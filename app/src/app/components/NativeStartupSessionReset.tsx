'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { clearNativeAppEphemeralData } from '@/lib/appSessionCleanup';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { resetUiUndoSession } from '@/lib/uiUndoMemory';
import LoadingStatusPanel from './LoadingStatusPanel';

async function isNativeRuntime(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    return isTauri();
  } catch {
    return false;
  }
}

export default function NativeStartupSessionReset({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Checking native runtime...', 10, 'Preparing local startup')
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const native = await isNativeRuntime();
      if (!native) {
        if (!cancelled) setProgress(buildLoadProgress('Loading app...', 100, 'Browser session ready'));
        if (!cancelled) setReady(true);
        return;
      }

      try {
        if (!cancelled) {
          setProgress(buildLoadProgress('Clearing local UI session...', 35, 'Keeping downloaded season database and Supabase login', { indeterminate: true }));
        }
        clearNativeAppEphemeralData({ preserveAuth: true });
        resetUiUndoSession();
        if (!cancelled) {
          setProgress(buildLoadProgress('Loading local season data', 70, 'Opening downloaded workspace'));
        }
      } catch (error) {
        if (!cancelled) {
          setWarning(error instanceof Error && error.message ? error.message : 'Local startup cleanup failed.');
          setProgress(buildLoadProgress('Continuing startup...', 85, 'Startup cleanup failed'));
        }
      } finally {
        if (!cancelled) {
          setProgress(buildLoadProgress('Rendering latest schedule', 100, 'Checking server changes after open'));
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <LoadingStatusPanel progress={progress} mode="fullscreen" icon="refresh" />;
  }

  return (
    <>
      {warning && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status">
          {warning}
        </div>
      )}
      {children}
    </>
  );
}
