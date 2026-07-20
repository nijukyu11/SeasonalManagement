import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKSPACE_WINDOW_CACHE_TTL_MS,
  buildWorkspaceWindowCacheKey,
  readCachedWorkspaceWindow,
  readWorkspaceWindowSnapshot,
  shouldRefreshWorkspaceWindow,
} from './seasonWorkspaceReadModel.ts';
import { getOperatorSessionEpoch } from './operatorSessionCacheRegistry.ts';
import { useSeasonWorkspaceStore } from './seasonWorkspaceStore.ts';
import type { FlightRecord } from './types';

function makeRecord(overrides: Partial<FlightRecord> & { id: string }): FlightRecord {
  return {
    linkId: '',
    type: overrides.type ?? 'D',
    airline: overrides.airline ?? 'VN',
    flightNumber: overrides.flightNumber ?? 'VN100',
    rawFlightNumber: overrides.rawFlightNumber ?? '100',
    requestStatusCode: null,
    route: overrides.route ?? 'DAD',
    schedule: overrides.schedule ?? '10:00',
    aircraft: overrides.aircraft ?? '321',
    category: overrides.category ?? 'PAX',
    flightType: overrides.flightType ?? 'J',
    codeShares: null,
    intDomInd: null,
    pax: overrides.pax ?? 100,
    gate: overrides.gate ?? null,
    stand: overrides.stand ?? null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: overrides.date ?? '2026-05-10',
    dayOfWeek: overrides.dayOfWeek ?? 1,
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    sourceKind: overrides.sourceKind ?? 'imported',
    sourceSide: overrides.sourceSide ?? (overrides.type === 'A' ? 'ARR' : 'DEP'),
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

test('workspace window cache key is stable for same logical window', () => {
  assert.equal(
    buildWorkspaceWindowCacheKey({
      route: 'daily',
      seasonId: 'season-1',
      dateFrom: '2026-06-22',
      dateTo: '2026-06-23',
      resourceType: null,
      filter: '',
    }),
    'daily|season-1|2026-06-22|2026-06-23||'
  );
});

test('fresh windows do not refresh on tab activation', () => {
  assert.equal(
    shouldRefreshWorkspaceWindow({
      cachedAt: 1000,
      now: 1500,
      stale: false,
      ttlMs: 10_000,
    }),
    false
  );
});

test('stale windows refresh even inside ttl', () => {
  assert.equal(
    shouldRefreshWorkspaceWindow({
      cachedAt: 1000,
      now: 1500,
      stale: true,
      ttlMs: 10_000,
    }),
    true
  );
});

test('default workspace cache ttl avoids refresh churn during normal tab switching', () => {
  assert.equal(WORKSPACE_WINDOW_CACHE_TTL_MS >= 10 * 60_000, true);
});

test('cached route windows remain readable after another tab loads a different window', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();

  const dailyWindowKey = buildWorkspaceWindowCacheKey({
    route: 'daily',
    seasonId: 'season-1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-23',
  });
  const gateWindowKey = buildWorkspaceWindowCacheKey({
    route: 'gate',
    seasonId: 'season-1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    resourceType: 'gate',
  });

  const dailyRecords = [
    makeRecord({ id: 'DAILY-1', flightNumber: 'VN101' }),
    makeRecord({ id: 'DAILY-2', flightNumber: 'VN102' }),
  ];
  const gateRecords = [
    makeRecord({ id: 'GATE-1', flightNumber: 'VN201', gate: 2 }),
  ];

  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: dailyRecords,
    modifications: [],
    windowKey: dailyWindowKey,
  });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: gateRecords,
    modifications: [],
    windowKey: gateWindowKey,
  });

  const cachedDailyWindow = readCachedWorkspaceWindow(
    store.getState().workspaces['season-1'],
    dailyWindowKey,
    Date.now(),
    WORKSPACE_WINDOW_CACHE_TTL_MS
  );
  assert.deepEqual(
    cachedDailyWindow?.records.map((record) => record.id),
    dailyRecords.map((record) => record.id)
  );
});

test('isolated window snapshots remain readable when normalized entities are pruned', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const windowKey = buildWorkspaceWindowCacheKey({
    route: 'daily',
    seasonId: 'season-1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-23',
  });
  const staleRecord = makeRecord({ id: 'DAILY-1' });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [staleRecord],
    modifications: [],
    windowKey,
  });
  store.getState().workspaces['season-1'].recordsById.delete(staleRecord.id);

  assert.deepEqual(
    readCachedWorkspaceWindow(store.getState().workspaces['season-1'], windowKey)?.records.map((record) => record.id),
    [staleRecord.id]
  );
});

test('workspace window snapshot remains readable when cache is stale from a cross-route mutation', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const windowKey = buildWorkspaceWindowCacheKey({
    route: 'daily',
    seasonId: 'season-1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-23',
  });
  const record = makeRecord({ id: 'LEG_D_2026-06-22_UO553', flightNumber: 'UO553' });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [record],
    modifications: [],
    windowKey,
  });
  store.getState().patchSeasonWorkspace({
    seasonId: 'season-1',
    affectedIds: [record.id],
    modifications: [{
      legId: record.id,
      action: 'modified',
      counter: ['C01', 'C02'],
    }],
  });

  assert.equal(
    readCachedWorkspaceWindow(store.getState().workspaces['season-1'], windowKey),
    null
  );
  const snapshot = readWorkspaceWindowSnapshot(store.getState().workspaces['season-1'], windowKey);
  assert.deepEqual(snapshot?.records.map((item) => item.id), [record.id]);
  assert.deepEqual(snapshot?.modifications.get(record.id)?.counter, ['C01', 'C02']);
});

test('each isolated window uses its own fetchedAt for TTL', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const epoch = getOperatorSessionEpoch();
  const firstKey = 'server-window-v2|season-1|||gate|all';
  const secondKey = 'server-window-v2|season-1|||checkin|all';
  for (const [key, fetchedAt] of [[firstKey, 1000], [secondKey, 5000]] as const) {
    const generation = store.getState().beginSeasonWindowRequest('season-1', key);
    store.getState().commitSeasonWindowResult({
      seasonId: 'season-1', windowKey: key, requestGeneration: generation, operatorSessionEpoch: epoch,
      rows: [], records: [makeRecord({ id: key })], modifications: new Map(), syncMeta: null,
      fetchedAt, dataVersion: 1, serverHighWater: 1,
    });
  }
  assert.equal(readCachedWorkspaceWindow(store.getState().workspaces['season-1'], firstKey, 5500, 1000), null);
  assert.ok(readCachedWorkspaceWindow(store.getState().workspaces['season-1'], secondKey, 5500, 1000));
});

test('older cross-window results cannot lower overlapping normalized entities', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const epoch = getOperatorSessionEpoch();
  const gateKey = 'server-window-v2|season-1|||gate|all';
  const dashboardKey = 'server-window-v2|season-1|||all|all';
  const overlap = makeRecord({ id: 'OVERLAP', gate: 7 });
  let generation = store.getState().beginSeasonWindowRequest('season-1', gateKey);
  store.getState().commitSeasonWindowResult({
    seasonId: 'season-1', windowKey: gateKey, requestGeneration: generation, operatorSessionEpoch: epoch,
    rows: [], records: [overlap], modifications: new Map(), syncMeta: null,
    fetchedAt: 2000, dataVersion: 2, serverHighWater: 11,
  });
  generation = store.getState().beginSeasonWindowRequest('season-1', dashboardKey);
  store.getState().commitSeasonWindowResult({
    seasonId: 'season-1', windowKey: dashboardKey, requestGeneration: generation, operatorSessionEpoch: epoch,
    rows: [], records: [{ ...overlap, gate: 1 }, makeRecord({ id: 'DASHBOARD-ONLY' })], modifications: new Map(), syncMeta: null,
    fetchedAt: 2100, dataVersion: 1, serverHighWater: 10,
  });
  assert.equal(readWorkspaceWindowSnapshot(store.getState().workspaces['season-1'], gateKey)?.records[0].gate, 7);
  const dashboard = readWorkspaceWindowSnapshot(store.getState().workspaces['season-1'], dashboardKey);
  assert.equal(dashboard?.records.find((item) => item.id === 'OVERLAP')?.gate, 7);
  assert.ok(dashboard?.records.some((item) => item.id === 'DASHBOARD-ONLY'));
  assert.equal(store.getState().workspaces['season-1'].recordServerHighWater.get('OVERLAP'), 11);
});
