'use client';

import { useCallback, useRef, useState } from 'react';

interface SyncActionButtonProps {
  syncing: boolean;
  pendingCount: number;
  progress?: string | null;
  onSync: () => Promise<void> | void;
  className?: string;
}

export default function SyncActionButton({
  syncing,
  pendingCount,
  progress,
  onSync,
  className = '',
}: SyncActionButtonProps) {
  const [clickLocked, setClickLocked] = useState(false);
  const clickLockedRef = useRef(false);
  const hasPending = pendingCount > 0;
  const busy = syncing || clickLocked;
  const disabledCursorClass = busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed';
  const label = busy ? 'Submitting...' : hasPending ? 'Save pending' : 'No pending';

  const handleClick = useCallback(async () => {
    if (busy || !hasPending || clickLockedRef.current) return;
    clickLockedRef.current = true;
    setClickLocked(true);
    try {
      await onSync();
    } finally {
      clickLockedRef.current = false;
      setClickLocked(false);
    }
  }, [busy, hasPending, onSync]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy || !hasPending}
      aria-busy={busy ? 'true' : 'false'}
      aria-live="polite"
      title={
        busy
          ? progress ?? 'Submitting pending changes'
          : hasPending
            ? progress ?? 'Submit pending changes to server'
            : 'No pending changes to submit'
      }
      className={`flex min-w-[116px] items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container ${disabledCursorClass} disabled:opacity-70 ${className}`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}>sync</span>
      <span>{label}</span>
    </button>
  );
}
