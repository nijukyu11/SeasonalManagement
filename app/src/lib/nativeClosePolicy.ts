export const NATIVE_CLOSE_CONFIRM_COPY = {
  title: 'Close app?',
  message: 'Closing the app will discard unsynced local edits and Undo history. Downloaded season data stays in the local database.',
  confirmLabel: 'Close App',
  cancelLabel: 'Cancel',
} as const;

export function shouldPreserveDurableLocalDataOnNativeClose(): boolean {
  return true;
}
