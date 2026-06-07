import type {
  FlightModification,
  FlightRecord,
  ModHistoryEntry,
  OperationalSettings,
  ParsedRow,
  Season,
} from './types';
import type { AuditDeltaChunk, AuditLogEntry, AuditSession } from './auditLog';
import type { SourceRowOperationPlan } from './sourceRowPatterns';
import type { LocalEntityVersionMap, LocalPendingOp } from './localSeasonStore';
import type { SeasonChangeEvent } from './seasonChangeEvents';
import { isSupabaseConfigured } from './supabase';
import { getCachedOperationalSettings, setCachedOperationalSettings } from './seasonDataCache';
import { isTauriRuntime } from './nativeRuntime';

export interface RemoteActor {
  uid?: string | null;
  email?: string | null;
  displayName?: string | null;
  isAnonymous?: boolean | null;
}

export interface RemoteSyncWorkspaceInput {
  seasonId: string;
  baseServerVersion: number;
  pendingOps: LocalPendingOp[];
  onProgress?: (label: string, written: number, total: number) => void;
}

export interface RemoteSyncWorkspaceResult {
  nextServerVersion: number;
}

export interface RemoteSyncWorkspaceV2Input {
  seasonId: string;
  clientId: string;
  baseServerSeq: number;
  pendingEvents: SeasonChangeEvent[];
  onProgress?: (label: string, written: number, total: number) => void;
}

export interface RemoteSyncWorkspaceV2Result {
  appliedEvents: SeasonChangeEvent[];
  conflictEvents: SeasonChangeEvent[];
  nextServerSeq: number;
  serverHighWater: number;
  nextServerVersion: number;
}

export interface RemoteScheduleNotificationFlushInput {
  seasonId?: string;
  limit?: number;
}

export interface RemoteScheduleNotificationFlushResult {
  sent: number;
  failed: number;
  skipped: number;
  deliveryIds: string[];
}

export interface RemoteSeasonImportCounts {
  sourceRows: number;
  flightRecords: number;
}

export interface RemoteDashboardSeasonData {
  sourceRows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
}

export interface RemoteSeasonSyncCursorState {
  serverHighWater: number;
  entityVersions: LocalEntityVersionMap;
}

export interface RemoteSeasonWorkspaceSnapshot extends RemoteDashboardSeasonData {
  season: Season;
  modHistory: ModHistoryEntry[];
  cursor: {
    serverHighWater: number;
  };
  entityVersions: LocalEntityVersionMap;
}

export interface RemoteSeasonEventPage {
  events: SeasonChangeEvent[];
  nextCursor: number;
  hasMore: boolean;
  serverHighWater: number;
}

export interface RemoteStore {
  getSeasons(): Promise<Season[]>;
  getSeason(id: string): Promise<Season | null>;
  findSeasonByCode(code: string): Promise<Season | null>;
  createSeason(season: Omit<Season, 'id'>): Promise<string>;
  updateSeason(id: string, data: Partial<Season>): Promise<void>;
  deleteSeason(id: string): Promise<void>;
  getOperationalSettings(): Promise<OperationalSettings>;
  saveOperationalSettings(settings: OperationalSettings): Promise<void>;
  saveAuditLogEntry(session: AuditSession, entry: AuditLogEntry): Promise<void>;
  getAuditSessions(maxSessions?: number): Promise<AuditSession[]>;
  getAuditLogEntries(sessionId: string, maxEntries?: number): Promise<AuditLogEntry[]>;
  getAuditDeltaChunks(sessionId: string, entryId: string): Promise<AuditDeltaChunk[]>;
  clearFlightRecords(seasonId: string): Promise<void>;
  clearSourceRows(seasonId: string): Promise<void>;
  clearModifications(seasonId: string): Promise<void>;
  clearModHistory(seasonId: string): Promise<void>;
  clearSeasonBaseline(seasonId: string): Promise<void>;
  batchWriteSourceRows(seasonId: string, rows: ParsedRow[], onProgress?: (written: number, total: number) => void): Promise<void>;
  getSourceRows(seasonId: string): Promise<ParsedRow[]>;
  batchWriteFlightRecords(seasonId: string, records: FlightRecord[], onProgress?: (written: number, total: number) => void): Promise<void>;
  verifySeasonImportCounts?(seasonId: string, expected: RemoteSeasonImportCounts): Promise<RemoteSeasonImportCounts>;
  getFlightRecords(seasonId: string): Promise<FlightRecord[]>;
  getDashboardSeasonData?(seasonId: string): Promise<RemoteDashboardSeasonData>;
  getSeasonWorkspaceSnapshot?(
    seasonId: string,
    options?: { modHistoryLimit?: number; transport?: 'auto' | 'rpc' | 'paged' }
  ): Promise<RemoteSeasonWorkspaceSnapshot | null>;
  addSourceRow(seasonId: string, row: Omit<ParsedRow, 'rowIndex'>): Promise<ParsedRow>;
  deleteSourceRow(seasonId: string, rowIndex: number, linkedRowIndex?: number): Promise<void>;
  linkSourceRows(seasonId: string, rowIndexA: number, rowIndexB: number, linkType?: 'overnight' | 'sameday'): Promise<void>;
  mergeSameDaySourceRows(seasonId: string, rowIndexA: number, rowIndexB: number): Promise<void>;
  unlinkSourceRows(seasonId: string, rowIndexA: number, rowIndexB: number): Promise<void>;
  splitSourceRowTurnaround(seasonId: string, rowIndex: number): Promise<number>;
  applySourceRowOperationPlan(seasonId: string, plan: SourceRowOperationPlan): Promise<void>;
  getModifications(seasonId: string): Promise<Map<string, FlightModification>>;
  saveModification(seasonId: string, legId: string, mod: FlightModification): Promise<void>;
  saveModifications(seasonId: string, mods: FlightModification[]): Promise<void>;
  removeModification(seasonId: string, legId: string): Promise<void>;
  deleteModifications(seasonId: string, legIds: string[]): Promise<void>;
  saveModificationsWithHistory(
    seasonId: string,
    mods: FlightModification[],
    currentMods: Map<string, FlightModification>,
    description: string
  ): Promise<void>;
  saveModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void>;
  getModHistory(seasonId: string, limit?: number): Promise<ModHistoryEntry[]>;
  undoModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void>;
  syncSeasonWorkspaceRemote(input: RemoteSyncWorkspaceInput): Promise<RemoteSyncWorkspaceResult>;
  syncSeasonWorkspaceRemoteV2?(input: RemoteSyncWorkspaceV2Input): Promise<RemoteSyncWorkspaceV2Result>;
  flushScheduleNotifications?(input?: RemoteScheduleNotificationFlushInput): Promise<RemoteScheduleNotificationFlushResult>;
  getSeasonEventHighWater?(seasonId: string): Promise<number>;
  getSeasonEntityVersions?(seasonId: string): Promise<LocalEntityVersionMap>;
  getSeasonSyncCursorState?(seasonId: string): Promise<RemoteSeasonSyncCursorState>;
  loadSeasonEventPage?(seasonId: string, serverSeq: number, options: { throughSeq: number; limit?: number }): Promise<RemoteSeasonEventPage>;
  loadSeasonEventsSince?(seasonId: string, serverSeq: number, options?: { throughSeq?: number }): Promise<SeasonChangeEvent[]>;
  subscribeToSeasonEvents?(seasonId: string, onEvent: (event: SeasonChangeEvent) => void): Promise<() => void> | (() => void);
  getCurrentRemoteActor(): Promise<RemoteActor | null>;
}

let cachedStore: Promise<RemoteStore> | null = null;

function shouldUseSupabase(): boolean {
  const backend = process.env.NEXT_PUBLIC_REMOTE_BACKEND?.toLowerCase();
  return backend === 'supabase' && isSupabaseConfigured();
}

async function getFirestoreStore(): Promise<RemoteStore> {
  if (isTauriRuntime()) {
    throw new Error('Native desktop runtime requires NEXT_PUBLIC_REMOTE_BACKEND=supabase; Firestore sync paths are disabled.');
  }
  const firestoreStore = await import('./firestore');
  return {
    ...firestoreStore,
    async syncSeasonWorkspaceRemote(input: RemoteSyncWorkspaceInput): Promise<RemoteSyncWorkspaceResult> {
      const records = input.pendingOps.filter((op): op is Extract<LocalPendingOp, { type: 'flightRecord' }> => op.type === 'flightRecord').map((op) => op.record as FlightRecord);
      const modifications = input.pendingOps.filter((op): op is Extract<LocalPendingOp, { type: 'modification' }> => op.type === 'modification').map((op) => op.mod);
      const modificationDeletes = input.pendingOps.filter((op): op is Extract<LocalPendingOp, { type: 'modificationDelete' }> => op.type === 'modificationDelete').map((op) => op.legId);
      const history = input.pendingOps.filter((op): op is Extract<LocalPendingOp, { type: 'modHistory' }> => op.type === 'modHistory').map((op) => op.entry);

      if (records.length > 0) await firestoreStore.batchWriteFlightRecords(input.seasonId, records, (written, total) => input.onProgress?.('Saving flight records', written, total));
      if (modifications.length > 0) {
        await firestoreStore.saveModifications(input.seasonId, modifications);
        input.onProgress?.('Saving modifications', modifications.length, modifications.length);
      }
      if (modificationDeletes.length > 0) {
        await firestoreStore.deleteModifications(input.seasonId, modificationDeletes);
        input.onProgress?.('Removing modifications', modificationDeletes.length, modificationDeletes.length);
      }
      if (history.length > 0) {
        await firestoreStore.saveModHistoryEntries(input.seasonId, history);
        input.onProgress?.('Saving history', history.length, history.length);
      }
      const nextServerVersion = input.baseServerVersion + 1;
      await firestoreStore.updateSeason(input.seasonId, { dataVersion: nextServerVersion, lastSyncedAt: Date.now() });
      return { nextServerVersion };
    },
    async getCurrentRemoteActor(): Promise<RemoteActor | null> {
      const { auth } = await import('./firebase');
      return auth.currentUser;
    },
  };
}

export function getRemoteStore(): Promise<RemoteStore> {
  if (!cachedStore) {
    cachedStore = shouldUseSupabase()
      ? import('./supabaseStore').then(({ supabaseStore }) => supabaseStore)
      : getFirestoreStore();
  }
  return cachedStore;
}

export async function getSeasons(): Promise<Season[]> {
  return (await getRemoteStore()).getSeasons();
}
export async function getSeason(id: string): Promise<Season | null> {
  return (await getRemoteStore()).getSeason(id);
}
export async function findSeasonByCode(code: string): Promise<Season | null> {
  return (await getRemoteStore()).findSeasonByCode(code);
}
export async function createSeason(season: Omit<Season, 'id'>): Promise<string> {
  return (await getRemoteStore()).createSeason(season);
}
export async function updateSeason(id: string, data: Partial<Season>): Promise<void> {
  return (await getRemoteStore()).updateSeason(id, data);
}
export async function deleteSeason(id: string): Promise<void> {
  return (await getRemoteStore()).deleteSeason(id);
}
export async function getOperationalSettings(): Promise<OperationalSettings> {
  const cached = getCachedOperationalSettings();
  if (cached) return cached;
  const settings = await (await getRemoteStore()).getOperationalSettings();
  setCachedOperationalSettings(settings);
  return settings;
}
export async function saveOperationalSettings(settings: OperationalSettings): Promise<void> {
  await (await getRemoteStore()).saveOperationalSettings(settings);
  setCachedOperationalSettings(settings);
}
export async function saveAuditLogEntry(session: AuditSession, entry: AuditLogEntry): Promise<void> {
  return (await getRemoteStore()).saveAuditLogEntry(session, entry);
}
export async function getAuditSessions(maxSessions?: number): Promise<AuditSession[]> {
  return (await getRemoteStore()).getAuditSessions(maxSessions);
}
export async function getAuditLogEntries(sessionId: string, maxEntries?: number): Promise<AuditLogEntry[]> {
  return (await getRemoteStore()).getAuditLogEntries(sessionId, maxEntries);
}
export async function getAuditDeltaChunks(sessionId: string, entryId: string): Promise<AuditDeltaChunk[]> {
  return (await getRemoteStore()).getAuditDeltaChunks(sessionId, entryId);
}
export async function clearFlightRecords(seasonId: string): Promise<void> {
  return (await getRemoteStore()).clearFlightRecords(seasonId);
}
export async function clearSourceRows(seasonId: string): Promise<void> {
  return (await getRemoteStore()).clearSourceRows(seasonId);
}
export async function clearModifications(seasonId: string): Promise<void> {
  return (await getRemoteStore()).clearModifications(seasonId);
}
export async function clearModHistory(seasonId: string): Promise<void> {
  return (await getRemoteStore()).clearModHistory(seasonId);
}
export async function clearSeasonBaseline(seasonId: string): Promise<void> {
  return (await getRemoteStore()).clearSeasonBaseline(seasonId);
}
export async function batchWriteSourceRows(_seasonId: string, rows: ParsedRow[], onProgress?: (written: number, total: number) => void): Promise<void> {
  void _seasonId;
  onProgress?.(rows.length, rows.length);
}
export async function getSourceRows(_seasonId: string): Promise<ParsedRow[]> {
  void _seasonId;
  return [];
}
export async function batchWriteFlightRecords(seasonId: string, records: FlightRecord[], onProgress?: (written: number, total: number) => void): Promise<void> {
  return (await getRemoteStore()).batchWriteFlightRecords(seasonId, records, onProgress);
}
export async function verifySeasonImportCounts(seasonId: string, expected: RemoteSeasonImportCounts): Promise<RemoteSeasonImportCounts> {
  const store = await getRemoteStore();
  if (!store.verifySeasonImportCounts) return expected;
  return store.verifySeasonImportCounts(seasonId, expected);
}
export async function getFlightRecords(seasonId: string): Promise<FlightRecord[]> {
  return (await getRemoteStore()).getFlightRecords(seasonId);
}
export async function getSeasonEventHighWater(seasonId: string): Promise<number> {
  const store = await getRemoteStore();
  return store.getSeasonEventHighWater?.(seasonId) ?? 0;
}
export async function getSeasonEntityVersions(seasonId: string): Promise<LocalEntityVersionMap> {
  const store = await getRemoteStore();
  return store.getSeasonEntityVersions?.(seasonId) ?? {};
}
export async function getSeasonWorkspaceSnapshot(
  seasonId: string,
  options: { modHistoryLimit?: number; transport?: 'auto' | 'rpc' | 'paged' } = {}
): Promise<RemoteSeasonWorkspaceSnapshot | null> {
  const store = await getRemoteStore();
  if (store.getSeasonWorkspaceSnapshot) return store.getSeasonWorkspaceSnapshot(seasonId, options);
  const season = await store.getSeason(seasonId);
  if (!season) return null;
  const [dashboardData, modHistory, serverHighWater, entityVersions] = await Promise.all([
    getDashboardSeasonData(seasonId),
    store.getModHistory(seasonId, options.modHistoryLimit ?? 50),
    store.getSeasonEventHighWater?.(seasonId) ?? Promise.resolve(0),
    store.getSeasonEntityVersions?.(seasonId) ?? Promise.resolve({}),
  ]);
  return {
    season,
    sourceRows: dashboardData.sourceRows,
    records: dashboardData.records,
    modifications: dashboardData.modifications,
    modHistory,
    cursor: { serverHighWater },
    entityVersions,
  };
}
export async function loadSeasonEventPage(
  seasonId: string,
  serverSeq: number,
  options: { throughSeq: number; limit?: number }
): Promise<RemoteSeasonEventPage> {
  const store = await getRemoteStore();
  if (store.loadSeasonEventPage) return store.loadSeasonEventPage(seasonId, serverSeq, options);
  const events = await (store.loadSeasonEventsSince?.(seasonId, serverSeq, { throughSeq: options.throughSeq }) ?? Promise.resolve([]));
  const cappedEvents = events.slice(0, options.limit ?? 200);
  const nextCursor = cappedEvents.reduce((max, event) => Math.max(max, event.serverSeq ?? max), serverSeq);
  return {
    events: cappedEvents,
    nextCursor,
    hasMore: events.length > cappedEvents.length,
    serverHighWater: options.throughSeq,
  };
}
export async function getDashboardSeasonData(seasonId: string): Promise<RemoteDashboardSeasonData> {
  const store = await getRemoteStore();
  if (store.getDashboardSeasonData) return store.getDashboardSeasonData(seasonId);
  const [records, modifications] = await Promise.all([
    store.getFlightRecords(seasonId),
    store.getModifications(seasonId),
  ]);
  return { sourceRows: [], records, modifications };
}
function sourceRowWritesDisabled(): Error {
  return new Error('Source row writes are disabled. Seasonal data is stored as atomic flight records.');
}

export async function addSourceRow(_seasonId: string, _row: Omit<ParsedRow, 'rowIndex'>): Promise<ParsedRow> {
  void _seasonId;
  void _row;
  throw sourceRowWritesDisabled();
}
export async function deleteSourceRow(_seasonId: string, _rowIndex: number, _linkedRowIndex?: number): Promise<void> {
  void _seasonId;
  void _rowIndex;
  void _linkedRowIndex;
  throw sourceRowWritesDisabled();
}
export async function linkSourceRows(_seasonId: string, _rowIndexA: number, _rowIndexB: number, _linkType?: 'overnight' | 'sameday'): Promise<void> {
  void _seasonId;
  void _rowIndexA;
  void _rowIndexB;
  void _linkType;
  throw sourceRowWritesDisabled();
}
export async function mergeSameDaySourceRows(_seasonId: string, _rowIndexA: number, _rowIndexB: number): Promise<void> {
  void _seasonId;
  void _rowIndexA;
  void _rowIndexB;
  throw sourceRowWritesDisabled();
}
export async function unlinkSourceRows(_seasonId: string, _rowIndexA: number, _rowIndexB: number): Promise<void> {
  void _seasonId;
  void _rowIndexA;
  void _rowIndexB;
  throw sourceRowWritesDisabled();
}
export async function splitSourceRowTurnaround(_seasonId: string, _rowIndex: number): Promise<number> {
  void _seasonId;
  void _rowIndex;
  throw sourceRowWritesDisabled();
}
export async function applySourceRowOperationPlan(_seasonId: string, _plan: SourceRowOperationPlan): Promise<void> {
  void _seasonId;
  void _plan;
  throw sourceRowWritesDisabled();
}
export async function getModifications(seasonId: string): Promise<Map<string, FlightModification>> {
  return (await getRemoteStore()).getModifications(seasonId);
}
export async function saveModification(seasonId: string, legId: string, mod: FlightModification): Promise<void> {
  return (await getRemoteStore()).saveModification(seasonId, legId, mod);
}
export async function saveModifications(seasonId: string, mods: FlightModification[]): Promise<void> {
  return (await getRemoteStore()).saveModifications(seasonId, mods);
}
export async function removeModification(seasonId: string, legId: string): Promise<void> {
  return (await getRemoteStore()).removeModification(seasonId, legId);
}
export async function deleteModifications(seasonId: string, legIds: string[]): Promise<void> {
  return (await getRemoteStore()).deleteModifications(seasonId, legIds);
}
export async function saveModificationsWithHistory(
  seasonId: string,
  mods: FlightModification[],
  currentMods: Map<string, FlightModification>,
  description: string
): Promise<void> {
  return (await getRemoteStore()).saveModificationsWithHistory(seasonId, mods, currentMods, description);
}
export async function saveModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void> {
  return (await getRemoteStore()).saveModHistoryEntries(seasonId, entries);
}
export async function getModHistory(seasonId: string, limit?: number): Promise<ModHistoryEntry[]> {
  return (await getRemoteStore()).getModHistory(seasonId, limit);
}
export async function undoModHistoryEntries(seasonId: string, entries: ModHistoryEntry[]): Promise<void> {
  return (await getRemoteStore()).undoModHistoryEntries(seasonId, entries);
}
export async function getCurrentRemoteActor(): Promise<RemoteActor | null> {
  return (await getRemoteStore()).getCurrentRemoteActor();
}
