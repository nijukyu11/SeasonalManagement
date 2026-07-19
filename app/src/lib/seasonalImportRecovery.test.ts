import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalImportStatusUnknownNotice,
  loadTargetedCommittedImportRefresh,
  resumeSeasonalImportAttemptOnce,
} from './seasonalImportRecovery.ts';
import type {
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
  RemoteSeasonWorkspaceWindowResult,
} from './remoteStore.ts';
import type { Season } from './types.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const attempt = {
  requestId: '33333333-3333-5333-8333-333333333333',
  checksum: 'abc',
  seasonId: null,
  seasonCode: 'W27',
  expectedDataVersion: 0,
  fileName: 'W27.xlsx',
  uploadedAt: 123,
  sourceRows: [{
    rowIndex: 1,
    effective: '2026-10-25',
    discontinue: '2027-03-27',
    airline: 'VN',
    aircraft: '321',
    daysOfWeek: [true, false, true, false, true, false, true],
    sta: '07:05',
    arrFlight: 'VN336',
    arrFlightType: 'PAX',
    arrRoute: 'KIX',
    arrFlightCategory: 'J',
    arrCodeShares: null,
    arrIntDomInd: 'I',
    std: null,
    depFlight: null,
    depFlightType: null,
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
    overnightLinkRowIndex: null,
    linkType: null,
  }],
} satisfies RemoteSeasonalImportInput;

const committed = {
  batchId: '00000000-0000-0000-0000-000000000001',
  seasonId: 'season-w27',
  seasonCode: 'W27',
  status: 'committed',
  sourceRowCount: 1,
  flightRecordCount: 72,
  preservedOperationalCount: 0,
  removedImportedCount: 0,
  dataVersion: 1,
  serverHighWater: 9,
  checksum: attempt.checksum,
} satisfies RemoteSeasonalImportResult;

const season = {
  id: committed.seasonId,
  seasonCode: committed.seasonCode,
  name: 'Winter 2027',
  fileName: attempt.fileName,
  uploadedAt: attempt.uploadedAt,
  effectiveStart: '2026-10-25',
  effectiveEnd: '2027-03-27',
  totalLegs: committed.flightRecordCount,
  totalSourceRows: committed.sourceRowCount,
  dataVersion: committed.dataVersion,
} satisfies Season;

const windowResult = {
  sourceRows: [],
  records: [],
  modifications: new Map(),
  syncMeta: {
    seasonId: committed.seasonId,
    baseServerVersion: committed.serverHighWater,
    lastServerSeq: committed.serverHighWater,
    localRevision: committed.serverHighWater,
    pendingCount: 0,
    lastLocalChangeAt: null,
    conflicts: [],
    syncStatus: 'synced',
  },
  cursor: { serverHighWater: committed.serverHighWater },
} as RemoteSeasonWorkspaceWindowResult;

test('manual Resume/Check calls once with the exact stored attempt and requestId', async () => {
  const gate = deferred<RemoteSeasonalImportResult>();
  const received: RemoteSeasonalImportInput[] = [];
  const running = resumeSeasonalImportAttemptOnce(attempt, async (storedAttempt) => {
    received.push(storedAttempt);
    return gate.promise;
  });

  await Promise.resolve();
  assert.equal(received.length, 1);
  assert.equal(received[0], attempt);
  assert.equal(received[0].requestId, attempt.requestId);
  assert.deepEqual(received[0].sourceRows, attempt.sourceRows);
  gate.resolve(committed);
  assert.deepEqual(await running, committed);
  assert.equal(received.length, 1);
});

test('targeted refresh always requests the committed season when active season is different or null', async () => {
  for (const activeSeasonId of [null, 'season-s26']) {
    const seasonsGate = deferred<Season[]>();
    const windowGate = deferred<RemoteSeasonWorkspaceWindowResult | null>();
    const requestedSeasonIds: string[] = [];
    const running = loadTargetedCommittedImportRefresh({
      committedImport: committed,
      windowInput: {
        dateFrom: null,
        dateTo: null,
        resourceType: 'schedule',
        limit: 100000,
      },
      loadSeasons: async () => seasonsGate.promise,
      loadWindow: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return windowGate.promise;
      },
    });

    await Promise.resolve();
    assert.deepEqual(requestedSeasonIds, [committed.seasonId]);
    assert.notEqual(requestedSeasonIds[0], activeSeasonId);
    seasonsGate.resolve([season]);
    windowGate.resolve(windowResult);
    const refreshed = await running;
    assert.equal(refreshed.season.id, committed.seasonId);
    assert.equal(refreshed.window, windowResult);
  }
});

test('first or different active season refresh failure retains pending state, then explicit refresh succeeds without commit', async () => {
  for (const activeSeasonId of [null, 'season-s26']) {
    let pendingCommittedImport: RemoteSeasonalImportResult | null = committed;
    const commitCalls = 0;
    const requestedSeasonIds: string[] = [];
    const firstSeasons = deferred<Season[]>();
    const firstWindow = deferred<RemoteSeasonWorkspaceWindowResult | null>();
    const firstRefresh = loadTargetedCommittedImportRefresh({
      committedImport: pendingCommittedImport,
      windowInput: { resourceType: 'schedule' },
      loadSeasons: async () => firstSeasons.promise,
      loadWindow: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return firstWindow.promise;
      },
    });

    await Promise.resolve();
    assert.equal(requestedSeasonIds[0], committed.seasonId);
    assert.notEqual(requestedSeasonIds[0], activeSeasonId);
    firstSeasons.resolve([season]);
    firstWindow.resolve(null);
    await assert.rejects(firstRefresh, /season-w27.*window/i);
    assert.equal(pendingCommittedImport, committed);
    assert.equal(commitCalls, 0);

    const secondSeasons = deferred<Season[]>();
    const secondWindow = deferred<RemoteSeasonWorkspaceWindowResult | null>();
    const secondRefresh = loadTargetedCommittedImportRefresh({
      committedImport: pendingCommittedImport,
      windowInput: { resourceType: 'schedule' },
      loadSeasons: async () => secondSeasons.promise,
      loadWindow: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return secondWindow.promise;
      },
    });
    secondSeasons.resolve([season]);
    secondWindow.resolve(windowResult);
    const refreshed = await secondRefresh;
    assert.equal(refreshed.season.id, committed.seasonId);
    assert.deepEqual(requestedSeasonIds, [committed.seasonId, committed.seasonId]);
    assert.equal(commitCalls, 0);
    pendingCommittedImport = null;
    assert.equal(pendingCommittedImport, null);
  }
});

test('ambiguous RPC failure notice is status unknown and exposes Resume/Check', () => {
  const notice = buildSeasonalImportStatusUnknownNotice(attempt, new Error('Failed to fetch'));

  assert.equal(notice.title, 'Import status unknown');
  assert.match(notice.message, /33333333-3333-5333-8333-333333333333/);
  assert.match(notice.message, /Resume\/Check/);
  assert.match(notice.message, /Failed to fetch/);
  assert.doesNotMatch(notice.title, /Import Failed/);
});
