import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow, Season } from './types';
import type {
  LocalEntityVersionMap,
  LocalPendingOp,
  LocalSyncMeta,
  SeasonalDisplayGroupCache,
} from './localSeasonStore';

export const LOCAL_SEASON_SQL_CONNECTION = 'sqlite:seasonal-management-local.db';
export const LOCAL_SEASON_SQL_SCHEMA_VERSION = 1;
const SQLITE_BUSY_RETRY_DELAYS_MS = [25, 75, 150];

export interface LocalSeasonSqlDatabase {
  supportsExplicitTransactions?: boolean;
  execute(sql: string, bindValues?: unknown[]): Promise<unknown>;
  select<T extends Record<string, unknown>>(sql: string, bindValues?: unknown[]): Promise<T[]>;
  close?(): unknown | Promise<unknown>;
}

export interface SqlStoredWorkspace {
  season: Season;
  rows: ParsedRow[];
  records: FlightRecord[];
  modificationEntries: Array<[string, FlightModification]>;
  modHistory: ModHistoryEntry[];
  baseRows: ParsedRow[];
  baseRecords: FlightRecord[];
  baseModificationEntries: Array<[string, FlightModification]>;
  baseModHistory: ModHistoryEntry[];
  pendingOps: LocalPendingOp[];
  derivedSeasonal: SeasonalDisplayGroupCache | null;
  entityVersions: LocalEntityVersionMap;
  syncMeta: LocalSyncMeta;
}

export interface SaveLocalSeasonSqlWorkspaceOptions {
  allowGeneratedRecordShrink?: boolean;
}

export interface RestoreLatestLocalSeasonSqlBackupResult {
  seasonId: string;
  backedUpAt: number;
  sourceRows: number;
  records: number;
  baseRecords: number;
  pendingOps: number;
  lastServerSeq: number | null;
}

export interface LocalSeasonSqlDeltaState {
  season: Season;
  pendingOps: LocalPendingOp[];
  syncMeta: LocalSyncMeta;
  modificationEntries: Array<[string, FlightModification]>;
  baseModificationEntries: Array<[string, FlightModification]>;
  baseRecords: FlightRecord[];
}

type JsonRow = { payloadJson?: string; payload_json?: string };

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS local_schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_seasons (
    season_id TEXT PRIMARY KEY,
    season_code TEXT NOT NULL,
    effective_start TEXT,
    effective_end TEXT,
    data_version INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_source_rows (
    season_id TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    effective TEXT,
    discontinue TEXT,
    airline TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, row_index, is_base),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_flight_records (
    season_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    flight_date TEXT,
    operational_date TEXT,
    type TEXT,
    source_side TEXT,
    status TEXT,
    turnaround_id TEXT,
    gate INTEGER,
    stand INTEGER,
    counter_json TEXT,
    check_in_start TEXT,
    check_in_end TEXT,
    schedule TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, record_id, is_base),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_modifications (
    season_id TEXT NOT NULL,
    leg_id TEXT NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    action TEXT NOT NULL,
    gate INTEGER,
    stand INTEGER,
    counter_json TEXT,
    check_in_start TEXT,
    check_in_end TEXT,
    schedule TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, leg_id, is_base),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_mod_history_entries (
    season_id TEXT NOT NULL,
    history_id TEXT NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, history_id, is_base),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_pending_ops (
    season_id TEXT NOT NULL,
    op_key TEXT NOT NULL,
    op_type TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, op_key),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_derived_seasonal (
    season_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_sync_meta (
    season_id TEXT PRIMARY KEY,
    pending_count INTEGER NOT NULL,
    sync_status TEXT NOT NULL,
    last_server_seq INTEGER,
    last_local_change_at INTEGER,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_entity_versions (
    season_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    PRIMARY KEY (season_id, target_type, target_id),
    FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS local_indexeddb_backup (
    season_id TEXT NOT NULL,
    backed_up_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (season_id, backed_up_at)
  )`,
  `CREATE TABLE IF NOT EXISTS local_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_local_flight_records_lookup ON local_flight_records (season_id, is_base, flight_date, type, gate, stand)',
  'CREATE INDEX IF NOT EXISTS idx_local_modifications_lookup ON local_modifications (season_id, is_base, leg_id, action, gate, stand)',
  'CREATE INDEX IF NOT EXISTS idx_local_pending_ops_type ON local_pending_ops (season_id, op_type, sort_order)',
  'CREATE INDEX IF NOT EXISTS idx_local_entity_versions_target ON local_entity_versions (season_id, target_type, target_id)',
];

let databasePromise: Promise<LocalSeasonSqlDatabase | null> | null = null;
let databaseFactory: (() => Promise<LocalSeasonSqlDatabase | null>) | null = null;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function payload<T>(row: JsonRow, fallback: T): T {
  return decodeJson(row.payloadJson ?? row.payload_json, fallback);
}

function boolToSql(value: boolean): number {
  return value ? 1 : 0;
}

function opKey(op: LocalPendingOp): string {
  if (op.type === 'flightRecord') return `flightRecord:${op.record.id}`;
  if (op.type === 'sourceRow') return `sourceRow:${op.row.rowIndex}`;
  if (op.type === 'modification') return `modification:${op.mod.legId}`;
  if (op.type === 'modificationDelete') return `modification:${op.legId}`;
  return `modHistory:${op.entry.id}`;
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error === 'string') return /database is locked|database table is locked|SQLITE_BUSY/i.test(error);
  if (error instanceof Error) return isSqliteBusyError(error.message);
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    return isSqliteBusyError([record.code, record.message].filter(Boolean).join(' '));
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeSql(
  db: LocalSeasonSqlDatabase,
  sql: string,
  bindValues?: unknown[]
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      return await db.execute(sql, bindValues);
    } catch (error) {
      const retryDelay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (!isSqliteBusyError(error) || retryDelay == null) throw error;
      attempt += 1;
      await wait(retryDelay);
    }
  }
}

async function transaction(db: LocalSeasonSqlDatabase, write: () => Promise<void>): Promise<void> {
  if (db.supportsExplicitTransactions === false) {
    await write();
    return;
  }

  await executeSql(db, 'BEGIN IMMEDIATE');
  try {
    await write();
    await executeSql(db, 'COMMIT');
  } catch (error) {
    try {
      await executeSql(db, 'ROLLBACK');
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function getTauriGlobal(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function isTauriRuntime(): boolean {
  const tauriGlobal = getTauriGlobal();
  return (
    Object.prototype.hasOwnProperty.call(tauriGlobal, '__TAURI_INTERNALS__') ||
    Object.prototype.hasOwnProperty.call(tauriGlobal, '__TAURI__')
  );
}

export function setLocalSeasonSqlDatabaseFactoryForTests(
  factory: (() => Promise<LocalSeasonSqlDatabase | null>) | null
): void {
  databaseFactory = factory;
  databasePromise = null;
}

export async function getLocalSeasonSqlDatabase(): Promise<LocalSeasonSqlDatabase | null> {
  if (!databasePromise) {
    databasePromise = (databaseFactory ?? loadTauriSqlDatabase)();
  }
  return databasePromise;
}

async function loadTauriSqlDatabase(): Promise<LocalSeasonSqlDatabase | null> {
  if (!isTauriRuntime()) return null;
  try {
    const sqlModule = await import('@tauri-apps/plugin-sql');
    const Database = sqlModule.default;
    const db = await Database.load(LOCAL_SEASON_SQL_CONNECTION);
    await migrateLocalSeasonSqlDatabase(db);
    return db;
  } catch (error) {
    console.warn('SQLite local store unavailable; falling back to IndexedDB.', error);
    return null;
  }
}

export async function migrateLocalSeasonSqlDatabase(db: LocalSeasonSqlDatabase): Promise<void> {
  await executeSql(db, 'PRAGMA foreign_keys = ON');
  for (const statement of SCHEMA_STATEMENTS) {
    await executeSql(db, statement);
  }
  await executeSql(db, 
    `INSERT INTO local_schema_version (id, version, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
    [LOCAL_SEASON_SQL_SCHEMA_VERSION, Date.now()]
  );
}

export async function saveLocalSeasonSqlWorkspace(
  db: LocalSeasonSqlDatabase,
  workspace: SqlStoredWorkspace,
  options: SaveLocalSeasonSqlWorkspaceOptions = {}
): Promise<void> {
  assertLocalSeasonSqlWorkspaceIntegrity(workspace, options);
  const seasonId = workspace.season.id;
  await transaction(db, async () => {
    await executeSql(db, 
      `INSERT INTO local_seasons (
        season_id, season_code, effective_start, effective_end, data_version, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(season_id) DO UPDATE SET
        season_code = excluded.season_code,
        effective_start = excluded.effective_start,
        effective_end = excluded.effective_end,
        data_version = excluded.data_version,
        payload_json = excluded.payload_json`,
      [
        seasonId,
        workspace.season.seasonCode,
        workspace.season.effectiveStart,
        workspace.season.effectiveEnd,
        workspace.season.dataVersion ?? 0,
        encodeJson(workspace.season),
      ]
    );

    for (const table of [
      'local_source_rows',
      'local_flight_records',
      'local_modifications',
      'local_mod_history_entries',
      'local_pending_ops',
      'local_derived_seasonal',
      'local_sync_meta',
      'local_entity_versions',
    ]) {
      await executeSql(db, `DELETE FROM ${table} WHERE season_id = ?`, [seasonId]);
    }

    await insertSourceRows(db, seasonId, workspace.rows, false);
    await insertSourceRows(db, seasonId, workspace.baseRows, true);
    await insertFlightRecords(db, seasonId, workspace.records, false);
    await insertFlightRecords(db, seasonId, workspace.baseRecords, true);
    await insertModifications(db, seasonId, workspace.modificationEntries, false);
    await insertModifications(db, seasonId, workspace.baseModificationEntries, true);
    await insertModHistory(db, seasonId, workspace.modHistory, false);
    await insertModHistory(db, seasonId, workspace.baseModHistory, true);
    await insertPendingOps(db, seasonId, workspace.pendingOps);
    await insertDerivedSeasonal(db, seasonId, workspace.derivedSeasonal);
    await insertSyncMeta(db, seasonId, workspace.syncMeta);
    await insertEntityVersions(db, seasonId, workspace.entityVersions);
  });
}

async function insertSourceRows(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  rows: ParsedRow[],
  isBase: boolean
): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await executeSql(db, 
      `INSERT INTO local_source_rows (
        season_id, row_index, is_base, sort_order, effective, discontinue, airline, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [seasonId, row.rowIndex, boolToSql(isBase), index, row.effective, row.discontinue, row.airline, encodeJson(row)]
    );
  }
}

async function insertFlightRecords(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  records: FlightRecord[],
  isBase: boolean
): Promise<void> {
  for (const [index, record] of records.entries()) {
    await executeSql(db, 
      `INSERT INTO local_flight_records (
        season_id, record_id, is_base, sort_order, flight_date, operational_date,
        type, source_side, status, turnaround_id, gate, stand, counter_json,
        check_in_start, check_in_end, schedule, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seasonId,
        record.id,
        boolToSql(isBase),
        index,
        record.date,
        record.operationalDate ?? record.date,
        record.type,
        record.sourceSide,
        record.status,
        record.turnaroundId ?? null,
        record.gate ?? null,
        record.stand ?? null,
        encodeJson(record.counter ?? null),
        record.checkInStart ?? null,
        record.checkInEnd ?? null,
        record.schedule,
        encodeJson(record),
      ]
    );
  }
}

async function insertModifications(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  entries: Array<[string, FlightModification]>,
  isBase: boolean
): Promise<void> {
  for (const [index, [legId, mod]] of entries.entries()) {
    await executeSql(db, 
      `INSERT INTO local_modifications (
        season_id, leg_id, is_base, sort_order, action, gate, stand, counter_json,
        check_in_start, check_in_end, schedule, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seasonId,
        legId,
        boolToSql(isBase),
        index,
        mod.action,
        mod.gate ?? null,
        mod.stand ?? null,
        encodeJson(mod.counter ?? null),
        mod.checkInStart ?? null,
        mod.checkInEnd ?? null,
        mod.schedule ?? null,
        encodeJson(mod),
      ]
    );
  }
}

async function insertModHistory(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  entries: ModHistoryEntry[],
  isBase: boolean
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    await executeSql(db, 
      `INSERT INTO local_mod_history_entries (
        season_id, history_id, is_base, sort_order, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [seasonId, entry.id, boolToSql(isBase), index, entry.timestamp, encodeJson(entry)]
    );
  }
}

async function insertPendingOps(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  pendingOps: LocalPendingOp[]
): Promise<void> {
  for (const [index, op] of pendingOps.entries()) {
    await executeSql(db, 
      `INSERT INTO local_pending_ops (
        season_id, op_key, op_type, sort_order, payload_json
      ) VALUES (?, ?, ?, ?, ?)`,
      [seasonId, opKey(op), op.type, index, encodeJson(op)]
    );
  }
}

async function insertDerivedSeasonal(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  derivedSeasonal: SeasonalDisplayGroupCache | null
): Promise<void> {
  await executeSql(db, 
    'INSERT INTO local_derived_seasonal (season_id, payload_json) VALUES (?, ?)',
    [seasonId, encodeJson(derivedSeasonal)]
  );
}

async function insertSyncMeta(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  syncMeta: LocalSyncMeta
): Promise<void> {
  await executeSql(db, 
    `INSERT INTO local_sync_meta (
      season_id, pending_count, sync_status, last_server_seq, last_local_change_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      seasonId,
      syncMeta.pendingCount,
      syncMeta.syncStatus,
      syncMeta.lastServerSeq ?? null,
      syncMeta.lastLocalChangeAt ?? null,
      encodeJson(syncMeta),
    ]
  );
}

async function insertEntityVersions(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  entityVersions: LocalEntityVersionMap
): Promise<void> {
  for (const [targetType, versions] of Object.entries(entityVersions)) {
    for (const [targetId, version] of Object.entries(versions)) {
      await executeSql(db, 
        `INSERT INTO local_entity_versions (
          season_id, target_type, target_id, server_version
        ) VALUES (?, ?, ?, ?)`,
        [seasonId, targetType, targetId, version]
      );
    }
  }
}

export async function loadLocalSeasonSqlWorkspace(
  db: LocalSeasonSqlDatabase,
  seasonId: string
): Promise<SqlStoredWorkspace | null> {
  const seasonRows = await db.select<JsonRow>(
    'SELECT payload_json AS payloadJson FROM local_seasons WHERE season_id = ?',
    [seasonId]
  );
  if (seasonRows.length === 0) return null;

  const [
    rows,
    baseRows,
    records,
    baseRecords,
    modificationEntries,
    baseModificationEntries,
    modHistory,
    baseModHistory,
    pendingOps,
    derivedRows,
    syncMetaRows,
    entityVersionRows,
  ] = await Promise.all([
    loadJsonRows<ParsedRow>(db, 'local_source_rows', seasonId, false),
    loadJsonRows<ParsedRow>(db, 'local_source_rows', seasonId, true),
    loadJsonRows<FlightRecord>(db, 'local_flight_records', seasonId, false),
    loadJsonRows<FlightRecord>(db, 'local_flight_records', seasonId, true),
    loadModificationEntries(db, seasonId, false),
    loadModificationEntries(db, seasonId, true),
    loadJsonRows<ModHistoryEntry>(db, 'local_mod_history_entries', seasonId, false),
    loadJsonRows<ModHistoryEntry>(db, 'local_mod_history_entries', seasonId, true),
    loadPendingOps(db, seasonId),
    db.select<JsonRow>('SELECT payload_json AS payloadJson FROM local_derived_seasonal WHERE season_id = ?', [seasonId]),
    db.select<JsonRow>('SELECT payload_json AS payloadJson FROM local_sync_meta WHERE season_id = ?', [seasonId]),
    db.select<{ targetType?: string; target_type?: string; targetId?: string; target_id?: string; serverVersion?: number; server_version?: number }>(
      `SELECT target_type AS targetType, target_id AS targetId, server_version AS serverVersion
       FROM local_entity_versions
       WHERE season_id = ?`,
      [seasonId]
    ),
  ]);

  return {
    season: payload<Season>(seasonRows[0], { id: seasonId } as Season),
    rows,
    records,
    modificationEntries,
    modHistory,
    baseRows,
    baseRecords,
    baseModificationEntries,
    baseModHistory,
    pendingOps,
    derivedSeasonal: derivedRows.length > 0 ? payload<SeasonalDisplayGroupCache | null>(derivedRows[0], null) : null,
    entityVersions: buildEntityVersionMap(entityVersionRows),
    syncMeta: syncMetaRows.length > 0
      ? payload<LocalSyncMeta>(syncMetaRows[0], { seasonId, pendingCount: 0, localRevision: 0, baseServerVersion: 0, lastLocalChangeAt: null, syncStatus: 'synced' })
      : { seasonId, pendingCount: pendingOps.length, localRevision: 0, baseServerVersion: 0, lastLocalChangeAt: null, syncStatus: pendingOps.length > 0 ? 'dirty' : 'synced' },
  };
}

async function loadJsonRows<T>(
  db: LocalSeasonSqlDatabase,
  table: string,
  seasonId: string,
  isBase: boolean
): Promise<T[]> {
  const rows = await db.select<JsonRow>(
    `SELECT payload_json AS payloadJson FROM ${table}
     WHERE season_id = ? AND is_base = ?
     ORDER BY sort_order ASC`,
    [seasonId, boolToSql(isBase)]
  );
  return rows.map((row) => payload<T>(row, null as T));
}

async function loadModificationEntries(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  isBase: boolean,
  legIds?: string[]
): Promise<Array<[string, FlightModification]>> {
  const params: unknown[] = [seasonId, boolToSql(isBase)];
  const legFilter = legIds && legIds.length > 0
    ? ` AND leg_id IN (${placeholders(legIds)})`
    : '';
  params.push(...(legIds ?? []));
  const rows = await db.select<{ legId?: string; leg_id?: string; payloadJson?: string; payload_json?: string }>(
    `SELECT leg_id AS legId, payload_json AS payloadJson
     FROM local_modifications
     WHERE season_id = ? AND is_base = ?${legFilter}
     ORDER BY sort_order ASC`,
    params
  );
  return rows.map((row) => [String(row.legId ?? row.leg_id), payload<FlightModification>(row, { legId: String(row.legId ?? row.leg_id), action: 'modified' })]);
}

async function loadPendingOps(
  db: LocalSeasonSqlDatabase,
  seasonId: string
): Promise<LocalPendingOp[]> {
  const rows = await db.select<JsonRow>(
    `SELECT payload_json AS payloadJson
     FROM local_pending_ops
     WHERE season_id = ?
     ORDER BY sort_order ASC`,
    [seasonId]
  );
  return rows.map((row) => payload<LocalPendingOp>(row, null as unknown as LocalPendingOp));
}

function buildEntityVersionMap(
  rows: Array<{ targetType?: string; target_type?: string; targetId?: string; target_id?: string; serverVersion?: number; server_version?: number }>
): LocalEntityVersionMap {
  const versions: LocalEntityVersionMap = {};
  for (const row of rows) {
    const targetType = String(row.targetType ?? row.target_type ?? '');
    const targetId = String(row.targetId ?? row.target_id ?? '');
    const version = Number(row.serverVersion ?? row.server_version ?? 0);
    if (!targetType || !targetId) continue;
    versions[targetType] ??= {};
    versions[targetType][targetId] = version;
  }
  return versions;
}

export function assertLocalSeasonSqlWorkspaceIntegrity(
  workspace: SqlStoredWorkspace,
  options: SaveLocalSeasonSqlWorkspaceOptions = {}
): void {
  if (options.allowGeneratedRecordShrink) return;
  const expectedRecords = Math.max(
    Number(workspace.season.totalLegs ?? 0),
    countGeneratedFlightRecords(workspace.rows),
    countGeneratedFlightRecords(workspace.baseRows)
  );
  if (expectedRecords === 0) return;
  const currentCount = workspace.records.length;
  const baseCount = workspace.baseRecords.length;
  if (currentCount >= expectedRecords && baseCount >= expectedRecords) return;
  throw new Error(
    `Local workspace ${workspace.season.id} would shrink generated flight records: ` +
    `expected at least ${expectedRecords}, got current=${currentCount}, base=${baseCount}.`
  );
}

function countGeneratedFlightRecords(rows: ParsedRow[]): number {
  let count = 0;
  for (const row of rows) {
    const start = parseSourceRowDate(row.effective);
    const end = parseSourceRowDate(row.discontinue);
    if (!start || !end || end < start) continue;
    const legsPerDay = (row.arrFlight != null && row.sta != null ? 1 : 0) +
      (row.depFlight != null && row.std != null ? 1 : 0);
    if (legsPerDay === 0) continue;
    const cursor = new Date(start);
    while (cursor <= end) {
      const jsDay = cursor.getDay();
      const dowIndex = jsDay === 0 ? 6 : jsDay - 1;
      if (row.daysOfWeek[dowIndex]) count += legsPerDay;
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return count;
}

function parseSourceRowDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dmy = /^(\d{1,2})[-\s/]([A-Za-z]{3})[-\s/](\d{2}|\d{4})$/.exec(trimmed);
  if (!dmy) return null;
  const month = MONTH_INDEX[dmy[2].toLowerCase()];
  if (month == null) return null;
  const rawYear = Number(dmy[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return new Date(year, month, Number(dmy[1]));
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export async function readLocalSeasonSqlDeltaState(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  affectedLegIds: Set<string>
): Promise<LocalSeasonSqlDeltaState | null> {
  const seasonRows = await db.select<JsonRow>(
    'SELECT payload_json AS payloadJson FROM local_seasons WHERE season_id = ?',
    [seasonId]
  );
  if (seasonRows.length === 0) return null;

  const legIds = Array.from(affectedLegIds);
  const [
    pendingOps,
    syncMetaRows,
    modificationEntries,
    baseModificationEntries,
    baseRecords,
  ] = await Promise.all([
    loadPendingOps(db, seasonId),
    db.select<JsonRow>('SELECT payload_json AS payloadJson FROM local_sync_meta WHERE season_id = ?', [seasonId]),
    loadModificationEntries(db, seasonId, false, legIds),
    loadModificationEntries(db, seasonId, true, legIds),
    loadFlightRecordsByIds(db, seasonId, legIds, true),
  ]);

  return {
    season: payload<Season>(seasonRows[0], { id: seasonId } as Season),
    pendingOps,
    syncMeta: syncMetaRows.length > 0
      ? payload<LocalSyncMeta>(syncMetaRows[0], { seasonId, pendingCount: pendingOps.length, localRevision: 0, baseServerVersion: 0, lastLocalChangeAt: null, syncStatus: pendingOps.length > 0 ? 'dirty' : 'synced' })
      : { seasonId, pendingCount: pendingOps.length, localRevision: 0, baseServerVersion: 0, lastLocalChangeAt: null, syncStatus: pendingOps.length > 0 ? 'dirty' : 'synced' },
    modificationEntries,
    baseModificationEntries,
    baseRecords,
  };
}

async function loadFlightRecordsByIds(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  recordIds: string[],
  isBase: boolean
): Promise<FlightRecord[]> {
  if (recordIds.length === 0) return [];
  const rows = await db.select<JsonRow>(
    `SELECT payload_json AS payloadJson
     FROM local_flight_records
     WHERE season_id = ? AND is_base = ? AND record_id IN (${placeholders(recordIds)})
     ORDER BY sort_order ASC`,
    [seasonId, boolToSql(isBase), ...recordIds]
  );
  return rows.map((row) => payload<FlightRecord>(row, null as unknown as FlightRecord));
}

export async function replaceLocalSeasonSqlPendingState(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  pendingOps: LocalPendingOp[],
  syncMeta: LocalSyncMeta
): Promise<void> {
  await transaction(db, async () => {
    await executeSql(db, 'DELETE FROM local_pending_ops WHERE season_id = ?', [seasonId]);
    await executeSql(db, 'DELETE FROM local_derived_seasonal WHERE season_id = ?', [seasonId]);
    await executeSql(db, 'DELETE FROM local_sync_meta WHERE season_id = ?', [seasonId]);
    await insertPendingOps(db, seasonId, pendingOps);
    await insertDerivedSeasonal(db, seasonId, null);
    await insertSyncMeta(db, seasonId, syncMeta);
  });
}

export async function listLocalSeasonSqlWorkspaceIds(db: LocalSeasonSqlDatabase): Promise<string[]> {
  const rows = await db.select<{ seasonId?: string; season_id?: string }>(
    'SELECT season_id AS seasonId FROM local_seasons ORDER BY season_id'
  );
  return rows.map((row) => String(row.seasonId ?? row.season_id));
}

export async function clearLocalSeasonSqlWorkspaces(db: LocalSeasonSqlDatabase): Promise<void> {
  await transaction(db, async () => {
    for (const table of [
      'local_source_rows',
      'local_flight_records',
      'local_modifications',
      'local_mod_history_entries',
      'local_pending_ops',
      'local_derived_seasonal',
      'local_sync_meta',
      'local_entity_versions',
      'local_seasons',
    ]) {
      await executeSql(db, `DELETE FROM ${table}`);
    }
  });
}

export async function readLocalSeasonSqlSyncMeta(
  db: LocalSeasonSqlDatabase,
  seasonId: string
): Promise<LocalSyncMeta | null> {
  const rows = await db.select<JsonRow>(
    'SELECT payload_json AS payloadJson FROM local_sync_meta WHERE season_id = ?',
    [seasonId]
  );
  return rows.length > 0 ? payload<LocalSyncMeta>(rows[0], null as unknown as LocalSyncMeta) : null;
}

export async function setLocalSeasonSqlSyncMeta(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  syncMeta: LocalSyncMeta
): Promise<void> {
  await transaction(db, async () => {
    await executeSql(db, 'DELETE FROM local_sync_meta WHERE season_id = ?', [seasonId]);
    await insertSyncMeta(db, seasonId, syncMeta);
  });
}

export async function saveLocalSeasonIndexedDbBackup(
  db: LocalSeasonSqlDatabase,
  seasonId: string,
  snapshot: unknown
): Promise<void> {
  await executeSql(db, 
    `INSERT INTO local_indexeddb_backup (season_id, backed_up_at, payload_json)
     VALUES (?, ?, ?)`,
    [seasonId, Date.now(), encodeJson(snapshot)]
  );
}

export async function restoreLatestLocalSeasonSqlBackup(
  db: LocalSeasonSqlDatabase,
  seasonId: string
): Promise<RestoreLatestLocalSeasonSqlBackupResult | null> {
  const rows = await db.select<JsonRow & { backedUpAt?: number; backed_up_at?: number }>(
    `SELECT backed_up_at AS backedUpAt, payload_json AS payloadJson
     FROM local_indexeddb_backup
     WHERE season_id = ?
     ORDER BY backed_up_at DESC
     LIMIT 1`,
    [seasonId]
  );
  if (rows.length === 0) return null;
  const backup = payload<SqlStoredWorkspace | null>(rows[0], null);
  if (!backup?.season?.id) {
    throw new Error(`Latest local backup for ${seasonId} is not a valid season workspace.`);
  }
  if (backup.season.id !== seasonId) {
    throw new Error(`Latest local backup season mismatch: expected ${seasonId}, got ${backup.season.id}.`);
  }
  await saveLocalSeasonSqlWorkspace(db, backup);
  return {
    seasonId,
    backedUpAt: Number(rows[0].backedUpAt ?? rows[0].backed_up_at ?? 0),
    sourceRows: backup.rows.length,
    records: backup.records.length,
    baseRecords: backup.baseRecords.length,
    pendingOps: backup.pendingOps.length,
    lastServerSeq: backup.syncMeta.lastServerSeq ?? null,
  };
}

export async function getLocalSeasonSqlKv<T>(
  db: LocalSeasonSqlDatabase,
  key: string,
  fallback: T
): Promise<T> {
  const rows = await db.select<{ valueJson?: string; value_json?: string }>(
    'SELECT value_json AS valueJson FROM local_kv WHERE key = ?',
    [key]
  );
  return rows.length > 0 ? decodeJson<T>(rows[0].valueJson ?? rows[0].value_json, fallback) : fallback;
}

export async function setLocalSeasonSqlKv(
  db: LocalSeasonSqlDatabase,
  key: string,
  value: unknown
): Promise<void> {
  await executeSql(db, 
    `INSERT INTO local_kv (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [key, encodeJson(value), Date.now()]
  );
}

