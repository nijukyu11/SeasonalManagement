export interface SeasonalFileActionBlock {
  code: 'busy' | 'draft' | 'no-selection' | 'stale-selection';
  message: string;
}

export function getSeasonalFileActionBlock(input: {
  action: 'import' | 'export';
  hasDraftChanges: boolean;
  busy: boolean;
  selectedCount?: number;
  staleSelectionCount?: number;
}): SeasonalFileActionBlock | null {
  if (input.busy) {
    return {
      code: 'busy',
      message: 'Another Seasonal operation is still running.',
    };
  }
  if (input.hasDraftChanges) {
    return {
      code: 'draft',
      message: `Save or discard the Seasonal draft before ${input.action}.`,
    };
  }
  if (input.action === 'export' && (input.staleSelectionCount ?? 0) > 0) {
    return {
      code: 'stale-selection',
      message: 'Selected flights are no longer available. Review the selection before export.',
    };
  }
  if (input.action === 'export' && (input.selectedCount ?? 0) === 0) {
    return {
      code: 'no-selection',
      message: 'Select at least one flight before export.',
    };
  }
  return null;
}

export function reconcileSeasonalSelection(
  selectedIds: string[],
  availableIds: Set<string>,
): { matchedIds: string[]; unknownIds: string[] } {
  return {
    matchedIds: selectedIds.filter((id) => availableIds.has(id)),
    unknownIds: selectedIds.filter((id) => !availableIds.has(id)),
  };
}
