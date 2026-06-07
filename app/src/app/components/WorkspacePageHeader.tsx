'use client';

import type { ReactNode } from 'react';

interface WorkspacePageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  seasonControl?: ReactNode;
  statusControls?: ReactNode;
  draftControls?: ReactNode;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  className?: string;
}

export default function WorkspacePageHeader({
  title,
  subtitle,
  leading,
  seasonControl,
  statusControls,
  draftControls,
  primaryActions,
  secondaryActions,
  className = '',
}: WorkspacePageHeaderProps) {
  const hasTopRight = Boolean(seasonControl || statusControls);
  const hasActions = Boolean(primaryActions || secondaryActions);

  return (
    <header className={`z-30 flex-none border-b border-slate-200 bg-white/80 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80 ${className}`}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {leading}
            <div className="min-w-0">
              <h1 className="font-h3 text-h3 text-on-surface">{title}</h1>
              {subtitle && (
                <p className="mt-0.5 max-w-3xl truncate font-body-sm text-body-sm text-on-surface-variant">{subtitle}</p>
              )}
            </div>
          </div>
          {hasTopRight && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
              {seasonControl}
              {statusControls}
            </div>
          )}
        </div>

        {draftControls && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {draftControls}
          </div>
        )}

        {hasActions && (
          <div className="flex min-w-0 flex-col gap-2 border-t border-slate-200/80 pt-3 dark:border-slate-800 md:flex-row md:items-center md:justify-between">
            {primaryActions && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {primaryActions}
              </div>
            )}
            {secondaryActions && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
                {secondaryActions}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
