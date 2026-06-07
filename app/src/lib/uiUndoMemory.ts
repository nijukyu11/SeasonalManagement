export const MAX_UI_UNDO_ENTRIES = 20;
const UI_UNDO_SESSION_RESET_AT_KEY = 'seasonal-management:ui-undo-reset-at';

export function trimUiUndoEntries<T>(entries: T[], limit = MAX_UI_UNDO_ENTRIES): T[] {
  return entries.length > limit ? entries.slice(0, limit) : entries;
}

export function trimUiUndoStack<T>(entries: T[], limit = MAX_UI_UNDO_ENTRIES): T[] {
  return entries.length > limit ? entries.slice(entries.length - limit) : entries;
}

function getUiUndoSessionResetAt(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.sessionStorage?.getItem(UI_UNDO_SESSION_RESET_AT_KEY);
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function resetUiUndoSession(resetAt = Date.now()): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage?.setItem(UI_UNDO_SESSION_RESET_AT_KEY, String(resetAt));
}

export function filterUiUndoEntriesForSession<T extends { timestamp?: number }>(entries: T[]): T[] {
  const resetAt = getUiUndoSessionResetAt();
  if (resetAt <= 0) return entries;
  return entries.filter((entry) => Number(entry.timestamp ?? 0) >= resetAt);
}
