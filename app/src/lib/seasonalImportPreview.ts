import type {
  SeasonalDraftImportCommittedResult,
  SeasonalDraftImportPreviewResult,
} from './seasonalDraftImportContract.ts';

export type SeasonalImportPreviewState =
  | { kind: 'idle' }
  | { kind: 'staging' }
  | { kind: 'preview'; result: SeasonalDraftImportPreviewResult; confirmation: string }
  | { kind: 'committing'; result: SeasonalDraftImportPreviewResult }
  | { kind: 'committed-refresh-pending'; result: SeasonalDraftImportCommittedResult };

export function canCommitSeasonalImportPreview(input: {
  state: SeasonalImportPreviewState;
  hasDraftChanges: boolean;
  busy: boolean;
  previewError?: boolean;
  isStale?: boolean;
}): boolean {
  if (input.state.kind !== 'preview') return false;
  if (input.previewError || input.isStale) return false;
  const { result, confirmation } = input.state;
  const confirmationValid = confirmation.trim().toUpperCase() === result.seasonCode.trim().toUpperCase();

  return result.valid
    && result.status === 'validated'
    && confirmationValid
    && !input.hasDraftChanges
    && !input.busy;
}
