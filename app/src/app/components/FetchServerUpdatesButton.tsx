'use client';

import { useCallback, useRef, useState } from 'react';

interface FetchServerUpdatesButtonProps {
  fetching: boolean;
  progress?: string | null;
  disabled?: boolean;
  onFetch: () => Promise<void> | void;
  className?: string;
}

export default function FetchServerUpdatesButton({
  fetching,
  progress,
  disabled = false,
  onFetch,
  className = '',
}: FetchServerUpdatesButtonProps) {
  const [clickLocked, setClickLocked] = useState(false);
  const clickLockedRef = useRef(false);
  const busy = fetching || clickLocked;
  const blocked = disabled || busy;
  const disabledCursorClass = busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed';
  const label = busy ? 'Fetching...' : 'Fetch data';

  const handleClick = useCallback(async () => {
    if (blocked || clickLockedRef.current) return;
    clickLockedRef.current = true;
    setClickLocked(true);
    try {
      await onFetch();
    } finally {
      clickLockedRef.current = false;
      setClickLocked(false);
    }
  }, [blocked, onFetch]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={blocked}
      aria-busy={busy ? 'true' : 'false'}
      aria-live="polite"
      title={busy ? progress ?? 'Fetching server data' : progress ?? 'Fetch latest data from server. Local edits are not uploaded.'}
      className={`flex min-w-[148px] items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container-high ${disabledCursorClass} disabled:opacity-70 ${className}`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}>cloud_sync</span>
      <span>{label}</span>
    </button>
  );
}
