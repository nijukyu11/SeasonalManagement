import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspaceWindowV2Page } from './seasonWorkspaceWindowRpcV2Contract.ts';

function okPage(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    seasonId: 'season-1',
    startDate: null,
    endDate: null,
    resourceType: 'schedule',
    snapshot: { dataVersion: 8, serverHighWater: 42 },
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    flightRecords: [{ record_id: 'record-1' }],
    flightRecordCounters: [],
    flightRecordWindows: [],
    modifications: [],
    modificationCounters: [],
    modificationWindows: [],
    modificationAddedLegs: [],
    ...overrides,
  };
}

test('parses an exact workspace V2 page', () => {
  const parsed = parseWorkspaceWindowV2Page(okPage());
  assert.equal(parsed.status, 'ok');
  if (parsed.status === 'ok') {
    assert.equal(parsed.snapshot.dataVersion, 8);
    assert.equal(parsed.flightRecords[0]?.record_id, 'record-1');
  }
});

test('snapshot_changed rejects row arrays', () => {
  assert.throws(
    () => parseWorkspaceWindowV2Page({
      status: 'snapshot_changed',
      snapshot: { dataVersion: 9, serverHighWater: 43 },
      flightRecords: [],
    }),
    /must not include row arrays/,
  );
});

test('requires a cursor exactly when more pages exist', () => {
  assert.throws(
    () => parseWorkspaceWindowV2Page(okPage({
      page: { returnedCount: 1, hasMore: true, nextCursor: null },
    })),
    /present exactly when/,
  );
});

test('rejects orphan child rows and duplicate roots', () => {
  assert.throws(
    () => parseWorkspaceWindowV2Page(okPage({
      flightRecordCounters: [{ record_id: 'other', counter_group: 'A', item_index: 0 }],
    })),
    /orphan record_id other/,
  );
  assert.throws(
    () => parseWorkspaceWindowV2Page(okPage({
      page: { returnedCount: 2, hasMore: false, nextCursor: null },
      flightRecords: [{ record_id: 'record-1' }, { record_id: 'record-1' }],
    })),
    /duplicate record_id record-1/,
  );
});

test('accepts an added modification root with its children', () => {
  const parsed = parseWorkspaceWindowV2Page(okPage({
    flightRecords: [],
    modifications: [{ leg_id: 'added-1' }],
    modificationAddedLegs: [{ leg_id: 'added-1' }],
    modificationCounters: [{ leg_id: 'added-1', counter_group: 'A', item_index: 0 }],
  }));
  assert.equal(parsed.status, 'ok');
});

test('rejects a root id used by both a base record and an added leg', () => {
  assert.throws(() => parseWorkspaceWindowV2Page(okPage({
    page: { returnedCount: 2, hasMore: false, nextCursor: null },
    modifications: [{ leg_id: 'record-1' }],
    modificationAddedLegs: [{ leg_id: 'record-1' }],
  })), /duplicate root id/);
});
