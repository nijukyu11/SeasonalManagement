import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmDailyImportZeroFlightDatesV1 } from './dailyImportScope.ts';
import {
  createDailyImportRetryPayloadV1,
  dailyImportPreviewTotalsV1,
  finishCommittedDailyImportV1,
  DailyImportV1RpcRejectedError,
  isDailyImportStaleVersionConflictV1,
  stageDailyImportWithTerminalRetryV1,
  type DailyImportStageResultV1,
} from './dailyImportRpcContract.ts';
import type { DailyImportStagePayloadV1 } from './dailyImportV1Contract.ts';
import type { DailyImportCommittedResultV1 } from './dailyImportRpcContract.ts';

test('preview uses effective totals without turning unknown Pax into zero', () => {
  const counts = { beforeCount: 2, afterCount: 2, insertedCount: 2, beforePax: 0, beforePaxKnownCount: 0, afterPax: 200, afterPaxKnownCount: 2,
    effectiveAfterCount: 1, effectiveAfterPax: 0, effectiveAfterPaxKnownCount: 1 };
  assert.deepEqual(dailyImportPreviewTotalsV1(counts), { beforePax: null, importedPax: 200, effectiveCount: 1, effectivePax: 0 });
  assert.equal(dailyImportPreviewTotalsV1({ ...counts, effectiveAfterPaxKnownCount: 0 }).effectivePax, null);
  assert.equal(dailyImportPreviewTotalsV1({ ...counts, effectiveAfterCount: undefined }).effectiveCount, null);
});

test('confirmed commit survives refresh failure; retry clears receipt only after read succeeds', async () => {
  const receipt = { status: 'committed', batchId: 'committed-batch', seasons: [] } as unknown as DailyImportCommittedResultV1;
  let remembered: DailyImportCommittedResultV1 | null = null;
  let refreshes = 0;
  const options = { remember: (value: DailyImportCommittedResultV1) => { remembered = value; },
    refresh: async () => { refreshes++; if (refreshes === 1) throw new TypeError('Failed to fetch'); },
    clear: () => { remembered = null; } };
  const first = await finishCommittedDailyImportV1(receipt, options);
  assert.equal(first.receipt.status, 'committed');
  assert.equal(first.refreshError, 'Failed to fetch');
  assert.equal(remembered, receipt);
  const retry = await finishCommittedDailyImportV1(receipt, options);
  assert.equal(retry.refreshError, null);
  assert.equal(remembered, null);
  assert.equal(refreshes, 2);
});

function payload(): DailyImportStagePayloadV1 {
  return {
    contractVersion: 1,
    requestId: '00000000-0000-5000-8000-000000000000',
    fileName: 'fixture.xlsx',
    workbookProfile: 'compact-b2',
    rawChecksum: 'raw',
    canonicalChecksum: 'before',
    resourcePolicyHash: 'policy',
    legs: [
      { sourceRowNumber: 2, sheetName: 'Data', side: 'ARR', seasonCode: 'S26', operationalDate: '2026-08-23', scheduledDate: '2026-08-23', scheduledTime: '08:00', airline: 'VN', flightNumber: 'VN101', rawFlightNumber: 'VN101', route: 'HAN', aircraft: 'A321', category: 'J', flightType: 'INT', requestStatusCode: null, resources: {}, rawResourceTokens: {}, occurrenceKey: 'one', looseOccurrenceKey: 'loose-one' },
      { sourceRowNumber: 3, sheetName: 'Data', side: 'DEP', seasonCode: 'S26', operationalDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '09:00', airline: 'VN', flightNumber: 'VN102', rawFlightNumber: 'VN102', route: 'SGN', aircraft: 'A321', category: 'J', flightType: 'INT', requestStatusCode: null, resources: {}, rawResourceTokens: {}, occurrenceKey: 'two', looseOccurrenceKey: 'loose-two' },
    ],
    seasons: [{ seasonId: 'season-1', seasonCode: 'S26', expectedDataVersion: 7, rangeStart: '2026-08-23', rangeEnd: '2026-08-25', affectedDates: ['2026-08-23', '2026-08-25'], confirmedZeroFlightDates: [], legCount: 2 }],
    diagnostics: [{ severity: 'blocking', code: 'DAILY_COVERAGE_GAP', message: 'gap', sheetName: 'Data', rowNumber: null, cellAddress: null, seasonCode: 'S26', operationalDate: null }],
  };
}

test('explicit zero-flight confirmation becomes part of affected scope and request identity', async () => {
  const before = payload();
  const confirmed = await confirmDailyImportZeroFlightDatesV1(before, { 'season-1': ['2026-08-24'] });
  assert.deepEqual(confirmed.seasons[0].affectedDates, ['2026-08-23', '2026-08-24', '2026-08-25']);
  assert.deepEqual(confirmed.seasons[0].confirmedZeroFlightDates, ['2026-08-24']);
  assert.equal(confirmed.diagnostics.length, 0);
  assert.notEqual(confirmed.requestId, before.requestId);
  assert.notEqual(confirmed.canonicalChecksum, before.canonicalChecksum);
});

test('zero-flight confirmation rejects dates that already contain a leg', async () => {
  await assert.rejects(
    confirmDailyImportZeroFlightDatesV1(payload(), { 'season-1': ['2026-08-23'] }),
    /đã có leg/,
  );
});

test('terminal Daily import retry gets a new request identity without changing the staged payload', () => {
  const before = payload();
  const retryRequestId = '11111111-1111-4111-8111-111111111111';
  const retry = createDailyImportRetryPayloadV1(before, retryRequestId);
  assert.equal(retry.requestId, retryRequestId);
  assert.equal(before.requestId, '00000000-0000-5000-8000-000000000000');
  assert.deepEqual({ ...retry, requestId: before.requestId }, before);
});

test('only the explicit HTTP conflict for stale Daily stage metadata is auto-refreshable', () => {
  const stale = new DailyImportV1RpcRejectedError(
    'stage Daily Schedule import V1: Stale Daily import stage for season season-1: expected 7, current 8',
    { code: 'PT409', details: 'refresh season metadata' },
  );
  assert.equal(isDailyImportStaleVersionConflictV1(stale), true);
  assert.equal(stale.details, 'refresh season metadata');
  assert.equal(isDailyImportStaleVersionConflictV1(new DailyImportV1RpcRejectedError(stale.message, { code: 'P0001' })), false);
  assert.equal(isDailyImportStaleVersionConflictV1(new DailyImportV1RpcRejectedError('preview hash mismatch', { code: 'PT409' })), false);
});

test('cancelled Daily import batch is staged again once with a fresh request identity', async () => {
  const before = payload();
  const calls: DailyImportStagePayloadV1[] = [];
  const resultFor = (input: DailyImportStagePayloadV1, status: DailyImportStageResultV1['status']): DailyImportStageResultV1 => ({
    batchId: status === 'cancelled' ? 'batch-cancelled' : 'batch-validated',
    requestId: input.requestId,
    status,
    previewHash: 'preview-hash',
    preview: { valid: true, fileName: input.fileName, workbookProfile: input.workbookProfile, sourceRowCount: 2, legCount: 2, seasons: [] },
    diagnostics: [],
    expiresAt: '2026-09-02T02:00:00Z',
    result: null,
  });
  const staged = await stageDailyImportWithTerminalRetryV1(before, async (input) => {
    calls.push(input);
    return resultFor(input, calls.length === 1 ? 'cancelled' : 'validated');
  }, { createRequestId: () => '22222222-2222-4222-8222-222222222222' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, before.requestId);
  assert.equal(calls[1].requestId, '22222222-2222-4222-8222-222222222222');
  assert.equal(staged.result.status, 'validated');
  assert.equal(staged.payload.requestId, calls[1].requestId);
});

test('transport failure recovers the staged batch using the same request identity', async () => {
  const before = payload();
  const lookedUp: string[] = [];
  const recovered: DailyImportStageResultV1 = {
    batchId: 'batch-recovered',
    requestId: before.requestId,
    status: 'validated',
    previewHash: 'preview-hash',
    preview: { valid: true, fileName: before.fileName, workbookProfile: before.workbookProfile, sourceRowCount: 2, legCount: 2, seasons: [] },
    diagnostics: [],
    expiresAt: '2026-09-02T02:00:00Z',
    result: null,
  };

  const staged = await stageDailyImportWithTerminalRetryV1(before, async () => {
    throw new TypeError('Failed to fetch');
  }, {
    getStatus: async (requestId) => {
      lookedUp.push(requestId);
      return recovered;
    },
  });

  assert.deepEqual(lookedUp, [before.requestId]);
  assert.equal(staged.payload.requestId, before.requestId);
  assert.equal(staged.result, recovered);
});

test('transport failure remains visible when the same request identity was not persisted', async () => {
  const before = payload();
  const original = new TypeError('Failed to fetch');
  await assert.rejects(
    stageDailyImportWithTerminalRetryV1(before, async () => {
      throw original;
    }, {
      getStatus: async () => { throw new Error('not found'); },
    }),
    (error) => error === original,
  );
});
