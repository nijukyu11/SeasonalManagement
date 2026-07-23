'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  SeasonAutoSyncScheduler,
  createInitialSeasonAutoSyncState,
  type SeasonAutoSyncRunResult,
  type SeasonAutoSyncState,
} from '@/lib/seasonAutoSync';
import {
  publishSeasonWorkspaceChanged,
  subscribeSeasonWorkspaceChanges,
} from '@/lib/seasonDataCache';
import { getRemoteStore } from '@/lib/remoteStore';
import { getOrCreateSeasonClientId } from '@/lib/seasonChangeEvents';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from '@/lib/operatorSessionCacheRegistry';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { useCachedRouteActivity } from './RouteCacheContext';

// Server-authoritative live refresh replaces user-facing conflict review in online-first mode.

type SyncResult = SeasonAutoSyncRunResult;

type SeasonSyncGuardOptions = {
  blocked?: boolean;
  reason?: string;
  beforeSync?: () => Promise<void> | void;
  quiet?: boolean;
  blockingUi?: boolean;
};

type RegisteredSeasonSyncGuard = SeasonSyncGuardOptions & {
  seasonId: string;
  source: string;
};

type SeasonSyncContextValue = {
  registerGuard: (seasonId: string, source: string, options: SeasonSyncGuardOptions) => () => void;
  ensureLiveSeason: (seasonId: string) => void;
  syncNow: (seasonId: string, source: string) => Promise<SyncResult>;
};

const DEFAULT_SYNC_STATE = createInitialSeasonAutoSyncState();
const SeasonSyncContext = createContext<SeasonSyncContextValue | null>(null);

type StoreListener = () => void;

function syncFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function syncFailureMessageWithContext(error: unknown, fallback: string): string {
  const detail = syncFailureMessage(error, fallback);
  return detail === fallback ? fallback : `${fallback} ${detail}`;
}

function createSeasonSyncStateStore() {
  const states = new Map<string, SeasonAutoSyncState>();
  const listeners = new Map<string, Set<StoreListener>>();
  const globalListeners = new Set<StoreListener>();
  let globalSnapshot: Array<{ seasonId: string; state: SeasonAutoSyncState }> = [];

  const rebuildGlobalSnapshot = () => {
    globalSnapshot = Array.from(states.entries()).map(([seasonId, state]) => ({ seasonId, state }));
  };

  const notify = (seasonId: string) => {
    const seasonListeners = listeners.get(seasonId);
    if (seasonListeners) {
      for (const listener of seasonListeners) listener();
    }
    for (const listener of globalListeners) listener();
  };

  return {
    get: (seasonId: string): SeasonAutoSyncState => states.get(seasonId) ?? DEFAULT_SYNC_STATE,
    set: (seasonId: string, state: SeasonAutoSyncState) => {
      if (states.get(seasonId) === state) return;
      states.set(seasonId, state);
      rebuildGlobalSnapshot();
      notify(seasonId);
    },
    getAll: () => globalSnapshot,
    subscribeAll: (listener: StoreListener) => {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },
    subscribe: (seasonId: string, listener: StoreListener) => {
      let seasonListeners = listeners.get(seasonId);
      if (!seasonListeners) {
        seasonListeners = new Set<StoreListener>();
        listeners.set(seasonId, seasonListeners);
      }
      seasonListeners.add(listener);
      return () => {
        seasonListeners?.delete(listener);
        if (seasonListeners?.size === 0) listeners.delete(seasonId);
      };
    },
  };
}

function createSeasonSyncWarningStore() {
  let seasonIds: string[] = [];
  const listeners = new Set<StoreListener>();

  const set = (nextSeasonIds: string[]) => {
    const uniqueSeasonIds = Array.from(new Set(nextSeasonIds.filter(Boolean)));
    if (
      uniqueSeasonIds.length === seasonIds.length &&
      uniqueSeasonIds.every((seasonId, index) => seasonId === seasonIds[index])
    ) {
      return;
    }
    seasonIds = uniqueSeasonIds;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => seasonIds,
    getServerSnapshot: () => [] as string[],
    set,
    subscribe: (listener: StoreListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const seasonSyncStateStore = createSeasonSyncStateStore();
const seasonSyncWarningStore = createSeasonSyncWarningStore();

export function getSeasonSyncStateSnapshot(seasonId: string): SeasonAutoSyncState {
  return seasonSyncStateStore.get(seasonId);
}

function browserSetTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  if (typeof window === 'undefined') return setTimeout(callback, delay);
  return window.setTimeout(callback, delay) as unknown as ReturnType<typeof setTimeout>;
}

function browserClearTimeout(handle: ReturnType<typeof setTimeout>): void {
  if (typeof window === 'undefined') {
    clearTimeout(handle);
    return;
  }
  window.clearTimeout(handle as unknown as number);
}

function isGlobalSyncFailureMessage(message: string | null | undefined): boolean {
  return /catch-up|subscription|sync summary|integrity|server update fetch|season is not available/i.test(message ?? '');
}

function canPatchLightweightSeasonState(state: SeasonAutoSyncState): boolean {
  return (
    state.status === 'synced' &&
    state.pendingCount == null &&
    state.message == null &&
    state.progress == null &&
    state.mode == null
  );
}

function browserRequestIdleCallback(callback: () => void, options?: { timeout?: number }): number {
  const idleWindow = typeof window === 'undefined'
    ? null
    : window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
  if (idleWindow?.requestIdleCallback) return idleWindow.requestIdleCallback(callback, options);
  return browserSetTimeout(callback, 32) as unknown as number;
}

function browserCancelIdleCallback(handle: number): void {
  const idleWindow = typeof window === 'undefined'
    ? null
    : window as Window & {
      cancelIdleCallback?: (handle: number) => void;
    };
  if (idleWindow?.cancelIdleCallback) {
    idleWindow.cancelIdleCallback(handle);
    return;
  }
  browserClearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export default function SeasonSyncProvider({ children }: { children: ReactNode }) {
  const guardsRef = useRef(new Map<string, RegisteredSeasonSyncGuard>());
  const statesRef = useRef<Record<string, SeasonAutoSyncState>>({});
  const liveUnsubscribersRef = useRef(new Map<string, () => void>());
  const liveSubscribingRef = useRef(new Set<string>());
  const liveSubscriptionAttemptsRef = useRef(new Map<string, { cancelled: boolean; operatorSessionEpoch: number }>());
  const providerMountedRef = useRef(true);
  const sessionPendingSeasonIdsRef = useRef(new Set<string>());
  const clientIdRef = useRef<string | null>(null);
  const onlineRef = useRef(true);
  const [scheduler, setScheduler] = useState<SeasonAutoSyncScheduler | null>(null);

  const setSessionPendingSeason = useCallback((seasonId: string, pendingCount: number | null | undefined) => {
    const shouldTrack = (pendingCount ?? 0) > 0;
    const currentlyTracked = sessionPendingSeasonIdsRef.current.has(seasonId);
    if (shouldTrack === currentlyTracked) return;
    const nextSeasonIds = new Set(sessionPendingSeasonIdsRef.current);
    if (shouldTrack) nextSeasonIds.add(seasonId);
    else nextSeasonIds.delete(seasonId);
    sessionPendingSeasonIdsRef.current = nextSeasonIds;
    seasonSyncWarningStore.set(Array.from(nextSeasonIds));
  }, []);

  const setSeasonState = useCallback((seasonId: string, state: SeasonAutoSyncState) => {
    setSessionPendingSeason(seasonId, state.pendingCount);
    const nextStates = {
      ...statesRef.current,
      [seasonId]: state,
    };
    statesRef.current = nextStates;
    seasonSyncStateStore.set(seasonId, state);
  }, [setSessionPendingSeason]);

  const patchSeasonState = useCallback((seasonId: string, patch: Partial<SeasonAutoSyncState>) => {
    setSeasonState(seasonId, {
      ...(statesRef.current[seasonId] ?? DEFAULT_SYNC_STATE),
      ...patch,
    });
  }, [setSeasonState]);

  const patchLightweightSeasonState = useCallback((seasonId: string, patch: Partial<SeasonAutoSyncState> = {}) => {
    const current = statesRef.current[seasonId] ?? DEFAULT_SYNC_STATE;
    const pendingCount = patch.pendingCount ?? current.pendingCount ?? 0;
    const nextSummary = {
      pendingCount,
      lastLocalChangeAt: patch.lastLocalChangeAt ?? current.lastLocalChangeAt,
      localRevision: patch.localRevision ?? current.localRevision,
    };
    if (!canPatchLightweightSeasonState(current)) return nextSummary;
    patchSeasonState(seasonId, {
      status: pendingCount > 0 ? 'dirty' : 'live',
      ...nextSummary,
      message: pendingCount > 0 ? 'Unsynced local changes. Use Save to push them to the server.' : null,
      progress: null,
      mode: null,
    });
    return nextSummary;
  }, [patchSeasonState]);

  const ensureLiveSeason = useCallback((seasonId: string) => {
    if (!clientIdRef.current) clientIdRef.current = getOrCreateSeasonClientId();
    if (liveUnsubscribersRef.current.has(seasonId) || liveSubscribingRef.current.has(seasonId)) return;
    const subscriptionAttempt = { cancelled: false, operatorSessionEpoch: getOperatorSessionEpoch() };
    liveSubscriptionAttemptsRef.current.set(seasonId, subscriptionAttempt);
    liveSubscribingRef.current.add(seasonId);
    void getRemoteStore().then(async (remoteStore) => {
      if (subscriptionAttempt.cancelled || !providerMountedRef.current) return;
      if (!remoteStore.subscribeToSeasonEvents) {
        liveUnsubscribersRef.current.set(seasonId, () => undefined);
        return;
      }
      const unsubscribe = await remoteStore.subscribeToSeasonEvents(seasonId, (event) => {
        if (subscriptionAttempt.cancelled || !providerMountedRef.current) return;
        if (!isOperatorSessionEpochCurrent(subscriptionAttempt.operatorSessionEpoch)) return;
        if (event.clientId === clientIdRef.current) return;
        const invalidated = useSeasonWorkspaceStore.getState().markSeasonWorkspaceStale(
          event.seasonId || seasonId,
          'realtime',
          subscriptionAttempt.operatorSessionEpoch,
        );
        if (!invalidated) return;
        publishSeasonWorkspaceChanged({
          seasonId: event.seasonId || seasonId,
          source: 'server-live',
          localRevision: event.serverSeq,
          affectedIds: [event.targetId],
          changedTargets: [`${event.targetType}:${event.targetId}`],
          syncMeta: null,
        });
      });
      if (subscriptionAttempt.cancelled || !providerMountedRef.current) {
        unsubscribe();
        return;
      }
      liveUnsubscribersRef.current.set(seasonId, unsubscribe);
    }).catch((error) => {
      if (subscriptionAttempt.cancelled || !providerMountedRef.current) return;
      if (!isOperatorSessionEpochCurrent(subscriptionAttempt.operatorSessionEpoch)) return;
      const message = syncFailureMessageWithContext(error, 'Live season subscription failed.');
      patchSeasonState(seasonId, {
        status: 'failed',
        message,
        progress: null,
      });
    }).finally(() => {
      if (liveSubscriptionAttemptsRef.current.get(seasonId) === subscriptionAttempt) {
        liveSubscriptionAttemptsRef.current.delete(seasonId);
        liveSubscribingRef.current.delete(seasonId);
      }
    });
  }, [patchSeasonState]);

  useEffect(() => {
    const nextScheduler = new SeasonAutoSyncScheduler({
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
      requestIdleCallback: browserRequestIdleCallback,
      cancelIdleCallback: browserCancelIdleCallback,
      isOnline: () => onlineRef.current,
      getPendingCount: async (seasonId) => statesRef.current[seasonId]?.pendingCount ?? 0,
      getBlockedReason: (seasonId) => {
        for (const guard of guardsRef.current.values()) {
          if (guard.seasonId === seasonId && guard.blocked) return guard.reason ?? 'Local operation in progress';
        }
        return null;
      },
      prepareSync: async (seasonId, mode, source) => {
        void mode;
        void source;
        const guards = Array.from(guardsRef.current.values()).filter((guard) => guard.seasonId === seasonId);
        for (const guard of guards) {
          await guard.beforeSync?.();
        }
      },
      run: async (seasonId, mode) => {
        const syncGuardSource = mode === 'auto' ? 'auto-sync' : 'manual-sync';
        const syncGuardKey = `${seasonId}:${syncGuardSource}`;
        guardsRef.current.set(syncGuardKey, {
          seasonId,
          source: syncGuardSource,
          blocked: mode === 'manual',
          reason: mode === 'auto' ? 'Auto save running' : 'Manual save running',
          quiet: true,
          blockingUi: mode === 'manual',
        });
        try {
          nextScheduler.setProgress(seasonId, mode === 'auto' ? 'Auto saving' : 'Saving to server');
          return { status: 'synced' as const, message: 'Changes saved to server.' };
        } finally {
          guardsRef.current.delete(syncGuardKey);
        }
      },
      onState: setSeasonState,
    });
    setScheduler(nextScheduler);
    return () => nextScheduler.dispose();
  }, [setSeasonState]);

  const registerGuard = useCallback((seasonId: string, source: string, options: SeasonSyncGuardOptions) => {
    const key = `${seasonId}:${source}`;
    guardsRef.current.set(key, {
      seasonId,
      source,
      ...options,
    });
    scheduler?.notifyGuardChanged(seasonId);
    return () => {
      guardsRef.current.delete(key);
      scheduler?.notifyGuardChanged(seasonId);
    };
  }, [scheduler]);

  const syncNow = useCallback(async (seasonId: string, source: string) => {
    const result = await (scheduler?.syncNow(seasonId, source) ??
      { status: 'failed' as const, message: 'Sync coordinator is not ready.' });
    ensureLiveSeason(seasonId);
    return result;
  }, [ensureLiveSeason, scheduler]);

  useEffect(() => {
    if (!scheduler) return undefined;
    const unsubscribe = subscribeSeasonWorkspaceChanges((event) => {
      ensureLiveSeason(event.seasonId);
      if (event.syncMeta) {
        const pendingCount = event.syncMeta.pendingCount ?? 0;
        const localRevision = event.syncMeta.localRevision ?? event.localRevision;
        setSessionPendingSeason(event.seasonId, pendingCount);
        patchSeasonState(event.seasonId, {
          status: pendingCount > 0 ? 'dirty' : 'live',
          pendingCount,
          lastLocalChangeAt: event.syncMeta.lastLocalChangeAt ?? null,
          localRevision,
          message: pendingCount > 0 ? 'Unsynced local changes. Use Save to push them to the server.' : null,
          progress: null,
          mode: null,
        });
        scheduler.notifyLocalChange(event.seasonId, {
          pendingCount,
          lastLocalChangeAt: event.syncMeta.lastLocalChangeAt,
          localRevision,
          source: event.source,
        });
        return;
      }
      const summary = patchLightweightSeasonState(event.seasonId, {
        localRevision: event.localRevision,
      });
      scheduler.notifyLocalChange(event.seasonId, {
        pendingCount: summary.pendingCount,
        lastLocalChangeAt: summary.lastLocalChangeAt,
        localRevision: summary.localRevision,
        source: event.source,
      });
    });
    return () => {
      unsubscribe();
    };
  }, [ensureLiveSeason, patchLightweightSeasonState, patchSeasonState, scheduler, setSessionPendingSeason]);

  useEffect(() => {
    if (!scheduler) return undefined;
    if (typeof window === 'undefined') return undefined;

    const updateOnlineState = () => {
      onlineRef.current = navigator.onLine;
      if (onlineRef.current) {
        scheduler.notifyOnline();
        return;
      }
      for (const [seasonId, state] of Object.entries(statesRef.current)) {
        if ((state.pendingCount ?? 0) > 0) {
          scheduler.notifyLocalChange(seasonId, {
            pendingCount: state.pendingCount,
            lastLocalChangeAt: state.lastLocalChangeAt,
            localRevision: state.localRevision,
          });
        }
      }
    };

    const resumePendingSync = () => {
      if (document.visibilityState === 'hidden') return;
      scheduler.notifyOnline();
    };

    updateOnlineState();
    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    window.addEventListener('focus', resumePendingSync);
    document.addEventListener('visibilitychange', resumePendingSync);
    return () => {
      window.removeEventListener('online', updateOnlineState);
      window.removeEventListener('offline', updateOnlineState);
      window.removeEventListener('focus', resumePendingSync);
      document.removeEventListener('visibilitychange', resumePendingSync);
    };
  }, [scheduler]);

  useEffect(() => {
    const subscriptionAttempts = liveSubscriptionAttemptsRef.current;
    const subscribingSeasons = liveSubscribingRef.current;
    const liveUnsubscribers = liveUnsubscribersRef.current;
    providerMountedRef.current = true;
    return () => {
      providerMountedRef.current = false;
      for (const attempt of subscriptionAttempts.values()) attempt.cancelled = true;
      subscriptionAttempts.clear();
      subscribingSeasons.clear();
      for (const unsubscribe of liveUnsubscribers.values()) unsubscribe();
      liveUnsubscribers.clear();
    };
  }, []);

  const contextValue = useMemo<SeasonSyncContextValue>(() => ({
    registerGuard,
    ensureLiveSeason,
    syncNow,
  }), [ensureLiveSeason, registerGuard, syncNow]);

  return (
    <SeasonSyncContext.Provider value={contextValue}>
      {children}
    </SeasonSyncContext.Provider>
  );
}

export function useSeasonSync(seasonId: string | null | undefined, source: string) {
  const context = useContext(SeasonSyncContext);
  const isRouteActive = useCachedRouteActivity();
  const status = useSyncExternalStore(
    useCallback((listener) => {
      if (!seasonId || !isRouteActive) return () => undefined;
      return seasonSyncStateStore.subscribe(seasonId, listener);
    }, [isRouteActive, seasonId]),
    useCallback(() => {
      if (!seasonId) return DEFAULT_SYNC_STATE;
      return seasonSyncStateStore.get(seasonId);
    }, [seasonId]),
    () => DEFAULT_SYNC_STATE,
  );
  useEffect(() => {
    if (!seasonId || !context || !isRouteActive) return undefined;
    context.ensureLiveSeason(seasonId);
    return undefined;
  }, [context, isRouteActive, seasonId]);
  const syncNow = useCallback(async () => {
    if (!seasonId || !context) return { status: 'failed' as const, message: 'No season selected.' };
    return context.syncNow(seasonId, source);
  }, [context, seasonId, source]);

  return {
    status,
    syncNow,
  };
}

export function useSeasonSyncActions() {
  const context = useContext(SeasonSyncContext);
  return useMemo(() => ({
    syncNow: async (seasonId: string, source: string) => (
      context?.syncNow(seasonId, source) ??
      { status: 'failed' as const, message: 'Sync coordinator is not ready.' }
    ),
  }), [context]);
}

export function useSeasonSyncSessionWarning() {
  const seasonIds = useSyncExternalStore(
    useCallback((listener) => seasonSyncWarningStore.subscribe(listener), []),
    seasonSyncWarningStore.getSnapshot,
    seasonSyncWarningStore.getServerSnapshot,
  );
  return useMemo(() => ({
    hasPending: seasonIds.length > 0,
    pendingSeasonCount: seasonIds.length,
    seasonIds,
  }), [seasonIds]);
}

export function useSeasonSyncGlobalStatus() {
  const states = useSyncExternalStore(
    useCallback((listener) => seasonSyncStateStore.subscribeAll(listener), []),
    seasonSyncStateStore.getAll,
    () => [] as Array<{ seasonId: string; state: SeasonAutoSyncState }>,
  );
  return useMemo(() => {
    const failedServerSync = states.find(({ state }) => state.status === 'failed' && isGlobalSyncFailureMessage(state.message));
    if (failedServerSync) return failedServerSync;
    return null;
  }, [states]);
}

export function getSeasonSyncPendingCount(status: SeasonAutoSyncState, fallbackPendingCount: number): number;
export function getSeasonSyncPendingCount(status: SeasonAutoSyncState, fallbackPendingCount: number | null): number | null;
export function getSeasonSyncPendingCount(status: SeasonAutoSyncState, fallbackPendingCount: number | null): number | null {
  return status.pendingCount ?? fallbackPendingCount;
}

export function getSeasonSyncLabel(status: SeasonAutoSyncState, fallbackPendingCount: number | null): string {
  const pendingCount = getSeasonSyncPendingCount(status, fallbackPendingCount);
  if (status.status === 'syncing') return status.mode === 'auto' ? 'Auto saving' : 'Saving';
  if (status.status === 'offline') return 'Offline';
  if (status.status === 'failed') return 'Failed';
  if (pendingCount == null) return 'Checking';
  if (pendingCount > 0) return `${pendingCount} pending submit`;
  return 'Synced';
}

export function getSeasonSyncTone(status: SeasonAutoSyncState, fallbackPendingCount: number | null): 'success' | 'warning' | 'error' | 'info' {
  const pendingCount = getSeasonSyncPendingCount(status, fallbackPendingCount);
  if (status.status === 'failed') return 'error';
  if (pendingCount == null) return 'info';
  if (pendingCount > 0) return 'warning';
  if (status.status === 'syncing' || status.status === 'offline' || status.status === 'scheduled' || status.status === 'live') return 'info';
  return 'success';
}

export function useSeasonSyncGuard(
  seasonId: string | null | undefined,
  source: string,
  options: SeasonSyncGuardOptions
): void {
  const context = useContext(SeasonSyncContext);
  const { blocked, reason, beforeSync, quiet, blockingUi } = options;
  const beforeSyncRef = useRef(beforeSync);
  useLayoutEffect(() => {
    beforeSyncRef.current = beforeSync;
  }, [beforeSync]);

  useEffect(() => {
    if (!context || !seasonId) return undefined;
    return context.registerGuard(seasonId, source, {
      blocked,
      reason,
      beforeSync: () => beforeSyncRef.current?.(),
      quiet,
      blockingUi,
    });
  }, [blocked, blockingUi, context, quiet, reason, seasonId, source]);
}
