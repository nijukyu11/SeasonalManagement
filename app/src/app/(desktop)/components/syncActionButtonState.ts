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
  const label = busy ? 'Đang lưu...' : hasPending ? 'Lưu thay đổi' : hasDraft ? 'Lưu bản nháp' : 'Không có thay đổi';

  let title: string;
  if (busy) {
    title = progress ?? (hasDraft && !hasPending ? 'Đang lưu thay đổi bản nháp' : 'Đang lưu thay đổi');
  } else if (hasPending) {
    title = progress ?? 'Lưu thay đổi lên máy chủ';
  } else if (hasDraft) {
    title = progress ?? 'Lưu thay đổi bản nháp lên máy chủ';
  } else {
    title = 'Không có thay đổi cần lưu';
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
