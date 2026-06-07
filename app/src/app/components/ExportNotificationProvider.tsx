'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { openSavedExport, revealSavedExport, type ExportSaveResult } from '@/lib/exportSave';

interface ExportNotificationContextValue {
  notifyExportCompleted: (result: ExportSaveResult) => void;
}

const ExportNotificationContext = createContext<ExportNotificationContextValue | null>(null);

export function useExportNotifications(): ExportNotificationContextValue {
  const context = useContext(ExportNotificationContext);
  if (!context) throw new Error('useExportNotifications must be used within ExportNotificationProvider');
  return context;
}

export default function ExportNotificationProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<ExportSaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notifyExportCompleted = useCallback((nextResult: ExportSaveResult) => {
    setError(null);
    setResult(nextResult);
  }, []);

  const value = useMemo(() => ({ notifyExportCompleted }), [notifyExportCompleted]);

  const handleOpen = useCallback(async () => {
    if (!result) return;
    try {
      await openSavedExport(result);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }, [result]);

  const handleReveal = useCallback(async () => {
    if (!result) return;
    try {
      await revealSavedExport(result);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : String(revealError));
    }
  }, [result]);

  return (
    <ExportNotificationContext.Provider value={value}>
      {children}
      {result ? (
        <div className="fixed bottom-4 right-4 z-[1300] w-[min(440px,calc(100vw-32px))] rounded-md border border-outline-variant bg-surface-container-high p-4 text-sm shadow-xl" role="status" aria-live="polite">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-[20px] text-primary">download_done</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-on-surface">Export completed</div>
              <div className="mt-1 break-all text-xs text-on-surface-variant">
                {result.filePath ?? result.fileName}
              </div>
              {error ? <div className="mt-2 text-xs font-medium text-error">{error}</div> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleOpen}
                  className="inline-flex items-center gap-1 rounded-md border border-outline px-2.5 py-1.5 text-xs font-semibold text-on-surface transition hover:bg-surface-container-highest"
                >
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  Open file
                </button>
                <button
                  type="button"
                  onClick={handleReveal}
                  className="inline-flex items-center gap-1 rounded-md border border-outline px-2.5 py-1.5 text-xs font-semibold text-on-surface transition hover:bg-surface-container-highest"
                >
                  <span className="material-symbols-outlined text-[16px]">folder_open</span>
                  Show in folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setError(null);
                  }}
                  className="ml-auto inline-flex items-center rounded-md px-2.5 py-1.5 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-container-highest"
                  aria-label="Dismiss export notification"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </ExportNotificationContext.Provider>
  );
}
