import type { SeasonWorkspaceChangeEvent } from '@/lib/seasonDataCache';

const FULL_REFRESH_SOURCES = new Set([
  'manual-fetch',
  'native-baseline-refresh',
  'native-baseline-merge',
]);
const EMPTY_TARGET_SYNC_SOURCES = new Set([
  'auto-sync',
  'remote-sync',
]);

type ParsedChangedTarget = {
  targetType: string;
  targetId: string;
};

function parseChangedTarget(rawTarget: string): ParsedChangedTarget | null {
  const separatorIndex = rawTarget.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= rawTarget.length - 1) return null;
  return {
    targetType: rawTarget.slice(0, separatorIndex),
    targetId: rawTarget.slice(separatorIndex + 1),
  };
}

export function shouldRefreshCheckInForWorkspaceChange(
  event: SeasonWorkspaceChangeEvent,
  visibleRecordIds: ReadonlySet<string>
): boolean {
  if (FULL_REFRESH_SOURCES.has(event.source)) return true;
  if (event.affectedIds.some((id) => visibleRecordIds.has(id))) return true;

  if (EMPTY_TARGET_SYNC_SOURCES.has(event.source) && event.changedTargets.length === 0) return false;

  for (const rawTarget of event.changedTargets) {
    const target = parseChangedTarget(rawTarget);
    if (!target) return true;
    if (target.targetType === 'sourceRow') return true;
    if (
      (target.targetType === 'flightRecord' || target.targetType === 'modification') &&
      visibleRecordIds.has(target.targetId)
    ) {
      return true;
    }
  }

  return event.changedTargets.length === 0;
}
