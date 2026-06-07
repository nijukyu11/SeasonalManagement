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
  discardLocalSeasonSqlPendingChanges,
  getLocalSeasonSqlDatabase,
  listLocalSeasonSqlPendingSummaries,
  loadLocalSeasonSqlWorkspace,
  readLocalSeasonSqlDeltaState,
  readLocalSeasonSqlSyncMeta,
  replaceLocalSeasonSqlPendingState,
  saveLocalSeasonSqlWorkspace,
  setLocalSeasonSqlSyncMeta,
  type LocalSeasonSqlDatabase,
  type SqlStoredWorkspace,
} from './localSeasonSqlStore';
import { runNativeLocalModificationBatchDelta, runNativeScheduleMutation } from './nativeLocalSeasonStore';
import { isTauriRuntime } from './nativeRuntime';

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

export type NativeFullWorkspaceSaveReason =
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
    if (op.type === 'flightRecord') {
      const record = op.record as FlightRecord;
      recordsById.set(record.id, record);
    } else if (op.type === 'modification') {
      modifications.set(op.mod.legId, op.mod);
    } else if (op.type === 'modificationDelete') {
      modifications.delete(op.legId);
    } else if (op.type === 'modHistory' && !modHistoryIds.has(op.entry.id)) {
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
  const mergedPending = mergePendingOps(pendingOps.filter((op) => op.type !== 'sourceRow'));
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
    rows: [],
    records: workspace.records.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
    modificationEntries: serializeModificationMap(workspace.modifications),
    modHistory: workspace.modHistory.map(serializeModHistoryEntryForPersistence),
    baseRows: [],
    baseRecords: workspace.baseRecords.map(serializeFlightRecordForPersistence) as unknown as FlightRecord[],
    baseModificationEntries: serializeModificationMap(deserializeModificationEntries(workspace.baseModificationEntries)),
    baseModHistory: workspace.baseModHistory.map(serializeModHistoryEntryForPersistence),
    pendingOps: workspace.pendingOps.filter((op) => op.type !== 'sourceRow').map(serializePendingOp),
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
  const baseRows: ParsedRow[] = [];
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

const memoryLocalSeasonWorkspaces = new Map<string, LocalSeasonWorkspace>();

function isLocalSeasonSqlUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('SQL local season store is unavailable');
}

function cloneMemoryWorkspace(workspace: LocalSeasonWorkspace): LocalSeasonWorkspace {
  return createLocalWorkspace({
    season: cloneJson(workspace.season),
    rows: cloneJson(workspace.rows),
    records: cloneJson(workspace.records),
    modifications: deserializeModificationEntries(serializeModificationMap(workspace.modifications)),
    modHistory: cloneJson(workspace.modHistory),
    baseRows: cloneJson(workspace.baseRows),
    baseRecords: cloneJson(workspace.baseRecords),
    baseModificationEntries: cloneJson(workspace.baseModificationEntries),
    baseModHistory: cloneJson(workspace.baseModHistory),
    pendingOps: cloneJson(workspace.pendingOps),
    derivedSeasonal: cloneJson(workspace.derivedSeasonal),
    entityVersions: cloneJson(workspace.entityVersions),
    syncMeta: cloneJson(workspace.syncMeta),
  });
}

async function getSqlDbForLocalStore(): Promise<LocalSeasonSqlDatabase> {
  return getLocalSeasonSqlDatabase();
}

async function getOptionalSqlDbForLocalStore(): Promise<LocalSeasonSqlDatabase | null> {
  try {
    return await getSqlDbForLocalStore();
  } catch (error) {
    if (isLocalSeasonSqlUnavailable(error)) return null;
    throw error;
  }
}

export async function saveLocalSeasonWorkspace(
  workspace: LocalSeasonWorkspace,
  options: SaveLocalSeasonWorkspaceOptions = {}
): Promise<void> {
  const sqlDb = await getOptionalSqlDbForLocalStore();
  if (!sqlDb) {
    memoryLocalSeasonWorkspaces.set(workspace.season.id, cloneMemoryWorkspace(workspace));
    return;
  }
  if (isNativeLocalRuntime() && !isNativeFullWorkspaceSaveAllowed(options)) {
    throw new Error(
      'Native desktop full-workspace saves are disabled. Use native row-level commands, or pass an explicit import/repair reason.'
    );
  }
  await saveLocalSeasonSqlWorkspace(sqlDb, serializeWorkspaceForSql(workspace), {
    writeLabel: options.nativeFullSaveReason ?? 'workspace-save',
  });
}

export async function clearAllLocalSeasonWorkspaces(): Promise<void> {
  const sqlDb = await getOptionalSqlDbForLocalStore();
  if (!sqlDb) {
    memoryLocalSeasonWorkspaces.clear();
    return;
  }
  await clearLocalSeasonSqlWorkspaces(sqlDb);
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
  const sqlDb = await getOptionalSqlDbForLocalStore();
  const discardedSeasonIds: string[] = [];
  let discardedCount = 0;
  if (!sqlDb) {
    for (const [seasonId, stored] of Array.from(memoryLocalSeasonWorkspaces.entries())) {
      const workspace = cloneMemoryWorkspace(stored);
      if (workspace.syncMeta.pendingCount <= 0 && (workspace.syncMeta.conflicts?.length ?? 0) <= 0) continue;
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
          pendingCount: 0,
          lastLocalChangeAt: null,
          syncStatus: 'synced',
        },
      };
      memoryLocalSeasonWorkspaces.set(seasonId, cloneMemoryWorkspace(next));
      discardedSeasonIds.push(seasonId);
      discardedCount += 1;
    }
    return { seasonIds: discardedSeasonIds, discardedCount };
  }
  const summaries = await listLocalSeasonSqlPendingSummaries(sqlDb);

  for (const summary of summaries) {
    const hasLocalEdits = summary.pendingCount > 0 || summary.lastLocalChangeAt != null;
    if (!hasLocalEdits) continue;
    const discarded = await discardLocalSeasonSqlPendingChanges(sqlDb, summary.seasonId);
    if (!discarded) continue;
    discardedSeasonIds.push(summary.seasonId);
    discardedCount += summary.pendingCount || discarded.discardedCount;
  }

  return { seasonIds: discardedSeasonIds, discardedCount };
}

export async function loadLocalSeasonWorkspace(seasonId: string): Promise<LocalSeasonWorkspace | null> {
  const sqlDb = await getOptionalSqlDbForLocalStore();
  if (!sqlDb) {
    const workspace = memoryLocalSeasonWorkspaces.get(seasonId);
    return workspace ? cloneMemoryWorkspace(workspace) : null;
  }
  const stored = await loadLocalSeasonSqlWorkspace(sqlDb, seasonId);
  return stored ? hydrateWorkspaceFromSql(stored) : null;
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
  void rows;
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
      : undefined
  );
  if (nativeSyncMeta) {
    const workspace = await loadLocalSeasonWorkspace(seasonId);
    if (!workspace) throw new Error(`Local season workspace ${seasonId} not found after native source-row mutation`);
    return { ...workspace, syncMeta: nativeSyncMeta };
  }
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
  const nextRecords = [...workspace.records, ...records];
  const modHistory = historyEntry ? [historyEntry, ...workspace.modHistory] : workspace.modHistory;
  const next = withPendingOps({ ...workspace, records: nextRecords, modHistory });
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
  const sqlDb = await getOptionalSqlDbForLocalStore();
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
  const sqlDb = await getOptionalSqlDbForLocalStore();
  if (!sqlDb) {
    const workspace = memoryLocalSeasonWorkspaces.get(seasonId);
    if (!workspace) return null;
    memoryLocalSeasonWorkspaces.set(seasonId, cloneMemoryWorkspace({ ...workspace, syncMeta }));
    return loadLocalSeasonWorkspace(seasonId);
  }
  await setLocalSeasonSqlSyncMeta(sqlDb, seasonId, syncMeta);
  return loadLocalSeasonWorkspace(seasonId);
}
