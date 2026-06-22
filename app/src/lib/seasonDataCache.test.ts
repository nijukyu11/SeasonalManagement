import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishSeasonWorkspaceChanged,
  subscribeSeasonWorkspaceChanges,
} from './seasonDataCache.ts';
import type { LocalSyncMeta } from './localSeasonStore.ts';

function makeSyncMeta(): LocalSyncMeta {
  return {
    seasonId: 'season-1',
    baseServerVersion: 0,
    localRevision: 5,
    pendingCount: 2,
    lastLocalChangeAt: 1778292000000,
    syncStatus: 'dirty',
  };
}

test('workspace change events carry affected ids and sync metadata', () => {
  const received: unknown[] = [];
  const unsubscribe = subscribeSeasonWorkspaceChanges((event) => received.push(event));
  const syncMeta = makeSyncMeta();

  const event = publishSeasonWorkspaceChanged({
    seasonId: 'season-1',
    localRevision: syncMeta.localRevision,
    source: 'checkin-native',
    affectedIds: ['LEG-1'],
    syncMeta,
  });
  unsubscribe();

  assert.equal(received.length, 1);
  assert.deepEqual(event.affectedIds, ['LEG-1']);
  assert.equal(event.syncMeta, syncMeta);
  assert.deepEqual((received[0] as typeof event).affectedIds, ['LEG-1']);
});

test('workspace change events preserve deduped native changed targets', () => {
  const event = publishSeasonWorkspaceChanged({
    seasonId: 'season-1',
    source: 'native-catchup',
    changedTargets: ['modification:leg-1', 'flightRecord:leg-2', 'modification:leg-1'],
  });

  assert.deepEqual(event.changedTargets, ['modification:leg-1', 'flightRecord:leg-2']);
});
