import { getDirtyImportGuard } from './importSeasonRules.ts';
import { getSeasonalFileActionBlock } from './seasonalFileActionGuard.ts';

export interface SeasonalRepairImportBlock {
  code: 'busy' | 'draft' | 'pending';
  message: string;
}

export function getSeasonalRepairImportBlock(input: {
  targetSeasonId: string | null;
  targetSeasonCode: string;
  activeSeasonId?: string | null;
  hasDraftChanges: boolean;
  pendingCount: number;
  conflictCount?: number | null;
  busy: boolean;
}): SeasonalRepairImportBlock | null {
  const fileBlock = getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: input.hasDraftChanges,
    busy: input.busy,
  });
  if (fileBlock?.code === 'busy' || fileBlock?.code === 'draft') {
    return { code: fileBlock.code, message: fileBlock.message };
  }

  const dirtyBlock = getDirtyImportGuard(input);
  if (!dirtyBlock.shouldBlock) return null;
  return {
    code: 'pending',
    message: `${dirtyBlock.message} Save or discard those changes before import.`,
  };
}
