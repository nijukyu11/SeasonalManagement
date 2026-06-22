import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow, Season } from './types';
import { flattenRowsToFlightRecords } from './atomicSchedule';
import {
  buildInitialSyncMeta,
  createLocalWorkspace,
  loadLocalSeasonWorkspace,
  rebuildPendingOpsFromBaseline,
  saveLocalSeasonWorkspace,
  updateLocalSyncMeta,
  type LocalPendingOp,
  type LocalSeasonWorkspace,
} from './localSeasonStore';
import { appendAuditLogEntry, buildSyncAuditDelta, type AuditSyncStatus } from './auditLog';
import { getRemoteStore, type RemoteSeasonSyncCursorState, type RemoteSeasonWorkspaceSnapshot, type RemoteStore } from './remoteStore';
import {
  applySeasonEventRange,
  buildPendingChangeEvents,
  getOrCreateSeasonClientId,
  type SeasonChangeEvent,
  type SeasonConflictItem,
} from './seasonChangeEvents';

export const CATCH_UP_EVENT_PAGE_SIZE = 200;
export const SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD = 100;
export const MAX_EVENT_REPLAY_BACKLOG = SNAPSHOT_CATCHUP_BACKLOG_THRESHOLD;

async function persistLocalSyncMeta(
  workspace: LocalSeasonWorkspace,
  syncMeta: LocalSeasonWorkspace['syncMeta']
): Promise<LocalSeasonWorkspace> {
  const nextWorkspace = { ...workspace, syncMeta };
  await updateLocalSyncMeta(workspace.season.id, syncMeta);
  return nextWorkspace;
}

export interface SyncPlanInput {
  baseServerVersion: number;
  serverVersion: number;
  pendingOps: LocalPendingOp[];
}

export interface SyncWrittenCounts {
  records: number;
  sourceRows: number;
  modifications: number;
  history: number;
}

export interface SyncPlan {
  status: 'ready' | 'refresh' | 'conflict' | 'noop';
  message: string;
  writtenCounts: SyncWrittenCounts;
}

export interface SyncResult {
  status: 'synced' | 'conflict' | 'failed';
  message: string;
  writtenCounts?: SyncWrittenCounts;
  reviewCount?: number;
}

export type SeasonWorkspaceStaleState = 'current' | 'clean-stale' | 'dirty-stale';

function numberOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function isSeasonWorkspaceStale(
  workspace: LocalSeasonWorkspace,
  serverSeason: Pick<Season, 'dataVersion'>
): SeasonWorkspaceStaleState {
  const localVersion = numberOrZero(workspace.season.dataVersion ?? workspace.syncMeta.baseServerVersion);
  const serverVersion = numberOrZero(serverSeason.dataVersion);
  if (serverVersion <= localVersion) return 'current';
  const hasLocalWork =
    workspace.pendingOps.length > 0 ||
    (workspace.syncMeta.pendingCount ?? 0) > 0 ||
    (workspace.syncMeta.conflicts?.length ?? 0) > 0;
  return hasLocalWork ? 'dirty-stale' : 'clean-stale';
}

export function countPendingOps(pendingOps: LocalPendingOp[]): SyncWrittenCounts {
  return {
    records: pendingOps.filter((op) => op.type === 'flightRecord').length,
    sourceRows: 0,
    modifications: pendingOps.filter((op) => op.type === 'modification' || op.type === 'modificationDelete').length,
    history: pendingOps.filter((op) => op.type === 'modHistory').length,
  };
}

function flushScheduleNotifications(remoteStore: RemoteStore, seasonId: string): void {
  if (!remoteStore.flushScheduleNotifications) return;
  try {
    void Promise.resolve(remoteStore.flushScheduleNotifications({ seasonId })).catch((error) => {
      console.debug('[schedule-notifications] flush failed', error);
    });
  } catch (error) {
    console.debug('[schedule-notifications] flush failed', error);
  }
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const writtenCounts = countPendingOps(input.pendingOps);
  if (input.pendingOps.length === 0) {
    if (input.serverVersion !== input.baseServerVersion) {
      return {
        status: 'refresh',
        message: `Server version changed from ${input.baseServerVersion} to ${input.serverVersion}. Refresh local workspace from server.`,
        writtenCounts,
      };
    }
    return { status: 'noop', message: 'No local changes to sync.', writtenCounts };
  }
  if (input.serverVersion !== input.baseServerVersion) {
    return {
      status: 'conflict',
      message: `Server version changed from ${input.baseServerVersion} to ${input.serverVersion}. Reload before syncing.`,
      writtenCounts,
    };
  }
  return { status: 'ready', message: 'Ready to sync local changes.', writtenCounts };
}

export function applySuccessfulSync(workspace: LocalSeasonWorkspace, nextServerVersion: number): LocalSeasonWorkspace {
  return {
    ...workspace,
    season: {
      ...workspace.season,
      dataVersion: nextServerVersion,
      lastSyncedAt: Date.now(),
    },
    baseRows: [...workspace.rows],
    baseRecords: [...workspace.records],
    baseModificationEntries: Array.from(workspace.modifications.entries()),
    baseModHistory: [...workspace.modHistory],
    pendingOps: [],
    syncMeta: {
      ...workspace.syncMeta,
      baseServerVersion: nextServerVersion,
      pendingCount: 0,
      lastLocalChangeAt: null,
      syncStatus: 'synced',
    },
  };
}

export function finalizeSuccessfulSync(
  syncStartWorkspace: LocalSeasonWorkspace,
  latestWorkspace: LocalSeasonWorkspace | null,
  nextServerVersion: number
): LocalSeasonWorkspace {
  const syncedStart = applySuccessfulSync(syncStartWorkspace, nextServerVersion);
  if (!latestWorkspace || latestWorkspace.syncMeta.localRevision === syncStartWorkspace.syncMeta.localRevision) {
    return syncedStart;
  }

  return rebuildPendingOpsFromBaseline({
    ...latestWorkspace,
    season: {
      ...latestWorkspace.season,
      dataVersion: nextServerVersion,
      lastSyncedAt: Date.now(),
    },
    baseRows: syncedStart.baseRows,
    baseRecords: syncedStart.baseRecords,
    baseModificationEntries: syncedStart.baseModificationEntries,
    baseModHistory: syncedStart.baseModHistory,
    syncMeta: {
      ...latestWorkspace.syncMeta,
      baseServerVersion: nextServerVersion,
    },
  }, latestWorkspace.syncMeta.lastLocalChangeAt);
}

function readWorkspaceEntity(workspace: LocalSeasonWorkspace | null, event: SeasonChangeEvent): Record<string, unknown> | null {
  if (!workspace) return null;
  if (event.targetType === 'flightRecord') {
    return workspace.records.find((record) => record.id === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (event.targetType === 'sourceRow') {
    return workspace.rows.find((row) => String(row.rowIndex) === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (event.targetType === 'modification') {
    return workspace.modifications.get(event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  return workspace.modHistory.find((entry) => entry.id === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
}

function pickFields(source: Record<string, unknown> | null, fields: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) output[field] = source?.[field] ?? null;
  return output;
}

function withRemotePayload(event: SeasonChangeEvent, remoteEntity: Record<string, unknown> | null): SeasonChangeEvent {
  const baseFieldVersions = event.opPayload.baseFieldVersions;
  if (event.targetType === 'flightRecord' && remoteEntity) {
    return {
      ...event,
      opPayload: { type: 'flightRecord', record: remoteEntity as unknown as FlightRecord, baseFieldVersions },
    };
  }
  if (event.targetType === 'sourceRow' && remoteEntity) {
    return {
      ...event,
      opPayload: { type: 'sourceRow', row: remoteEntity as unknown as ParsedRow, baseFieldVersions },
    };
  }
  if (event.targetType === 'modification') {
    return {
      ...event,
      opPayload: remoteEntity
        ? { type: 'modification', mod: remoteEntity as unknown as FlightModification, baseFieldVersions }
        : { type: 'modificationDelete', legId: event.targetId, baseFieldVersions },
    };
  }
  if (event.targetType === 'modHistory' && remoteEntity) {
    return {
      ...event,
      opPayload: { type: 'modHistory', entry: remoteEntity as unknown as ModHistoryEntry, baseFieldVersions },
    };
  }
  return event;
}

function conflictsFromServerRejectedEvents(
  events: SeasonChangeEvent[],
  localWorkspace: LocalSeasonWorkspace,
  remoteWorkspace: LocalSeasonWorkspace | null
): SeasonConflictItem[] {
  return events.map((localEvent) => {
    const localEntity = readWorkspaceEntity(localWorkspace, localEvent);
    const remoteEntity = readWorkspaceEntity(remoteWorkspace, localEvent);
    const remoteEvent = withRemotePayload(localEvent, remoteEntity);
    return {
      id: `sync-conflict:${localEvent.opId}`,
      event: remoteEvent,
      targetType: localEvent.targetType,
      targetId: localEvent.targetId,
      overlappingFields: localEvent.changedFields,
      localFields: pickFields(localEntity, localEvent.changedFields),
      remoteFields: pickFields(remoteEntity, localEvent.changedFields),
      createdAt: Date.now(),
      message: `Remote ${localEvent.targetType} ${localEvent.targetId} changed before this local edit could be applied.`,
    };
  });
}

function mergeConflicts(existing: SeasonConflictItem[] | undefined, incoming: SeasonConflictItem[]): SeasonConflictItem[] {
  const byId = new Map((existing ?? []).map((conflict) => [conflict.id, conflict]));
  for (const conflict of incoming) byId.set(conflict.id, conflict);
  return Array.from(byId.values());
}

function conflictsFromLocalEvents(events: SeasonChangeEvent[]): SeasonConflictItem[] {
  return events.map((event) => ({
    id: `sync-conflict:${event.opId}`,
    event,
    targetType: event.targetType,
    targetId: event.targetId,
    overlappingFields: event.changedFields,
    localFields: {},
    remoteFields: {},
    createdAt: Date.now(),
    message: `Remote ${event.targetType} ${event.targetId} changed before this local edit could be applied.`,
  }));
}

function finalizeSuccessfulEventSync(
  syncStartWorkspace: LocalSeasonWorkspace,
  latestWorkspace: LocalSeasonWorkspace | null,
  nextServerVersion: number,
  processedServerSeq: number,
  clientId: string,
  _appliedEvents: SeasonChangeEvent[],
  conflictEvents: SeasonChangeEvent[],
  serverConflictWorkspace: LocalSeasonWorkspace | null = null
): LocalSeasonWorkspace {
  if (conflictEvents.length === 0) {
    const synced = finalizeSuccessfulSync(syncStartWorkspace, latestWorkspace, nextServerVersion);
    return {
      ...synced,
      syncMeta: {
        ...synced.syncMeta,
        clientId,
        lastServerSeq: Math.max(synced.syncMeta.lastServerSeq ?? 0, processedServerSeq),
      },
    };
  }

  const latest = latestWorkspace ?? syncStartWorkspace;
  const conflicts = serverConflictWorkspace
    ? conflictsFromServerRejectedEvents(conflictEvents, latest, serverConflictWorkspace)
    : conflictsFromLocalEvents(conflictEvents);
  if (latest.syncMeta.localRevision !== syncStartWorkspace.syncMeta.localRevision) {
    const nextConflicts = mergeConflicts(latest.syncMeta.conflicts, conflicts);
    const rebuilt = rebuildPendingOpsFromBaseline({
        ...latest,
        season: {
          ...latest.season,
          dataVersion: nextServerVersion,
          lastSyncedAt: Date.now(),
        },
        syncMeta: {
          ...latest.syncMeta,
          baseServerVersion: nextServerVersion,
          clientId,
          lastServerSeq: processedServerSeq,
          conflicts: nextConflicts,
        },
      }, latest.syncMeta.lastLocalChangeAt);
    return {
      ...rebuilt,
      syncMeta: {
        ...rebuilt.syncMeta,
        clientId,
        lastServerSeq: processedServerSeq,
        conflicts: nextConflicts,
        syncStatus: 'dirty',
      },
    };
  }

  const conflictTargets = new Set(conflictEvents.map((event) => `${event.targetType}:${event.targetId}`));
  const oldBaseRows = new Map(syncStartWorkspace.baseRows.map((row) => [String(row.rowIndex), row]));
  const oldBaseRecords = new Map(syncStartWorkspace.baseRecords.map((record) => [record.id, record]));
  const oldBaseMods = new Map(syncStartWorkspace.baseModificationEntries);
  const nextBaseRows = latest.rows.map((row) => conflictTargets.has(`sourceRow:${row.rowIndex}`) ? oldBaseRows.get(String(row.rowIndex)) ?? row : row);
  const nextBaseRecords = latest.records.map((record) => conflictTargets.has(`flightRecord:${record.id}`) ? oldBaseRecords.get(record.id) ?? record : record);
  const nextBaseMods = new Map(latest.modifications);
  for (const event of conflictEvents) {
    if (event.targetType !== 'modification') continue;
    const baseMod = oldBaseMods.get(event.targetId);
    if (baseMod) nextBaseMods.set(event.targetId, baseMod);
    else nextBaseMods.delete(event.targetId);
  }

  const baseWorkspace = {
    ...latest,
    season: {
      ...latest.season,
      dataVersion: nextServerVersion,
      lastSyncedAt: Date.now(),
    },
    baseRows: nextBaseRows,
    baseRecords: nextBaseRecords,
    baseModificationEntries: Array.from(nextBaseMods.entries()),
    baseModHistory: [...latest.modHistory],
    syncMeta: {
      ...latest.syncMeta,
      baseServerVersion: nextServerVersion,
      clientId,
      lastServerSeq: processedServerSeq,
      conflicts: mergeConflicts(latest.syncMeta.conflicts, conflicts),
    },
  };

  const rebuilt = rebuildPendingOpsFromBaseline(baseWorkspace, baseWorkspace.syncMeta.lastLocalChangeAt);
  return {
    ...rebuilt,
    syncMeta: {
      ...rebuilt.syncMeta,
      clientId,
      lastServerSeq: processedServerSeq,
      conflicts: baseWorkspace.syncMeta.conflicts,
      syncStatus: (baseWorkspace.syncMeta.conflicts?.length ?? 0) > 0
        ? (rebuilt.pendingOps.length > 0 ? 'dirty' : 'needs_review')
        : rebuilt.syncMeta.syncStatus,
    },
  };
}

async function loadRemoteSyncBaseline(
  seasonId: string,
  serverSeason: Season,
  remoteStore: RemoteStore
): Promise<Pick<LocalSeasonWorkspace, 'entityVersions' | 'syncMeta'>> {
  const [eventHighWater, entityVersions] = await Promise.all([
    remoteStore.getSeasonEventHighWater
      ? remoteStore.getSeasonEventHighWater(seasonId).catch(() => 0)
      : Promise.resolve(0),
    remoteStore.getSeasonEntityVersions
      ? remoteStore.getSeasonEntityVersions(seasonId).catch(() => ({}))
      : Promise.resolve({}),
  ]);
  return {
    entityVersions,
    syncMeta: buildInitialSyncMeta(serverSeason, { lastServerSeq: eventHighWater }),
  };
}

async function loadRemoteSyncCursorState(
  seasonId: string,
  remoteStore: RemoteStore
): Promise<RemoteSeasonSyncCursorState> {
  if (remoteStore.getSeasonSyncCursorState) {
    return remoteStore.getSeasonSyncCursorState(seasonId);
  }
  const [serverHighWater, entityVersions] = await Promise.all([
    remoteStore.getSeasonEventHighWater
      ? remoteStore.getSeasonEventHighWater(seasonId).catch(() => 0)
      : Promise.resolve(0),
    remoteStore.getSeasonEntityVersions
      ? remoteStore.getSeasonEntityVersions(seasonId).catch(() => ({}))
      : Promise.resolve({}),
  ]);
  return { serverHighWater, entityVersions };
}

export function createWorkspaceFromRemoteSnapshot(
  snapshot: RemoteSeasonWorkspaceSnapshot,
  options: { clientId?: string } = {}
): LocalSeasonWorkspace {
  const rebuiltRecords = snapshot.sourceRows.length > 0
    ? mergeSnapshotPersistedRecords(flattenRowsToFlightRecords(snapshot.sourceRows), snapshot.records)
    : snapshot.records;
  return createLocalWorkspace({
    season: snapshot.season,
    rows: snapshot.sourceRows,
    records: rebuiltRecords,
    modifications: snapshot.modifications,
    modHistory: snapshot.modHistory,
    baseRows: snapshot.sourceRows,
    baseRecords: rebuiltRecords,
    entityVersions: snapshot.entityVersions,
    serverEventHighWater: snapshot.cursor.serverHighWater,
    syncMeta: buildInitialSyncMeta(snapshot.season, {
      lastServerSeq: snapshot.cursor.serverHighWater,
      clientId: options.clientId,
    }),
  });
}

function mergeSnapshotPersistedRecords(
  rebuiltRecords: FlightRecord[],
  persistedRecords: FlightRecord[]
): FlightRecord[] {
  const persistedById = new Map(persistedRecords.map((record) => [record.id, record]));
  const persistedBySignature = new Map(persistedRecords.map((record) => [snapshotRecordSignature(record), record]));
  return rebuiltRecords.map((rebuilt) => ({
    ...rebuilt,
    ...(persistedById.get(rebuilt.id) ?? persistedBySignature.get(snapshotRecordSignature(rebuilt)) ?? {}),
    id: rebuilt.id,
  }));
}

function snapshotRecordSignature(record: FlightRecord): string {
  return [
    record.sourceRowIndex ?? '',
    record.date ?? '',
    record.type ?? '',
    record.rawFlightNumber ?? record.flightNumber ?? '',
    record.route ?? '',
    record.schedule ?? '',
  ].join('\u001f');
}

async function loadSeasonWorkspaceSnapshot(
  seasonId: string,
  serverSeason: Season,
  remoteStore: RemoteStore,
  options: { clientId?: string } = {}
): Promise<LocalSeasonWorkspace> {
  if (remoteStore.getSeasonWorkspaceSnapshot) {
    const snapshot = await remoteStore.getSeasonWorkspaceSnapshot(seasonId, { modHistoryLimit: 50 });
    if (!snapshot) throw new Error(`Season ${seasonId} snapshot not found.`);
    return createWorkspaceFromRemoteSnapshot(snapshot, options);
  }
  const workspace = await loadServerSeasonWorkspace(seasonId, serverSeason, remoteStore);
  return {
    ...workspace,
    syncMeta: {
      ...workspace.syncMeta,
      clientId: options.clientId ?? workspace.syncMeta.clientId,
    },
  };
}

async function catchUpSeasonWorkspace(
  seasonId: string,
  workspace: LocalSeasonWorkspace,
  remoteStore: RemoteStore,
  options: { throughSeq?: number; clientId?: string } = {}
): Promise<LocalSeasonWorkspace> {
  if (!remoteStore.loadSeasonEventPage && !remoteStore.getSeasonWorkspaceSnapshot) return workspace;
  const clientId = options.clientId ?? workspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
  const fromSeq = workspace.syncMeta.lastServerSeq ?? 0;
  const cursorState = await loadRemoteSyncCursorState(seasonId, remoteStore);
  const throughSeq = options.throughSeq ?? cursorState.serverHighWater;
  if (throughSeq <= fromSeq) {
    return {
      ...workspace,
      entityVersions: Object.keys(cursorState.entityVersions).length > 0
        ? cursorState.entityVersions
        : workspace.entityVersions,
      syncMeta: {
        ...workspace.syncMeta,
        clientId,
      },
    };
  }

  if (!remoteStore.loadSeasonEventPage) return workspace;

  let cursor = fromSeq;
  let nextWorkspace: LocalSeasonWorkspace = {
    ...workspace,
    entityVersions: Object.keys(cursorState.entityVersions).length > 0
      ? { ...workspace.entityVersions, ...cursorState.entityVersions }
      : workspace.entityVersions,
    syncMeta: {
      ...workspace.syncMeta,
      clientId,
    },
  };
  let hasMore = true;

  while (hasMore && cursor < throughSeq) {
    const page = await remoteStore.loadSeasonEventPage(seasonId, cursor, {
      throughSeq,
      limit: CATCH_UP_EVENT_PAGE_SIZE,
    });
    if (page.events.length === 0 || page.nextCursor <= cursor) break;
    nextWorkspace = applySeasonEventRange(nextWorkspace, page.events, { clientId }).workspace;
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }
  return {
    ...nextWorkspace,
    syncMeta: {
      ...nextWorkspace.syncMeta,
      clientId,
    },
  };
}

async function loadServerSeasonWorkspace(
  seasonId: string,
  serverSeason: Season,
  remoteStore: RemoteStore
): Promise<LocalSeasonWorkspace> {
  const [fetchedRecords, modifications, modHistory, baseline] = await Promise.all([
    remoteStore.getFlightRecords(seasonId),
    remoteStore.getModifications(seasonId),
    remoteStore.getModHistory(seasonId),
    loadRemoteSyncBaseline(seasonId, serverSeason, remoteStore),
  ]);
  return createLocalWorkspace({
    season: serverSeason,
    rows: [],
    records: fetchedRecords,
    modifications,
    modHistory,
    baseRecords: fetchedRecords,
    entityVersions: baseline.entityVersions,
    syncMeta: baseline.syncMeta,
    pendingOps: [],
  });
}

export async function syncSeasonWorkspace(
  seasonId: string,
  onProgress?: (label: string, written: number, total: number) => void
): Promise<SyncResult> {
  let workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) return { status: 'failed', message: `Local season workspace ${seasonId} not found.` };
  let activeWorkspace = workspace;
  const baseSyncDelta = buildSyncAuditDelta(activeWorkspace);

  function appendSyncAudit(status: AuditSyncStatus, message: string, writtenCounts?: SyncWrittenCounts): void {
    const syncDelta = { ...baseSyncDelta, status };
    void appendAuditLogEntry({
      seasonId: activeWorkspace.season.id,
      seasonCode: activeWorkspace.season.seasonCode,
      module: 'sync',
      category: 'sync',
      operation: `Sync ${status} for ${activeWorkspace.season.seasonCode}: ${message}`,
      targetFlightIds: Array.from(new Set(syncDelta.exactChanges.filter((delta) => delta.targetType === 'flight').map((delta) => delta.targetId))),
      targetFlightLabels: Array.from(new Set(syncDelta.exactChanges.filter((delta) => delta.targetType === 'flight').map((delta) => delta.targetLabel))),
      deltas: syncDelta.exactChanges,
      syncDelta,
      metadata: {
        writtenCounts: writtenCounts ?? countPendingOps(activeWorkspace.pendingOps),
        pendingCount: activeWorkspace.pendingOps.length,
        localRevision: activeWorkspace.syncMeta.localRevision,
      },
    });
  }

  const remoteStore = await getRemoteStore();
  const serverSeason = await remoteStore.getSeason(seasonId) as Season | null;
  if (!serverSeason) {
    appendSyncAudit('failed', 'Season no longer exists on server.');
    return { status: 'failed', message: 'Season no longer exists on server.' };
  }

  const serverVersion = serverSeason.dataVersion ?? 0;
  const staleState = isSeasonWorkspaceStale(workspace, serverSeason);
  if (staleState === 'clean-stale') {
    try {
      const refreshed = await loadSeasonWorkspaceSnapshot(seasonId, serverSeason, remoteStore, {
        clientId: workspace.syncMeta.clientId ?? getOrCreateSeasonClientId(),
      });
      await saveLocalSeasonWorkspace(refreshed, { nativeFullSaveReason: 'sync-baseline' });
      activeWorkspace = refreshed;
      appendSyncAudit('synced', 'Server baseline refreshed from latest seasonal import.', countPendingOps(refreshed.pendingOps));
      return {
        status: 'synced',
        message: 'Server baseline refreshed from latest seasonal import.',
        writtenCounts: countPendingOps(refreshed.pendingOps),
      };
    } catch (err) {
      const message = (err as Error).message;
      appendSyncAudit('failed', message);
      return { status: 'failed', message };
    }
  }
  if (staleState === 'dirty-stale') {
    const message = 'Server seasonal baseline changed after this local workspace was edited. Review, discard, or export local changes before refreshing.';
    appendSyncAudit('conflict', message, countPendingOps(workspace.pendingOps));
    return { status: 'conflict', message, writtenCounts: countPendingOps(workspace.pendingOps), reviewCount: workspace.syncMeta.conflicts?.length ?? 0 };
  }
  if (remoteStore.syncSeasonWorkspaceRemoteV2) {
    const clientId = workspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
    try {
      const caughtUpWorkspace = await catchUpSeasonWorkspace(seasonId, workspace, remoteStore, { clientId });
      if (caughtUpWorkspace !== workspace) {
        workspace = caughtUpWorkspace;
        activeWorkspace = caughtUpWorkspace;
        await saveLocalSeasonWorkspace(caughtUpWorkspace, { nativeFullSaveReason: 'sync-baseline' });
      }
    } catch (err) {
      workspace = await persistLocalSyncMeta(workspace, { ...workspace.syncMeta, syncStatus: 'failed' });
      activeWorkspace = workspace;
      const message = (err as Error).message;
      appendSyncAudit('failed', message);
      return { status: 'failed', message };
    }

    if (workspace.pendingOps.length === 0) {
      const reviewCount = workspace.syncMeta.conflicts?.length ?? 0;
      const message = reviewCount > 0
        ? `${reviewCount} item${reviewCount === 1 ? '' : 's'} need review. No unrelated local changes to sync.`
        : 'No local changes to sync.';
      appendSyncAudit(reviewCount > 0 ? 'conflict' : 'noop', message, countPendingOps(workspace.pendingOps));
      return { status: reviewCount > 0 ? 'conflict' : 'synced', message, writtenCounts: countPendingOps(workspace.pendingOps), reviewCount };
    }

    const actor = await remoteStore.getCurrentRemoteActor().catch(() => null);
    const pendingEvents = buildPendingChangeEvents(workspace, {
      clientId,
      actorUserId: actor?.uid ?? null,
    });
    try {
      workspace = await persistLocalSyncMeta(workspace, { ...workspace.syncMeta, clientId, syncStatus: 'syncing' });
      activeWorkspace = workspace;
      const writtenCounts = countPendingOps(workspace.pendingOps);
      const result = await remoteStore.syncSeasonWorkspaceRemoteV2({
        seasonId,
        clientId,
        baseServerSeq: workspace.syncMeta.lastServerSeq ?? workspace.syncMeta.baseServerVersion ?? serverVersion,
        pendingEvents,
        onProgress,
      });
      const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
      const serverConflictWorkspace = result.conflictEvents.length > 0
        ? await loadSeasonWorkspaceSnapshot(
            seasonId,
            { ...serverSeason, dataVersion: result.nextServerVersion ?? serverVersion },
            remoteStore,
            { clientId }
          )
        : null;
      const synced = finalizeSuccessfulEventSync(
        workspace,
        latestWorkspace,
        result.nextServerVersion ?? serverVersion,
        workspace.syncMeta.lastServerSeq ?? 0,
        clientId,
        result.appliedEvents,
        result.conflictEvents,
        serverConflictWorkspace
      );
      const postCaughtUp = await catchUpSeasonWorkspace(
        seasonId,
        synced,
        remoteStore,
        { throughSeq: result.serverHighWater ?? result.nextServerSeq, clientId }
      );
      await saveLocalSeasonWorkspace(postCaughtUp, { nativeFullSaveReason: 'sync-baseline' });
      const reviewCount = postCaughtUp.syncMeta.conflicts?.length ?? 0;
      const message = reviewCount > 0
        ? `Synced non-conflicting changes. ${reviewCount} item${reviewCount === 1 ? '' : 's'} need review.`
        : 'Local changes synced.';
      appendSyncAudit('synced', message, writtenCounts);
      flushScheduleNotifications(remoteStore, seasonId);
      return { status: 'synced', message, writtenCounts, reviewCount };
    } catch (err) {
      const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
      activeWorkspace = await persistLocalSyncMeta(
        latestWorkspace ?? workspace,
        { ...(latestWorkspace ?? workspace).syncMeta, syncStatus: 'failed' }
      );
      const message = (err as Error).message;
      appendSyncAudit('failed', message);
      return { status: 'failed', message };
    }
  }

  const plan = planSync({
    baseServerVersion: workspace.syncMeta.baseServerVersion,
    serverVersion,
    pendingOps: workspace.pendingOps,
  });

  if (plan.status === 'noop') {
    const reviewCount = workspace.syncMeta.conflicts?.length ?? 0;
    const message = reviewCount > 0
      ? `${reviewCount} item${reviewCount === 1 ? '' : 's'} need review. No unrelated local changes to sync.`
      : plan.message;
    appendSyncAudit(reviewCount > 0 ? 'conflict' : 'noop', message, plan.writtenCounts);
    return { status: reviewCount > 0 ? 'conflict' : 'synced', message, writtenCounts: plan.writtenCounts, reviewCount };
  }
  if (plan.status === 'refresh') {
    try {
      onProgress?.('Refreshing from server', 0, 1);
      const refreshed = await loadSeasonWorkspaceSnapshot(seasonId, serverSeason, remoteStore);
      const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
      if (latestWorkspace && latestWorkspace.syncMeta.localRevision !== workspace.syncMeta.localRevision) {
        activeWorkspace = await persistLocalSyncMeta(latestWorkspace, { ...latestWorkspace.syncMeta, syncStatus: 'conflict' });
        const message = 'Local changes were made while refreshing remote changes. Review them before syncing.';
        appendSyncAudit('conflict', message, plan.writtenCounts);
        return { status: 'conflict', message, writtenCounts: plan.writtenCounts };
      }
      await saveLocalSeasonWorkspace(refreshed, { nativeFullSaveReason: 'sync-baseline' });
      onProgress?.('Refreshing from server', 1, 1);
      appendSyncAudit('synced', 'Remote changes refreshed.', plan.writtenCounts);
      return { status: 'synced', message: 'Remote changes refreshed.', writtenCounts: plan.writtenCounts };
    } catch (err) {
      const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
      activeWorkspace = await persistLocalSyncMeta(
        latestWorkspace ?? workspace,
        { ...(latestWorkspace ?? workspace).syncMeta, syncStatus: 'failed' }
      );
      const message = (err as Error).message;
      appendSyncAudit('failed', message);
      return { status: 'failed', message };
    }
  }
  if (plan.status === 'conflict') {
    const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
    activeWorkspace = await persistLocalSyncMeta(
      latestWorkspace ?? workspace,
      { ...(latestWorkspace ?? workspace).syncMeta, syncStatus: 'conflict' }
    );
    appendSyncAudit('conflict', plan.message, plan.writtenCounts);
    return { status: 'conflict', message: plan.message, writtenCounts: plan.writtenCounts };
  }

  try {
    workspace = await persistLocalSyncMeta(workspace, { ...workspace.syncMeta, syncStatus: 'syncing' });
    activeWorkspace = workspace;
    const writtenCounts = countPendingOps(workspace.pendingOps);
    const { nextServerVersion } = await remoteStore.syncSeasonWorkspaceRemote({
      seasonId,
      baseServerVersion: serverVersion,
      pendingOps: workspace.pendingOps,
      onProgress,
    });
    const nextVersion = nextServerVersion;
    const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
    const synced = finalizeSuccessfulSync(workspace, latestWorkspace, nextVersion);
    await saveLocalSeasonWorkspace(synced, { nativeFullSaveReason: 'sync-baseline' });
    appendSyncAudit('synced', 'Local changes synced.', writtenCounts);
    return { status: 'synced', message: 'Local changes synced.', writtenCounts };
  } catch (err) {
    const latestWorkspace = await loadLocalSeasonWorkspace(seasonId);
    activeWorkspace = await persistLocalSyncMeta(
      latestWorkspace ?? workspace,
      { ...(latestWorkspace ?? workspace).syncMeta, syncStatus: 'failed' }
    );
    const message = (err as Error).message;
    appendSyncAudit('failed', message);
    return { status: 'failed', message };
  }
}
