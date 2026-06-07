'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { isTauriRuntime } from '@/lib/nativeRuntime';

function NativeAppRequiredPlaceholder() {
  return (
    <div className="flex h-screen min-w-0 flex-1 items-center justify-center bg-surface px-6 text-on-surface">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-primary-container text-primary">
          <span className="material-symbols-outlined text-[30px]">desktop_windows</span>
        </div>
        <h1 className="text-xl font-semibold">Native app required</h1>
        <p className="mt-3 text-sm leading-6 text-on-surface-variant">
          Seasonal Management now uses the native SQLite engine as the only operational data store. Open this workspace in the Tauri desktop app to load schedules, sync, and make allocation changes.
        </p>
      </div>
    </div>
  );
}

export default function NativeRuntimeGate({ children }: { children: ReactNode }) {
  const [runtimeReady] = useState(() => isTauriRuntime());

  if (!runtimeReady) {
    return <NativeAppRequiredPlaceholder />;
  }

  return <>{children}</>;
}
