'use client';

import { useEffect, useRef } from 'react';
import {
  subscribeSeasonWorkspaceChanges,
  type SeasonWorkspaceChangeEvent,
} from '@/lib/seasonDataCache';
import { useCachedRouteActivity } from '../components/RouteCacheContext';

interface UseSeasonWorkspaceRefreshOptions {
  seasonId: string | null | undefined;
  policy: 'background' | 'on-activation';
  source: string;
  onNativeRefresh?: (event: SeasonWorkspaceChangeEvent) => Promise<void> | void;
}

const REFRESH_DEBOUNCE_MS = 120;
const ACTIVATION_REFRESH_TIMEOUT_MS = 500;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function isSameWorkspaceChangeSource(eventSource: string, ownSource: string): boolean {
  return eventSource === ownSource || eventSource.startsWith(`${ownSource}-`);
}

export function useSeasonWorkspaceRefresh({
  seasonId,
  policy,
  source,
  onNativeRefresh,
}: UseSeasonWorkspaceRefreshOptions): void {
  const isRouteActive = useCachedRouteActivity();
  const onNativeRefreshRef = useRef(onNativeRefresh);
  const seasonIdRef = useRef(seasonId);
  const policyRef = useRef(policy);
  const sourceRef = useRef(source);
  const isRouteActiveRef = useRef(isRouteActive);
  const staleEventRef = useRef<SeasonWorkspaceChangeEvent | null>(null);
  const lastHandledEventSeqRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const activationRefreshHandleRef = useRef<number | null>(null);
  const activationRefreshHandleTypeRef = useRef<'idle' | 'timeout' | null>(null);
  const refreshingRef = useRef(false);
  const scheduleRefreshRef = useRef<(event: SeasonWorkspaceChangeEvent) => void>(() => undefined);
  const scheduleActivationRefreshRef = useRef<(event: SeasonWorkspaceChangeEvent) => void>(() => undefined);

  useEffect(() => {
    onNativeRefreshRef.current = onNativeRefresh;
    seasonIdRef.current = seasonId;
    policyRef.current = policy;
    sourceRef.current = source;
    isRouteActiveRef.current = isRouteActive;
  }, [isRouteActive, onNativeRefresh, policy, seasonId, source]);

  useEffect(() => {
    let disposed = false;
    const idleWindow = window as IdleWindow;

    const cancelActivationRefresh = () => {
      const handle = activationRefreshHandleRef.current;
      if (handle == null) return;
      if (activationRefreshHandleTypeRef.current === 'idle') {
        idleWindow.cancelIdleCallback?.(handle);
      } else {
        window.clearTimeout(handle);
      }
      activationRefreshHandleRef.current = null;
      activationRefreshHandleTypeRef.current = null;
    };

    async function refreshFromNativeEvent(event: SeasonWorkspaceChangeEvent) {
      const currentSeasonId = seasonIdRef.current;
      if (!currentSeasonId || event.eventSeq <= lastHandledEventSeqRef.current) return;
      if (refreshingRef.current) {
        staleEventRef.current = event;
        return;
      }
      refreshingRef.current = true;
      try {
        if (!disposed) await onNativeRefreshRef.current?.(event);
        lastHandledEventSeqRef.current = Math.max(lastHandledEventSeqRef.current, event.eventSeq);
        if (staleEventRef.current?.eventSeq === event.eventSeq) staleEventRef.current = null;
      } catch (error) {
        console.error('Season workspace refresh failed', error);
        lastHandledEventSeqRef.current = Math.max(lastHandledEventSeqRef.current, event.eventSeq);
        if (staleEventRef.current?.eventSeq === event.eventSeq) staleEventRef.current = null;
      } finally {
        refreshingRef.current = false;
        const pendingEvent = staleEventRef.current;
        if (!disposed && pendingEvent && pendingEvent.eventSeq > lastHandledEventSeqRef.current) {
          void scheduleRefreshRef.current(pendingEvent);
        }
      }
    }

    scheduleRefreshRef.current = (event: SeasonWorkspaceChangeEvent) => {
      staleEventRef.current = event;
      if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        const pendingEvent = staleEventRef.current;
        if (pendingEvent) void refreshFromNativeEvent(pendingEvent);
      }, REFRESH_DEBOUNCE_MS);
    };

    scheduleActivationRefreshRef.current = (event: SeasonWorkspaceChangeEvent) => {
      staleEventRef.current = event;
      cancelActivationRefresh();

      const runAfterActivation = () => {
        activationRefreshHandleRef.current = null;
        activationRefreshHandleTypeRef.current = null;
        const pendingEvent = staleEventRef.current;
        if (!disposed && pendingEvent) scheduleRefreshRef.current(pendingEvent);
      };

      if (typeof idleWindow.requestIdleCallback === 'function') {
        activationRefreshHandleTypeRef.current = 'idle';
        activationRefreshHandleRef.current = idleWindow.requestIdleCallback(runAfterActivation, {
          timeout: ACTIVATION_REFRESH_TIMEOUT_MS,
        });
        return;
      }

      activationRefreshHandleTypeRef.current = 'timeout';
      activationRefreshHandleRef.current = window.setTimeout(runAfterActivation, 32);
    };

    const unsubscribe = subscribeSeasonWorkspaceChanges((event) => {
      const currentSeasonId = seasonIdRef.current;
      const currentRouteActive = isRouteActiveRef.current;
      if (!currentSeasonId || event.seasonId !== currentSeasonId) return;
      if (event.eventSeq <= lastHandledEventSeqRef.current) return;
      if (currentRouteActive && isSameWorkspaceChangeSource(event.source, sourceRef.current)) return;
      if (policyRef.current === 'background' || currentRouteActive) {
        scheduleRefreshRef.current(event);
        return;
      }
      if (policyRef.current === 'on-activation') {
        staleEventRef.current = event;
        return;
      }
      staleEventRef.current = event;
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current);
      cancelActivationRefresh();
    };
  }, []);

  useEffect(() => {
    if (!isRouteActive || policy !== 'on-activation') return;
    const pendingEvent = staleEventRef.current;
    if (pendingEvent) scheduleActivationRefreshRef.current(pendingEvent);
  }, [isRouteActive, policy]);
}
