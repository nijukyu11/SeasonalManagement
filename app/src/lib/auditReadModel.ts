import type { AuditDeltaItem, AuditLogEntry, AuditSession } from './auditLog';
import {
  createOperatorSessionAbortError,
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
  registerOperatorSessionCacheClearer,
} from './operatorSessionCacheRegistry.ts';
import type { SeasonWorkspaceWindowRequestStatus } from './seasonWorkspaceStore';

export const AUDIT_READ_CACHE_TTL_MS = 5 * 60_000;

export interface AuditReadState<T> {
  snapshot: T | null;
  freshness: 'missing' | 'fresh' | 'stale';
  shouldRevalidate: boolean;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  fetchedAt: number | null;
  lastError: string | null;
}

interface AuditReadMetadata {
  fetchedAt: number | null;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  lastError: string | null;
}

interface AuditReadModelDependencies {
  loadSessions: (maxSessions: number, operatorSessionEpoch: number) => Promise<AuditSession[]>;
  loadEntries: (sessionId: string, maxEntries: number, operatorSessionEpoch: number) => Promise<AuditLogEntry[]>;
  loadDeltas: (sessionId: string, entryId: string, operatorSessionEpoch: number) => Promise<AuditDeltaItem[]>;
  getOperatorSessionEpoch: () => number;
  isOperatorSessionEpochCurrent: (epoch: number) => boolean;
  now: () => number;
}

const EMPTY_METADATA: AuditReadMetadata = { fetchedAt: null, requestStatus: 'idle', lastError: null };

function stateFor<T>(snapshot: T | undefined, metadata: AuditReadMetadata | undefined, now: number): AuditReadState<T> {
  const resolved = metadata ?? EMPTY_METADATA;
  const missing = snapshot === undefined;
  const stale = !missing && (resolved.fetchedAt === null || now - resolved.fetchedAt > AUDIT_READ_CACHE_TTL_MS);
  return {
    snapshot: snapshot ?? null,
    freshness: missing ? 'missing' : stale ? 'stale' : 'fresh',
    shouldRevalidate: missing || stale,
    requestStatus: resolved.requestStatus,
    fetchedAt: resolved.fetchedAt,
    lastError: resolved.lastError,
  };
}

export function createAuditReadModel(dependencies: AuditReadModelDependencies) {
  const sessionSnapshots = new Map<string, AuditSession[]>();
  const entrySnapshots = new Map<string, AuditLogEntry[]>();
  const deltaSnapshots = new Map<string, AuditDeltaItem[]>();
  const metadata = new Map<string, AuditReadMetadata>();
  const inFlight = new Map<string, Promise<unknown>>();
  let clearEpoch = 0;

  const sessionKey = (limit: number) => `sessions:${limit}`;
  const entryKey = (sessionId: string, limit: number) => `entries:${sessionId}:${limit}`;
  const deltaKey = (sessionId: string, entryId: string) => `deltas:${sessionId}:${entryId}`;

  function revalidate<T>(input: {
    key: string;
    snapshots: Map<string, T>;
    force: boolean;
    load: (operatorSessionEpoch: number) => Promise<T>;
  }): Promise<T> {
    const existing = inFlight.get(input.key) as Promise<T> | undefined;
    if (existing) return existing;
    const current = stateFor(input.snapshots.get(input.key), metadata.get(input.key), dependencies.now());
    if (!input.force && !current.shouldRevalidate && current.snapshot !== null) return Promise.resolve(current.snapshot);
    const operatorSessionEpoch = dependencies.getOperatorSessionEpoch();
    const startingClearEpoch = clearEpoch;
    metadata.set(input.key, {
      ...metadata.get(input.key) ?? EMPTY_METADATA,
      requestStatus: current.snapshot === null ? 'loading' : 'refreshing',
      lastError: null,
    });
    const promise = input.load(operatorSessionEpoch).then((value) => {
      if (startingClearEpoch !== clearEpoch || !dependencies.isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
        throw createOperatorSessionAbortError();
      }
      input.snapshots.set(input.key, value);
      metadata.set(input.key, { fetchedAt: dependencies.now(), requestStatus: 'ready', lastError: null });
      return value;
    }).catch((error) => {
      if (startingClearEpoch !== clearEpoch || !dependencies.isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
        throw createOperatorSessionAbortError();
      }
      metadata.set(input.key, {
        ...metadata.get(input.key) ?? EMPTY_METADATA,
        requestStatus: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }).finally(() => {
      if (inFlight.get(input.key) === promise) inFlight.delete(input.key);
    });
    inFlight.set(input.key, promise);
    return promise;
  }

  return {
    readSessions(maxSessions = 50, now = dependencies.now()) {
      const key = sessionKey(maxSessions);
      return stateFor(sessionSnapshots.get(key), metadata.get(key), now);
    },
    readEntries(sessionId: string, maxEntries = 200, now = dependencies.now()) {
      const key = entryKey(sessionId, maxEntries);
      return stateFor(entrySnapshots.get(key), metadata.get(key), now);
    },
    readDeltas(sessionId: string, entryId: string, now = dependencies.now()) {
      const key = deltaKey(sessionId, entryId);
      return stateFor(deltaSnapshots.get(key), metadata.get(key), now);
    },
    revalidateSessions(maxSessions = 50, force = false) {
      const key = sessionKey(maxSessions);
      return revalidate({ key, snapshots: sessionSnapshots, force, load: (epoch) => dependencies.loadSessions(maxSessions, epoch) });
    },
    revalidateEntries(sessionId: string, maxEntries = 200, force = false) {
      const key = entryKey(sessionId, maxEntries);
      return revalidate({ key, snapshots: entrySnapshots, force, load: (epoch) => dependencies.loadEntries(sessionId, maxEntries, epoch) });
    },
    revalidateDeltas(sessionId: string, entry: AuditLogEntry, force = false) {
      const key = deltaKey(sessionId, entry.id);
      return revalidate({
        key,
        snapshots: deltaSnapshots,
        force,
        load: async (epoch) => {
          const chunks = await dependencies.loadDeltas(sessionId, entry.id, epoch);
          return chunks.length > 0 ? chunks : entry.syncDelta?.exactChanges ?? entry.deltas;
        },
      });
    },
    patchAfterAppend(session: AuditSession, entry: AuditLogEntry, operatorSessionEpoch: number): boolean {
      if (!dependencies.isOperatorSessionEpochCurrent(operatorSessionEpoch)) return false;
      for (const [key, sessions] of sessionSnapshots) {
        sessionSnapshots.set(key, [session, ...sessions.filter((candidate) => candidate.id !== session.id)]);
        metadata.set(key, { fetchedAt: dependencies.now(), requestStatus: 'ready', lastError: null });
      }
      for (const [key, entries] of entrySnapshots) {
        if (!key.startsWith(`entries:${entry.sessionId}:`)) continue;
        entrySnapshots.set(key, [entry, ...entries.filter((candidate) => candidate.id !== entry.id)]);
        metadata.set(key, { fetchedAt: dependencies.now(), requestStatus: 'ready', lastError: null });
      }
      return true;
    },
    clear(): void {
      clearEpoch += 1;
      sessionSnapshots.clear();
      entrySnapshots.clear();
      deltaSnapshots.clear();
      metadata.clear();
      inFlight.clear();
    },
  };
}

const auditReadModel = createAuditReadModel({
  loadSessions: async (maxSessions, operatorSessionEpoch) => {
    const { getAuditSessions } = await import('./remoteStore.ts');
    return getAuditSessions({ maxSessions, operatorSessionEpoch });
  },
  loadEntries: async (sessionId, maxEntries, operatorSessionEpoch) => {
    const { getAuditLogEntries } = await import('./remoteStore.ts');
    return getAuditLogEntries(sessionId, { maxEntries, operatorSessionEpoch });
  },
  loadDeltas: async (sessionId, entryId, operatorSessionEpoch) => {
    const { getAuditDeltaChunks } = await import('./remoteStore.ts');
    const chunks = await getAuditDeltaChunks(sessionId, entryId, { operatorSessionEpoch });
    return chunks.sort((left, right) => left.chunkIndex - right.chunkIndex).flatMap((chunk) => chunk.items);
  },
  getOperatorSessionEpoch,
  isOperatorSessionEpochCurrent,
  now: Date.now,
});

export const readAuditSessionsState = (maxSessions = 50, now = Date.now()) => auditReadModel.readSessions(maxSessions, now);
export const readAuditEntriesState = (sessionId: string, maxEntries = 200, now = Date.now()) => auditReadModel.readEntries(sessionId, maxEntries, now);
export const readAuditDeltaState = (sessionId: string, entryId: string, now = Date.now()) => auditReadModel.readDeltas(sessionId, entryId, now);
export const revalidateAuditSessions = (options: { maxSessions?: number; force?: boolean } = {}) => auditReadModel.revalidateSessions(options.maxSessions, options.force);
export const revalidateAuditEntries = (sessionId: string, options: { maxEntries?: number; force?: boolean } = {}) => auditReadModel.revalidateEntries(sessionId, options.maxEntries, options.force);
export const revalidateAuditDeltas = (sessionId: string, entry: AuditLogEntry, options: { force?: boolean } = {}) => auditReadModel.revalidateDeltas(sessionId, entry, options.force);
export const patchAuditCacheAfterAppend = (session: AuditSession, entry: AuditLogEntry, operatorSessionEpoch: number) => auditReadModel.patchAfterAppend(session, entry, operatorSessionEpoch);
export const clearAuditReadModel = () => auditReadModel.clear();

registerOperatorSessionCacheClearer('audit-read-model', clearAuditReadModel);
