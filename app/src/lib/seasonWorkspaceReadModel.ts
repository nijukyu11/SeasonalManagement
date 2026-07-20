import type { FlightModification, FlightRecord, ParsedRow, Season } from './types';
import type { LocalSyncMeta } from './localSeasonStore';
import type {
  SeasonWorkspaceSlice,
  SeasonWorkspaceWindowMetadata,
} from './seasonWorkspaceStore';

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
  metadata: SeasonWorkspaceWindowMetadata;
}

export function buildWorkspaceWindowCacheKey(input: WorkspaceWindowCacheKeyInput): string {
  return [input.route, input.seasonId, input.dateFrom ?? '', input.dateTo ?? '', input.resourceType ?? '', input.filter ?? ''].join('|');
}

export function shouldRefreshWorkspaceWindow(input: WorkspaceWindowRefreshInput): boolean {
  if (input.stale) return true;
  if (input.cachedAt == null) return true;
  return input.now - input.cachedAt > input.ttlMs;
}

export function readWorkspaceWindowSnapshot(
  workspace: SeasonWorkspaceSlice | undefined,
  windowKey: string,
): CachedWorkspaceWindow | null {
  const snapshot = workspace?.windowSnapshots.get(windowKey);
  const metadata = workspace?.windowMetadata.get(windowKey);
  if (!workspace || !snapshot || !metadata) return null;
  const snapshotHighWater = metadata.serverHighWater ?? -1;
  const records = snapshot.records.map((record) => {
    if ((workspace.recordServerHighWater.get(record.id) ?? -1) > snapshotHighWater) {
      return workspace.recordsById.get(record.id) ?? record;
    }
    return record;
  });
  const modifications = new Map<string, FlightModification>();
  for (const [legId, modification] of snapshot.modifications) {
    if ((workspace.modificationServerHighWater.get(legId) ?? -1) > snapshotHighWater) {
      modifications.set(legId, workspace.modificationsByLegId.get(legId) ?? modification);
    } else {
      modifications.set(legId, modification);
    }
  }
  return {
    season: workspace.season,
    rows: snapshot.rows,
    records,
    modifications,
    syncMeta: snapshot.syncMeta,
    windowKey,
    metadata,
  };
}

export function readCachedWorkspaceWindow(
  workspace: SeasonWorkspaceSlice | undefined,
  windowKey: string,
  now = Date.now(),
  ttlMs = WORKSPACE_WINDOW_CACHE_TTL_MS,
): CachedWorkspaceWindow | null {
  const snapshot = readWorkspaceWindowSnapshot(workspace, windowKey);
  if (!snapshot) return null;
  if (shouldRefreshWorkspaceWindow({
    cachedAt: snapshot.metadata.fetchedAt,
    now,
    stale: snapshot.metadata.staleReason !== null,
    ttlMs,
  })) return null;
  return snapshot;
}
