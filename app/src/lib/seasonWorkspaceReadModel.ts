import type { FlightModification, FlightRecord, ParsedRow, Season } from './types';
import type { LocalSyncMeta } from './localSeasonStore';
import type { SeasonWorkspaceSlice } from './seasonWorkspaceStore';

export const WORKSPACE_WINDOW_CACHE_TTL_MS = 10 * 60_000;

export interface WorkspaceWindowCacheKeyInput {
  route: string;
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  resourceType?: string | null;
  filter?: string | null;
}

export interface WorkspaceWindowRefreshInput {
  cachedAt: number | null | undefined;
  now: number;
  stale: boolean;
  ttlMs: number;
}

export interface CachedWorkspaceWindow {
  season: Season | null;
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
  windowKey: string;
}

export function buildWorkspaceWindowCacheKey(input: WorkspaceWindowCacheKeyInput): string {
  return [
    input.route,
    input.seasonId,
    input.dateFrom ?? '',
    input.dateTo ?? '',
    input.resourceType ?? '',
    input.filter ?? '',
  ].join('|');
}

export function shouldRefreshWorkspaceWindow(input: WorkspaceWindowRefreshInput): boolean {
  if (input.stale) return true;
  if (!input.cachedAt) return true;
  return input.now - input.cachedAt > input.ttlMs;
}

export function readCachedWorkspaceWindow(
  workspace: SeasonWorkspaceSlice | undefined,
  windowKey: string,
  now = Date.now(),
  ttlMs = WORKSPACE_WINDOW_CACHE_TTL_MS
): CachedWorkspaceWindow | null {
  if (!workspace) return null;
  const cachedWindowIds = workspace.windowIds.get(windowKey);
  if (!cachedWindowIds) return null;
  if (shouldRefreshWorkspaceWindow({
    cachedAt: workspace.updatedAt,
    now,
    stale: workspace.staleWindowKeys.has(windowKey),
    ttlMs,
  })) {
    return null;
  }
  const records = cachedWindowIds
    .map((id) => workspace.recordsById.get(id))
    .filter((record): record is FlightRecord => Boolean(record));
  if (records.length !== cachedWindowIds.length) return null;
  return {
    season: workspace.season,
    rows: workspace.rows,
    records,
    modifications: new Map(workspace.modificationsByLegId),
    syncMeta: workspace.syncMeta,
    windowKey,
  };
}
