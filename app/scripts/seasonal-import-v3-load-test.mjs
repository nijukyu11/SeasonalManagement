import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Let Node report the original resolution error.
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  parseSeasonalImportV3CancelResult,
  parseSeasonalImportV3CommittedResult,
  parseSeasonalImportV3StageResult,
  parseSeasonalImportV3StatusResult,
  prepareSeasonalImportV3Attempt,
} = await import('../src/lib/seasonalImportV3Contract.ts');
const {
  cleanupTestPrincipals,
  connectTestDatabase,
  createTestPrincipals,
  loadVerifiedFixture,
  runWithCleanupAndClose,
} = await import('./seasonal-import-v2-load-test.mjs');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MERGE_STAGE_P95_MS = 2_000;
const MERGE_STAGE_MAX_MS = 4_000;
const MERGE_COMMIT_P95_MS = 2_000;
const MERGE_COMMIT_MAX_MS = 4_000;
const AUTHENTICATED_TIMEOUT_MS = 8_000;
const PERFORMANCE_RUNS = 5;

function sourceRow(rowIndex, occurrenceDates, sides = 'both', flightOffset = 0) {
  const lastDate = new Date(`${occurrenceDates[0]}T00:00:00Z`);
  lastDate.setUTCDate(lastDate.getUTCDate() + ((occurrenceDates[1] - 1) * 7));
  const discontinue = lastDate.toISOString().slice(0, 10);
  const suffix = String(rowIndex + flightOffset).padStart(3, '0');
  const arrival = sides === 'both' || sides === 'arrival';
  const departure = sides === 'both' || sides === 'departure';
  return {
    rowIndex,
    effective: occurrenceDates[0],
    discontinue,
    airline: 'VN',
    aircraft: '321',
    daysOfWeek: [true, false, false, false, false, false, false],
    sta: arrival ? '07:05' : null,
    arrFlight: arrival ? `1${suffix}` : null,
    arrFlightType: arrival ? 'PAX' : null,
    arrRoute: arrival ? 'KIX' : null,
    arrFlightCategory: arrival ? 'J' : null,
    arrCodeShares: null,
    arrIntDomInd: arrival ? 'I' : null,
    std: departure ? '09:10' : null,
    depFlight: departure ? `2${suffix}` : null,
    depFlightType: departure ? 'PAX' : null,
    depRoute: departure ? 'KIX' : null,
    depFlightCategory: departure ? 'J' : null,
    depCodeShares: null,
    depIntDomInd: departure ? 'I' : null,
    overnightLinkRowIndex: null,
    linkType: null,
  };
}

function book3SizedRows(flightOffset = 0) {
  return [
    ...Array.from({ length: 8 }, (_, index) =>
      sourceRow(index + 1, ['2026-01-05', 5], 'both', flightOffset)),
    sourceRow(9, ['2026-01-05', 4], 'both', flightOffset),
    sourceRow(10, ['2026-01-05', 5], 'arrival', flightOffset),
    sourceRow(11, ['2026-01-05', 5], 'arrival', flightOffset),
  ];
}

function oneOccurrenceRow(rowIndex, flightOffset) {
  return sourceRow(rowIndex, ['2026-01-05', 1], 'arrival', flightOffset);
}

async function authenticatedQuery(client, userId, text, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("set local statement_timeout = '8s'");
    await client.query(
      "select pg_catalog.set_config('request.jwt.claim.sub', $1, true)",
      [userId],
    );
    const result = await client.query(text, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    if (error?.code === '57014') {
      throw new Error('Seasonal Import V3 returned forbidden SQLSTATE 57014.', {
        cause: error,
      });
    }
    throw error;
  }
}

async function stage(client, userId, attempt) {
  const startedAt = performance.now();
  const response = await authenticatedQuery(
    client,
    userId,
    'select public.stage_seasonal_import_v3($1::jsonb) as result',
    [JSON.stringify(attempt)],
  );
  return {
    result: parseSeasonalImportV3StageResult(response.rows[0]?.result),
    durationMs: performance.now() - startedAt,
  };
}

async function commit(client, userId, preview) {
  const startedAt = performance.now();
  const response = await authenticatedQuery(
    client,
    userId,
    'select public.commit_seasonal_import_v3($1::uuid, $2::integer, $3::text) as result',
    [preview.batchId, preview.expectedDataVersion, preview.previewHash],
  );
  return {
    result: parseSeasonalImportV3CommittedResult(response.rows[0]?.result),
    durationMs: performance.now() - startedAt,
  };
}

async function status(client, userId, requestId) {
  const response = await authenticatedQuery(
    client,
    userId,
    'select public.get_seasonal_import_v3_status($1::uuid) as result',
    [requestId],
  );
  return parseSeasonalImportV3StatusResult(response.rows[0]?.result);
}

async function cancel(client, userId, batchId) {
  const response = await authenticatedQuery(
    client,
    userId,
    'select public.cancel_seasonal_import_v3($1::uuid) as result',
    [batchId],
  );
  return parseSeasonalImportV3CancelResult(response.rows[0]?.result);
}

function percentile95(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function metric(samples) {
  return {
    runs: samples.length,
    p95Ms: Number(percentile95(samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

function sqlState(error) {
  return typeof error?.code === 'string'
    ? error.code
    : typeof error?.cause?.code === 'string'
      ? error.cause.code
      : '';
}

async function expectSqlState(operation, expected, label) {
  await assert.rejects(operation, (error) => {
    assert.ok(
      expected.includes(sqlState(error)),
      `${label}: expected ${expected.join('/')}, got ${sqlState(error) || error}`,
    );
    return true;
  });
}

async function currentVersion(client, seasonId) {
  const result = await client.query(
    'select data_version from public.seasons where id = $1',
    [seasonId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0].data_version;
}

async function prepareExisting(seasonId, seasonCode, dataVersion, rows, strategy = 'merge') {
  return prepareSeasonalImportV3Attempt({
    seasonId,
    seasonCode,
    expectedDataVersion: dataVersion,
    strategy,
    fileName: `${seasonCode}-${strategy}-load.xlsx`,
    uploadedAt: 0,
    sourceRows: rows,
  });
}

async function runPerformance(client, userId) {
  const stageDurations = [];
  const commitDurations = [];
  let seasonId = null;
  let dataVersion = 0;
  const seasonCode = 'S98';
  const rows = book3SizedRows();

  for (let index = 0; index < PERFORMANCE_RUNS; index += 1) {
    const attempt = await prepareExisting(seasonId, seasonCode, dataVersion, rows);
    const staged = await stage(client, userId, attempt);
    assert.equal(staged.result.valid, true, JSON.stringify(staged.result.diagnostics));
    assert.equal(staged.result.counts.sourceRowCount, 11);
    assert.equal(staged.result.counts.generatedOccurrenceCount, 98);
    assert.equal(staged.result.counts.removeImportedCount, 0);
    assert.equal(staged.result.counts.clearStructuralOverlayCount, 0);
    assert.equal(staged.result.counts.clearDeletedOverlayCount, 0);
    const committed = await commit(client, userId, staged.result);
    seasonId = committed.result.seasonId;
    dataVersion = committed.result.dataVersion;
    stageDurations.push(staged.durationMs);
    commitDurations.push(committed.durationMs);
  }

  const fixture = await loadVerifiedFixture('W26');
  const replaceAttempt = await prepareExisting(
    seasonId,
    seasonCode,
    dataVersion,
    fixture.sourceRows,
    'replace',
  );
  const replaceStage = await stage(client, userId, replaceAttempt);
  assert.equal(replaceStage.result.valid, true, JSON.stringify(replaceStage.result.diagnostics));
  const replaceCommit = await commit(client, userId, replaceStage.result);
  dataVersion = replaceCommit.result.dataVersion;

  const fullBaselineAttempt = await prepareExisting(
    seasonId,
    seasonCode,
    dataVersion,
    fixture.sourceRows,
    'merge',
  );
  const fullBaselineStage = await stage(client, userId, fullBaselineAttempt);
  assert.equal(fullBaselineStage.result.valid, true, JSON.stringify(fullBaselineStage.result.diagnostics));
  await cancel(client, userId, fullBaselineStage.result.batchId);

  const stageMetric = metric(stageDurations);
  const commitMetric = metric(commitDurations);
  assert.ok(stageMetric.p95Ms < MERGE_STAGE_P95_MS, `merge stage p95 ${stageMetric.p95Ms} ms`);
  assert.ok(stageMetric.maxMs < MERGE_STAGE_MAX_MS, `merge stage max ${stageMetric.maxMs} ms`);
  assert.ok(commitMetric.p95Ms < MERGE_COMMIT_P95_MS, `merge commit p95 ${commitMetric.p95Ms} ms`);
  assert.ok(commitMetric.maxMs < MERGE_COMMIT_MAX_MS, `merge commit max ${commitMetric.maxMs} ms`);
  assert.ok(replaceStage.durationMs < AUTHENTICATED_TIMEOUT_MS);
  assert.ok(replaceCommit.durationMs < AUTHENTICATED_TIMEOUT_MS);
  assert.ok(fullBaselineStage.durationMs < AUTHENTICATED_TIMEOUT_MS);

  return {
    seasonId,
    seasonCode,
    dataVersion,
    generatedOccurrenceCount: 98,
    mergeStage: stageMetric,
    mergeCommit: commitMetric,
    fullReplace: {
      sourceRowCount: fixture.sourceRows.length,
      generatedOccurrenceCount: replaceStage.result.counts.generatedOccurrenceCount,
      stageMs: Number(replaceStage.durationMs.toFixed(2)),
      commitMs: Number(replaceCommit.durationMs.toFixed(2)),
      restageAgainstFullBaselineMs: Number(fullBaselineStage.durationMs.toFixed(2)),
    },
    sqlState57014Count: 0,
  };
}

async function runConcurrency(client, secondClient, principals) {
  const { primaryUserId, secondaryUserId } = principals;
  const initialAttempt = await prepareSeasonalImportV3Attempt({
    seasonId: null,
    seasonCode: 'S97',
    expectedDataVersion: 0,
    strategy: 'merge',
    fileName: 'S97-concurrency.xlsx',
    uploadedAt: 0,
    sourceRows: book3SizedRows(100),
  });
  const initialStage = await stage(client, primaryUserId, initialAttempt);
  const initialCommit = await commit(client, primaryUserId, initialStage.result);
  let seasonId = initialCommit.result.seasonId;
  let dataVersion = initialCommit.result.dataVersion;

  const sameAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    book3SizedRows(100),
  );
  const sameStage = await stage(client, primaryUserId, sameAttempt);
  const sameResults = await Promise.all([
    commit(client, primaryUserId, sameStage.result),
    commit(secondClient, primaryUserId, sameStage.result),
  ]);
  assert.deepEqual(sameResults[0].result, sameResults[1].result);
  const eventCount = await client.query(
    'select count(*)::integer as count from public.season_change_events where op_id = $1',
    [sameStage.result.batchId],
  );
  assert.equal(eventCount.rows[0].count, 1);
  dataVersion = sameResults[0].result.dataVersion;

  const leftAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    [oneOccurrenceRow(1, 400)],
  );
  const rightAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    [oneOccurrenceRow(1, 500)],
  );
  const [leftStage, rightStage] = await Promise.all([
    stage(client, primaryUserId, leftAttempt),
    stage(secondClient, primaryUserId, rightAttempt),
  ]);
  const competing = await Promise.allSettled([
    commit(client, primaryUserId, leftStage.result),
    commit(secondClient, primaryUserId, rightStage.result),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(sqlState(competing.find((result) => result.status === 'rejected').reason), '40001');
  dataVersion = await currentVersion(client, seasonId);

  const fencedAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    [oneOccurrenceRow(1, 600)],
  );
  const fencedStage = await stage(client, primaryUserId, fencedAttempt);
  await secondClient.query('begin');
  await secondClient.query('select id from public.seasons where id = $1 for update', [seasonId]);
  await secondClient.query(
    'update public.seasons set data_version = data_version + 1 where id = $1',
    [seasonId],
  );
  const fencedCommitPromise = commit(client, primaryUserId, fencedStage.result);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await secondClient.query('commit');
  await expectSqlState(() => fencedCommitPromise, ['40001'], 'season mutation fence');
  dataVersion = await currentVersion(client, seasonId);

  const raceAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    [oneOccurrenceRow(1, 700)],
  );
  const raceStage = await stage(client, primaryUserId, raceAttempt);
  const race = await Promise.allSettled([
    commit(client, primaryUserId, raceStage.result),
    cancel(secondClient, primaryUserId, raceStage.result.batchId),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  const terminal = await status(client, primaryUserId, raceStage.result.requestId);
  assert.ok(['committed', 'cancelled'].includes(terminal.status));
  if (terminal.status === 'committed') dataVersion = terminal.dataVersion;

  const ownedAttempt = await prepareExisting(
    seasonId,
    'S97',
    dataVersion,
    [oneOccurrenceRow(1, 800)],
  );
  const ownedStage = await stage(client, primaryUserId, ownedAttempt);
  await expectSqlState(
    () => status(secondClient, secondaryUserId, ownedStage.result.requestId),
    ['42501'],
    'cross-owner status',
  );
  await expectSqlState(
    () => cancel(secondClient, secondaryUserId, ownedStage.result.batchId),
    ['42501'],
    'cross-owner cancel',
  );
  await expectSqlState(
    () => commit(secondClient, secondaryUserId, ownedStage.result),
    ['42501'],
    'cross-owner commit',
  );
  await cancel(client, primaryUserId, ownedStage.result.batchId);

  return {
    sameBatchEventCount: 1,
    competingPreviewCommitCount: 1,
    seasonMutationFence: '40001',
    cancelCommitTerminalStatus: terminal.status,
    ownerIsolation: ['status:42501', 'cancel:42501', 'commit:42501'],
  };
}

async function runFaults(client, userId) {
  const beforeStage = await prepareSeasonalImportV3Attempt({
    seasonId: null,
    seasonCode: 'S96',
    expectedDataVersion: 0,
    strategy: 'merge',
    fileName: 'fault-before-stage.xlsx',
    uploadedAt: 0,
    sourceRows: [oneOccurrenceRow(1, 900)],
  });
  const beforeStageCount = await client.query(
    'select count(*)::integer as count from public.season_import_batches where request_id = $1',
    [beforeStage.requestId],
  );
  assert.equal(beforeStageCount.rows[0].count, 0);

  const afterStage = await stage(client, userId, beforeStage);
  const recoveredStage = await status(client, userId, afterStage.result.requestId);
  assert.equal(recoveredStage.status, 'validated');

  const beforeCommitStatus = await status(client, userId, afterStage.result.requestId);
  assert.equal(beforeCommitStatus.status, 'validated');
  const committed = await commit(client, userId, afterStage.result);
  const recoveredCommit = await status(client, userId, afterStage.result.requestId);
  assert.equal(recoveredCommit.status, 'committed');
  const idempotentCommit = await commit(client, userId, afterStage.result);
  assert.deepEqual(idempotentCommit.result, committed.result);

  const injectedStatusFailure = new Error('injected status transport failure');
  await assert.rejects(
    async () => {
      throw injectedStatusFailure;
    },
    /injected status transport failure/,
  );
  const statusAfterFailure = await status(client, userId, afterStage.result.requestId);
  assert.equal(statusAfterFailure.status, 'committed');

  const pageSource = await readFile(
    path.join(SCRIPT_DIR, '..', 'src', 'app', 'SeasonalSchedulePage.tsx'),
    'utf8',
  );
  const stageStart = pageSource.indexOf('const stagePreparedSeasonalImport');
  const stageEnd = pageSource.indexOf('const handleFile =', stageStart);
  const stageSource = pageSource.slice(stageStart, stageEnd);
  assert.ok(stageStart >= 0 && stageEnd > stageStart);
  assert.doesNotMatch(stageSource, /applySeasonalImportRemote|stage_seasonal_import_v2|SQLite|native/i);

  return {
    beforeStage: 'no-batch',
    afterStageResponseLost: recoveredStage.status,
    beforeCommit: beforeCommitStatus.status,
    commitResponseLost: recoveredCommit.status,
    afterCommitBeforeRefresh: 'committed-refresh-pending',
    statusTransportFailure: statusAfterFailure.status,
    duplicateCommitCount: 0,
    v2OrSqliteFallbackCount: 0,
  };
}

async function run(mode) {
  assert.ok(['load', 'concurrency', 'all'].includes(mode), `Unsupported --mode ${mode}`);
  const { client, databaseName, engine } = await connectTestDatabase(
    `seasonal-import-v3-${mode}`,
  );
  const second = await connectTestDatabase(`seasonal-import-v3-${mode}-second`);
  let principals;
  return runWithCleanupAndClose({
    run: async () => {
      principals = await createTestPrincipals(client);
      const output = {
        suite: `seasonal-import-v3-${mode}`,
        databaseName,
        databaseEngine: engine.split('\n')[0],
        authenticatedStatementTimeoutMs: AUTHENTICATED_TIMEOUT_MS,
      };
      if (mode === 'load' || mode === 'all') {
        output.performance = await runPerformance(client, principals.primaryUserId);
        output.faults = await runFaults(client, principals.primaryUserId);
      }
      if (mode === 'concurrency' || mode === 'all') {
        output.concurrency = await runConcurrency(
          client,
          second.client,
          principals,
        );
      }
      console.log(JSON.stringify(output));
      return output;
    },
    cleanup: async () => {
      try {
        if (principals) {
          await client.query(
            `delete from public.season_import_batch_preimages_v3
             where batch_id in (
               select batch_id
               from public.season_import_batches
               where created_by = any($1::uuid[])
             )`,
            [[principals.primaryUserId, principals.secondaryUserId]],
          );
          await cleanupTestPrincipals(
            client,
            [principals.primaryUserId, principals.secondaryUserId],
          );
        }
      } finally {
        await second.client.end();
      }
    },
    close: () => client.end(),
  });
}

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'load';
await run(mode);
