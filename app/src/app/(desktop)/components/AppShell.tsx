'use client';

import type { ReactNode } from 'react';
import { Suspense } from 'react';
import AppRouteCache from './AppRouteCache';
import AppSidebar from './AppSidebar';
import AppUpdateProvider from './AppUpdateProvider';
import ExportNotificationProvider from './ExportNotificationProvider';
import NativeCloseCleanupGuard from './NativeCloseCleanupGuard';
import NativeRuntimeGate from './NativeRuntimeGate';
import NativeStartupSessionReset from './NativeStartupSessionReset';
import OperatorAuthGate from './OperatorAuthGate';
import SeasonSyncProvider, { useSeasonSyncGlobalStatus } from './SeasonSyncProvider';

function buildCatchUpProgressLabel(progress: string | null | undefined, message: string | null | undefined): {
  label: string;
  detail: string;
  percent: number;
  indeterminate: boolean;
} {
  const text = progress ?? message ?? 'Checking server changes';
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    const written = Number(match[1]);
    const total = Number(match[2]);
    return {
      label: 'Updating in background',
      detail: text,
      percent: total > 0 ? Math.round((written / total) * 100) : 0,
      indeterminate: false,
    };
  }
  if (/snapshot/i.test(text)) {
    return {
      label: 'Refreshing server snapshot',
      detail: 'Loading latest server baseline',
      percent: 65,
      indeterminate: true,
    };
  }
  if (/failed/i.test(message ?? '')) {
    return {
      label: 'Server sync failed',
      detail: message ?? 'Remote changes could not be checked.',
      percent: 100,
      indeterminate: false,
    };
  }
  return {
    label: 'Checking server changes',
    detail: text,
    percent: 35,
    indeterminate: true,
  };
}

function SeasonSyncStartupCatchUpStatus() {
  const activeStatus = useSeasonSyncGlobalStatus();
  if (!activeStatus) return null;
  const status = activeStatus.state;
  const progress = buildCatchUpProgressLabel(status.progress, status.message);
  const barWidth = progress.indeterminate ? '52%' : `${Math.max(0, Math.min(100, progress.percent))}%`;

  return (
    <div className="pointer-events-auto rounded border border-outline-variant bg-surface-container-low px-3 py-1 shadow-sm" role="status" aria-live="polite">
      <div className="mx-auto flex min-h-7 max-w-3xl items-center gap-2 text-xs text-on-surface-variant">
        <span className={`material-symbols-outlined text-[16px] ${status.status === 'failed' ? 'text-error' : 'text-primary'} ${status.status === 'failed' ? '' : 'animate-spin'}`}>
          {status.status === 'failed' ? 'error' : 'sync'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-semibold text-on-surface">{progress.label}</span>
            <span className="truncate">{progress.detail}</span>
          </div>
          <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-container-high">
            <div
              className={`h-0.5 rounded-full bg-primary ${progress.indeterminate ? 'animate-pulse' : 'transition-[width] duration-300 ease-out'}`}
              style={{ width: barWidth }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SeasonSyncBannerLayer() {
  return (
    <div className="app-shell-sync-banner-layer pointer-events-none absolute bottom-3 left-3 right-3 z-[70] flex flex-col gap-2 sm:left-auto sm:w-[420px]">
      <SeasonSyncStartupCatchUpStatus />
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <NativeCloseCleanupGuard />
      <NativeStartupSessionReset>
        <OperatorAuthGate>
          <div className="flex h-dvh overflow-hidden bg-surface text-on-surface">
            <Suspense fallback={<div className="h-dvh w-16 flex-none border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950" />}>
              <AppSidebar />
            </Suspense>
            <ExportNotificationProvider>
              <div className="app-shell-content relative flex min-w-0 flex-1 flex-col overflow-hidden">
                <NativeRuntimeGate>
                  <AppUpdateProvider>
                    <SeasonSyncProvider>
                      <SeasonSyncBannerLayer />
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <Suspense fallback={<div className="h-full w-full bg-surface" />}>
                          <AppRouteCache>{children}</AppRouteCache>
                        </Suspense>
                      </div>
                    </SeasonSyncProvider>
                  </AppUpdateProvider>
                </NativeRuntimeGate>
              </div>
            </ExportNotificationProvider>
          </div>
        </OperatorAuthGate>
      </NativeStartupSessionReset>
    </>
  );
}
