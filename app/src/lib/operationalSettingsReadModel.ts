import type { OperationalSettings } from './types';
import { getCachedOperationalSettings, setCachedOperationalSettings } from './seasonDataCache.ts';
import { useSeasonWorkspaceStore, type SeasonWorkspaceWindowRequestStatus } from './seasonWorkspaceStore.ts';
import {
  createOperatorSessionAbortError,
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
  registerOperatorSessionCacheClearer,
} from './operatorSessionCacheRegistry.ts';

export const OPERATIONAL_SETTINGS_CACHE_TTL_MS = 10 * 60_000;

export interface OperationalSettingsReadState {
  snapshot: OperationalSettings | null;
  freshness: 'missing' | 'fresh' | 'stale';
  shouldRevalidate: boolean;
  fetchedAt: number | null;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  lastError: string | null;
}

interface Dependencies {
  load: (operatorSessionEpoch: number) => Promise<OperationalSettings>;
  getEpoch: () => number;
  isCurrent: (epoch: number) => boolean;
  commitShared: (settings: OperationalSettings, epoch: number) => boolean;
  now: () => number;
  initialSnapshot?: OperationalSettings | null;
}

export function createOperationalSettingsReadModel(dependencies: Dependencies) {
  let snapshot = dependencies.initialSnapshot ?? null;
  let fetchedAt: number | null = snapshot ? dependencies.now() : null;
  let requestStatus: SeasonWorkspaceWindowRequestStatus = 'idle';
  let lastError: string | null = null;
  let inFlight: Promise<OperationalSettings> | null = null;
  let clearEpoch = 0;

  function read(now = dependencies.now(), ttlMs = OPERATIONAL_SETTINGS_CACHE_TTL_MS): OperationalSettingsReadState {
    const missing = snapshot === null;
    const stale = !missing && (fetchedAt === null || now - fetchedAt > ttlMs);
    return {
      snapshot,
      freshness: missing ? 'missing' : stale ? 'stale' : 'fresh',
      shouldRevalidate: missing || stale,
      fetchedAt,
      requestStatus,
      lastError,
    };
  }

  function commit(settings: OperationalSettings, operatorSessionEpoch: number, committedAt = dependencies.now()): boolean {
    if (!dependencies.isCurrent(operatorSessionEpoch)) return false;
    if (!dependencies.commitShared(settings, operatorSessionEpoch)) return false;
    snapshot = settings;
    fetchedAt = committedAt;
    requestStatus = 'ready';
    lastError = null;
    return true;
  }

  function revalidate(force = false): Promise<OperationalSettings> {
    if (inFlight) return inFlight;
    const current = read();
    if (!force && !current.shouldRevalidate && current.snapshot) return Promise.resolve(current.snapshot);
    const operatorSessionEpoch = dependencies.getEpoch();
    const startingClearEpoch = clearEpoch;
    requestStatus = snapshot ? 'refreshing' : 'loading';
    lastError = null;
    const promise = dependencies.load(operatorSessionEpoch).then((settings) => {
      if (startingClearEpoch !== clearEpoch || !dependencies.isCurrent(operatorSessionEpoch)) {
        throw createOperatorSessionAbortError();
      }
      commit(settings, operatorSessionEpoch);
      return settings;
    }).catch((error) => {
      if (startingClearEpoch !== clearEpoch || !dependencies.isCurrent(operatorSessionEpoch)) {
        throw createOperatorSessionAbortError();
      }
      requestStatus = 'error';
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  return {
    read,
    revalidate,
    commit,
    clear(): void {
      clearEpoch += 1;
      snapshot = null;
      fetchedAt = null;
      requestStatus = 'idle';
      lastError = null;
      inFlight = null;
    },
  };
}

const operationalSettingsReadModel = createOperationalSettingsReadModel({
  load: async (operatorSessionEpoch) => {
    const { getOperationalSettings } = await import('./remoteStore.ts');
    return getOperationalSettings({ force: true, operatorSessionEpoch });
  },
  getEpoch: getOperatorSessionEpoch,
  isCurrent: isOperatorSessionEpochCurrent,
  commitShared: (settings, epoch) => {
    if (!isOperatorSessionEpochCurrent(epoch)) return false;
    setCachedOperationalSettings(settings);
    return useSeasonWorkspaceStore.getState().setOperationalSettings(settings, epoch);
  },
  now: Date.now,
  initialSnapshot: getCachedOperationalSettings(),
});

export function readOperationalSettingsState(
  options: { now?: number; ttlMs?: number } = {},
): OperationalSettingsReadState {
  return operationalSettingsReadModel.read(options.now, options.ttlMs);
}

export function revalidateOperationalSettings(options: { force?: boolean } = {}): Promise<OperationalSettings> {
  return operationalSettingsReadModel.revalidate(options.force);
}

export function commitOperationalSettingsSnapshot(
  settings: OperationalSettings,
  options: { operatorSessionEpoch: number; fetchedAt?: number },
): boolean {
  return operationalSettingsReadModel.commit(settings, options.operatorSessionEpoch, options.fetchedAt);
}

export function clearOperationalSettingsReadModel(): void {
  operationalSettingsReadModel.clear();
}

registerOperatorSessionCacheClearer('operational-settings-read-model', clearOperationalSettingsReadModel);
