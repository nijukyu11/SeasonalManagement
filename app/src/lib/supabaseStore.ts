import { getSupabaseClient, invokeSupabaseFunction } from './supabase';
import type {
  RemoteStore,
  RemoteSyncWorkspaceInput,
  RemoteSyncWorkspaceResult,
  RemoteSyncWorkspaceV2Input,
  RemoteSyncWorkspaceV2Result,
  RemoteScheduleNotificationFlushInput,
  RemoteScheduleNotificationFlushResult,
  RemoteActor,
  RemoteDashboardSeasonData,
  RemoteSeasonEventPage,
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
  RemoteSeasonalImportResumeInput,
  RemoteSeasonalExportSnapshot,
  RemoteSeasonalExportSnapshotInput,
  RemoteSeasonSyncCursorState,
  RemoteRequestOptions,
  RemoteSeasonWorkspaceWindowInput,
  RemoteSeasonWorkspaceWindowResult,
  RemoteSeasonWorkspaceSnapshot,
  ServerSeasonMutationPayload,
  ServerSeasonMutationResult,
} from './remoteStore';
import { seasonEventTargetKey, type SeasonChangeEvent, type SeasonChangeEventPayload, type SeasonChangeTargetType } from './seasonChangeEvents';
import type { Season, ParsedRow, FlightModification, ModHistoryEntry, FlightRecord, OperationalSettings } from './types';
import type { AuditDeltaChunk, AuditLogEntry, AuditSession } from './auditLog';
import { validateOperationalSettings } from './settingsRules';
import { serializeFlightModificationForPersistence } from './persistenceSchema';
import {
  canonicalizeSeasonalImportSourceRows,
  normalizeSeasonalImportV2Mode,
  normalizeSeasonalImportExpectedDataVersion,
  parseSeasonalImportV2Result,
  runSeasonalImportV2RpcFlow,
  SeasonalImportV2RpcRejectedError,
} from './seasonalImportRpcContract';
import {
  parseSeasonalImportV3CancelResult,
  parseSeasonalImportV3CommittedResult,
  parseSeasonalImportV3StageResult,
  parseSeasonalImportV3StatusResult,
  type SeasonalImportV3Attempt,
  type SeasonalImportV3CommittedResult,
  type SeasonalImportV3StageResult,
} from './seasonalImportV3Contract';
import {
  DailyImportV1RpcRejectedError,
  parseDailyImportCommittedResultV1,
  parseDailyImportStageResultV1,
  type DailyImportCommittedResultV1,
  type DailyImportStagePayloadV1,
  type DailyImportStageResultV1,
} from './dailyImportRpcContract';
import {
  fromFlightRecordRows,
  fromModHistoryRows,
  fromModificationRows,
  fromSeasonRow,
  fromSettingsTableRows,
  toAiContextDocumentRows,
  hydrateSourceRowsFromRelationalPages,
  toAiModelRows,
  toAircraftGroupRows,
  toAircraftGroupTypeRows,
  toAirlineColorRows,
  toCheckInCounterGroupMemberRows,
  toCheckInCounterGroupRows,
  toCheckInCounterLockMemberRows,
  toCheckInCounterLockRows,
  toCheckInCounterRows,
  toCounterRuleRows,
  toGateGroupMemberRows,
  toGateGroupRows,
  toGateLockMemberRows,
  toGateLockRows,
  toGateResourceRows,
  toModHistoryRows,
  toOperationalSettingsRow,
  toRouteCountryRows,
  toSeasonRow,
  toStandGateMappingRows,
  type FlightRecordCounterRelationalRow,
  type FlightRecordRelationalRow,
  type FlightRecordWindowRelationalRow,
  type ModHistoryChangeRelationalRow,
  type ModHistoryEntryRelationalRow,
  type ModHistoryRecordChangeRelationalRow,
  type ModificationAddedLegRelationalRow,
  type ModificationCounterRelationalRow,
  type ModificationRelationalRow,
  type ModificationWindowRelationalRow,
  type OperationalSettingsRow,
  type SeasonRelationalRow,
  type SourceRowDayRelationalRow,
  type SourceRowRelationalRow,
} from './supabaseRelationalMappers';
import { FIRESTORE_WRITE_BATCH_SIZE, chunkFirestoreWrites, pauseBetweenFirestoreWriteBatches } from './firestoreWritePlanner';
import { splitModHistoryEntriesForFirestore } from './modHistorySizing';
import { splitAuditDeltaChunks } from './auditLog';
import type { LocalEntityVersionMap } from './localSeasonStore';
import { materializeSeasonalExportSnapshot } from './seasonalExportSnapshot';
import type { OperatorSessionCheckpointOptions } from './operatorSessionCacheRegistry';
import { isStatementTimeoutError, shouldUseLegacyWorkspaceWindowRpc } from './supabaseErrorPolicy';
import { loadWorkspaceWindowV2 } from './seasonWorkspaceWindowV2Assembler';

type SupabaseError = { message: string; code?: string | null; details?: string | null; hint?: string | null };
type SupabaseResult<T> = { data: T | null; error: SupabaseError | null };
type JsonRecord = Record<string, unknown>;
type PayloadRow<T> = { payload: T | null };
const SUPABASE_SELECT_PAGE_SIZE = 1000;
const SUPABASE_IN_FILTER_BATCH_SIZE = 100;
const SYNC_V2_EVENT_CHUNK_SIZE = 50;
const OPERATIONAL_SETTINGS_BASE_COLUMNS = [
  'id',
  'updated_at',
  'ai_enabled',
  'ai_active_model_id',
  'ai_updated_at',
] as const;
const OPERATIONAL_SETTINGS_DASHBOARD_ALERT_COLUMNS = [
  'dashboard_arrival_bucket_flights',
  'dashboard_departure_bucket_flights',
  'dashboard_ad_gap_flights',
  'dashboard_ctg_abs_pct',
  'dashboard_pax_coverage_min_pct',
] as const;
const OPERATIONAL_SETTINGS_BASE_SELECT = OPERATIONAL_SETTINGS_BASE_COLUMNS.join(',');
const OPERATIONAL_SETTINGS_SELECT = [
  ...OPERATIONAL_SETTINGS_BASE_COLUMNS,
  ...OPERATIONAL_SETTINGS_DASHBOARD_ALERT_COLUMNS,
].join(',');
type SeasonChangeEventRow = {
  event_id: string;
  season_id: string;
  client_id: string;
  op_id: string | null;
  actor_user_id: string | null;
  server_seq: number | null;
  target_type: SeasonChangeTargetType;
  target_id: string;
  changed_fields: string[] | null;
  op_payload: SeasonChangeEventPayload | null;
  created_at: string | null;
};
type SeasonEntityVersionRow = {
  target_type: SeasonChangeTargetType;
  target_id: string;
  field_versions: Record<string, number | string | null> | null;
};
type SeasonWorkspaceSnapshotRpc = {
  season?: SeasonRelationalRow | null;
  sourceRows?: SourceRowRelationalRow[];
  sourceRowDays?: SourceRowDayRelationalRow[];
  flightRecords?: FlightRecordRelationalRow[];
  flightRecordCounters?: FlightRecordCounterRelationalRow[];
  flightRecordWindows?: FlightRecordWindowRelationalRow[];
  modifications?: ModificationRelationalRow[];
  modificationCounters?: ModificationCounterRelationalRow[];
  modificationWindows?: ModificationWindowRelationalRow[];
  modificationAddedLegs?: ModificationAddedLegRelationalRow[];
  modHistoryEntries?: ModHistoryEntryRelationalRow[];
  modHistoryChanges?: ModHistoryChangeRelationalRow[];
  modHistoryRecordChanges?: ModHistoryRecordChangeRelationalRow[];
  cursor?: { serverHighWater?: number | string | null; server_high_water?: number | string | null };
  entityVersions?: SeasonEntityVersionRow[];
};
type SeasonEventPageRpc = {
  events?: Array<SeasonChangeEvent | SeasonChangeEventRow>;
  nextCursor?: number | string | null;
  next_cursor?: number | string | null;
  hasMore?: boolean | null;
  has_more?: boolean | null;
  serverHighWater?: number | string | null;
  server_high_water?: number | string | null;
};
type ServerSeasonMutationRpc = {
  seasonId?: string | null;
  season_id?: string | null;
  serverHighWater?: number | string | null;
  server_high_water?: number | string | null;
  nextServerSeq?: number | string | null;
  next_server_seq?: number | string | null;
  changedTargets?: string[] | null;
  changed_targets?: string[] | null;
  affectedIds?: string[] | null;
  affected_ids?: string[] | null;
  appliedEvents?: unknown[] | null;
  applied_events?: unknown[] | null;
  rejectedEvents?: unknown[] | null;
  rejected_events?: unknown[] | null;
};
type SeasonWorkspaceWindowRpc = Omit<SeasonWorkspaceSnapshotRpc, 'season' | 'modHistoryEntries' | 'modHistoryChanges' | 'modHistoryRecordChanges' | 'sourceRows' | 'sourceRowDays'> & {
  seasonId?: string | null;
  season_id?: string | null;
  cursor?: { serverHighWater?: number | string | null; server_high_water?: number | string | null };
};

function client() {
  return getSupabaseClient();
}

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

function assertOk<T>(result: SupabaseResult<T>, action: string): T {
  if (result.error) throw new Error(`${action}: ${result.error.message}`);
  return result.data as T;
}

function assertDailyImportRpcOk<T>(result: SupabaseResult<T>, action: string): T {
  if (!result.error) return result.data as T;
  const message = `${action}: ${result.error.message}`;
  if (typeof result.error.code === 'string' && result.error.code.trim()) {
    throw new DailyImportV1RpcRejectedError(message, result.error);
  }
  throw new Error(message);
}

function assertSeasonalImportRpcOk<T>(result: SupabaseResult<T>, action: string): T {
  if (!result.error) return result.data as T;
  const message = `${action}: ${result.error.message}`;
  if (typeof result.error.code === 'string' && result.error.code.trim()) {
    throw new SeasonalImportV2RpcRejectedError(message, result.error);
  }
  throw new Error(message);
}

function assertSeasonalImportV3RpcOk<T>(result: SupabaseResult<T>, action: string): T {
  if (!result.error) return result.data as T;
  const code = typeof result.error.code === 'string' && result.error.code.trim()
    ? ` [${result.error.code.trim()}]`
    : '';
  throw new Error(`${action}${code}: ${result.error.message}`);
}

function isMissingDashboardAlertColumnError(error: unknown): boolean {
  if (!error) return false;
  const details = typeof error === 'object'
    ? [
        (error as { code?: unknown }).code,
        (error as { message?: unknown }).message,
        (error as { details?: unknown }).details,
        (error as { hint?: unknown }).hint,
      ].filter(Boolean).join(' ')
    : String(error);
  return (
    /PGRST204|42703|column .* does not exist/i.test(details) &&
    OPERATIONAL_SETTINGS_DASHBOARD_ALERT_COLUMNS.some((column) => details.includes(column))
  );
}

function randomId(prefix: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function groupRowsByKey<T>(rows: T[], getKey: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return grouped;
}

type SelectFilter =
  | { type: 'eq'; column: string; value: string | number | boolean | null }
  | { type: 'gte'; column: string; value: string | number }
  | { type: 'lte'; column: string; value: string | number }
  | { type: 'in'; column: string; values: Array<string | number> }
  | { type: 'order'; column: string; ascending?: boolean };

type FilterableQuery = {
  eq(column: string, value: unknown): FilterableQuery;
  gte(column: string, value: unknown): FilterableQuery;
  lte(column: string, value: unknown): FilterableQuery;
  in(column: string, values: readonly unknown[]): FilterableQuery;
  order(column: string, options?: { ascending?: boolean }): FilterableQuery;
};

type SelectAllQuery<T> = FilterableQuery & {
  abortSignal(signal: AbortSignal): SelectAllQuery<T>;
  range(from: number, to: number): Promise<SupabaseResult<T[]>>;
};

interface SelectAllRowsOptions {
  signal?: AbortSignal;
  limit?: number;
}

function applySelectFilters<TQuery extends FilterableQuery>(query: TQuery, filters: SelectFilter[]): TQuery {
  let next: FilterableQuery = query;
  for (const filter of filters) {
    if (filter.type === 'eq') next = next.eq(filter.column, filter.value);
    if (filter.type === 'gte') next = next.gte(filter.column, filter.value);
    if (filter.type === 'lte') next = next.lte(filter.column, filter.value);
    if (filter.type === 'in') next = next.in(filter.column, filter.values);
    if (filter.type === 'order') next = next.order(filter.column, { ascending: filter.ascending ?? true });
  }
  return next as TQuery;
}

async function selectAllRows<T>(
  table: string,
  filters: SelectFilter[] = [],
  action = `load ${table}`,
  options: SelectAllRowsOptions = {}
): Promise<T[]> {
  const rows: T[] = [];
  const requestedLimit = options.limit === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Math.floor(options.limit));
  for (let from = 0; rows.length < requestedLimit; from += SUPABASE_SELECT_PAGE_SIZE) {
    const remaining = requestedLimit - rows.length;
    const pageLimit = Math.min(SUPABASE_SELECT_PAGE_SIZE, remaining);
    const to = from + pageLimit - 1;
    let query = applySelectFilters(
      client().from(table).select('*') as unknown as SelectAllQuery<T>,
      filters
    );
    if (options.signal) query = query.abortSignal(options.signal);
    const page = assertOk(await query.range(from, to), action) as T[];
    rows.push(...page);
    if (rows.length >= requestedLimit || page.length < pageLimit) break;
  }
  return rows;
}

async function readRowsByInFilter<T>(
  table: string,
  column: string,
  values: string[],
  action: string,
  options: RemoteRequestOptions = {}
): Promise<T[]> {
  const uniqueValues = uniqueStrings(values);
  if (uniqueValues.length === 0) return [];
  const rows: T[] = [];
  for (let i = 0; i < uniqueValues.length; i += SUPABASE_IN_FILTER_BATCH_SIZE) {
    const chunk = uniqueValues.slice(i, i + SUPABASE_IN_FILTER_BATCH_SIZE);
    const page = await selectAllRows<T>(
      table,
      [{ type: 'in', column, values: chunk }],
      action,
      { signal: options.signal }
    );
    rows.push(...page);
  }
  return rows;
}

function toSeasonChangeEvent(row: SeasonChangeEventRow): SeasonChangeEvent {
  return {
    eventId: row.event_id,
    seasonId: row.season_id,
    clientId: row.client_id,
    opId: row.op_id ?? row.event_id,
    actorUserId: row.actor_user_id,
    serverSeq: row.server_seq,
    targetType: row.target_type,
    targetId: row.target_id,
    changedFields: row.changed_fields ?? [],
    opPayload: row.op_payload ?? { type: 'flightRecord', baseFieldVersions: {} },
    createdAt: row.created_at ?? new Date().toISOString(),
  };
}

function normalizeRpcSeasonEvent(value: SeasonChangeEvent | SeasonChangeEventRow): SeasonChangeEvent {
  const maybeRow = value as Partial<SeasonChangeEventRow>;
  if (maybeRow.event_id) return toSeasonChangeEvent(maybeRow as SeasonChangeEventRow);
  return value as SeasonChangeEvent;
}

function toEntityVersionMap(rows: SeasonEntityVersionRow[]): LocalEntityVersionMap {
  const versions: LocalEntityVersionMap = {};
  for (const row of rows) {
    const targetVersions: Record<string, number> = {};
    for (const [field, value] of Object.entries(row.field_versions ?? {})) {
      const numericValue = Number(value ?? 0);
      if (Number.isFinite(numericValue)) targetVersions[field] = numericValue;
    }
    versions[seasonEventTargetKey(row.target_type, row.target_id)] = targetVersions;
  }
  return versions;
}

function numberFromRpc(value: number | string | null | undefined, fallback = 0): number {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeServerSeasonMutationResult(result: ServerSeasonMutationRpc | null): ServerSeasonMutationResult {
  const seasonId = result?.seasonId ?? result?.season_id;
  if (!seasonId) throw new Error('apply season server mutation: response did not include seasonId');
  const serverHighWater = numberFromRpc(result?.serverHighWater ?? result?.server_high_water);
  return {
    seasonId,
    serverHighWater,
    nextServerSeq: numberFromRpc(result?.nextServerSeq ?? result?.next_server_seq, serverHighWater),
    changedTargets: result?.changedTargets ?? result?.changed_targets ?? [],
    affectedIds: result?.affectedIds ?? result?.affected_ids ?? [],
    appliedEvents: (result?.appliedEvents ?? result?.applied_events ?? []).map((event) => (
      normalizeRpcSeasonEvent(event as SeasonChangeEvent | SeasonChangeEventRow)
    )),
    rejectedEvents: result?.rejectedEvents ?? result?.rejected_events ?? [],
  };
}

function snapshotArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function mapWorkspaceSnapshot(snapshot: SeasonWorkspaceSnapshotRpc): RemoteSeasonWorkspaceSnapshot | null {
  if (!snapshot.season) return null;
  const flightRecordRows = snapshotArray(snapshot.flightRecords);
  const countersByRecord = groupRowsByKey(snapshotArray(snapshot.flightRecordCounters), (row) => row.record_id);
  const windowsByRecord = groupRowsByKey(snapshotArray(snapshot.flightRecordWindows), (row) => row.record_id);
  const records = flightRecordRows
    .map((row) => fromFlightRecordRows(
      row,
      countersByRecord.get(row.record_id) ?? [],
      windowsByRecord.get(row.record_id) ?? []
    ))
    .sort((a, b) => a.date.localeCompare(b.date) || a.flightNumber.localeCompare(b.flightNumber) || a.id.localeCompare(b.id));

  const countersByLeg = groupRowsByKey(snapshotArray(snapshot.modificationCounters), (row) => row.leg_id);
  const windowsByLeg = groupRowsByKey(snapshotArray(snapshot.modificationWindows), (row) => row.leg_id);
  const addedLegsByLeg = new Map(snapshotArray(snapshot.modificationAddedLegs).map((row) => [row.leg_id, row]));
  for (const row of flightRecordRows) {
    if (row.source_kind !== 'manual' || row.action !== 'added') continue;
    addedLegsByLeg.set(row.record_id, { ...row, leg_id: row.record_id });
  }
  const modifications = new Map(snapshotArray(snapshot.modifications).map((row) => [row.leg_id, fromModificationRows(
    row,
    countersByLeg.get(row.leg_id) ?? [],
    windowsByLeg.get(row.leg_id) ?? [],
    addedLegsByLeg.get(row.leg_id)
  )]));

  const historyChangesByEntry = groupRowsByKey(snapshotArray(snapshot.modHistoryChanges), (row) => row.entry_id);
  const historyRecordChangesByEntry = groupRowsByKey(snapshotArray(snapshot.modHistoryRecordChanges), (row) => row.entry_id);
  const modHistory = snapshotArray(snapshot.modHistoryEntries).map((row) => fromModHistoryRows(
    row,
    historyChangesByEntry.get(row.entry_id) ?? [],
    historyRecordChangesByEntry.get(row.entry_id) ?? []
  ));
  const serverHighWater = numberFromRpc(snapshot.cursor?.serverHighWater ?? snapshot.cursor?.server_high_water);

  return {
    season: fromSeasonRow(snapshot.season),
    sourceRows: [],
    records,
    modifications,
    modHistory,
    cursor: { serverHighWater },
    entityVersions: toEntityVersionMap(snapshotArray(snapshot.entityVersions)),
  };
}

function toServerWorkspaceWindowSyncMeta(
  seasonId: string,
  serverHighWater: number
): RemoteSeasonWorkspaceWindowResult['syncMeta'] {
  return {
    seasonId,
    baseServerVersion: serverHighWater,
    lastServerSeq: serverHighWater,
    localRevision: serverHighWater,
    pendingCount: 0,
    lastLocalChangeAt: null,
    conflicts: [],
    syncStatus: 'synced',
  };
}

function mapWorkspaceWindow(
  input: RemoteSeasonWorkspaceWindowInput,
  payload: SeasonWorkspaceWindowRpc,
  dataVersion = 0,
): RemoteSeasonWorkspaceWindowResult {
  const snapshot = mapWorkspaceSnapshot({
    ...payload,
    season: {
      id: input.seasonId,
      season_code: '',
      name: '',
      file_name: '',
      uploaded_at: 0,
      effective_start: '',
      effective_end: '',
      total_legs: 0,
      total_source_rows: 0,
      data_version: 0,
      last_synced_at: null,
    },
    sourceRows: [],
    sourceRowDays: [],
    modHistoryEntries: [],
    modHistoryChanges: [],
    modHistoryRecordChanges: [],
  });
  const serverHighWater = numberFromRpc(payload.cursor?.serverHighWater ?? payload.cursor?.server_high_water);
  return {
    sourceRows: [],
    records: snapshot?.records ?? [],
    modifications: snapshot?.modifications ?? new Map(),
    cursor: { dataVersion, serverHighWater },
    syncMeta: toServerWorkspaceWindowSyncMeta(input.seasonId, serverHighWater),
  };
}

async function loadSeasonWorkspaceSnapshotPaged(
  seasonId: string,
  options: { modHistoryLimit?: number } = {}
): Promise<RemoteSeasonWorkspaceSnapshot | null> {
  const [season, flightData, modHistory, cursorState] = await Promise.all([
    readSeasonRelational(seasonId),
    readFlightRecordsForDashboardSeason(seasonId),
    supabaseStore.getModHistory(seasonId, options.modHistoryLimit ?? 50),
    supabaseStore.getSeasonSyncCursorState
      ? supabaseStore.getSeasonSyncCursorState(seasonId)
      : Promise.resolve({ serverHighWater: 0, entityVersions: {} }),
  ]);
  if (!season) return null;
  const modifications = await readModificationsForDashboardSeason(
    seasonId,
    flightData.rows
  );
  return {
    season,
    sourceRows: [],
    records: flightData.records,
    modifications,
    modHistory,
    cursor: { serverHighWater: cursorState.serverHighWater },
    entityVersions: cursorState.entityVersions,
  };
}

async function upsertRows(
  table: string,
  rows: JsonRecord[],
  onConflict: string,
  onProgress?: (written: number, total: number) => void,
  options?: OperatorSessionCheckpointOptions,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += FIRESTORE_WRITE_BATCH_SIZE) {
    const chunk = rows.slice(i, i + FIRESTORE_WRITE_BATCH_SIZE);
    options?.assertOperatorSessionCurrent();
    assertOk(await client().from(table).upsert(chunk, { onConflict }), `upsert ${table}`);
    onProgress?.(Math.min(i + FIRESTORE_WRITE_BATCH_SIZE, rows.length), rows.length);
    await pauseBetweenFirestoreWriteBatches();
  }
}

async function readSeasonRelational(id: string): Promise<Season | null> {
  const row = assertOk(
    await client().from('seasons').select('*').eq('id', id).maybeSingle(),
    'load season'
  ) as SeasonRelationalRow | null;
  return row ? fromSeasonRow(row) : null;
}

async function readFlightRecordRowsForDashboardSeason(seasonId: string): Promise<{
  season: Season | null;
  rows: FlightRecordRelationalRow[];
}> {
  const season = await readSeasonRelational(seasonId);
  const rowsById = new Map<string, FlightRecordRelationalRow>();
  const seasonRows = await selectAllRows<FlightRecordRelationalRow>('season_flight_records', [
    { type: 'eq', column: 'season_id', value: seasonId },
  ], 'load season flight record rows');
  for (const row of seasonRows) rowsById.set(row.record_id, row);

  return { season, rows: Array.from(rowsById.values()) };
}

async function hydrateFlightRecordRows(
  rows: FlightRecordRelationalRow[],
  options: RemoteRequestOptions = {}
): Promise<FlightRecord[]> {
  const recordIds = uniqueStrings(rows.map((row) => row.record_id));
  const [counterRows, windowRows] = await Promise.all([
    readFlightRecordCounters(recordIds, options),
    readFlightRecordWindows(recordIds, options),
  ]);
  const countersByRecord = groupRowsByKey(counterRows, (row) => row.record_id);
  const windowsByRecord = groupRowsByKey(windowRows, (row) => row.record_id);
  return rows
    .map((row) => fromFlightRecordRows(
      row,
      countersByRecord.get(row.record_id) ?? [],
      windowsByRecord.get(row.record_id) ?? []
    ))
    .sort((a, b) => a.date.localeCompare(b.date) || a.flightNumber.localeCompare(b.flightNumber) || a.id.localeCompare(b.id));
}

async function readFlightRecordsForDashboardSeason(seasonId: string): Promise<{
  season: Season | null;
  rows: FlightRecordRelationalRow[];
  records: FlightRecord[];
}> {
  const data = await readFlightRecordRowsForDashboardSeason(seasonId);
  const records = await hydrateFlightRecordRows(data.rows);
  return { ...data, records };
}

function toOperationalSettingsBaseRow(settings: OperationalSettings): Pick<OperationalSettingsRow, 'id' | 'updated_at' | 'ai_enabled' | 'ai_active_model_id' | 'ai_updated_at'> {
  const row = toOperationalSettingsRow(settings);
  return {
    id: row.id,
    updated_at: row.updated_at,
    ai_enabled: row.ai_enabled,
    ai_active_model_id: row.ai_active_model_id,
    ai_updated_at: row.ai_updated_at,
  };
}

async function readOperationalSettingsRowWithDashboardAlertFallback(): Promise<SupabaseResult<OperationalSettingsRow>> {
  const fullResult = await client()
    .from('operational_settings')
    .select(OPERATIONAL_SETTINGS_SELECT)
    .eq('id', 'operational')
    .maybeSingle();
  if (!isMissingDashboardAlertColumnError(fullResult.error)) {
    return fullResult as unknown as SupabaseResult<OperationalSettingsRow>;
  }
  return await client()
    .from('operational_settings')
    .select(OPERATIONAL_SETTINGS_BASE_SELECT)
    .eq('id', 'operational')
    .maybeSingle() as unknown as SupabaseResult<OperationalSettingsRow>;
}

async function upsertOperationalSettingsRowWithDashboardAlertFallback(
  settings: OperationalSettings,
  options?: OperatorSessionCheckpointOptions,
): Promise<void> {
  const normalized = validateOperationalSettings(settings);
  options?.assertOperatorSessionCurrent();
  const fullResult = await client()
    .from('operational_settings')
    .upsert(toOperationalSettingsRow(normalized), { onConflict: 'id' });
  if (!isMissingDashboardAlertColumnError(fullResult.error)) {
    assertOk(fullResult, 'save operational settings');
    return;
  }
  options?.assertOperatorSessionCurrent();
  assertOk(
    await client()
      .from('operational_settings')
      .upsert(toOperationalSettingsBaseRow(normalized), { onConflict: 'id' }),
    'save operational settings'
  );
}

async function readOperationalSettingsRelational(): Promise<OperationalSettings> {
  const [
    settingsRow,
    routeCountryRows,
    airlineColorRows,
    aircraftGroupRows,
    aircraftGroupTypeRows,
    counterRuleRows,
    checkInCounterRows,
    checkInCounterGroupRows,
    checkInCounterGroupMemberRows,
    checkInCounterLockRows,
    checkInCounterLockMemberRows,
    gateResourceRows,
    gateGroupRows,
    gateGroupMemberRows,
    gateLockRows,
    gateLockMemberRows,
    standGateMappingRows,
    aiModelRows,
    aiContextDocumentRows,
  ] = await Promise.all([
    readOperationalSettingsRowWithDashboardAlertFallback(),
    client().from('operational_route_countries').select('*').order('route', { ascending: true }),
    client().from('operational_airline_colors').select('*').order('airline_code', { ascending: true }),
    client().from('operational_aircraft_groups').select('*').order('name', { ascending: true }),
    client().from('operational_aircraft_group_types').select('*').order('aircraft_type', { ascending: true }),
    client().from('operational_counter_rules').select('*').order('sort_order', { ascending: true }),
    client().from('operational_checkin_counters').select('*').order('sort_order', { ascending: true }),
    client().from('operational_checkin_counter_groups').select('*').order('sort_order', { ascending: true }),
    client().from('operational_checkin_counter_group_members').select('*').order('sort_order', { ascending: true }),
    client().from('operational_checkin_counter_locks').select('*').order('start_time', { ascending: true }),
    client().from('operational_checkin_counter_lock_members').select('*').order('sort_order', { ascending: true }),
    client().from('operational_gate_resources').select('*').order('sort_order', { ascending: true }),
    client().from('operational_gate_groups').select('*').order('sort_order', { ascending: true }),
    client().from('operational_gate_group_members').select('*').order('sort_order', { ascending: true }),
    client().from('operational_gate_locks').select('*').order('start_time', { ascending: true }),
    client().from('operational_gate_lock_members').select('*').order('sort_order', { ascending: true }),
    client().from('operational_stand_gate_mappings').select('*').order('sort_order', { ascending: true }),
    client().from('operational_ai_models').select('*').order('sort_order', { ascending: true }),
    client().from('operational_ai_context_documents').select('*').order('sort_order', { ascending: true }),
  ]);
  return fromSettingsTableRows({
    settingsRow: assertOk(settingsRow as unknown as SupabaseResult<OperationalSettingsRow>, 'load operational settings') as OperationalSettingsRow | null,
    routeCountryRows: assertOk(routeCountryRows, 'load route countries') as Parameters<typeof fromSettingsTableRows>[0]['routeCountryRows'],
    airlineColorRows: assertOk(airlineColorRows, 'load airline colors') as Parameters<typeof fromSettingsTableRows>[0]['airlineColorRows'],
    aircraftGroupRows: assertOk(aircraftGroupRows, 'load aircraft groups') as Parameters<typeof fromSettingsTableRows>[0]['aircraftGroupRows'],
    aircraftGroupTypeRows: assertOk(aircraftGroupTypeRows, 'load aircraft group types') as Parameters<typeof fromSettingsTableRows>[0]['aircraftGroupTypeRows'],
    counterRuleRows: assertOk(counterRuleRows, 'load counter rules') as Parameters<typeof fromSettingsTableRows>[0]['counterRuleRows'],
    checkInCounterRows: assertOk(checkInCounterRows, 'load check-in counters') as Parameters<typeof fromSettingsTableRows>[0]['checkInCounterRows'],
    checkInCounterGroupRows: assertOk(checkInCounterGroupRows, 'load check-in counter groups') as Parameters<typeof fromSettingsTableRows>[0]['checkInCounterGroupRows'],
    checkInCounterGroupMemberRows: assertOk(checkInCounterGroupMemberRows, 'load check-in counter group members') as Parameters<typeof fromSettingsTableRows>[0]['checkInCounterGroupMemberRows'],
    checkInCounterLockRows: assertOk(checkInCounterLockRows, 'load check-in counter locks') as Parameters<typeof fromSettingsTableRows>[0]['checkInCounterLockRows'],
    checkInCounterLockMemberRows: assertOk(checkInCounterLockMemberRows, 'load check-in counter lock members') as Parameters<typeof fromSettingsTableRows>[0]['checkInCounterLockMemberRows'],
    gateResourceRows: assertOk(gateResourceRows, 'load gate resources') as Parameters<typeof fromSettingsTableRows>[0]['gateResourceRows'],
    gateGroupRows: assertOk(gateGroupRows, 'load gate groups') as Parameters<typeof fromSettingsTableRows>[0]['gateGroupRows'],
    gateGroupMemberRows: assertOk(gateGroupMemberRows, 'load gate group members') as Parameters<typeof fromSettingsTableRows>[0]['gateGroupMemberRows'],
    gateLockRows: assertOk(gateLockRows, 'load gate locks') as Parameters<typeof fromSettingsTableRows>[0]['gateLockRows'],
    gateLockMemberRows: assertOk(gateLockMemberRows, 'load gate lock members') as Parameters<typeof fromSettingsTableRows>[0]['gateLockMemberRows'],
    standGateMappingRows: assertOk(standGateMappingRows, 'load stand gate mappings') as Parameters<typeof fromSettingsTableRows>[0]['standGateMappingRows'],
    aiModelRows: assertOk(aiModelRows, 'load AI models') as Parameters<typeof fromSettingsTableRows>[0]['aiModelRows'],
    aiContextDocumentRows: assertOk(aiContextDocumentRows, 'load AI context documents') as Parameters<typeof fromSettingsTableRows>[0]['aiContextDocumentRows'],
  });
}

async function clearTableRows(table: string, clearColumn = 'id', options?: OperatorSessionCheckpointOptions): Promise<void> {
  options?.assertOperatorSessionCurrent();
  assertOk(await client().from(table).delete().not(clearColumn, 'is', null), `clear ${table}`);
}

async function upsertTableRows(table: string, rows: JsonRecord[], onConflict: string, options?: OperatorSessionCheckpointOptions): Promise<void> {
  if (rows.length > 0) {
    options?.assertOperatorSessionCurrent();
    assertOk(await client().from(table).upsert(rows, { onConflict }), `save ${table}`);
  }
}

async function replaceTableRows(table: string, rows: JsonRecord[], onConflict: string, clearColumn = 'id', options?: OperatorSessionCheckpointOptions): Promise<void> {
  await clearTableRows(table, clearColumn, options);
  await upsertTableRows(table, rows, onConflict, options);
}

async function writeOperationalSettingsRelational(settings: OperationalSettings, options?: OperatorSessionCheckpointOptions): Promise<void> {
  const normalized = validateOperationalSettings(settings);
  await upsertOperationalSettingsRowWithDashboardAlertFallback(normalized, options);
  await clearTableRows('operational_aircraft_group_types', 'group_id', options);
  await clearTableRows('operational_checkin_counter_group_members', 'group_id', options);
  await clearTableRows('operational_checkin_counter_lock_members', 'lock_id', options);
  await clearTableRows('operational_gate_group_members', 'group_id', options);
  await clearTableRows('operational_gate_lock_members', 'lock_id', options);

  await replaceTableRows('operational_route_countries', toRouteCountryRows(normalized), 'route', 'route', options);
  await replaceTableRows('operational_airline_colors', toAirlineColorRows(normalized), 'airline_code', 'airline_code', options);
  await replaceTableRows('operational_aircraft_groups', toAircraftGroupRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_counter_rules', toCounterRuleRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_checkin_counters', toCheckInCounterRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_checkin_counter_groups', toCheckInCounterGroupRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_checkin_counter_locks', toCheckInCounterLockRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_gate_resources', toGateResourceRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_gate_groups', toGateGroupRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_gate_locks', toGateLockRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_stand_gate_mappings', toStandGateMappingRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_ai_models', toAiModelRows(normalized), 'id', 'id', options);
  await replaceTableRows('operational_ai_context_documents', toAiContextDocumentRows(normalized), 'id', 'id', options);

  await upsertTableRows('operational_aircraft_group_types', toAircraftGroupTypeRows(normalized), 'group_id,aircraft_type', options);
  await upsertTableRows('operational_checkin_counter_group_members', toCheckInCounterGroupMemberRows(normalized), 'group_id,counter_id', options);
  await upsertTableRows('operational_checkin_counter_lock_members', toCheckInCounterLockMemberRows(normalized), 'lock_id,counter_id', options);
  await upsertTableRows('operational_gate_group_members', toGateGroupMemberRows(normalized), 'group_id,gate_id', options);
  await upsertTableRows('operational_gate_lock_members', toGateLockMemberRows(normalized), 'lock_id,gate_id', options);
}

async function readFlightRecordCounters(recordIds?: string[], options: RemoteRequestOptions = {}): Promise<FlightRecordCounterRelationalRow[]> {
  if (recordIds) {
    return readRowsByInFilter<FlightRecordCounterRelationalRow>(
      'season_flight_record_counters',
      'record_id',
      recordIds,
      'load flight record counters',
      options
    );
  }
  return selectAllRows<FlightRecordCounterRelationalRow>('season_flight_record_counters', [], 'load flight record counters');
}

async function readFlightRecordWindows(recordIds?: string[], options: RemoteRequestOptions = {}): Promise<FlightRecordWindowRelationalRow[]> {
  if (recordIds) {
    return readRowsByInFilter<FlightRecordWindowRelationalRow>(
      'season_flight_record_checkin_windows',
      'record_id',
      recordIds,
      'load flight record windows',
      options
    );
  }
  return selectAllRows<FlightRecordWindowRelationalRow>('season_flight_record_checkin_windows', [], 'load flight record windows');
}

async function readModificationChildren(seasonId: string, legIds?: string[], options: RemoteRequestOptions = {}): Promise<{
  counterRows: ModificationCounterRelationalRow[];
  windowRows: ModificationWindowRelationalRow[];
  addedLegRows: ModificationAddedLegRelationalRow[];
}> {
  if (legIds) {
    const uniqueLegIds = uniqueStrings(legIds);
    if (uniqueLegIds.length === 0) {
      return { counterRows: [], windowRows: [], addedLegRows: [] };
    }
    const [counterRows, windowRows, addedLegRows] = await Promise.all([
      readRowsByInFilter<ModificationCounterRelationalRow>('season_modification_counters', 'leg_id', uniqueLegIds, 'load modification counters', options),
      readRowsByInFilter<ModificationWindowRelationalRow>('season_modification_checkin_windows', 'leg_id', uniqueLegIds, 'load modification windows', options),
      readRowsByInFilter<ModificationAddedLegRelationalRow>('season_modification_added_legs', 'leg_id', uniqueLegIds, 'load modification added legs', options),
    ]);
    return { counterRows, windowRows, addedLegRows };
  }
  const [counterRows, windowRows, addedLegRows] = await Promise.all([
    selectAllRows<ModificationCounterRelationalRow>('season_modification_counters', [], 'load modification counters'),
    selectAllRows<ModificationWindowRelationalRow>('season_modification_checkin_windows', [], 'load modification windows'),
    selectAllRows<ModificationAddedLegRelationalRow>('season_modification_added_legs', [
      { type: 'eq', column: 'season_id', value: seasonId },
    ], 'load modification added legs'),
  ]);
  return {
    counterRows,
    windowRows,
    addedLegRows,
  };
}

async function readModificationRowsForDashboardSeason(
  seasonId: string,
  recordIds: string[],
  options: RemoteRequestOptions = {}
): Promise<ModificationRelationalRow[]> {
  const rowsByLegId = new Map<string, ModificationRelationalRow>();
  const seasonRows = await selectAllRows<ModificationRelationalRow>('season_modifications', [
    { type: 'eq', column: 'season_id', value: seasonId },
  ], 'load season modifications', { signal: options.signal });
  for (const row of seasonRows) rowsByLegId.set(row.leg_id, row);

  const recordScopedRows = await readRowsByInFilter<ModificationRelationalRow>(
    'season_modifications',
    'leg_id',
    recordIds,
    'load record-scoped modifications',
    options
  );
  for (const row of recordScopedRows) rowsByLegId.set(row.leg_id, row);

  return Array.from(rowsByLegId.values());
}

async function readModificationsForDashboardSeason(
  seasonId: string,
  recordRows: FlightRecordRelationalRow[],
  options: RemoteRequestOptions = {}
): Promise<Map<string, FlightModification>> {
  const recordIds = recordRows.map((row) => row.record_id);
  const rows = await readModificationRowsForDashboardSeason(seasonId, recordIds, options);
  const legIds = rows.map((row) => row.leg_id);
  const children = await readModificationChildren(seasonId, legIds, options);
  const countersByLeg = groupRowsByKey(children.counterRows, (row) => row.leg_id);
  const windowsByLeg = groupRowsByKey(children.windowRows, (row) => row.leg_id);
  const addedLegsByLeg = new Map(children.addedLegRows.map((row) => [row.leg_id, row]));
  for (const row of recordRows) {
    if (row.source_kind !== 'manual' || row.action !== 'added') continue;
    addedLegsByLeg.set(row.record_id, { ...row, leg_id: row.record_id });
  }
  return new Map(rows.map((row) => [row.leg_id, fromModificationRows(
    row,
    countersByLeg.get(row.leg_id) ?? [],
    windowsByLeg.get(row.leg_id) ?? [],
    addedLegsByLeg.get(row.leg_id)
  )]));
}

export const supabaseStore: RemoteStore = {
  async getSeasons(): Promise<Season[]> {
    const rows = await selectAllRows<SeasonRelationalRow>('seasons', [
      { type: 'order', column: 'uploaded_at', ascending: false },
    ], 'load seasons');
    return rows.map(fromSeasonRow);
  },

  async getSeason(id: string): Promise<Season | null> {
    return readSeasonRelational(id);
  },

  async findSeasonByCode(code: string): Promise<Season | null> {
    const result = await client().from('seasons').select('*').eq('season_code', code).maybeSingle();
    if (result.error) {
      const message = result.error.message ?? '';
      if (/multiple|Results contain/i.test(message)) {
        throw new Error(`find season: Duplicate season_code detected for ${code}. Resolve duplicate seasons before importing.`);
      }
      throw new Error(`find season: ${message}`);
    }
    const row = result.data as SeasonRelationalRow | null;
    return row ? fromSeasonRow(row) : null;
  },

  async createSeason(season: Omit<Season, 'id'>): Promise<string> {
    const id = randomId('season');
    const uploadedAt = Date.now();
    assertOk(
      await client().rpc('manage_season_metadata_v2', {
        p_action: 'create',
        p_season_id: id,
        p_payload: toSeasonRow({ ...season, uploadedAt }, id, uploadedAt),
      }),
      'create season'
    );
    return id;
  },

  async updateSeason(id: string, data: Partial<Season>): Promise<void> {
    const current = await supabaseStore.getSeason(id);
    if (!current) throw new Error(`Season ${id} not found`);
    const next = { ...current, ...data, id };
    assertOk(
      await client().rpc('manage_season_metadata_v2', {
        p_action: 'update',
        p_season_id: id,
        p_payload: toSeasonRow(next, id, next.uploadedAt),
      }),
      'update season'
    );
  },

  async deleteSeason(id: string): Promise<void> {
    assertOk(await client().rpc('manage_season_metadata_v2', {
      p_action: 'delete',
      p_season_id: id,
      p_payload: {},
    }), 'delete season');
  },

  async getOperationalSettings(): Promise<OperationalSettings> {
    return readOperationalSettingsRelational();
  },

  async saveOperationalSettings(settings: OperationalSettings, options?: OperatorSessionCheckpointOptions): Promise<void> {
    await writeOperationalSettingsRelational(settings, options);
  },

  async saveAuditLogEntry(session: AuditSession, entry: AuditLogEntry, options?: OperatorSessionCheckpointOptions): Promise<void> {
    const exactDeltas = entry.syncDelta?.exactChanges ?? entry.deltas;
    const deltaChunks = splitAuditDeltaChunks(exactDeltas);
    const entryPayload: AuditLogEntry = {
      ...entry,
      deltas: [],
      syncDelta: entry.syncDelta ? { ...entry.syncDelta, exactChanges: [] } : undefined,
      deltaChunkCount: deltaChunks.length,
    };

    options?.assertOperatorSessionCurrent();
    assertOk(
      await client().from('audit_sessions').upsert({
        id: session.id,
        started_at: session.startedAt,
        last_seen_at: session.lastSeenAt,
        payload: stripUndefinedDeep(session),
      }, { onConflict: 'id' }),
      'save audit session'
    );
    options?.assertOperatorSessionCurrent();
    assertOk(
      await client().from('audit_entries').upsert({
        session_id: session.id,
        id: entry.id,
        timestamp: entry.timestamp,
        payload: stripUndefinedDeep(entryPayload),
      }, { onConflict: 'session_id,id' }),
      'save audit entry'
    );
    await upsertRows(
      'audit_delta_chunks',
      deltaChunks.map((chunk) => ({
        session_id: session.id,
        entry_id: entry.id,
        id: chunk.id,
        chunk_index: chunk.chunkIndex,
        payload: stripUndefinedDeep(chunk),
      })),
      'session_id,entry_id,id',
      undefined,
      options
    );
  },

  async getAuditSessions(maxSessions = 50): Promise<AuditSession[]> {
    const rows = assertOk(
      await client().from('audit_sessions').select('payload').order('last_seen_at', { ascending: false }).limit(maxSessions),
      'load audit sessions'
    ) as Array<PayloadRow<AuditSession>>;
    return rows.map((row) => row.payload as AuditSession);
  },

  async getAuditLogEntries(sessionId: string, maxEntries = 200): Promise<AuditLogEntry[]> {
    const rows = assertOk(
      await client().from('audit_entries').select('payload').eq('session_id', sessionId).order('timestamp', { ascending: false }).limit(maxEntries),
      'load audit entries'
    ) as Array<PayloadRow<AuditLogEntry>>;
    return rows.map((row) => row.payload as AuditLogEntry);
  },

  async getAuditDeltaChunks(sessionId: string, entryId: string): Promise<AuditDeltaChunk[]> {
    const rows = assertOk(
      await client().from('audit_delta_chunks').select('payload').eq('session_id', sessionId).eq('entry_id', entryId).order('chunk_index', { ascending: true }),
      'load audit delta chunks'
    ) as Array<PayloadRow<AuditDeltaChunk>>;
    return rows.map((row) => row.payload as AuditDeltaChunk);
  },

  async getSourceRows(seasonId: string): Promise<ParsedRow[]> {
    const [rows, dayRows] = await Promise.all([
      selectAllRows<SourceRowRelationalRow>('season_source_rows', [
        { type: 'eq', column: 'season_id', value: seasonId },
        { type: 'order', column: 'row_index', ascending: true },
      ], 'load seasonal source provenance'),
      selectAllRows<SourceRowDayRelationalRow>('season_source_row_days', [
        { type: 'eq', column: 'season_id', value: seasonId },
        { type: 'order', column: 'row_index', ascending: true },
        { type: 'order', column: 'iso_dow', ascending: true },
      ], 'load seasonal source provenance days'),
    ]);
    return hydrateSourceRowsFromRelationalPages([rows], [dayRows]);
  },

  async stageSeasonalImportV3(
    input: SeasonalImportV3Attempt,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<SeasonalImportV3StageResult> {
    const attempt = {
      ...input,
      sourceRows: canonicalizeSeasonalImportSourceRows(input.sourceRows),
    };
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('stage_seasonal_import_v3', { p_import: attempt });
    options.assertOperatorSessionCurrent();
    return parseSeasonalImportV3StageResult(
      assertSeasonalImportV3RpcOk(response, 'stage seasonal import V3'),
    );
  },

  async commitSeasonalImportV3(
    input: { batchId: string; expectedDataVersion: number; previewHash: string },
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<SeasonalImportV3CommittedResult> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('commit_seasonal_import_v3', {
      p_batch_id: input.batchId,
      p_expected_data_version: input.expectedDataVersion,
      p_preview_hash: input.previewHash,
    });
    options.assertOperatorSessionCurrent();
    return parseSeasonalImportV3CommittedResult(
      assertSeasonalImportV3RpcOk(response, 'commit seasonal import V3'),
    );
  },

  async getSeasonalImportV3Status(
    requestId: string,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<SeasonalImportV3StageResult | SeasonalImportV3CommittedResult> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('get_seasonal_import_v3_status', {
      p_request_id: requestId,
    });
    options.assertOperatorSessionCurrent();
    return parseSeasonalImportV3StatusResult(
      assertSeasonalImportV3RpcOk(response, 'get seasonal import V3 status'),
    );
  },

  async cancelSeasonalImportV3(
    batchId: string,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<{ batchId: string; status: 'cancelled' }> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('cancel_seasonal_import_v3', {
      p_batch_id: batchId,
    });
    options.assertOperatorSessionCurrent();
    return parseSeasonalImportV3CancelResult(
      assertSeasonalImportV3RpcOk(response, 'cancel seasonal import V3'),
    );
  },

  async stageDailyScheduleImportV1(
    input: DailyImportStagePayloadV1,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<DailyImportStageResultV1> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('stage_daily_schedule_import_v1', { p_import: input });
    options.assertOperatorSessionCurrent();
    return parseDailyImportStageResultV1(assertDailyImportRpcOk(response, 'stage Daily Schedule import V1'));
  },

  async commitDailyScheduleImportV1(
    input: { batchId: string; expectedVersions: Record<string, number>; previewHash: string },
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<DailyImportCommittedResultV1> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('commit_daily_schedule_import_v1', {
      p_batch_id: input.batchId,
      p_expected_versions: input.expectedVersions,
      p_preview_hash: input.previewHash,
    });
    options.assertOperatorSessionCurrent();
    return parseDailyImportCommittedResultV1(assertDailyImportRpcOk(response, 'commit Daily Schedule import V1'));
  },

  async getDailyScheduleImportV1Status(
    requestId: string,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<DailyImportStageResultV1> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('get_daily_schedule_import_v1_status', { p_request_id: requestId });
    options.assertOperatorSessionCurrent();
    return parseDailyImportStageResultV1(assertDailyImportRpcOk(response, 'get Daily Schedule import V1 status'));
  },

  async cancelDailyScheduleImportV1(
    batchId: string,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<DailyImportStageResultV1> {
    options.assertOperatorSessionCurrent();
    const response = await client().rpc('cancel_daily_schedule_import_v1', { p_batch_id: batchId });
    options.assertOperatorSessionCurrent();
    return parseDailyImportStageResultV1(assertDailyImportRpcOk(response, 'cancel Daily Schedule import V1'));
  },

  async applySeasonalImportRemote(
    input: RemoteSeasonalImportInput,
    options: OperatorSessionCheckpointOptions = { assertOperatorSessionCurrent: () => undefined },
  ): Promise<RemoteSeasonalImportResult> {
    const expectedDataVersion = normalizeSeasonalImportExpectedDataVersion(
      input.seasonId,
      input.expectedDataVersion,
    );
    const payload = {
      requestId: input.requestId,
      checksum: input.checksum,
      mode: normalizeSeasonalImportV2Mode(input.mode),
      seasonId: input.seasonId ?? null,
      seasonCode: input.seasonCode,
      expectedDataVersion,
      fileName: input.fileName,
      uploadedAt: input.uploadedAt,
      sourceRows: canonicalizeSeasonalImportSourceRows(input.sourceRows),
    };
    options.assertOperatorSessionCurrent();
    const result = await runSeasonalImportV2RpcFlow(payload, {
      stage: async (attempt) => {
        options.assertOperatorSessionCurrent();
        return assertSeasonalImportRpcOk(
          await client().rpc('stage_seasonal_import_v2', { p_import: attempt }),
          'stage seasonal import',
        );
      },
      commit: async (batchId, version) => {
        options.assertOperatorSessionCurrent();
        return assertSeasonalImportRpcOk(
          await client().rpc('commit_seasonal_import_v2', {
            p_batch_id: batchId,
            p_expected_data_version: version,
          }),
          'commit seasonal import',
        );
      },
    });
    options.assertOperatorSessionCurrent();
    return result;
  },

  async resumeSeasonalImportRemote(input: RemoteSeasonalImportResumeInput): Promise<RemoteSeasonalImportResult> {
    const payload = assertSeasonalImportRpcOk(
      await client().rpc('resume_seasonal_import_v2', {
        p_request_id: input.requestId,
        p_expected_data_version: input.expectedDataVersion,
      }),
      'resume Seasonal import',
    );
    return parseSeasonalImportV2Result(payload);
  },

  async applySeasonServerMutationV1(payload: ServerSeasonMutationPayload): Promise<ServerSeasonMutationResult> {
    const result = assertOk(
      await client().rpc('apply_season_server_mutation_v1', {
        p_mutation: stripUndefinedDeep(payload),
      }),
      'apply season server mutation'
    ) as ServerSeasonMutationRpc | null;
    return normalizeServerSeasonMutationResult(result);
  },

  async getFlightRecords(seasonId: string): Promise<FlightRecord[]> {
    return (await readFlightRecordsForDashboardSeason(seasonId)).records;
  },

  async getSeasonalExportSnapshot(
    input: RemoteSeasonalExportSnapshotInput
  ): Promise<RemoteSeasonalExportSnapshot> {
    const payload = assertOk(
      await client().rpc('get_seasonal_export_snapshot_v2', {
        p_season_id: input.seasonId,
        p_expected_data_version: input.expectedDataVersion,
      }),
      'load strict seasonal export snapshot',
    );
    return materializeSeasonalExportSnapshot(payload, input);
  },

  async getDashboardSeasonData(seasonId: string): Promise<RemoteDashboardSeasonData> {
    const flightData = await readFlightRecordsForDashboardSeason(seasonId);
    const modifications = await readModificationsForDashboardSeason(
      seasonId,
      flightData.rows
    );
    return {
      sourceRows: [],
      records: flightData.records,
      modifications,
    };
  },

  async getSeasonWorkspaceWindow(
    input: RemoteSeasonWorkspaceWindowInput,
    options: RemoteRequestOptions = {}
  ): Promise<RemoteSeasonWorkspaceWindowResult | null> {
    try {
      const payload = await loadWorkspaceWindowV2(input, {
        signal: options.signal,
        expectedSnapshot: options.expectedSnapshot,
        requestPage: async ({ query, pageSize, cursor, expectedSnapshot, signal }) => {
          let request = client().rpc('get_season_schedule_allocation_window_v2', {
            p_season_id: query.seasonId,
            p_start_date: query.dateFrom ?? null,
            p_end_date: query.dateTo ?? null,
            p_resource_type: query.resourceType ?? 'all',
            p_page_size: pageSize,
            p_after_effective_date: cursor?.effectiveDate ?? null,
            p_after_root_id: cursor?.rootId ?? null,
            p_after_root_kind: cursor?.rootKind ?? null,
            p_expected_data_version: expectedSnapshot?.dataVersion ?? null,
            p_expected_server_high_water: expectedSnapshot?.serverHighWater ?? null,
          });
          if (signal) request = request.abortSignal(signal);
          return assertOk(await request, 'load server workspace window V2');
        },
      });
      return mapWorkspaceWindow(input, {
        ...payload,
        cursor: { serverHighWater: payload.snapshot.serverHighWater },
      }, payload.snapshot.dataVersion);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!shouldUseLegacyWorkspaceWindowRpc(error)) throw error;

      let request = client().rpc('get_season_schedule_allocation_window_v1', {
        p_season_id: input.seasonId,
        p_start_date: input.dateFrom ?? null,
        p_end_date: input.dateTo ?? null,
        p_resource_type: input.resourceType ?? 'all',
        p_limit: input.limit ?? null,
      });
      if (options.signal) request = request.abortSignal(options.signal);
      const payload = assertOk(await request, 'load legacy server workspace window') as SeasonWorkspaceWindowRpc | null;
      return payload ? mapWorkspaceWindow(input, payload) : null;
    }
  },

  async getSeasonWorkspaceSnapshot(
    seasonId: string,
    options: { modHistoryLimit?: number; transport?: 'auto' | 'rpc' | 'paged' } = {}
  ): Promise<RemoteSeasonWorkspaceSnapshot | null> {
    if (options.transport === 'paged') {
      return loadSeasonWorkspaceSnapshotPaged(seasonId, options);
    }
    try {
      const snapshot = assertOk(
        await client().rpc('get_season_workspace_snapshot', {
          p_season_id: seasonId,
          p_mod_history_limit: options.modHistoryLimit ?? 50,
        }),
        'load season workspace snapshot'
      ) as SeasonWorkspaceSnapshotRpc | null;
      return snapshot ? mapWorkspaceSnapshot(snapshot) : null;
    } catch (error) {
      if (options.transport !== 'rpc' && isStatementTimeoutError(error)) {
        return loadSeasonWorkspaceSnapshotPaged(seasonId, options);
      }
      throw error;
    }
  },

  async getModifications(seasonId: string): Promise<Map<string, FlightModification>> {
    const flightData = await readFlightRecordRowsForDashboardSeason(seasonId);
    return readModificationsForDashboardSeason(
      seasonId,
      flightData.rows
    );
  },

  async saveModification(seasonId: string, legId: string, mod: FlightModification): Promise<void> {
    await supabaseStore.saveModifications(seasonId, [{ ...mod, legId }]);
  },

  async saveModifications(seasonId: string, mods: FlightModification[]): Promise<void> {
    for (const mod of mods) {
      assertOk(
        await client().rpc('save_canonical_season_modification_v1', {
          p_season_id: seasonId,
          p_mod_payload: serializeFlightModificationForPersistence(mod),
        }),
        'save canonical season modification'
      );
    }
  },

  async removeModification(seasonId: string, legId: string): Promise<void> {
    assertOk(
      await client().rpc('remove_canonical_season_modification_v1', {
        p_season_id: seasonId,
        p_leg_id: legId,
      }),
      'remove canonical season modification'
    );
  },

  async deleteModifications(seasonId: string, legIds: string[]): Promise<void> {
    if (legIds.length === 0) return;
    for (const chunk of chunkFirestoreWrites(legIds)) {
      for (const legId of chunk) {
        assertOk(
          await client().rpc('remove_canonical_season_modification_v1', {
            p_season_id: seasonId,
            p_leg_id: legId,
          }),
          'delete canonical season modification'
        );
      }
      await pauseBetweenFirestoreWriteBatches();
    }
  },

  async saveModificationsWithHistory(
    seasonId: string,
    mods: FlightModification[],
    currentMods: Map<string, FlightModification>,
    description: string
  ): Promise<void> {
    if (mods.length === 0) return;
    const historyEntry: ModHistoryEntry = {
      id: randomId('history'),
      timestamp: Date.now(),
      description,
      changes: mods.map((mod) => ({
        legId: mod.legId,
        previousMod: currentMods.get(mod.legId) ?? null,
        newMod: serializeFlightModificationForPersistence(mod) as FlightModification,
      })),
    };
    await supabaseStore.saveModifications(seasonId, mods);
    await supabaseStore.saveModHistoryEntries(seasonId, [historyEntry]);
  },

  async saveModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void> {
    const entriesToWrite = splitModHistoryEntriesForFirestore(entries);
    for (const entry of entriesToWrite) {
      const rows = toModHistoryRows(seasonId, entry);
      await upsertRows('season_mod_history_entries', [rows.entryRow], 'entry_id');
      assertOk(await client().from('season_mod_history_changes').delete().eq('entry_id', entry.id), 'clear mod history changes');
      assertOk(await client().from('season_mod_history_record_changes').delete().eq('entry_id', entry.id), 'clear mod history record changes');
      if (rows.changeRows.length > 0) await upsertRows('season_mod_history_changes', rows.changeRows, 'entry_id,change_index');
      if (rows.recordChangeRows.length > 0) await upsertRows('season_mod_history_record_changes', rows.recordChangeRows, 'entry_id,change_index');
    }
  },

  async getModHistory(seasonId: string, limit = 20): Promise<ModHistoryEntry[]> {
    const rows = assertOk(
      await client().from('season_mod_history_entries').select('*').eq('season_id', seasonId).order('timestamp', { ascending: false }).limit(limit),
      'load mod history'
    ) as ModHistoryEntryRelationalRow[];
    const entryIds = rows.map((row) => row.entry_id);
    if (entryIds.length === 0) return [];
    const [changeRowsResult, recordChangeRowsResult] = await Promise.all([
      client().from('season_mod_history_changes').select('*').in('entry_id', entryIds),
      client().from('season_mod_history_record_changes').select('*').in('entry_id', entryIds),
    ]);
    const changeRows = assertOk(changeRowsResult, 'load mod history changes') as ModHistoryChangeRelationalRow[];
    const recordChangeRows = assertOk(recordChangeRowsResult, 'load mod history record changes') as ModHistoryRecordChangeRelationalRow[];
    return rows.map((row) => fromModHistoryRows(
      row,
      changeRows.filter((change) => change.entry_id === row.entry_id),
      recordChangeRows.filter((change) => change.entry_id === row.entry_id)
    ));
  },

  async undoModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void> {
    const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
    for (const entry of sorted) {
      for (const chunk of chunkFirestoreWrites(entry.changes)) {
        const restore = chunk.filter((change) => change.previousMod).map((change) => change.previousMod as FlightModification);
        const remove = chunk.filter((change) => !change.previousMod).map((change) => change.legId);
        if (restore.length > 0) await supabaseStore.saveModifications(seasonId, restore);
        if (remove.length > 0) await supabaseStore.deleteModifications(seasonId, remove);
        await pauseBetweenFirestoreWriteBatches();
      }
      assertOk(await client().from('season_mod_history_entries').delete().eq('entry_id', entry.id), 'delete undo history');
    }
  },

  async syncSeasonWorkspaceRemote(input: RemoteSyncWorkspaceInput): Promise<RemoteSyncWorkspaceResult> {
    const result = assertOk(
      await client().rpc('sync_season_workspace', {
        p_season_id: input.seasonId,
        p_base_version: input.baseServerVersion,
        p_pending_ops: input.pendingOps,
      }),
      'sync season workspace'
    ) as { next_server_version?: number; nextServerVersion?: number };
    input.onProgress?.('Saving workspace', input.pendingOps.length, input.pendingOps.length);
    return { nextServerVersion: result.next_server_version ?? result.nextServerVersion ?? input.baseServerVersion + 1 };
  },

  async syncSeasonWorkspaceRemoteV2(input: RemoteSyncWorkspaceV2Input): Promise<RemoteSyncWorkspaceV2Result> {
    let baseServerSeq = input.baseServerSeq;
    let nextServerSeq = input.baseServerSeq;
    let serverHighWater = input.baseServerSeq;
    let nextServerVersion = input.baseServerSeq;
    const appliedEvents: SeasonChangeEvent[] = [];
    const conflictEvents: SeasonChangeEvent[] = [];
    const changedTargets = new Set<string>();
    const acknowledgedOps = new Set<string>();
    for (let start = 0; start < input.pendingEvents.length; start += SYNC_V2_EVENT_CHUNK_SIZE) {
      const chunk = input.pendingEvents.slice(start, start + SYNC_V2_EVENT_CHUNK_SIZE);
      const result = assertOk(
        await client().rpc('sync_season_workspace_v2', {
          p_season_id: input.seasonId,
          p_client_id: input.clientId,
          p_base_server_seq: baseServerSeq,
          p_pending_events: chunk,
        }),
        'sync season workspace v2'
      ) as {
        applied_events?: SeasonChangeEvent[];
        appliedEvents?: SeasonChangeEvent[];
        conflict_events?: SeasonChangeEvent[];
        conflictEvents?: SeasonChangeEvent[];
        changed_targets?: string[];
        changedTargets?: string[];
        acknowledged_ops?: string[];
        acknowledgedOps?: string[];
        next_server_seq?: number;
        nextServerSeq?: number;
        server_high_water?: number;
        serverHighWater?: number;
        next_server_version?: number;
        nextServerVersion?: number;
      };
      appliedEvents.push(...(result.applied_events ?? result.appliedEvents ?? []).map(normalizeRpcSeasonEvent));
      conflictEvents.push(...(result.conflict_events ?? result.conflictEvents ?? []).map(normalizeRpcSeasonEvent));
      for (const target of result.changed_targets ?? result.changedTargets ?? []) changedTargets.add(target);
      for (const opId of result.acknowledged_ops ?? result.acknowledgedOps ?? []) acknowledgedOps.add(opId);
      nextServerSeq = result.next_server_seq ?? result.nextServerSeq ?? baseServerSeq;
      serverHighWater = Math.max(serverHighWater, result.server_high_water ?? result.serverHighWater ?? nextServerSeq);
      nextServerVersion = result.next_server_version ?? result.nextServerVersion ?? nextServerVersion;
      baseServerSeq = nextServerSeq;
      input.onProgress?.('Saving workspace events', Math.min(start + chunk.length, input.pendingEvents.length), input.pendingEvents.length);
    }
    return {
      appliedEvents,
      conflictEvents,
      changedTargets: Array.from(changedTargets),
      acknowledgedOps: Array.from(acknowledgedOps),
      nextServerSeq,
      serverHighWater,
      nextServerVersion,
    };
  },

  async flushScheduleNotifications(
    input: RemoteScheduleNotificationFlushInput = {}
  ): Promise<RemoteScheduleNotificationFlushResult> {
    const result = await invokeSupabaseFunction<Partial<RemoteScheduleNotificationFlushResult>>('schedule-telegram-notify', {
      seasonId: input.seasonId,
      limit: input.limit,
    });
    return {
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      skipped: result.skipped ?? 0,
      deliveryIds: result.deliveryIds ?? [],
    };
  },

  async getSeasonEventHighWater(seasonId: string): Promise<number> {
    const row = assertOk(
      await client()
        .from('season_change_events')
        .select('server_seq')
        .eq('season_id', seasonId)
        .order('server_seq', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'load season event high-water'
    ) as { server_seq: number | null } | null;
    return Number(row?.server_seq ?? 0);
  },

  async getSeasonEntityVersions(seasonId: string): Promise<LocalEntityVersionMap> {
    const rows = await selectAllRows<SeasonEntityVersionRow>('season_entity_versions', [
      { type: 'eq', column: 'season_id', value: seasonId },
    ], 'load season entity versions');
    return toEntityVersionMap(rows);
  },

  async getSeasonSyncCursorState(seasonId: string): Promise<RemoteSeasonSyncCursorState> {
    const [serverHighWater, entityVersions] = await Promise.all([
      supabaseStore.getSeasonEventHighWater!(seasonId),
      supabaseStore.getSeasonEntityVersions!(seasonId),
    ]);
    return { serverHighWater, entityVersions };
  },

  async loadSeasonEventPage(
    seasonId: string,
    serverSeq: number,
    options: { throughSeq: number; limit?: number }
  ): Promise<RemoteSeasonEventPage> {
    const result = assertOk(
      await client().rpc('get_season_change_event_page', {
        p_season_id: seasonId,
        p_after_seq: serverSeq,
        p_through_seq: options.throughSeq,
        p_limit: options.limit ?? 200,
      }),
      'load season change event page'
    ) as SeasonEventPageRpc;
    const events = (result.events ?? []).map(normalizeRpcSeasonEvent);
    return {
      events,
      nextCursor: numberFromRpc(result.nextCursor ?? result.next_cursor, serverSeq),
      hasMore: Boolean(result.hasMore ?? result.has_more ?? false),
      serverHighWater: numberFromRpc(result.serverHighWater ?? result.server_high_water, options.throughSeq),
    };
  },

  async loadSeasonEventsSince(
    seasonId: string,
    serverSeq: number,
    options: { throughSeq?: number } = {}
  ): Promise<SeasonChangeEvent[]> {
    const throughSeq = options.throughSeq ?? (await supabaseStore.getSeasonEventHighWater!(seasonId));
    const events: SeasonChangeEvent[] = [];
    let cursor = serverSeq;
    let hasMore = true;
    while (hasMore && cursor < throughSeq) {
      const page = await supabaseStore.loadSeasonEventPage!(seasonId, cursor, {
        throughSeq,
        limit: 500,
      });
      events.push(...page.events);
      hasMore = page.hasMore && page.nextCursor > cursor;
      cursor = page.nextCursor;
    }
    return events;
  },

  async subscribeToSeasonEvents(
    seasonId: string,
    onEvent: (event: SeasonChangeEvent) => void,
    options: { onStatus?: (status: string) => void } = {},
  ): Promise<() => void> {
    const channelTopic = `season-change-events:${seasonId}:${randomId('subscription')}`;
    const channel = client()
      .channel(channelTopic)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'season_change_events',
          filter: `season_id=eq.${seasonId}`,
        },
        (payload) => onEvent(toSeasonChangeEvent(payload.new as SeasonChangeEventRow))
      )
      .subscribe((status) => options.onStatus?.(status));
    return () => {
      void client().removeChannel(channel);
    };
  },

  async getCurrentRemoteActor(): Promise<RemoteActor | null> {
    const { data } = await getSupabaseClient().auth.getUser();
    const user = data.user;
    if (!user) return null;

    const { data: operator } = await getSupabaseClient()
      .from('app_operators')
      .select('email,username,display_name')
      .eq('user_id', user.id)
      .maybeSingle();

    const email = typeof operator?.email === 'string' ? operator.email : user.email ?? null;
    const username = typeof operator?.username === 'string' ? operator.username : null;
    const displayName = typeof operator?.display_name === 'string'
      ? operator.display_name
      : user.user_metadata?.name ?? user.user_metadata?.full_name ?? username;

    return {
      uid: user.id,
      email,
      displayName,
      isAnonymous: user.is_anonymous ?? false,
    };
  },
};
