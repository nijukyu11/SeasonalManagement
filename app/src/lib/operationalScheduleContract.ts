import type { CheckInAllocationMode, CheckInCounterWindowMap, FlightCounter, FlightRecord, StandValue } from './types';

export function isOperationalScheduleV1Enabled(): boolean {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED === '1') {
    return true;
  }
  return false;
}

/**
 * Matches database table public.operational_flight_legs exactly (M1-M5 schema).
 */
export interface OperationalFlightLeg {
  leg_id: string;
  leg_key: string;
  operational_date: string;
  scheduled_date: string;
  scheduled_time: string;
  side: 'ARR' | 'DEP';
  airline: string;
  flight_number: string;
  raw_flight_number: string | null;
  route: string;
  aircraft_type: string;
  flight_category: string;
  pax: number | null;
  code_shares: string | null;
  int_dom_ind: string | null;
  stand: string | null;
  gate: number | null;
  carousel: number | null;
  counter_token: string | null;
  mct: string | null;
  fb: string | null;
  lb: string | null;
  bhs: string | null;
  ghs: string | null;
  check_in_start: string | null;
  check_in_end: string | null;
  check_in_allocation_mode: 'grouped' | 'broken' | null;
  turnaround_id: string | null;
  linked_leg_id: string | null;
  link_type: 'sameday' | 'overnight' | null;
  pair_anchor_date: string | null;
  source_type: 'published_seasonal' | 'daily_import' | 'operational_manual';
  source_season_id: string | null;
  source_draft_id: string | null;
  source_batch_id: string | null;
  source_occurrence_key: string | null;
  source_row_number: number | null;
  published_version_id: string | null;
  authority_rank?: number;
  status: 'active' | 'cancelled' | 'deleted';
  deletion_reason: string | null;
  created_at?: string;
  created_by?: string | null;
  updated_at?: string;
  updated_by?: string | null;
  lineage_id?: string;
  lineage_generation?: number;
}

export interface OperationalLegCounter {
  leg_id: string;
  counter_group: string;
  item_index: number;
  counter_value: string;
}

export interface OperationalLegCheckinWindow {
  leg_id: string;
  counter_key: string;
  window_start: string;
  window_end: string;
}

export interface OperationalWindowSnapshot {
  revision: string;
  token: string;
}

export interface OperationalWindowCursor {
  operationalDate: string;
  scheduledTime: string;
  legId: string;
}

export interface OperationalWindowResult {
  status: 'ok' | 'snapshot_changed';
  startDate?: string;
  endDate?: string;
  resourceType?: string;
  snapshot: OperationalWindowSnapshot;
  resources?: Record<string, unknown[]>;
  legCounters?: OperationalLegCounter[];
  legCheckinWindows?: OperationalLegCheckinWindow[];
  page?: {
    returnedCount: number;
    hasMore: boolean;
    nextCursor: OperationalWindowCursor | null;
  };
  legs?: OperationalFlightLeg[];
  linkedLegs?: OperationalFlightLeg[];
  authorityDays?: unknown[];
}

export interface OperationalLegChangeInput {
  legId: string;
  patch: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface OperationalMutationEvent {
  targetId: string;
  serverSeq: string;
  after: Record<string, unknown>;
}

export interface OperationalMutationReceipt {
  status: 'committed' | 'conflict' | 'stale';
  requestId: string;
  revision: string;
  events?: OperationalMutationEvent[];
  appliedCount?: number;
  message?: string;
  createdLegIds?: string[];
}

export function getTodayVietnamIsoDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function getOperationalDayVietnamIso(now = new Date()): string {
  return getTodayVietnamIsoDate(new Date(now.getTime() - 5 * 3600_000));
}

export function resolveOperationalDate(scheduledDate: string, scheduledTime: string): string {
  if (!scheduledDate) return '';
  const time = (scheduledTime || '00:00').slice(0, 5);
  return time < '05:00' ? shiftVietnamIsoDate(scheduledDate, -1) : scheduledDate;
}

export function shiftVietnamIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type OperationalPreset = 'today' | 'tomorrow' | 'next7days' | 'custom';

export function buildOperationalDateRange(
  preset: OperationalPreset,
  customStart?: string,
  customEnd?: string,
  now = new Date(),
): { startDate: string; endDate: string } {
  const today = getOperationalDayVietnamIso(now);
  switch (preset) {
    case 'today':
      return { startDate: today, endDate: today };
    case 'tomorrow': {
      const tomorrow = shiftVietnamIsoDate(today, 1);
      return { startDate: tomorrow, endDate: tomorrow };
    }
    case 'next7days': {
      const end = shiftVietnamIsoDate(today, 6);
      return { startDate: today, endDate: end };
    }
    case 'custom':
      return {
        startDate: customStart || today,
        endDate: customEnd || customStart || today,
      };
    default:
      return { startDate: today, endDate: today };
  }
}

export function buildCounterFromLegCounters(counters: OperationalLegCounter[] | undefined): FlightCounter {
  if (!counters || counters.length === 0) return null;
  const groups: Record<string, string[]> = {};
  for (const c of counters) {
    if (!groups[c.counter_group]) groups[c.counter_group] = [];
    groups[c.counter_group].push(c.counter_value);
  }
  const groupKeys = Object.keys(groups);
  if (groupKeys.length === 0) return null;
  if (groupKeys.length === 1 && groupKeys[0] === '__single__') {
    return groups['__single__'];
  }
  return groups;
}

export function buildWindowsFromLegCheckinWindows(
  windows: OperationalLegCheckinWindow[] | undefined,
): CheckInCounterWindowMap {
  if (!windows || windows.length === 0) return {};
  const map: CheckInCounterWindowMap = {};
  for (const w of windows) {
    map[w.counter_key] = {
      start: w.window_start,
      end: w.window_end,
    };
  }
  return map;
}

function calculateDayOfWeek(dateStr: string): number {
  if (!dateStr) return 0;
  const parts = dateStr.split('-').map(Number);
  if (parts.length < 3) return 0;
  const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
  return day === 0 ? 7 : day;
}

// Keep exact server preimages: UI records shorten times and do not expose every DB field.
const operationalRecordPreimages = new WeakMap<FlightRecord, {
  leg: OperationalFlightLeg;
  counters: OperationalLegCounter[];
  windows: OperationalLegCheckinWindow[];
}>();

export function operationalLegToFlightRecord(
  leg: OperationalFlightLeg,
  counters?: OperationalLegCounter[],
  windows?: OperationalLegCheckinWindow[],
): FlightRecord {
  const legCounters = counters?.filter((c) => c.leg_id === leg.leg_id);
  const legWindows = windows?.filter((w) => w.leg_id === leg.leg_id);

  const sourceKindMap: Record<OperationalFlightLeg['source_type'], FlightRecord['sourceKind']> = {
    published_seasonal: 'seasonal',
    daily_import: 'daily',
    operational_manual: 'manual',
  };

  const record: FlightRecord = {
    id: leg.leg_id,
    linkId: leg.turnaround_id ?? (leg.linked_leg_id ? String(leg.linked_leg_id) : leg.leg_id),
    type: leg.side === 'ARR' ? 'A' : 'D',
    airline: leg.airline,
    flightNumber: leg.flight_number,
    rawFlightNumber: leg.raw_flight_number ?? (leg.flight_number.startsWith(leg.airline) ? leg.flight_number : `${leg.airline}${leg.flight_number}`),
    route: leg.route,
    schedule: leg.scheduled_time ? leg.scheduled_time.slice(0, 5) : '00:00',
    aircraft: leg.aircraft_type ?? '',
    category: leg.flight_category ?? '',
    flightType: 'PAX',
    intDomInd: leg.int_dom_ind ?? null,
    codeShares: leg.code_shares ?? null,
    date: leg.scheduled_date,
    scheduledDate: leg.scheduled_date,
    scheduledTime: leg.scheduled_time ? leg.scheduled_time.slice(0, 5) : '00:00',
    operationalDate: leg.operational_date,
    iataSeasonCode: undefined,
    dayOfWeek: calculateDayOfWeek(leg.scheduled_date || leg.operational_date),
    pax: leg.pax ?? null,
    gate: leg.gate ?? null,
    stand: (leg.stand as StandValue) ?? null,
    carousel: leg.carousel ?? null,
    mct: leg.mct ?? null,
    fb: leg.fb ?? null,
    lb: leg.lb ?? null,
    bhs: leg.bhs ?? null,
    ghs: leg.ghs ?? null,
    requestStatusCode: null,
    action: null,
    sourceRowIndex: leg.source_row_number ?? 0,
    status: leg.status === 'deleted' ? 'deleted' : 'active',
    sourceKind: sourceKindMap[leg.source_type] ?? 'imported',
    sourceSide: leg.side,
    turnaroundId: leg.turnaround_id ?? undefined,
    linkedRecordId: leg.linked_leg_id ?? undefined,
    draftId: leg.source_draft_id ?? undefined,
    linkType: leg.link_type ?? undefined,
    pairAnchorDate: leg.pair_anchor_date ?? undefined,
    checkInAllocationMode: (leg.check_in_allocation_mode as CheckInAllocationMode) ?? null,
    checkInStart: leg.check_in_start ?? null,
    checkInEnd: leg.check_in_end ?? null,
    counter: buildCounterFromLegCounters(legCounters),
    checkInCounterWindows: buildWindowsFromLegCheckinWindows(legWindows),
  };
  operationalRecordPreimages.set(record, { leg, counters: legCounters ?? [], windows: legWindows ?? [] });
  return record;
}

export async function loadFullOperationalScheduleWindow(input: {
  startDate: string;
  endDate: string;
  resourceType?: string;
  pageSize?: number;
  maxAttempts?: number;
  fetchWindowFn: (params: {
    startDate: string;
    endDate: string;
    resourceType?: string;
    pageSize?: number;
    afterOperationalDate?: string | null;
    afterScheduledTime?: string | null;
    afterLegId?: string | null;
    expectedSnapshot?: string | null;
  }) => Promise<OperationalWindowResult>;
}): Promise<{
  records: FlightRecord[];
  resources: Record<string, unknown[]>;
  snapshot: OperationalWindowSnapshot;
}> {
  const { startDate, endDate, resourceType = 'all', pageSize = 1000, maxAttempts = 50, fetchWindowFn } = input;
  const legMap = new Map<string, OperationalFlightLeg>();
  const counterMap = new Map<string, Map<string, OperationalLegCounter>>();
  const windowMap = new Map<string, Map<string, OperationalLegCheckinWindow>>();
  let resourcesAccum: Record<string, unknown[]> = {};
  let currentSnapshot: OperationalWindowSnapshot = { revision: '0', token: '' };

  let cursor: OperationalWindowCursor | null = null;
  let hasMore = true;
  let attempts = 0;

  while (hasMore) {
    attempts += 1;
    if (attempts > maxAttempts) {
      throw new Error(
        `Exceeded maximum pagination attempts (${maxAttempts}) while loading operational schedule window for ${startDate} to ${endDate}`,
      );
    }

    const res = await fetchWindowFn({
      startDate,
      endDate,
      resourceType,
      pageSize,
      afterOperationalDate: cursor?.operationalDate ?? null,
      afterScheduledTime: cursor?.scheduledTime ?? null,
      afterLegId: cursor?.legId ?? null,
      expectedSnapshot: cursor ? currentSnapshot.token : null,
    });

    if (res.status === 'snapshot_changed') {
      legMap.clear();
      counterMap.clear();
      windowMap.clear();
      resourcesAccum = {};
      cursor = null;
      hasMore = true;
      currentSnapshot = res.snapshot;
      continue;
    }

    currentSnapshot = res.snapshot;
    if (res.resources) {
      resourcesAccum = { ...resourcesAccum, ...res.resources };
    }

    if (res.legCounters) {
      for (const c of res.legCounters) {
        let legCounters = counterMap.get(c.leg_id);
        if (!legCounters) {
          legCounters = new Map<string, OperationalLegCounter>();
          counterMap.set(c.leg_id, legCounters);
        }
        legCounters.set(`${c.counter_group}:${c.item_index}`, c);
      }
    }

    if (res.legCheckinWindows) {
      for (const w of res.legCheckinWindows) {
        let legWindows = windowMap.get(w.leg_id);
        if (!legWindows) {
          legWindows = new Map<string, OperationalLegCheckinWindow>();
          windowMap.set(w.leg_id, legWindows);
        }
        legWindows.set(w.counter_key, w);
      }
    }

    if (res.legs) {
      for (const leg of res.legs) {
        legMap.set(leg.leg_id, leg);
      }
    }

    if (res.linkedLegs) {
      for (const leg of res.linkedLegs) {
        if (!legMap.has(leg.leg_id)) {
          legMap.set(leg.leg_id, leg);
        }
      }
    }

    hasMore = Boolean(res.page?.hasMore && res.page?.nextCursor);
    cursor = res.page?.nextCursor ?? null;
    if (!cursor) break;
  }

  const records: FlightRecord[] = [];
  for (const leg of legMap.values()) {
    if (leg.status !== 'deleted') {
      const counters = counterMap.has(leg.leg_id)
        ? Array.from(counterMap.get(leg.leg_id)!.values())
        : undefined;
      const windows = windowMap.has(leg.leg_id)
        ? Array.from(windowMap.get(leg.leg_id)!.values())
        : undefined;
      records.push(
        operationalLegToFlightRecord(
          leg,
          counters,
          windows,
        ),
      );
    }
  }
  return {
    records,
    resources: resourcesAccum,
    snapshot: currentSnapshot,
  };
}

export function flightCounterToDbCounters(
  counter: FlightCounter,
): Array<{ counter_group: string; item_index: number; counter_value: string }> {
  if (!counter) return [];
  if (typeof counter === 'string') {
    const trimmed = counter.trim();
    return trimmed ? [{ counter_group: '__single__', item_index: 0, counter_value: trimmed }] : [];
  }
  if (Array.isArray(counter)) {
    return counter
      .map((val, idx) => ({
        counter_group: '__single__',
        item_index: idx,
        counter_value: String(val).trim(),
      }))
      .filter((c) => c.counter_value.length > 0);
  }
  const result: Array<{ counter_group: string; item_index: number; counter_value: string }> = [];
  for (const [group, values] of Object.entries(counter)) {
    if (Array.isArray(values)) {
      values.forEach((val, idx) => {
        const trimmed = String(val).trim();
        if (trimmed) {
          result.push({ counter_group: group, item_index: idx, counter_value: trimmed });
        }
      });
    }
  }
  return result.sort((a, b) => a.counter_group.localeCompare(b.counter_group) || a.item_index - b.item_index);
}

export function flightWindowsToDbWindows(
  windows: CheckInCounterWindowMap | undefined,
): Array<{ counter_key: string; window_start: string; window_end: string }> {
  if (!windows) return [];
  return Object.entries(windows)
    .filter(([key, win]) => Boolean(key && win?.start && win?.end))
    .map(([key, win]) => ({
      counter_key: key,
      window_start: win.start,
      window_end: win.end,
    }))
    .sort((a, b) => a.counter_key.localeCompare(b.counter_key));
}

export function buildOperationalLegPatchAndPreimage(
  currentLeg: OperationalFlightLeg | FlightRecord,
  updates: Record<string, unknown>,
): OperationalLegChangeInput | null {
  const patch: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};

  const getProp = (field: string): unknown => {
    if (!('leg_id' in currentLeg)) {
      const source = operationalRecordPreimages.get(currentLeg);
      if (source) {
        if (field === 'counters') return source.counters.map(({ leg_id: _legId, ...counter }) => counter);
        if (field === 'checkin_windows') return source.windows.map(({ leg_id: _legId, ...window }) => window);
        return source.leg[field as keyof OperationalFlightLeg] ?? null;
      }
    }
    if ('leg_id' in currentLeg) {
      const legRec = currentLeg as unknown as Record<string, unknown>;
      if (field === 'counters') {
        const raw = legRec.counters;
        if (Array.isArray(raw)) {
          return (raw as Array<Record<string, unknown>>).map((c) => ({
            counter_group: String(c.counter_group ?? '__single__'),
            item_index: Number(c.item_index ?? 0),
            counter_value: String(c.counter_value ?? ''),
          }));
        }
        return [];
      }
      if (field === 'checkin_windows') {
        const raw = legRec.checkin_windows;
        if (Array.isArray(raw)) {
          return (raw as Array<Record<string, unknown>>).map((w) => ({
            counter_key: String(w.counter_key ?? ''),
            window_start: String(w.window_start ?? ''),
            window_end: String(w.window_end ?? ''),
          }));
        }
        return [];
      }
      return legRec[field] ?? null;
    }

    const record = currentLeg as FlightRecord;
    switch (field) {
      case 'airline': return record.airline ?? null;
      case 'flight_number': return record.flightNumber ?? null;
      case 'scheduled_date': return record.scheduledDate ?? record.date;
      case 'scheduled_time': {
        const time = record.scheduledTime ?? record.schedule;
        return time.length === 5 ? `${time}:00` : time;
      }
      case 'route': return record.route;
      case 'aircraft_type': return record.aircraft;
      case 'code_shares': return record.codeShares;
      case 'flight_category': return record.category;
      case 'int_dom_ind': return record.intDomInd;
      case 'status': return record.status;
      case 'deletion_reason': return null;
      case 'gate': return record.gate ?? null;
      case 'stand': return record.stand ?? null;
      case 'carousel': return record.carousel ?? null;
      case 'pax': return record.pax ?? null;
      case 'counter_token': return null;
      case 'mct': return record.mct ?? null;
      case 'fb': return record.fb ?? null;
      case 'lb': return record.lb ?? null;
      case 'bhs': return record.bhs ?? null;
      case 'ghs': return record.ghs ?? null;
      case 'check_in_start': return record.checkInStart ?? null;
      case 'check_in_end': return record.checkInEnd ?? null;
      case 'check_in_allocation_mode': return record.checkInAllocationMode ?? null;
      case 'linked_leg_id': return record.linkedRecordId ?? null;
      case 'turnaround_id': return record.turnaroundId ?? null;
      case 'link_type': return record.linkType ?? null;
      case 'pair_anchor_date': return record.pairAnchorDate ?? null;
      case 'counters': return flightCounterToDbCounters(record.counter);
      case 'checkin_windows': return flightWindowsToDbWindows(record.checkInCounterWindows ?? undefined);
      default: return null;
    }
  };

  const allowedFields = [
    'airline', 'flight_number', 'scheduled_date', 'scheduled_time', 'route', 'aircraft_type',
    'flight_category', 'int_dom_ind', 'code_shares', 'status', 'deletion_reason',
    'gate', 'stand', 'carousel', 'pax', 'counter_token', 'mct', 'fb', 'lb', 'bhs', 'ghs',
    'check_in_start', 'check_in_end', 'check_in_allocation_mode',
    'linked_leg_id', 'turnaround_id', 'link_type', 'pair_anchor_date',
    'counters', 'checkin_windows',
  ];

  const keyMap: Record<string, string> = {
    airline: 'airline',
    flightNumber: 'flight_number',
    flight_number: 'flight_number',
    scheduledDate: 'scheduled_date',
    scheduled_date: 'scheduled_date',
    date: 'scheduled_date',
    scheduledTime: 'scheduled_time',
    scheduled_time: 'scheduled_time',
    scheduleTime: 'scheduled_time',
    schedule: 'scheduled_time',
    route: 'route',
    aircraftType: 'aircraft_type',
    aircraft: 'aircraft_type',
    aircraft_type: 'aircraft_type',
    flightCategory: 'flight_category',
    category: 'flight_category',
    flight_category: 'flight_category',
    intDomInd: 'int_dom_ind',
    int_dom_ind: 'int_dom_ind',
    codeShares: 'code_shares',
    code_shares: 'code_shares',
    status: 'status',
    deletionReason: 'deletion_reason',
    deletion_reason: 'deletion_reason',
    gate: 'gate',
    stand: 'stand',
    carousel: 'carousel',
    pax: 'pax',
    counter: 'counters',
    counters: 'counters',
    counterToken: 'counter_token',
    counter_token: 'counter_token',
    mct: 'mct',
    fb: 'fb',
    lb: 'lb',
    bhs: 'bhs',
    ghs: 'ghs',
    checkInStart: 'check_in_start',
    check_in_start: 'check_in_start',
    checkInEnd: 'check_in_end',
    check_in_end: 'check_in_end',
    checkInAllocationMode: 'check_in_allocation_mode',
    check_in_allocation_mode: 'check_in_allocation_mode',
    linkedRecordId: 'linked_leg_id',
    linked_leg_id: 'linked_leg_id',
    turnaroundId: 'turnaround_id',
    turnaround_id: 'turnaround_id',
    linkType: 'link_type',
    link_type: 'link_type',
    pairAnchorDate: 'pair_anchor_date',
    pair_anchor_date: 'pair_anchor_date',
    checkin_windows: 'checkin_windows',
    checkInCounterWindows: 'checkin_windows',
  };

  const unsupportedFields: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const dbField = keyMap[key];
    if (dbField && allowedFields.includes(dbField)) {
      if (dbField === 'counters') {
        const isDbFormat = Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'counter_group' in value[0];
        patch.counters = isDbFormat ? value : flightCounterToDbCounters(value as FlightCounter);
      } else if (dbField === 'checkin_windows') {
        const isDbFormat = Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'counter_key' in value[0];
        patch.checkin_windows = isDbFormat ? value : flightWindowsToDbWindows(value as CheckInCounterWindowMap);
      } else {
        patch[dbField] = value;
      }
      expected[dbField] = getProp(dbField);
    } else {
      unsupportedFields.push(key);
    }
  }

  if (unsupportedFields.length > 0) {
    throw new Error(
      `Unsupported operational fields: [${unsupportedFields.join(', ')}]`,
    );
  }

  if (Object.keys(patch).length === 0) return null;

  const legId = 'leg_id' in currentLeg ? currentLeg.leg_id : currentLeg.id;
  return { legId, patch, expected };
}
export interface DailyImportLegInputV2 {
  operationalDate: string;
  scheduledDate: string;
  scheduledTime: string;
  side: 'ARR' | 'DEP';
  airline: string;
  flightNumber: string;
  rawFlightNumber?: string | null;
  route: string;
  aircraft?: string | null;
  category?: string | null;
  flightType?: string | null;
  requestStatusCode?: string | null;
  sheetName?: string;
  sourceRowNumber: number;
  resources?: Record<string, unknown>;
  rawResourceTokens?: Record<string, string | null>;
}

export interface DailyImportStagePayloadV2 {
  contractVersion: 2;
  requestId: string;
  fileName?: string;
  workbookProfile?: string;
  rawChecksum?: string;
  canonicalChecksum: string;
  resourcePolicyHash?: string;
  affectedDates: string[];
  confirmedZeroFlightDates?: string[];
  legs: DailyImportLegInputV2[];
  diagnostics?: Array<Record<string, unknown>>;
}

export interface DailyImportReplacedLegV2 {
  legId: string;
  sourceType: string;
  operationalDate: string;
  side: 'ARR' | 'DEP';
  airline: string;
  flightNumber: string;
  scheduledTime: string;
  route: string;
}

export interface DailyImportPreviewV2 {
  importGuardVersion: '2';
  valid: boolean;
  affectedDates: string[];
  confirmedZeroFlightDates: string[];
  sourceFingerprint: string;
  legCount: number;
  replacedCount?: number;
  rebaseCount?: number;
  replacedLegsCount?: number;
  replacedLegsTruncated?: boolean;
  replacedLegs?: DailyImportReplacedLegV2[];
  rebasedOverridesCount?: number;
  rebasedOverridesTruncated?: boolean;
  rebasedOverrides: Array<{
    occurrenceKey: string;
    matchedLegId: string | null;
    fields: Record<string, unknown>;
  }>;
  replacedBySource: Record<string, number>;
  inputHash: string;
}

export interface DailyImportUploadBeginResultV2 {
  uploadId: string;
  batchId: string;
  requestId: string;
  nextChunkIndex: number;
  chunkCount: number;
  totalChunks?: number;
  legCount: number;
  status: string;
}

export interface DailyImportUploadAppendResultV2 {
  uploadId: string;
  nextChunkIndex: number;
  receivedChunks: number;
  totalChunks: number;
}

export function parseDailyImportUploadBeginResultV2(value: unknown): DailyImportUploadBeginResultV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Daily import begin upload result must be an object');
  }
  const obj = value as Record<string, unknown>;
  const uploadId = (obj.uploadId ?? obj.upload_id ?? obj.batchId ?? obj.batch_id) as string;
  const batchId = (obj.batchId ?? obj.batch_id ?? uploadId) as string;
  const requestId = (obj.requestId ?? obj.request_id) as string;
  const nextChunkIndex = Number(obj.nextChunkIndex ?? obj.next_chunk_index ?? 0);
  const chunkCount = Number(obj.chunkCount ?? obj.chunk_count ?? obj.totalChunks ?? obj.total_chunks ?? 0);
  const legCount = Number(obj.legCount ?? obj.leg_count ?? 0);
  const status = String(obj.status ?? 'uploading');
  if (!uploadId || !requestId) {
    throw new Error('Daily import begin upload result missing required fields');
  }
  return { uploadId, batchId, requestId, nextChunkIndex, chunkCount, totalChunks: chunkCount, legCount, status };
}

export function parseDailyImportUploadAppendResultV2(value: unknown): DailyImportUploadAppendResultV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Daily import append upload result must be an object');
  }
  const obj = value as Record<string, unknown>;
  const uploadId = (obj.uploadId ?? obj.upload_id) as string;
  const nextChunkIndex = Number(obj.nextChunkIndex ?? obj.next_chunk_index ?? 0);
  const receivedChunks = Number(obj.receivedChunks ?? obj.received_chunks ?? 0);
  const totalChunks = Number(obj.totalChunks ?? obj.total_chunks ?? 0);
  if (!uploadId) {
    throw new Error('Daily import append upload result missing required fields');
  }
  return { uploadId, nextChunkIndex, receivedChunks, totalChunks };
}

export interface DailyImportStageResultV2 {
  batchId: string;
  requestId: string;
  status: 'validated' | 'failed' | 'cancelled' | 'expired' | 'committed';
  previewHash: string;
  preview: DailyImportPreviewV2;
  diagnostics: Array<Record<string, unknown>>;
  expiresAt: string;
  result: DailyImportCommittedResultV2 | null;
}

export interface DailyImportCommittedResultV2 {
  status: 'committed';
  batchId: string;
  affectedDates: string[];
  insertedCount: number;
  replacedCount: number;
  revision: string;
}

export function parseDailyImportStageResultV2(value: unknown): DailyImportStageResultV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Daily import stage result must be an object');
  }
  const raw = value as Record<string, unknown>;
  const batchId = (raw.batchId ?? raw.batch_id) as string;
  const requestId = (raw.requestId ?? raw.request_id) as string;
  const status = raw.status as DailyImportStageResultV2['status'];
  const previewHash = (raw.previewHash ?? raw.preview_hash) as string;
  const expiresAt = (raw.expiresAt ?? raw.expires_at ?? '') as string;
  const preview = raw.preview as Record<string, unknown> | undefined;
  const diagnostics = Array.isArray(raw.diagnostics) ? (raw.diagnostics as Array<Record<string, unknown>>) : [];
  const result = raw.result ? parseDailyImportCommittedResultV2(raw.result) : null;

  if (
    typeof batchId !== 'string' ||
    typeof requestId !== 'string' ||
    typeof status !== 'string' ||
    typeof previewHash !== 'string' ||
    !preview ||
    typeof preview !== 'object'
  ) {
    throw new Error('Daily import stage result missing required SQL batch fields');
  }

  const normalizedPreview: DailyImportPreviewV2 = {
    importGuardVersion: '2',
    valid: Boolean(preview.valid),
    affectedDates: Array.isArray(preview.affectedDates ?? preview.affected_dates) ? ((preview.affectedDates ?? preview.affected_dates) as string[]) : [],
    confirmedZeroFlightDates: Array.isArray(preview.confirmedZeroFlightDates ?? preview.confirmed_zero_flight_dates) ? ((preview.confirmedZeroFlightDates ?? preview.confirmed_zero_flight_dates) as string[]) : [],
    sourceFingerprint: String(preview.sourceFingerprint ?? preview.source_fingerprint ?? ''),
    legCount: Number(preview.legCount ?? preview.leg_count ?? 0),
    replacedCount: Number(preview.replacedCount ?? preview.replaced_count ?? preview.replacedLegsCount ?? preview.replaced_legs_count ?? 0),
    rebaseCount: Number(preview.rebaseCount ?? preview.rebase_count ?? 0),
    replacedLegsTruncated: preview.replacedLegsTruncated != null ? Boolean(preview.replacedLegsTruncated) : (preview.replaced_legs_truncated != null ? Boolean(preview.replaced_legs_truncated) : undefined),
    replacedLegs: Array.isArray(preview.replacedLegs ?? preview.replaced_legs) ? ((preview.replacedLegs ?? preview.replaced_legs) as DailyImportReplacedLegV2[]) : [],
    rebasedOverridesCount: preview.rebasedOverridesCount != null ? Number(preview.rebasedOverridesCount) : (preview.rebased_overrides_count != null ? Number(preview.rebased_overrides_count) : undefined),
    rebasedOverridesTruncated: preview.rebasedOverridesTruncated != null ? Boolean(preview.rebasedOverridesTruncated) : (preview.rebased_overrides_truncated != null ? Boolean(preview.rebased_overrides_truncated) : undefined),
    rebasedOverrides: Array.isArray(preview.rebasedOverrides ?? preview.rebased_overrides) ? ((preview.rebasedOverrides ?? preview.rebased_overrides) as DailyImportPreviewV2['rebasedOverrides']) : [],
    replacedBySource: (preview.replacedBySource ?? preview.replaced_by_source ?? {}) as Record<string, number>,
    inputHash: String(preview.inputHash ?? preview.input_hash ?? ''),
  };

  return {
    batchId,
    requestId,
    status,
    previewHash,
    preview: normalizedPreview,
    diagnostics,
    expiresAt,
    result,
  };
}

export function parseDailyImportCommittedResultV2(value: unknown): DailyImportCommittedResultV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Daily import commit receipt must be an object');
  }
  const raw = value as Record<string, unknown>;
  const batchId = (raw.batchId ?? raw.batch_id) as string;
  const status = raw.status as 'committed';
  const revision = raw.revision != null ? String(raw.revision) : null;
  const affectedDates = (raw.affectedDates ?? raw.affected_dates) as string[];
  const insertedCount = Number(raw.insertedCount ?? raw.inserted_count ?? 0);
  const replacedCount = Number(raw.replacedCount ?? raw.replaced_count ?? 0);
  if (
    status !== 'committed' ||
    typeof batchId !== 'string' ||
    revision == null ||
    !Array.isArray(affectedDates)
  ) {
    throw new Error('Daily import commit receipt is missing required SQL receipt fields (status, batchId, affectedDates, insertedCount, replacedCount, revision)');
  }
  return {
    status: 'committed',
    batchId,
    affectedDates: affectedDates.map(String),
    insertedCount,
    replacedCount,
    revision,
  };
}

export function extractOperationalDatesFromChangeEvent(payload: {
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  [key: string]: unknown;
} | Record<string, unknown>): string[] {
  const dates = new Set<string>();
  if (!payload || typeof payload !== 'object') return [];

  const raw = payload as Record<string, unknown>;
  const hasWrapper = 'new' in raw || 'old' in raw;
  const newRow = (hasWrapper ? raw.new : raw) as Record<string, unknown> | undefined;
  const oldRow = (hasWrapper ? raw.old : undefined) as Record<string, unknown> | undefined;

  const parseState = (state: unknown): Record<string, unknown> | null => {
    if (!state) return null;
    if (typeof state === 'object') return state as Record<string, unknown>;
    if (typeof state === 'string') {
      try {
        const parsed = JSON.parse(state);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  };

  const checkRow = (row?: Record<string, unknown>) => {
    if (!row || typeof row !== 'object') return;
    const opDate = row.operational_date ?? row.operationalDate;
    if (opDate) dates.add(String(opDate));

    const afterState = parseState(row.after_state ?? row.afterState);
    if (afterState) {
      const d = afterState.operational_date ?? afterState.operationalDate;
      if (d) dates.add(String(d));
    }

    const beforeState = parseState(row.before_state ?? row.beforeState);
    if (beforeState) {
      const d = beforeState.operational_date ?? beforeState.operationalDate;
      if (d) dates.add(String(d));
    }
  };

  checkRow(newRow);
  checkRow(oldRow);

  return Array.from(dates);
}

export interface OperationalRealtimeClient {
  channel(name: string): {
    on(
      type: 'postgres_changes',
      filter: { event: string; schema: string; table: string },
      callback: (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => void,
    ): {
      subscribe(callback?: (status: string) => void): unknown;
    };
  };
  removeChannel(channel: unknown): unknown;
}

export function subscribeToOperationalChanges(
  client: OperationalRealtimeClient | unknown,
  options: {
    onDateInvalidated: (dates: string[], event?: Record<string, unknown>) => void;
    onEvent?: (event: Record<string, unknown>) => void;
    onStatus?: (status: string) => void;
    onReconnect?: () => void;
  },
): { unsubscribe: () => void } {
  if (!client || typeof (client as OperationalRealtimeClient).channel !== 'function') {
    return { unsubscribe: () => undefined };
  }
  const typedClient = client as OperationalRealtimeClient;
  const channelName = `operational-changes-${Math.random().toString(36).slice(2, 9)}`;
  const channel = typedClient.channel(channelName)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'operational_change_events' },
      (payload) => {
        const dates = extractOperationalDatesFromChangeEvent(payload);
        const eventRow = (payload?.new ?? (payload && !payload.old ? payload : undefined)) as Record<string, unknown> | undefined;
        if (dates.length > 0) {
          options.onDateInvalidated(dates, eventRow);
        }
        if (options.onEvent && eventRow) {
          options.onEvent(eventRow);
        }
      },
    )
    .subscribe((status: string) => {
      options.onStatus?.(status);
      if (status === 'SUBSCRIBED') {
        options.onReconnect?.();
      }
    });

  return {
    unsubscribe: () => {
      try {
        typedClient.removeChannel(channel);
      } catch {
        // ignore cleanup error
      }
    },
  };
}

export function shouldInvalidateOperationalWindow(
  dates: string[],
  activeWindow: { startDate: string; endDate: string },
  options?: {
    requestId?: string | null;
    ignoredRequestIds?: Set<string> | Iterable<string>;
    isMutating?: boolean;
  },
): boolean {
  if (!dates || dates.length === 0) return false;
  if (options?.isMutating) return false;
  if (options?.requestId && options?.ignoredRequestIds) {
    const ignored = options.ignoredRequestIds instanceof Set
      ? options.ignoredRequestIds
      : new Set(options.ignoredRequestIds);
    if (ignored.has(options.requestId)) return false;
  }
  return dates.some((d) => d >= activeWindow.startDate && d <= activeWindow.endDate);
}
