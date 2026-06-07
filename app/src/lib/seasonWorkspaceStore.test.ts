import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectSeasonRecordOrder,
  selectSeasonWorkspaceCounters,
  useSeasonWorkspaceStore,
} from './seasonWorkspaceStore.ts';
import type { LocalSyncMeta } from './localSeasonStore.ts';
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

function makeSyncMeta(overrides: Partial<LocalSyncMeta> = {}): LocalSyncMeta {
  return {
    seasonId: 'season-1',
    baseServerVersion: 0,
    localRevision: 1,
    pendingCount: 0,
    lastLocalChangeAt: null,
    syncStatus: 'synced',
    ...overrides,
  };
}

test('patchSeasonWorkspace replaces only affected records and updates counters from client state', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();

  const keptRecord = makeRecord({ id: 'LEG-KEEP', type: 'A', sourceSide: 'ARR', flightNumber: 'VN101' });
  const changedRecord = makeRecord({ id: 'LEG-CHANGE', type: 'D', sourceSide: 'DEP', gate: 1, flightNumber: 'VN102' });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [keptRecord, changedRecord],
    modifications: [],
    syncMeta: makeSyncMeta({ pendingCount: 0, localRevision: 1 }),
    windowKey: 'checkin:2026-05-10',
  });

  const orderBefore = selectSeasonRecordOrder(store.getState(), 'season-1');
  store.getState().patchSeasonWorkspace({
    seasonId: 'season-1',
    affectedIds: ['LEG-CHANGE'],
    records: [{ ...changedRecord, gate: 7 }],
    modifications: [{ legId: 'LEG-CHANGE', action: 'modified', gate: 7 }],
    syncMeta: makeSyncMeta({ pendingCount: 1, localRevision: 2, lastLocalChangeAt: 1778292000000, syncStatus: 'dirty' }),
  });

  const state = store.getState();
  const workspace = state.workspaces['season-1'];
  assert.equal(workspace.recordsById.get('LEG-KEEP'), keptRecord);
  assert.notEqual(workspace.recordsById.get('LEG-CHANGE'), changedRecord);
  assert.equal(workspace.recordsById.get('LEG-CHANGE')?.gate, 7);
  assert.equal(workspace.modificationsByLegId.get('LEG-CHANGE')?.gate, 7);
  assert.equal(selectSeasonRecordOrder(state, 'season-1'), orderBefore);

  assert.deepEqual(selectSeasonWorkspaceCounters(state, 'season-1'), {
    totalRecords: 2,
    activeRecords: 2,
    deletedRecords: 0,
    arrivalRecords: 1,
    departureRecords: 1,
    pendingCount: 1,
    lastLocalChangeAt: 1778292000000,
  });
});
