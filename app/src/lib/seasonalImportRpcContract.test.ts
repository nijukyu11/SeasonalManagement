import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalImportCommittedRefreshFailure,
  buildSeasonalImportV2Checksum,
  deriveSeasonalImportV2RequestId,
  normalizeSeasonalImportExpectedDataVersion,
  parseSeasonalImportV2Result,
  parseSeasonalImportV2StageResult,
} from './seasonalImportRpcContract.ts';
import type { ParsedRow } from './types.ts';

const committedResult = {
  batchId: '00000000-0000-0000-0000-000000000001',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  status: 'committed',
  sourceRowCount: 450,
  flightRecordCount: 26631,
  preservedOperationalCount: 12,
  removedImportedCount: 7,
  dataVersion: 2,
  serverHighWater: 10,
  checksum: 'abc',
} as const;

function sourceRow(rowIndex: number, flightNumber: string): ParsedRow {
  return {
    rowIndex,
    effective: '2026-10-25',
    discontinue: '2027-03-27',
    airline: 'VN',
    aircraft: '321',
    daysOfWeek: [true, false, true, false, true, false, true],
    sta: '07:05',
    arrFlight: flightNumber,
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
  };
}

test('import V2 accepts only the exact committed server result', () => {
  assert.deepEqual(parseSeasonalImportV2Result(committedResult), committedResult);
  assert.throws(
    () => parseSeasonalImportV2Result({ ...committedResult, extra: true }),
    /unexpected field extra/,
  );
});

test('import V2 rejects missing, null, snake-case-only and wrong-status responses', () => {
  assert.throws(() => parseSeasonalImportV2Result({ status: 'committed' }), /batchId/);
  for (const field of ['batchId', 'seasonId', 'seasonCode', 'checksum'] as const) {
    assert.throws(
      () => parseSeasonalImportV2Result({ ...committedResult, [field]: null }),
      new RegExp(field),
    );
    assert.throws(
      () => parseSeasonalImportV2Result({ ...committedResult, [field]: '  ' }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => parseSeasonalImportV2Result({
      batch_id: committedResult.batchId,
      season_id: committedResult.seasonId,
      season_code: committedResult.seasonCode,
      status: 'committed',
      source_row_count: committedResult.sourceRowCount,
      flight_record_count: committedResult.flightRecordCount,
      preserved_operational_count: committedResult.preservedOperationalCount,
      removed_imported_count: committedResult.removedImportedCount,
      data_version: committedResult.dataVersion,
      server_high_water: committedResult.serverHighWater,
      checksum: committedResult.checksum,
    }),
    /batchId/,
  );
  assert.throws(
    () => parseSeasonalImportV2Result({ ...committedResult, status: 'validated' }),
    /status/,
  );
});

test('import V2 rejects malformed server counts instead of substituting client lengths', () => {
  const countFields = [
    'sourceRowCount',
    'flightRecordCount',
    'preservedOperationalCount',
    'removedImportedCount',
    'dataVersion',
    'serverHighWater',
  ] as const;
  for (const field of countFields) {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '450']) {
      assert.throws(
        () => parseSeasonalImportV2Result({ ...committedResult, [field]: invalid }),
        new RegExp(field),
      );
    }
  }
});

test('stage V2 accepts only validated batches without diagnostics', () => {
  const result = {
    batchId: committedResult.batchId,
    status: 'validated',
    sourceRowCount: 1,
    generatedRecordCount: 72,
    diagnostics: [],
    valid: true,
  } as const;

  assert.deepEqual(parseSeasonalImportV2StageResult(result), result);
  assert.throws(
    () => parseSeasonalImportV2StageResult({
      ...result,
      status: 'failed',
      valid: false,
      diagnostics: [{ code: 'duplicate-occurrence', message: 'Duplicate occurrence.' }],
    }),
    /duplicate-occurrence.*Duplicate occurrence/,
  );
  assert.throws(
    () => parseSeasonalImportV2StageResult({ ...result, generatedRecordCount: null }),
    /generatedRecordCount/,
  );
});

test('seasonal import checksum is stable across property order and normalized season code', async () => {
  const canonical = sourceRow(1, 'VN336');
  const reordered = Object.fromEntries(Object.entries(canonical).reverse()) as unknown as ParsedRow;

  const first = await buildSeasonalImportV2Checksum(' w26 ', [canonical]);
  const second = await buildSeasonalImportV2Checksum('W26', [reordered]);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.notEqual(
    await buildSeasonalImportV2Checksum('W26', [sourceRow(2, 'VN337'), canonical]),
    await buildSeasonalImportV2Checksum('W26', [canonical, sourceRow(2, 'VN337')]),
  );
});

test('request ID is deterministic, UUID-form and sensitive to expected version', async () => {
  const input = {
    seasonId: 'season-w26',
    seasonCode: 'W26',
    expectedDataVersion: 3,
    checksum: await buildSeasonalImportV2Checksum('W26', [sourceRow(1, 'VN336')]),
  };

  const first = await deriveSeasonalImportV2RequestId(input);
  const retry = await deriveSeasonalImportV2RequestId(input);
  const nextVersion = await deriveSeasonalImportV2RequestId({ ...input, expectedDataVersion: 4 });
  const otherSeason = await deriveSeasonalImportV2RequestId({ ...input, seasonId: 'season-s27' });
  const otherChecksum = await deriveSeasonalImportV2RequestId({
    ...input,
    checksum: `${input.checksum.startsWith('f') ? 'e' : 'f'}${input.checksum.slice(1)}`,
  });

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(retry, first);
  assert.notEqual(nextVersion, first);
  assert.notEqual(otherSeason, first);
  assert.notEqual(otherChecksum, first);
});

test('new-season null expected version normalizes to zero while existing-season null is rejected', async () => {
  assert.equal(normalizeSeasonalImportExpectedDataVersion(null, null), 0);
  assert.equal(normalizeSeasonalImportExpectedDataVersion(undefined, 0), 0);
  assert.throws(
    () => normalizeSeasonalImportExpectedDataVersion('season-w26', null),
    /expectedDataVersion/,
  );
  assert.throws(
    () => normalizeSeasonalImportExpectedDataVersion('season-w26', -1),
    /expectedDataVersion/,
  );

  const checksum = await buildSeasonalImportV2Checksum('W27', [sourceRow(1, 'VN336')]);
  assert.equal(
    await deriveSeasonalImportV2RequestId({
      seasonId: null,
      seasonCode: 'W27',
      expectedDataVersion: null,
      checksum,
    }),
    await deriveSeasonalImportV2RequestId({
      seasonId: null,
      seasonCode: 'W27',
      expectedDataVersion: 0,
      checksum,
    }),
  );
});

test('a committed import refresh failure is not classified as Import Failed', () => {
  const failure = buildSeasonalImportCommittedRefreshFailure(
    committedResult,
    new Error('Server window unavailable.'),
  );

  assert.equal(failure.title, 'Import committed, refresh failed');
  assert.match(failure.message, /Import committed, refresh failed/);
  assert.match(failure.message, /season-w26/);
  assert.match(failure.message, /00000000-0000-0000-0000-000000000001/);
  assert.match(failure.message, /Server window unavailable/);
  assert.doesNotMatch(failure.title, /Import Failed/);
});
