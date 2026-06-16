'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  SeasonAutoSyncScheduler,
  createInitialSeasonAutoSyncState,
  type SeasonAutoSyncState,
} from '@/lib/seasonAutoSync';
import {
  publishSeasonWorkspaceChanged,
  subscribeSeasonWorkspaceChanges,
} from '@/lib/seasonDataCache';
import { getRemoteStore } from '@/lib/remoteStore';
import {
  getOrCreateSeasonClientId,
  type SeasonChangeEvent,
} from '@/lib/seasonChangeEvents';
import {
  checkNativeSeasonIntegrity,
  isTauriRuntime,
  queryNativeSyncSummary,
  runNativeSeasonCatchup,
  syncNativePendingChanges,
  type NativeSyncSummaryResult,
} from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { useCachedRouteActivity } from './RouteCacheContext';

const CATCH_UP_EVENT_PAGE_SIZE = 200;
const MANUAL_FETCH_REPLAY_EVENT_WINDOW = 1_000;

type SyncResult =
  | {
      status: 'synced';
      message?: string;
      reviewCount?: number;
    }
  | {
      status: 'failed' | 'conflict';
      message: string;
      reviewCount?: number;
    };

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
  fetchUpdatesNow: (seasonId: string, source: string) => Promise<SyncResult>;
  seedSeasonSyncFromNative: (seasonId: string) => Promise<void>;
};

const DEFAULT_SYNC_STATE = createInitialSeasonAutoSyncState();
const WORKSPACE_CHANGE_DEBOUNCE_MS = 200;

const SeasonSyncContext = createContext<SeasonSyncContextValue | null>(null);

type CatchUpSeasonOptions = {
  mode?: 'auto' | 'manual';
  source?: string;
};

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

function normalizeSyncSource(source: string | null, result: SyncResult): string {
  if (result.message === 'Remote changes refreshed.') return 'remote-sync';
  const sourceFamily = (source ?? 'auto').split('-')[0] || 'auto';
  return `${sourceFamily}-sync`;
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
  const pendingCatchUpSeasonIdsRef = useRef(new Set<string>());
  const catchUpInFlightRef = useRef(new Set<string>());
  const runCatchUpSeasonRef = useRef<(seasonId: string) => void>(() => undefined);
  const liveUnsubscribersRef = useRef(new Map<string, () => void>());
  const liveSubscribingRef = useRef(new Set<string>());
  const pendingWorkspaceChangeSeasonIdsRef = useRef(new Set<string>());
  const pendingWorkspaceChangeSourcesRef = useRef(new Map<string, string>());
  const workspaceChangeDebounceTimerRef = useRef<number | null>(null);
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

  const markSessionPendingSeason = useCallback((seasonId: string) => {
    if (sessionPendingSeasonIdsRef.current.has(seasonId)) return;
    const nextSeasonIds = new Set(sessionPendingSeasonIdsRef.current);
    nextSeasonIds.add(seasonId);
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

  const getBlockedGuard = useCallback((seasonId: string) => {
    for (const guard of guardsRef.current.values()) {
      if (guard.seasonId === seasonId && guard.blocked) return guard;
    }
    return null;
  }, []);

  const hasBlockedGuard = useCallback((seasonId: string) => getBlockedGuard(seasonId) !== null, [getBlockedGuard]);

  const applyRemoteEvents = useCallback(async (seasonId: string, events: SeasonChangeEvent[]) => {
    if (events.length === 0) return;
    if (!isTauriRuntime()) return;
    const blockedGuard = getBlockedGuard(seasonId);
    if (blockedGuard) {
      pendingCatchUpSeasonIdsRef.current.add(seasonId);
      if (!blockedGuard.quiet) {
        patchSeasonState(seasonId, {
          status: 'catching_up',
          message: 'Remote changes queued for native catch-up.',
          progress: null,
        });
      }
      return;
    }
    pendingCatchUpSeasonIdsRef.current.add(seasonId);
    patchSeasonState(seasonId, {
      status: 'catching_up',
      message: 'Remote changes queued for native catch-up.',
      progress: null,
    });
    runCatchUpSeasonRef.current(seasonId);
  }, [getBlockedGuard, patchSeasonState]);

  const scheduleRemoteEvents = useCallback((seasonId: string, events: SeasonChangeEvent[]) => {
    browserRequestIdleCallback(() => {
      void applyRemoteEvents(seasonId, events).catch((error) => {
        patchSeasonState(seasonId, {
          status: 'failed',
          message: syncFailureMessage(error, 'Remote change catch-up failed.'),
          progress: null,
        });
      });
    }, { timeout: 1000 });
  }, [applyRemoteEvents, patchSeasonState]);

  const patchStateFromNativeSummary = useCallback((seasonId: string, summary: NativeSyncSummaryResult | null | undefined) => {
    const conflictCount = summary?.conflictCount ?? 0;
    const pendingCount = summary?.pendingCount ?? 0;
    patchSeasonState(seasonId, {
      status: conflictCount > 0 ? 'needs_review' : (pendingCount > 0 ? 'dirty' : 'live'),
      pendingCount,
      lastLocalChangeAt: summary?.lastLocalChangeAt ?? null,
      localRevision: summary?.localRevision ?? null,
      message: conflictCount > 0 ? `${conflictCount} remote conflict${conflictCount === 1 ? '' : 's'} need review.` : null,
      progress: null,
      mode: null,
      conflictCount,
    });
  }, [patchSeasonState]);

  const flushQueuedRemoteEvents = useCallback((seasonId: string) => {
    if (hasBlockedGuard(seasonId)) return;
    if (!pendingCatchUpSeasonIdsRef.current.has(seasonId)) return;
    pendingCatchUpSeasonIdsRef.current.delete(seasonId);
    runCatchUpSeasonRef.current(seasonId);
  }, [hasBlockedGuard]);

  const catchUpSeason = useCallback(async (
    seasonId: string,
    options: CatchUpSeasonOptions = {}
  ): Promise<SyncResult> => {
    const manualFetch = options.mode === 'manual';
    const stateMode = manualFetch ? 'manual' : null;
    const publishSource = manualFetch ? 'manual-fetch' : options.source ?? null;
    const remoteStore = await getRemoteStore();
    try {
      void Promise.resolve(remoteStore.flushScheduleNotifications?.({ seasonId })).catch((error) => {
        console.debug('[schedule-notifications] startup flush failed', error);
      });
    } catch (error) {
      console.debug('[schedule-notifications] startup flush failed', error);
    }
    if (!isTauriRuntime()) return { status: 'failed', message: 'Native server update fetch is unavailable.' };
    const blockedGuard = getBlockedGuard(seasonId);
    if (blockedGuard) {
      pendingCatchUpSeasonIdsRef.current.add(seasonId);
      const message = 'Remote catch-up queued until the local operation finishes.';
      if (!blockedGuard.quiet) {
        patchSeasonState(seasonId, {
          status: 'catching_up',
          message,
          progress: null,
          mode: stateMode,
        });
      }
      return { status: 'failed', message };
    }
    const nativeDesktopRuntime = isTauriRuntime();
    if (!nativeDesktopRuntime) {
      const message = 'Native desktop runtime is required for server update fetch.';
      patchSeasonState(seasonId, {
        status: 'failed',
        message,
        progress: null,
        mode: stateMode,
      });
      return { status: 'failed', message };
    }
    try {
      const season = await remoteStore.getSeason(seasonId);
      if (!season) {
        const message = 'Selected season is not available on the server.';
        patchSeasonState(seasonId, {
          status: 'failed',
          message,
          progress: null,
          mode: stateMode,
        });
        return { status: 'failed', message };
      }
      const baseline = await ensureNativeSeasonBaseline(season);
      if (baseline.source === 'server' || baseline.source === 'merged') {
        const summary = await queryNativeSyncSummary(seasonId);
        publishSeasonWorkspaceChanged({
          seasonId,
          localRevision: summary?.localRevision ?? null,
          source: baseline.source === 'merged' ? 'native-baseline-merge' : 'native-baseline-refresh',
        });
      }
      await checkNativeSeasonIntegrity(seasonId);
    } catch (error) {
      const message = syncFailureMessage(error, 'Local season integrity check failed.');
      patchSeasonState(seasonId, {
        status: 'failed',
        message,
        progress: null,
        mode: stateMode,
      });
      return { status: 'failed', message };
    }
    const initialSummary = await queryNativeSyncSummary(seasonId);
    const lastServerSeq = initialSummary?.lastServerSeq ?? 0;
    const cursorState = remoteStore.getSeasonSyncCursorState
      ? await remoteStore.getSeasonSyncCursorState(seasonId)
      : {
          serverHighWater: remoteStore.getSeasonEventHighWater
            ? await remoteStore.getSeasonEventHighWater(seasonId).catch(() => lastServerSeq)
            : lastServerSeq,
          entityVersions: remoteStore.getSeasonEntityVersions
            ? await remoteStore.getSeasonEntityVersions(seasonId).catch(() => ({}))
            : {},
    };
    const serverHighWater = cursorState.serverHighWater;
    const backlog = serverHighWater - lastServerSeq;
    const workspaceIsFresh = Boolean(
      initialSummary &&
      initialSummary.localRecordCount === 0 &&
      initialSummary.entityVersionCount === 0 &&
      initialSummary.pendingCount === 0 &&
      initialSummary.conflictCount === 0
    );
    const shouldReplayRecentEvents = manualFetch && serverHighWater > 0 && !workspaceIsFresh;
    const catchUpStartSeq = workspaceIsFresh && serverHighWater > 0
      ? 0
      : backlog > 0
        ? lastServerSeq
        : shouldReplayRecentEvents
          ? Math.max(0, Math.min(lastServerSeq, serverHighWater) - MANUAL_FETCH_REPLAY_EVENT_WINDOW)
          : lastServerSeq;
    const catchUpBacklog = serverHighWater - catchUpStartSeq;
    const replayingRecentEvents = !workspaceIsFresh && backlog <= 0 && catchUpBacklog > 0;
    if (catchUpBacklog <= 0) {
      patchStateFromNativeSummary(seasonId, initialSummary);
      if (manualFetch) {
        patchSeasonState(seasonId, {
          message: 'No server updates found.',
          progress: null,
          mode: null,
        });
      }
      return { status: 'synced', message: 'No server updates found.' };
    }

    patchSeasonState(seasonId, {
      status: 'catching_up',
      message: replayingRecentEvents
        ? 'Verifying recent server changes in background.'
        : `Updating ${catchUpBacklog} remote change${catchUpBacklog === 1 ? '' : 's'} in background.`,
      progress: `Updating in background: 0 / ${catchUpBacklog}`,
      mode: stateMode,
    });

    const clientId = clientIdRef.current ?? getOrCreateSeasonClientId();
    clientIdRef.current = clientId;

    const nativeResult = await runNativeSeasonCatchup({
      seasonId,
      clientId,
      localCursor: catchUpStartSeq,
      serverHighWater,
      pageSize: CATCH_UP_EVENT_PAGE_SIZE,
      reconcileManifest: manualFetch,
      onProgress: (progress) => {
        patchSeasonState(seasonId, {
          status: 'catching_up',
          message: replayingRecentEvents
            ? 'Verifying recent server changes in background.'
            : `Updating ${catchUpBacklog} remote change${catchUpBacklog === 1 ? '' : 's'} in background.`,
          progress: `Updating in background: ${Math.min(progress.lastServerSeq - catchUpStartSeq, catchUpBacklog)} / ${catchUpBacklog}`,
          mode: stateMode,
        });
      },
    });
    if (nativeResult) {
      const summary = await queryNativeSyncSummary(seasonId);
      if (nativeResult.appliedEvents > 0 || nativeResult.changedTargets.length > 0 || nativeResult.lastServerSeq > lastServerSeq) {
        publishSeasonWorkspaceChanged({
          seasonId,
          localRevision: summary?.localRevision ?? nativeResult.lastServerSeq,
          source: publishSource ?? 'native-catchup',
        });
      }
      patchStateFromNativeSummary(seasonId, summary);
      const conflictCount = summary?.conflictCount ?? 0;
      const changed = nativeResult.appliedEvents > 0 || nativeResult.changedTargets.length > 0 || nativeResult.lastServerSeq > lastServerSeq;
      return {
        status: 'synced',
        message: conflictCount > 0
          ? `${conflictCount} remote conflict${conflictCount === 1 ? '' : 's'} need review.`
          : changed
            ? 'Server updates fetched.'
            : 'No server updates found.',
        reviewCount: conflictCount || undefined,
      };
    }

    const message = nativeDesktopRuntime
      ? 'Native server update fetch is unavailable.'
      : 'Server update fetch is not available in this runtime.';
    patchSeasonState(seasonId, {
      status: 'failed',
      message,
      progress: null,
      mode: stateMode,
    });
    return { status: 'failed', message };
  }, [getBlockedGuard, patchSeasonState, patchStateFromNativeSummary]);

  const runCatchUpSeason = useCallback((seasonId: string) => {
    if (catchUpInFlightRef.current.has(seasonId)) {
      pendingCatchUpSeasonIdsRef.current.add(seasonId);
      return;
    }
    catchUpInFlightRef.current.add(seasonId);
    void catchUpSeason(seasonId).catch((error) => {
      patchSeasonState(seasonId, {
        status: 'failed',
        message: syncFailureMessage(error, 'Remote change catch-up failed.'),
        progress: null,
      });
    }).finally(() => {
      catchUpInFlightRef.current.delete(seasonId);
      if (pendingCatchUpSeasonIdsRef.current.has(seasonId) && !hasBlockedGuard(seasonId)) {
        pendingCatchUpSeasonIdsRef.current.delete(seasonId);
        runCatchUpSeasonRef.current(seasonId);
      }
    });
  }, [catchUpSeason, hasBlockedGuard, patchSeasonState]);

  const runManualFetchSeason = useCallback(async (seasonId: string, source: string): Promise<SyncResult> => {
    if (!clientIdRef.current) clientIdRef.current = getOrCreateSeasonClientId();
    if (catchUpInFlightRef.current.has(seasonId)) {
      pendingCatchUpSeasonIdsRef.current.add(seasonId);
      const message = 'Server update fetch is already running.';
      patchSeasonState(seasonId, {
        status: 'catching_up',
        message,
        progress: null,
        mode: 'manual',
      });
      return { status: 'failed', message };
    }

    catchUpInFlightRef.current.add(seasonId);
    try {
      return await catchUpSeason(seasonId, { mode: 'manual', source });
    } catch (error) {
      const message = syncFailureMessage(error, 'Remote change catch-up failed.');
      patchSeasonState(seasonId, {
        status: 'failed',
        message,
        progress: null,
        mode: 'manual',
      });
      return { status: 'failed', message };
    } finally {
      catchUpInFlightRef.current.delete(seasonId);
      if (pendingCatchUpSeasonIdsRef.current.has(seasonId) && !hasBlockedGuard(seasonId)) {
        pendingCatchUpSeasonIdsRef.current.delete(seasonId);
        runCatchUpSeasonRef.current(seasonId);
      }
    }
  }, [catchUpSeason, hasBlockedGuard, patchSeasonState]);

  useEffect(() => {
    runCatchUpSeasonRef.current = runCatchUpSeason;
  }, [runCatchUpSeason]);

  const ensureLiveSeason = useCallback((seasonId: string) => {
    if (!clientIdRef.current) clientIdRef.current = getOrCreateSeasonClientId();
    if (liveUnsubscribersRef.current.has(seasonId) || liveSubscribingRef.current.has(seasonId)) return;
    liveSubscribingRef.current.add(seasonId);
    void getRemoteStore().then(async (remoteStore) => {
      if (!remoteStore.subscribeToSeasonEvents) return;
      const unsubscribe = await remoteStore.subscribeToSeasonEvents(seasonId, (event) => {
        if (event.clientId === clientIdRef.current) return;
        scheduleRemoteEvents(seasonId, [event]);
      });
      liveUnsubscribersRef.current.set(seasonId, unsubscribe);
      runCatchUpSeason(seasonId);
    }).finally(() => {
      liveSubscribingRef.current.delete(seasonId);
    });
  }, [runCatchUpSeason, scheduleRemoteEvents]);

  useEffect(() => {
    const nextScheduler = new SeasonAutoSyncScheduler({
      setTimeout: browserSetTimeout,
      clearTimeout: browserClearTimeout,
      requestIdleCallback: browserRequestIdleCallback,
      cancelIdleCallback: browserCancelIdleCallback,
      isOnline: () => onlineRef.current,
      getPendingCount: async (seasonId) => (await queryNativeSyncSummary(seasonId))?.pendingCount ?? 0,
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
      run: async (seasonId, mode, source) => {
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
          nextScheduler.setProgress(seasonId, mode === 'auto' ? 'Auto saving' : 'Preparing native save');
          const nativeResult = await syncNativePendingChanges(seasonId);
          if (nativeResult?.notificationFlushError) {
            console.debug('[schedule-notifications] native flush failed', nativeResult.notificationFlushError);
          }
          const summary = await queryNativeSyncSummary(seasonId);
          if (summary) {
            const publishResult: SyncResult = nativeResult?.status === 'synced'
              ? { status: 'synced', message: nativeResult.message }
              : nativeResult?.status === 'conflict'
                ? { status: 'conflict', message: nativeResult.message, reviewCount: nativeResult.conflictCount || undefined }
                : { status: 'failed', message: nativeResult?.message ?? 'Native sync command is unavailable.' };
            publishSeasonWorkspaceChanged({
              seasonId,
              localRevision: summary.localRevision,
              source: normalizeSyncSource(source, publishResult),
            });
          }
          if (!nativeResult) return { status: 'failed' as const, message: 'Native sync command is unavailable.' };
          return {
            status: nativeResult.status === 'synced' ? 'synced' as const : nativeResult.status === 'conflict' ? 'conflict' as const : 'failed' as const,
            message: nativeResult.message,
            reviewCount: nativeResult.conflictCount || undefined,
          };
        } finally {
          guardsRef.current.delete(syncGuardKey);
          flushQueuedRemoteEvents(seasonId);
          if (pendingCatchUpSeasonIdsRef.current.has(seasonId) && !hasBlockedGuard(seasonId)) {
            pendingCatchUpSeasonIdsRef.current.delete(seasonId);
            runCatchUpSeason(seasonId);
          }
        }
      },
      onState: setSeasonState,
    });
    setScheduler(nextScheduler);
  }, [flushQueuedRemoteEvents, hasBlockedGuard, runCatchUpSeason, setSeasonState]);

  const registerGuard = useCallback((seasonId: string, source: string, options: SeasonSyncGuardOptions) => {
    const key = `${seasonId}:${source}`;
    guardsRef.current.set(key, {
      seasonId,
      source,
      ...options,
    });
    scheduler?.notifyGuardChanged(seasonId);
    flushQueuedRemoteEvents(seasonId);
    if (pendingCatchUpSeasonIdsRef.current.has(seasonId) && !hasBlockedGuard(seasonId)) {
      pendingCatchUpSeasonIdsRef.current.delete(seasonId);
      runCatchUpSeason(seasonId);
    }
    return () => {
      guardsRef.current.delete(key);
      scheduler?.notifyGuardChanged(seasonId);
      flushQueuedRemoteEvents(seasonId);
      if (pendingCatchUpSeasonIdsRef.current.has(seasonId) && !hasBlockedGuard(seasonId)) {
        pendingCatchUpSeasonIdsRef.current.delete(seasonId);
        runCatchUpSeason(seasonId);
      }
    };
  }, [flushQueuedRemoteEvents, hasBlockedGuard, runCatchUpSeason, scheduler]);

  const syncNow = useCallback(async (seasonId: string, source: string) => {
    ensureLiveSeason(seasonId);
    const result = await (scheduler?.syncNow(seasonId, source) ??
      { status: 'failed' as const, message: 'Sync coordinator is not ready.' });
    if (result.status === 'synced' || result.status === 'conflict') {
      const summary = await queryNativeSyncSummary(seasonId).catch(() => null);
      if (summary) {
        patchStateFromNativeSummary(seasonId, summary);
        publishSeasonWorkspaceChanged({
          seasonId,
          localRevision: summary.localRevision,
          source: normalizeSyncSource(source, result),
          syncMeta: null,
        });
      }
    }
    return result;
  }, [ensureLiveSeason, patchStateFromNativeSummary, scheduler]);

  const fetchUpdatesNow = useCallback(async (seasonId: string, source: string) => {
    ensureLiveSeason(seasonId);
    return runManualFetchSeason(seasonId, source);
  }, [ensureLiveSeason, runManualFetchSeason]);

  const seedSeasonSyncFromNative = useCallback(async (seasonId: string) => {
    const summary = await queryNativeSyncSummary(seasonId);
    patchStateFromNativeSummary(seasonId, summary);
  }, [patchStateFromNativeSummary]);

  useEffect(() => {
    if (!scheduler) return undefined;
    const pendingWorkspaceChangeSeasonIds = pendingWorkspaceChangeSeasonIdsRef.current;
    const pendingWorkspaceChangeSources = pendingWorkspaceChangeSourcesRef.current;
    const flushWorkspaceChanges = () => {
      const seasonIds = Array.from(pendingWorkspaceChangeSeasonIdsRef.current);
      pendingWorkspaceChangeSeasonIdsRef.current.clear();
      for (const seasonId of seasonIds) {
        const source = pendingWorkspaceChangeSourcesRef.current.get(seasonId);
        pendingWorkspaceChangeSourcesRef.current.delete(seasonId);
        void queryNativeSyncSummary(seasonId).then((summary) => {
          if (!summary) return;
          setSessionPendingSeason(seasonId, summary.pendingCount);
          scheduler.notifyLocalChange(seasonId, {
            pendingCount: summary.pendingCount,
            lastLocalChangeAt: summary.lastLocalChangeAt,
            localRevision: summary.localRevision,
            source,
          });
          if (summary.conflictCount > 0) {
            patchSeasonState(seasonId, {
              status: 'needs_review',
              pendingCount: summary.pendingCount,
              lastLocalChangeAt: summary.lastLocalChangeAt,
              localRevision: summary.localRevision,
              message: `${summary.conflictCount} remote conflict${summary.conflictCount === 1 ? '' : 's'} need review.`,
              progress: null,
              conflictCount: summary.conflictCount,
            });
          }
        });
      }
    };
    const unsubscribe = subscribeSeasonWorkspaceChanges((event) => {
      ensureLiveSeason(event.seasonId);
      markSessionPendingSeason(event.seasonId);
      pendingWorkspaceChangeSeasonIdsRef.current.add(event.seasonId);
      pendingWorkspaceChangeSourcesRef.current.set(event.seasonId, event.source);
      if (workspaceChangeDebounceTimerRef.current != null) {
        window.clearTimeout(workspaceChangeDebounceTimerRef.current);
      }
      workspaceChangeDebounceTimerRef.current = window.setTimeout(() => {
        workspaceChangeDebounceTimerRef.current = null;
        flushWorkspaceChanges();
      }, WORKSPACE_CHANGE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (workspaceChangeDebounceTimerRef.current != null) {
        window.clearTimeout(workspaceChangeDebounceTimerRef.current);
        workspaceChangeDebounceTimerRef.current = null;
      }
      pendingWorkspaceChangeSeasonIds.clear();
      pendingWorkspaceChangeSources.clear();
    };
  }, [ensureLiveSeason, markSessionPendingSeason, patchSeasonState, scheduler, setSessionPendingSeason]);

  useEffect(() => {
    if (!scheduler) return undefined;
    if (typeof window === 'undefined') return undefined;

    const updateOnlineState = () => {
      onlineRef.current = navigator.onLine;
      if (onlineRef.current) {
        scheduler.notifyOnline();
        for (const seasonId of liveUnsubscribersRef.current.keys()) runCatchUpSeason(seasonId);
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
      for (const seasonId of liveUnsubscribersRef.current.keys()) runCatchUpSeason(seasonId);
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
  }, [runCatchUpSeason, scheduler]);

  useEffect(() => () => {
    for (const unsubscribe of liveUnsubscribersRef.current.values()) unsubscribe();
    liveUnsubscribersRef.current.clear();
  }, []);

  const contextValue = useMemo<SeasonSyncContextValue>(() => ({
    registerGuard,
    ensureLiveSeason,
    syncNow,
    fetchUpdatesNow,
    seedSeasonSyncFromNative,
  }), [ensureLiveSeason, fetchUpdatesNow, registerGuard, seedSeasonSyncFromNative, syncNow]);

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
  const fetchUpdatesNow = useCallback(async () => {
    if (!seasonId || !context) return { status: 'failed' as const, message: 'No season selected.' };
    return context.fetchUpdatesNow(seasonId, source);
  }, [context, seasonId, source]);

  return {
    status,
    syncNow,
    fetchUpdatesNow,
  };
}

export function useSeasonSyncActions() {
  const context = useContext(SeasonSyncContext);
  return useMemo(() => ({
    syncNow: async (seasonId: string, source: string) => (
      context?.syncNow(seasonId, source) ??
      { status: 'failed' as const, message: 'Sync coordinator is not ready.' }
    ),
    fetchUpdatesNow: async (seasonId: string, source: string) => (
      context?.fetchUpdatesNow(seasonId, source) ??
      { status: 'failed' as const, message: 'Sync coordinator is not ready.' }
    ),
    seedSeasonSyncFromNative: async (seasonId: string) => {
      await context?.seedSeasonSyncFromNative(seasonId);
    },
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
    const catchingUp = states.find(({ state }) => (
      state.status === 'catching_up' &&
      state.progress !== 'Checking server changes' &&
      !/^Checking server changes\.?$/.test(state.message ?? '')
    ));
    if (catchingUp) return catchingUp;
    return states.find(({ state }) => state.status === 'failed' && /catch-up/i.test(state.message ?? '')) ?? null;
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
  if (status.status === 'catching_up') return 'Catching up';
  if (status.status === 'needs_review') return 'Review needed';
  if (status.status === 'offline') return 'Offline';
  if (status.status === 'conflict') return 'Conflict';
  if (status.status === 'failed') return 'Failed';
  if (pendingCount == null) return 'Checking';
  if (pendingCount > 0) return `${pendingCount} unsynced`;
  return 'Synced';
}

export function getSeasonSyncTone(status: SeasonAutoSyncState, fallbackPendingCount: number | null): 'success' | 'warning' | 'error' | 'info' {
  const pendingCount = getSeasonSyncPendingCount(status, fallbackPendingCount);
  if (status.status === 'conflict' || status.status === 'failed') return 'error';
  if (status.status === 'needs_review') return 'warning';
  if (status.status === 'syncing' || status.status === 'offline' || status.status === 'scheduled' || status.status === 'catching_up' || status.status === 'live') return 'info';
  if (pendingCount == null) return 'info';
  if (pendingCount > 0) return 'warning';
  return 'success';
}

export function useSeasonSyncGuard(
  seasonId: string | null | undefined,
  source: string,
  options: SeasonSyncGuardOptions
): void {
  const context = useContext(SeasonSyncContext);
  const { blocked, reason, beforeSync, quiet, blockingUi } = options;

  useEffect(() => {
    if (!context || !seasonId) return undefined;
    return context.registerGuard(seasonId, source, { blocked, reason, beforeSync, quiet, blockingUi });
  }, [beforeSync, blocked, blockingUi, context, quiet, reason, seasonId, source]);
}
