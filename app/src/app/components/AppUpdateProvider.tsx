'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createAppUpdaterClient,
  formatUpdateDate,
  getCurrentAppVersion,
  type AppUpdateDownloadState,
  type AppUpdateInstallResult,
  type AppUpdateMetadata,
  type AppUpdaterCheckResult,
} from '@/lib/appUpdater';

type AppUpdateContextValue = {
  currentVersion: string | null;
  checkResult: AppUpdaterCheckResult | null;
  availableUpdate: AppUpdateMetadata | null;
  checking: boolean;
  installing: boolean;
  installResult: AppUpdateInstallResult | null;
  progress: AppUpdateDownloadState;
  error: string | null;
  lastCheckedAt: number | null;
  checkNow: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  relaunch: () => Promise<void>;
  dismissAvailableBanner: () => void;
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const initialProgress: AppUpdateDownloadState = {
  downloadedBytes: 0,
  contentLength: null,
  percent: null,
};

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function useAppUpdate(): AppUpdateContextValue {
  const context = useContext(AppUpdateContext);
  if (!context) throw new Error('useAppUpdate must be used inside AppUpdateProvider');
  return context;
}

function AppUpdateBanner() {
  const {
    availableUpdate,
    dismissAvailableBanner,
    installResult,
    installing,
    progress,
    relaunch,
    downloadAndInstall,
  } = useAppUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (!availableUpdate || dismissedVersion === availableUpdate.version) return null;

  if (installResult) {
    return (
      <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-950" role="status">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium">{installResult.message}</span>
          <button
            type="button"
            onClick={() => void relaunch()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            Restart
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950" role="status" aria-live="polite">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <span className="font-semibold">Update {availableUpdate.version} is available</span>
          {availableUpdate.publishedAt && (
            <span className="ml-2 text-blue-800">{formatUpdateDate(availableUpdate.publishedAt)}</span>
          )}
          {installing && (
            <span className="ml-2 text-blue-800">
              Downloading{progress.percent == null ? '...' : ` ${progress.percent}%`}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadAndInstall()}
            disabled={installing}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className={`material-symbols-outlined text-[16px] ${installing ? 'animate-spin' : ''}`}>
              {installing ? 'progress_activity' : 'download'}
            </span>
            {installing ? 'Installing' : 'Download'}
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissedVersion(availableUpdate.version);
              dismissAvailableBanner();
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-blue-800 hover:bg-blue-100"
            aria-label="Dismiss update banner"
            title="Dismiss"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AppUpdateProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createAppUpdaterClient(), []);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<AppUpdaterCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<AppUpdateInstallResult | null>(null);
  const [progress, setProgress] = useState<AppUpdateDownloadState>(initialProgress);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const checkNow = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await client.check();
      setCheckResult(result);
      setLastCheckedAt(Date.now());
      if (result.status === 'available') {
        setInstallResult(null);
        setBannerDismissed(false);
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void getCurrentAppVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => {
        if (!cancelled) setCurrentVersion(null);
      });
    const startupCheckId = window.setTimeout(() => void checkNow(), 0);
    const intervalId = window.setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(startupCheckId);
      window.clearInterval(intervalId);
    };
  }, [checkNow]);

  const availableUpdate = checkResult?.status === 'available' ? checkResult.update : null;

  const downloadAndInstall = useCallback(async () => {
    if (!availableUpdate) return;
    setInstalling(true);
    setError(null);
    setProgress(initialProgress);
    try {
      const result = await client.downloadAndInstall(availableUpdate, setProgress);
      setInstallResult(result);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setInstalling(false);
    }
  }, [availableUpdate, client]);

  const relaunch = useCallback(async () => {
    setError(null);
    try {
      await client.relaunch();
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [client]);

  const value = useMemo<AppUpdateContextValue>(() => ({
    currentVersion,
    checkResult,
    availableUpdate,
    checking,
    installing,
    installResult,
    progress,
    error,
    lastCheckedAt,
    checkNow,
    downloadAndInstall,
    relaunch,
    dismissAvailableBanner: () => setBannerDismissed(true),
  }), [
    availableUpdate,
    checkNow,
    checkResult,
    currentVersion,
    downloadAndInstall,
    error,
    checking,
    installResult,
    installing,
    lastCheckedAt,
    progress,
    relaunch,
  ]);

  return (
    <AppUpdateContext.Provider value={value}>
      {!bannerDismissed && <AppUpdateBanner />}
      {children}
    </AppUpdateContext.Provider>
  );
}
