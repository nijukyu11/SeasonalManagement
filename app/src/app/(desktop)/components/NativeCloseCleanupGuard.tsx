'use client';

import { useEffect, useRef, useState } from 'react';
import { clearNativeAppSessionData } from '@/lib/appSessionCleanup';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { NATIVE_CLOSE_CONFIRM_COPY } from '@/lib/nativeClosePolicy';
import { formatUiError } from '@/lib/uiDisplayText';
import { useAppDialog } from './AppDialog';
import LoadingStatusPanel from './LoadingStatusPanel';

const CLOSE_CLEANUP_TIMEOUT_MS = 7000;

function timeoutAfter(ms: number): Promise<{ status: 'timeout' }> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
}

export default function NativeCloseCleanupGuard() {
  const { dialogNode, showAlert, showConfirm } = useAppDialog();
  const closingRef = useRef(false);
  const [closeProgress, setCloseProgress] = useState<LoadProgress | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let active = true;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (!active) return;
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(async (event) => {
        if (closingRef.current) {
          event.preventDefault();
          return;
        }

        const confirmed = await showConfirm({
          ...NATIVE_CLOSE_CONFIRM_COPY,
          cancelLabel: 'Hủy',
          tone: 'warning',
        });
        if (!confirmed) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        closingRef.current = true;
        setCloseProgress(buildLoadProgress('Đang xóa dữ liệu phiên...', 35, 'Dữ liệu trên máy chủ không thay đổi', { indeterminate: true }));
        try {
          const cleanupResult = await Promise.race([
            clearNativeAppSessionData({
              preserveAuth: true,
              resetUndoSession: true,
            })
              .then(() => ({ status: 'cleared' as const }))
              .catch((error: unknown) => ({ status: 'failed' as const, error })),
            timeoutAfter(CLOSE_CLEANUP_TIMEOUT_MS),
          ]);
          if (cleanupResult.status === 'timeout') {
            console.warn('[native-close-cleanup] session cleanup timed out; closing app');
          } else if (cleanupResult.status === 'failed') {
            console.warn('[native-close-cleanup] session cleanup failed; closing app', cleanupResult.error);
          }
          setCloseProgress(buildLoadProgress('Đang đóng ứng dụng...', 100, 'Dữ liệu trên máy chủ không thay đổi'));
          await appWindow.destroy();
        } catch (error) {
          closingRef.current = false;
          setCloseProgress(null);
          event.preventDefault();
          await showAlert({
            title: 'Không thể dọn dẹp khi đóng ứng dụng',
            message: formatUiError(error, 'Ứng dụng không thể xóa phiên giao diện. Cửa sổ sẽ được giữ nguyên.'),
            tone: 'error',
          });
        }
      });
    }).catch((error) => {
      console.debug('[native-close-cleanup] close cleanup hook unavailable', error);
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [showAlert, showConfirm]);

  return (
    <>
      {dialogNode}
      {closeProgress && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/45 p-6">
          <LoadingStatusPanel
            progress={closeProgress}
            className="min-h-0 w-full max-w-sm rounded-xl border border-outline-variant bg-surface shadow-xl"
            style={{
              width: 'min(420px, calc(100vw - 32px))',
              maxWidth: '420px',
              minWidth: 'min(320px, calc(100vw - 32px))',
              flex: '0 0 min(420px, calc(100vw - 32px))',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}
    </>
  );
}
