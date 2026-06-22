'use client';

import type { CSSProperties } from 'react';
import type { LoadProgress } from '@/lib/importProgress';

interface LoadingStatusPanelProps {
  progress: LoadProgress;
  className?: string;
  style?: CSSProperties;
  mode?: 'compact' | 'fullscreen' | 'inline';
  icon?: string;
}

function joinClassNames(...classNames: Array<string | false | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

export default function LoadingStatusPanel({
  progress,
  className,
  style,
  mode = 'compact',
  icon = 'sync',
}: LoadingStatusPanelProps) {
  const percent = Math.max(0, Math.min(100, progress.percent));
  const shellClassName = mode === 'fullscreen'
    ? 'flex h-dvh items-center justify-center bg-surface px-6 text-on-surface'
    : mode === 'inline'
      ? 'flex w-full items-center justify-center px-4 py-3 text-on-surface'
      : 'flex w-full min-h-[220px] items-center justify-center px-6 py-10 text-on-surface';
  const barClassName = progress.indeterminate
    ? 'h-full w-1/2 rounded-full bg-primary shadow-sm animate-pulse'
    : 'h-full rounded-full bg-primary shadow-sm transition-[width] duration-300 ease-out';
  const innerClassName = mode === 'inline'
    ? 'w-full min-w-0 text-left'
    : 'w-[min(28rem,calc(100vw-3rem))] min-w-[min(20rem,calc(100vw-3rem))] max-w-full text-center';
  const iconClassName = mode === 'inline'
    ? 'flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary-container text-primary'
    : 'mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-container text-primary';

  return (
    <div className={joinClassNames(shellClassName, className)} style={style}>
      <div className={innerClassName} role="status" aria-live="polite">
        <div className={iconClassName}>
          <span className="material-symbols-outlined animate-spin text-[24px]">{icon}</span>
        </div>
        <div className={joinClassNames(mode === 'inline' ? 'mt-3 text-sm' : 'mt-4 text-base leading-6', 'min-w-0 text-balance font-semibold text-on-surface')}>
          {progress.label}
        </div>
        {progress.detail && (
          <div className="mt-1 min-w-0 text-balance text-xs font-medium leading-5 text-on-surface-variant">{progress.detail}</div>
        )}
        <div
          className="mt-4 h-2 w-full min-w-0 overflow-hidden rounded-full bg-surface-container-high"
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.indeterminate ? undefined : percent}
        >
          <div
            className={barClassName}
            style={progress.indeterminate ? undefined : { width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 text-xs font-semibold tabular-nums text-on-surface-variant">
          {progress.indeterminate ? 'Working...' : `${percent}%`}
        </div>
      </div>
    </div>
  );
}
