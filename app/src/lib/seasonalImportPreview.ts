import type {
  SeasonalImportV3CommittedResult,
  SeasonalImportV3StageResult,
  SeasonalImportV3Strategy,
} from './seasonalImportV3Contract.ts';

export type SeasonalImportPreviewState =
  | { kind: 'idle' }
  | { kind: 'staging'; strategy: SeasonalImportV3Strategy }
  | { kind: 'preview'; result: SeasonalImportV3StageResult; confirmation: string }
  | { kind: 'committing'; result: SeasonalImportV3StageResult }
  | { kind: 'committed-refresh-pending'; result: SeasonalImportV3CommittedResult };

export function canCommitSeasonalImportPreview(input: {
  state: SeasonalImportPreviewState;
  hasDraftChanges: boolean;
  busy: boolean;
}): boolean {
  if (input.state.kind !== 'preview') return false;
  const { result, confirmation } = input.state;
  return result.valid
    && result.status === 'validated'
    && (result.strategy === 'merge' || confirmation === result.seasonCode)
    && !input.hasDraftChanges
    && !input.busy;
}
