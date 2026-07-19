import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalImportStatusUnknownNotice,
  loadTargetedCommittedImportRefresh,
  resumeSeasonalImportAttemptOnce,
} from './seasonalImportRecovery.ts';
import type {
  RemoteSeasonalExportSnapshot,
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
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

const snapshotResult = {
  seasonId: committed.seasonId,
  dataVersion: committed.dataVersion,
  totalCount: committed.flightRecordCount,
  serverHighWater: committed.serverHighWater,
  truncated: false,
  records: Array.from({ length: committed.flightRecordCount }, (_, index) => ({ id: `record-${index}` })) as never[],
  modifications: new Map(),
} satisfies RemoteSeasonalExportSnapshot;

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
    const snapshotGate = deferred<RemoteSeasonalExportSnapshot>();
    const requestedSeasonIds: string[] = [];
    const running = loadTargetedCommittedImportRefresh({
      committedImport: committed,
      loadSeasons: async () => seasonsGate.promise,
      loadSnapshot: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return snapshotGate.promise;
      },
    });

    await Promise.resolve();
    assert.deepEqual(requestedSeasonIds, [committed.seasonId]);
    assert.notEqual(requestedSeasonIds[0], activeSeasonId);
    seasonsGate.resolve([season]);
    snapshotGate.resolve(snapshotResult);
    const refreshed = await running;
    assert.equal(refreshed.season.id, committed.seasonId);
    assert.equal(refreshed.snapshot, snapshotResult);
    assert.equal(refreshed.window.records.length, committed.flightRecordCount);
  }
});

test('first or different active season refresh failure retains pending state, then explicit refresh succeeds without commit', async () => {
  for (const activeSeasonId of [null, 'season-s26']) {
    let pendingCommittedImport: RemoteSeasonalImportResult | null = committed;
    const commitCalls = 0;
    const requestedSeasonIds: string[] = [];
    const firstSeasons = deferred<Season[]>();
    const firstSnapshot = deferred<RemoteSeasonalExportSnapshot>();
    const firstRefresh = loadTargetedCommittedImportRefresh({
      committedImport: pendingCommittedImport,
      loadSeasons: async () => firstSeasons.promise,
      loadSnapshot: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return firstSnapshot.promise;
      },
    });

    await Promise.resolve();
    assert.equal(requestedSeasonIds[0], committed.seasonId);
    assert.notEqual(requestedSeasonIds[0], activeSeasonId);
    firstSeasons.resolve([season]);
    firstSnapshot.reject(new Error('snapshot unavailable'));
    await assert.rejects(firstRefresh, /snapshot unavailable/i);
    assert.equal(pendingCommittedImport, committed);
    assert.equal(commitCalls, 0);

    const secondSeasons = deferred<Season[]>();
    const secondSnapshot = deferred<RemoteSeasonalExportSnapshot>();
    const secondRefresh = loadTargetedCommittedImportRefresh({
      committedImport: pendingCommittedImport,
      loadSeasons: async () => secondSeasons.promise,
      loadSnapshot: async (input) => {
        requestedSeasonIds.push(input.seasonId);
        return secondSnapshot.promise;
      },
    });
    secondSeasons.resolve([season]);
    secondSnapshot.resolve(snapshotResult);
    const refreshed = await secondRefresh;
    assert.equal(refreshed.season.id, committed.seasonId);
    assert.deepEqual(requestedSeasonIds, [committed.seasonId, committed.seasonId]);
    assert.equal(commitCalls, 0);
    pendingCommittedImport = null;
    assert.equal(pendingCommittedImport, null);
  }
});

test('committed refresh rejects missing, truncated, empty, stale, and count-mismatched snapshots', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['missing records', { ...snapshotResult, records: undefined }, /records.*array/i],
    ['missing modifications', { ...snapshotResult, modifications: undefined }, /modifications.*Map/i],
    ['truncated', { ...snapshotResult, truncated: true }, /truncated/i],
    ['empty', { ...snapshotResult, records: [], totalCount: committed.flightRecordCount }, /record count/i],
    ['stale version', { ...snapshotResult, dataVersion: committed.dataVersion - 1 }, /dataVersion/i],
    ['stale highwater', { ...snapshotResult, serverHighWater: committed.serverHighWater - 1 }, /serverHighWater/i],
    ['wrong total', { ...snapshotResult, totalCount: committed.flightRecordCount - 1 }, /totalCount/i],
  ];

  for (const [label, snapshot, expected] of cases) {
    await assert.rejects(
      loadTargetedCommittedImportRefresh({
        committedImport: committed,
        loadSeasons: async () => [season],
        loadSnapshot: async () => snapshot as RemoteSeasonalExportSnapshot,
      }),
      expected,
      label,
    );
  }
});

test('empty committed refresh requires both a zero commit count and an explicit business allowance', async () => {
  const zeroCommitted = { ...committed, sourceRowCount: 0, flightRecordCount: 0 };
  const zeroSeason = { ...season, totalLegs: 0, totalSourceRows: 0 };
  const zeroSnapshot = { ...snapshotResult, totalCount: 0, records: [] };

  await assert.rejects(
    loadTargetedCommittedImportRefresh({
      committedImport: zeroCommitted,
      loadSeasons: async () => [zeroSeason],
      loadSnapshot: async () => zeroSnapshot,
    }),
    /empty repair is not allowed/i,
  );
  const refreshed = await loadTargetedCommittedImportRefresh({
    committedImport: zeroCommitted,
    loadSeasons: async () => [zeroSeason],
    loadSnapshot: async () => zeroSnapshot,
    allowEmptyCommittedImport: true,
  });
  assert.equal(refreshed.snapshot.records.length, 0);
});

test('ambiguous RPC failure notice is status unknown and exposes Resume/Check', () => {
  const notice = buildSeasonalImportStatusUnknownNotice(attempt, new Error('Failed to fetch'));

  assert.equal(notice.title, 'Import status unknown');
  assert.match(notice.message, /33333333-3333-5333-8333-333333333333/);
  assert.match(notice.message, /Resume\/Check/);
  assert.match(notice.message, /Failed to fetch/);
  assert.doesNotMatch(notice.title, /Import Failed/);
});
