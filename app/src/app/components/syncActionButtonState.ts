export interface SyncActionButtonStateInput {
  syncing: boolean;
  pendingCount: number;
  draftCount?: number;
  progress?: string | null;
}

export interface SyncActionButtonState {
  canSubmit: boolean;
  busy: boolean;
  disabled: boolean;
  disabledCursorClass: string;
  label: string;
  title: string;
}

export function getSyncActionButtonState({
  syncing,
  pendingCount,
  draftCount = 0,
  progress,
}: SyncActionButtonStateInput): SyncActionButtonState {
  const hasPending = pendingCount > 0;
  const hasDraft = draftCount > 0;
  const canSubmit = hasPending || hasDraft;
  const busy = syncing;
  const disabled = busy || !canSubmit;
  const disabledCursorClass = busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed';
  const label = busy ? 'Submitting...' : hasPending ? 'Save pending' : hasDraft ? 'Save draft' : 'No pending';

  let title: string;
  if (busy) {
    title = progress ?? (hasDraft && !hasPending ? 'Submitting draft changes' : 'Submitting pending changes');
  } else if (hasPending) {
    title = progress ?? 'Submit pending changes to server';
  } else if (hasDraft) {
    title = progress ?? 'Save draft changes to server';
  } else {
    title = 'No pending changes to submit';
  }

  return {
    canSubmit,
    busy,
    disabled,
    disabledCursorClass,
    label,
    title,
  };
}
