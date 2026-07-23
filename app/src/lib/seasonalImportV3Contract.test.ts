import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSeasonalImportV3RequestId,
  parseSeasonalImportV3CancelResult,
  parseSeasonalImportV3CommittedResult,
  parseSeasonalImportV3StageResult,
  parseSeasonalImportV3StatusResult,
  prepareSeasonalImportV3Attempt,
  type SeasonalImportV3PreviewCounts,
} from './seasonalImportV3Contract.ts';

const BATCH_ID = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '11111111-1111-5111-8111-111111111111';
const SEASON_ID = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
const HASH = 'a'.repeat(64);

function previewCounts(
  overrides: Partial<SeasonalImportV3PreviewCounts> = {},
): SeasonalImportV3PreviewCounts {
  return {
    sourceRowCount: 1,
    generatedOccurrenceCount: 2,
    insertCount: 1,
    baselineUpdateCount: 0,
    unchangedCount: 1,
    preservedOutsideScopeCount: 3,
    preservedOverlayCount: 2,
    preservedDeletedOverlayCount: 1,
    removeImportedCount: 0,
    clearStructuralOverlayCount: 0,
    clearDeletedOverlayCount: 0,
    manualCollisionCount: 0,
    ...overrides,
  };
}

function stageResult(overrides: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    requestId: REQUEST_ID,
    seasonId: SEASON_ID,
    seasonCode: 'S26',
    strategy: 'merge',
    status: 'validated',
    valid: true,
    expectedDataVersion: 16573,
    previewHash: HASH,
    counts: previewCounts(),
    diagnosticCount: 0,
    diagnosticsTruncated: false,
    diagnostics: [],
    expiresAt: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

function committedResult(overrides: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    requestId: REQUEST_ID,
    seasonId: SEASON_ID,
    seasonCode: 'S26',
    strategy: 'merge',
    status: 'committed',
    previewHash: HASH,
    counts: previewCounts(),
    importedRecordCount: 10,
    totalEffectiveRecordCount: 15,
    dataVersion: 16574,
    serverHighWater: 20001,
    checksum: 'b'.repeat(64),
    ...overrides,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

async function expectedRequestId(input: {
  seasonIdentity: string;
  expectedDataVersion: number;
  strategy: 'merge' | 'replace';
  checksum: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableJson({ contractVersion: 3, ...input })),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('V3 stage accepts invalid structured previews without throwing', () => {
  const result = parseSeasonalImportV3StageResult(stageResult({
    status: 'failed',
    valid: false,
    counts: previewCounts({ manualCollisionCount: 1 }),
    diagnosticCount: 1,
    diagnostics: [{
      code: 'manual-occurrence-collision',
      message: 'Incoming occurrence collides with a manual added flight.',
      sourceRowIndexes: [4],
      occurrenceKey: `${SEASON_ID}|2026-06-06|KC|KC259`,
      affectedDateCount: 1,
      sampleDates: ['2026-06-06'],
    }],
  }));

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.counts.manualCollisionCount, 1);
});

test('V3 stage parser is exact and validates identifiers, enums, hashes, and counts', () => {
  assert.deepEqual(parseSeasonalImportV3StageResult(stageResult()), stageResult());
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({ extra: true })),
    /unexpected field extra/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({ counts: undefined })),
    /counts/,
  );
  for (const field of ['batchId', 'requestId'] as const) {
    assert.throws(
      () => parseSeasonalImportV3StageResult(stageResult({ [field]: 'not-a-uuid' })),
      new RegExp(field),
    );
  }
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({ seasonId: '  ' })),
    /seasonId/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({ strategy: 'append' })),
    /strategy/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({ previewHash: '  ' })),
    /previewHash/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      counts: previewCounts({ insertCount: -1 }),
    })),
    /insertCount/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      counts: previewCounts({ unchangedCount: 2 }),
    })),
    /generatedOccurrenceCount/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      counts: previewCounts({ removeImportedCount: 1 }),
    })),
    /removeImportedCount/,
  );
});

test('V3 stage enforces validity and diagnostic count invariants', () => {
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      counts: previewCounts({ manualCollisionCount: 1 }),
    })),
    /manualCollisionCount/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      diagnosticCount: 1,
    })),
    /diagnosticCount/,
  );
  assert.throws(
    () => parseSeasonalImportV3StageResult(stageResult({
      status: 'failed',
      valid: false,
      diagnosticCount: 2,
      diagnosticsTruncated: false,
      diagnostics: [{
        code: 'one',
        message: 'One diagnostic.',
        sourceRowIndexes: [1],
        occurrenceKey: null,
        affectedDateCount: 1,
        sampleDates: ['2026-06-06'],
      }],
    })),
    /diagnosticCount/,
  );
});

test('V3 committed, status, and cancel parsers accept only their exact shapes', () => {
  assert.deepEqual(parseSeasonalImportV3CommittedResult(committedResult()), committedResult());
  assert.deepEqual(parseSeasonalImportV3StatusResult(stageResult()), stageResult());
  assert.deepEqual(parseSeasonalImportV3StatusResult(committedResult()), committedResult());
  assert.throws(
    () => parseSeasonalImportV3CommittedResult(committedResult({ unexpected: 1 })),
    /unexpected field unexpected/,
  );
  assert.deepEqual(
    parseSeasonalImportV3CancelResult({ batchId: BATCH_ID, status: 'cancelled' }),
    { batchId: BATCH_ID, status: 'cancelled' },
  );
  assert.throws(
    () => parseSeasonalImportV3CancelResult({
      batchId: BATCH_ID,
      status: 'cancelled',
      extra: true,
    }),
    /unexpected field extra/,
  );
});

test('V3 request identity is deterministic and binds contract, strategy, and version', async () => {
  const input = {
    seasonId: SEASON_ID,
    seasonCode: 'S26',
    expectedDataVersion: 16573,
    strategy: 'merge' as const,
    checksum: HASH,
  };
  const first = await deriveSeasonalImportV3RequestId(input);
  const retry = await deriveSeasonalImportV3RequestId({ ...input });

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(retry, first);
  assert.equal(first, await expectedRequestId({
    seasonIdentity: SEASON_ID,
    expectedDataVersion: input.expectedDataVersion,
    strategy: input.strategy,
    checksum: input.checksum,
  }));
  assert.notEqual(
    await deriveSeasonalImportV3RequestId({ ...input, strategy: 'replace' }),
    first,
  );
  assert.notEqual(
    await deriveSeasonalImportV3RequestId({ ...input, expectedDataVersion: 16574 }),
    first,
  );
});

test('V3 request identity normalizes new-season identity and rejects invalid input', async () => {
  const input = {
    seasonId: null,
    seasonCode: ' s27 ',
    expectedDataVersion: 0,
    strategy: 'merge' as const,
    checksum: HASH.toUpperCase(),
  };
  const first = await deriveSeasonalImportV3RequestId(input);
  const normalized = await deriveSeasonalImportV3RequestId({
    ...input,
    seasonCode: 'S27',
    checksum: HASH,
  });

  assert.equal(first, normalized);
  await assert.rejects(
    () => deriveSeasonalImportV3RequestId({ ...input, expectedDataVersion: 1 }),
    /expectedDataVersion/,
  );
  await assert.rejects(
    () => deriveSeasonalImportV3RequestId({ ...input, strategy: 'append' as 'merge' }),
    /strategy/,
  );
  await assert.rejects(
    () => deriveSeasonalImportV3RequestId({ ...input, checksum: '  ' }),
    /checksum/,
  );
});

test('V3 attempt preparation canonicalizes source rows and binds the selected strategy', async () => {
  const sourceRows = [{
    rowIndex: 1,
    effective: '2026-03-29',
    discontinue: '2026-10-24',
    airline: 'KE',
    aircraft: '738',
    daysOfWeek: [true, false, false, false, false, false, false],
    sta: '23:15',
    arrFlight: 'KE2093',
    arrFlightType: 'PAX',
    arrRoute: 'icn',
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
  }];
  const merge = await prepareSeasonalImportV3Attempt({
    seasonId: SEASON_ID,
    seasonCode: ' s26 ',
    expectedDataVersion: 16573,
    strategy: 'merge',
    fileName: 'Book3.xlsx',
    uploadedAt: 123,
    sourceRows,
  });
  const replace = await prepareSeasonalImportV3Attempt({
    seasonId: SEASON_ID,
    seasonCode: 'S26',
    expectedDataVersion: 16573,
    strategy: 'replace',
    fileName: 'Book3.xlsx',
    uploadedAt: 123,
    sourceRows,
  });

  assert.equal(merge.contractVersion, 3);
  assert.equal(merge.seasonCode, 'S26');
  assert.equal(merge.sourceRows[0].airline, 'KE');
  assert.equal(merge.sourceRows[0].arrFlight, 'KE2093');
  assert.notEqual(merge.requestId, replace.requestId);
  assert.equal(merge.checksum, replace.checksum);
});
