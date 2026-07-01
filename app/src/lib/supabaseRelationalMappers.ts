import type {
  AircraftGroup,
  AiAnalysisContextDocument,
  AirlineColorSetting,
  CheckInCounterGroup,
  CheckInCounterLock,
  CheckInCounterResource,
  CounterAllocationRule,
  FlightCounter,
  FlightLeg,
  FlightModification,
  FlightRecord,
  GateGroup,
  GateLock,
  GateResource,
  ModHistoryEntry,
  OperationalSettings,
  ParsedRow,
  RouteCountryMapping,
  Season,
  StandGateMapping,
} from './types';
import {
  hydrateFlightModificationFromPersistence,
  hydrateFlightRecordFromPersistence,
  hydrateModHistoryEntryFromPersistence,
  hydrateSourceRowFromPersistence,
  serializeFlightModificationForPersistence,
  serializeFlightRecordForPersistence,
  serializeModHistoryEntryForPersistence,
  serializeSourceRowForPersistence,
} from './persistenceSchema';
import { withOperationalFlightMetadata } from './iataSeason';
import { hydrateOperationalSettings, validateOperationalSettings } from './settingsRules';

type JsonSnapshot = Record<string, unknown> | null;

export type SeasonRelationalRow = {
  id: string;
  season_code: string | null;
  name: string | null;
  file_name: string | null;
  uploaded_at: number | null;
  effective_start: string | null;
  effective_end: string | null;
  total_legs: number | null;
  total_source_rows: number | null;
  data_version: number | null;
  last_synced_at: number | null;
};

export type SourceRowRelationalRow = {
  season_id: string;
  row_index: number;
  effective: string | null;
  discontinue: string | null;
  airline: string | null;
  aircraft: string | null;
  sta: string | null;
  arr_flight: string | null;
  arr_route: string | null;
  arr_category: string | null;
  arr_code_shares: string | null;
  arr_int_dom_ind: string | null;
  std: string | null;
  dep_flight: string | null;
  dep_route: string | null;
  dep_category: string | null;
  dep_code_shares: string | null;
  dep_int_dom_ind: string | null;
  overnight_link_row_index: number | null;
  link_type: 'overnight' | 'sameday' | null;
};

export type SourceRowDayRelationalRow = {
  season_id: string;
  row_index: number;
  iso_dow: number;
};

export type FlightRecordRelationalRow = {
  season_id: string;
  record_id: string;
  link_id: string | null;
  type: 'A' | 'D' | null;
  airline: string | null;
  flight_number: string | null;
  raw_flight_number: string | null;
  request_status_code: string | null;
  route: string | null;
  schedule: string | null;
  aircraft: string | null;
  category: string | null;
  code_shares: string | null;
  int_dom_ind: string | null;
  pax: number | null;
  gate: number | null;
  stand: number | null;
  carousel: number | null;
  mct: string | null;
  fb: string | null;
  lb: string | null;
  bhs: string | null;
  ghs: string | null;
  date: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  operational_date: string | null;
  iata_season_code: string | null;
  flight_series_id: string | null;
  day_of_week: number | null;
  action: 'modified' | 'added' | 'deleted' | null;
  source_row_index: number | null;
  linked_source_row_index: number | null;
  link_type: 'overnight' | 'sameday' | null;
  pair_anchor_date: string | null;
  linked_record_id: string | null;
  source_kind: 'imported' | 'added' | null;
  source_side: 'ARR' | 'DEP' | null;
  status: 'active' | 'deleted' | null;
  turnaround_id: string | null;
};

export type FlightRecordCounterRelationalRow = {
  record_id: string;
  counter_group: string;
  item_index: number;
  counter_value: string;
};

export type FlightRecordWindowRelationalRow = {
  record_id: string;
  counter_key: string;
  window_start: string;
  window_end: string;
};

export type ModificationRelationalRow = {
  season_id: string;
  leg_id: string;
  action: 'modified' | 'deleted' | 'added';
  changed_fields: string[];
  schedule: string | null;
  aircraft: string | null;
  route: string | null;
  code_shares: string | null;
  pax: number | null;
  gate: number | null;
  stand: number | null;
  carousel: number | null;
  mct: string | null;
  fb: string | null;
  lb: string | null;
  bhs: string | null;
  ghs: string | null;
  check_in_start: string | null;
  check_in_end: string | null;
  check_in_allocation_mode: 'grouped' | 'broken' | null;
};

export type ModificationAddedLegRelationalRow = FlightRecordRelationalRow & {
  leg_id: string;
};

export type ModificationCounterRelationalRow = {
  leg_id: string;
  counter_group: string;
  item_index: number;
  counter_value: string;
};

export type ModificationWindowRelationalRow = {
  leg_id: string;
  counter_key: string;
  window_start: string;
  window_end: string;
};

export type ModHistoryEntryRelationalRow = {
  season_id: string;
  entry_id: string;
  timestamp: number;
  description: string;
};

export type ModHistoryChangeRelationalRow = {
  entry_id: string;
  change_index: number;
  leg_id: string;
  previous_mod_snapshot: JsonSnapshot;
  new_mod_snapshot: JsonSnapshot;
};

export type ModHistoryRecordChangeRelationalRow = {
  entry_id: string;
  change_index: number;
  record_id: string;
  previous_record_snapshot: JsonSnapshot;
  new_record_snapshot: JsonSnapshot;
};

export type OperationalSettingsRow = {
  id: string;
  updated_at: number | null;
  ai_enabled: boolean;
  ai_active_model_id: string | null;
  ai_updated_at: number | null;
  dashboard_arrival_bucket_flights?: number | null;
  dashboard_departure_bucket_flights?: number | null;
  dashboard_ad_gap_flights?: number | null;
  dashboard_ctg_abs_pct?: number | null;
  dashboard_pax_coverage_min_pct?: number | null;
};

export type OperationalAiContextDocumentRow = {
  id: string;
  kind: 'rule' | 'skill' | null;
  title: string | null;
  content_md: string | null;
  enabled: boolean | null;
  sort_order: number | null;
  created_at: number | null;
  updated_at: number | null;
};

const SINGLE_COUNTER_GROUP = '__single__';

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripUndefinedDeep(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue === undefined) continue;
    output[key] = stripUndefinedDeep(entryValue);
  }
  return output as T;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function normalizeCounterValues(value: string | number | Array<string | number>): string[] {
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry));
}

function counterRows<T extends { counter_group: string; item_index: number; counter_value: string }>(
  counter: FlightCounter,
  build: (group: string, itemIndex: number, value: string) => T
): T[] {
  if (counter == null) return [];
  if (typeof counter === 'string' || typeof counter === 'number') {
    return [build(SINGLE_COUNTER_GROUP, 0, String(counter))];
  }
  if (Array.isArray(counter)) {
    return counter.map((value, index) => build(SINGLE_COUNTER_GROUP, index, String(value)));
  }
  const rows: T[] = [];
  for (const [group, value] of Object.entries(counter)) {
    normalizeCounterValues(value).forEach((entry, index) => rows.push(build(group, index, entry)));
  }
  return rows;
}

function rowsToCounter<T extends { counter_group: string | null; item_index: number | null; counter_value: string | null }>(rows: T[]): FlightCounter {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) =>
    String(a.counter_group ?? '').localeCompare(String(b.counter_group ?? '')) ||
    Number(a.item_index ?? 0) - Number(b.item_index ?? 0)
  );
  const isSingle = ordered.every((row) => (row.counter_group ?? SINGLE_COUNTER_GROUP) === SINGLE_COUNTER_GROUP);
  if (isSingle) {
    const values = ordered.map((row) => String(row.counter_value ?? ''));
    return values.length === 1 ? values[0] : values;
  }
  const grouped: Record<string, string | string[]> = {};
  for (const row of ordered) {
    const group = String(row.counter_group ?? '');
    const value = String(row.counter_value ?? '');
    const current = grouped[group];
    if (current == null) grouped[group] = value;
    else if (Array.isArray(current)) current.push(value);
    else grouped[group] = [current, value];
  }
  return grouped;
}

function windowsToRows<T>(
  windows: FlightRecord['checkInCounterWindows'],
  build: (counterKey: string, start: string, end: string) => T
): T[] {
  if (!windows) return [];
  return Object.entries(windows).map(([counterKey, window]) => build(counterKey, window.start, window.end));
}

function rowsToWindows<T extends { counter_key: string | null; window_start: string | null; window_end: string | null }>(rows: T[]): FlightRecord['checkInCounterWindows'] {
  if (rows.length === 0) return null;
  return Object.fromEntries(
    rows
      .filter((row) => row.counter_key && row.window_start && row.window_end)
      .map((row) => [String(row.counter_key), { start: String(row.window_start), end: String(row.window_end) }])
  );
}

export function toSeasonRow(season: Omit<Season, 'id'> | Season, id: string, uploadedAt = season.uploadedAt): SeasonRelationalRow {
  return {
    id,
    season_code: season.seasonCode,
    name: season.name,
    file_name: season.fileName,
    uploaded_at: uploadedAt,
    effective_start: season.effectiveStart,
    effective_end: season.effectiveEnd,
    total_legs: season.totalLegs,
    total_source_rows: season.totalSourceRows,
    data_version: season.dataVersion ?? 0,
    last_synced_at: season.lastSyncedAt ?? null,
  };
}

export function fromSeasonRow(row: SeasonRelationalRow): Season {
  return {
    id: row.id,
    seasonCode: row.season_code ?? '',
    name: row.name ?? row.season_code ?? '',
    fileName: row.file_name ?? '',
    uploadedAt: row.uploaded_at ?? 0,
    effectiveStart: row.effective_start ?? '',
    effectiveEnd: row.effective_end ?? '',
    totalLegs: row.total_legs ?? 0,
    totalSourceRows: row.total_source_rows ?? 0,
    dataVersion: row.data_version ?? 0,
    lastSyncedAt: row.last_synced_at ?? undefined,
  };
}

export function toSourceRowRow(seasonId: string, row: ParsedRow): SourceRowRelationalRow {
  const persisted = serializeSourceRowForPersistence(row);
  return {
    season_id: seasonId,
    row_index: persisted.rowIndex,
    effective: persisted.effective,
    discontinue: persisted.discontinue,
    airline: persisted.airline,
    aircraft: persisted.aircraft,
    sta: persisted.sta,
    arr_flight: persisted.arrFlight,
    arr_route: persisted.arrRoute,
    arr_category: persisted.arrFlightCategory,
    arr_code_shares: persisted.arrCodeShares,
    arr_int_dom_ind: persisted.arrIntDomInd,
    std: persisted.std,
    dep_flight: persisted.depFlight,
    dep_route: persisted.depRoute,
    dep_category: persisted.depFlightCategory,
    dep_code_shares: persisted.depCodeShares,
    dep_int_dom_ind: persisted.depIntDomInd,
    overnight_link_row_index: persisted.overnightLinkRowIndex ?? null,
    link_type: persisted.linkType ?? null,
  };
}

export function toSourceRowDayRows(seasonId: string, row: ParsedRow): SourceRowDayRelationalRow[] {
  return row.daysOfWeek
    .map((operates, index) => operates ? { season_id: seasonId, row_index: row.rowIndex, iso_dow: index + 1 } : null)
    .filter((entry): entry is SourceRowDayRelationalRow => entry !== null);
}

export function fromSourceRowRows(row: SourceRowRelationalRow, dayRows: SourceRowDayRelationalRow[]): ParsedRow {
  return hydrateSourceRowFromPersistence({
    rowIndex: row.row_index,
    effective: row.effective ?? '',
    discontinue: row.discontinue ?? '',
    airline: row.airline ?? '',
    aircraft: row.aircraft ?? '',
    daysOfWeek: Array.from({ length: 7 }, (_, index) => dayRows.some((day) => day.row_index === row.row_index && day.iso_dow === index + 1)),
    sta: row.sta,
    arrFlight: row.arr_flight,
    arrRoute: row.arr_route,
    arrFlightCategory: row.arr_category,
    arrCodeShares: row.arr_code_shares,
    arrIntDomInd: row.arr_int_dom_ind,
    std: row.std,
    depFlight: row.dep_flight,
    depRoute: row.dep_route,
    depFlightCategory: row.dep_category,
    depCodeShares: row.dep_code_shares,
    depIntDomInd: row.dep_int_dom_ind,
    overnightLinkRowIndex: row.overnight_link_row_index ?? undefined,
    linkType: row.link_type ?? undefined,
  });
}

export function toFlightRecordRow(seasonId: string, record: FlightRecord): FlightRecordRelationalRow {
  const persisted = serializeFlightRecordForPersistence(withOperationalFlightMetadata(record));
  return {
    season_id: seasonId,
    record_id: persisted.id,
    link_id: persisted.linkId,
    type: persisted.type,
    airline: persisted.airline,
    flight_number: persisted.flightNumber,
    raw_flight_number: persisted.rawFlightNumber,
    request_status_code: persisted.requestStatusCode,
    route: persisted.route,
    schedule: persisted.schedule,
    aircraft: persisted.aircraft,
    category: persisted.category,
    code_shares: persisted.codeShares,
    int_dom_ind: persisted.intDomInd,
    pax: persisted.pax,
    gate: persisted.gate,
    stand: persisted.stand,
    carousel: persisted.carousel,
    mct: persisted.mct,
    fb: persisted.fb,
    lb: persisted.lb,
    bhs: persisted.bhs,
    ghs: persisted.ghs,
    date: persisted.date,
    scheduled_date: persisted.scheduledDate ?? persisted.date,
    scheduled_time: persisted.scheduledTime ?? persisted.schedule,
    operational_date: persisted.operationalDate ?? persisted.date,
    iata_season_code: persisted.iataSeasonCode ?? null,
    flight_series_id: persisted.flightSeriesId ?? null,
    day_of_week: persisted.dayOfWeek,
    action: persisted.action,
    source_row_index: persisted.sourceRowIndex,
    linked_source_row_index: persisted.linkedSourceRowIndex ?? null,
    link_type: persisted.linkType ?? null,
    pair_anchor_date: persisted.pairAnchorDate ?? null,
    linked_record_id: persisted.linkedRecordId ?? null,
    source_kind: persisted.sourceKind,
    source_side: persisted.sourceSide,
    status: persisted.status,
    turnaround_id: persisted.turnaroundId ?? null,
  };
}

export function toFlightRecordCounterRows(record: FlightRecord): FlightRecordCounterRelationalRow[] {
  return counterRows(record.counter, (group, itemIndex, value) => ({
    record_id: record.id,
    counter_group: group,
    item_index: itemIndex,
    counter_value: value,
  }));
}

export function toFlightRecordWindowRows(record: FlightRecord): FlightRecordWindowRelationalRow[] {
  return windowsToRows(record.checkInCounterWindows, (counterKey, start, end) => ({
    record_id: record.id,
    counter_key: counterKey,
    window_start: start,
    window_end: end,
  }));
}

export function fromFlightRecordRows(
  row: FlightRecordRelationalRow,
  counterRowsForRecord: FlightRecordCounterRelationalRow[],
  windowRowsForRecord: FlightRecordWindowRelationalRow[]
): FlightRecord {
  return hydrateFlightRecordFromPersistence({
    id: row.record_id,
    linkId: row.link_id ?? '',
    type: row.type ?? 'A',
    airline: row.airline ?? '',
    flightNumber: row.flight_number ?? '',
    rawFlightNumber: row.raw_flight_number ?? row.flight_number ?? '',
    requestStatusCode: row.request_status_code,
    route: row.route ?? '',
    schedule: row.schedule ?? '',
    aircraft: row.aircraft ?? '',
    category: row.category ?? '',
    codeShares: row.code_shares,
    intDomInd: row.int_dom_ind,
    pax: row.pax,
    gate: row.gate,
    stand: row.stand,
    counter: rowsToCounter(counterRowsForRecord),
    checkInCounterWindows: rowsToWindows(windowRowsForRecord),
    carousel: row.carousel,
    mct: row.mct,
    fb: row.fb,
    lb: row.lb,
    bhs: row.bhs,
    ghs: row.ghs,
    date: row.date ?? '',
    scheduledDate: row.scheduled_date ?? row.date ?? '',
    scheduledTime: row.scheduled_time ?? row.schedule ?? '',
    operationalDate: row.operational_date ?? row.date ?? '',
    iataSeasonCode: row.iata_season_code ?? undefined,
    flightSeriesId: row.flight_series_id ?? undefined,
    dayOfWeek: row.day_of_week ?? 0,
    action: row.action,
    sourceRowIndex: row.source_row_index ?? 0,
    linkedSourceRowIndex: row.linked_source_row_index ?? undefined,
    linkType: row.link_type ?? undefined,
    pairAnchorDate: row.pair_anchor_date ?? undefined,
    linkedRecordId: row.linked_record_id ?? undefined,
    sourceKind: row.source_kind ?? 'imported',
    sourceSide: row.source_side ?? 'ARR',
    status: row.status ?? 'active',
    turnaroundId: row.turnaround_id ?? undefined,
  });
}

export function toModificationRow(seasonId: string, mod: FlightModification): ModificationRelationalRow {
  const persisted = serializeFlightModificationForPersistence(mod);
  const changedFields = Object.keys(persisted).filter((field) => !['legId', 'action', 'addedLeg', 'counter', 'checkInCounterWindows'].includes(field));
  if ('counter' in persisted) changedFields.push('counter');
  if ('checkInCounterWindows' in persisted) changedFields.push('checkInCounterWindows');
  if ('addedLeg' in persisted) changedFields.push('addedLeg');
  return {
    season_id: seasonId,
    leg_id: persisted.legId,
    action: persisted.action,
    changed_fields: [...new Set(changedFields)],
    schedule: persisted.schedule ?? null,
    aircraft: persisted.aircraft ?? null,
    route: persisted.route ?? null,
    code_shares: persisted.codeShares ?? null,
    pax: persisted.pax ?? null,
    gate: persisted.gate ?? null,
    stand: persisted.stand ?? null,
    carousel: persisted.carousel ?? null,
    mct: persisted.mct ?? null,
    fb: persisted.fb ?? null,
    lb: persisted.lb ?? null,
    bhs: persisted.bhs ?? null,
    ghs: persisted.ghs ?? null,
    check_in_start: persisted.checkInStart ?? null,
    check_in_end: persisted.checkInEnd ?? null,
    check_in_allocation_mode: persisted.checkInAllocationMode ?? null,
  };
}

export function toModificationCounterRows(mod: FlightModification): ModificationCounterRelationalRow[] {
  return counterRows(mod.counter ?? null, (group, itemIndex, value) => ({
    leg_id: mod.legId,
    counter_group: group,
    item_index: itemIndex,
    counter_value: value,
  }));
}

export function toModificationWindowRows(mod: FlightModification): ModificationWindowRelationalRow[] {
  return windowsToRows(mod.checkInCounterWindows ?? null, (counterKey, start, end) => ({
    leg_id: mod.legId,
    counter_key: counterKey,
    window_start: start,
    window_end: end,
  }));
}

export function toModificationAddedLegRow(seasonId: string, mod: FlightModification): ModificationAddedLegRelationalRow | null {
  if (mod.action !== 'added' || !mod.addedLeg) return null;
  const leg = mod.addedLeg as FlightLeg;
  return {
    ...toFlightRecordRow(seasonId, {
      ...leg,
      sourceKind: 'added',
      sourceSide: leg.type === 'A' ? 'ARR' : 'DEP',
      status: 'active',
    } as FlightRecord),
    leg_id: mod.legId,
  };
}

export function fromModificationRows(
  row: ModificationRelationalRow,
  counterRowsForMod: ModificationCounterRelationalRow[],
  windowRowsForMod: ModificationWindowRelationalRow[],
  addedLegRow?: ModificationAddedLegRelationalRow | null
): FlightModification {
  const changedFields = new Set(row.changed_fields ?? []);
  const mod: FlightModification = { legId: row.leg_id, action: row.action };
  const assign = <K extends keyof FlightModification>(field: K, value: FlightModification[K]) => {
    if (changedFields.has(String(field))) mod[field] = value;
  };
  assign('schedule', row.schedule as FlightModification['schedule']);
  assign('aircraft', row.aircraft as FlightModification['aircraft']);
  assign('route', row.route as FlightModification['route']);
  assign('codeShares', row.code_shares as FlightModification['codeShares']);
  assign('pax', row.pax as FlightModification['pax']);
  assign('gate', row.gate as FlightModification['gate']);
  assign('stand', row.stand as FlightModification['stand']);
  assign('carousel', row.carousel as FlightModification['carousel']);
  assign('mct', row.mct as FlightModification['mct']);
  assign('fb', row.fb as FlightModification['fb']);
  assign('lb', row.lb as FlightModification['lb']);
  assign('bhs', row.bhs as FlightModification['bhs']);
  assign('ghs', row.ghs as FlightModification['ghs']);
  assign('checkInStart', row.check_in_start as FlightModification['checkInStart']);
  assign('checkInEnd', row.check_in_end as FlightModification['checkInEnd']);
  assign('checkInAllocationMode', row.check_in_allocation_mode as FlightModification['checkInAllocationMode']);
  if (changedFields.has('counter')) mod.counter = rowsToCounter(counterRowsForMod);
  if (changedFields.has('checkInCounterWindows')) mod.checkInCounterWindows = rowsToWindows(windowRowsForMod);
  if (changedFields.has('addedLeg') && addedLegRow) {
    mod.addedLeg = hydrateFlightRecordFromPersistence({
      ...fromFlightRecordRows(addedLegRow, [], []),
      sourceKind: undefined,
      sourceSide: undefined,
      status: undefined,
    } as Partial<FlightRecord>) as FlightLeg;
  }
  return hydrateFlightModificationFromPersistence(mod);
}

export function toModHistoryRows(seasonId: string, entry: ModHistoryEntry): {
  entryRow: ModHistoryEntryRelationalRow;
  changeRows: ModHistoryChangeRelationalRow[];
  recordChangeRows: ModHistoryRecordChangeRelationalRow[];
} {
  const persisted = serializeModHistoryEntryForPersistence(entry);
  return {
    entryRow: {
      season_id: seasonId,
      entry_id: persisted.id,
      timestamp: persisted.timestamp,
      description: persisted.description,
    },
    changeRows: persisted.changes.map((change, index) => ({
      entry_id: persisted.id,
      change_index: index,
      leg_id: change.legId,
      previous_mod_snapshot: change.previousMod ? stripUndefinedDeep(change.previousMod as unknown as JsonSnapshot) : null,
      new_mod_snapshot: stripUndefinedDeep(change.newMod as unknown as JsonSnapshot),
    })),
    recordChangeRows: (persisted.recordChanges ?? []).map((change, index) => ({
      entry_id: persisted.id,
      change_index: index,
      record_id: change.recordId,
      previous_record_snapshot: change.previousRecord ? stripUndefinedDeep(change.previousRecord as unknown as JsonSnapshot) : null,
      new_record_snapshot: change.newRecord ? stripUndefinedDeep(change.newRecord as unknown as JsonSnapshot) : null,
    })),
  };
}

export function fromModHistoryRows(
  entryRow: ModHistoryEntryRelationalRow,
  changeRows: ModHistoryChangeRelationalRow[],
  recordChangeRows: ModHistoryRecordChangeRelationalRow[]
): ModHistoryEntry {
  return hydrateModHistoryEntryFromPersistence({
    id: entryRow.entry_id,
    timestamp: entryRow.timestamp,
    description: entryRow.description,
    changes: changeRows
      .sort((a, b) => a.change_index - b.change_index)
      .map((change) => ({
        legId: change.leg_id,
        previousMod: change.previous_mod_snapshot as unknown as FlightModification | null,
        newMod: change.new_mod_snapshot as unknown as FlightModification,
      })),
    recordChanges: recordChangeRows
      .sort((a, b) => a.change_index - b.change_index)
      .map((change) => ({
        recordId: change.record_id,
        previousRecord: change.previous_record_snapshot as unknown as FlightRecord | null,
        newRecord: change.new_record_snapshot as unknown as FlightRecord | null,
      })),
  });
}

export function toOperationalSettingsRow(settings: OperationalSettings): OperationalSettingsRow {
  const normalized = validateOperationalSettings(settings);
  return {
    id: 'operational',
    updated_at: normalized.updatedAt ?? Date.now(),
    ai_enabled: normalized.aiAnalysis.enabled,
    ai_active_model_id: normalized.aiAnalysis.activeModelId,
    ai_updated_at: normalized.aiAnalysis.updatedAt,
    dashboard_arrival_bucket_flights: normalized.dashboardAlerts.arrivalBucketFlights,
    dashboard_departure_bucket_flights: normalized.dashboardAlerts.departureBucketFlights,
    dashboard_ad_gap_flights: normalized.dashboardAlerts.adGapFlights,
    dashboard_ctg_abs_pct: normalized.dashboardAlerts.ctgAbsPct,
    dashboard_pax_coverage_min_pct: normalized.dashboardAlerts.paxCoverageMinPct,
  };
}

export function fromOperationalSettingsRows(input: {
  settingsRow: OperationalSettingsRow | null;
  routeCountries: RouteCountryMapping[];
  airlineColors: AirlineColorSetting[];
  aircraftGroups: AircraftGroup[];
  counterAllocationRules: CounterAllocationRule[];
  checkInCounters: CheckInCounterResource[];
  checkInCounterGroups: CheckInCounterGroup[];
  checkInCounterLocks: CheckInCounterLock[];
  gateResources: GateResource[];
  gateGroups: GateGroup[];
  gateLocks: GateLock[];
  standGateMappings: StandGateMapping[];
  aiModels: OperationalSettings['aiAnalysis']['models'];
  aiContextDocuments: AiAnalysisContextDocument[];
}): OperationalSettings {
  return hydrateOperationalSettings({
    updatedAt: input.settingsRow?.updated_at ?? null,
    routeCountries: input.routeCountries,
    airlineColors: input.airlineColors,
    aircraftGroups: input.aircraftGroups,
    counterAllocationRules: input.counterAllocationRules,
    checkInCounters: input.checkInCounters,
    checkInCounterGroups: input.checkInCounterGroups,
    checkInCounterLocks: input.checkInCounterLocks,
    gateResources: input.gateResources,
    gateGroups: input.gateGroups,
    gateLocks: input.gateLocks,
    standGateMappings: input.standGateMappings,
    dashboardAlerts: {
      arrivalBucketFlights: input.settingsRow?.dashboard_arrival_bucket_flights ?? null,
      departureBucketFlights: input.settingsRow?.dashboard_departure_bucket_flights ?? null,
      adGapFlights: input.settingsRow?.dashboard_ad_gap_flights ?? null,
      ctgAbsPct: input.settingsRow?.dashboard_ctg_abs_pct ?? null,
      paxCoverageMinPct: input.settingsRow?.dashboard_pax_coverage_min_pct ?? null,
    },
    aiAnalysis: {
      enabled: input.settingsRow?.ai_enabled ?? true,
      activeModelId: input.settingsRow?.ai_active_model_id ?? input.aiModels.find((model) => model.enabled)?.id ?? input.aiModels[0]?.id ?? 'gemini-flash',
      models: input.aiModels,
      contextDocuments: input.aiContextDocuments,
      updatedAt: input.settingsRow?.ai_updated_at ?? null,
    },
  });
}

export function toRouteCountryRows(settings: OperationalSettings): Array<{ route: string; country: string }> {
  return validateOperationalSettings(settings).routeCountries.map((entry) => ({ route: entry.route, country: entry.country }));
}

export function toAirlineColorRows(settings: OperationalSettings): Array<{ airline_code: string; color: string }> {
  return validateOperationalSettings(settings).airlineColors.map((entry) => ({ airline_code: entry.airlineCode, color: entry.color }));
}

export function toAircraftGroupRows(settings: OperationalSettings): Array<{ id: string; name: string; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).aircraftGroups.map((group) => ({
    id: group.id,
    name: group.name,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  }));
}

export function toAircraftGroupTypeRows(settings: OperationalSettings): Array<{ group_id: string; aircraft_type: string }> {
  return validateOperationalSettings(settings).aircraftGroups.flatMap((group) =>
    group.aircraftTypes.map((aircraftType) => ({ group_id: group.id, aircraft_type: aircraftType }))
  );
}

export function toCounterRuleRows(settings: OperationalSettings): Array<{
  id: string;
  name: string;
  enabled: boolean;
  priority_score: number;
  sort_order: number;
  condition_aircraft_types: string[];
  condition_aircraft_groups: string[];
  condition_airline_codes: string[];
  counter_value: number;
  created_at: number;
  updated_at: number;
}> {
  return validateOperationalSettings(settings).counterAllocationRules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority_score: rule.priorityScore,
    sort_order: rule.sortOrder,
    condition_aircraft_types: rule.conditions.aircraftTypes,
    condition_aircraft_groups: rule.conditions.aircraftGroups,
    condition_airline_codes: rule.conditions.airlineCodes,
    counter_value: rule.counterValue,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  }));
}

export function toCheckInCounterRows(settings: OperationalSettings): Array<{ id: string; label: string; enabled: boolean; sort_order: number; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).checkInCounters.map((counter) => ({
    id: counter.id,
    label: counter.label,
    enabled: counter.enabled,
    sort_order: counter.sortOrder,
    created_at: counter.createdAt,
    updated_at: counter.updatedAt,
  }));
}

export function toCheckInCounterGroupRows(settings: OperationalSettings): Array<{ id: string; name: string; bhs: string; sort_order: number; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).checkInCounterGroups.map((group) => ({
    id: group.id,
    name: group.name,
    bhs: group.bhs,
    sort_order: group.sortOrder,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  }));
}

export function toCheckInCounterGroupMemberRows(settings: OperationalSettings): Array<{ group_id: string; counter_id: string; sort_order: number }> {
  return validateOperationalSettings(settings).checkInCounterGroups.flatMap((group) =>
    group.counterIds.map((counterId, index) => ({ group_id: group.id, counter_id: counterId, sort_order: index }))
  );
}

export function toCheckInCounterLockRows(settings: OperationalSettings): Array<{ id: string; name: string; start_time: string; end_time: string; reason: string | null; enabled: boolean; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).checkInCounterLocks.map((lock) => ({
    id: lock.id,
    name: lock.name,
    start_time: lock.start,
    end_time: lock.end,
    reason: lock.reason,
    enabled: lock.enabled,
    created_at: lock.createdAt,
    updated_at: lock.updatedAt,
  }));
}

export function toCheckInCounterLockMemberRows(settings: OperationalSettings): Array<{ lock_id: string; counter_id: string; sort_order: number }> {
  return validateOperationalSettings(settings).checkInCounterLocks.flatMap((lock) =>
    lock.counterIds.map((counterId, index) => ({ lock_id: lock.id, counter_id: counterId, sort_order: index }))
  );
}

export function toGateResourceRows(settings: OperationalSettings): Array<{ id: string; label: string; enabled: boolean; sort_order: number; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).gateResources.map((gate) => ({
    id: gate.id,
    label: gate.label,
    enabled: gate.enabled,
    sort_order: gate.sortOrder,
    created_at: gate.createdAt,
    updated_at: gate.updatedAt,
  }));
}

export function toGateGroupRows(settings: OperationalSettings): Array<{ id: string; name: string; sort_order: number; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).gateGroups.map((group) => ({
    id: group.id,
    name: group.name,
    sort_order: group.sortOrder,
    created_at: group.createdAt,
    updated_at: group.updatedAt,
  }));
}

export function toGateGroupMemberRows(settings: OperationalSettings): Array<{ group_id: string; gate_id: string; sort_order: number }> {
  return validateOperationalSettings(settings).gateGroups.flatMap((group) =>
    group.gateIds.map((gateId, index) => ({ group_id: group.id, gate_id: gateId, sort_order: index }))
  );
}

export function toGateLockRows(settings: OperationalSettings): Array<{ id: string; name: string; start_time: string; end_time: string; reason: string | null; enabled: boolean; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).gateLocks.map((lock) => ({
    id: lock.id,
    name: lock.name,
    start_time: lock.start,
    end_time: lock.end,
    reason: lock.reason,
    enabled: lock.enabled,
    created_at: lock.createdAt,
    updated_at: lock.updatedAt,
  }));
}

export function toGateLockMemberRows(settings: OperationalSettings): Array<{ lock_id: string; gate_id: string; sort_order: number }> {
  return validateOperationalSettings(settings).gateLocks.flatMap((lock) =>
    lock.gateIds.map((gateId, index) => ({ lock_id: lock.id, gate_id: gateId, sort_order: index }))
  );
}

export function toStandGateMappingRows(settings: OperationalSettings): Array<{ id: string; stand: number; gate: number; sort_order: number; enabled: boolean; created_at: number; updated_at: number }> {
  return validateOperationalSettings(settings).standGateMappings.map((mapping) => ({
    id: mapping.id,
    stand: mapping.stand,
    gate: mapping.gate,
    sort_order: mapping.sortOrder,
    enabled: mapping.enabled,
    created_at: mapping.createdAt,
    updated_at: mapping.updatedAt,
  }));
}

export function toAiModelRows(settings: OperationalSettings): Array<{ id: string; label: string; provider: string; model: string; base_url: string | null; enabled: boolean; key_updated_at: number | null; sort_order: number }> {
  return validateOperationalSettings(settings).aiAnalysis.models.map((model, index) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    model: model.model,
    base_url: model.baseUrl,
    enabled: model.enabled,
    key_updated_at: model.keyUpdatedAt,
    sort_order: index,
  }));
}

export function toAiContextDocumentRows(settings: OperationalSettings): OperationalAiContextDocumentRow[] {
  return validateOperationalSettings(settings).aiAnalysis.contextDocuments.map((document, index) => ({
    id: document.id,
    kind: document.kind,
    title: document.title,
    content_md: document.contentMd,
    enabled: document.enabled,
    sort_order: document.sortOrder ?? index,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  }));
}

export function fromSettingsTableRows(input: {
  settingsRow: OperationalSettingsRow | null;
  routeCountryRows: Array<{ route: string | null; country: string | null }>;
  airlineColorRows: Array<{ airline_code: string | null; color: string | null }>;
  aircraftGroupRows: Array<{ id: string; name: string | null; created_at: number | null; updated_at: number | null }>;
  aircraftGroupTypeRows: Array<{ group_id: string; aircraft_type: string | null }>;
  counterRuleRows: Array<{
    id: string;
    name: string | null;
    enabled: boolean | null;
    priority_score: number | null;
    sort_order: number | null;
    condition_aircraft_types: string[] | null;
    condition_aircraft_groups: string[] | null;
    condition_airline_codes: string[] | null;
    counter_value: number | null;
    created_at: number | null;
    updated_at: number | null;
  }>;
  checkInCounterRows: Array<{ id: string; label: string | null; enabled: boolean | null; sort_order: number | null; created_at: number | null; updated_at: number | null }>;
  checkInCounterGroupRows: Array<{ id: string; name: string | null; bhs: string | null; sort_order: number | null; created_at: number | null; updated_at: number | null }>;
  checkInCounterGroupMemberRows: Array<{ group_id: string; counter_id: string | null; sort_order: number | null }>;
  checkInCounterLockRows: Array<{ id: string; name: string | null; start_time: string | null; end_time: string | null; reason: string | null; enabled: boolean | null; created_at: number | null; updated_at: number | null }>;
  checkInCounterLockMemberRows: Array<{ lock_id: string; counter_id: string | null; sort_order: number | null }>;
  gateResourceRows: Array<{ id: string; label: string | null; enabled: boolean | null; sort_order: number | null; created_at: number | null; updated_at: number | null }>;
  gateGroupRows: Array<{ id: string; name: string | null; sort_order: number | null; created_at: number | null; updated_at: number | null }>;
  gateGroupMemberRows: Array<{ group_id: string; gate_id: string | null; sort_order: number | null }>;
  gateLockRows: Array<{ id: string; name: string | null; start_time: string | null; end_time: string | null; reason: string | null; enabled: boolean | null; created_at: number | null; updated_at: number | null }>;
  gateLockMemberRows: Array<{ lock_id: string; gate_id: string | null; sort_order: number | null }>;
  standGateMappingRows: Array<{ id: string; stand: number | null; gate: number | null; sort_order: number | null; enabled: boolean | null; created_at: number | null; updated_at: number | null }>;
  aiModelRows: Array<{ id: string; label: string | null; provider: string | null; model: string | null; base_url: string | null; enabled: boolean | null; key_updated_at: number | null; sort_order: number | null }>;
  aiContextDocumentRows: OperationalAiContextDocumentRow[];
}): OperationalSettings {
  const groupTypeMap = new Map<string, string[]>();
  for (const row of input.aircraftGroupTypeRows) {
    if (!row.aircraft_type) continue;
    const values = groupTypeMap.get(row.group_id) ?? [];
    values.push(row.aircraft_type);
    groupTypeMap.set(row.group_id, values);
  }
  const checkInGroupMemberMap = new Map<string, string[]>();
  for (const row of [...input.checkInCounterGroupMemberRows].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))) {
    if (!row.counter_id) continue;
    checkInGroupMemberMap.set(row.group_id, [...(checkInGroupMemberMap.get(row.group_id) ?? []), row.counter_id]);
  }
  const checkInLockMemberMap = new Map<string, string[]>();
  for (const row of [...input.checkInCounterLockMemberRows].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))) {
    if (!row.counter_id) continue;
    checkInLockMemberMap.set(row.lock_id, [...(checkInLockMemberMap.get(row.lock_id) ?? []), row.counter_id]);
  }
  const gateGroupMemberMap = new Map<string, string[]>();
  for (const row of [...input.gateGroupMemberRows].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))) {
    if (!row.gate_id) continue;
    gateGroupMemberMap.set(row.group_id, [...(gateGroupMemberMap.get(row.group_id) ?? []), row.gate_id]);
  }
  const gateLockMemberMap = new Map<string, string[]>();
  for (const row of [...input.gateLockMemberRows].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))) {
    if (!row.gate_id) continue;
    gateLockMemberMap.set(row.lock_id, [...(gateLockMemberMap.get(row.lock_id) ?? []), row.gate_id]);
  }
  return fromOperationalSettingsRows({
    settingsRow: input.settingsRow,
    routeCountries: input.routeCountryRows.map((row) => ({ route: row.route ?? '', country: row.country ?? '' })),
    airlineColors: input.airlineColorRows.map((row) => ({ airlineCode: row.airline_code ?? '', color: row.color ?? '' })),
    aircraftGroups: input.aircraftGroupRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      aircraftTypes: groupTypeMap.get(row.id) ?? [],
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    counterAllocationRules: input.counterRuleRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      enabled: row.enabled ?? true,
      priorityScore: row.priority_score ?? 0,
      sortOrder: row.sort_order ?? 0,
      conditions: {
        aircraftTypes: row.condition_aircraft_types ?? [],
        aircraftGroups: row.condition_aircraft_groups ?? [],
        airlineCodes: row.condition_airline_codes ?? [],
      },
      counterValue: row.counter_value ?? 0,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    checkInCounters: input.checkInCounterRows.map((row) => ({
      id: row.id,
      label: row.label ?? '',
      enabled: row.enabled ?? true,
      sortOrder: row.sort_order ?? 0,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    checkInCounterGroups: input.checkInCounterGroupRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      bhs: row.bhs ?? '',
      counterIds: checkInGroupMemberMap.get(row.id) ?? [],
      sortOrder: row.sort_order ?? 0,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    checkInCounterLocks: input.checkInCounterLockRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      counterIds: checkInLockMemberMap.get(row.id) ?? [],
      start: row.start_time ?? '',
      end: row.end_time ?? '',
      reason: row.reason,
      enabled: row.enabled ?? true,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    gateResources: input.gateResourceRows.map((row) => ({
      id: row.id,
      label: row.label ?? '',
      enabled: row.enabled ?? true,
      sortOrder: row.sort_order ?? 0,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    gateGroups: input.gateGroupRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      gateIds: gateGroupMemberMap.get(row.id) ?? [],
      sortOrder: row.sort_order ?? 0,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    gateLocks: input.gateLockRows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      gateIds: gateLockMemberMap.get(row.id) ?? [],
      start: row.start_time ?? '',
      end: row.end_time ?? '',
      reason: row.reason,
      enabled: row.enabled ?? true,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    standGateMappings: input.standGateMappingRows.map((row) => ({
      id: row.id,
      stand: numberOrNull(row.stand) ?? 0,
      gate: numberOrNull(row.gate) ?? 0,
      sortOrder: row.sort_order ?? 0,
      enabled: row.enabled ?? true,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    })),
    aiModels: input.aiModelRows
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((row) => ({
        id: row.id,
        label: row.label ?? row.id,
        provider: row.provider === 'openai-compatible' || row.provider === 'deepseek' ? row.provider : 'gemini',
        model: row.model ?? '',
        baseUrl: textOrNull(row.base_url),
        enabled: row.enabled ?? true,
        keyUpdatedAt: row.key_updated_at,
      })),
    aiContextDocuments: input.aiContextDocumentRows
      .sort((a, b) =>
        String(a.kind ?? '').localeCompare(String(b.kind ?? '')) ||
        Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
      )
      .map((row) => ({
        id: row.id,
        kind: row.kind === 'skill' ? 'skill' : 'rule',
        title: row.title ?? row.id,
        contentMd: row.content_md ?? '',
        enabled: row.enabled ?? true,
        sortOrder: row.sort_order ?? 0,
        createdAt: row.created_at ?? 0,
        updatedAt: row.updated_at ?? 0,
      })),
  });
}
