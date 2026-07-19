import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import * as XLSX from 'xlsx';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Let Node report the original resolution error below.
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  cleanFlightNumber,
  expandToFlightLegs,
  parseSeasonalSchedule,
} = await import('../src/lib/parser.ts');
const {
  buildCanonicalSeasonalRows,
  exportCanonicalSeasonalRowsToExcel,
} = await import('../src/lib/canonicalSeasonalRows.ts');
const {
  parseDailyImportDateTime,
  parseDailyImportWorksheet,
  partitionDailyImportRowsByIataSeason,
} = await import('../src/lib/dailyScheduleImport.ts');
const {
  SeasonalImportV2StatusUnknownError,
  buildSeasonalImportCommittedRefreshFailure,
  canonicalizeSeasonalImportSourceRows,
  parseSeasonalImportV2Result,
  parseSeasonalImportV2StageResult,
  prepareSeasonalImportV2Attempt,
  runSeasonalImportV2RpcFlow,
} = await import('../src/lib/seasonalImportRpcContract.ts');
const {
  SEASONAL_IMPORT_RECOVERY_STORAGE_KEY,
  buildSeasonalImportRecoveryReceipt,
  committedSeasonalImportFromRecoveryReceipt,
  loadSeasonalImportRecoveryReceipt,
  markSeasonalImportRecoveryCommitted,
  persistSeasonalImportRecoveryReceipt,
} = await import('../src/lib/seasonalImportReceipt.ts');
const { loadTargetedCommittedImportRefresh } = await import('../src/lib/seasonalImportRecovery.ts');
const { materializeSeasonalExportSnapshot } = await import('../src/lib/seasonalExportSnapshot.ts');
const { fromSeasonRow } = await import('../src/lib/supabaseRelationalMappers.ts');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(SCRIPT_DIR, 'fixtures');
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const DISPOSABLE_DATABASE_PATTERN = /^seasonal_task11_[a-z0-9_]+$/;
const FIXTURE_FILES = Object.freeze({
  S26: path.join(FIXTURE_DIR, 'seasonal-s26-source.json'),
  W26: path.join(FIXTURE_DIR, 'seasonal-w26-source.json'),
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function upperText(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || null;
}

function parseDetailedFlightIdentity(value) {
  const compact = upperText(value)?.replace(/\s+/g, '') ?? '';
  if (!compact) return null;
  const iataMatch = /^([A-Z0-9]{2})([0-9].*)$/.exec(compact);
  const match = iataMatch && /[A-Z]/.test(iataMatch[1])
    ? iataMatch
    : /^([A-Z]+)([0-9].*)$/.exec(compact);
  if (!match) return null;
  const cleaned = cleanFlightNumber(match[1], match[2]);
  return cleaned ? { airline: match[1], ...cleaned } : null;
}

function detailedRecord(row, side, sourceRowIndex) {
  const prefix = side === 'A' ? 'ARR' : 'DEP';
  const identity = parseDetailedFlightIdentity(row[`${prefix}-AIRLINE_FLIGHT_SUFFIX`]);
  const scheduled = parseDailyImportDateTime(row[`${prefix}-Scheduled`]);
  if (!identity || !scheduled?.date) return null;
  const id = `FIXTURE_${sourceRowIndex}_${side}`;
  return {
    id,
    linkId: id,
    type: side,
    airline: identity.airline,
    flightNumber: identity.flightNumber,
    rawFlightNumber: identity.rawFlightNumber,
    requestStatusCode: null,
    route: upperText(row[`${prefix}-ORIG_DEST_AIRPORT_CODE`]) ?? '',
    schedule: scheduled.time,
    scheduledDate: scheduled.date,
    scheduledTime: scheduled.time,
    operationalDate: scheduled.date,
    iataSeasonCode: 'W26',
    flightSeriesId: id,
    aircraft: upperText(row.AIRCRAFT_SERIES) ?? '',
    category: upperText(row[`${prefix}-FlightCategory`]) ?? 'J',
    flightType: upperText(row[`${prefix}-FlightType`]) ?? 'PAX',
    codeShares: upperText(row[`${prefix}-CODESHARES`]),
    intDomInd: null,
    pax: null,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: scheduled.date,
    dayOfWeek: new Date(`${scheduled.date}T00:00:00Z`).getUTCDay(),
    action: null,
    sourceRowIndex,
    sourceKind: 'imported',
    sourceSide: side === 'A' ? 'ARR' : 'DEP',
    status: 'active',
  };
}

export function occurrenceKey(leg) {
  return [leg.type, leg.date, leg.airline, leg.flightNumber].join('|');
}

export function occurrenceSignature(leg) {
  return [
    leg.type,
    leg.date,
    leg.airline,
    leg.flightNumber,
    leg.route,
    leg.schedule,
    leg.aircraft,
    leg.category,
    leg.codeShares ?? '',
    leg.intDomInd ?? '',
  ].join('|');
}

function duplicateOccurrenceCount(legs) {
  const counts = new Map();
  for (const leg of legs) counts.set(occurrenceKey(leg), (counts.get(occurrenceKey(leg)) ?? 0) + 1);
  return Array.from(counts.values()).reduce((total, count) => total + Math.max(0, count - 1), 0);
}

async function strictParseCanonicalWorkbook(buffer, expectedSeasonCode) {
  const parsed = parseSeasonalSchedule(XLSX.read(buffer, { type: 'buffer', cellDates: false }));
  assert.equal(parsed.seasonCode, expectedSeasonCode, 'fixture worksheet season code mismatch');
  assert.deepEqual(parsed.issues, [], `fixture parser issues: ${JSON.stringify(parsed.issues.slice(0, 10))}`);
  return canonicalizeSeasonalImportSourceRows(parsed.rows);
}

async function strictRoundTripSourceRows(sourceRows, seasonCode) {
  const blob = exportCanonicalSeasonalRowsToExcel(sourceRows, seasonCode);
  const reparsed = await strictParseCanonicalWorkbook(Buffer.from(await blob.arrayBuffer()), seasonCode);
  assert.deepEqual(reparsed, sourceRows, `${seasonCode} source rows changed during strict workbook round-trip`);
}

export async function deriveDetailedSourceRows(buffer, manifest) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const detailedRows = parseDailyImportWorksheet(workbook.Sheets[workbook.SheetNames[0]]);
  assert.equal(detailedRows.length, manifest.source.detailedRowCount, 'detailed source row count changed');
  const seasonBatches = partitionDailyImportRowsByIataSeason(detailedRows);
  const w26Batch = seasonBatches.find((batch) => batch.seasonCode === manifest.seasonCode);
  assert.ok(w26Batch, `detailed workbook contains no ${manifest.seasonCode} rows`);
  assert.equal(w26Batch.legCount, manifest.verification.expectedGeneratedCount, 'detailed W26 leg count changed');

  const records = [];
  w26Batch.rows.forEach((row, index) => {
    const sourceRowIndex = index + 1;
    const arrival = detailedRecord(row, 'A', sourceRowIndex);
    const departure = detailedRecord(row, 'D', sourceRowIndex);
    if (arrival) records.push(arrival);
    if (departure) records.push(departure);
    if (!arrival || !departure) return;
    const linkType = departure.date > arrival.date ? 'overnight' : 'sameday';
    const turnaroundId = `FIXTURE_PAIR_${sourceRowIndex}`;
    Object.assign(arrival, {
      linkId: turnaroundId,
      turnaroundId,
      linkedRecordId: departure.id,
      linkType,
      pairAnchorDate: arrival.date,
    });
    Object.assign(departure, {
      linkId: turnaroundId,
      turnaroundId,
      linkedRecordId: arrival.id,
      linkType,
      pairAnchorDate: arrival.date,
    });
  });
  assert.equal(records.length, manifest.verification.expectedGeneratedCount, 'derived detailed occurrence count changed');
  const canonical = buildCanonicalSeasonalRows({ records, modifications: new Map() });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation.issues.slice(0, 10)));
  const workbookBlob = exportCanonicalSeasonalRowsToExcel(canonical.rows, manifest.seasonCode);
  return strictParseCanonicalWorkbook(
    Buffer.from(await workbookBlob.arrayBuffer()),
    manifest.seasonCode,
  );
}

function fixtureEnvironmentName(seasonCode) {
  return `SEASONAL_${seasonCode}_FIXTURE`;
}

export async function loadVerifiedFixture(seasonCode) {
  const fixturePath = FIXTURE_FILES[seasonCode];
  if (!fixturePath) throw new Error(`Unsupported fixture season ${seasonCode}`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.seasonCode, seasonCode);
  assert.ok(Array.isArray(fixture.sourceRows) && fixture.sourceRows.length > 0, 'fixture sourceRows must be non-empty');
  const sourceRows = canonicalizeSeasonalImportSourceRows(fixture.sourceRows);
  assert.equal(sourceRows.length, fixture.verification.sourceRowCount, 'fixture source row count mismatch');
  assert.equal(sha256(JSON.stringify(sourceRows)), fixture.verification.sourceRowsSha256, 'fixture source row hash mismatch');

  const overridePath = process.env[fixtureEnvironmentName(seasonCode)];
  if (overridePath) {
    const workbookBytes = fs.readFileSync(path.resolve(overridePath));
    const expectedHash = process.env[`SEASONAL_${seasonCode}_EXPECTED_SHA256`] ?? fixture.source.sha256;
    assert.equal(sha256(workbookBytes), expectedHash, `${seasonCode} override workbook SHA256 mismatch`);
    const derived = fixture.derivation.id === 'daily-detailed-to-canonical-v1'
      ? await deriveDetailedSourceRows(workbookBytes, fixture)
      : await strictParseCanonicalWorkbook(workbookBytes, seasonCode);
    assert.deepEqual(derived, sourceRows, `${seasonCode} override workbook does not reproduce the committed fixture`);
  }

  await strictRoundTripSourceRows(sourceRows, seasonCode);
  const parseStartedAt = performance.now();
  const legs = expandToFlightLegs(sourceRows);
  const parseDurationMs = performance.now() - parseStartedAt;
  const duplicateCount = duplicateOccurrenceCount(legs);
  assert.equal(legs.length, fixture.verification.expectedGeneratedCount, 'fixture generated count mismatch');
  assert.equal(duplicateCount, fixture.verification.duplicateOccurrenceCount, 'fixture duplicate count mismatch');
  assert.equal(duplicateCount, 0, `${seasonCode} fixture contains duplicate occurrence keys`);
  const coverage = {
    start: sourceRows.map((row) => row.effective).sort()[0],
    end: sourceRows.map((row) => row.discontinue).sort().at(-1),
  };
  assert.deepEqual(coverage, fixture.verification.coverage, 'fixture coverage mismatch');
  return { fixture, fixturePath, sourceRows, legs, duplicateCount, parseDurationMs };
}

function requireDatabaseUrl() {
  const connectionString = process.env.SEASONAL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('SEASONAL_TEST_DATABASE_URL is required');
  if (process.env.SEASONAL_TEST_TEMP_DB !== '1') {
    throw new Error('Refusing to run without SEASONAL_TEST_TEMP_DB=1');
  }
  const parsed = new URL(connectionString);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) {
    throw new Error(`Refusing non-Task11 database name ${databaseName || '<empty>'}`);
  }
  return { connectionString, databaseName };
}

export async function connectTestDatabase(applicationName) {
  const { connectionString, databaseName } = requireDatabaseUrl();
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
  });
  await client.connect();
  const identity = await client.query('select current_database() as database_name, version() as engine');
  assert.equal(identity.rows[0]?.database_name, databaseName, 'connected database differs from URL');
  return { client, databaseName, engine: String(identity.rows[0]?.engine ?? 'PostgreSQL') };
}

export async function authenticatedQuery(client, userId, text, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("select pg_catalog.set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await client.query(text, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function createTestPrincipals(client) {
  const primaryUserId = randomUUID();
  const secondaryUserId = randomUUID();
  for (const [userId, label] of [[primaryUserId, 'primary'], [secondaryUserId, 'secondary']]) {
    const email = `seasonal-task11-${label}-${userId}@example.invalid`;
    await client.query(
      `insert into auth.users (
         id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at
       ) values ($1, 'authenticated', 'authenticated', $2, '', now(),
         '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [userId, email],
    );
    await client.query(
      `insert into public.app_operators (user_id, email, username, display_name)
       values ($1, $2, $3, $4)`,
      [userId, email, `task11_${label}_${userId.replaceAll('-', '')}`, `Task 11 ${label}`],
    );
    for (const permission of ['seasonal.write', 'seasonal.read', 'season.repair']) {
      await client.query(
        `insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
         values ($1, $2, 'allow')`,
        [userId, permission],
      );
    }
  }
  return { primaryUserId, secondaryUserId };
}

export async function stageAttempt(client, userId, attempt) {
  const startedAt = performance.now();
  try {
    const result = await authenticatedQuery(
      client,
      userId,
      'select public.stage_seasonal_import_v2($1::jsonb) as result',
      [JSON.stringify(attempt)],
    );
    return { result: parseSeasonalImportV2StageResult(result.rows[0]?.result), durationMs: performance.now() - startedAt };
  } catch (error) {
    if (error?.code === '57014') throw new Error('Seasonal stage returned forbidden SQLSTATE 57014', { cause: error });
    throw error;
  }
}

export async function previewBatch(client, batchId) {
  const startedAt = performance.now();
  try {
    const result = await client.query(
      `select
         count(*) filter (where item_kind = 'record')::integer as generated_count,
         count(*) filter (where item_kind = 'diagnostic')::integer as diagnostic_count,
         (count(*) filter (where item_kind = 'record')
           - count(distinct occurrence_key) filter (where item_kind = 'record'))::integer as duplicate_count
       from public.seasonal_import_atomic_preview_v2($1::uuid)`,
      [batchId],
    );
    return { ...result.rows[0], durationMs: performance.now() - startedAt };
  } catch (error) {
    if (error?.code === '57014') throw new Error('Seasonal preview returned forbidden SQLSTATE 57014', { cause: error });
    throw error;
  }
}

export async function previewSignatures(client, batchId) {
  const result = await client.query(
    `select type, scheduled_date, airline, flight_number, route, schedule,
            aircraft, category, code_shares, int_dom_ind
     from public.seasonal_import_atomic_preview_v2($1::uuid)
     where item_kind = 'record'
     order by occurrence_key, route, schedule, aircraft, category, code_shares, int_dom_ind`,
    [batchId],
  );
  return result.rows.map((row) => [
    row.type,
    row.scheduled_date,
    row.airline,
    row.flight_number,
    row.route,
    row.schedule,
    row.aircraft,
    row.category,
    row.code_shares ?? '',
    row.int_dom_ind ?? '',
  ].join('|')).sort();
}

export async function commitBatch(client, userId, batchId, expectedDataVersion) {
  const startedAt = performance.now();
  try {
    const result = await authenticatedQuery(
      client,
      userId,
      'select public.commit_seasonal_import_v2($1::uuid, $2::integer) as result',
      [batchId, expectedDataVersion],
    );
    return { result: parseSeasonalImportV2Result(result.rows[0]?.result), durationMs: performance.now() - startedAt };
  } catch (error) {
    if (error?.code === '57014') throw new Error('Seasonal commit returned forbidden SQLSTATE 57014', { cause: error });
    throw error;
  }
}

export async function fetchExportSnapshot(client, userId, seasonId, dataVersion) {
  const result = await authenticatedQuery(
    client,
    userId,
    'select public.get_seasonal_export_snapshot_v2($1::text, $2::integer) as result',
    [seasonId, dataVersion],
  );
  return result.rows[0]?.result;
}

async function loadAuthoritativeSeasons(client, userId) {
  const result = await authenticatedQuery(
    client,
    userId,
    `select id, season_code, name, file_name, uploaded_at, effective_start,
            effective_end, total_legs, total_source_rows, data_version, last_synced_at
     from public.seasons
     order by uploaded_at desc, id`,
  );
  return result.rows.map(fromSeasonRow);
}

export async function removeBatchAndSeason(client, userId, batchId, seasonId) {
  if (batchId) await client.query('delete from public.season_import_batches where batch_id = $1::uuid', [batchId]);
  if (seasonId) {
    await authenticatedQuery(
      client,
      userId,
      "select public.manage_season_metadata_v2('delete', $1, '{}'::jsonb)",
      [seasonId],
    );
  }
}

export async function cleanupTestPrincipals(client, userIds) {
  const seasonRows = await client.query(
    `select distinct season_id
     from public.season_import_batches
     where created_by = any($1::uuid[]) and season_id is not null`,
    [userIds],
  );
  await client.query('delete from public.season_import_batches where created_by = any($1::uuid[])', [userIds]);
  const seasonIds = seasonRows.rows.map((row) => row.season_id);
  for (const seasonId of seasonIds) {
    await authenticatedQuery(
      client,
      userIds[0],
      "select public.manage_season_metadata_v2('delete', $1, '{}'::jsonb)",
      [seasonId],
    );
  }
  await client.query('delete from public.app_operator_permission_overrides where user_id = any($1::uuid[])', [userIds]);
  await client.query('delete from public.app_operators where user_id = any($1::uuid[])', [userIds]);
  await client.query('delete from auth.users where id = any($1::uuid[])', [userIds]);
}

function sqlState(error) {
  return typeof error?.code === 'string' ? error.code : '';
}

async function expectSqlState(operation, expected, label) {
  await assert.rejects(operation, (error) => {
    assert.ok(expected.includes(sqlState(error)), `${label}: expected ${expected.join('/')}, got ${sqlState(error) || error}`);
    return true;
  });
}

function tinySourceRow(rowIndex, flightNumber) {
  return {
    rowIndex,
    effective: '2026-10-25',
    discontinue: '2026-10-25',
    airline: 'VN',
    aircraft: '321',
    daysOfWeek: [false, false, false, false, false, false, true],
    sta: '07:05',
    arrFlight: flightNumber,
    arrFlightType: 'PAX',
    arrRoute: 'KIX',
    arrFlightCategory: 'J',
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
  };
}

async function runFaultInjection(client, principals, committedMain) {
  const { primaryUserId, secondaryUserId } = principals;
  const beforeStage = await prepareSeasonalImportV2Attempt({
    seasonId: null,
    seasonCode: 'S97',
    expectedDataVersion: 0,
    fileName: 'fault-before-stage.xlsx',
    uploadedAt: 0,
    sourceRows: [tinySourceRow(1, 'VN901')],
  });
  await assert.rejects(
    runSeasonalImportV2RpcFlow(beforeStage, {
      stage: async () => { throw new Error('injected before-stage network failure'); },
      commit: async () => { throw new Error('commit must not run'); },
    }),
    SeasonalImportV2StatusUnknownError,
  );
  const beforeCount = await client.query('select count(*)::integer as count from public.season_import_batches where request_id = $1', [beforeStage.requestId]);
  assert.equal(beforeCount.rows[0].count, 0);

  const afterStage = await prepareSeasonalImportV2Attempt({
    seasonId: null,
    seasonCode: 'S96',
    expectedDataVersion: 0,
    fileName: 'fault-after-stage.xlsx',
    uploadedAt: 0,
    sourceRows: [tinySourceRow(1, 'VN902')],
  });
  await assert.rejects(
    runSeasonalImportV2RpcFlow(afterStage, {
      stage: async () => {
        await stageAttempt(client, primaryUserId, afterStage);
        throw new Error('injected after-stage response loss');
      },
      commit: async () => { throw new Error('commit must not run'); },
    }),
    SeasonalImportV2StatusUnknownError,
  );
  const recoveredAfterStage = await runSeasonalImportV2RpcFlow(afterStage, {
    stage: async () => (await stageAttempt(client, primaryUserId, afterStage)).result,
    commit: async (batchId, version) => (await commitBatch(client, primaryUserId, batchId, version)).result,
  });

  const commitLost = await prepareSeasonalImportV2Attempt({
    seasonId: null,
    seasonCode: 'S95',
    expectedDataVersion: 0,
    fileName: 'fault-commit-lost.xlsx',
    uploadedAt: 0,
    sourceRows: [tinySourceRow(1, 'VN903')],
  });
  let deliveredCommit = null;
  await assert.rejects(
    runSeasonalImportV2RpcFlow(commitLost, {
      stage: async () => (await stageAttempt(client, primaryUserId, commitLost)).result,
      commit: async (batchId, version) => {
        deliveredCommit = (await commitBatch(client, primaryUserId, batchId, version)).result;
        throw new Error('injected commit-response delivery loss');
      },
    }),
    SeasonalImportV2StatusUnknownError,
  );
  assert.ok(deliveredCommit);
  const recoveredCommit = await runSeasonalImportV2RpcFlow(commitLost, {
    stage: async () => (await stageAttempt(client, primaryUserId, commitLost)).result,
    commit: async (batchId, version) => (await commitBatch(client, primaryUserId, batchId, version)).result,
  });
  assert.deepEqual(recoveredCommit, deliveredCommit);
  const committedCount = await client.query(
    `select count(*)::integer as count from public.season_flight_records
     where season_id = $1 and source_kind = 'imported' and status = 'active'`,
    [recoveredCommit.seasonId],
  );
  assert.equal(committedCount.rows[0].count, 1, 'commit response retry duplicated records');

  const receipt = markSeasonalImportRecoveryCommitted(
    buildSeasonalImportRecoveryReceipt(commitLost, primaryUserId),
    recoveredCommit,
  );
  const storedValues = new Map();
  const receiptStorage = {
    getItem: (key) => storedValues.get(key) ?? null,
    setItem: (key, value) => { storedValues.set(key, value); },
    removeItem: (key) => { storedValues.delete(key); },
  };
  persistSeasonalImportRecoveryReceipt(receiptStorage, receipt);
  const persistedReceiptJson = storedValues.get(SEASONAL_IMPORT_RECOVERY_STORAGE_KEY);
  assert.equal(typeof persistedReceiptJson, 'string');
  assert.doesNotMatch(persistedReceiptJson, /"sourceRows"|"fileName"|"uploadedAt"|\.xlsx|PK\u0003\u0004/);
  const retainedReceipt = loadSeasonalImportRecoveryReceipt(receiptStorage, {
    ownerUserId: primaryUserId,
    expectedSeasonId: recoveredCommit.seasonId,
  });
  assert.ok(retainedReceipt);
  assert.deepEqual(committedSeasonalImportFromRecoveryReceipt(retainedReceipt), recoveredCommit);

  const refreshStateBefore = await client.query(
    `select
       batches.status,
       batches.generated_record_count,
       batches.committed_at,
       seasons.data_version,
       (select count(*)::integer
        from public.season_import_batches matching
        where matching.request_id = batches.request_id) as batch_count,
       (select count(*)::integer
        from public.season_flight_records records
        where records.season_id = batches.season_id
          and records.source_kind = 'imported'
          and records.status = 'active') as record_count
     from public.season_import_batches batches
     join public.seasons seasons on seasons.id = batches.season_id
     where batches.batch_id = $1::uuid`,
    [recoveredCommit.batchId],
  );
  assert.equal(refreshStateBefore.rows.length, 1);

  let refreshError;
  let snapshotLoaderCalls = 0;
  await assert.rejects(
    loadTargetedCommittedImportRefresh({
      committedImport: recoveredCommit,
      loadSeasons: () => loadAuthoritativeSeasons(client, primaryUserId),
      loadSnapshot: async (input) => {
        snapshotLoaderCalls += 1;
        const rawSnapshot = await fetchExportSnapshot(
          client,
          primaryUserId,
          input.seasonId,
          input.expectedDataVersion,
        );
        assert.equal(typeof rawSnapshot?.totalCount, 'number');
        return materializeSeasonalExportSnapshot(
          { ...rawSnapshot, totalCount: rawSnapshot.totalCount + 1 },
          input,
        );
      },
    }),
    (error) => {
      refreshError = error;
      assert.match(String(error), /totalCount .* does not match flightRecords length/);
      return true;
    },
  );
  assert.equal(snapshotLoaderCalls, 1);
  const refreshFailure = buildSeasonalImportCommittedRefreshFailure(recoveredCommit, refreshError);
  assert.equal(refreshFailure.title, 'Import committed, refresh failed');
  assert.match(refreshFailure.message, new RegExp(recoveredCommit.seasonId));
  assert.match(refreshFailure.message, new RegExp(recoveredCommit.batchId));
  assert.match(refreshFailure.message, /totalCount .* does not match flightRecords length/);

  const refreshStateAfter = await client.query(
    `select
       batches.status,
       batches.generated_record_count,
       batches.committed_at,
       seasons.data_version,
       (select count(*)::integer
        from public.season_import_batches matching
        where matching.request_id = batches.request_id) as batch_count,
       (select count(*)::integer
        from public.season_flight_records records
        where records.season_id = batches.season_id
          and records.source_kind = 'imported'
          and records.status = 'active') as record_count
     from public.season_import_batches batches
     join public.seasons seasons on seasons.id = batches.season_id
     where batches.batch_id = $1::uuid`,
    [recoveredCommit.batchId],
  );
  assert.deepEqual(refreshStateAfter.rows, refreshStateBefore.rows, 'refresh recovery must not restage or recommit');
  assert.equal(refreshStateAfter.rows[0].status, 'committed');
  assert.equal(refreshStateAfter.rows[0].batch_count, 1);
  assert.equal(refreshStateAfter.rows[0].record_count, 1);

  const mainBatch = await client.query('select request_id from public.season_import_batches where batch_id = $1::uuid', [committedMain.batchId]);
  assert.equal(mainBatch.rows.length, 1);
  await expectSqlState(
    () => stageAttempt(client, secondaryUserId, { ...committedMain.attempt }),
    ['42501'],
    'cross-owner retry',
  );
  await expectSqlState(
    () => stageAttempt(client, primaryUserId, { ...committedMain.attempt, mode: 'repair' }),
    ['23505'],
    'cross-mode retry',
  );

  const versionAttempt = await prepareSeasonalImportV2Attempt({
    seasonId: committedMain.seasonId,
    seasonCode: committedMain.seasonCode,
    expectedDataVersion: committedMain.dataVersion,
    fileName: 'fault-version.xlsx',
    uploadedAt: 0,
    sourceRows: [tinySourceRow(1, 'VN904')],
  });
  const versionStage = await stageAttempt(client, primaryUserId, versionAttempt);
  await expectSqlState(
    () => commitBatch(client, primaryUserId, versionStage.result.batchId, committedMain.dataVersion + 1),
    ['22023', '40001'],
    'version conflict',
  );

  return {
    beforeStage: 'status-unknown-no-batch',
    afterStage: { batchId: recoveredAfterStage.batchId, status: recoveredAfterStage.status },
    commitResponseLost: { batchId: recoveredCommit.batchId, status: recoveredCommit.status },
    postCommitRefresh: {
      status: refreshFailure.title,
      malformedSnapshotRejected: true,
      snapshotLoaderCalls,
      retainedMinimalReceipt: true,
      stageOrCommitStateUnchanged: true,
      sourceRowsPersistedInReceipt: false,
      workbookPayloadPersistedInReceipt: false,
      receiptBytes: Buffer.byteLength(persistedReceiptJson, 'utf8'),
    },
    conflicts: ['owner:42501', 'mode:23505', 'version:fail-closed'],
  };
}

export async function runLoadTest() {
  const fixtureData = await loadVerifiedFixture('W26');
  const { client, databaseName, engine } = await connectTestDatabase('seasonal-task11-load');
  let principals;
  try {
    principals = await createTestPrincipals(client);
    const attempt = await prepareSeasonalImportV2Attempt({
      seasonId: null,
      seasonCode: 'W26',
      expectedDataVersion: 0,
      fileName: fixtureData.fixture.source.basename,
      uploadedAt: 0,
      sourceRows: fixtureData.sourceRows,
    });
    const requestJson = JSON.stringify(attempt);
    const requestBytes = Buffer.byteLength(requestJson, 'utf8');
    assert.equal(Object.hasOwn(attempt, 'flightRecords'), false, 'source-row request must not contain flightRecords');
    assert.doesNotMatch(requestJson, /"flightRecords"\s*:/);
    assert.ok(requestBytes > 0 && requestBytes <= MAX_REQUEST_BYTES, `request is ${requestBytes} bytes; limit is ${MAX_REQUEST_BYTES}`);

    const staged = await stageAttempt(client, principals.primaryUserId, attempt);
    assert.equal(staged.result.generatedRecordCount, fixtureData.fixture.verification.expectedGeneratedCount);
    const preview = await previewBatch(client, staged.result.batchId);
    assert.equal(preview.generated_count, fixtureData.fixture.verification.expectedGeneratedCount);
    assert.equal(preview.diagnostic_count, 0);
    assert.equal(preview.duplicate_count, 0);
    const committed = await commitBatch(client, principals.primaryUserId, staged.result.batchId, 0);
    assert.equal(committed.result.flightRecordCount, fixtureData.fixture.verification.expectedGeneratedCount);

    const retryStage = await stageAttempt(client, principals.primaryUserId, attempt);
    const retryCommit = await commitBatch(client, principals.primaryUserId, retryStage.result.batchId, 0);
    assert.equal(retryStage.result.batchId, staged.result.batchId);
    assert.deepEqual(retryCommit.result, committed.result);
    const persisted = await client.query(
      `select
         (select count(*)::integer from public.season_import_batches where request_id = $1) as batch_count,
         (select count(*)::integer from public.season_flight_records where season_id = $2 and source_kind = 'imported' and status = 'active') as record_count`,
      [attempt.requestId, committed.result.seasonId],
    );
    assert.equal(persisted.rows[0].batch_count, 1);
    assert.equal(persisted.rows[0].record_count, fixtureData.fixture.verification.expectedGeneratedCount);

    const faults = await runFaultInjection(client, principals, { ...committed.result, attempt });
    const metrics = {
      fixture: {
        seasonCode: 'W26',
        sourceBasename: fixtureData.fixture.source.basename,
        sourceSha256: fixtureData.fixture.source.sha256,
        sourceRowsSha256: fixtureData.fixture.verification.sourceRowsSha256,
        sourceRowCount: fixtureData.sourceRows.length,
        expectedGeneratedCount: fixtureData.fixture.verification.expectedGeneratedCount,
        coverage: fixtureData.fixture.verification.coverage,
        parityLabel: 'fixture-derived count; production shadow parity is separate',
      },
      requestBytes,
      parseDurationMs: Number(fixtureData.parseDurationMs.toFixed(2)),
      stageDurationMs: Number(staged.durationMs.toFixed(2)),
      previewDurationMs: Number(preview.durationMs.toFixed(2)),
      commitDurationMs: Number(committed.durationMs.toFixed(2)),
      generatedCount: committed.result.flightRecordCount,
      duplicateCount: preview.duplicate_count,
      databaseName,
      databaseEngine: engine.split('\n')[0],
      idempotentRetry: true,
      faults,
    };
    console.log(JSON.stringify(metrics));
    return metrics;
  } finally {
    if (principals) await cleanupTestPrincipals(client, [principals.primaryUserId, principals.secondaryUserId]);
    await client.end();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await runLoadTest();
