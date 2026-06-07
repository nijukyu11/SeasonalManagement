import {
  buildFlightActionAuditEntry,
  formatAuditFlightLabel,
  type AuditActor,
  type AuditDeltaItem,
  type AuditModule,
} from './auditLog.ts';
import type { FlightModification, FlightRecord, ModHistoryEntry, Season } from './types.ts';

export const TELEGRAM_MESSAGE_SAFE_LIMIT = 3900;
const BASE_AIRPORT = 'DAD';
const UTC_PLUS_7_OFFSET_MINUTES = 7 * 60;

export type ScheduleNotificationModule = Extract<AuditModule, 'seasonal' | 'detailed'>;
export type ScheduleNotificationFlightAction = 'added' | 'deleted' | 'modified';
export type ScheduleNotificationChangeKind = 'added' | 'cancelled' | 'schedule' | 'aircraft' | 'pattern';

export interface ScheduleNotificationFlight {
  id: string;
  label: string;
  type: FlightRecord['type'];
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
  action: ScheduleNotificationFlightAction;
  pairKey: string;
}

export interface ScheduleNotificationMonthlyImpact {
  month: string;
  label: string;
  before: number;
  after: number;
}

export interface ScheduleNotificationDelta {
  targetId: string;
  targetLabel: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface ScheduleNotificationPayload {
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

export interface ScheduleNotificationFormatOptions {
  operator?: Pick<AuditActor, 'uid' | 'email' | 'displayName'> | null;
  sentAt?: string;
}

type RecordInput = Partial<FlightRecord> | null | undefined;
const MODIFICATION_OVERRIDE_FIELDS: Array<keyof FlightModification> = [
  'schedule',
  'aircraft',
  'route',
  'codeShares',
  'pax',
  'gate',
  'stand',
  'counter',
  'checkInStart',
  'checkInEnd',
  'checkInAllocationMode',
  'checkInCounterWindows',
  'carousel',
  'mct',
  'fb',
  'lb',
  'bhs',
  'ghs',
];

function recordMap(records: RecordInput[] | undefined): Map<string, Partial<FlightRecord>> {
  const map = new Map<string, Partial<FlightRecord>>();
  for (const record of records ?? []) {
    if (record?.id) map.set(record.id, record);
  }
  return map;
}

function modificationMap(modifications: Map<string, FlightModification> | FlightModification[] | undefined): Map<string, FlightModification> {
  if (!modifications) return new Map();
  if (modifications instanceof Map) return new Map(modifications);
  return new Map(modifications.map((mod) => [mod.legId, mod]));
}

function resolveTargetIds(
  targetRecordIds: string[] | undefined,
  beforeRecords: Map<string, Partial<FlightRecord>>,
  afterRecords: Map<string, Partial<FlightRecord>>,
  beforeMods: Map<string, FlightModification>,
  afterMods: Map<string, FlightModification>,
): Set<string> {
  const explicitIds = (targetRecordIds ?? []).filter((id) => String(id).trim().length > 0);
  if (explicitIds.length > 0) return new Set(explicitIds);

  const targetIds = new Set<string>();
  beforeRecords.forEach((_record, id) => targetIds.add(id));
  afterRecords.forEach((_record, id) => targetIds.add(id));
  beforeMods.forEach((_mod, id) => targetIds.add(id));
  afterMods.forEach((_mod, id) => targetIds.add(id));
  return targetIds;
}

function normalizeString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeFlightDate(record: Partial<FlightRecord> | undefined): string | null {
  return normalizeString(record?.date ?? record?.operationalDate ?? record?.scheduledDate);
}

function normalizeFlightSchedule(record: Partial<FlightRecord> | undefined): string | null {
  return normalizeString(record?.schedule ?? record?.scheduledTime);
}

function actionForTarget(
  targetId: string,
  before: Partial<FlightRecord> | undefined,
  after: Partial<FlightRecord> | undefined,
  beforeMod: FlightModification | undefined,
  afterMod: FlightModification | undefined,
): ScheduleNotificationFlightAction {
  if (!before && after) return 'added';
  if (before && (!after || after.status === 'deleted')) return 'deleted';
  if (afterMod?.action === 'added') return 'added';
  if (afterMod?.action === 'deleted') return 'deleted';
  if (beforeMod?.action === 'added' && !afterMod) return 'deleted';
  return 'modified';
}

function pairKeyForRecord(record: Partial<FlightRecord> & { id?: string }): string {
  if (record.turnaroundId) return `turnaround:${record.turnaroundId}`;
  if (record.linkId && record.pairAnchorDate) return `link:${record.linkId}:${record.pairAnchorDate}`;
  if (record.id && record.linkedRecordId) {
    return `linked:${[record.id, record.linkedRecordId].sort().join(':')}`;
  }
  return `single:${record.id ?? formatAuditFlightLabel(record)}`;
}

function effectiveRecord(
  targetId: string,
  record: Partial<FlightRecord> | undefined,
  modification: FlightModification | undefined,
): Partial<FlightRecord> | undefined {
  const baseRecord = modification?.action === 'added' && modification.addedLeg
    ? { ...modification.addedLeg, id: targetId }
    : record ? { ...record, id: record.id ?? targetId } : undefined;
  if (!baseRecord || baseRecord.status === 'deleted' || modification?.action === 'deleted') return undefined;

  const effective = { ...baseRecord, id: targetId } as Partial<FlightRecord>;
  for (const field of MODIFICATION_OVERRIDE_FIELDS) {
    if (hasOwn(modification ?? {}, field)) {
      (effective as Record<string, unknown>)[field] = modification?.[field] ?? null;
    }
  }
  return effective;
}

function buildFlight(
  targetId: string,
  before: Partial<FlightRecord> | undefined,
  after: Partial<FlightRecord> | undefined,
  beforeMod: FlightModification | undefined,
  afterMod: FlightModification | undefined,
): ScheduleNotificationFlight {
  const beforeEffective = effectiveRecord(targetId, before, beforeMod);
  const afterEffective = effectiveRecord(targetId, after, afterMod);
  const labelRecord = afterEffective ?? beforeEffective ?? after ?? before ?? afterMod?.addedLeg ?? beforeMod?.addedLeg ?? { id: targetId };
  const beforeSchedule = normalizeFlightSchedule(beforeEffective);
  const afterSchedule = normalizeFlightSchedule(afterEffective);
  const beforeAircraft = normalizeString(beforeEffective?.aircraft);
  const afterAircraft = normalizeString(afterEffective?.aircraft);
  return {
    id: targetId,
    label: formatAuditFlightLabel(labelRecord),
    type: (labelRecord.type ?? 'A') as FlightRecord['type'],
    date: normalizeFlightDate(afterEffective ?? beforeEffective ?? labelRecord),
    schedule: afterSchedule ?? beforeSchedule,
    route: normalizeString(labelRecord.route),
    aircraft: afterAircraft ?? beforeAircraft ?? normalizeString(labelRecord.aircraft),
    beforeAircraft,
    afterAircraft,
    beforeSchedule,
    afterSchedule,
    action: actionForTarget(targetId, before, after, beforeMod, afterMod),
    pairKey: pairKeyForRecord(labelRecord),
  };
}

function affectedPeriodForFlights(flights: ScheduleNotificationFlight[]): { from: string | null; to: string | null } {
  const dates = flights.map((flight) => flight.date).filter((date): date is string => Boolean(date)).sort();
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

function countActions(flights: ScheduleNotificationFlight[]): ScheduleNotificationPayload['counts'] {
  return {
    total: flights.length,
    added: flights.filter((flight) => flight.action === 'added').length,
    deleted: flights.filter((flight) => flight.action === 'deleted').length,
    modified: flights.filter((flight) => flight.action === 'modified').length,
  };
}

interface FlightGroupItem {
  id: string;
  label: string;
  type: FlightRecord['type'];
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

interface TargetMonthlyIdentities {
  pairKeys: Set<string>;
  flightKeys: Set<string>;
}

function targetMonthlyIdentities(flights: ScheduleNotificationFlight[]): TargetMonthlyIdentities {
  const pairKeys = new Set<string>();
  const flightKeys = new Set<string>();
  for (const group of groupFlightItems(flights)) {
    if (groupContainsPair(group)) {
      pairKeys.add(groupIdentityKey(group));
    } else {
      group.forEach((flight) => flightKeys.add(flightIdentityKey(flight)));
    }
  }
  return { pairKeys, flightKeys };
}

function monthKeyForDate(date: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}/.test(date)) return null;
  return date.slice(0, 7);
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function isoDayNumber(date: string | null): number | null {
  if (!date) return null;
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return null;
  const day = value.getUTCDay();
  return day === 0 ? 7 : day;
}

function formatPattern(days: Set<number> | undefined): string | null {
  if (!days || days.size === 0) return null;
  return Array.from(days).sort((left, right) => left - right).join('');
}

function activeSnapshotFlights(
  records: Map<string, Partial<FlightRecord>>,
  modifications: Map<string, FlightModification>,
): FlightGroupItem[] {
  const ids = new Set<string>();
  records.forEach((_record, id) => ids.add(id));
  modifications.forEach((_mod, id) => ids.add(id));

  const flights: FlightGroupItem[] = [];
  for (const id of ids) {
    const effective = effectiveRecord(id, records.get(id), modifications.get(id));
    if (!effective) continue;
    flights.push({
      id,
      label: formatAuditFlightLabel(effective),
      type: (effective.type ?? 'A') as FlightRecord['type'],
      date: normalizeFlightDate(effective),
      route: normalizeString(effective.route),
      pairKey: pairKeyForRecord(effective),
    });
  }
  return flights;
}

function countSnapshotIdentitiesByMonth(
  records: Map<string, Partial<FlightRecord>>,
  modifications: Map<string, FlightModification>,
  targetIdentities: TargetMonthlyIdentities,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groupFlightItems(activeSnapshotFlights(records, modifications))) {
    const matchingIdentityCount = targetIdentities.pairKeys.has(groupIdentityKey(group))
      ? 1
      : new Set(group
        .map(flightIdentityKey)
        .filter((key) => targetIdentities.flightKeys.has(key))).size;
    if (matchingIdentityCount === 0) continue;
    const month = monthKeyForDate(group.find((flight) => flight.date)?.date ?? null);
    if (!month) continue;
    counts.set(month, (counts.get(month) ?? 0) + matchingIdentityCount);
  }
  return counts;
}

function patternSnapshotIdentities(
  records: Map<string, Partial<FlightRecord>>,
  modifications: Map<string, FlightModification>,
  targetIdentities: TargetMonthlyIdentities,
  months: Set<string>,
): Map<string, string> {
  const patterns = new Map<string, Set<number>>();
  const addPatternDay = (identity: string, date: string | null) => {
    const month = monthKeyForDate(date);
    if (!month || !months.has(month)) return;
    const day = isoDayNumber(date);
    if (!day) return;
    const days = patterns.get(identity) ?? new Set<number>();
    days.add(day);
    patterns.set(identity, days);
  };

  for (const group of groupFlightItems(activeSnapshotFlights(records, modifications))) {
    const pairIdentity = groupIdentityKey(group);
    if (targetIdentities.pairKeys.has(pairIdentity)) {
      addPatternDay(pairIdentity, group.find((flight) => flight.date)?.date ?? null);
    }
    for (const flight of group) {
      const flightIdentity = flightIdentityKey(flight);
      if (targetIdentities.flightKeys.has(flightIdentity)) addPatternDay(flightIdentity, flight.date);
    }
  }

  return new Map(Array.from(patterns.entries()).map(([identity, days]) => [identity, formatPattern(days) ?? '']));
}

function addPatternMetadata(
  flights: ScheduleNotificationFlight[],
  beforeRecords: Map<string, Partial<FlightRecord>>,
  afterRecords: Map<string, Partial<FlightRecord>>,
  beforeMods: Map<string, FlightModification>,
  afterMods: Map<string, FlightModification>,
): ScheduleNotificationFlight[] {
  const targetIdentities = targetMonthlyIdentities(flights);
  if (targetIdentities.pairKeys.size === 0 && targetIdentities.flightKeys.size === 0) return flights;

  const months = new Set<string>();
  for (const flight of flights) {
    const month = monthKeyForDate(flight.date);
    if (month) months.add(month);
  }
  if (months.size === 0) return flights;

  const beforePatterns = patternSnapshotIdentities(beforeRecords, beforeMods, targetIdentities, months);
  const afterPatterns = patternSnapshotIdentities(afterRecords, afterMods, targetIdentities, months);
  const patternByFlightId = new Map<string, { before: string | null; after: string | null }>();

  for (const group of groupFlightsByIdentity(flights)) {
    const identity = groupIdentityKey(group);
    const pattern = {
      before: normalizeString(beforePatterns.get(identity)),
      after: normalizeString(afterPatterns.get(identity)),
    };
    for (const flight of group) patternByFlightId.set(flight.id, pattern);
  }

  return flights.map((flight) => {
    const pattern = patternByFlightId.get(flight.id);
    return pattern ? { ...flight, beforePattern: pattern.before, afterPattern: pattern.after } : flight;
  });
}

function buildMonthlyImpact(
  flights: ScheduleNotificationFlight[],
  beforeRecords: Map<string, Partial<FlightRecord>>,
  afterRecords: Map<string, Partial<FlightRecord>>,
  beforeMods: Map<string, FlightModification>,
  afterMods: Map<string, FlightModification>,
): ScheduleNotificationMonthlyImpact[] {
  const targetIdentities = targetMonthlyIdentities(flights);
  if (targetIdentities.pairKeys.size === 0 && targetIdentities.flightKeys.size === 0) return [];

  const months = new Set<string>();
  for (const flight of flights) {
    const month = monthKeyForDate(flight.date);
    if (month) months.add(month);
  }
  if (months.size === 0) return [];

  const beforeCounts = countSnapshotIdentitiesByMonth(beforeRecords, beforeMods, targetIdentities);
  const afterCounts = countSnapshotIdentitiesByMonth(afterRecords, afterMods, targetIdentities);

  return Array.from(months).sort().map((month) => ({
    month,
    label: monthLabel(month),
    before: beforeCounts.get(month) ?? 0,
    after: afterCounts.get(month) ?? 0,
  }));
}

function mergeCounts(flights: ScheduleNotificationFlight[]): ScheduleNotificationPayload['counts'] {
  return countActions(flights);
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

  return {
    ...first,
    historyEntryId: payloads.map((payload) => payload.historyEntryId).join('+'),
    operation: first.operation,
    timestamp: Math.min(...payloads.map((payload) => payload.timestamp)),
    counts: mergeCounts(flights),
    affectedPeriod: {
      from: payloads
        .map((payload) => payload.affectedPeriod.from)
        .filter((date): date is string => Boolean(date))
        .sort()[0] ?? null,
      to: payloads
        .map((payload) => payload.affectedPeriod.to)
        .filter((date): date is string => Boolean(date))
        .sort()
        .at(-1) ?? null,
    },
    changeKinds: deriveScheduleNotificationChangeKinds({ counts: mergeCounts(flights), flights, deltas }),
    monthlyImpact: mergeMonthlyImpact(payloads),
    flights,
    deltas,
  };
}

export function coalesceScheduleNotificationPayloads(
  payloads: ScheduleNotificationPayload[]
): ScheduleNotificationPayload[] {
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

function normalizeDelta(delta: AuditDeltaItem): ScheduleNotificationDelta {
  return {
    targetId: delta.targetId,
    targetLabel: delta.targetLabel,
    field: delta.field,
    before: delta.before,
    after: delta.after,
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function effectiveModificationBeforeValue(
  baseRecord: Partial<FlightRecord> | undefined,
  previousMod: FlightModification | undefined,
  field: keyof FlightModification,
): unknown {
  if (previousMod && hasOwn(previousMod, field)) return previousMod[field];
  return baseRecord?.[field as keyof FlightRecord] ?? null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = left === undefined ? null : left;
  const normalizedRight = right === undefined ? null : right;
  if (normalizedLeft === normalizedRight) return true;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function buildEffectiveModificationDeltas(
  beforeRecords: Map<string, Partial<FlightRecord>>,
  beforeMods: Map<string, FlightModification>,
  afterMods: Map<string, FlightModification>,
  targetIds: Set<string>,
): AuditDeltaItem[] {
  const deltas: AuditDeltaItem[] = [];
  for (const [targetId, afterMod] of afterMods) {
    if (!targetIds.has(targetId)) continue;
    if (afterMod.action !== 'modified') continue;
    const baseRecord = beforeRecords.get(targetId);
    const previousMod = beforeMods.get(targetId);
    const labelRecord = baseRecord ?? afterMod.addedLeg ?? { id: targetId };
    for (const field of MODIFICATION_OVERRIDE_FIELDS) {
      if (!hasOwn(afterMod, field)) continue;
      const before = effectiveModificationBeforeValue(baseRecord, previousMod, field);
      const after = afterMod[field] ?? null;
      if (valuesEqual(before, after)) continue;
      deltas.push({
        targetType: 'modification',
        targetId,
        targetLabel: formatAuditFlightLabel(labelRecord),
        field: String(field),
        before,
        after,
      });
    }
  }
  return deltas;
}

export function buildScheduleNotificationPayloadFromHistory(params: {
  season: Pick<Season, 'id' | 'seasonCode'>;
  historyEntry: Pick<ModHistoryEntry, 'id' | 'timestamp'>;
  module: ScheduleNotificationModule;
  operation: string;
  beforeRecords?: RecordInput[];
  afterRecords?: RecordInput[];
  beforeModifications?: Map<string, FlightModification> | FlightModification[];
  afterModifications?: Map<string, FlightModification> | FlightModification[];
  targetRecordIds?: string[];
  metadata?: Record<string, unknown>;
}): ScheduleNotificationPayload {
  const beforeRecords = recordMap(params.beforeRecords);
  const afterRecords = recordMap(params.afterRecords);
  const beforeMods = modificationMap(params.beforeModifications);
  const afterMods = modificationMap(params.afterModifications);
  const targetIds = resolveTargetIds(params.targetRecordIds, beforeRecords, afterRecords, beforeMods, afterMods);

  const rawFlights = Array.from(targetIds)
    .map((targetId) => buildFlight(
      targetId,
      beforeRecords.get(targetId),
      afterRecords.get(targetId),
      beforeMods.get(targetId),
      afterMods.get(targetId),
    ))
    .sort((left, right) => (
      (left.date ?? '').localeCompare(right.date ?? '') ||
      left.pairKey.localeCompare(right.pairKey) ||
      left.type.localeCompare(right.type) ||
      left.label.localeCompare(right.label)
    ));
  const flights = addPatternMetadata(rawFlights, beforeRecords, afterRecords, beforeMods, afterMods);

  const auditEntry = buildFlightActionAuditEntry({
    id: `notification-audit-${params.historyEntry.id}`,
    sessionId: `notification-session-${params.historyEntry.id}`,
    timestamp: params.historyEntry.timestamp,
    seasonId: params.season.id,
    seasonCode: params.season.seasonCode,
    module: params.module,
    operation: params.operation,
    beforeRecords: params.beforeRecords,
    afterRecords: params.afterRecords,
    beforeModifications: params.beforeModifications,
    afterModifications: params.afterModifications,
    targetRecordIds: params.targetRecordIds,
    metadata: params.metadata,
  });

  const effectiveModificationDeltas = buildEffectiveModificationDeltas(beforeRecords, beforeMods, afterMods, targetIds);
  const effectiveModificationTargets = new Set(effectiveModificationDeltas.map((delta) => delta.targetId));
  const auditDeltas = auditEntry.deltas.filter((delta) => !(
    delta.targetType === 'modification' &&
    delta.field === 'modification' &&
    effectiveModificationTargets.has(delta.targetId)
  ));

  const deltas = [...auditDeltas, ...effectiveModificationDeltas].map(normalizeDelta);
  const counts = countActions(flights);

  return {
    version: 1,
    historyEntryId: params.historyEntry.id,
    seasonId: params.season.id,
    seasonCode: params.season.seasonCode,
    module: params.module,
    operation: params.operation,
    timestamp: params.historyEntry.timestamp,
    counts,
    affectedPeriod: affectedPeriodForFlights(flights),
    changeKinds: deriveScheduleNotificationChangeKinds({ counts, flights, deltas }),
    monthlyImpact: buildMonthlyImpact(flights, beforeRecords, afterRecords, beforeMods, afterMods),
    flights,
    deltas,
  };
}

export function withScheduleNotificationPayload(
  historyEntry: ModHistoryEntry,
  params: Omit<Parameters<typeof buildScheduleNotificationPayloadFromHistory>[0], 'historyEntry'>
): ModHistoryEntry {
  const scheduleNotification = buildScheduleNotificationPayloadFromHistory({
    ...params,
    historyEntry,
  });
  if (!isScheduleNotificationPayloadRelevant(scheduleNotification)) return historyEntry;
  return {
    ...historyEntry,
    scheduleNotification,
  };
}

function formatOperator(operator: ScheduleNotificationFormatOptions['operator']): string {
  if (!operator) return 'Unknown operator';
  const display = normalizeString(operator.displayName);
  const email = normalizeString(operator.email);
  const uid = normalizeString(operator.uid);
  return display ?? email ?? uid ?? 'Unknown operator';
}

function formatPeriod(period: ScheduleNotificationPayload['affectedPeriod']): string {
  if (period.from && period.to && period.from !== period.to) return `${period.from} to ${period.to}`;
  return period.from ?? period.to ?? 'Unknown period';
}

function pluralizeFlight(count: number): string {
  return count === 1 ? 'Flight' : 'Flights';
}

function actionSummary(
  payload: Pick<ScheduleNotificationPayload, 'counts' | 'flights' | 'deltas' | 'changeKinds'>,
  unitInfo: { count: number; hasPair: boolean },
  period: ScheduleNotificationPayload['affectedPeriod']
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

function schedulePrefix(type: FlightRecord['type']): string {
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

export function isScheduleNotificationPayloadRelevant(payload: Pick<ScheduleNotificationPayload, 'counts' | 'flights' | 'deltas' | 'changeKinds'>): boolean {
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

function formatUtcPlus7Timestamp(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
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

function pushChunk(chunks: string[], header: string[], currentLines: string[]): void {
  if (currentLines.length === 0) return;
  chunks.push([...header, ...currentLines].join('\n'));
}

function splitLinesByLimit(header: string[], bodyLines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let currentLines: string[] = [];
  for (const line of bodyLines) {
    const candidate = [...header, ...currentLines, line].join('\n');
    if (currentLines.length > 0 && candidate.length > limit) {
      pushChunk(chunks, header, currentLines);
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  pushChunk(chunks, header, currentLines);
  return chunks.length > 0 ? chunks : [header.join('\n')];
}

function withPartNumbers(messages: string[]): string[] {
  if (messages.length <= 1) return messages;
  const total = messages.length;
  return messages.map((message, index) => `[${index + 1}/${total}]\n${message}`);
}

export function formatScheduleNotificationMessages(
  payload: ScheduleNotificationPayload,
  options: ScheduleNotificationFormatOptions = {},
): string[] {
  const flightGroups = groupFlightsByIdentity(payload.flights);
  const unitInfo = affectedUnitInfo(payload.flights);
  const header = [
    '🚨 FLIGHT SCHEDULE UPDATE',
    `👤 User: ${formatOperator(options.operator)}`,
    `📅 Season: ${payload.seasonCode ?? payload.seasonId}`,
  ];

  const flightLines = flightGroups.flatMap((group, index) => [
    index === 0 ? '' : '',
    ...formatGroupBlock(group),
  ]);
  const summaryLines = [
    '',
    `🔄 Modification Summary: ${actionSummary(payload, unitInfo, payload.affectedPeriod)}`,
    ...formatImpactLines(payload.monthlyImpact),
  ];
  const timestampLine = `⏰ Timestamp: ${formatUtcPlus7Timestamp(options.sentAt)}`;
  const chunks = splitLinesByLimit(header, [...flightLines, ...summaryLines, timestampLine], TELEGRAM_MESSAGE_SAFE_LIMIT - 16);
  return withPartNumbers(chunks);
}
