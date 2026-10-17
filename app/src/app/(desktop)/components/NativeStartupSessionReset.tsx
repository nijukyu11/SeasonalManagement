'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { clearNativeAppEphemeralData } from '@/lib/appSessionCleanup';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { resetUiUndoSession } from '@/lib/uiUndoMemory';
import { formatUiError } from '@/lib/uiDisplayText';
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
    buildLoadProgress('Đang kiểm tra môi trường ứng dụng...', 10, 'Đang chuẩn bị phiên làm việc')
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const native = await isNativeRuntime();
      if (!native) {
        if (!cancelled) setProgress(buildLoadProgress('Đang tải ứng dụng...', 100, 'Phiên trình duyệt đã sẵn sàng'));
        if (!cancelled) setReady(true);
        return;
      }

      try {
        if (!cancelled) {
          setProgress(buildLoadProgress('Đang xóa phiên giao diện cục bộ...', 35, 'Giữ nguyên phiên đăng nhập', { indeterminate: true }));
        }
        clearNativeAppEphemeralData({ preserveAuth: true });
        resetUiUndoSession();
        if (!cancelled) {
          setProgress(buildLoadProgress('Đang kết nối không gian làm việc trên máy chủ', 70, 'Đang tải dữ liệu đã lưu từ máy chủ'));
        }
      } catch (error) {
        if (!cancelled) {
          setWarning(formatUiError(error, 'Không thể dọn dẹp phiên khi khởi động.'));
          setProgress(buildLoadProgress('Đang tiếp tục khởi động...', 85, 'Dọn dẹp khi khởi động chưa thành công'));
        }
      } finally {
        if (!cancelled) {
          setProgress(buildLoadProgress('Đang hiển thị lịch mới nhất', 100, 'Đang kiểm tra thay đổi trên máy chủ sau khi mở'));
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
