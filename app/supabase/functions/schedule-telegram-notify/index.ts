import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const TELEGRAM_MESSAGE_SAFE_LIMIT = 3900;
const MAX_DELIVERIES_PER_INVOCATION = 20;
const MAX_TELEGRAM_MESSAGES_PER_DELIVERY = 10;
const BASE_AIRPORT = 'DAD';
const UTC_PLUS_7_OFFSET_MINUTES = 7 * 60;

type ScheduleNotificationModule = 'seasonal' | 'detailed';
type FlightType = 'A' | 'D';
type FlightAction = 'added' | 'deleted' | 'modified';
type ScheduleNotificationChangeKind = 'added' | 'cancelled' | 'schedule' | 'aircraft' | 'pattern';

interface ScheduleNotificationFlight {
  id: string;
  label: string;
  type: FlightType;
  date: string | null;
  schedule: string | null;
  route: string | null;
  aircraft: string | null;
  beforeAircraft?: string | null;
  afterAircraft?: string | null;
  beforeSchedule?: string | null;
  afterSchedule?: string | null;
  beforePattern?: string | null;
  afterPattern?: string | null;
  action: FlightAction;
  pairKey: string;
}

interface ScheduleNotificationMonthlyImpact {
  month: string;
  label: string;
  before: number;
  after: number;
}

interface ScheduleNotificationDelta {
  targetId: string;
  targetLabel: string;
  field: string;
  before: unknown;
  after: unknown;
}

interface ScheduleNotificationPayload {
  version: 1;
  historyEntryId: string;
  seasonId: string;
  seasonCode: string | null;
  module: ScheduleNotificationModule;
  operation: string;
  timestamp: number;
  counts: {
    total: number;
    added: number;
    deleted: number;
    modified: number;
  };
  affectedPeriod: {
    from: string | null;
    to: string | null;
  };
  changeKinds?: ScheduleNotificationChangeKind[];
  monthlyImpact?: ScheduleNotificationMonthlyImpact[];
  flights: ScheduleNotificationFlight[];
  deltas: ScheduleNotificationDelta[];
}

interface DeliveryRow {
  id: string;
  season_id: string;
  history_entry_id: string;
  actor_user_id: string | null;
  module: ScheduleNotificationModule;
  payload: ScheduleNotificationPayload;
  attempts: number;
}

interface DeliveryGroup {
  deliveries: DeliveryRow[];
  payload: ScheduleNotificationPayload;
}

interface InvokeBody {
  seasonId?: string;
  limit?: number;
}

interface OperatorIdentity {
  uid: string | null;
  email: string | null;
  displayName: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      getPublishableKey(),
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const { data: operator, error: operatorError } = await supabase
      .from('app_operators')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (operatorError) return jsonResponse({ error: operatorError.message }, 500);
    if (!operator) return jsonResponse({ error: 'Operator access is required' }, 403);

    const telegramToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const telegramChatId = Deno.env.get('TELEGRAM_CHAT_ID');
    if (!telegramToken || !telegramChatId) {
      return jsonResponse({ error: 'Telegram bot token or chat id is not configured' }, 500);
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', getServiceKey());
    const body = await readBody(req);
    const limit = Math.max(1, Math.min(Number(body.limit ?? 10), MAX_DELIVERIES_PER_INVOCATION));
    let query = admin
      .from('schedule_notification_deliveries')
      .select('id, season_id, history_entry_id, actor_user_id, module, payload, attempts')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (body.seasonId) query = query.eq('season_id', body.seasonId);

    const { data: rows, error: rowsError } = await query;
    if (rowsError) return jsonResponse({ error: rowsError.message }, 500);

    const deliveries = (rows ?? []) as DeliveryRow[];
    const actorCache = new Map<string, OperatorIdentity>();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const deliveryIds: string[] = [];

    for (const group of coalesceDeliveryRows(deliveries)) {
      const claimedDeliveries: DeliveryRow[] = [];
      for (const delivery of group.deliveries) {
        const claimed = await claimDelivery(admin, delivery);
        if (claimed) {
          claimedDeliveries.push(delivery);
        } else {
          skipped += 1;
        }
      }
      if (claimedDeliveries.length === 0) continue;

      try {
        const primaryDelivery = claimedDeliveries[0];
        const actor = await resolveOperator(admin, primaryDelivery.actor_user_id, actorCache);
        const payload = claimedDeliveries.length === group.deliveries.length
          ? group.payload
          : coalesceScheduleNotificationPayloads(claimedDeliveries.map((delivery) => delivery.payload))[0];
        if (!payload || !isScheduleNotificationPayloadRelevant(payload)) {
          for (const delivery of claimedDeliveries) {
            await markDeliverySent(admin, delivery.id, []);
            deliveryIds.push(delivery.id);
          }
          sent += claimedDeliveries.length;
          continue;
        }
        let messages = formatScheduleNotificationMessages(payload, {
          operator: actor,
          sentAt: new Date().toISOString(),
        });
        if (messages.length > MAX_TELEGRAM_MESSAGES_PER_DELIVERY) {
          messages = [formatSuppressedNotificationMessage(primaryDelivery, actor)];
        }
        const telegramMessageIds: number[] = [];
        for (const text of messages) {
          telegramMessageIds.push(await sendTelegramMessage(telegramToken, telegramChatId, text));
        }
        for (const delivery of claimedDeliveries) {
          await markDeliverySent(admin, delivery.id, telegramMessageIds);
          deliveryIds.push(delivery.id);
        }
        sent += claimedDeliveries.length;
      } catch (error) {
        failed += claimedDeliveries.length;
        for (const delivery of claimedDeliveries) {
          await markDeliveryFailed(admin, delivery.id, errorMessage(error));
        }
      }
    }

    return jsonResponse({ sent, failed, skipped, deliveryIds });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 500);
  }
});

async function readBody(req: Request): Promise<InvokeBody> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body as InvokeBody : {};
  } catch {
    return {};
  }
}

function parseSecretDictionary(name: string): Record<string, string> {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function getPublishableKey(): string {
  return Deno.env.get('SUPABASE_ANON_KEY')
    ?? parseSecretDictionary('SUPABASE_PUBLISHABLE_KEYS').default
    ?? '';
}

function getServiceKey(): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? parseSecretDictionary('SUPABASE_SECRET_KEYS').default;
  if (!key) throw new Error('Supabase service role secret is not configured');
  return key;
}

async function claimDelivery(admin: ReturnType<typeof createClient>, delivery: DeliveryRow): Promise<boolean> {
  const { data, error } = await admin
    .from('schedule_notification_deliveries')
    .update({
      status: 'sending',
      attempts: delivery.attempts + 1,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', delivery.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function markDeliverySent(
  admin: ReturnType<typeof createClient>,
  id: string,
  telegramMessageIds: number[],
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from('schedule_notification_deliveries')
    .update({
      status: 'sent',
      telegram_message_ids: telegramMessageIds,
      error: null,
      sent_at: now,
      updated_at: now,
    })
    .eq('id', id);
  if (error) throw error;
}

async function markDeliveryFailed(admin: ReturnType<typeof createClient>, id: string, errorText: string): Promise<void> {
  const { error } = await admin
    .from('schedule_notification_deliveries')
    .update({
      status: 'failed',
      error: errorText.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) console.error('Failed to mark Telegram delivery as failed', error);
}

async function resolveOperator(
  admin: ReturnType<typeof createClient>,
  userId: string | null,
  cache: Map<string, OperatorIdentity>,
): Promise<OperatorIdentity> {
  if (!userId) return { uid: null, email: null, displayName: null };
  const cached = cache.get(userId);
  if (cached) return cached;
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) {
    const fallback = { uid: userId, email: null, displayName: null };
    cache.set(userId, fallback);
    return fallback;
  }
  const metadata = data.user.user_metadata ?? {};
  const identity = {
    uid: data.user.id,
    email: data.user.email ?? null,
    displayName: stringOrNull(metadata.name) ?? stringOrNull(metadata.full_name),
  };
  cache.set(userId, identity);
  return identity;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<number> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch((): Record<string, unknown> => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const description = typeof payload.description === 'string' ? payload.description : response.statusText;
    throw new Error(`Telegram sendMessage failed: ${description}`);
  }
  const result = payload.result as { message_id?: number } | undefined;
  return result?.message_id ?? 0;
}

function formatOperator(operator: OperatorIdentity): string {
  return operator.displayName ?? operator.email ?? operator.uid ?? 'Unknown operator';
}

function formatPeriod(period: ScheduleNotificationPayload['affectedPeriod']): string {
  if (period.from && period.to && period.from !== period.to) return `${period.from} to ${period.to}`;
  return period.from ?? period.to ?? 'Unknown period';
}

interface FlightGroupItem {
  id: string;
  label: string;
  type: FlightType;
  date: string | null;
  route: string | null;
  pairKey: string;
}

function sortFlightGroup<T extends FlightGroupItem>(group: T[]): T[] {
  return group.sort((left, right) => left.type.localeCompare(right.type) || left.label.localeCompare(right.label));
}

function groupFlightItems<T extends FlightGroupItem>(flights: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const flight of flights) {
    const group = groups.get(flight.pairKey) ?? [];
    group.push(flight);
    groups.set(flight.pairKey, group);
  }
  return Array.from(groups.values()).map(sortFlightGroup);
}

function groupContainsPair(group: FlightGroupItem[]): boolean {
  return group.some((flight) => flight.type === 'A') && group.some((flight) => flight.type === 'D');
}

function flightIdentityKey(flight: FlightGroupItem): string {
  return `flight:${flight.type}:${flight.label}:${flight.route ?? ''}`;
}

function groupIdentityKey(group: FlightGroupItem[]): string {
  if (groupContainsPair(group)) {
    const arrival = group.find((flight) => flight.type === 'A');
    const departure = group.find((flight) => flight.type === 'D');
    return `pair:${arrival?.label ?? ''}:${arrival?.route ?? ''}:${departure?.label ?? ''}:${departure?.route ?? ''}`;
  }
  return flightIdentityKey(group[0]);
}

function groupFlightsByIdentity(flights: ScheduleNotificationFlight[]): ScheduleNotificationFlight[][] {
  const groups = new Map<string, ScheduleNotificationFlight[]>();
  for (const occurrenceGroup of groupFlightItems(flights)) {
    const key = groupIdentityKey(occurrenceGroup);
    const group = groups.get(key) ?? [];
    group.push(...occurrenceGroup);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map(sortFlightGroup);
}

function affectedUnitInfo(flights: ScheduleNotificationFlight[]): { count: number; hasPair: boolean } {
  let count = 0;
  let hasPair = false;
  for (const group of groupFlightItems(flights)) {
    if (groupContainsPair(group)) {
      hasPair = true;
      count += 1;
    } else {
      count += group.length;
    }
  }
  return { count, hasPair };
}

function coalesceIdentityKey(payload: ScheduleNotificationPayload): { key: string; pairKeyScoped: boolean } | null {
  const pairKeys = Array.from(new Set(payload.flights.map((flight) => flight.pairKey))).sort();
  const sharedPairKey = pairKeys.length === 1 && !pairKeys[0].startsWith('single:') ? pairKeys[0] : null;
  if (sharedPairKey) return { key: `pair-key:${sharedPairKey}`, pairKeyScoped: true };

  const identityGroups = groupFlightsByIdentity(payload.flights);
  if (identityGroups.length !== 1) return null;
  return { key: `identity:${groupIdentityKey(identityGroups[0])}`, pairKeyScoped: false };
}

function coalesceScheduleSignature(payload: ScheduleNotificationPayload): string {
  const group = groupFlightsByIdentity(payload.flights)[0] ?? [];
  return [
    formatScheduleState(group, 'before'),
    formatScheduleState(group, 'after'),
    formatAircraftState(group, 'before'),
    formatAircraftState(group, 'after'),
    formatScheduleValue(uniqueValues(group.map((flight) => flight.beforePattern))) ?? '',
    formatScheduleValue(uniqueValues(group.map((flight) => flight.afterPattern))) ?? '',
  ].join('>');
}

function coalesceGroupKey(payload: ScheduleNotificationPayload): string | null {
  const identity = coalesceIdentityKey(payload);
  if (!identity) return null;
  const actionKey = (payload.changeKinds ?? deriveScheduleNotificationChangeKinds(payload)).sort().join('+') || [
    payload.counts.added > 0 ? 'added' : null,
    payload.counts.deleted > 0 ? 'deleted' : null,
    payload.counts.modified > 0 ? 'modified' : null,
  ].filter(Boolean).join('+');
  if (!actionKey) return null;
  return [
    payload.seasonId,
    payload.module,
    actionKey,
    identity.key,
    identity.pairKeyScoped ? '' : coalesceScheduleSignature(payload),
  ].join('|');
}

function canCoalescePayloads(payloads: ScheduleNotificationPayload[]): boolean {
  if (payloads.length < 2) return false;
  return Boolean(coalesceGroupKey(payloads[0]));
}

function mergeCounts(flights: ScheduleNotificationFlight[]): ScheduleNotificationPayload['counts'] {
  return {
    total: flights.length,
    added: flights.filter((flight) => flight.action === 'added').length,
    deleted: flights.filter((flight) => flight.action === 'deleted').length,
    modified: flights.filter((flight) => flight.action === 'modified').length,
  };
}

function mergeMonthlyImpact(payloads: ScheduleNotificationPayload[]): ScheduleNotificationMonthlyImpact[] {
  const rows = new Map<string, ScheduleNotificationMonthlyImpact>();
  for (const payload of payloads) {
    for (const row of payload.monthlyImpact ?? []) {
      const existing = rows.get(row.month);
      rows.set(row.month, {
        month: row.month,
        label: row.label,
        before: Math.max(existing?.before ?? 0, row.before),
        after: Math.max(existing?.after ?? 0, row.after),
      });
    }
  }
  return Array.from(rows.values()).sort((left, right) => left.month.localeCompare(right.month));
}

function coalescePayloadGroup(payloads: ScheduleNotificationPayload[]): ScheduleNotificationPayload {
  const first = payloads[0];
  const flights = Array.from(
    new Map(payloads.flatMap((payload) => payload.flights).map((flight) => [flight.id, flight])).values()
  ).sort((left, right) => (
    (left.date ?? '').localeCompare(right.date ?? '') ||
    left.pairKey.localeCompare(right.pairKey) ||
    left.type.localeCompare(right.type) ||
    left.label.localeCompare(right.label)
  ));
  const deltas = Array.from(
    new Map(payloads
      .flatMap((payload) => payload.deltas)
      .map((delta) => [`${delta.targetId}:${delta.field}:${JSON.stringify(delta.before)}:${JSON.stringify(delta.after)}`, delta])).values()
  );
  const fromDates = payloads.map((payload) => payload.affectedPeriod.from).filter((date): date is string => Boolean(date)).sort();
  const toDates = payloads.map((payload) => payload.affectedPeriod.to).filter((date): date is string => Boolean(date)).sort();

  return {
    ...first,
    historyEntryId: payloads.map((payload) => payload.historyEntryId).join('+'),
    timestamp: Math.min(...payloads.map((payload) => payload.timestamp)),
    counts: mergeCounts(flights),
    affectedPeriod: {
      from: fromDates[0] ?? null,
      to: toDates[toDates.length - 1] ?? null,
    },
    changeKinds: deriveScheduleNotificationChangeKinds({ counts: mergeCounts(flights), flights, deltas }),
    monthlyImpact: mergeMonthlyImpact(payloads),
    flights,
    deltas,
  };
}

function coalesceScheduleNotificationPayloads(payloads: ScheduleNotificationPayload[]): ScheduleNotificationPayload[] {
  const groups = new Map<string, ScheduleNotificationPayload[]>();
  const passthrough: ScheduleNotificationPayload[] = [];
  for (const payload of payloads.filter(isScheduleNotificationPayloadRelevant)) {
    const key = coalesceGroupKey(payload);
    if (!key) {
      passthrough.push(payload);
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(payload);
    groups.set(key, group);
  }
  const coalesced = Array.from(groups.values()).flatMap((group) => (
    canCoalescePayloads(group) ? [coalescePayloadGroup(group)] : group
  ));
  return [...coalesced, ...passthrough].sort((left, right) => left.timestamp - right.timestamp);
}

function coalesceDeliveryRows(deliveries: DeliveryRow[]): DeliveryGroup[] {
  const groups = new Map<string, DeliveryRow[]>();
  const passthrough: DeliveryGroup[] = [];
  for (const delivery of deliveries) {
    const key = coalesceGroupKey(delivery.payload);
    if (!key) {
      passthrough.push({ deliveries: [delivery], payload: delivery.payload });
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(delivery);
    groups.set(key, group);
  }

  const coalesced = Array.from(groups.values()).map((group) => {
    const payloads = group.map((delivery) => delivery.payload);
    const [payload] = coalesceScheduleNotificationPayloads(payloads);
    if (payload && canCoalescePayloads(payloads)) return { deliveries: group, payload };
    return null;
  });

  return [
    ...coalesced.filter((group): group is DeliveryGroup => Boolean(group)),
    ...Array.from(groups.values())
      .filter((group) => !canCoalescePayloads(group.map((delivery) => delivery.payload)))
      .flatMap((group) => group.map((delivery) => ({ deliveries: [delivery], payload: delivery.payload }))),
    ...passthrough,
  ];
}

function pluralizeFlight(count: number): string {
  return count === 1 ? 'Flight' : 'Flights';
}

function actionSummary(
  payload: Pick<ScheduleNotificationPayload, 'counts' | 'flights' | 'deltas' | 'changeKinds'>,
  unitInfo: { count: number; hasPair: boolean },
  period: ScheduleNotificationPayload['affectedPeriod'],
): string {
  const kinds = payload.changeKinds ?? deriveScheduleNotificationChangeKinds(payload);
  const isPatternOnly = kinds.length === 1 && kinds[0] === 'pattern';
  const actions = isPatternOnly
    ? ['Changed Pattern']
    : [
      (kinds.includes('schedule') || kinds.includes('aircraft') || payload.counts.modified > 0) ? 'Updated' : null,
      kinds.includes('added') ? 'Added' : null,
      kinds.includes('cancelled') ? 'Cancelled' : null,
      kinds.includes('pattern') ? 'Changed Pattern' : null,
    ].filter((action): action is string => Boolean(action));
  const actionLabel = actions.length > 0 ? actions.join('/') : 'Updated';
  const unitLabel = unitInfo.hasPair ? 'Flight Pair(s)' : pluralizeFlight(unitInfo.count);
  return `${actionLabel} ${unitInfo.count} ${unitLabel} (Period: ${formatPeriod(period)})`;
}

function routeForFlight(flight: Pick<ScheduleNotificationFlight, 'type' | 'route'>): string {
  const route = flight.route ?? 'Unknown';
  return flight.type === 'A' ? `${route}-${BASE_AIRPORT}` : `${BASE_AIRPORT}-${route}`;
}

function groupTitle(group: ScheduleNotificationFlight[]): string {
  const arrival = group.find((flight) => flight.type === 'A');
  const departure = group.find((flight) => flight.type === 'D');
  if (arrival && departure) {
    return `✈️ Flight Pair: ${arrival.label} / ${departure.label} (${arrival.route ?? 'Unknown'}-${BASE_AIRPORT}-${departure.route ?? 'Unknown'})`;
  }
  const flight = group[0];
  return `✈️ Flight: ${flight.label} (${routeForFlight(flight)})`;
}

function schedulePrefix(type: FlightType): string {
  return type === 'A' ? 'STA' : 'STD';
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function formatScheduleValue(values: string[]): string | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return 'Multiple';
}

function flightScheduleForState(flight: ScheduleNotificationFlight, state: 'before' | 'after'): string | null | undefined {
  if (state === 'before') return flight.beforeSchedule ?? (flight.action !== 'added' ? flight.schedule : null);
  return flight.afterSchedule ?? (flight.action !== 'deleted' ? flight.schedule : null);
}

function formatScheduleState(group: ScheduleNotificationFlight[], state: 'before' | 'after'): string {
  const pieces: string[] = [];
  for (const type of ['A', 'D'] as const) {
    const values = uniqueValues(group
      .filter((flight) => flight.type === type)
      .map((flight) => flightScheduleForState(flight, state)));
    const value = formatScheduleValue(values);
    if (value) pieces.push(`${schedulePrefix(type)} ${value}`);
  }
  if (pieces.length > 0) return pieces.join(' / ');
  if (state === 'after' && group.every((flight) => flight.action === 'deleted')) return 'Cancelled';
  if (state === 'before' && group.every((flight) => flight.action === 'added')) return 'None';
  return state === 'after' ? 'No active schedule' : 'None';
}

function flightAircraftForState(flight: ScheduleNotificationFlight, state: 'before' | 'after'): string | null | undefined {
  if (state === 'before') return flight.beforeAircraft ?? (flight.action !== 'added' ? flight.aircraft : null);
  return flight.afterAircraft ?? (flight.action !== 'deleted' ? flight.aircraft : null);
}

function formatAircraftState(group: ScheduleNotificationFlight[], state: 'before' | 'after'): string {
  const values = uniqueValues(group.map((flight) => flightAircraftForState(flight, state)));
  const value = formatScheduleValue(values);
  if (value) return value;
  if (state === 'after' && group.every((flight) => flight.action === 'deleted')) return 'Cancelled';
  if (state === 'before' && group.every((flight) => flight.action === 'added')) return 'None';
  return state === 'after' ? 'No active aircraft' : 'None';
}

function groupHasScheduleChange(group: ScheduleNotificationFlight[]): boolean {
  const oldSchedule = formatScheduleState(group, 'before');
  const newSchedule = formatScheduleState(group, 'after');
  return oldSchedule !== newSchedule && oldSchedule !== 'None' && newSchedule !== 'Cancelled';
}

function groupHasAircraftChange(group: ScheduleNotificationFlight[]): boolean {
  const oldAircraft = formatAircraftState(group, 'before');
  const newAircraft = formatAircraftState(group, 'after');
  return oldAircraft !== newAircraft && oldAircraft !== 'None' && newAircraft !== 'Cancelled';
}

function groupHasPatternChange(group: ScheduleNotificationFlight[]): boolean {
  const beforePatterns = uniqueValues(group.map((flight) => flight.beforePattern));
  const afterPatterns = uniqueValues(group.map((flight) => flight.afterPattern));
  if (beforePatterns.length === 1 && afterPatterns.length === 1 && beforePatterns[0] !== afterPatterns[0]) return true;
  return group.some((flight) => flight.action === 'added') &&
    group.some((flight) => flight.action === 'deleted') &&
    formatScheduleState(group, 'before') === formatScheduleState(group, 'after') &&
    formatAircraftState(group, 'before') === formatAircraftState(group, 'after');
}

function deriveScheduleNotificationChangeKinds(payload: Pick<ScheduleNotificationPayload, 'counts' | 'flights' | 'deltas'>): ScheduleNotificationChangeKind[] {
  const kinds = new Set<ScheduleNotificationChangeKind>();
  for (const group of groupFlightsByIdentity(payload.flights)) {
    const hasScheduleChange = groupHasScheduleChange(group);
    const hasAircraftChange = groupHasAircraftChange(group);
    const hasPatternChange = groupHasPatternChange(group);
    const hasAdded = group.some((flight) => flight.action === 'added');
    const hasDeleted = group.some((flight) => flight.action === 'deleted');
    const patternOnly = hasPatternChange && hasAdded && hasDeleted && !hasScheduleChange && !hasAircraftChange;

    if (hasScheduleChange) kinds.add('schedule');
    if (hasAircraftChange) kinds.add('aircraft');
    if (patternOnly) kinds.add('pattern');
    if (!patternOnly && hasAdded) kinds.add('added');
    if (!patternOnly && hasDeleted) kinds.add('cancelled');
  }

  for (const delta of payload.deltas) {
    if (delta.field === 'schedule') kinds.add('schedule');
    if (delta.field === 'aircraft') kinds.add('aircraft');
  }

  return Array.from(kinds);
}

function isScheduleNotificationPayloadRelevant(payload: Pick<ScheduleNotificationPayload, 'counts' | 'flights' | 'deltas' | 'changeKinds'>): boolean {
  if (payload.flights.length === 0) return false;
  const kinds = payload.changeKinds ?? deriveScheduleNotificationChangeKinds(payload);
  return kinds.length > 0;
}

function parseMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinuteDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta} mins`;
}

function scheduleDeltaSuffix(group: ScheduleNotificationFlight[]): string {
  const deltas = uniqueValues(group.map((flight) => {
    const before = parseMinutes(flightScheduleForState(flight, 'before'));
    const after = parseMinutes(flightScheduleForState(flight, 'after'));
    if (before == null || after == null) return null;
    const delta = after - before;
    return delta === 0 ? null : String(delta);
  }));
  if (deltas.length !== 1) return '';
  return ` (${formatMinuteDelta(Number(deltas[0]))})`;
}

function formatGroupBlock(group: ScheduleNotificationFlight[]): string[] {
  const oldSchedule = formatScheduleState(group, 'before');
  const newSchedule = formatScheduleState(group, 'after');
  const suffix = newSchedule === 'Cancelled' ? '' : scheduleDeltaSuffix(group);
  const oldAircraft = formatAircraftState(group, 'before');
  const newAircraft = formatAircraftState(group, 'after');
  const beforePattern = formatScheduleValue(uniqueValues(group.map((flight) => flight.beforePattern)));
  const afterPattern = formatScheduleValue(uniqueValues(group.map((flight) => flight.afterPattern)));
  const hasScheduleChange = groupHasScheduleChange(group);
  const hasAircraftChange = groupHasAircraftChange(group);
  const hasPatternChange = groupHasPatternChange(group);
  const hasAdded = group.some((flight) => flight.action === 'added');
  const hasDeleted = group.some((flight) => flight.action === 'deleted');
  const lines = [groupTitle(group)];

  if (hasScheduleChange || (hasAdded && !hasDeleted) || (hasDeleted && !hasAdded)) {
    lines.push(`❌ Old Schedule: ${oldSchedule}`);
    lines.push(`✅ New Schedule: ${newSchedule}${suffix}`);
  } else {
    lines.push(`🕓 Schedule: ${newSchedule !== 'No active schedule' ? newSchedule : oldSchedule}`);
  }

  if (hasPatternChange) {
    lines.push(`🔁 Pattern: ${beforePattern ?? 'None'} -> ${afterPattern ?? 'None'}`);
  }

  if (hasAircraftChange) {
    lines.push(`❌ Old Aircraft: ${oldAircraft}`);
    lines.push(`✅ New Aircraft: ${newAircraft}`);
  }

  return lines;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUtcPlus7Timestamp(value: string): string {
  const date = new Date(value);
  const shifted = new Date(date.getTime() + UTC_PLUS_7_OFFSET_MINUTES * 60_000);
  return [
    shifted.getUTCFullYear(),
    '-',
    pad2(shifted.getUTCMonth() + 1),
    '-',
    pad2(shifted.getUTCDate()),
    ' ',
    pad2(shifted.getUTCHours()),
    ':',
    pad2(shifted.getUTCMinutes()),
    ' (UTC+7)',
  ].join('');
}

function formatImpactLines(impact: ScheduleNotificationPayload['monthlyImpact']): string[] {
  const rows = impact ?? [];
  if (rows.length === 0) return ['📊 Affection: Unknown'];
  return rows.map((row) => `📊 Affection: ${row.label} ${row.before} (before) -> ${row.after} (after)`);
}

function splitLinesByLimit(header: string[], bodyLines: string[]): string[] {
  const limit = TELEGRAM_MESSAGE_SAFE_LIMIT - 16;
  const chunks: string[] = [];
  let currentLines: string[] = [];
  for (const line of bodyLines) {
    const candidate = [...header, ...currentLines, line].join('\n');
    if (currentLines.length > 0 && candidate.length > limit) {
      chunks.push([...header, ...currentLines].join('\n'));
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  if (currentLines.length > 0) chunks.push([...header, ...currentLines].join('\n'));
  return chunks.length > 0 ? chunks : [header.join('\n')];
}

function withPartNumbers(messages: string[]): string[] {
  if (messages.length <= 1) return messages;
  const total = messages.length;
  return messages.map((message, index) => `[${index + 1}/${total}]\n${message}`);
}

function formatScheduleNotificationMessages(
  payload: ScheduleNotificationPayload,
  options: { operator: OperatorIdentity; sentAt: string },
): string[] {
  const flightGroups = groupFlightsByIdentity(payload.flights);
  const unitInfo = affectedUnitInfo(payload.flights);
  const header = [
    '🚨 FLIGHT SCHEDULE UPDATE',
    `👤 User: ${formatOperator(options.operator)}`,
    `📅 Season: ${payload.seasonCode ?? payload.seasonId}`,
  ];
  const flightLines = flightGroups.flatMap((group) => ['', ...formatGroupBlock(group)]);
  const summaryLines = [
    '',
    `🔄 Modification Summary: ${actionSummary(payload, unitInfo, payload.affectedPeriod)}`,
    ...formatImpactLines(payload.monthlyImpact),
  ];
  const timestampLine = `⏰ Timestamp: ${formatUtcPlus7Timestamp(options.sentAt)}`;
  return withPartNumbers(splitLinesByLimit(header, [...flightLines, ...summaryLines, timestampLine]));
}

function formatSuppressedNotificationMessage(delivery: DeliveryRow, operator: OperatorIdentity): string {
  return [
    '🚨 FLIGHT SCHEDULE UPDATE',
    `👤 User: ${formatOperator(operator)}`,
    `📅 Season: ${delivery.payload.seasonCode ?? delivery.payload.seasonId}`,
    `🔄 Modification Summary: ${actionSummary(delivery.payload, affectedUnitInfo(delivery.payload.flights), delivery.payload.affectedPeriod)}`,
    '⚠️ Telegram details suppressed: notification exceeded safety limit.',
    `Delivery ID: ${delivery.id}`,
    `History Entry: ${delivery.history_entry_id}`,
    `⏰ Timestamp: ${formatUtcPlus7Timestamp(new Date().toISOString())}`,
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
