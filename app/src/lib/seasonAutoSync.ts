export const AUTO_SYNC_DEBOUNCE_MS = 3000;
export const AUTO_SYNC_IDLE_TIMEOUT_MS = 1000;
export const AUTO_SYNC_RETRY_DELAYS_MS = [] as const;
const AUTO_SYNC_SOURCE_FAMILIES = new Set(['daily', 'checkin', 'gate']);

export type AutoSyncMode = 'auto' | 'manual';

export type SeasonAutoSyncStatus =
  | 'synced'
  | 'dirty'
  | 'scheduled'
  | 'syncing'
  | 'live'
  | 'offline'
  | 'failed';

export type SeasonAutoSyncRunStatus = 'synced' | 'busy' | 'failed';

export interface SeasonAutoSyncRunResult {
  status: SeasonAutoSyncRunStatus;
  message?: string;
  reviewCount?: number;
}

export interface SeasonAutoSyncState {
  status: SeasonAutoSyncStatus;
  pendingCount: number | null;
  lastLocalChangeAt: number | null;
  localRevision: number | null;
  message: string | null;
  progress: string | null;
  mode: AutoSyncMode | null;
  retryAttempt: number;
}

export interface SeasonAutoSyncSummary {
  pendingCount?: number | null;
  lastLocalChangeAt?: number | null;
  localRevision?: number | null;
  source?: string;
  [key: string]: unknown;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type IdleHandle = number;

type IdleDeadlineCallback = () => void;

interface SeasonAutoSyncRuntime {
  setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
  clearTimeout: (handle: TimeoutHandle) => void;
  requestIdleCallback?: (callback: IdleDeadlineCallback, options?: { timeout?: number }) => IdleHandle;
  cancelIdleCallback?: (handle: IdleHandle) => void;
  isOnline?: () => boolean;
  getPendingCount: (seasonId: string) => Promise<number>;
  getBlockedReason?: (seasonId: string) => string | null | Promise<string | null>;
  prepareSync?: (seasonId: string, mode: AutoSyncMode, source: string | null) => Promise<void> | void;
  run: (seasonId: string, mode: AutoSyncMode, source: string | null) => Promise<SeasonAutoSyncRunResult>;
  onState?: (seasonId: string, state: SeasonAutoSyncState) => void;
}

interface SeasonAutoSyncRecord {
  state: SeasonAutoSyncState;
  timeoutHandle: TimeoutHandle | null;
  idleHandle: IdleHandle | null;
  running: boolean;
  runningPromise: Promise<SeasonAutoSyncRunResult> | null;
  queued: boolean;
  source: string | null;
}

export function createInitialSeasonAutoSyncState(): SeasonAutoSyncState {
  return {
    status: 'synced',
    pendingCount: null,
    lastLocalChangeAt: null,
    localRevision: null,
    message: null,
    progress: null,
    mode: null,
    retryAttempt: 0,
  };
}

export function getAutoSyncRetryDelayMs(retryAttempt: number): number | null {
  void retryAttempt;
  return null;
}

function syncSourceFamily(source: string | null | undefined): string {
  return (source ?? '').split('-')[0] || '';
}

export function shouldAutoSyncSource(source: string | null | undefined): boolean {
  return AUTO_SYNC_SOURCE_FAMILIES.has(syncSourceFamily(source));
}

export function isTransientSyncFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    'failed to fetch',
    'network',
    'timeout',
    'timed out',
    'offline',
    'temporarily',
    'connection',
    'aborted',
    'rate limit',
  ].some((needle) => normalized.includes(needle));
}

export class SeasonAutoSyncScheduler {
  private readonly records = new Map<string, SeasonAutoSyncRecord>();
  private readonly runtime: SeasonAutoSyncRuntime;

  constructor(runtime: SeasonAutoSyncRuntime) {
    this.runtime = runtime;
  }

  notifyLocalChange(seasonId: string, summary: SeasonAutoSyncSummary = {}): void {
    const record = this.getRecord(seasonId);
    record.source = summary.source ?? record.source;
    const pendingCount = summary.pendingCount ?? record.state.pendingCount ?? 1;
    const hasPending = (pendingCount ?? 0) > 0;
    if (record.running) {
      record.queued = hasPending;
      this.updateState(seasonId, {
        status: 'syncing',
        pendingCount,
        lastLocalChangeAt: summary.lastLocalChangeAt ?? record.state.lastLocalChangeAt,
        localRevision: summary.localRevision ?? record.state.localRevision,
        message: record.state.message ?? 'Saving',
        progress: record.state.progress ?? 'Saving',
        mode: record.state.mode ?? 'auto',
      });
      return;
    }

    this.cancelScheduled(record);
    const canAutoSync = hasPending &&
      this.isOnline() &&
      shouldAutoSyncSource(record.source);
    this.updateState(seasonId, {
      status: hasPending ? (canAutoSync ? 'scheduled' : this.isOnline() ? 'dirty' : 'offline') : 'synced',
      pendingCount,
      lastLocalChangeAt: summary.lastLocalChangeAt ?? record.state.lastLocalChangeAt,
      localRevision: summary.localRevision ?? record.state.localRevision,
      message: summary.pendingCount === 0
        ? null
        : canAutoSync
          ? 'Auto save queued'
          : 'Unsynced local changes. Use Save to push them to the server.',
      progress: null,
      mode: canAutoSync ? 'auto' : null,
    });

      if (!hasPending) {
      this.updateState(seasonId, { retryAttempt: 0 });
      return;
    }

    if (!this.isOnline()) {
      this.updateState(seasonId, {
        status: 'offline',
        message: 'Offline. Use Save when the connection returns.',
      });
      return;
    }

    if (canAutoSync) {
      this.schedule(seasonId, record, AUTO_SYNC_DEBOUNCE_MS);
    }
  }

  notifyGuardChanged(seasonId: string): void {
    const record = this.getRecord(seasonId);
    if (!record.state.pendingCount) return;
    if (record.running) return;
    const canAutoSync = this.isOnline() && shouldAutoSyncSource(record.source);
    this.cancelScheduled(record);
    this.updateState(seasonId, {
      status: canAutoSync ? 'scheduled' : this.isOnline() ? 'dirty' : 'offline',
      message: this.isOnline()
        ? canAutoSync ? 'Auto save queued' : 'Unsynced local changes. Use Save to push them to the server.'
        : 'Offline. Use Save when the connection returns.',
      mode: canAutoSync ? 'auto' : null,
    });
    if (canAutoSync) this.schedule(seasonId, record, AUTO_SYNC_DEBOUNCE_MS);
  }

  notifyOnline(): void {
    for (const [seasonId, record] of this.records) {
      if (
        !record.state.pendingCount ||
        record.running
      ) continue;
      const canAutoSync = this.isOnline() && shouldAutoSyncSource(record.source);
      this.cancelScheduled(record);
      this.updateState(seasonId, {
        status: canAutoSync ? 'scheduled' : this.isOnline() ? 'dirty' : 'offline',
        message: this.isOnline()
          ? canAutoSync ? 'Auto save queued' : 'Unsynced local changes. Use Save to push them to the server.'
          : 'Offline. Use Save when the connection returns.',
        mode: canAutoSync ? 'auto' : null,
      });
      if (canAutoSync) this.schedule(seasonId, record, AUTO_SYNC_DEBOUNCE_MS);
    }
  }

  async syncNow(seasonId: string, source: string | null = null): Promise<SeasonAutoSyncRunResult> {
    const record = this.getRecord(seasonId);
    record.source = source ?? record.source;
    this.cancelScheduled(record);
    return this.runSeason(seasonId, 'manual');
  }

  setProgress(seasonId: string, progress: string | null): void {
    this.updateState(seasonId, { progress });
  }

  getState(seasonId: string): SeasonAutoSyncState {
    return this.getRecord(seasonId).state;
  }

  private getRecord(seasonId: string): SeasonAutoSyncRecord {
    const existing = this.records.get(seasonId);
    if (existing) return existing;
    const record: SeasonAutoSyncRecord = {
      state: createInitialSeasonAutoSyncState(),
      timeoutHandle: null,
      idleHandle: null,
      running: false,
      runningPromise: null,
      queued: false,
      source: null,
    };
    this.records.set(seasonId, record);
    return record;
  }

  private updateState(seasonId: string, patch: Partial<SeasonAutoSyncState>): void {
    const record = this.getRecord(seasonId);
    record.state = { ...record.state, ...patch };
    this.runtime.onState?.(seasonId, record.state);
  }

  private isOnline(): boolean {
    return this.runtime.isOnline?.() ?? true;
  }

  private cancelScheduled(record: SeasonAutoSyncRecord): void {
    if (record.timeoutHandle != null) {
      this.runtime.clearTimeout(record.timeoutHandle);
      record.timeoutHandle = null;
    }
    if (record.idleHandle != null) {
      this.runtime.cancelIdleCallback?.(record.idleHandle);
      record.idleHandle = null;
    }
  }

  private schedule(seasonId: string, record: SeasonAutoSyncRecord, delay: number): void {
    if (!this.isOnline() || !shouldAutoSyncSource(record.source)) return;
    record.timeoutHandle = this.runtime.setTimeout(() => {
      record.timeoutHandle = null;
      const run = () => {
        record.idleHandle = null;
        void this.runSeason(seasonId, 'auto');
      };
      if (this.runtime.requestIdleCallback) {
        record.idleHandle = this.runtime.requestIdleCallback(run, {
          timeout: AUTO_SYNC_IDLE_TIMEOUT_MS,
        });
        return;
      }
      run();
    }, delay);
  }

  private async runSeason(seasonId: string, mode: AutoSyncMode): Promise<SeasonAutoSyncRunResult> {
    const record = this.getRecord(seasonId);
    if (record.running) {
      record.queued = true;
      if (record.runningPromise) return record.runningPromise;
      return { status: 'failed', message: 'Sync already running.' };
    }
    if (!this.isOnline()) {
      this.updateState(seasonId, {
        status: 'offline',
        message: 'Offline. Use Save when the connection returns.',
        mode,
      });
      return { status: 'failed', message: 'Offline. Use Save when the connection returns.' };
    }

    const blockedReason = await this.runtime.getBlockedReason?.(seasonId);
    if (blockedReason) {
      this.updateState(seasonId, {
        status: 'dirty',
        message: blockedReason,
        mode: null,
      });
      return { status: 'failed', message: blockedReason };
    }

    try {
      await this.runtime.prepareSync?.(seasonId, mode, record.source);
    } catch (err) {
      const message = (err as Error).message;
      this.handleFailure(seasonId, message);
      return { status: 'failed', message };
    }

    let pendingCount: number;
    try {
      pendingCount = await this.runtime.getPendingCount(seasonId);
    } catch (err) {
      const message = (err as Error).message;
      this.handleFailure(seasonId, message);
      return { status: 'failed', message };
    }
    if (pendingCount <= 0 && mode !== 'manual') {
      this.updateState(seasonId, {
        status: 'synced',
        pendingCount: 0,
        lastLocalChangeAt: null,
        message: null,
        progress: null,
        mode: null,
        retryAttempt: 0,
      });
      return { status: 'synced', message: 'No local changes to save.' };
    }

    record.running = true;
    record.queued = false;
    this.updateState(seasonId, {
      status: 'syncing',
      pendingCount,
      message: 'Saving',
      progress: 'Preparing save',
      mode,
    });

    const runningPromise = (async (): Promise<SeasonAutoSyncRunResult> => {
      try {
        const result = await this.runtime.run(seasonId, mode, record.source);
        if (result.status === 'busy') {
          this.updateState(seasonId, {
            status: 'syncing',
            message: result.message ?? 'Save already running.',
            progress: null,
            mode,
          });
          return result;
        }

        if (result.status !== 'synced') {
          this.handleFailure(seasonId, result.message ?? 'Save failed.');
          return result;
        }

        const nextPendingCount = await this.runtime.getPendingCount(seasonId);
        this.updateState(seasonId, {
          status: nextPendingCount > 0 ? 'dirty' : 'synced',
          pendingCount: nextPendingCount,
          lastLocalChangeAt: nextPendingCount > 0 ? record.state.lastLocalChangeAt : null,
          message: nextPendingCount > 0 ? 'New local changes are waiting for the next save.' : null,
          progress: null,
          mode: null,
          retryAttempt: 0,
        });
        return result;
      } catch (err) {
        const message = (err as Error).message;
        this.handleFailure(seasonId, message);
        return { status: 'failed', message };
      } finally {
        record.running = false;
        record.runningPromise = null;
        if (record.queued) {
          record.queued = false;
          const pendingCount = await this.runtime.getPendingCount(seasonId).catch(() => record.state.pendingCount ?? 0);
          if (pendingCount > 0) {
            const canAutoSync = this.isOnline() && shouldAutoSyncSource(record.source);
            this.updateState(seasonId, {
              status: canAutoSync ? 'scheduled' : this.isOnline() ? 'dirty' : 'offline',
              pendingCount,
              message: canAutoSync
                ? 'Auto save queued'
                : this.isOnline()
                  ? 'Unsynced local changes. Use Save to push them to the server.'
                  : 'Offline. Use Save when the connection returns.',
              mode: canAutoSync ? 'auto' : null,
            });
            if (canAutoSync) this.schedule(seasonId, record, AUTO_SYNC_DEBOUNCE_MS);
          }
        }
      }
    })();
    record.runningPromise = runningPromise;
    return runningPromise;
  }

  private handleFailure(seasonId: string, message: string): void {
    this.updateState(seasonId, {
      status: 'failed',
      message,
      progress: null,
      mode: null,
    });
  }
}
