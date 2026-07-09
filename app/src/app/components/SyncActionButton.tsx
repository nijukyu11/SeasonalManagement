'use client';

import { useCallback, useRef, useState } from 'react';

import { getSyncActionButtonState } from './syncActionButtonState';

interface SyncActionButtonProps {
  syncing: boolean;
  pendingCount: number;
  draftCount?: number;
  progress?: string | null;
  onSync: () => Promise<void> | void;
  className?: string;
}

export default function SyncActionButton({
  syncing,
  pendingCount,
  draftCount,
  progress,
  onSync,
  className = '',
}: SyncActionButtonProps) {
  const [clickLocked, setClickLocked] = useState(false);
  const clickLockedRef = useRef(false);
  const state = getSyncActionButtonState({
    syncing: syncing || clickLocked,
    pendingCount,
    draftCount,
    progress,
  });

  const handleClick = useCallback(async () => {
    if (state.busy || !state.canSubmit || clickLockedRef.current) return;
    clickLockedRef.current = true;
    setClickLocked(true);
    try {
      await onSync();
    } finally {
      clickLockedRef.current = false;
      setClickLocked(false);
    }
  }, [state.busy, state.canSubmit, onSync]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={state.disabled}
      aria-busy={state.busy ? 'true' : 'false'}
      aria-live="polite"
      title={state.title}
      className={`flex min-w-[116px] items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container ${state.disabledCursorClass} disabled:opacity-70 ${className}`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${state.busy ? 'animate-spin' : ''}`}>sync</span>
      <span>{state.label}</span>
    </button>
  );
}
