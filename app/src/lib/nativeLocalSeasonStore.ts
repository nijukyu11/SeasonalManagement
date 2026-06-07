import type { LocalSyncMeta } from './localSeasonStore';
import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow } from './types';
import { isTauriRuntime } from './nativeRuntime';

export interface NativeLocalModificationBatchDeltaResult {
  syncMeta: LocalSyncMeta;
  affectedIds: string[];
}

export interface NativeScheduleMutationResult {
  syncMeta: LocalSyncMeta;
}

export function isNativeLocalStoreRuntime(): boolean {
  return isTauriRuntime();
}

export async function runNativeLocalModificationBatchDeltaResult(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>
): Promise<NativeLocalModificationBatchDeltaResult | null> {
  if (!isNativeLocalStoreRuntime()) return null;
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
  history?: Pick<ModHistoryEntry, 'id' | 'timestamp' | 'description' | 'scheduleNotification'>
): Promise<LocalSyncMeta | null> {
  const result = await runNativeLocalModificationBatchDeltaResult(seasonId, mods, history);
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
