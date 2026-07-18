/**
 * Real PostgreSQL only. PGlite cannot prove multi-session locking because it
 * serializes access through one embedded runtime. This harness requires an
 * explicitly marked disposable localhost database and never auto-discovers a
 * server or connects to a remote host.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const connectionString = process.env.SEASONAL_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('SEASONAL_TEST_DATABASE_URL is required');
}

if (process.env.SEASONAL_TEST_TEMP_DB !== '1') {
  throw new Error('Refusing to run without SEASONAL_TEST_TEMP_DB=1');
}

const databaseUrl = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)) {
  throw new Error('Concurrency test only runs against a localhost temporary PostgreSQL server');
}

const require = createRequire(import.meta.url);
const pgModulePath = process.env.SEASONAL_TEST_PG_MODULE;
const { Client } = pgModulePath ? require(resolve(pgModulePath)) : require('pg');

const fixtureId = randomUUID();
const compactFixtureId = fixtureId.replace(/-/g, '');
const userId = randomUUID();
const requestId = randomUUID();
const seasonRaceRequestId = randomUUID();
const seasonId = `seasonal-import-v2-concurrency-${fixtureId}`;
const conflictingSeasonId = `seasonal-import-v2-concurrency-conflict-${fixtureId}`;
const seasonCode = `T${compactFixtureId.slice(0, 8).toUpperCase()}`;
const email = `seasonal-import-v2-${fixtureId}@example.invalid`;
const advisoryLockKey = 2_026_071_809;
const sourceRows = Array.from({ length: 250 }, (_, rowIndex) => ({
  rowIndex,
  effective: '2026-10-25',
  discontinue: '2026-10-25',
  airline: 'VN',
  aircraft: '321',
  daysOfWeek: [false, false, false, false, false, false, true],
  sta: '07:05',
  arrFlight: `VN${String(1000 + rowIndex)}`,
  arrRoute: 'KIX',
}));
const payload = {
  requestId,
  checksum: `concurrency-${fixtureId}`,
  seasonId,
  seasonCode,
  expectedDataVersion: 3,
  fileName: 'concurrency.xlsx',
  sourceRows,
};
const seasonRacePayload = {
  ...payload,
  requestId: seasonRaceRequestId,
  checksum: `season-race-${fixtureId}`,
};

const clientOptions = {
  connectionString,
  connectionTimeoutMillis: 5_000,
  query_timeout: 35_000,
  statement_timeout: 35_000,
};
const admin = new Client({ ...clientOptions, application_name: 'seasonal-import-v2-admin' });
const clientA = new Client({ ...clientOptions, application_name: 'seasonal-import-v2-client-a' });
const clientB = new Client({ ...clientOptions, application_name: 'seasonal-import-v2-client-b' });

let adminConnected = false;
let clientAConnected = false;
let clientBConnected = false;
let adminTransactionOpen = false;
let transactionAOpen = false;
let transactionBOpen = false;
let callA;
let callB;
let seasonRaceCall;
const overallTimeout = setTimeout(() => {
  process.stderr.write('seasonal import V2 concurrency test exceeded 60 seconds\n');
  process.exit(1);
}, 60_000);

async function withTimeout(promise, label, timeoutMs = 30_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForLock(client, processId, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const activity = await client.query(
      `select wait_event_type, wait_event
       from pg_catalog.pg_stat_activity
       where pid = $1`,
      [processId]
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') {
      return activity.rows[0].wait_event;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`${label} did not reach a lock wait within 15 seconds`);
}

async function beginAuthenticated(client) {
  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`set local statement_timeout = '30s'`);
  await client.query(
    `select pg_catalog.set_config('request.jwt.claim.sub', $1, true)`,
    [userId]
  );
}

async function connectClient(client, onConnected) {
  await client.connect();
  onConnected();
}

try {
  await Promise.all([
    connectClient(admin, () => { adminConnected = true; }),
    connectClient(clientA, () => { clientAConnected = true; }),
    connectClient(clientB, () => { clientBConnected = true; }),
  ]);

  await admin.query(
    `insert into auth.users (
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values ($1, 'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userId, email]
  );
  await admin.query(
    `insert into public.app_operators (user_id, email, username, display_name)
     values ($1, $2, $3, 'Seasonal Import V2 Concurrency Test')`,
    [userId, email, `seasonal_import_v2_${compactFixtureId}`]
  );
  await admin.query(
    `insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
     values ($1, 'seasonal.write', 'allow')`,
    [userId]
  );
  await admin.query(
    `insert into public.seasons (
       id, season_code, name, file_name, uploaded_at,
       effective_start, effective_end, total_legs, total_source_rows, data_version
     ) values ($1, $2, 'Concurrency Test', '', 0, '', '', 0, 0, 3)`,
    [seasonId, seasonCode]
  );

  await admin.query(`
    drop trigger if exists season_import_v2_concurrency_pause
      on public.season_import_batches;

    create or replace function public.season_import_v2_concurrency_pause()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, pg_temp
    as $$
    begin
      if pg_catalog.current_setting(
        'seasonal.test.pause_after_batch_insert',
        true
      ) = 'on' then
        perform pg_catalog.pg_advisory_xact_lock(${advisoryLockKey});
      end if;
      return new;
    end;
    $$;

    create trigger season_import_v2_concurrency_pause
    after insert on public.season_import_batches
    for each row
    execute function public.season_import_v2_concurrency_pause();
  `);

  await admin.query('begin');
  adminTransactionOpen = true;
  await admin.query('select pg_catalog.pg_advisory_xact_lock($1)', [advisoryLockKey]);

  await beginAuthenticated(clientA);
  transactionAOpen = true;
  await clientA.query(
    `select pg_catalog.set_config(
      'seasonal.test.pause_after_batch_insert',
      'on',
      true
    )`
  );
  callA = clientA.query(
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(payload)]
  );
  const firstWait = await waitForLock(admin, clientA.processID, 'first staging client');
  assert.match(firstWait, /advisory/i);

  await beginAuthenticated(clientB);
  transactionBOpen = true;
  callB = clientB.query(
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(payload)]
  );
  const secondWait = await waitForLock(admin, clientB.processID, 'conflicting staging client');
  assert.match(secondWait, /transactionid/i);

  await admin.query('commit');
  adminTransactionOpen = false;

  const firstResponse = (await withTimeout(callA, 'first staging call')).rows[0].result;
  callA = undefined;
  await clientA.query('commit');
  transactionAOpen = false;
  const secondResponse = (await withTimeout(callB, 'conflicting staging call')).rows[0].result;
  callB = undefined;
  await clientB.query('commit');
  transactionBOpen = false;

  assert.equal(firstResponse.batchId, secondResponse.batchId);
  assert.equal(firstResponse.status, 'staged');
  assert.equal(secondResponse.status, 'staged');
  assert.equal(firstResponse.sourceRowCount, sourceRows.length);
  assert.equal(secondResponse.sourceRowCount, sourceRows.length);
  assert.equal(firstResponse.valid, true);
  assert.equal(secondResponse.valid, true);

  const persisted = await admin.query(
    `select
       (select count(*)::integer
        from public.season_import_batches batches
        where batches.request_id = $1) as batch_count,
       (select count(*)::integer
        from public.season_import_batch_rows rows
        join public.season_import_batches batches on batches.batch_id = rows.batch_id
        where batches.request_id = $1) as row_count`,
    [requestId]
  );
  assert.equal(persisted.rows[0].batch_count, 1);
  assert.equal(persisted.rows[0].row_count, sourceRows.length);

  await admin.query(
    'drop trigger if exists season_import_v2_concurrency_pause on public.season_import_batches'
  );
  await admin.query('drop function if exists public.season_import_v2_concurrency_pause()');

  await admin.query('begin');
  adminTransactionOpen = true;
  await admin.query(
    `insert into public.seasons (
       id, season_code, name, file_name, uploaded_at,
       effective_start, effective_end, total_legs, total_source_rows, data_version
     ) values ($1, $2, 'Concurrent Season Conflict', '', 0, '', '', 0, 0, 3)`,
    [conflictingSeasonId, ` ${seasonCode.toLowerCase()} `]
  );

  await beginAuthenticated(clientA);
  transactionAOpen = true;
  seasonRaceCall = clientA.query(
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(seasonRacePayload)]
  );
  const seasonLookupWait = await waitForLock(admin, clientA.processID, 'season lookup race client');
  assert.match(seasonLookupWait, /relation/i);

  await admin.query('commit');
  adminTransactionOpen = false;

  await assert.rejects(
    withTimeout(seasonRaceCall, 'season lookup race staging call'),
    (error) => error?.code === '21000' && /Ambiguous seasonCode/.test(error.message)
  );
  seasonRaceCall = undefined;
  await clientA.query('rollback');
  transactionAOpen = false;

  console.log(
    JSON.stringify({
      batchId: firstResponse.batchId,
      batchCount: persisted.rows[0].batch_count,
      rowCount: persisted.rows[0].row_count,
      firstClientWait: firstWait,
      secondClientWait: secondWait,
      seasonLookupWait,
      seasonLookupConflict: '21000 Ambiguous seasonCode',
    })
  );
} finally {
  if (adminConnected && adminTransactionOpen) {
    await withTimeout(admin.query('rollback'), 'admin transaction rollback', 5_000).catch(() => {});
    adminTransactionOpen = false;
  }

  await Promise.allSettled([
    transactionAOpen
      ? withTimeout(clientA.query('rollback'), 'first client rollback', 35_000)
      : undefined,
    transactionBOpen
      ? withTimeout(clientB.query('rollback'), 'second client rollback', 35_000)
      : undefined,
    callA ? withTimeout(callA, 'first staging cleanup', 35_000) : undefined,
    callB ? withTimeout(callB, 'conflicting staging cleanup', 35_000) : undefined,
    seasonRaceCall
      ? withTimeout(seasonRaceCall, 'season lookup race cleanup', 35_000)
      : undefined,
  ]);

  if (adminConnected) {
    await withTimeout(
      admin.query(
        'drop trigger if exists season_import_v2_concurrency_pause on public.season_import_batches'
      ),
      'drop concurrency trigger',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query('drop function if exists public.season_import_v2_concurrency_pause()'),
      'drop concurrency function',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query(
        'delete from public.season_import_batches where request_id = any($1::uuid[])',
        [[requestId, seasonRaceRequestId]]
      ),
      'delete concurrency batches',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query(
        `delete from public.app_operator_permission_overrides
         where user_id = $1 and permission_key = 'seasonal.write'`,
        [userId]
      ),
      'delete permission override',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query('delete from public.app_operators where user_id = $1', [userId]),
      'delete test operator',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query('delete from public.seasons where id = any($1::text[])', [
        [seasonId, conflictingSeasonId],
      ]),
      'delete test seasons',
      5_000
    ).catch(() => {});
    await withTimeout(
      admin.query('delete from auth.users where id = $1', [userId]),
      'delete test user',
      5_000
    ).catch(() => {});
  }

  await Promise.allSettled([
    adminConnected ? withTimeout(admin.end(), 'admin client close', 5_000) : undefined,
    clientAConnected ? withTimeout(clientA.end(), 'first client close', 5_000) : undefined,
    clientBConnected ? withTimeout(clientB.end(), 'second client close', 5_000) : undefined,
  ]);
  clearTimeout(overallTimeout);
}
