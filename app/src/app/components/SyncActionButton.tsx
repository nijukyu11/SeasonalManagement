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
  const busy = syncing || clickLocked;
  const label = busy ? 'Saving...' : 'Save';

  const handleClick = useCallback(async () => {
    if (busy || clickLockedRef.current) return;
    clickLockedRef.current = true;
    setClickLocked(true);
    try {
      await onSync();
    } finally {
      clickLockedRef.current = false;
      setClickLocked(false);
    }
  }, [busy, onSync]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      aria-busy={busy ? 'true' : 'false'}
      aria-live="polite"
      title={busy ? progress ?? 'Save in progress' : progress ?? 'Save changes to server'}
      className={`flex min-w-[116px] items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-caps text-label-caps text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container disabled:cursor-wait disabled:opacity-70 ${className}`}
    >
      <span className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}>sync</span>
      <span>{label}</span>
    </button>
  );
}
