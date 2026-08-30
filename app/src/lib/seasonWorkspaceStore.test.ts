import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectSeasonRecordOrder,
  selectSeasonWorkspaceCounters,
  useSeasonWorkspaceStore,
} from './seasonWorkspaceStore.ts';
import type { LocalSyncMeta } from './localSeasonStore.ts';
import { getOperatorSessionEpoch } from './operatorSessionCacheRegistry.ts';
import type { FlightModification, FlightRecord } from './types';

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

function makeModification(legId: string, gate: number): FlightModification {
  return { legId, action: 'modified', gate };
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

test('applyServerModificationPatch updates only matching snapshots and rejects stale sequence values', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const target = makeRecord({ id: 'LEG-TARGET', gate: 1 });
  const other = makeRecord({ id: 'LEG-OTHER', gate: 2 });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [target],
    modifications: [makeModification(target.id, 1)],
    syncMeta: makeSyncMeta({ lastServerSeq: 100, baseServerVersion: 100, localRevision: 100 }),
    windowKey: 'gate:target',
  });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [other],
    modifications: [makeModification(other.id, 2)],
    syncMeta: makeSyncMeta({ lastServerSeq: 100, baseServerVersion: 100, localRevision: 100 }),
    windowKey: 'gate:other',
  });

  const before = store.getState().workspaces['season-1'];
  const targetSnapshotBefore = before.windowSnapshots.get('gate:target');
  const otherSnapshotBefore = before.windowSnapshots.get('gate:other');
  const targetMetadataBefore = before.windowMetadata.get('gate:target');

  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: target.id,
    modification: makeModification(target.id, 7),
    serverSeq: 102,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'applied');

  const after = store.getState().workspaces['season-1'];
  assert.equal(after.modificationsByLegId.get(target.id)?.gate, 7);
  assert.equal(after.modificationServerHighWater.get(target.id), 102);
  assert.notEqual(after.windowSnapshots.get('gate:target'), targetSnapshotBefore);
  assert.equal(after.windowSnapshots.get('gate:target')?.modifications.get(target.id)?.gate, 7);
  assert.equal(after.windowSnapshots.get('gate:other'), otherSnapshotBefore);
  assert.equal(after.windowMetadata.get('gate:target')?.generation, targetMetadataBefore?.generation);
  assert.equal(after.windowMetadata.get('gate:target')?.staleReason, targetMetadataBefore?.staleReason);
  assert.equal(after.windowMetadata.get('gate:target')?.serverHighWater, 102);

  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: target.id,
    modification: makeModification(target.id, 3),
    serverSeq: 101,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'ignored-stale');
  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: target.id,
    modification: makeModification(target.id, 8),
    serverSeq: 102,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'ignored-stale');
  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: 'LEG-MISSING',
    modification: makeModification('LEG-MISSING', 8),
    serverSeq: 103,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'missing-target');
  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: target.id,
    modification: makeModification(target.id, 8),
    serverSeq: 103,
    operatorSessionEpoch: getOperatorSessionEpoch() + 1,
  }), 'invalid-epoch');
  assert.equal(store.getState().workspaces['season-1'].modificationsByLegId.get(target.id)?.gate, 7);
});

test('applyServerModificationPatch merges a partial event into the canonical modification', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const target = makeRecord({ id: 'LEG-PARTIAL', gate: 1 });
  const existingModification = {
    ...makeModification(target.id, 1),
    stand: '5',
  };
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [target],
    modifications: [existingModification],
    syncMeta: makeSyncMeta({ lastServerSeq: 100 }),
    windowKey: 'checkin:partial',
  });

  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: target.id,
    modification: { legId: target.id, action: 'modified', counter: [21, 22] },
    serverSeq: 101,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'applied');

  const canonical = store.getState().workspaces['season-1'].modificationsByLegId.get(target.id);
  assert.equal(canonical?.gate, 1);
  assert.equal(canonical?.stand, 5);
  assert.deepEqual(canonical?.counter, [21, 22]);
  const snapshot = store.getState().workspaces['season-1'].windowSnapshots.get('checkin:partial');
  assert.equal(snapshot?.modifications.get(target.id)?.gate, 1);
  assert.equal(snapshot?.modifications.get(target.id)?.stand, 5);
  assert.deepEqual(snapshot?.modifications.get(target.id)?.counter, [21, 22]);
});

test('a late server-window response cannot overwrite a newer direct modification patch', () => {
  const store = useSeasonWorkspaceStore;
  store.getState().resetSeasonWorkspaceStore();
  const record = makeRecord({ id: 'LEG-RACE', gate: 1 });
  store.getState().replaceSeasonWindow({
    seasonId: 'season-1',
    records: [record],
    modifications: [makeModification(record.id, 1)],
    syncMeta: makeSyncMeta({ lastServerSeq: 100 }),
    windowKey: 'gate:race',
  });
  const generation = store.getState().beginSeasonWindowRequest('season-1', 'gate:race');
  assert.equal(store.getState().applyServerModificationPatch({
    seasonId: 'season-1',
    legId: record.id,
    modification: makeModification(record.id, 9),
    serverSeq: 102,
    operatorSessionEpoch: getOperatorSessionEpoch(),
  }), 'applied');
  assert.equal(store.getState().commitSeasonWindowResult({
    seasonId: 'season-1',
    windowKey: 'gate:race',
    requestGeneration: generation,
    operatorSessionEpoch: getOperatorSessionEpoch(),
    rows: [],
    records: [record],
    modifications: new Map([[record.id, makeModification(record.id, 4)]]),
    syncMeta: makeSyncMeta({ lastServerSeq: 101 }),
    fetchedAt: Date.now(),
    dataVersion: 1,
    serverHighWater: 101,
  }), true);
  const workspace = store.getState().workspaces['season-1'];
  assert.equal(workspace.modificationsByLegId.get(record.id)?.gate, 9);
  assert.equal(workspace.windowSnapshots.get('gate:race')?.modifications.get(record.id)?.gate, 9);
  assert.equal(workspace.windowMetadata.get('gate:race')?.serverHighWater, 102);
});
