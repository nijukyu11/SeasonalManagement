import { getSupabaseClient } from './supabase';
import { isTauriRuntime } from './nativeRuntime';
import type { LocalSyncMeta } from './localSeasonStore';
import type { FlightModification, FlightRecord, Season } from './types';
import { getOrCreateSeasonClientId } from './seasonChangeEvents';

export interface NativeSeasonCatchupProgress {
  seasonId: string;
  cancellationId: string;
  committedPages: number;
  appliedEvents: number;
  lastServerSeq: number;
  serverHighWater: number;
  changedTargets: string[];
  checkpoint?: 'passive' | null;
}

export interface NativeSeasonCatchupResult {
  seasonId: string;
  committedPages: number;
  appliedEvents: number;
  conflictCount: number;
  changedTargets: string[];
  lastServerSeq: number;
  checkpointCount: number;
  reconciledFlightRows: number;
  reconciledModificationRows: number;
  reconciledEntityVersions: number;
}

export interface RunNativeSeasonCatchupInput {
  seasonId: string;
  clientId: string;
  localCursor: number;
  serverHighWater: number;
  pageSize?: number;
  reconcileManifest?: boolean;
  onProgress?: (progress: NativeSeasonCatchupProgress) => void;
}

export interface NativeSeasonIntegrityResult {
  seasonId: string;
  ok: boolean;
  sourceRows: number;
  baseSourceRows: number;
  records: number;
  baseRecords: number;
  pendingOps: number;
  pendingCount: number;
  syncStatus: string;
  lastServerSeq?: number | null;
}

export interface EnsureNativeLocalSeasonResult {
  seasonId: string;
  syncMeta: LocalSyncMeta;
}

export interface NativeSeasonSnapshotImportInput {
  season: Season;
  sourceRows: unknown[];
  records: FlightRecord[];
  modifications: FlightModification[];
  modHistory: unknown[];
  serverEventHighWater: number;
  entityVersions: Record<string, Record<string, number>>;
}

export interface NativeSeasonSnapshotImportResult {
  seasonId: string;
  sourceRows: number;
  records: number;
  modifications: number;
  modHistory: number;
  lastServerSeq: number;
  syncMeta: LocalSyncMeta;
}

export interface NativeSeasonFreshnessResult {
  seasonId: string;
  exists: boolean;
  localDataVersion?: number | null;
  baseServerVersion?: number | null;
  lastServerSeq?: number | null;
  pendingCount: number;
  conflictCount: number;
  recordCount: number;
  baseRecordCount: number;
}

export interface NativeSeasonSnapshotMergeInput extends NativeSeasonSnapshotImportInput {
  clientId?: string;
}

export interface NativeSeasonSnapshotMergeResult extends NativeSeasonSnapshotImportResult {
  mergedPendingCount: number;
  conflictCount: number;
  conflicts: unknown[];
}

export type NativeSeasonConflictResolution = 'keepMine' | 'acceptRemote';

export interface NativeSeasonConflictResolveResult {
  seasonId: string;
  conflictCount: number;
  syncMeta: LocalSyncMeta;
}

export interface NativeScheduleWindowInput {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  flightNumberFilter?: string | null;
  routeFilter?: string | null;
  typeFilter?: string | null;
  statusFilter?: string | null;
  limit?: number;
  offset?: number;
}

export interface NativeScheduleWindowResult {
  seasonId: string;
  records: FlightRecord[];
  modifications: FlightModification[];
  total: number;
  rawTotal: number;
  effectiveTotal: number;
  arrivalTotal: number;
  departureTotal: number;
  deletedModificationTotal: number;
  truncated: boolean;
  syncMeta: LocalSyncMeta;
}

export interface NativeAllocationWindowInput extends NativeScheduleWindowInput {
  resourceType?: 'gate' | 'stand' | 'counter' | 'checkin' | 'check-in' | null;
  resourceIds?: string[];
}

export interface NativeSyncSummaryResult {
  seasonId: string;
  pendingCount: number;
  conflictCount: number;
  syncStatus: string;
  lastLocalChangeAt?: number | null;
  lastServerSeq?: number | null;
  localRevision: number;
}

export interface NativeConflictSummaryResult {
  seasonId: string;
  conflictCount: number;
  conflicts: unknown[];
}

export interface NativeSourceRowsWindowInput {
  seasonId: string;
  search?: string | null;
  effectiveFrom?: string | null;
  discontinueTo?: string | null;
  limit?: number;
  offset?: number;
}

export interface NativeSourceRowsWindowResult {
  seasonId: string;
  rows: unknown[];
  total: number;
  syncMeta: LocalSyncMeta;
}

export interface NativeDashboardSummaryInput {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface NativeDashboardSummaryResult {
  seasonId: string;
  totalRecords: number;
  arrivalRecords: number;
  departureRecords: number;
  deletedRecords: number;
  totalPax: number;
  syncMeta: LocalSyncMeta;
}

export type NativeDashboardAiSqlValue = string | number | boolean | null;

export interface NativeDashboardAiSqlInput {
  sql: string;
  params?: NativeDashboardAiSqlValue[];
  limit?: number;
}

export interface NativeDashboardAiSqlResult {
  columns: string[];
  rows: Record<string, NativeDashboardAiSqlValue>[];
  rowCount: number;
  truncated: boolean;
  executedSqlPreview: string;
  dataQualityNotes: string[];
}

export interface NativeDiscardSessionEditsResult {
  discardedCount: number;
  syncMeta: LocalSyncMeta;
}

export interface NativeSyncPendingChangesResult {
  status: 'synced' | 'failed' | 'conflict';
  message: string;
  pendingCount: number;
  conflictCount: number;
  notificationSent: number;
  notificationFailed: number;
  notificationSkipped: number;
  notificationFlushError?: string | null;
}

export { isTauriRuntime } from './nativeRuntime';

function randomCancellationId(seasonId: string): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `season-catchup:${seasonId}:${suffix}`;
}

async function currentAccessToken(): Promise<string | null> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

async function refreshedAccessToken(): Promise<string | null> {
  const { data, error } = await getSupabaseClient().auth.refreshSession();
  if (!error && data.session?.access_token) return data.session.access_token;
  return currentAccessToken();
}

export async function runNativeSeasonCatchup(
  input: RunNativeSeasonCatchupInput
): Promise<NativeSeasonCatchupResult | null> {
  if (!isTauriRuntime()) return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;

  const accessToken = await currentAccessToken();
  if (!accessToken) return null;

  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  const cancellationId = randomCancellationId(input.seasonId);
  const unlistenTokenRequired = await listen<{ seasonId: string; cancellationId: string }>(
    'season-catchup-token-required',
    async (event) => {
      if (event.payload.cancellationId !== cancellationId) return;
      const refreshedToken = await refreshedAccessToken();
      if (!refreshedToken) return;
      await invoke('refresh_season_catchup_token', {
        input: {
          cancellationId,
          accessToken: refreshedToken,
        },
      });
    }
  );
  const unlistenProgress = await listen<NativeSeasonCatchupProgress>(
    'season-catchup-progress',
    (event) => {
      if (event.payload.cancellationId !== cancellationId) return;
      input.onProgress?.(event.payload);
    }
  );

  try {
    return await invoke<NativeSeasonCatchupResult>('run_season_catchup', {
      input: {
        seasonId: input.seasonId,
        supabaseUrl,
        anonKey,
        accessToken,
        clientId: input.clientId,
        localCursor: input.localCursor,
        serverHighWater: input.serverHighWater,
        pageSize: input.pageSize ?? 200,
        cancellationId,
        reconcileManifest: input.reconcileManifest ?? false,
      },
    });
  } finally {
    unlistenTokenRequired();
    unlistenProgress();
  }
}

async function invokeNative<T>(command: string, input: unknown): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, { input });
}

export async function checkNativeSeasonIntegrity(
  seasonId: string
): Promise<NativeSeasonIntegrityResult | null> {
  return invokeNative<NativeSeasonIntegrityResult>('check_season_integrity', { seasonId });
}

export async function ensureNativeLocalSeason(
  season: Season
): Promise<LocalSyncMeta | null> {
  const result = await invokeNative<EnsureNativeLocalSeasonResult>('ensure_local_season', { season });
  return result?.syncMeta ?? null;
}

export async function importNativeSeasonSnapshot(
  input: NativeSeasonSnapshotImportInput
): Promise<NativeSeasonSnapshotImportResult | null> {
  return invokeNative<NativeSeasonSnapshotImportResult>('import_season_snapshot', input);
}

export async function queryNativeSeasonFreshness(
  seasonId: string
): Promise<NativeSeasonFreshnessResult | null> {
  return invokeNative<NativeSeasonFreshnessResult>('query_season_freshness', { seasonId });
}

export async function mergeNativeSeasonSnapshot(
  input: NativeSeasonSnapshotMergeInput
): Promise<NativeSeasonSnapshotMergeResult | null> {
  return invokeNative<NativeSeasonSnapshotMergeResult>('merge_season_snapshot', input);
}

export async function queryNativeScheduleWindow(
  input: NativeScheduleWindowInput
): Promise<NativeScheduleWindowResult | null> {
  return invokeNative<NativeScheduleWindowResult>('query_schedule_window', input);
}

export async function queryNativeAllocationWindow(
  input: NativeAllocationWindowInput
): Promise<NativeScheduleWindowResult | null> {
  return invokeNative<NativeScheduleWindowResult>('query_allocation_window', input);
}

export async function queryNativeSyncSummary(
  seasonId: string
): Promise<NativeSyncSummaryResult | null> {
  return invokeNative<NativeSyncSummaryResult>('query_sync_summary', { seasonId });
}

export async function queryNativeConflictSummary(
  seasonId: string
): Promise<NativeConflictSummaryResult | null> {
  return invokeNative<NativeConflictSummaryResult>('query_conflict_summary', { seasonId });
}

export async function resolveNativeSeasonConflict(
  seasonId: string,
  conflictId: string,
  resolution: NativeSeasonConflictResolution
): Promise<NativeSeasonConflictResolveResult | null> {
  return invokeNative<NativeSeasonConflictResolveResult>('resolve_season_conflict', {
    seasonId,
    conflictId,
    resolution,
  });
}

export async function queryNativeSourceRowsWindow(
  input: NativeSourceRowsWindowInput
): Promise<NativeSourceRowsWindowResult | null> {
  return invokeNative<NativeSourceRowsWindowResult>('query_source_rows_window', input);
}

export async function queryNativeDashboardSummary(
  input: NativeDashboardSummaryInput
): Promise<NativeDashboardSummaryResult | null> {
  return invokeNative<NativeDashboardSummaryResult>('query_dashboard_summary', input);
}

export async function queryNativeDashboardAiSql(
  input: NativeDashboardAiSqlInput
): Promise<NativeDashboardAiSqlResult | null> {
  return invokeNative<NativeDashboardAiSqlResult>('query_native_dashboard_ai_sql', input);
}

export async function callNativeDashboardAiAgent(payload: unknown): Promise<unknown | null> {
  if (!isTauriRuntime()) return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Thiếu cấu hình Supabase để tải provider key cho Python AI Agent.');
  const accessToken = await currentAccessToken();
  if (!accessToken) throw new Error('Cần đăng nhập operator để tải provider key cho Python AI Agent.');
  return invokeNative<unknown>('call_dashboard_ai_agent', {
    payload,
    supabaseUrl,
    anonKey,
    accessToken,
  });
}

export async function queryNativeDashboardAiAgentHealth(): Promise<{ healthy: boolean; status: string } | null> {
  if (!isTauriRuntime()) return null;
  return invokeNative<{ healthy: boolean; status: string }>('dashboard_ai_agent_health', {});
}

export async function discardNativeSessionEdits(
  seasonId: string
): Promise<NativeDiscardSessionEditsResult | null> {
  return invokeNative<NativeDiscardSessionEditsResult>('discard_session_edits', { seasonId });
}

export async function syncNativePendingChanges(
  seasonId: string
): Promise<NativeSyncPendingChangesResult | null> {
  if (!isTauriRuntime()) return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const accessToken = await currentAccessToken();
  if (!accessToken) return null;
  return invokeNative<NativeSyncPendingChangesResult>('sync_pending_changes', {
    seasonId,
    supabaseUrl,
    anonKey,
    accessToken,
    clientId: getOrCreateSeasonClientId(),
  });
}
