export interface SeasonalFileActionRuntimeState {
  hasDraftChanges: boolean;
  draftRevision: number;
}

const runtimeStateBySeason = new Map<string, SeasonalFileActionRuntimeState>();

export function setSeasonalFileActionRuntimeState(
  seasonId: string,
  state: SeasonalFileActionRuntimeState,
): void {
  runtimeStateBySeason.set(seasonId, { ...state });
}

export function getSeasonalFileActionRuntimeState(
  seasonId: string | null | undefined,
): SeasonalFileActionRuntimeState {
  if (!seasonId) return { hasDraftChanges: false, draftRevision: 0 };
  return runtimeStateBySeason.get(seasonId) ?? { hasDraftChanges: false, draftRevision: 0 };
}

export function clearSeasonalFileActionRuntimeState(seasonId: string): void {
  runtimeStateBySeason.delete(seasonId);
}
