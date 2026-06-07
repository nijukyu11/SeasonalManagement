import {
  loadLocalSeasonWorkspace,
  saveLocalSeasonWorkspace,
  type LocalSeasonWorkspace,
} from './localSeasonStore';
import {
  resolveSeasonConflict,
  type SeasonConflictResolution,
} from './seasonChangeEvents';
import { patchCachedSeasonData, publishSeasonWorkspaceChanged } from './seasonDataCache';

export async function resolveLocalSeasonConflict(
  seasonId: string,
  conflictId: string,
  resolution: SeasonConflictResolution
): Promise<LocalSeasonWorkspace> {
  const workspace = await loadLocalSeasonWorkspace(seasonId);
  if (!workspace) throw new Error(`Local season workspace ${seasonId} not found`);
  if (resolution === 'editManually') return workspace;

  const nextWorkspace = resolveSeasonConflict(workspace, conflictId, resolution);
  await saveLocalSeasonWorkspace(nextWorkspace, { nativeFullSaveReason: 'sync-baseline' });
  patchCachedSeasonData(seasonId, {
    rows: nextWorkspace.rows,
    records: nextWorkspace.records,
    modifications: nextWorkspace.modifications,
  });
  publishSeasonWorkspaceChanged({
    seasonId,
    localRevision: nextWorkspace.syncMeta.localRevision,
    source: 'conflict-review',
  });
  return nextWorkspace;
}
