import type { FlightRecord, FlightModification, CheckInCounterWindowMap, FlightCounter } from './types';
import { hydrateFlightRecordFromPersistence } from './persistenceSchema.ts';

export interface SeasonalDraftCounterItem {
  counter_group: string;
  item_index: number;
  counter_value: string;
}

export interface SeasonalDraftWindowItem {
  counter_key: string;
  window_start: string;
  window_end: string;
}

export interface SeasonalDraftRecord {
  draft_id: string;
  season_id: string;
  link_id: string;
  type: 'A' | 'D';
  airline: string;
  flight_number: string;
  raw_flight_number?: string | null;
  request_status_code?: string | null;
  route: string;
  schedule: string;
  aircraft: string;
  category: string;
  code_shares?: string | null;
  int_dom_ind?: string | null;
  pax?: number | null;
  gate?: number | null;
  stand?: string | null;
  carousel?: number | null;
  mct?: string | null;
  fb?: string | null;
  lb?: string | null;
  bhs?: string | null;
  ghs?: string | null;
  date: string;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  operational_date?: string | null;
  iata_season_code?: string | null;
  flight_series_id?: string | null;
  day_of_week?: number | null;
  action?: 'modified' | 'added' | 'deleted' | null;
  source_row_index?: number | null;
  linked_source_row_index?: number | null;
  link_type?: 'overnight' | 'sameday' | null;
  pair_anchor_date?: string | null;
  linked_draft_id?: string | null;
  turnaround_id?: string | null;
  source_kind?: 'imported' | 'manual';
  source_side?: 'ARR' | 'DEP';
  status?: 'active' | 'deleted';
  deletion_reason?: string | null;
  counters?: SeasonalDraftCounterItem[];
  checkin_windows?: SeasonalDraftWindowItem[];
  check_in_start?: string | null;
  check_in_end?: string | null;
  check_in_allocation_mode?: string | null;
}

export interface SeasonalDraftChangeInput {
  draftId: string;
  expected: Record<string, unknown> | null;
  patch: Record<string, unknown>;
}

export interface SeasonalDraftMutationReceipt {
  status: 'committed';
  requestId: string;
  revision: string;
  events: Array<{
    draftId: string;
    serverSeq: string;
    after: Record<string, unknown>;
  }>;
}

export interface SeasonalDraftWindowResult {
  status: 'ok' | 'snapshot_changed';
  revision: string;
  epoch: string;
  serverHighWater: string;
  drafts: SeasonalDraftRecord[];
  hasMore: boolean;
  nextDraftId?: string | null;
}

export interface SeasonalDraftExportSnapshotResult {
  seasonId: string;
  seasonCode: string;
  draftRevision: string;
  draftEpoch: string;
  totalCount: number;
  serverHighWater: string;
  truncated: boolean;
  flightRecords: Array<Record<string, unknown>>;
  flightRecordCounters: Array<Record<string, unknown>>;
  flightRecordWindows: Array<Record<string, unknown>>;
}

export interface SeasonalPublishPreviewPlanningCounts {
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  ambiguous: number;
}

export interface SeasonalPublishPreviewOperationalCounts {
  write: number;
  retire: number;
}

export interface SeasonalPublishPreviewPayload {
  publishContractVersion: number;
  baseVersionId: string | null;
  draftRevision: string;
  draftEpoch: string;
  draftChecksum: string;
  scopeFingerprint: string;
  businessToday: string;
  proposedTag: string;
  publishedOn: string;
  sequenceInDay: number;
  rangeStart: string;
  rangeEnd: string;
  planningCounts: SeasonalPublishPreviewPlanningCounts;
  operationalCounts: SeasonalPublishPreviewOperationalCounts;
  diagnostics: Array<{ code: string; [key: string]: unknown }>;
  operationalDiagnosticCount?: number;
  skippedDays: string[];
  publishableDays: string[];
}

export interface SeasonalPublishPreviewResult {
  previewId: string;
  previewHash: string;
  status: 'ready' | 'blocked';
  preview: SeasonalPublishPreviewPayload;
  expiresAt: string;
}

export interface SeasonalPublishCommitResult {
  status: 'committed';
  previewId: string;
  versionId: string;
  versionTag: string;
  planningCounts: SeasonalPublishPreviewPlanningCounts;
  operationalCounts: SeasonalPublishPreviewOperationalCounts;
  skippedDays: string[];
  operationalRevision: string;
}

export interface SeasonalPublishVersionSummary {
  version_id: string;
  season_id: string;
  season_code: string;
  version_tag: string;
  sequence_in_day: number;
  published_at: string;
  published_by: string;
  publish_notes: string;
  range_start: string;
  range_end: string;
  total_flight_count: number;
  added_count: number;
  modified_count: number;
  removed_count: number;
  unchanged_count: number;
  skipped_day_count: number;
  snapshot_checksum: string;
  publish_sequence: string;
}

export interface SeasonalPublishVersionsPageResult {
  versions: SeasonalPublishVersionSummary[];
  hasMore: boolean;
  nextSequence: string | null;
}

export interface SeasonalPublishedDiffEntry {
  diff_id?: string;
  entry_index: string;
  version_id: string;
  base_version_id?: string | null;
  season_id: string;
  change_type: 'added' | 'modified' | 'removed';
  flight_key: string;
  source_draft_id: string;
  operational_date: string;
  side: 'ARR' | 'DEP';
  airline: string;
  flight_number: string;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
  changed_fields?: string[] | null;
}

export interface SeasonalPublishedDiffPageResult {
  entries: SeasonalPublishedDiffEntry[];
  hasMore: boolean;
  nextIndex: string | null;
  stale?: boolean;
}

export function isSeasonalPlanningV1Enabled(): boolean {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED === '1') {
    return true;
  }
  return false;
}

export function countersToSeasonalDraftItems(counter: FlightCounter | null | undefined): SeasonalDraftCounterItem[] {
  if (!counter) return [];
  const items: SeasonalDraftCounterItem[] = [];
  if (Array.isArray(counter)) {
    counter.forEach((val, idx) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        items.push({ counter_group: '__single__', item_index: idx, counter_value: String(val).trim() });
      }
    });
    return items;
  }
  for (const [group, values] of Object.entries(counter)) {
    if (Array.isArray(values)) {
      values.forEach((val, idx) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          items.push({ counter_group: group, item_index: idx, counter_value: String(val).trim() });
        }
      });
    }
  }
  return items;
}

export function windowsToSeasonalDraftItems(windows: CheckInCounterWindowMap | null | undefined): SeasonalDraftWindowItem[] {
  if (!windows) return [];
  const items: SeasonalDraftWindowItem[] = [];
  for (const [key, range] of Object.entries(windows)) {
    if (range && typeof range.start === 'string' && typeof range.end === 'string') {
      items.push({
        counter_key: key,
        window_start: range.start,
        window_end: range.end,
      });
    }
  }
  return items;
}

export function seasonalDraftItemsToCounter(items: SeasonalDraftCounterItem[] | null | undefined): FlightCounter {
  if (!items || items.length === 0) return {};
  const isSingleGroup = items.every((i) => i.counter_group === '__single__');
  if (isSingleGroup) {
    const sorted = [...items].sort((a, b) => a.item_index - b.item_index);
    return sorted.map((s) => s.counter_value);
  }
  const grouped: Record<string, string[]> = {};
  for (const item of items) {
    if (!grouped[item.counter_group]) grouped[item.counter_group] = [];
    grouped[item.counter_group].push(item.counter_value);
  }
  return grouped;
}

export function seasonalDraftItemsToWindows(items: SeasonalDraftWindowItem[] | null | undefined): CheckInCounterWindowMap {
  if (!items || items.length === 0) return {};
  const map: CheckInCounterWindowMap = {};
  for (const item of items) {
    map[item.counter_key] = { start: item.window_start, end: item.window_end };
  }
  return map;
}

export function seasonalDraftToFlightRecord(draft: SeasonalDraftRecord): FlightRecord {
  return hydrateFlightRecordFromPersistence({
    id: draft.draft_id,
    linkId: draft.link_id ?? draft.turnaround_id ?? undefined,
    checkInAllocationMode: (draft.check_in_allocation_mode as unknown as FlightRecord['checkInAllocationMode']) ?? null,
    type: draft.type,
    airline: draft.airline,
    flightNumber: draft.flight_number,
    rawFlightNumber: draft.raw_flight_number || draft.flight_number,
    requestStatusCode: draft.request_status_code || null,
    route: draft.route,
    schedule: draft.schedule,
    aircraft: draft.aircraft,
    category: draft.category,
    codeShares: draft.code_shares || null,
    intDomInd: draft.int_dom_ind || null,
    pax: draft.pax ?? null,
    gate: draft.gate ?? null,
    stand: draft.stand ?? null,
    carousel: draft.carousel ?? null,
    mct: draft.mct ?? null,
    fb: draft.fb ?? null,
    lb: draft.lb ?? null,
    bhs: draft.bhs ?? null,
    ghs: draft.ghs ?? null,
    date: draft.date,
    scheduledDate: draft.scheduled_date || draft.date,
    scheduledTime: draft.scheduled_time || draft.schedule,
    operationalDate: draft.operational_date || draft.date,
    iataSeasonCode: draft.iata_season_code || undefined,
    flightSeriesId: draft.flight_series_id || undefined,
    dayOfWeek: draft.day_of_week ?? 0,
    action: draft.action || null,
    sourceRowIndex: draft.source_row_index ?? 0,
    linkedSourceRowIndex: draft.linked_source_row_index ?? undefined,
    linkType: draft.link_type ?? undefined,
    pairAnchorDate: draft.pair_anchor_date ?? undefined,
    linkedRecordId: draft.linked_draft_id ?? undefined,
    draftId: draft.draft_id,
    sourceKind: draft.source_kind === 'manual' ? 'manual' : 'imported',
    sourceSide: draft.source_side ?? (draft.type === 'A' ? 'ARR' : 'DEP'),
    status: draft.status ?? 'active',
    turnaroundId: draft.turnaround_id ?? undefined,
    counter: seasonalDraftItemsToCounter(draft.counters),
    checkInCounterWindows: seasonalDraftItemsToWindows(draft.checkin_windows),
    checkInStart: draft.check_in_start ?? null,
    checkInEnd: draft.check_in_end ?? null,
  });
}

export function flightRecordToSeasonalDraftChange(
  record: FlightRecord,
  baseRecord: FlightRecord | null | undefined
): SeasonalDraftChangeInput | null {
  const draftId = record.draftId || record.id;
  if (!baseRecord) {
    const patch: Record<string, unknown> = {
      type: record.type,
      airline: record.airline.toUpperCase().trim(),
      flight_number: record.flightNumber.toUpperCase().trim(),
      raw_flight_number: record.rawFlightNumber || record.flightNumber,
      request_status_code: record.requestStatusCode ?? null,
      route: record.route.trim(),
      schedule: record.schedule,
      aircraft: record.aircraft,
      category: record.category,
      code_shares: record.codeShares ?? null,
      int_dom_ind: record.intDomInd ?? null,
      pax: record.pax ?? null,
      gate: record.gate ?? null,
      stand: record.stand ?? null,
      carousel: record.carousel ?? null,
      mct: record.mct ?? null,
      fb: record.fb ?? null,
      lb: record.lb ?? null,
      bhs: record.bhs ?? null,
      ghs: record.ghs ?? null,
      date: record.date,
      scheduled_date: record.scheduledDate || record.date,
      scheduled_time: record.scheduledTime || record.schedule,
      flight_series_id: record.flightSeriesId ?? null,
      day_of_week: record.dayOfWeek ?? 0,
      linked_draft_id: record.linkedRecordId ?? null,
      turnaround_id: record.turnaroundId ?? null,
      link_type: record.linkType ?? null,
      pair_anchor_date: record.pairAnchorDate ?? null,
      status: record.status ?? 'active',
      deletion_reason: record.status === 'deleted' ? 'planning_removed' : null,
      counters: countersToSeasonalDraftItems(record.counter),
      checkin_windows: windowsToSeasonalDraftItems(record.checkInCounterWindows),
      check_in_start: record.checkInStart ?? null,
      check_in_end: record.checkInEnd ?? null,
      check_in_allocation_mode: record.checkInAllocationMode ?? null,
    };
    return { draftId, expected: null, patch };
  }

  const expected: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};

  const checkScalar = (snakeKey: string, newVal: unknown, oldVal: unknown) => {
    const normNew = newVal === undefined ? null : newVal;
    const normOld = oldVal === undefined ? null : oldVal;
    if (normNew !== normOld) {
      expected[snakeKey] = normOld;
      patch[snakeKey] = normNew;
    }
  };

  checkScalar('type', record.type, baseRecord.type);
  checkScalar('airline', record.airline.toUpperCase().trim(), baseRecord.airline.toUpperCase().trim());
  checkScalar('flight_number', record.flightNumber.toUpperCase().trim(), baseRecord.flightNumber.toUpperCase().trim());
  checkScalar('raw_flight_number', record.rawFlightNumber || record.flightNumber, baseRecord.rawFlightNumber || baseRecord.flightNumber);
  checkScalar('request_status_code', record.requestStatusCode ?? null, baseRecord.requestStatusCode ?? null);
  checkScalar('route', record.route.trim(), baseRecord.route.trim());
  checkScalar('schedule', record.schedule, baseRecord.schedule);
  checkScalar('aircraft', record.aircraft, baseRecord.aircraft);
  checkScalar('category', record.category, baseRecord.category);
  checkScalar('code_shares', record.codeShares ?? null, baseRecord.codeShares ?? null);
  checkScalar('int_dom_ind', record.intDomInd ?? null, baseRecord.intDomInd ?? null);
  checkScalar('pax', record.pax ?? null, baseRecord.pax ?? null);
  checkScalar('gate', record.gate ?? null, baseRecord.gate ?? null);
  checkScalar('stand', record.stand ?? null, baseRecord.stand ?? null);
  checkScalar('carousel', record.carousel ?? null, baseRecord.carousel ?? null);
  checkScalar('mct', record.mct ?? null, baseRecord.mct ?? null);
  checkScalar('fb', record.fb ?? null, baseRecord.fb ?? null);
  checkScalar('lb', record.lb ?? null, baseRecord.lb ?? null);
  checkScalar('bhs', record.bhs ?? null, baseRecord.bhs ?? null);
  checkScalar('ghs', record.ghs ?? null, baseRecord.ghs ?? null);
  checkScalar('date', record.date, baseRecord.date);
  checkScalar('scheduled_date', record.scheduledDate || record.date, baseRecord.scheduledDate || baseRecord.date);
  checkScalar('scheduled_time', record.scheduledTime || record.schedule, baseRecord.scheduledTime || baseRecord.schedule);
  checkScalar('flight_series_id', record.flightSeriesId ?? null, baseRecord.flightSeriesId ?? null);
  checkScalar('day_of_week', record.dayOfWeek ?? 0, baseRecord.dayOfWeek ?? 0);
  checkScalar('linked_draft_id', record.linkedRecordId ?? null, baseRecord.linkedRecordId ?? null);
  checkScalar('turnaround_id', record.turnaroundId ?? null, baseRecord.turnaroundId ?? null);
  checkScalar('link_type', record.linkType ?? null, baseRecord.linkType ?? null);
  checkScalar('pair_anchor_date', record.pairAnchorDate ?? null, baseRecord.pairAnchorDate ?? null);
  checkScalar('status', record.status ?? 'active', baseRecord.status ?? 'active');
  if (record.status === 'deleted' && baseRecord.status !== 'deleted') {
    expected.deletion_reason = null;
    patch.deletion_reason = 'planning_removed';
  }
  checkScalar('check_in_start', record.checkInStart ?? null, baseRecord.checkInStart ?? null);
  checkScalar('check_in_end', record.checkInEnd ?? null, baseRecord.checkInEnd ?? null);
  checkScalar('check_in_allocation_mode', record.checkInAllocationMode ?? null, baseRecord.checkInAllocationMode ?? null);

  const newCounters = countersToSeasonalDraftItems(record.counter);
  const oldCounters = countersToSeasonalDraftItems(baseRecord.counter);
  if (JSON.stringify(newCounters) !== JSON.stringify(oldCounters)) {
    expected.counters = oldCounters;
    patch.counters = newCounters;
  }

  const newWindows = windowsToSeasonalDraftItems(record.checkInCounterWindows);
  const oldWindows = windowsToSeasonalDraftItems(baseRecord.checkInCounterWindows);
  if (JSON.stringify(newWindows) !== JSON.stringify(oldWindows)) {
    expected.checkin_windows = oldWindows;
    patch.checkin_windows = newWindows;
  }

  if (Object.keys(patch).length === 0) return null;
  return { draftId, expected, patch };
}
