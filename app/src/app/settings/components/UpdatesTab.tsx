'use client';

import { useAppUpdate } from '@/app/components/AppUpdateProvider';
import { formatUpdateDate } from '@/lib/appUpdater';

function formatBytes(value: number): string {
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unitIndex;
  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function statusText(status: ReturnType<typeof useAppUpdate>['checkResult']): string {
  if (!status) return 'Updates have not been checked in this session.';
  if (status.status === 'unavailable') return status.message;
  if (status.status === 'upToDate') return status.message;
  return `Update ${status.update.version} is available.`;
}

export default function UpdatesTab() {
  const {
    availableUpdate,
    checkNow,
    checkResult,
    checking,
    currentVersion,
    downloadAndInstall,
    error,
    installResult,
    installing,
    lastCheckedAt,
    progress,
    relaunch,
  } = useAppUpdate();

  const lastCheckedLabel = lastCheckedAt == null
    ? 'Never'
    : formatUpdateDate(new Date(lastCheckedAt).toISOString());
  const progressLabel = progress.contentLength == null
    ? formatBytes(progress.downloadedBytes)
    : `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.contentLength)}`;

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-h3 text-[18px] font-semibold text-on-surface">Application Updates</h2>
            <p className="mt-1 max-w-3xl text-sm text-on-surface-variant">
              Desktop updates are signed by Tauri and downloaded from GitHub Releases after operator confirmation.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={checking || installing}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className={`material-symbols-outlined text-[18px] ${checking ? 'animate-spin' : ''}`}>
              {checking ? 'progress_activity' : 'sync'}
            </span>
            {checking ? 'Checking' : 'Check for updates'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant">Current version</div>
              <div className="mt-1 text-lg font-semibold text-on-surface">{currentVersion ?? 'Unknown'}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant">Latest version</div>
              <div className="mt-1 text-lg font-semibold text-on-surface">{availableUpdate?.version ?? 'No newer release'}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant">Last checked</div>
              <div className="mt-1 text-lg font-semibold text-on-surface">{lastCheckedLabel ?? 'Never'}</div>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 text-[22px] text-primary">
                {availableUpdate ? 'new_releases' : 'verified'}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-on-surface">{statusText(checkResult)}</h3>
                {availableUpdate?.publishedAt && (
                  <p className="mt-1 text-sm text-on-surface-variant">
                    Published {formatUpdateDate(availableUpdate.publishedAt)}
                  </p>
                )}
                {availableUpdate?.notes && (
                  <p className="mt-3 whitespace-pre-line text-sm leading-6 text-on-surface-variant">{availableUpdate.notes}</p>
                )}
                {error && <p className="mt-3 text-sm font-medium text-error">{error}</p>}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
          <h3 className="text-sm font-semibold text-on-surface">Install update</h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            Download starts only after confirmation. Restart is required after installation.
          </p>

          <div className="mt-4 space-y-3">
            <button
              type="button"
              onClick={() => void downloadAndInstall()}
              disabled={!availableUpdate || checking || installing || Boolean(installResult)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[18px] ${installing ? 'animate-spin' : ''}`}>
                {installing ? 'progress_activity' : 'download'}
              </span>
              {installing ? 'Downloading and installing' : 'Download & install'}
            </button>

            <button
              type="button"
              onClick={() => void relaunch()}
              disabled={!installResult || installing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">restart_alt</span>
              Restart app
            </button>
          </div>

          {(installing || progress.percent != null) && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs font-semibold text-on-surface-variant">
                <span>{progressLabel}</span>
                <span>{progress.percent == null ? 'Working' : `${progress.percent}%`}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-container-high">
                <div
                  className="h-2 rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${progress.percent ?? 25}%` }}
                />
              </div>
            </div>
          )}

          {installResult && (
            <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
              {installResult.message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
