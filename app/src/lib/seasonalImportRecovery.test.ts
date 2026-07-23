import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalImportStatusUnknownNotice,
  checkSeasonalImportV3RecoveryStatusOnce,
  loadTargetedCommittedImportRefresh,
  resumeSeasonalImportAttemptOnce,
} from './seasonalImportRecovery.ts';
import { buildSeasonalImportV3RecoveryReceipt } from './seasonalImportReceipt.ts';
import type {
  RemoteSeasonalExportSnapshot,
  RemoteSeasonalImportInput,
  RemoteSeasonalImportResult,
} from './remoteStore.ts';
import type { Season } from './types.ts';
import type {
  SeasonalImportV3CommittedResult,
  SeasonalImportV3StageResult,
} from './seasonalImportV3Contract.ts';

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
  preservedOperationalCount: 2,
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
  totalLegs: committed.flightRecordCount + committed.preservedOperationalCount,
  totalSourceRows: committed.sourceRowCount,
  dataVersion: committed.dataVersion,
} satisfies Season;

const snapshotResult = {
  seasonId: committed.seasonId,
  seasonCode: committed.seasonCode,
  dataVersion: committed.dataVersion,
  totalCount: committed.flightRecordCount + committed.preservedOperationalCount,
  sourceRowCount: committed.sourceRowCount,
  serverHighWater: committed.serverHighWater,
  truncated: false,
  records: [
    ...Array.from({ length: committed.flightRecordCount }, (_, index) => ({
      id: `imported-${index}`,
      sourceKind: 'imported',
      status: index === 0 ? 'deleted' : 'active',
      action: index === 0 ? 'deleted' : undefined,
    })),
    { id: 'preserved-added-1', sourceKind: 'added', status: 'active', action: 'added' },
    { id: 'preserved-added-2', sourceKind: 'added', status: 'active', action: 'added' },
  ] as unknown as RemoteSeasonalExportSnapshot['records'],
  modifications: new Map(),
} satisfies RemoteSeasonalExportSnapshot;

const v3Counts = {
  sourceRowCount: 1,
  generatedOccurrenceCount: 1,
  insertCount: 1,
  baselineUpdateCount: 0,
  unchangedCount: 0,
  preservedOutsideScopeCount: 0,
  preservedOverlayCount: 0,
  preservedDeletedOverlayCount: 0,
  removeImportedCount: 0,
  clearStructuralOverlayCount: 0,
  clearDeletedOverlayCount: 0,
  manualCollisionCount: 0,
};

const v3Stage = {
  batchId: '10000000-0000-4000-8000-000000000001',
  requestId: '20000000-0000-5000-8000-000000000001',
  seasonId: 'season-w27',
  seasonCode: 'W27',
  strategy: 'merge',
  status: 'validated',
  valid: true,
  expectedDataVersion: 0,
  previewHash: 'preview-hash',
  counts: v3Counts,
  diagnosticCount: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
  expiresAt: '2026-07-24T12:00:00.000Z',
} satisfies SeasonalImportV3StageResult;

const v3Committed = {
  batchId: v3Stage.batchId,
  requestId: v3Stage.requestId,
  seasonId: v3Stage.seasonId,
  seasonCode: v3Stage.seasonCode,
  strategy: v3Stage.strategy,
  status: 'committed',
  previewHash: v3Stage.previewHash,
  counts: v3Counts,
  importedRecordCount: 1,
  totalEffectiveRecordCount: 1,
  dataVersion: 1,
  serverHighWater: 10,
  checksum: 'checksum-v3',
} satisfies SeasonalImportV3CommittedResult;

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

test('targeted refresh caches every imported and preserved added physical row', async () => {
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
    assert.equal(refreshed.window.records.length, snapshotResult.totalCount);
    assert.equal(refreshed.window.records.filter((record) => record.sourceKind === 'imported').length, committed.flightRecordCount);
    assert.deepEqual(
      refreshed.window.records.filter((record) => record.sourceKind === 'added').map((record) => record.id),
      ['preserved-added-1', 'preserved-added-2'],
    );
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

test('committed refresh rejects malformed, stale, and contract-mismatched snapshots', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['missing records', { ...snapshotResult, records: undefined }, /records.*array/i],
    ['missing modifications', { ...snapshotResult, modifications: undefined }, /modifications.*Map/i],
    ['truncated', { ...snapshotResult, truncated: true }, /truncated/i],
    ['empty', { ...snapshotResult, records: [], totalCount: 0 }, /imported flight record count/i],
    ['stale version', { ...snapshotResult, dataVersion: committed.dataVersion - 1 }, /dataVersion/i],
    ['stale highwater', { ...snapshotResult, serverHighWater: committed.serverHighWater - 1 }, /serverHighWater/i],
    ['wrong physical total', { ...snapshotResult, totalCount: snapshotResult.totalCount - 1 }, /record count.*totalCount/i],
    ['wrong imported count', {
      ...snapshotResult,
      records: snapshotResult.records.map((record, index) => index === 1 ? { ...record, sourceKind: 'added' as const } : record),
    }, /imported flight record count/i],
    ['wrong snapshot source row count', { ...snapshotResult, sourceRowCount: committed.sourceRowCount + 1 }, /source row count/i],
    ['wrong season metadata source row count', { ...snapshotResult }, /season metadata source row count/i],
    ['wrong snapshot season code', { ...snapshotResult, seasonCode: 'S99' }, /seasonCode mismatch/i],
    ['wrong season metadata code', { ...snapshotResult }, /season metadata code/i],
  ];

  for (const [label, snapshot, expected] of cases) {
    await assert.rejects(
      loadTargetedCommittedImportRefresh({
        committedImport: committed,
        loadSeasons: async () => [
          label === 'wrong season metadata source row count'
            ? { ...season, totalSourceRows: committed.sourceRowCount + 1 }
            : label === 'wrong season metadata code'
              ? { ...season, seasonCode: 'S99' }
              : season,
        ],
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
  const zeroSnapshot = { ...snapshotResult, totalCount: 0, sourceRowCount: 0, records: [] };

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

test('V3 Resume/Check performs one status-only request and returns preview or commit', async () => {
  const receipt = buildSeasonalImportV3RecoveryReceipt(v3Stage);
  for (const statusResult of [v3Stage, v3Committed]) {
    const requestIds: string[] = [];
    const result = await checkSeasonalImportV3RecoveryStatusOnce(
      receipt,
      async (requestId) => {
        requestIds.push(requestId);
        return statusResult;
      },
    );
    assert.deepEqual(requestIds, [v3Stage.requestId]);
    assert.equal(result.clearReceipt, false);
    assert.equal(result.kind, statusResult.status === 'committed' ? 'committed' : 'preview');
    assert.equal(result.result, statusResult);
  }
});

test('V3 terminal status requests receipt clearing only after status is displayed', async () => {
  const receipt = buildSeasonalImportV3RecoveryReceipt(v3Stage);
  for (const status of ['failed', 'cancelled', 'expired'] as const) {
    const terminal = {
      ...v3Stage,
      status,
      valid: false,
      diagnosticCount: 1,
      diagnostics: [{
        code: status,
        message: `Batch is ${status}.`,
        sourceRowIndexes: [],
        occurrenceKey: null,
        affectedDateCount: 0,
        sampleDates: [],
      }],
    } satisfies SeasonalImportV3StageResult;
    const result = await checkSeasonalImportV3RecoveryStatusOnce(
      receipt,
      async () => terminal,
    );
    assert.equal(result.kind, 'terminal');
    assert.equal(result.clearReceipt, true);
    assert.equal(result.result.status, status);
  }
});

test('V3 unknown network status keeps the receipt and never invokes an apply callback', async () => {
  const receipt = buildSeasonalImportV3RecoveryReceipt(v3Stage);
  let statusCalls = 0;
  await assert.rejects(
    checkSeasonalImportV3RecoveryStatusOnce(receipt, async () => {
      statusCalls += 1;
      throw new Error('Failed to fetch');
    }),
    /Failed to fetch/,
  );
  assert.equal(statusCalls, 1);
  assert.equal(receipt.status, 'validated');
});

test('V3 status recovery preserves deleted-overlay preview counts exactly', async () => {
  const stage = {
    ...v3Stage,
    counts: {
      ...v3Stage.counts,
      preservedOverlayCount: 4,
      preservedDeletedOverlayCount: 2,
      clearDeletedOverlayCount: 0,
    },
  } satisfies SeasonalImportV3StageResult;
  const result = await checkSeasonalImportV3RecoveryStatusOnce(
    buildSeasonalImportV3RecoveryReceipt(stage),
    async () => stage,
  );

  assert.equal(result.kind, 'preview');
  assert.equal(result.result.counts.preservedDeletedOverlayCount, 2);
  assert.equal(result.result.counts.clearDeletedOverlayCount, 0);
});
