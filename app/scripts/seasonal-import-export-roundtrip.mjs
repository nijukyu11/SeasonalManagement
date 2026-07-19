import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import {
  authenticatedQuery,
  cleanupTestPrincipals,
  commitBatch,
  connectTestDatabase,
  createTestPrincipals,
  fetchExportSnapshot,
  loadVerifiedFixture,
  occurrenceKey,
  occurrenceSignature,
  previewBatch,
  previewSignatures,
  removeBatchAndSeason,
  stageAttempt,
} from './seasonal-import-v2-load-test.mjs';

const {
  buildCanonicalSeasonalRows,
  exportCanonicalSeasonalRowsToExcel,
} = await import('../src/lib/canonicalSeasonalRows.ts');
const { parseSeasonalSchedule, expandToFlightLegs } = await import('../src/lib/parser.ts');
const { materializeSeasonalExportSnapshot } = await import('../src/lib/seasonalExportSnapshot.ts');
const { materializeEffectiveSeasonalLegs } = await import('../src/lib/effectiveSeasonalLegs.ts');
const {
  inferLinkedPairType,
  pairAnchorForLinkedLegs,
  resolveSeasonalPairs,
} = await import('../src/lib/seasonalPairing.ts');
const {
  canonicalizeSeasonalImportSourceRows,
  prepareSeasonalImportV2Attempt,
} = await import('../src/lib/seasonalImportRpcContract.ts');

function sortedSignatures(legs) {
  return legs.map(occurrenceSignature).sort();
}

function assertNoDuplicateKeys(legs, label) {
  const counts = new Map();
  for (const leg of legs) counts.set(occurrenceKey(leg), (counts.get(occurrenceKey(leg)) ?? 0) + 1);
  const duplicates = Array.from(counts).filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], `${label} duplicate occurrence keys: ${JSON.stringify(duplicates.slice(0, 10))}`);
}

function assertSignaturesEqual(expected, actual, label) {
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const signature of expected) expectedCounts.set(signature, (expectedCounts.get(signature) ?? 0) + 1);
  for (const signature of actual) actualCounts.set(signature, (actualCounts.get(signature) ?? 0) + 1);
  const missing = [];
  const extra = [];
  for (const [signature, count] of expectedCounts) {
    const delta = count - (actualCounts.get(signature) ?? 0);
    if (delta > 0) missing.push([signature, delta]);
  }
  for (const [signature, count] of actualCounts) {
    const delta = count - (expectedCounts.get(signature) ?? 0);
    if (delta > 0) extra.push([signature, delta]);
  }
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label} occurrence signature mismatch`);
}

function pairDiagnostics(resolution) {
  const count = (code) => resolution.issues.filter((issue) => issue.code === code).length;
  return {
    unresolvedPairCount: resolution.issues.length,
    ambiguousPairCount: count('ambiguous-pair'),
    nonReciprocalPairCount: count('non-reciprocal-link'),
    missingCounterpartCount: count('missing-counterpart'),
  };
}

function pairSignature(pair) {
  const linkType = inferLinkedPairType(pair.arrival, pair.departure);
  const anchorDate = pairAnchorForLinkedLegs(pair.arrival, pair.departure, linkType);
  return [
    occurrenceSignature(pair.arrival),
    occurrenceSignature(pair.departure),
    linkType,
    anchorDate,
  ].join('=>');
}

function pairingTopology(legs, resolution) {
  const turnaroundCardinality = new Map();
  for (const leg of legs) {
    if (!leg.turnaroundId) continue;
    turnaroundCardinality.set(
      leg.turnaroundId,
      (turnaroundCardinality.get(leg.turnaroundId) ?? 0) + 1,
    );
  }
  const pairSignatures = resolution.pairs.map(pairSignature).sort();
  const pairTurnaroundCardinality = resolution.pairs.map((pair) => {
    const ids = Array.from(new Set([
      pair.arrival.turnaroundId,
      pair.departure.turnaroundId,
    ].filter(Boolean)));
    const cardinalities = ids.map((id) => turnaroundCardinality.get(id) ?? 0).sort((a, b) => a - b);
    return `${pairSignature(pair)}|turnaround:${cardinalities.join(',') || 'none'}`;
  }).sort();
  return {
    pairSignatures,
    pairTurnaroundCardinality,
    turnaroundGroupCount: turnaroundCardinality.size,
  };
}

async function parseWorkbookBlob(blob, seasonCode) {
  assert.ok(blob.size > 0, `${seasonCode} export workbook is empty`);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.ok(bytes.length > 100, `${seasonCode} export workbook is unexpectedly small`);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const parsed = parseSeasonalSchedule(workbook);
  assert.equal(parsed.seasonCode, seasonCode);
  assert.deepEqual(parsed.issues, [], `${seasonCode} exported workbook parser issues`);
  assert.ok(parsed.rows.length > 0, `${seasonCode} exported workbook contains no source rows`);
  return { bytes, rows: canonicalizeSeasonalImportSourceRows(parsed.rows), legs: expandToFlightLegs(parsed.rows) };
}

async function verifySeasonRoundTrip(client, userId, seasonCode) {
  const fixtureData = await loadVerifiedFixture(seasonCode);
  const fixtureSignatures = sortedSignatures(fixtureData.legs);
  assertNoDuplicateKeys(fixtureData.legs, `${seasonCode} input`);

  const initialAttempt = await prepareSeasonalImportV2Attempt({
    seasonId: null,
    seasonCode,
    expectedDataVersion: 0,
    fileName: fixtureData.fixture.source.basename,
    uploadedAt: 0,
    sourceRows: fixtureData.sourceRows,
  });
  const staged = await stageAttempt(client, userId, initialAttempt);
  const initialPreview = await previewBatch(client, staged.result.batchId);
  assert.equal(initialPreview.generated_count, fixtureData.fixture.verification.expectedGeneratedCount);
  assert.equal(initialPreview.duplicate_count, 0);
  assert.equal(initialPreview.diagnostic_count, 0);
  const committed = await commitBatch(client, userId, staged.result.batchId, 0);
  assert.equal(committed.result.flightRecordCount, fixtureData.fixture.verification.expectedGeneratedCount);
  const originalSeasonId = committed.result.seasonId;

  const rawSnapshot = await fetchExportSnapshot(
    client,
    userId,
    committed.result.seasonId,
    committed.result.dataVersion,
  );
  const snapshot = materializeSeasonalExportSnapshot(rawSnapshot, {
    seasonId: committed.result.seasonId,
    expectedDataVersion: committed.result.dataVersion,
  });
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.totalCount, snapshot.records.length);
  assert.equal(snapshot.totalCount, fixtureData.fixture.verification.expectedGeneratedCount);
  assert.equal(snapshot.sourceRowCount, fixtureData.fixture.verification.sourceRowCount);

  const canonical = buildCanonicalSeasonalRows({
    records: snapshot.records,
    modifications: snapshot.modifications,
  });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation.issues.slice(0, 10)));
  assert.equal(canonical.effectiveLegs.length, fixtureData.fixture.verification.expectedGeneratedCount);
  const preExportPairResolution = resolveSeasonalPairs(canonical.effectiveLegs);
  const preExportPairDiagnostics = pairDiagnostics(preExportPairResolution);
  const preExportPairingTopology = pairingTopology(canonical.effectiveLegs, preExportPairResolution);
  assertNoDuplicateKeys(canonical.effectiveLegs, `${seasonCode} effective snapshot`);

  const workbookBlob = exportCanonicalSeasonalRowsToExcel(canonical.rows, seasonCode);
  const reparsed = await parseWorkbookBlob(workbookBlob, seasonCode);
  assertNoDuplicateKeys(reparsed.legs, `${seasonCode} exported workbook`);
  assert.equal(reparsed.legs.length, fixtureData.fixture.verification.expectedGeneratedCount);
  assertSignaturesEqual(fixtureSignatures, sortedSignatures(reparsed.legs), `${seasonCode} export`);

  await removeBatchAndSeason(client, userId, staged.result.batchId, originalSeasonId);
  const originalSeasonAfterDelete = await client.query(
    'select count(*)::integer as count from public.seasons where id = $1',
    [originalSeasonId],
  );
  assert.equal(originalSeasonAfterDelete.rows[0].count, 0, `${seasonCode} original season must be deleted before same-code re-import`);
  const reimportAttempt = await prepareSeasonalImportV2Attempt({
    seasonId: null,
    seasonCode,
    expectedDataVersion: 0,
    fileName: `${seasonCode}-roundtrip.xlsx`,
    uploadedAt: 0,
    sourceRows: reparsed.rows,
  });
  const restaged = await stageAttempt(client, userId, reimportAttempt);
  assert.notEqual(restaged.result.batchId, staged.result.batchId, `${seasonCode} re-import must use a separate batch`);
  const stagedTarget = await client.query(
    `select season_id, status, result #>> '{_staging,targetSeasonId}' as target_season_id
     from public.season_import_batches
     where batch_id = $1::uuid`,
    [restaged.result.batchId],
  );
  assert.equal(stagedTarget.rows.length, 1);
  assert.equal(stagedTarget.rows[0].status, 'validated');
  assert.equal(stagedTarget.rows[0].season_id, null);
  assert.equal(typeof stagedTarget.rows[0].target_season_id, 'string');
  assert.ok(stagedTarget.rows[0].target_season_id.length > 0);
  assert.notEqual(stagedTarget.rows[0].target_season_id, originalSeasonId);
  const reimportPreview = await previewBatch(client, restaged.result.batchId);
  assert.equal(reimportPreview.generated_count, fixtureData.fixture.verification.expectedGeneratedCount);
  assert.equal(reimportPreview.duplicate_count, 0);
  assert.equal(reimportPreview.diagnostic_count, 0);
  const databaseSignatures = await previewSignatures(client, restaged.result.batchId);
  assertSignaturesEqual(fixtureSignatures, databaseSignatures, `${seasonCode} preview re-import`);

  const reimportCommitted = await commitBatch(client, userId, restaged.result.batchId, 0);
  const reimportBatch = await client.query(
    `select season_id, status, result #>> '{_staging,targetSeasonId}' as target_season_id
     from public.season_import_batches
     where batch_id = $1::uuid`,
    [restaged.result.batchId],
  );
  assert.equal(reimportBatch.rows.length, 1);
  assert.equal(reimportBatch.rows[0].status, 'committed');
  assert.equal(reimportCommitted.result.seasonId, stagedTarget.rows[0].target_season_id);
  assert.equal(reimportBatch.rows[0].season_id, reimportCommitted.result.seasonId);
  assert.equal(reimportBatch.rows[0].target_season_id, reimportCommitted.result.seasonId);
  assert.notEqual(reimportCommitted.result.seasonId, originalSeasonId);
  assert.equal(reimportCommitted.result.flightRecordCount, fixtureData.fixture.verification.expectedGeneratedCount);

  const targetSeasonState = await client.query(
    `select seasons.id, seasons.total_legs, seasons.total_source_rows, seasons.data_version,
            count(records.record_id) filter (
              where records.source_kind = 'imported' and records.status = 'active'
            )::integer as imported_record_count
     from public.seasons seasons
     left join public.season_flight_records records on records.season_id = seasons.id
     where seasons.id = $1
     group by seasons.id`,
    [reimportCommitted.result.seasonId],
  );
  assert.equal(targetSeasonState.rows.length, 1, `${seasonCode} re-import target season must exist`);
  assert.equal(targetSeasonState.rows[0].total_legs, fixtureData.fixture.verification.expectedGeneratedCount);
  assert.equal(targetSeasonState.rows[0].total_source_rows, reparsed.rows.length);
  assert.equal(targetSeasonState.rows[0].data_version, reimportCommitted.result.dataVersion);
  assert.equal(targetSeasonState.rows[0].imported_record_count, fixtureData.fixture.verification.expectedGeneratedCount);

  const rawReimportSnapshot = await fetchExportSnapshot(
    client,
    userId,
    reimportCommitted.result.seasonId,
    reimportCommitted.result.dataVersion,
  );
  const reimportSnapshot = materializeSeasonalExportSnapshot(rawReimportSnapshot, {
    seasonId: reimportCommitted.result.seasonId,
    expectedDataVersion: reimportCommitted.result.dataVersion,
  });
  assert.equal(reimportSnapshot.truncated, false);
  assert.equal(reimportSnapshot.totalCount, fixtureData.fixture.verification.expectedGeneratedCount);
  assert.equal(reimportSnapshot.sourceRowCount, reparsed.rows.length);
  const reimportEffectiveLegs = materializeEffectiveSeasonalLegs(
    reimportSnapshot.records,
    reimportSnapshot.modifications,
  );
  assert.equal(reimportEffectiveLegs.length, fixtureData.fixture.verification.expectedGeneratedCount);
  assertNoDuplicateKeys(reimportEffectiveLegs, `${seasonCode} authoritative re-import`);
  assertSignaturesEqual(
    sortedSignatures(canonical.effectiveLegs),
    sortedSignatures(reimportEffectiveLegs),
    `${seasonCode} authoritative re-import`,
  );
  const postReimportPairResolution = resolveSeasonalPairs(reimportEffectiveLegs);
  const postReimportPairDiagnostics = pairDiagnostics(postReimportPairResolution);
  const postReimportPairingTopology = pairingTopology(reimportEffectiveLegs, postReimportPairResolution);
  assert.deepEqual(
    postReimportPairDiagnostics,
    preExportPairDiagnostics,
    `${seasonCode} re-import pair diagnostics changed`,
  );
  assert.deepEqual(
    postReimportPairingTopology.pairSignatures,
    preExportPairingTopology.pairSignatures,
    `${seasonCode} re-import pair signatures changed`,
  );
  assert.deepEqual(
    postReimportPairingTopology.pairTurnaroundCardinality,
    preExportPairingTopology.pairTurnaroundCardinality,
    `${seasonCode} re-import turnaround cardinality changed`,
  );
  assert.equal(
    postReimportPairingTopology.turnaroundGroupCount,
    preExportPairingTopology.turnaroundGroupCount,
    `${seasonCode} re-import turnaround group count changed`,
  );

  await removeBatchAndSeason(
    client,
    userId,
    restaged.result.batchId,
    reimportCommitted.result.seasonId,
  );

  return {
    seasonCode,
    sourceBasename: fixtureData.fixture.source.basename,
    sourceSha256: fixtureData.fixture.source.sha256,
    sourceRowsSha256: fixtureData.fixture.verification.sourceRowsSha256,
    coverage: fixtureData.fixture.verification.coverage,
    sourceRowCount: fixtureData.sourceRows.length,
    generatedCount: fixtureData.fixture.verification.expectedGeneratedCount,
    exportSourceRowCount: canonical.rows.length,
    workbookBytes: reparsed.bytes.length,
    originalSeasonId,
    reimportSeasonId: reimportCommitted.result.seasonId,
    initialBatchId: staged.result.batchId,
    reimportBatchId: restaged.result.batchId,
    reimportLifecycle: 'original-deleted-before-distinct-same-code-reimport',
    targetSeasonVerifiedBeforeCleanup: true,
    signaturesMatched: true,
    duplicateCount: 0,
    unresolvedPairCount: postReimportPairDiagnostics.unresolvedPairCount,
    ambiguousPairCount: postReimportPairDiagnostics.ambiguousPairCount,
    nonReciprocalPairCount: postReimportPairDiagnostics.nonReciprocalPairCount,
    missingCounterpartCount: postReimportPairDiagnostics.missingCounterpartCount,
    pairCount: postReimportPairResolution.pairs.length,
    turnaroundGroupCount: postReimportPairingTopology.turnaroundGroupCount,
    pairSignaturesMatched: true,
    turnaroundCardinalityMatched: true,
    truncated: false,
  };
}

export async function runRoundTripTest() {
  const { client, databaseName, engine } = await connectTestDatabase('seasonal-task11-roundtrip');
  let principals;
  try {
    principals = await createTestPrincipals(client);
    const results = [];
    for (const seasonCode of ['S26', 'W26']) {
      results.push(await verifySeasonRoundTrip(client, principals.primaryUserId, seasonCode));
    }
    const remainingCommitted = await authenticatedQuery(
      client,
      principals.primaryUserId,
      `select count(*)::integer as count
       from public.seasons
       where season_code in ('S26', 'W26')`,
    );
    assert.equal(remainingCommitted.rows[0].count, 0, 'round-trip must not leave committed fixture seasons');
    const output = {
      databaseName,
      databaseEngine: engine.split('\n')[0],
      seasons: results,
    };
    console.log(JSON.stringify(output));
    return output;
  } finally {
    if (principals) await cleanupTestPrincipals(client, [principals.primaryUserId, principals.secondaryUserId]);
    await client.end();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await runRoundTripTest();
