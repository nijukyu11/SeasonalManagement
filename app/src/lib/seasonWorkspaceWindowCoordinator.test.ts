import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServerWorkspaceWindowKey,
  createSeasonWorkspaceWindowCoordinator,
} from './seasonWorkspaceWindowCoordinator.ts';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from './operatorSessionCacheRegistry.ts';
import { useSeasonWorkspaceStore } from './seasonWorkspaceStore.ts';
import type { FlightRecord } from './types';

function record(id: string, gate: number): FlightRecord {
  return {
    id, linkId: '', type: 'D', flightType: 'J', airline: 'VN', flightNumber: 'VN1', rawFlightNumber: '1',
    requestStatusCode: null, route: 'DAD', schedule: '10:00', aircraft: '321', category: 'PAX',
    codeShares: null, intDomInd: null, pax: 100, gate, stand: null, carousel: null, counter: null,
    mct: null, fb: null, lb: null, bhs: null, ghs: null, date: '2026-06-22', dayOfWeek: 1,
    action: null, sourceRowIndex: 1, sourceKind: 'imported', sourceSide: 'DEP', status: 'active',
  };
}

function result(gate: number, dataVersion = 8, serverHighWater = 42) {
  return {
    sourceRows: [], records: [record('R1', gate)], modifications: new Map(),
    cursor: { dataVersion, serverHighWater },
    syncMeta: {
      seasonId: 'S1', baseServerVersion: serverHighWater, lastServerSeq: serverHighWater,
      localRevision: serverHighWater, pendingCount: 0, lastLocalChangeAt: null,
      conflicts: [], syncStatus: 'synced' as const,
    },
  };
}

test('builds the canonical logical V2 key', () => {
  assert.equal(buildServerWorkspaceWindowKey({
    seasonId: 'season-1', dateFrom: '2026-06-22', dateTo: '2026-06-23', resourceType: 'gate', limit: 500,
  }), 'server-window-v2|season-1|2026-06-22|2026-06-23|gate|500');
});

test('seven same-key callers share one strict promise and one loader', async () => {
  useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore();
  let loads = 0;
  let resolveLoad: ((value: ReturnType<typeof result>) => void) | null = null;
  const coordinator = createSeasonWorkspaceWindowCoordinator({
    loadWindow: async () => {
      loads += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
    store: useSeasonWorkspaceStore, now: () => 2000, delay: async () => undefined, random: () => 0,
    getOperatorSessionEpoch, isOperatorSessionEpochCurrent,
  });
  const input = { seasonId: 'S1', resourceType: 'gate' };
  const calls = Array.from({ length: 7 }, (_, index) => coordinator.revalidate(input, {
    force: index % 2 === 1,
    initiator: 'immediate',
  }));
  for (const call of calls.slice(1)) assert.strictEqual(call, calls[0]);
  assert.equal(loads, 1);
  (resolveLoad as unknown as (value: ReturnType<typeof result>) => void)(result(7));
  const loaded = await calls[0];
  assert.equal(loaded?.records[0].gate, 7);
  assert.deepEqual(coordinator.read(input), {
    windowKey: 'server-window-v2|S1|||gate|all', generation: 0, snapshot: loaded,
    freshness: 'fresh', requestStatus: 'ready', shouldRevalidate: false, fetchedAt: 2000,
    dataVersion: 8, serverHighWater: 42, staleReason: null, lastError: null,
  });
  await coordinator.revalidate(input);
  assert.equal(loads, 1);
});

test('automatic callers share one jitter and an immediate caller promotes the same promise', async () => {
  useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore();
  let delayResolve: (() => void) | null = null;
  let delays = 0;
  let loads = 0;
  const coordinator = createSeasonWorkspaceWindowCoordinator({
    loadWindow: async () => { loads += 1; return result(3); },
    store: useSeasonWorkspaceStore, now: () => 2000,
    delay: () => { delays += 1; return new Promise<void>((resolve) => { delayResolve = resolve; }); },
    random: () => 0.5, getOperatorSessionEpoch, isOperatorSessionEpochCurrent,
  });
  const input = { seasonId: 'S1' };
  const automatic = coordinator.revalidate(input);
  const second = coordinator.revalidate(input);
  assert.strictEqual(second, automatic);
  assert.equal(delays, 1);
  assert.equal(loads, 0);
  const immediate = coordinator.revalidate(input, { force: true, initiator: 'immediate' });
  assert.strictEqual(immediate, automatic);
  await automatic;
  assert.equal(loads, 1);
  void delayResolve;
});

test('failed refresh preserves the stale snapshot and records the error', async () => {
  useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore();
  const epoch = getOperatorSessionEpoch();
  const key = buildServerWorkspaceWindowKey({ seasonId: 'S1' });
  useSeasonWorkspaceStore.getState().replaceSeasonWindow({
    seasonId: 'S1', records: [record('R1', 1)], modifications: [], windowKey: key, operatorSessionEpoch: epoch,
  });
  useSeasonWorkspaceStore.getState().markSeasonWindowStale('S1', key, 'realtime', epoch);
  const coordinator = createSeasonWorkspaceWindowCoordinator({
    loadWindow: async () => { throw new Error('Failed to fetch'); },
    store: useSeasonWorkspaceStore, now: () => 3000, delay: async () => undefined, random: () => 0,
    getOperatorSessionEpoch, isOperatorSessionEpochCurrent,
  });
  await assert.rejects(coordinator.revalidate({ seasonId: 'S1' }, { initiator: 'immediate' }), /Failed to fetch/);
  const state = coordinator.read({ seasonId: 'S1' });
  assert.equal(state.snapshot?.records[0].gate, 1);
  assert.equal(state.lastError, 'Failed to fetch');
  assert.equal(state.staleReason, 'request-error');
});

test('an older generation cannot overwrite a completed post-mutation snapshot or start a third load', async () => {
  useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore();
  const epoch = getOperatorSessionEpoch();
  const pending: Array<(value: ReturnType<typeof result>) => void> = [];
  let loads = 0;
  const coordinator = createSeasonWorkspaceWindowCoordinator({
    loadWindow: async () => {
      loads += 1;
      return new Promise((resolve) => { pending.push(resolve); });
    },
    store: useSeasonWorkspaceStore, now: () => 4000, delay: async () => undefined, random: () => 0,
    getOperatorSessionEpoch, isOperatorSessionEpochCurrent,
  });
  const input = { seasonId: 'S1', resourceType: 'schedule' };
  const first = coordinator.revalidate(input, { initiator: 'immediate' });
  assert.equal(loads, 1);

  assert.equal(useSeasonWorkspaceStore.getState().markSeasonWorkspaceStale('S1', 'mutation', epoch), true);
  const second = coordinator.revalidate(input, { force: true, initiator: 'immediate' });
  assert.equal(loads, 2);

  pending[1](result(9, 9, 43));
  assert.equal((await second)?.records[0].gate, 9);
  pending[0](result(1, 8, 42));
  assert.equal((await first)?.records[0].gate, 9);
  assert.equal(loads, 2);
  assert.equal(coordinator.read(input).snapshot?.records[0].gate, 9);
});

test('shared request aborts only after every signalled consumer releases its lease', async () => {
  useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore();
  let loads = 0;
  const coordinator = createSeasonWorkspaceWindowCoordinator({
    loadWindow: async () => { loads += 1; return result(5); },
    store: useSeasonWorkspaceStore,
    now: () => 5000,
    delay: () => new Promise<void>(() => undefined),
    random: () => 0,
    getOperatorSessionEpoch,
    isOperatorSessionEpochCurrent,
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const input = { seasonId: 'S1' };
  const first = coordinator.revalidate(input, { signal: firstController.signal });
  const second = coordinator.revalidate(input, { signal: secondController.signal });
  assert.strictEqual(second, first);

  firstController.abort();
  await Promise.resolve();
  assert.equal(loads, 0);
  secondController.abort();
  await assert.rejects(first, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(loads, 0);
});
