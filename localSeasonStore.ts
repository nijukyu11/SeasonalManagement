import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow, Season } from './types';
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
import type { SeasonConflictItem } from './seasonChangeEvents';
import {
  clearLocalSeasonSqlWorkspaces,
  getLocalSeasonSqlDatabase,
  getLocalSeasonSqlKv,
  listLocalSeasonSqlWorkspaceIds,
  loadLocalSeasonSqlWorkspace,
  readLocalSeasonSqlDeltaState,
  readLocalSeasonSqlSyncMeta,
  replaceLocalSeasonSqlPendingState,
  saveLocalSeasonIndexedDbBackup,
  saveLocalSeasonSqlWorkspace,
  setLocalSeasonSqlSyncMeta,
  setLocalSeasonSqlKv,
  type LocalSeasonSqlDatabase,
  type SqlStoredWorkspace,
} from './localSeasonSqlStore';
import { runNativeLocalModificationBatchDelta, runNativeScheduleMutation } from './nativeLocalSeasonStore';
import { isTauriRuntime } from './nativeRuntime';

const DB_NAME = 'seasonal-management-local';
const DB_VERSION = 3;
const INDEXEDDB_SQL_RESET_KEY = 'indexeddb-sql-reset-v1';

export type LocalEntityVersionMap = Record<string, Record<string, number>>;

export type LocalPendingOp =
  | { type: 'flightRecord'; record: FlightRecord | { id: string; [key: string]: unknown } }
  | { type: 'sourceRow'; row: ParsedRow | { rowIndex: number; [key: string]: unknown } }
  | { type: 'modification'; mod: FlightModification }
  | { type: 'modificationDelete'; legId: string }
  | { type: 'modHistory'; entry: ModHistoryEntry };

export interface LocalSyncMeta {
  seasonId: string;
  baseServerVersion: number;
  lastServerSeq?: number;
  clientId?: string;
  appliedEventIds?: string[];
  conflicts?: SeasonConflictItem[];
  localRevision: number;
  pendingCount: number;
  lastLocalChangeAt: number | null;
  syncStatus: 'synced' | 'dirty' | 'syncing' | 'conflict' | 'needs_review' | 'failed';
}

export interface SeasonalDisplayGroupCache {
  groups: unknown[];
  builtAt: number;
  revision: number;
}

interface StoredSeasonData {
  season: Season;
  rows: ParsedRow[];
  records: FlightRecord[];
  modificationEntries: Array<[string, FlightModification]>;
  modHistory: ModHistoryEntry[];
  baseRows?: ParsedRow[];
  baseRecords?: FlightRecord[];
  baseModificationEntries?: Array<[string, FlightModification]>;
  baseModHistory?: ModHistoryEntry[];
}

export interface LocalSeasonWorkspace {
  season: Season;
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
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

interface SeasonalLocalDb extends DBSchema {
  seasonData: {
    key: string;
    value: StoredSeasonData & { seasonId: string };
  };
  pendingOps: {
    key: string;
    value: { seasonId: string; ops: LocalPendingOp[] };
  };
  derivedSeasonal: {
    key: string;
    value: { seasonId: string; cache: SeasonalDisplayGroupCache | null };
  };
  syncMeta: {
    key: string;
    value: LocalSyncMeta;
  };
  entityVersions: {
    key: string;
    value: { seasonId: string; versions: LocalEntityVersionMap };
  };
}

const memoryWorkspaces = new Map<string, LocalSeasonWorkspace>();
let dbPromise: Promise<IDBPDatabase<SeasonalLocalDb>> | null = null;
let databaseResetInProgress = false;
let sqlMigrationPromise: Promise<void> | null = null;

export type NativeFullWorkspaceSaveReason =
  | 'indexeddb-seed'
  | 'server-baseline'
  | 'import-reset'
  | 'repair-reset'
  | 'sync-baseline'
  | 'session-discard'
  | 'undo-reset';

export interface SaveLocalSeasonWorkspaceOptions {
  nativeFullSaveReason?: NativeFullWorkspaceSaveReason;
}

function isNativeLocalRuntime(): boolean {
  return isTauriRuntime();
}

function isNativeFullWorkspaceSaveAllowed(options: SaveLocalSeasonWorkspaceOptions): boolean {
  return Boolean(options.nativeFullSaveReason);
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function getDb(): Promise<IDBPDatabase<SeasonalLocalDb>> {
  if (databaseResetInProgress) {
    return Promise.reject(new Error('Local session cleanup is in progress'));
  }
  if (!dbPromise) {
    dbPromise = openDB<SeasonalLocalDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('seasonData')) db.createObjectStore('seasonData');
        if (!db.objectStoreNames.contains('pendingOps')) db.createObjectStore('pendingOps');
        if (!db.objectStoreNames.contains('derivedSeasonal')) db.createObjectStore('derivedSeasonal');
        if (!db.objectStoreNames.contains('syncMeta')) db.createObjectStore('syncMeta');
        if (!db.objectStoreNames.contains('entityVersions')) db.createObjectStore('entityVersions');
      },
    });
  }
  return dbPromise;
}

async function closeLocalSeasonDb(): Promise<void> {
  const pendingDb = dbPromise;
  dbPromise = null;
  if (!pendingDb) return;

  try {
    const db = await pendingDb;
    db.close();
  } catch {
    // If opening failed because of a local DB version mismatch, there is no
    // live connection to close. The delete step below is still the rollback.
  }
}

export function serializeModificationMap(
  modifications: Map<string, FlightModification>
): Array<[string, FlightModification]> {
  return Array.from(modifications.entries()).map(([legId, mod]) => [
    legId,
    serializeFlightModificationForPersistence(mod) as FlightModification,
  ]);
}

export function deserializeModificationEntries(
  entries: Array<[string, FlightModification]> = []
): Map<string, FlightModification> {
  return new Map(entries.map(([legId, mod]) => [legId, hydrateFlightModificationFromPersistence(mod)]));
}

function pickHydratedModificationsById(
  entries: Array<[string, FlightModification]> | undefined,
  legIds: Set<string>
): Map<string, FlightModification> {
  const picked = new Map<string, FlightModification>();
  for (const [legId, mod] of entries ?? []) {
    if (!legIds.has(legId)) continue;
    picked.set(legId, hydrateFlightModificationFromPersistence(mod));
  }
  return picked;
}

export function buildInitialSyncMeta(
  season: Pick<Season, 'id' | 'dataVersion'>,
  options: { lastServerSeq?: number; clientId?: string } = {}
): LocalSyncMeta {
  return {
    seasonId: season.id,
    baseServerVersion: season.dataVersion ?? 0,
    lastServerSeq: options.lastServerSeq ?? 0,
    clientId: options.clientId,
    localRevision: 0,
    pendingCount: 0,
    lastLocalChangeAt: null,
    syncStatus: 'synced',
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

function isSameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isNoOpModificationAgainstBaseRecord(
  mod: FlightModification,
  baseRecord: FlightRecord | undefined
): boolean {
  if (mod.action !== 'modified' || !baseRecord) return false;
  const fieldPairs: Array<[keyof FlightModification, keyof FlightRecord]> = [
    ['schedule', 'schedule'],
    ['aircraft', 'aircraft'],
    ['route', 'route'],
    ['codeShares', 'codeShares'],
    ['pax', 'pax'],
    ['gate', 'gate'],
    ['stand', 'stand'],
    ['counter', 'counter'],
    ['checkInStart', 'checkInStart'],
    ['checkInEnd', 'checkInEnd'],
    ['checkInAllocationMode', 'checkInAllocationMode'],
    ['carousel', 'carousel'],
    ['mct', 'mct'],
    ['fb', 'fb'],
    ['lb', 'lb'],
    ['bhs', 'bhs'],
    ['ghs', 'ghs'],
  ];
  return fieldPairs.every(([modKey, recordKey]) => {
    if (!(modKey in mod)) return true;
    return isSameValue(mod[modKey] ?? null, baseRecord[recordKey] ?? null);
  });
}

function serializePendingOp(op: LocalPendingOp): LocalPendingOp {
  if (op.type === 'sourceRow') {
    return { ...op, row: serializeSourceRowForPersistence(op.row as ParsedRow) };
  }
  if (op.type === 'flightRecord') {
    return { ...op, record: serializeFlightRecordForPersistence(op.record as FlightRecord) };
  }
  if (op.type === 'modification') {
    return { ...op, mod: serializeFlightModificationForPersistence(op.mod) as FlightModification };
  }
  if (op.type === 'modHistory') {
    return { ...op, entry: serializeModHistoryEntryForPersistence(op.entry) };
  }
  return op;
}

function hydratePendingOp(op: LocalPendingOp): LocalPendingOp {
  if (op.type === 'sourceRow') {
    return { ...op, row: hydrateSourceRowFromPersistence(op.row as Partial<ParsedRow>) };
  }
  if (op.type === 'flightRecord') {
    return { ...op, record: hydrateFlightRecordFromPersistence(op.record as Partial<FlightRecord>) };
  }
  if (op.type === 'modification') {
    return { ...op, mod: hydrateFlightModificationFromPersistence(op.mod) };
  }
  if (op.type === 'modHistory') {
    return { ...op, entry: hydrateModHistoryEntryFromPersistence(op.entry) };
  }
  return op;
}

function applyPendingOpsToStoredSeasonData(
  data: StoredSeasonData,
  pendingOps: LocalPendingOp[]
): {
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  modHistory: ModHistoryEntry[];
} {
  const rowsByIndex = new Map<number, ParsedRow>();
  for (const row of data.rows) {
    const hydrated = hydrateSourceRowFromPersistence(row);
    rowsByIndex.set(hydrated.rowIndex, hydrated);
  }

  const recordsById = new Map<string, FlightRecord>();
  for (const record of data.records) {
    const hydrated = hydrateFlightRecordFromPersistence(record);
    recordsById.set(hydrated.id, hydrated);
  }

  const modifications = deserializeModificationEntries(data.modificationEntries);
  const modHistory = data.modHistory.map((entry) => hydrateModHistoryEntryFromPersistence(entry));
  const modHistoryIds = new Set(modHistory.map((entry) => entry.id));
  const pendingHistory: ModHistoryEntry[] = [];

  for (const op of pendingOps) {
    if (op.type === 'sourceRow') {
      const row = op.row as ParsedRow;
      rowsByIndex.set(row.rowIndex, row);
    } else if (op.type === 'flightRecord') {
      const record = op.record as FlightRecord;
      recordsById.set(record.id, record);
    } else if (op.type === 'modification') {
      modifications.set(op.mod.legId, op.mod);
    } else if (op.type === 'modificationDelete') {
      modifications.delete(op.legId);
    } else if (!modHistoryIds.has(op.entry.id)) {
      pendingHistory.push(op.entry);
      modHistoryIds.add(op.entry.id);
    }
  }

  return {
    rows: Array.from(rowsByIndex.values()),
    records: Array.from(recordsById.values()),
    modifications,
    modHistory: [...pendingHistory, ...modHistory],
  };
}

function pickHydratedRecordsById(
  records: FlightRecord[] | undefined,
  recordIds: Set<string>
): Map<string, FlightRecord> {
  const picked = new Map<string, FlightRecord>();
  for (const record of records ?? []) {
    if (!recordIds.has(record.id)) continue;
    picked.set(record.id, hydrateFlightRecordFromPersistence(record));
  }
  return picked;
}

function buildNextSyncMeta(
  current: LocalSyncMeta | undefined,
  season: Pick<Season, 'id' | 'dataVersion'>,
  pendingCount: number,
  changedAt: number
): LocalSyncMeta {
  const base = current ?? buildInitialSyncMeta(season);
  const conflictCount = base.conflicts?.length ?? 0;
  return {
    ...base,
    localRevision: base.localRevision + 1,
    pendingCount,
    lastLocalChangeAt: pendingCount > 0 ? changedAt : null,
    syncStatus: conflictCount > 0 ? (pendingCount > 0 ? 'dirty' : 'needs_review') : (pendingCount > 0 ? 'dirty' : 'synced'),
  };
}

export function createLocalWorkspace({
  season,
  rows,
  records,
  modifications,
  modHistory,
  baseRows,
  baseRecords,
  baseModificationEntries,
  baseModHistory,
  pendingOps = [],
  derivedSeasonal = null,
  entityVersions = {},
  serverEventHighWater,
  syncMeta,
}: {
  season: Season;
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  modHistory: ModHistoryEntry[];
  baseRows?: ParsedRow[];
  baseRecords?: FlightRecord[];
  baseModificationEntries?: Array<[string, FlightModification]>;
  baseModHistory?: ModHistoryEntry[];
  pendingOps?: LocalPendingOp[];
  derivedSeasonal?: SeasonalDisplayGroupCache | null;
  entityVersions?: LocalEntityVersionMap;
  serverEventHighWater?: number;
  syncMeta?: LocalSyncMeta;
}): LocalSeasonWorkspace {
  const mergedPending = mergePendingOps(pendingOps);
  const nextMeta = syncMeta ?? buildInitialSyncMeta(season, { lastServerSeq: serverEventHighWater });
  return {
    season,
    rows,
    records,
    modifications,
    modHistory,
    baseRows: baseRows ?? cloneJson(rows),
    baseRecords: baseRecords ?? cloneJson(records),
    baseModificationEntries: baseModificationEntries ?? serializeModificationMap(modifications),
    baseModHistory: baseModHistory ?? cloneJson(modHistory),
    pendingOps: mergedPending,
    derivedSeasonal,
    entityVersions: cloneJson(entityVersions),
    syncMeta: {
      ...nextMeta,
      pendingCount: mergedPending.length,
      syncStatus: mergedPending.length > 0 && nextMeta.syncStatus === 'synced' ? 'dirty' : nextMeta.syncStatus,
    },
  };
}

function pendingKey(op: LocalPendingOp): string {
  if (op.type === 'flightRecord') return `flightRecord:${op.record.id}`;
  if (op.type === 'sourceRow') return `sourceRow:${op.row.rowIndex}`;
  if (op.type === 'modification') return `modification:${op.mod.legId}`;
  if (op.type === 'modificationDelete') return `modification:${op.legId}`;
  return `modHistory:${op.entry.id}`;
}

export function mergePendingOps(ops: LocalPendingOp[]): LocalPendingOp[] {
  const byKey = new Map<string, LocalPendingOp>();
  for (const op of ops) byKey.set(pendingKey(op), op);
  return Array.from(byKey.values());
}

export function rebuildPendingOpsFromBaseline(
  workspace: LocalSeasonWorkspace,
  changedAt: number | null = workspace.syncMeta.lastLocalChangeAt
): LocalSeasonWorkspace {
  const pendingOps: LocalPendingOp[] = [];
  const baseRowsByIndex = new Map(workspace.baseRows.map((row) => [row.rowIndex, row]));
  for (const row of workspace.rows) {
    const baseRow = baseRowsByIndex.get(row.rowIndex);
    if (!baseRow || !isSameValue(row, baseRow)) pendingOps.push({ type: 'sourceRow', row });
  }

  const baseRecordsById = new Map(workspace.baseRecords.map((record) => [record.id, record]));
  for (const record of workspace.records) {
    const baseRecord = baseRecordsById.get(record.id);
    if (!baseRecord || !isSameValue(record, baseRecord)) pendingOps.push({ type: 'flightRecord', record });
  }

  const baseMods = deserializeModificationEntries(workspace.baseModificationEntries);
  const normalizedMods = new Map(workspace.modifications);
  for (const [legId, mod] of workspace.modifications) {
    if (!baseMods.has(legId) && isNoOpModificationAgainstBaseRecord(mod, baseRecordsById.get(legId))) {
      normalizedMods.delete(legId);
    }
  }

  for (const [legId, mod] of normalizedMods) {
    const baseMod = baseMods.get(legId);
    if (!baseMod || !isSameValue(mod, baseMod)) pendingOps.push({ type: 'modification', mod });
  }
  for (const legId of baseMods.keys()) {
    if (!normalizedMods.has(legId)) pendingOps.push({ type: 'modificationDelete', legId });
  }

  const hasPendingBusinessChange = pendingOps.some((op) => op.type !== 'modHistory');
  if (hasPendingBusinessChange) {
    const baseHistoryIds = new Set(workspace.baseModHistory.map((entry) => entry.id));
    for (const entry of workspace.modHistory) {
      if (!baseHistoryIds.has(entry.id)) pendingOps.push({ type: 'modHistory', entry });
    }
  }

  const mergedPending = mergePendingOps(pendingOps);
  const conflictCount = workspace.syncMeta.conflicts?.length ?? 0;
  return {
    ...workspace,
    modifications: normalizedMods,
    pendingOps: mergedPending,
    syncMeta: {
      ...workspace.syncMeta,
      pendingCount: mergedPending.length,
      lastLocalChangeAt: mergedPending.length > 0 ? changedAt ?? Date.now() : null,
      syncStatus: conflictCount > 0 ? (mergedPending.length > 0 ? 'dirty' : 'needs_review') : (mergedPending.length > 0 ? 'dirty' : 'synced'),
    },
  };
}

export function markDerivedSeasonalDirty(workspace: LocalSeasonWorkspace): LocalSeasonWorkspace {
  return {
    ...workspace,
    derivedSeasonal: null,
    syncMeta: {
      ...workspace.syncMeta,
      localRevision: workspace.syncMeta.localRevision + 1,
    },
  };
}

function withPendingOps(workspace: LocalSeasonWorkspace): LocalSeasonWorkspace {
  return markDerivedSeasonalDirty(rebuildPendingOpsFromBaseline(workspace, Date.now()));
}

function serializeWorkspaceForSql(workspace: LocalSeasonWorkspace): SqlStoredWorkspace {
  return {
    season: workspace.season,
    rows: workspace.rows.map(serializeSourceRowForPersistence) as unknown as ParsedRow[],
    records: workspace.records.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
    modificationEntries: serializeModificationMap(workspace.modifications),
    modHistory: workspace.modHistory.map(serializeModHistoryEntryForPersistence),
    baseRows: workspace.baseRows.map(serializeSourceRowForPersistence) as unknown as ParsedRow[],
    baseRecords: workspace.baseRecords.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
    baseModificationEntries: serializeModificationMap(deserializeModificationEntries(workspace.baseModificationEntries)),
    baseModHistory: workspace.baseModHistory.map(serializeModHistoryEntryForPersistence),
    pendingOps: workspace.pendingOps.map(serializePendingOp),
    derivedSeasonal: workspace.derivedSeasonal,
    entityVersions: workspace.entityVersions,
    syncMeta: workspace.syncMeta,
  };
}

function hydrateWorkspaceFromSql(stored: SqlStoredWorkspace): LocalSeasonWorkspace {
  const pendingOps = stored.pendingOps.map(hydratePendingOp);
  const current = applyPendingOpsToStoredSeasonData({
    season: stored.season,
    rows: stored.rows,
    records: stored.records,
    modificationEntries: stored.modificationEntries,
    modHistory: stored.modHistory,
    baseRows: stored.baseRows,
    baseRecords: stored.baseRecords,
    baseModificationEntries: stored.baseModificationEntries,
    baseModHistory: stored.baseModHistory,
  }, pendingOps);
  const baseRows = (stored.baseRows ?? stored.rows).map((row) => hydrateSourceRowFromPersistence(row));
  const baseRecords = (stored.baseRecords ?? stored.records).map((record) => hydrateFlightRecordFromPersistence(record));
  const baseModificationEntries = (stored.baseModificationEntries ?? stored.modificationEntries).map(([legId, mod]) => [legId, hydrateFlightModificationFromPersistence(mod)] as [string, FlightModification]);
  const baseModHistory = (stored.baseModHistory ?? stored.modHistory).map((entry) => hydrateModHistoryEntryFromPersistence(entry));

  return createLocalWorkspace({
    season: stored.season,
    rows: current.rows,
    records: current.records,
    modifications: current.modifications,
    modHistory: current.modHistory,
    baseRows,
    baseRecords,
    baseModificationEntries,
    baseModHistory,
    pendingOps,
    derivedSeasonal: stored.derivedSeasonal,
    entityVersions: stored.entityVersions,
    syncMeta: stored.syncMeta,
  });
}

async function ensureSqlSeededFromIndexedDb(sqlDb: LocalSeasonSqlDatabase): Promise<void> {
  if (!canUseIndexedDb()) {
    await setLocalSeasonSqlKv(sqlDb, INDEXEDDB_SQL_RESET_KEY, true);
    return;
  }
  if (await getLocalSeasonSqlKv(sqlDb, INDEXEDDB_SQL_RESET_KEY, false)) return;
  if (!sqlMigrationPromise) {
    sqlMigrationPromise = (async () => {
      const seasonIds = await listIndexedDbLocalSeasonWorkspaceIds();
      for (const seasonId of seasonIds) {
        const workspace = await loadIndexedDbLocalSeasonWorkspace(seasonId);
        if (!workspace) continue;
        const serialized = serializeWorkspaceForSql(workspace);
        await saveLocalSeasonIndexedDbBackup(sqlDb, seasonId, serialized);
        await saveLocalSeasonSqlWorkspace(sqlDb, serialized);
      }
      await setLocalSeasonSqlKv(sqlDb, INDEXEDDB_SQL_RESET_KEY, true);
      databaseResetInProgress = true;
      try {
        await closeLocalSeasonDb();
        await deleteDB(DB_NAME);
      } finally {
        databaseResetInProgress = false;
      }
    })().finally(() => {
      sqlMigrationPromise = null;
    });
  }
  await sqlMigrationPromise;
}

async function getSqlDbForLocalStore(): Promise<LocalSeasonSqlDatabase | null> {
  const sqlDb = await getLocalSeasonSqlDatabase();
  if (!sqlDb) return null;
  await ensureSqlSeededFromIndexedDb(sqlDb);
  return sqlDb;
}

export async function saveLocalSeasonWorkspace(
  workspace: LocalSeasonWorkspace,
  options: SaveLocalSeasonWorkspaceOptions = {}
): Promise<void> {
  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) {
    if (isNativeLocalRuntime() && !isNativeFullWorkspaceSaveAllowed(options)) {
      throw new Error(
        'Native desktop full-workspace saves are disabled. Use native row-level commands, or pass an explicit import/repair reason.'
      );
    }
    await saveLocalSeasonSqlWorkspace(sqlDb, serializeWorkspaceForSql(workspace));
    memoryWorkspaces.set(workspace.season.id, workspace);
    return;
  }
  await saveIndexedDbLocalSeasonWorkspace(workspace);
}

async function saveIndexedDbLocalSeasonWorkspace(workspace: LocalSeasonWorkspace): Promise<void> {
  if (!canUseIndexedDb()) {
    memoryWorkspaces.set(workspace.season.id, workspace);
    return;
  }

  const db = await getDb();
  const seasonId = workspace.season.id;
  const tx = db.transaction(['seasonData', 'pendingOps', 'derivedSeasonal', 'syncMeta', 'entityVersions'], 'readwrite');
  await Promise.all([
    tx.objectStore('seasonData').put({
      seasonId,
      season: workspace.season,
      rows: workspace.rows.map(serializeSourceRowForPersistence) as unknown as ParsedRow[],
      records: workspace.records.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
      modificationEntries: serializeModificationMap(workspace.modifications),
      modHistory: workspace.modHistory.map(serializeModHistoryEntryForPersistence),
      baseRows: workspace.baseRows.map(serializeSourceRowForPersistence) as unknown as ParsedRow[],
      baseRecords: workspace.baseRecords.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
      baseModificationEntries: serializeModificationMap(deserializeModificationEntries(workspace.baseModificationEntries)),
      baseModHistory: workspace.baseModHistory.map(serializeModHistoryEntryForPersistence),
    }, seasonId),
    tx.objectStore('pendingOps').put({ seasonId, ops: workspace.pendingOps.map(serializePendingOp) }, seasonId),
    tx.objectStore('derivedSeasonal').put({ seasonId, cache: workspace.derivedSeasonal }, seasonId),
    tx.objectStore('syncMeta').put(workspace.syncMeta, seasonId),
    tx.objectStore('entityVersions').put({ seasonId, versions: workspace.entityVersions }, seasonId),
    tx.done,
  ]);
}

export async function clearAllLocalSeasonWorkspaces(): Promise<void> {
  memoryWorkspaces.clear();
  const sqlDb = await getLocalSeasonSqlDatabase();
  if (sqlDb) {
    await clearLocalSeasonSqlWorkspaces(sqlDb);
    await setLocalSeasonSqlKv(sqlDb, INDEXEDDB_SQL_RESET_KEY, true);
  }
  if (!canUseIndexedDb()) return;

  databaseResetInProgress = true;
  try {
    await closeLocalSeasonDb();
    await deleteDB(DB_NAME);
  } finally {
    databaseResetInProgress = false;
  }
}

async function listLocalSeasonWorkspaceIds(): Promise<string[]> {
  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) return listLocalSeasonSqlWorkspaceIds(sqlDb);
  return listIndexedDbLocalSeasonWorkspaceIds();
}

async function listIndexedDbLocalSeasonWorkspaceIds(): Promise<string[]> {
  if (!canUseIndexedDb()) return Array.from(memoryWorkspaces.keys());
  const db = await getDb();
  const keys = await db.getAllKeys('seasonData');
  return keys.map((key) => String(key));
}

export async function discardLocalPendingChanges(seasonId: string): Promise<LocalSeasonWorkspace | null> {
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) return null;

  const conflictCount = workspace.syncMeta.conflicts?.length ?? 0;
  const next: LocalSeasonWorkspace = {
    ...workspace,
    rows: cloneJson(workspace.baseRows),
    records: cloneJson(workspace.baseRecords),
    modifications: deserializeModificationEntries(workspace.baseModificationEntries),
    modHistory: cloneJson(workspace.baseModHistory),
    pendingOps: [],
    derivedSeasonal: null,
    syncMeta: {
      ...workspace.syncMeta,
      localRevision: workspace.syncMeta.localRevision + 1,
      pendingCount: 0,
      lastLocalChangeAt: null,
      syncStatus: conflictCount > 0 ? 'needs_review' : 'synced',
    },
  };
  await saveLocalSeasonWorkspace(next, { nativeFullSaveReason: 'session-discard' });
  return next;
}

export async function discardAllLocalPendingChanges(): Promise<{ seasonIds: string[]; discardedCount: number }> {
  const seasonIds = await listLocalSeasonWorkspaceIds();
  const discardedSeasonIds: string[] = [];
  let discardedCount = 0;

  for (const seasonId of seasonIds) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) continue;
    const pendingCount = workspace.pendingOps.length || workspace.syncMeta.pendingCount || 0;
    const hasLocalEdits = pendingCount > 0 || workspace.syncMeta.lastLocalChangeAt != null;
    if (!hasLocalEdits) continue;
    const discarded = await discardLocalPendingChanges(seasonId);
    if (!discarded) continue;
    discardedSeasonIds.push(seasonId);
    discardedCount += pendingCount;
  }

  return { seasonIds: discardedSeasonIds, discardedCount };
}

export async function loadLocalSeasonWorkspace(seasonId: string): Promise<LocalSeasonWorkspace | null> {
  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) {
    const stored = await loadLocalSeasonSqlWorkspace(sqlDb, seasonId);
    return stored ? hydrateWorkspaceFromSql(stored) : null;
  }
  return loadIndexedDbLocalSeasonWorkspace(seasonId);
}

async function loadIndexedDbLocalSeasonWorkspace(seasonId: string): Promise<LocalSeasonWorkspace | null> {
  if (!canUseIndexedDb()) return memoryWorkspaces.get(seasonId) ?? null;

  const db = await getDb();
  const [data, pending, derived, meta, entityVersions] = await Promise.all([
    db.get('seasonData', seasonId),
    db.get('pendingOps', seasonId),
    db.get('derivedSeasonal', seasonId),
    db.get('syncMeta', seasonId),
    db.get('entityVersions', seasonId),
  ]);
  if (!data) return null;

  const pendingOps = (pending?.ops ?? []).map(hydratePendingOp);
  const current = applyPendingOpsToStoredSeasonData(data, pendingOps);
  const baseRows = (data.baseRows ?? data.rows).map((row) => hydrateSourceRowFromPersistence(row));
  const baseRecords = (data.baseRecords ?? data.records).map((record) => hydrateFlightRecordFromPersistence(record));
  const baseModificationEntries = (data.baseModificationEntries ?? data.modificationEntries).map(([legId, mod]) => [legId, hydrateFlightModificationFromPersistence(mod)] as [string, FlightModification]);
  const baseModHistory = (data.baseModHistory ?? data.modHistory).map((entry) => hydrateModHistoryEntryFromPersistence(entry));

  return createLocalWorkspace({
    season: data.season,
    rows: current.rows,
    records: current.records,
    modifications: current.modifications,
    modHistory: current.modHistory,
    baseRows,
    baseRecords,
    baseModificationEntries,
    baseModHistory,
    pendingOps,
    derivedSeasonal: derived?.cache ?? null,
    entityVersions: entityVersions?.versions ?? {},
    syncMeta: meta ?? buildInitialSyncMeta(data.season),
  });
}

export async function applyLocalModificationBatchDelta(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description'>
): Promise<LocalSyncMeta> {
  if (mods.length === 0) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
    return workspace.syncMeta;
  }

  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) {
    const changedAt = Date.now();
    const affectedLegIds = new Set(mods.map((mod) => mod.legId));
    const state = await readLocalSeasonSqlDeltaState(sqlDb, seasonId, affectedLegIds);
    if (!state) throw new Error(`Local season workspace ${seasonId} not found`);

    const pendingOps = state.pendingOps.map(hydratePendingOp);
    const affectedModifications = deserializeModificationEntries(state.modificationEntries);
    const affectedBaseMods = deserializeModificationEntries(state.baseModificationEntries);
    const baseRecordsById = new Map(
      state.baseRecords.map((record) => [record.id, hydrateFlightRecordFromPersistence(record)])
    );

    for (const op of pendingOps) {
      if (op.type === 'modification' && affectedLegIds.has(op.mod.legId)) affectedModifications.set(op.mod.legId, op.mod);
      if (op.type === 'modificationDelete' && affectedLegIds.has(op.legId)) affectedModifications.delete(op.legId);
    }

    const retainedBusinessOps: LocalPendingOp[] = [];
    const retainedHistoryOps: LocalPendingOp[] = [];
    for (const op of pendingOps) {
      if (op.type === 'modHistory') {
        retainedHistoryOps.push(op);
      } else if (op.type === 'modification') {
        if (!affectedLegIds.has(op.mod.legId)) retainedBusinessOps.push(op);
      } else if (op.type === 'modificationDelete') {
        if (!affectedLegIds.has(op.legId)) retainedBusinessOps.push(op);
      } else {
        retainedBusinessOps.push(op);
      }
    }

    const nextModificationOps: LocalPendingOp[] = [];
    const historyChanges: ModHistoryEntry['changes'] = [];
    for (const mod of mods) {
      const previousMod = affectedModifications.get(mod.legId) ?? null;
      const nextMod: FlightModification = {
        ...(previousMod ?? {}),
        ...mod,
        legId: mod.legId,
        action: mod.action,
      };
      historyChanges.push({
        legId: mod.legId,
        previousMod,
        newMod: nextMod,
      });

      const baseMod = affectedBaseMods.get(mod.legId);
      if (!baseMod && isNoOpModificationAgainstBaseRecord(nextMod, baseRecordsById.get(mod.legId))) {
        affectedModifications.delete(mod.legId);
        continue;
      }
      affectedModifications.set(mod.legId, nextMod);
      if (!baseMod || !isSameValue(nextMod, baseMod)) {
        nextModificationOps.push({ type: 'modification', mod: nextMod });
      }
    }

    const nextHistoryOps: LocalPendingOp[] = history
      ? [{
          type: 'modHistory',
          entry: {
            id: history.id,
            timestamp: history.timestamp,
            description: history.description,
            changes: historyChanges,
          },
        }, ...retainedHistoryOps]
      : retainedHistoryOps;
    const businessOps = mergePendingOps([...retainedBusinessOps, ...nextModificationOps]);
    const nextPendingOps = businessOps.some((op) => op.type !== 'modHistory')
      ? mergePendingOps([...businessOps, ...nextHistoryOps])
      : businessOps;
    const nextSyncMeta = buildNextSyncMeta(state.syncMeta, state.season, nextPendingOps.length, changedAt);
    await replaceLocalSeasonSqlPendingState(
      sqlDb,
      seasonId,
      nextPendingOps.map(serializePendingOp),
      nextSyncMeta
    );
    return nextSyncMeta;
  }

  if (!canUseIndexedDb()) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
    const historyEntry: ModHistoryEntry | undefined = history
      ? {
          id: history.id,
          timestamp: history.timestamp,
          description: history.description,
          changes: mods.map((mod) => {
            const previousMod = workspace.modifications.get(mod.legId) ?? null;
            return {
              legId: mod.legId,
              previousMod,
              newMod: {
                ...(previousMod ?? {}),
                ...mod,
                legId: mod.legId,
                action: mod.action,
              },
            };
          }),
        }
      : undefined;
    const next = await applyLocalModificationBatch(seasonId, mods, historyEntry);
    return next.syncMeta;
  }

  const db = await getDb();
  const [data, pending, meta] = await Promise.all([
    db.get('seasonData', seasonId),
    db.get('pendingOps', seasonId),
    db.get('syncMeta', seasonId),
  ]);
  if (!data) throw new Error(`Local season workspace ${seasonId} not found`);

  const changedAt = Date.now();
  const pendingOps = (pending?.ops ?? []).map(hydratePendingOp);
  const affectedLegIds = new Set(mods.map((mod) => mod.legId));
  const affectedModifications = pickHydratedModificationsById(data.modificationEntries, affectedLegIds);
  const affectedBaseMods = pickHydratedModificationsById(data.baseModificationEntries ?? data.modificationEntries, affectedLegIds);
  const baseRecordsById = pickHydratedRecordsById(data.baseRecords ?? data.records, affectedLegIds);

  for (const op of pendingOps) {
    if (op.type === 'modification' && affectedLegIds.has(op.mod.legId)) affectedModifications.set(op.mod.legId, op.mod);
    if (op.type === 'modificationDelete' && affectedLegIds.has(op.legId)) affectedModifications.delete(op.legId);
  }

  const retainedBusinessOps: LocalPendingOp[] = [];
  const retainedHistoryOps: LocalPendingOp[] = [];
  for (const op of pendingOps) {
    if (op.type === 'modHistory') {
      retainedHistoryOps.push(op);
    } else if (op.type === 'modification') {
      if (!affectedLegIds.has(op.mod.legId)) retainedBusinessOps.push(op);
    } else if (op.type === 'modificationDelete') {
      if (!affectedLegIds.has(op.legId)) retainedBusinessOps.push(op);
    } else {
      retainedBusinessOps.push(op);
    }
  }

  const nextModificationOps: LocalPendingOp[] = [];
  const historyChanges: ModHistoryEntry['changes'] = [];
  for (const mod of mods) {
    const previousMod = affectedModifications.get(mod.legId) ?? null;
    const nextMod: FlightModification = {
      ...(previousMod ?? {}),
      ...mod,
      legId: mod.legId,
      action: mod.action,
    };
    historyChanges.push({
      legId: mod.legId,
      previousMod,
      newMod: nextMod,
    });

    const baseMod = affectedBaseMods.get(mod.legId);
    if (!baseMod && isNoOpModificationAgainstBaseRecord(nextMod, baseRecordsById.get(mod.legId))) {
      affectedModifications.delete(mod.legId);
      continue;
    }
    affectedModifications.set(mod.legId, nextMod);
    if (!baseMod || !isSameValue(nextMod, baseMod)) {
      nextModificationOps.push({ type: 'modification', mod: nextMod });
    }
  }

  const nextHistoryOps: LocalPendingOp[] = history
    ? [{
        type: 'modHistory',
        entry: {
          id: history.id,
          timestamp: history.timestamp,
          description: history.description,
          changes: historyChanges,
        },
      }, ...retainedHistoryOps]
    : retainedHistoryOps;
  const businessOps = mergePendingOps([...retainedBusinessOps, ...nextModificationOps]);
  const nextPendingOps = businessOps.some((op) => op.type !== 'modHistory')
    ? mergePendingOps([...businessOps, ...nextHistoryOps])
    : businessOps;
  const nextSyncMeta = buildNextSyncMeta(meta ?? undefined, data.season, nextPendingOps.length, changedAt);
  const tx = db.transaction(['pendingOps', 'derivedSeasonal', 'syncMeta'], 'readwrite');
  await Promise.all([
    tx.objectStore('pendingOps').put({ seasonId, ops: nextPendingOps.map(serializePendingOp) }, seasonId),
    tx.objectStore('derivedSeasonal').put({ seasonId, cache: null }, seasonId),
    tx.objectStore('syncMeta').put(nextSyncMeta, seasonId),
    tx.done,
  ]);
  return nextSyncMeta;
}

export async function applyLocalFlightRecordMutation(
  seasonId: string,
  result: { records: FlightRecord[]; updatedRecords?: FlightRecord[] },
  historyEntry?: ModHistoryEntry
): Promise<LocalSeasonWorkspace> {
  const changedRecords = result.updatedRecords ?? result.records;
  const nativeSyncMeta = await runNativeScheduleMutation(
    seasonId,
    changedRecords,
    [],
    [],
    historyEntry
      ? {
          id: historyEntry.id,
          timestamp: historyEntry.timestamp,
          description: historyEntry.description,
        }
      : undefined
  );
  if (nativeSyncMeta) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found after native schedule mutation`);
    return { ...workspace, syncMeta: nativeSyncMeta };
  }
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
  const modHistory = historyEntry ? [historyEntry, ...workspace.modHistory] : workspace.modHistory;
  const changedRecordsById = new Map(changedRecords.map((record) => [record.id, record]));
  const nextRecords = workspace.records.map((record) => changedRecordsById.get(record.id) ?? record);
  const existingRecordIds = new Set(workspace.records.map((record) => record.id));
  for (const record of changedRecords) {
    if (!existingRecordIds.has(record.id)) nextRecords.push(record);
  }
  const next = withPendingOps({ ...workspace, records: nextRecords, modHistory });
  await saveLocalSeasonWorkspace(next);
  return next;
}

export async function applyLocalModificationBatch(
  seasonId: string,
  mods: FlightModification[],
  historyEntry?: ModHistoryEntry
): Promise<LocalSeasonWorkspace> {
  const nativeSyncMeta = await runNativeLocalModificationBatchDelta(
    seasonId,
    mods,
    historyEntry
      ? {
          id: historyEntry.id,
          timestamp: historyEntry.timestamp,
          description: historyEntry.description,
        }
      : undefined
  );
  if (nativeSyncMeta) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found after native modification mutation`);
    return { ...workspace, syncMeta: nativeSyncMeta };
  }
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
  const modifications = new Map(workspace.modifications);
  for (const mod of mods) modifications.set(mod.legId, mod);
  const modHistory = historyEntry ? [historyEntry, ...workspace.modHistory] : workspace.modHistory;
  const next = withPendingOps({ ...workspace, modifications, modHistory });
  await saveLocalSeasonWorkspace(next);
  return next;
}

export async function applyLocalSourceRows(
  seasonId: string,
  rows: ParsedRow[],
  records: FlightRecord[],
  historyEntry?: ModHistoryEntry
): Promise<LocalSeasonWorkspace> {
  const nativeSyncMeta = await runNativeScheduleMutation(
    seasonId,
    records,
    [],
    [],
    historyEntry
      ? {
          id: historyEntry.id,
          timestamp: historyEntry.timestamp,
          description: historyEntry.description,
        }
      : undefined,
    rows
  );
  if (nativeSyncMeta) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found after native source-row mutation`);
    return { ...workspace, syncMeta: nativeSyncMeta };
  }
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
  const nextRows = [...workspace.rows, ...rows];
  const nextRecords = [...workspace.records, ...records];
  const modHistory = historyEntry ? [historyEntry, ...workspace.modHistory] : workspace.modHistory;
  const next = withPendingOps({ ...workspace, rows: nextRows, records: nextRecords, modHistory });
  await saveLocalSeasonWorkspace(next);
  return next;
}

export async function getPendingSyncSummary(
  seasonId: string
): Promise<{
  pendingCount: number;
  conflictCount: number;
  syncStatus: LocalSyncMeta['syncStatus'];
  lastLocalChangeAt: number | null;
}> {
  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) {
    const meta = await readLocalSeasonSqlSyncMeta(sqlDb, seasonId);
    if (meta) {
      const conflictCount = meta.conflicts?.length ?? 0;
      return {
        pendingCount: meta.pendingCount,
        conflictCount,
        syncStatus: conflictCount > 0 ? 'needs_review' : meta.syncStatus,
        lastLocalChangeAt: meta.lastLocalChangeAt,
      };
    }
  }
  if (canUseIndexedDb()) {
    const db = await getDb();
    const meta = await db.get('syncMeta', seasonId);
    if (meta) {
      const conflictCount = meta.conflicts?.length ?? 0;
      return {
        pendingCount: meta.pendingCount,
        conflictCount,
        syncStatus: conflictCount > 0 ? 'needs_review' : meta.syncStatus,
        lastLocalChangeAt: meta.lastLocalChangeAt,
      };
    }
  }
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  const conflictCount = workspace?.syncMeta.conflicts?.length ?? 0;
  return {
    pendingCount: workspace?.syncMeta.pendingCount ?? 0,
    conflictCount,
    syncStatus: conflictCount > 0 ? 'needs_review' : workspace?.syncMeta.syncStatus ?? 'synced',
    lastLocalChangeAt: workspace?.syncMeta.lastLocalChangeAt ?? null,
  };
}

export async function updateLocalSyncMeta(seasonId: string, syncMeta: LocalSyncMeta): Promise<LocalSeasonWorkspace | null> {
  const sqlDb = await getSqlDbForLocalStore();
  if (sqlDb) {
    await setLocalSeasonSqlSyncMeta(sqlDb, seasonId, syncMeta);
    const cached = memoryWorkspaces.get(seasonId);
    if (!cached) return null;
    const next = { ...cached, syncMeta };
    memoryWorkspaces.set(seasonId, next);
    return next;
  }

  if (canUseIndexedDb()) {
    const db = await getDb();
    await db.put('syncMeta', syncMeta, seasonId);
    return null;
  }

  const workspace = memoryWorkspaces.get(seasonId);
  if (!workspace) return null;
  const next = { ...workspace, syncMeta };
  memoryWorkspaces.set(seasonId, next);
  return next;
}
