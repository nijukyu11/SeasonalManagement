import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshCheckInForWorkspaceChange } from './workspaceRefreshScope.ts';
import type { SeasonWorkspaceChangeEvent } from '@/lib/seasonDataCache';

function event(partial: Partial<SeasonWorkspaceChangeEvent>): SeasonWorkspaceChangeEvent {
  return {
    seasonId: 'season-1',
    eventSeq: 1,
    localRevision: null,
    changedAt: Date.now(),
    source: 'server-live',
    affectedIds: [],
    changedTargets: [],
    syncMeta: null,
    ...partial,
  };
}

test('check-in refreshes unknown target-less live events conservatively', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(event({ source: 'server-live' }), new Set(['leg-1'])),
    true
  );
});

test('check-in ignores sync completion events without changed targets', () => {
  for (const source of ['remote-sync', 'auto-sync']) {
    assert.equal(
      shouldRefreshCheckInForWorkspaceChange(event({ source }), new Set(['leg-1'])),
      false
    );
  }
});

test('check-in ignores live targets outside the visible allocation window', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'server-live', changedTargets: ['modification:leg-9', 'flightRecord:leg-10'] }),
      new Set(['leg-1'])
    ),
    false
  );
});

test('check-in refreshes when server-live touches a visible modification or flight record', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'server-live', changedTargets: ['modification:leg-1'] }),
      new Set(['leg-1'])
    ),
    true
  );
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'server-live', changedTargets: ['flightRecord:leg-2'] }),
      new Set(['leg-2'])
    ),
    true
  );
});

test('check-in treats baseline and manual fetch as explicit full refreshes', () => {
  for (const source of ['manual-fetch', 'native-baseline-refresh', 'native-baseline-merge']) {
    assert.equal(
      shouldRefreshCheckInForWorkspaceChange(event({ source }), new Set(['leg-1'])),
      true
    );
  }
});

test('check-in refreshes for source row targets because row-to-window impact is not locally knowable', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'server-live', changedTargets: ['sourceRow:42'] }),
      new Set(['leg-1'])
    ),
    true
  );
});
