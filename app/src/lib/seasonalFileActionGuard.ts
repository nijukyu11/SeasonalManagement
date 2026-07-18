import type { FlightModification, FlightRecord } from './types.ts';

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

export interface SeasonalFileActionOperation {
  token: number;
  action: 'import' | 'export';
  seasonId: string | null;
  draftRevision: number;
}

export interface SeasonalMutationOperation {
  token: number;
}

export interface SeasonalFileActionInvalidation {
  code: 'operation-replaced' | 'season-changed' | 'draft-changed';
  message: string;
}

export interface SeasonalFileActionController {
  beginFileAction(
    action: SeasonalFileActionOperation['action'],
    context: Pick<SeasonalFileActionOperation, 'seasonId' | 'draftRevision'>,
  ): SeasonalFileActionOperation | null;
  validateFileAction(
    operation: SeasonalFileActionOperation,
    latest: {
      seasonId: string | null;
      draftRevision: number;
      hasDraftChanges: boolean;
    },
  ): SeasonalFileActionInvalidation | null;
  finishFileAction(operation: SeasonalFileActionOperation): void;
  beginMutation(): SeasonalMutationOperation | null;
  finishMutation(operation: SeasonalMutationOperation): void;
  isFileActionActive(): boolean;
  isMutationActive(): boolean;
}

export function createSeasonalFileActionController(): SeasonalFileActionController {
  let nextToken = 1;
  let activeFileAction: SeasonalFileActionOperation | null = null;
  let activeMutation: SeasonalMutationOperation | null = null;

  return {
    beginFileAction(action, context) {
      if (activeFileAction || activeMutation) return null;
      activeFileAction = {
        token: nextToken++,
        action,
        seasonId: context.seasonId,
        draftRevision: context.draftRevision,
      };
      return activeFileAction;
    },
    validateFileAction(operation, latest) {
      if (!activeFileAction || activeFileAction.token !== operation.token) {
        return {
          code: 'operation-replaced',
          message: 'This Seasonal file action is no longer current.',
        };
      }
      if (latest.seasonId !== operation.seasonId) {
        return {
          code: 'season-changed',
          message: 'The active season changed while the file action was running.',
        };
      }
      if (latest.draftRevision !== operation.draftRevision || latest.hasDraftChanges) {
        return {
          code: 'draft-changed',
          message: 'The Seasonal draft changed while the file action was running.',
        };
      }
      return null;
    },
    finishFileAction(operation) {
      if (activeFileAction?.token === operation.token) activeFileAction = null;
    },
    beginMutation() {
      if (activeFileAction || activeMutation) return null;
      activeMutation = { token: nextToken++ };
      return activeMutation;
    },
    finishMutation(operation) {
      if (activeMutation?.token === operation.token) activeMutation = null;
    },
    isFileActionActive() {
      return activeFileAction !== null;
    },
    isMutationActive() {
      return activeMutation !== null;
    },
  };
}

export function buildSeasonalAvailableRecordIds(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>,
): Set<string> {
  const deletedIds = new Set<string>();
  for (const modification of modifications.values()) {
    if (modification.action === 'deleted') deletedIds.add(modification.legId);
  }

  const availableIds = new Set<string>();
  for (const record of records) {
    if (
      record.status !== 'deleted'
      && record.action !== 'deleted'
      && !deletedIds.has(record.id)
    ) {
      availableIds.add(record.id);
    }
  }

  for (const modification of modifications.values()) {
    if (modification.action !== 'added' || !modification.addedLeg) continue;
    const addedId = modification.addedLeg.id.trim();
    if (
      !addedId
      || addedId !== modification.legId
      || modification.addedLeg.action === 'deleted'
      || deletedIds.has(addedId)
    ) {
      continue;
    }
    availableIds.add(addedId);
  }

  return availableIds;
}
