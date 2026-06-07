import { clearSeasonDataCache } from './seasonDataCache';
import { discardAllLocalPendingChanges } from './localSeasonStore';
import { resetUiUndoSession } from './uiUndoMemory';

const APP_LOCAL_STORAGE_KEYS = new Set([
  'seasonal-management-sidebar:expanded',
  'seasonal-management:last-route',
]);

function shouldPreserveLocalStorageKey(key: string, preserveAuth: boolean): boolean {
  if (!preserveAuth) return false;
  if (key.startsWith('sb-')) return true;
  return key.includes('supabase.auth.token');
}

function shouldClearLocalStorageKey(key: string): boolean {
  return APP_LOCAL_STORAGE_KEYS.has(key) ||
    key.startsWith('dashboard:aiNotebook:') ||
    key.startsWith('season-sync:') ||
    key.startsWith('seasonal-management:') ||
    key.startsWith('sidebar:') ||
    key.startsWith('route-cache:');
}

function clearAppOwnedWebStorage(preserveAuth: boolean): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage?.clear();

  const storage = window.localStorage;
  if (!storage) return;
  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    if (shouldPreserveLocalStorageKey(key, preserveAuth)) continue;
    if (shouldClearLocalStorageKey(key)) keysToRemove.push(key);
  }
  for (const key of keysToRemove) storage.removeItem(key);
}

export async function clearNativeAppSessionData(
  input: { preserveAuth?: boolean; discardPendingLocalChanges?: boolean; resetUndoSession?: boolean } = {}
): Promise<void> {
  const preserveAuth = input.preserveAuth ?? true;
  clearNativeAppEphemeralData({ preserveAuth });
  if (input.resetUndoSession ?? false) resetUiUndoSession();
  if (input.discardPendingLocalChanges ?? false) {
    await discardAllLocalPendingChanges();
  }
}

export function clearNativeAppEphemeralData(
  input: { preserveAuth?: boolean } = {}
): void {
  const preserveAuth = input.preserveAuth ?? true;
  clearAppOwnedWebStorage(preserveAuth);
  clearSeasonDataCache();
}
