import type { LocalSyncMeta } from './localSeasonStore';
import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow } from './types';
import { isTauriRuntime } from './nativeRuntime';
import { applySeasonServerMutationV1 } from './remoteStore';
import { getOrCreateSeasonClientId } from './seasonChangeEvents';
import { queryNativeSyncSummary, runNativeSeasonCatchup } from './nativeSeasonCatchup';
import { SERVER_AUTHORITATIVE_MODE } from './serverAuthoritativeMode';

export interface NativeLocalModificationBatchDeltaResult {
  syncMeta: LocalSyncMeta;
  affectedIds: string[];
}

export interface NativeScheduleMutationResult {
  syncMeta: LocalSyncMeta;
}

type NativeLocalModificationSource = 'gate' | 'checkin' | 'allocation';

export function isNativeLocalStoreRuntime(): boolean {
  return isTauriRuntime();
}

function randomClientMutationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `mutation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toServerAuthoritativeSyncMeta(
  seasonId: string,
  clientId: string,
  serverSeq: number,
  appliedEvents: unknown[] = []
): LocalSyncMeta {
  const appliedEventIds = appliedEvents
    .map((event) => {
      if (!event || typeof event !== 'object') return null;
      const value = event as { eventId?: unknown; event_id?: unknown };
      return typeof value.eventId === 'string'
        ? value.eventId
        : typeof value.event_id === 'string'
          ? value.event_id
          : null;
    })
    .filter((eventId): eventId is string => Boolean(eventId));
  return {
    seasonId,
    baseServerVersion: serverSeq,
    lastServerSeq: serverSeq,
    clientId,
    appliedEventIds,
    conflicts: [],
    localRevision: serverSeq,
    pendingCount: 0,
    lastLocalChangeAt: null,
    syncStatus: 'synced',
  };
}

function historyOperation(
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>
): Record<string, unknown>[] {
  if (!history) return [];
  return [{
    type: 'modHistory',
    entry: {
      ...history,
      changes: [],
      recordChanges: [],
    },
  }];
}

async function applyServerAuthoritativeOperations(
  seasonId: string,
  source: string,
  operations: unknown[]
): Promise<LocalSyncMeta> {
  const clientId = getOrCreateSeasonClientId();
  const summary = await queryNativeSyncSummary(seasonId).catch(() => null);
  const baseServerSeq = summary?.lastServerSeq ?? 0;
  const result = await applySeasonServerMutationV1({
    seasonId,
    clientId,
    clientMutationId: randomClientMutationId(),
    source,
    baseServerSeq,
    operations,
  });
  if (result.serverHighWater > baseServerSeq) {
    await runNativeSeasonCatchup({
      seasonId,
      clientId,
      localCursor: baseServerSeq,
      serverHighWater: result.serverHighWater,
      pageSize: 200,
    });
  }
  return toServerAuthoritativeSyncMeta(seasonId, clientId, result.nextServerSeq, result.appliedEvents);
}

export async function runNativeLocalModificationBatchDeltaResult(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>,
  source: NativeLocalModificationSource = 'allocation'
): Promise<NativeLocalModificationBatchDeltaResult | null> {
  if (!isNativeLocalStoreRuntime()) return null;
  if (SERVER_AUTHORITATIVE_MODE) {
    const operations = [
      ...mods.map((mod) => ({ type: 'modification', mod })),
      ...historyOperation(history),
    ];
    const syncMeta = await applyServerAuthoritativeOperations(seasonId, source, operations);
    return {
      syncMeta,
      affectedIds: mods.map((mod) => mod.legId),
    };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NativeLocalModificationBatchDeltaResult>('apply_local_modification_batch_delta', {
    input: {
      seasonId,
      mods,
      history,
    },
  });
}

export async function runNativeLocalModificationBatchDelta(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>,
  source?: NativeLocalModificationSource
): Promise<LocalSyncMeta | null> {
  const result = await runNativeLocalModificationBatchDeltaResult(seasonId, mods, history, source);
  if (!result) return null;
  return result.syncMeta;
}

export async function runNativeScheduleMutation(
  seasonId: string,
  records: FlightRecord[],
  deletedIds: string[] = [],
  mods: FlightModification[] = [],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>,
  sourceRows: ParsedRow[] = []
): Promise<LocalSyncMeta | null> {
  if (!isNativeLocalStoreRuntime()) return null;
  if (SERVER_AUTHORITATIVE_MODE) {
    const operations = [
      ...records.map((record) => ({ type: 'flightRecord', record })),
      ...deletedIds.map((id) => ({ type: 'flightRecord', record: { id, status: 'deleted' } })),
      ...sourceRows.map((row) => ({ type: 'sourceRow', row })),
      ...mods.map((mod) => ({ type: 'modification', mod })),
      ...historyOperation(history),
    ];
    return applyServerAuthoritativeOperations(seasonId, 'schedule', operations);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<NativeScheduleMutationResult>('apply_schedule_mutation', {
    input: {
      seasonId,
      records,
      sourceRows,
      mods,
      deletedIds,
      history,
    },
  });
  return result.syncMeta;
}
