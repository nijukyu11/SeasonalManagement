import { useSyncExternalStore } from 'react';
function extractUserIdFromSupabaseAuthPayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const directUserId = parsed.user?.id ?? parsed.currentSession?.user?.id ?? (Array.isArray(parsed) ? parsed[2]?.id : null);
    if (typeof directUserId === 'string' && directUserId.trim().length > 0) {
      return directUserId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function getSynchronousOperatorUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const storage = window.localStorage;
  if (!storage) return null;
  const candidateKeys = [
    'seasonal-management-supabase-auth-token',
    'sb-rhmehiinfchiiuqmdukz-auth-token',
    'sb-supabase-auth-token',
  ];
  for (const k of candidateKeys) {
    const raw = storage.getItem(k);
    const userId = extractUserIdFromSupabaseAuthPayload(raw);
    if (userId) return userId;
  }
  return null;
}
import {
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
  registerOperatorSessionCacheClearer,
} from './operatorSessionCacheRegistry.ts';

export const SEASONAL_RESTORE_ATTEMPT_PREFIX = 'seasonal:pending-restore:v1';

export class SeasonalRestoreStorageError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SeasonalRestoreStorageError';
    this.cause = cause;
  }
}

export interface SeasonalRestoreAttemptPayload {
  contractVersion: 1;
  ownerUserId: string;
  seasonId: string;
  seasonCode: string;
  versionId: string;
  versionTag: string;
  requestId: string;
  expectedRevision: string;
  expectedEpoch: string;
  startedAt: number;
  status: 'executing' | 'unresolved' | 'committed';
  error?: string | null;
}

export function getSeasonalRestoreAttemptStorageKey(operatorId: string): string {
  const op = operatorId.trim();
  if (!op) {
    throw new SeasonalRestoreStorageError('An authorized operator session is required for seasonal restore storage key.');
  }
  return `${SEASONAL_RESTORE_ATTEMPT_PREFIX}:${op}`;
}

function getSafeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// In-memory active execution tracking with operator session fence
let inMemoryExecutingAttempt: SeasonalRestoreAttemptPayload | null = null;
let inMemoryAttemptEpoch = 0;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

// Register with operator session cache registry to clear in-memory state on auth/epoch change
registerOperatorSessionCacheClearer('seasonal-restore-journal', () => {
  inMemoryExecutingAttempt = null;
  inMemoryAttemptEpoch = getOperatorSessionEpoch();
  notifyListeners();
});

export function subscribeToSeasonalRestoreState(listener: () => void): () => void {
  listeners.add(listener);

  const handleStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(SEASONAL_RESTORE_ATTEMPT_PREFIX)) {
      notifyListeners();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage);
  }

  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage);
    }
  };
}

export function setSeasonalRestoreExecuting(
  executing: boolean,
  attempt?: SeasonalRestoreAttemptPayload | null,
): void {
  if (executing && attempt) {
    const ownerUserId = attempt.ownerUserId?.trim();
    if (!ownerUserId) {
      throw new SeasonalRestoreStorageError('An authenticated operator is required to set executing restore attempt.');
    }
    inMemoryExecutingAttempt = { ...attempt, status: 'executing' };
    inMemoryAttemptEpoch = getOperatorSessionEpoch();
  } else {
    inMemoryExecutingAttempt = null;
  }
  notifyListeners();
}

export function getExecutingSeasonalRestoreAttempt(expectedOperatorId?: string | null): SeasonalRestoreAttemptPayload | null {
  if (!inMemoryExecutingAttempt) return null;
  if (!isOperatorSessionEpochCurrent(inMemoryAttemptEpoch)) {
    inMemoryExecutingAttempt = null;
    return null;
  }
  const currentOperatorId = expectedOperatorId !== undefined ? expectedOperatorId : getSynchronousOperatorUserId();
  if (!currentOperatorId || inMemoryExecutingAttempt.ownerUserId !== currentOperatorId) {
    return null;
  }
  return inMemoryExecutingAttempt;
}

export function persistSeasonalRestoreAttempt(
  storageInput: Storage | null | undefined,
  attempt: SeasonalRestoreAttemptPayload,
): void {
  const ownerUserId = attempt.ownerUserId?.trim();
  if (!ownerUserId) {
    throw new SeasonalRestoreStorageError('An authenticated operator is required to persist seasonal restore attempt.');
  }

  const storage = storageInput ?? getSafeStorage();
  if (!storage) {
    throw new SeasonalRestoreStorageError('Storage is unavailable. Cannot proceed with restore without durable journal.');
  }

  const key = getSeasonalRestoreAttemptStorageKey(ownerUserId);
  try {
    storage.setItem(key, JSON.stringify(attempt));
  } catch (err) {
    throw new SeasonalRestoreStorageError('Failed to persist seasonal restore attempt before RPC execution.', err);
  }
  notifyListeners();
}

export function loadSeasonalRestoreAttempt(
  storageInput?: Storage | null,
  scope?: { seasonId?: string | null; ownerUserId?: string | null },
): SeasonalRestoreAttemptPayload | null {
  const ownerUserId = scope?.ownerUserId ?? getSynchronousOperatorUserId();
  if (!ownerUserId || ownerUserId.trim().length === 0) {
    return null;
  }

  const storage = storageInput ?? getSafeStorage();
  if (!storage) return null;

  const key = getSeasonalRestoreAttemptStorageKey(ownerUserId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SeasonalRestoreAttemptPayload;
    if (!parsed || parsed.contractVersion !== 1 || !parsed.requestId || !parsed.versionId) {
      return null;
    }
    // Strict ownership verification: cannot hydrate another operator's journal!
    if (parsed.ownerUserId !== ownerUserId) {
      return null;
    }
    if (scope?.seasonId && parsed.seasonId !== scope.seasonId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function markSeasonalRestoreAttemptStatus(
  storageInput: Storage | null | undefined,
  seasonId: string,
  requestId: string,
  status: 'executing' | 'unresolved' | 'committed',
  error?: string | null,
  scope?: { ownerUserId?: string | null },
): SeasonalRestoreAttemptPayload | null {
  const ownerUserId = scope?.ownerUserId ?? getSynchronousOperatorUserId();
  if (!ownerUserId) {
    throw new SeasonalRestoreStorageError('An authenticated operator is required to update restore attempt status.');
  }

  const storage = storageInput ?? getSafeStorage();
  if (!storage) {
    throw new SeasonalRestoreStorageError('Storage is unavailable. Cannot update restore attempt status.');
  }

  const current = loadSeasonalRestoreAttempt(storage, { seasonId, ownerUserId });
  if (!current || current.requestId !== requestId) {
    return null;
  }

  const updated: SeasonalRestoreAttemptPayload = {
    ...current,
    status,
    error: error !== undefined ? error : current.error,
  };

  persistSeasonalRestoreAttempt(storage, updated);
  return updated;
}

export function clearSeasonalRestoreAttempt(
  storageInput: Storage | null | undefined,
  seasonId: string,
  requestId?: string,
  scope?: { ownerUserId?: string | null },
): boolean {
  const ownerUserId = scope?.ownerUserId ?? getSynchronousOperatorUserId();
  if (!ownerUserId) return false;

  const storage = storageInput ?? getSafeStorage();
  if (!storage) return false;

  const current = loadSeasonalRestoreAttempt(storage, { seasonId, ownerUserId });
  if (current && requestId && current.requestId !== requestId) {
    return false;
  }

  try {
    const key = getSeasonalRestoreAttemptStorageKey(ownerUserId);
    storage.removeItem(key);
  } catch {
    // ignore removal errors
  }

  if (inMemoryExecutingAttempt && inMemoryExecutingAttempt.seasonId === seasonId && inMemoryExecutingAttempt.ownerUserId === ownerUserId) {
    inMemoryExecutingAttempt = null;
  }

  notifyListeners();
  return true;
}

export function isSeasonalRestoreBlockedSync(
  seasonId?: string | null,
  expectedOperatorId?: string | null,
): boolean {
  const currentOperatorId = expectedOperatorId !== undefined ? expectedOperatorId : getSynchronousOperatorUserId();
  if (!currentOperatorId) return false;

  const inMemory = getExecutingSeasonalRestoreAttempt(currentOperatorId);
  if (inMemory) {
    if (!seasonId || inMemory.seasonId === seasonId) {
      return true;
    }
  }

  const persisted = loadSeasonalRestoreAttempt(undefined, { seasonId, ownerUserId: currentOperatorId });
  if (persisted && (persisted.status === 'executing' || persisted.status === 'unresolved' || persisted.status === 'committed')) {
    return true;
  }
  return false;
}

export function useSeasonalRestoreBlocked(
  seasonId?: string | null,
  expectedOperatorId?: string | null,
): boolean {
  return useSyncExternalStore(
    subscribeToSeasonalRestoreState,
    () => isSeasonalRestoreBlockedSync(seasonId, expectedOperatorId),
    () => false,
  );
}
