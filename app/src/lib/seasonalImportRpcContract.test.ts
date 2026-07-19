import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalImportCommittedRefreshFailure,
  buildSeasonalImportV2Checksum,
  canonicalizeSeasonalImportSourceRows,
  deriveSeasonalImportV2RequestId,
  normalizeSeasonalImportExpectedDataVersion,
  parseSeasonalImportV2Result,
  parseSeasonalImportV2StageResult,
  runSeasonalImportV2RpcFlow,
  SeasonalImportV2RpcRejectedError,
  SeasonalImportV2StatusUnknownError,
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

const validatedStage = {
  batchId: committedResult.batchId,
  status: 'validated',
  sourceRowCount: 1,
  generatedRecordCount: 72,
  diagnostics: [],
  valid: true,
} as const;

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

test('stage V2 accepts validated and committed persisted batches without diagnostics', () => {
  assert.deepEqual(parseSeasonalImportV2StageResult(validatedStage), validatedStage);
  assert.deepEqual(
    parseSeasonalImportV2StageResult({ ...validatedStage, status: 'committed' }),
    { ...validatedStage, status: 'committed' },
  );
  assert.throws(
    () => parseSeasonalImportV2StageResult({
      ...validatedStage,
      status: 'failed',
      valid: false,
      diagnostics: [{ code: 'duplicate-occurrence', message: 'Duplicate occurrence.' }],
    }),
    /duplicate-occurrence.*Duplicate occurrence/,
  );
  assert.throws(
    () => parseSeasonalImportV2StageResult({ ...validatedStage, generatedRecordCount: null }),
    /generatedRecordCount/,
  );
});

test('canonical source DTO normalizes nullability, Unicode and drops unsupported extras', () => {
  const nfc = sourceRow(1, 'VN336');
  nfc.arrRoute = 'Đà Nẵng';
  const missingOptionals = {
    rowIndex: 1,
    effective: nfc.effective,
    discontinue: nfc.discontinue,
    airline: nfc.airline,
    aircraft: nfc.aircraft,
    daysOfWeek: nfc.daysOfWeek,
    sta: nfc.sta,
    arrFlight: nfc.arrFlight,
    arrRoute: 'Đà Nẵng'.normalize('NFD'),
    unsupportedClientField: 'drop-me',
  } as unknown as ParsedRow;
  const explicitNulls = {
    rowIndex: 1,
    effective: nfc.effective,
    discontinue: nfc.discontinue,
    airline: nfc.airline,
    aircraft: nfc.aircraft,
    daysOfWeek: nfc.daysOfWeek,
    sta: nfc.sta,
    arrFlight: nfc.arrFlight,
    arrFlightType: null,
    arrRoute: 'Đà Nẵng',
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
    std: null,
    depFlight: null,
    depFlightType: null,
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
    overnightLinkRowIndex: null,
    linkType: null,
  } as unknown as ParsedRow;

  const canonicalMissing = canonicalizeSeasonalImportSourceRows([missingOptionals]);
  const canonicalNulls = canonicalizeSeasonalImportSourceRows([explicitNulls]);

  assert.deepEqual(canonicalMissing, canonicalNulls);
  assert.equal(canonicalMissing[0].arrRoute, 'Đà Nẵng'.normalize('NFC'));
  assert.equal(canonicalMissing[0].arrCodeShares, null);
  assert.equal(canonicalMissing[0].overnightLinkRowIndex, null);
  assert.equal(canonicalMissing[0].linkType, null);
  assert.equal('unsupportedClientField' in canonicalMissing[0], false);
  assert.deepEqual(Object.keys(canonicalMissing[0]), [
    'rowIndex', 'effective', 'discontinue', 'airline', 'aircraft', 'daysOfWeek',
    'sta', 'arrFlight', 'arrFlightType', 'arrRoute', 'arrFlightCategory', 'arrCodeShares', 'arrIntDomInd',
    'std', 'depFlight', 'depFlightType', 'depRoute', 'depFlightCategory', 'depCodeShares', 'depIntDomInd',
    'overnightLinkRowIndex', 'linkType',
  ]);
});

test('canonical source DTO rejects invalid row identity and operating days', () => {
  assert.throws(
    () => canonicalizeSeasonalImportSourceRows([{ ...sourceRow(1, 'VN336'), rowIndex: 1.5 }]),
    /rowIndex/,
  );
  assert.throws(
    () => canonicalizeSeasonalImportSourceRows([{
      ...sourceRow(1, 'VN336'),
      daysOfWeek: [true, false],
    }]),
    /seven booleans/,
  );
  assert.throws(
    () => canonicalizeSeasonalImportSourceRows([{
      ...sourceRow(1, 'VN336'),
      daysOfWeek: [true, false, true, false, true, false, 1] as unknown as boolean[],
    }]),
    /seven booleans/,
  );
});

test('seasonal import checksum is stable across DTO property order, nullability, Unicode and season code', async () => {
  const canonical = sourceRow(1, 'VN336');
  canonical.arrRoute = 'Đà Nẵng';
  const reordered = Object.fromEntries(Object.entries({
    ...canonical,
    arrRoute: 'Đà Nẵng'.normalize('NFD'),
    overnightLinkRowIndex: undefined,
    linkType: undefined,
  }).reverse()) as unknown as ParsedRow;
  const canonicalRows = canonicalizeSeasonalImportSourceRows([canonical]);
  const reorderedRows = canonicalizeSeasonalImportSourceRows([reordered]);

  const first = await buildSeasonalImportV2Checksum(' w26 ', canonicalRows);
  const second = await buildSeasonalImportV2Checksum('W26', reorderedRows);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.notEqual(
    await buildSeasonalImportV2Checksum('W26', canonicalizeSeasonalImportSourceRows([sourceRow(2, 'VN337'), canonical])),
    await buildSeasonalImportV2Checksum('W26', canonicalizeSeasonalImportSourceRows([canonical, sourceRow(2, 'VN337')])),
  );
});

test('request ID is deterministic, UUID-form and sensitive to expected version', async () => {
  const input = {
    seasonId: 'season-w26',
    seasonCode: 'W26',
    expectedDataVersion: 3,
    checksum: await buildSeasonalImportV2Checksum('W26', canonicalizeSeasonalImportSourceRows([sourceRow(1, 'VN336')])),
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
    () => normalizeSeasonalImportExpectedDataVersion(null, 1),
    /new seasonal import.*zero/i,
  );
  assert.throws(
    () => normalizeSeasonalImportExpectedDataVersion(undefined, 2),
    /new seasonal import.*zero/i,
  );
  assert.throws(
    () => normalizeSeasonalImportExpectedDataVersion('season-w26', null),
    /expectedDataVersion/,
  );
  assert.throws(
    () => normalizeSeasonalImportExpectedDataVersion('season-w26', -1),
    /expectedDataVersion/,
  );

  const checksum = await buildSeasonalImportV2Checksum('W27', canonicalizeSeasonalImportSourceRows([sourceRow(1, 'VN336')]));
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

test('committed staging recovery still invokes idempotent commit exactly once', async () => {
  const stageGate = deferred<unknown>();
  const commitGate = deferred<unknown>();
  const calls: string[] = [];
  const attempt = {
    requestId: '11111111-1111-5111-8111-111111111111',
    checksum: committedResult.checksum,
    seasonId: committedResult.seasonId,
    seasonCode: committedResult.seasonCode,
    expectedDataVersion: 1,
    fileName: 'W26.xlsx',
    uploadedAt: 1,
    sourceRows: canonicalizeSeasonalImportSourceRows([sourceRow(1, 'VN336')]),
  };
  const running = runSeasonalImportV2RpcFlow(attempt, {
    stage: async (payload) => {
      calls.push(`stage:${payload.requestId}`);
      return stageGate.promise;
    },
    commit: async (batchId, expectedDataVersion) => {
      calls.push(`commit:${batchId}:${expectedDataVersion}`);
      return commitGate.promise;
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, [`stage:${attempt.requestId}`]);
  stageGate.resolve({ ...validatedStage, status: 'committed' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    `stage:${attempt.requestId}`,
    `commit:${committedResult.batchId}:1`,
  ]);
  commitGate.resolve(committedResult);
  assert.deepEqual(await running, committedResult);
  assert.equal(calls.length, 2);
});

test('RPC flow never automatically retries an ambiguous stage or commit failure', async () => {
  const attempt = {
    requestId: '22222222-2222-5222-8222-222222222222',
    checksum: committedResult.checksum,
    seasonId: committedResult.seasonId,
    seasonCode: committedResult.seasonCode,
    expectedDataVersion: 1,
    fileName: 'W26.xlsx',
    uploadedAt: 1,
    sourceRows: canonicalizeSeasonalImportSourceRows([sourceRow(1, 'VN336')]),
  };
  let stageCalls = 0;
  let commitCalls = 0;
  await assert.rejects(
    runSeasonalImportV2RpcFlow(attempt, {
      stage: async () => {
        stageCalls += 1;
        throw new Error('network stage failure');
      },
      commit: async () => {
        commitCalls += 1;
        return committedResult;
      },
    }),
    SeasonalImportV2StatusUnknownError,
  );
  assert.equal(stageCalls, 1);
  assert.equal(commitCalls, 0);

  stageCalls = 0;
  commitCalls = 0;
  await assert.rejects(
    runSeasonalImportV2RpcFlow(attempt, {
      stage: async () => {
        stageCalls += 1;
        return validatedStage;
      },
      commit: async () => {
        commitCalls += 1;
        throw new Error('network commit failure');
      },
    }),
    SeasonalImportV2StatusUnknownError,
  );
  assert.equal(stageCalls, 1);
  assert.equal(commitCalls, 1);
});

test('RPC flow preserves conclusive coded server rejection instead of reporting unknown status', async () => {
  const rejection = new SeasonalImportV2RpcRejectedError(
    'commit seasonal import: stale data version',
    { code: '40001' },
  );
  const attempt = {
    requestId: '44444444-4444-5444-8444-444444444444',
    checksum: committedResult.checksum,
    seasonId: committedResult.seasonId,
    seasonCode: committedResult.seasonCode,
    expectedDataVersion: 1,
    fileName: 'W26.xlsx',
    uploadedAt: 1,
    sourceRows: canonicalizeSeasonalImportSourceRows([sourceRow(1, 'VN336')]),
  };
  let commitCalls = 0;

  await assert.rejects(
    runSeasonalImportV2RpcFlow(attempt, {
      stage: async () => validatedStage,
      commit: async () => {
        commitCalls += 1;
        throw rejection;
      },
    }),
    (error) => error === rejection,
  );
  assert.equal(commitCalls, 1);
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
