import type {
  RemoteRequestOptions,
  RemoteSeasonWorkspaceWindowInput,
  RemoteSeasonWorkspaceWindowResult,
} from './remoteStore';
import {
  createOperatorSessionAbortError,
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
  registerOperatorSessionCacheClearer,
} from './operatorSessionCacheRegistry.ts';
import {
  readWorkspaceWindowSnapshot,
  WORKSPACE_WINDOW_CACHE_TTL_MS,
  type CachedWorkspaceWindow,
} from './seasonWorkspaceReadModel.ts';
import {
  useSeasonWorkspaceStore,
  type SeasonWorkspaceWindowRequestStatus,
} from './seasonWorkspaceStore.ts';
import type { WorkspaceWindowV2SnapshotToken } from './seasonWorkspaceWindowRpcV2Contract.ts';

export type { SeasonWorkspaceWindowRequestStatus } from './seasonWorkspaceStore.ts';

type WorkspaceWindowLoader = (
  input: RemoteSeasonWorkspaceWindowInput,
  options?: RemoteRequestOptions,
) => Promise<RemoteSeasonWorkspaceWindowResult | null>;

export interface ServerWorkspaceWindowInput {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  resourceType?: 'gate' | 'checkin' | 'schedule' | string | null;
  limit?: number | null;
}

export type SeasonWorkspaceWindowFreshness = 'missing' | 'fresh' | 'stale';

export interface SeasonWorkspaceWindowState {
  windowKey: string;
  generation: number;
  snapshot: CachedWorkspaceWindow | null;
  freshness: SeasonWorkspaceWindowFreshness;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  shouldRevalidate: boolean;
  fetchedAt: number | null;
  dataVersion: number | null;
  serverHighWater: number | null;
  staleReason: string | null;
  lastError: string | null;
}

interface RevalidateOptions {
  force?: boolean;
  signal?: AbortSignal;
  initiator?: 'automatic' | 'immediate';
  expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
}

interface CoordinatorEntry {
  promise: Promise<CachedWorkspaceWindow | null>;
  controller: AbortController;
  generation: number;
  epoch: number;
  started: boolean;
  cancelled: boolean;
  hasUnsignalledConsumer: boolean;
  activeSignals: Set<AbortSignal>;
  promote(): void;
}

export function buildServerWorkspaceWindowKey(input: ServerWorkspaceWindowInput): string {
  return ['server-window-v2', input.seasonId, input.dateFrom ?? '', input.dateTo ?? '', input.resourceType ?? 'all', input.limit ?? 'all'].join('|');
}

function jitterMilliseconds(random: () => number): number {
  return 100 + Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, random())) * 201);
}

export function createSeasonWorkspaceWindowCoordinator(deps: {
  loadWindow: WorkspaceWindowLoader;
  store: Pick<typeof useSeasonWorkspaceStore, 'getState'>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  getOperatorSessionEpoch: () => number;
  isOperatorSessionEpochCurrent: (epoch: number) => boolean;
}) {
  const inFlight = new Map<string, CoordinatorEntry>();

  const read = (
    input: ServerWorkspaceWindowInput,
    options: { now?: number; ttlMs?: number } = {},
  ): SeasonWorkspaceWindowState => {
    const windowKey = buildServerWorkspaceWindowKey(input);
    const workspace = deps.store.getState().workspaces[input.seasonId];
    const metadata = workspace?.windowMetadata.get(windowKey);
    const snapshot = readWorkspaceWindowSnapshot(workspace, windowKey);
    const now = options.now ?? deps.now();
    const ttlMs = options.ttlMs ?? WORKSPACE_WINDOW_CACHE_TTL_MS;
    const expired = metadata?.fetchedAt != null && now - metadata.fetchedAt > ttlMs;
    const freshness: SeasonWorkspaceWindowFreshness = !snapshot
      ? 'missing'
      : metadata?.staleReason != null || metadata?.fetchedAt == null || expired
        ? 'stale'
        : 'fresh';
    return {
      windowKey,
      generation: metadata?.generation ?? 0,
      snapshot,
      freshness,
      requestStatus: metadata?.requestStatus ?? 'idle',
      shouldRevalidate: freshness !== 'fresh',
      fetchedAt: metadata?.fetchedAt ?? null,
      dataVersion: metadata?.dataVersion ?? null,
      serverHighWater: metadata?.serverHighWater ?? null,
      staleReason: expired && metadata?.staleReason == null ? 'ttl' : metadata?.staleReason ?? null,
      lastError: metadata?.lastError ?? null,
    };
  };

  const attachLease = (entry: CoordinatorEntry, signal?: AbortSignal): void => {
    if (!signal) {
      entry.hasUnsignalledConsumer = true;
      return;
    }
    if (signal.aborted) {
      if (!entry.hasUnsignalledConsumer && entry.activeSignals.size === 0) {
        entry.cancelled = true;
        entry.controller.abort(signal.reason);
        entry.promote();
      }
      return;
    }
    entry.activeSignals.add(signal);
    signal.addEventListener('abort', () => {
      entry.activeSignals.delete(signal);
      if (!entry.hasUnsignalledConsumer && entry.activeSignals.size === 0) {
        entry.cancelled = true;
        entry.controller.abort(signal.reason);
        entry.promote();
      }
    }, { once: true });
  };

  const revalidateInternal = (
    input: ServerWorkspaceWindowInput,
    options: RevalidateOptions = {},
  ): Promise<CachedWorkspaceWindow | null> => {
    const current = read(input);
    if (!options.force && !current.shouldRevalidate) return Promise.resolve(current.snapshot);

    const entryKey = `${current.windowKey}@${current.generation}`;
    const existing = inFlight.get(entryKey);
    if (existing) {
      attachLease(existing, options.signal);
      if ((options.initiator ?? 'automatic') === 'immediate') existing.promote();
      return existing.promise;
    }

    const epoch = deps.getOperatorSessionEpoch();
    const controller = new AbortController();
    let promoteStart: (() => void) | null = null;
    const promoted = new Promise<void>((resolve) => { promoteStart = resolve; });
    const requestGeneration = deps.store.getState().beginSeasonWindowRequest(input.seasonId, current.windowKey);
    const entry: CoordinatorEntry = {
      promise: Promise.resolve(null) as Promise<CachedWorkspaceWindow | null>,
      controller,
      generation: requestGeneration,
      epoch,
      started: false,
      cancelled: false,
      hasUnsignalledConsumer: false,
      activeSignals: new Set<AbortSignal>(),
      promote: () => { promoteStart?.(); },
    };

    const run = async (): Promise<CachedWorkspaceWindow | null> => {
      const initiator = options.initiator ?? 'automatic';
      if (initiator === 'automatic') {
        await Promise.race([deps.delay(jitterMilliseconds(deps.random)), promoted]);
      }
      entry.started = true;
      if (entry.cancelled || controller.signal.aborted || !deps.isOperatorSessionEpochCurrent(epoch)) {
        if (deps.isOperatorSessionEpochCurrent(epoch)) {
          deps.store.getState().cancelSeasonWindowRequest(input.seasonId, current.windowKey, requestGeneration);
        }
        throw createOperatorSessionAbortError();
      }

      const beforeLoad = read(input);
      if (beforeLoad.generation !== requestGeneration) {
        if (beforeLoad.freshness === 'fresh') return beforeLoad.snapshot;
        return revalidateInternal(input, { force: true, initiator: 'immediate', expectedSnapshot: options.expectedSnapshot });
      }
      if (!options.force && !beforeLoad.shouldRevalidate) return beforeLoad.snapshot;

      try {
        const result = await deps.loadWindow({
          ...input,
          limit: input.limit ?? undefined,
        }, {
          signal: controller.signal,
          expectedSnapshot: options.expectedSnapshot,
        });
        if (entry.cancelled || !deps.isOperatorSessionEpochCurrent(epoch)) throw createOperatorSessionAbortError();
        if (!result) {
          deps.store.getState().cancelSeasonWindowRequest(input.seasonId, current.windowKey, requestGeneration);
          return null;
        }
        const committed = deps.store.getState().commitSeasonWindowResult({
          seasonId: input.seasonId,
          windowKey: current.windowKey,
          requestGeneration,
          operatorSessionEpoch: epoch,
          rows: result.sourceRows,
          records: result.records,
          modifications: result.modifications,
          syncMeta: result.syncMeta,
          fetchedAt: deps.now(),
          dataVersion: result.cursor.dataVersion,
          serverHighWater: result.cursor.serverHighWater,
        });
        if (!committed) {
          if (!deps.isOperatorSessionEpochCurrent(epoch)) throw createOperatorSessionAbortError();
          const latest = read(input);
          if (latest.generation !== requestGeneration && latest.freshness === 'fresh') return latest.snapshot;
          return revalidateInternal(input, { force: true, initiator: 'immediate' });
        }
        return read(input).snapshot;
      } catch (error) {
        if (entry.cancelled || controller.signal.aborted || !deps.isOperatorSessionEpochCurrent(epoch)) {
          if (deps.isOperatorSessionEpochCurrent(epoch)) {
            deps.store.getState().cancelSeasonWindowRequest(input.seasonId, current.windowKey, requestGeneration);
          }
          throw createOperatorSessionAbortError();
        }
        deps.store.getState().failSeasonWindowRequest(input.seasonId, current.windowKey, requestGeneration, error);
        throw error;
      }
    };

    entry.promise = run().finally(() => {
      if (inFlight.get(entryKey) === entry) inFlight.delete(entryKey);
    });
    inFlight.set(entryKey, entry);
    attachLease(entry, options.signal);
    if ((options.initiator ?? 'automatic') === 'immediate') entry.promote();
    return entry.promise;
  };

  const revalidate = (
    input: ServerWorkspaceWindowInput,
    options: { force?: boolean; signal?: AbortSignal; initiator?: 'automatic' | 'immediate' } = {},
  ) => revalidateInternal(input, options);

  const revalidateAfterMutation = (
    input: ServerWorkspaceWindowInput,
    options: {
      operatorSessionEpoch: number;
      generationAlreadyAdvanced: boolean;
      expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
    },
  ): Promise<CachedWorkspaceWindow | null> => {
    if (!deps.isOperatorSessionEpochCurrent(options.operatorSessionEpoch)) {
      return Promise.reject(createOperatorSessionAbortError());
    }
    if (!options.generationAlreadyAdvanced) {
      const advanced = deps.store.getState().markSeasonWorkspaceStale(input.seasonId, 'mutation', options.operatorSessionEpoch);
      if (!advanced) return Promise.reject(createOperatorSessionAbortError());
    }
    return revalidateInternal(input, {
      force: true,
      initiator: 'immediate',
      expectedSnapshot: options.expectedSnapshot,
    });
  };

  const clear = (): void => {
    for (const entry of inFlight.values()) {
      entry.cancelled = true;
      entry.controller.abort(createOperatorSessionAbortError());
      entry.promote();
    }
    inFlight.clear();
  };

  return { read, revalidate, revalidateAfterMutation, clear };
}

const defaultCoordinator = createSeasonWorkspaceWindowCoordinator({
  loadWindow: (input, options) => import('./remoteStore.ts').then((module) => module.loadSeasonWorkspaceWindowTransport(input, options)),
  store: useSeasonWorkspaceStore,
  now: Date.now,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
});

registerOperatorSessionCacheClearer('season-workspace-window-coordinator', defaultCoordinator.clear);

export const readSeasonWorkspaceWindowState = defaultCoordinator.read;
export const revalidateSeasonWorkspaceWindow = defaultCoordinator.revalidate;
export const revalidateSeasonWorkspaceAfterMutation = defaultCoordinator.revalidateAfterMutation;
