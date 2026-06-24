import {
  queryNativeSyncSummary,
  resolveNativeSeasonConflict,
  runNativeSeasonCatchup,
  type NativeSeasonCatchupResult,
  type NativeSeasonConflictResolution,
  type NativeSeasonConflictResolveResult,
  type NativeSyncSummaryResult,
} from './nativeSeasonRepository';

export const LEGACY_NATIVE_SYNC_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_LEGACY_NATIVE_SYNC_REPAIR === 'true';

export type RunLegacyNativeCatchupInput = Parameters<typeof runNativeSeasonCatchup>[0];

export type ResolveLegacyNativeSeasonConflictInput = {
  seasonId: string;
  conflictId: string;
  resolution: NativeSeasonConflictResolution;
};

export function assertLegacyNativeSyncEnabled(): void {
  if (!LEGACY_NATIVE_SYNC_ENABLED) {
    throw new Error('Legacy native sync repair is disabled in online-first mode.');
  }
}

export async function runLegacyNativeCatchup(
  input: RunLegacyNativeCatchupInput
): Promise<NativeSeasonCatchupResult | null> {
  assertLegacyNativeSyncEnabled();
  return runNativeSeasonCatchup(input);
}

export async function queryLegacyNativeSyncSummary(
  seasonId: string
): Promise<NativeSyncSummaryResult | null> {
  assertLegacyNativeSyncEnabled();
  return queryNativeSyncSummary(seasonId);
}

export async function resolveLegacyNativeSeasonConflict(
  input: ResolveLegacyNativeSeasonConflictInput
): Promise<NativeSeasonConflictResolveResult | null> {
  assertLegacyNativeSyncEnabled();
  return resolveNativeSeasonConflict(input.seasonId, input.conflictId, input.resolution);
}
