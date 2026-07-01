import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKSPACE_WINDOW_CACHE_TTL_MS,
  buildWorkspaceWindowCacheKey,
  readCachedWorkspaceWindow,
  readWorkspaceWindowSnapshot,
  shouldRefreshWorkspaceWindow,
} from './seasonWorkspaceReadModel.ts';
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

test('readCachedWorkspaceWindow rejects incomplete cached window records', () => {
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

  assert.equal(
    readCachedWorkspaceWindow(store.getState().workspaces['season-1'], windowKey),
    null
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
