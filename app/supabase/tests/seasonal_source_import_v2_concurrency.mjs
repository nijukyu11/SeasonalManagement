/**
 * Real PostgreSQL only. PGlite cannot prove multi-session locking because it
 * serializes access through one embedded runtime. This harness requires an
 * explicitly marked disposable localhost database and never auto-discovers a
 * server or connects to a remote host.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  parseDisposableDatabaseConfig,
  verifyDatabaseIdentityOrClose,
} from '../../scripts/seasonal-test-database-guard.mjs';

const databaseConfig = parseDisposableDatabaseConfig(process.env);
const connectionString = databaseConfig.connectionString;
const expectedDatabaseName = databaseConfig.databaseName;

const HARD_TIMEOUT_MS = 60_000;
const CLEANUP_RESERVE_MS = 10_000;
const SCENARIO_TIMEOUT_MS = HARD_TIMEOUT_MS - CLEANUP_RESERVE_MS;
const QUERY_TIMEOUT_MS = 35_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const harnessStartedAt = Date.now();
const hardDeadline = harnessStartedAt + HARD_TIMEOUT_MS;
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
  query_timeout: QUERY_TIMEOUT_MS,
  statement_timeout: QUERY_TIMEOUT_MS,
};
const abortController = new AbortController();
const backgroundErrors = [];
let cleanupStarted = false;
let databaseIdentityVerified = false;

function createClientState(name) {
  const client = new Client({ ...clientOptions, application_name: `seasonal-import-v2-${name}` });
  const state = {
    name,
    client,
    connected: false,
    transactionOpen: false,
    pendingQueries: 0,
  };
  client.on('error', (error) => {
    if (!cleanupStarted) {
      backgroundErrors.push(wrapError(`${name} connection error`, error));
      abortController.abort(error);
    }
  });
  return state;
}

const janitor = createClientState('janitor');
const admin = createClientState('admin');
const clientA = createClientState('client-a');
const clientB = createClientState('client-b');
const scenarioClients = [admin, clientA, clientB];

function wrapError(label, error) {
  const wrapped = new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  wrapped.cause = error;
  return wrapped;
}

function startTrackedQuery(state, text, params = []) {
  state.pendingQueries += 1;
  const queryPromise = state.client.query(text, params);
  void queryPromise.then(
    () => { state.pendingQueries -= 1; },
    () => { state.pendingQueries -= 1; }
  );
  return queryPromise;
}

async function waitForOperation(promise, label, timeoutMs = QUERY_TIMEOUT_MS) {
  let timeout;
  let onAbort;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(
      abortController.signal.reason instanceof Error
        ? abortController.signal.reason
        : new Error(`${label} aborted`)
    );
    if (abortController.signal.aborted) {
      onAbort();
      return;
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timeout);
    abortController.signal.removeEventListener('abort', onAbort);
  }
}

async function connectClient(state) {
  await waitForOperation(
    state.client.connect().then(() => { state.connected = true; }),
    `${state.name} connect`,
    5_000
  );
}

async function query(state, text, params, label, timeoutMs = QUERY_TIMEOUT_MS) {
  return waitForOperation(startTrackedQuery(state, text, params), label, timeoutMs);
}

async function sleep(milliseconds, label) {
  await waitForOperation(
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
    label,
    milliseconds + 1_000
  );
}

async function beginAuthenticated(state) {
  await query(state, 'begin', [], `${state.name} begin`);
  state.transactionOpen = true;
  await query(state, 'set local role authenticated', [], `${state.name} role`);
  await query(
    state,
    `set local statement_timeout = '30s'`,
    [],
    `${state.name} statement timeout`
  );
  await query(
    state,
    `select pg_catalog.set_config('request.jwt.claim.sub', $1, true)`,
    [userId],
    `${state.name} auth context`
  );
}

async function commit(state) {
  await query(state, 'commit', [], `${state.name} commit`);
  state.transactionOpen = false;
}

async function rollback(state) {
  await query(state, 'rollback', [], `${state.name} rollback`);
  state.transactionOpen = false;
}

async function waitForLock(processId, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const activity = await query(
      admin,
      `select wait_event_type, wait_event
       from pg_catalog.pg_stat_activity
       where pid = $1`,
      [processId],
      `${label} activity`,
      2_000
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') {
      return activity.rows[0].wait_event;
    }
    await sleep(25, `${label} poll`);
  }
  throw new Error(`${label} did not reach a lock wait within 15 seconds`);
}

async function runScenario() {
  await connectClient(janitor);
  try {
    await verifyDatabaseIdentityOrClose(janitor.client, expectedDatabaseName);
  } catch (error) {
    if (error?.databaseClientClosed === true) janitor.connected = false;
    throw error;
  }
  databaseIdentityVerified = true;
  await Promise.all(scenarioClients.map(connectClient));

  await query(
    admin,
    `insert into auth.users (
       id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) values ($1, 'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userId, email],
    'insert test user'
  );
  await query(
    admin,
    `insert into public.app_operators (user_id, email, username, display_name)
     values ($1, $2, $3, 'Seasonal Import V2 Concurrency Test')`,
    [userId, email, `seasonal_import_v2_${compactFixtureId}`],
    'insert test operator'
  );
  await query(
    admin,
    `insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
     values ($1, 'seasonal.write', 'allow')`,
    [userId],
    'insert permission override'
  );
  await query(
    admin,
    `insert into public.seasons (
       id, season_code, name, file_name, uploaded_at,
       effective_start, effective_end, total_legs, total_source_rows, data_version
     ) values ($1, $2, 'Concurrency Test', '', 0, '', '', 0, 0, 3)`,
    [seasonId, seasonCode],
    'insert test season'
  );
  await query(
    admin,
    `drop trigger if exists season_import_v2_concurrency_pause
       on public.season_import_batches;

     create or replace function public.season_import_v2_concurrency_pause()
     returns trigger
     language plpgsql
     set search_path = pg_catalog, pg_temp
     as $$
     begin
       if pg_catalog.current_setting('seasonal.test.pause_after_batch_insert', true) = 'on' then
         perform pg_catalog.pg_advisory_xact_lock(${advisoryLockKey});
       end if;
       return new;
     end;
     $$;

     create trigger season_import_v2_concurrency_pause
     after insert on public.season_import_batches
     for each row
     execute function public.season_import_v2_concurrency_pause();`,
    [],
    'install concurrency pause trigger'
  );

  await query(admin, 'begin', [], 'admin advisory transaction begin');
  admin.transactionOpen = true;
  await query(
    admin,
    'select pg_catalog.pg_advisory_xact_lock($1)',
    [advisoryLockKey],
    'acquire advisory lock'
  );

  await beginAuthenticated(clientA);
  await query(
    clientA,
    `select pg_catalog.set_config('seasonal.test.pause_after_batch_insert', 'on', true)`,
    [],
    'enable first client pause'
  );
  const callA = startTrackedQuery(
    clientA,
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(payload)]
  );
  const firstWait = await waitForLock(clientA.client.processID, 'first staging client');
  assert.match(firstWait, /advisory/i);

  await beginAuthenticated(clientB);
  const callB = startTrackedQuery(
    clientB,
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(payload)]
  );
  const secondWait = await waitForLock(clientB.client.processID, 'conflicting staging client');
  assert.match(secondWait, /transactionid/i);

  await commit(admin);
  const firstResponse = (
    await waitForOperation(callA, 'first staging call')
  ).rows[0].result;
  await commit(clientA);
  const secondResponse = (
    await waitForOperation(callB, 'conflicting staging call')
  ).rows[0].result;
  await commit(clientB);

  assert.equal(firstResponse.batchId, secondResponse.batchId);
  assert.equal(firstResponse.status, 'validated');
  assert.equal(secondResponse.status, 'validated');
  assert.equal(firstResponse.sourceRowCount, sourceRows.length);
  assert.equal(secondResponse.sourceRowCount, sourceRows.length);
  assert.equal(firstResponse.valid, true);
  assert.equal(secondResponse.valid, true);

  const persisted = await query(
    admin,
    `select
       (select count(*)::integer
        from public.season_import_batches batches
        where batches.request_id = $1) as batch_count,
       (select count(*)::integer
        from public.season_import_batch_rows rows
        join public.season_import_batches batches on batches.batch_id = rows.batch_id
        where batches.request_id = $1) as row_count`,
    [requestId],
    'verify concurrent retry persistence'
  );
  assert.equal(persisted.rows[0].batch_count, 1);
  assert.equal(persisted.rows[0].row_count, sourceRows.length);

  await query(
    admin,
    'drop trigger season_import_v2_concurrency_pause on public.season_import_batches',
    [],
    'drop concurrency pause trigger'
  );
  await query(
    admin,
    'drop function public.season_import_v2_concurrency_pause()',
    [],
    'drop concurrency pause function'
  );

  await query(admin, 'begin', [], 'season race transaction begin');
  admin.transactionOpen = true;
  await query(
    admin,
    `insert into public.seasons (
       id, season_code, name, file_name, uploaded_at,
       effective_start, effective_end, total_legs, total_source_rows, data_version
     ) values ($1, $2, 'Concurrent Season Conflict', '', 0, '', '', 0, 0, 3)`,
    [conflictingSeasonId, ` ${seasonCode.toLowerCase()} `],
    'insert concurrent season conflict'
  );

  await beginAuthenticated(clientA);
  const seasonRaceCall = startTrackedQuery(
    clientA,
    'select public.stage_seasonal_import_v2($1::jsonb) as result',
    [JSON.stringify(seasonRacePayload)]
  );
  const seasonLookupWait = await waitForLock(clientA.client.processID, 'season lookup race client');
  assert.match(seasonLookupWait, /relation/i);
  await commit(admin);
  await assert.rejects(
    waitForOperation(seasonRaceCall, 'season lookup race staging call'),
    (error) => error?.code === '21000' && /Ambiguous seasonCode/.test(error.message)
  );
  await rollback(clientA);

  console.log(JSON.stringify({
    databaseName: expectedDatabaseName,
    databaseIdentityVerified,
    batchId: firstResponse.batchId,
    batchCount: persisted.rows[0].batch_count,
    rowCount: persisted.rows[0].row_count,
    firstClientWait: firstWait,
    secondClientWait: secondWait,
    seasonLookupWait,
    seasonLookupConflict: '21000 Ambiguous seasonCode',
  }));
}

async function cleanup() {
  const cleanupErrors = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(wrapError(label, error));
    }
  };
  const cleanupQuery = (text, params, label) => attempt(label, () =>
    waitForCleanupOperation(() => janitor.client.query(text, params), label)
  );

  for (const state of scenarioClients) {
    if (state.connected && state.transactionOpen && state.pendingQueries === 0) {
      await attempt(`${state.name} rollback cleanup`, async () => {
        await waitForCleanupOperation(
          () => state.client.query('rollback'),
          `${state.name} rollback cleanup`
        );
        state.transactionOpen = false;
      });
    }
  }

  if (janitor.connected && databaseIdentityVerified) {
    for (const state of scenarioClients) {
      if (
        state.connected
        && (abortController.signal.aborted || state.transactionOpen || state.pendingQueries > 0)
        && Number.isInteger(state.client.processID)
      ) {
        await cleanupQuery(
          'select pg_catalog.pg_terminate_backend($1)',
          [state.client.processID],
          `terminate pending ${state.name} session`
        );
      }
    }

    await cleanupQuery(
      `drop trigger if exists season_import_v2_concurrency_pause
         on public.season_import_batches`,
      [],
      'drop concurrency trigger cleanup'
    );
    await cleanupQuery(
      'drop function if exists public.season_import_v2_concurrency_pause()',
      [],
      'drop concurrency function cleanup'
    );
    await cleanupQuery(
      'delete from public.season_import_batches where request_id = any($1::uuid[])',
      [[requestId, seasonRaceRequestId]],
      'delete concurrency batches cleanup'
    );
    await cleanupQuery(
      `delete from public.app_operator_permission_overrides
       where user_id = $1 and permission_key = 'seasonal.write'`,
      [userId],
      'delete permission override cleanup'
    );
    await cleanupQuery(
      'delete from public.app_operators where user_id = $1',
      [userId],
      'delete test operator cleanup'
    );
    await cleanupQuery(
      'delete from public.seasons where id = any($1::text[])',
      [[seasonId, conflictingSeasonId]],
      'delete test seasons cleanup'
    );
    await cleanupQuery(
      'delete from auth.users where id = $1',
      [userId],
      'delete test user cleanup'
    );
  } else if (databaseIdentityVerified) {
    cleanupErrors.push(new Error('janitor connection unavailable for database cleanup'));
  }

  for (const state of [...scenarioClients, janitor]) {
    if (!state.connected) {
      continue;
    }
    await attempt(`${state.name} close cleanup`, async () => {
      try {
        await waitForCleanupOperation(() => state.client.end(), `${state.name} close cleanup`);
      } catch (error) {
        state.client.connection?.stream?.destroy();
        throw error;
      }
    });
  }

  return cleanupErrors;
}

async function waitForCleanupOperation(operation, label) {
  const remainingHardBudget = hardDeadline - Date.now();
  if (remainingHardBudget <= 0) {
    throw new Error(`${label} could not start before the 60-second hard deadline`);
  }

  const timeoutMs = Math.min(CLEANUP_TIMEOUT_MS, remainingHardBudget);
  let timeout;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const hardTimeout = setTimeout(() => {
  abortController.abort(new Error(
    'seasonal import V2 concurrency scenario exceeded 50 seconds; cleanup reserve started'
  ));
}, SCENARIO_TIMEOUT_MS);
let scenarioError;
let cleanupErrors = [];

try {
  await runScenario();
  if (backgroundErrors.length > 0) {
    throw new AggregateError(backgroundErrors, 'Concurrency harness connection errors');
  }
} catch (error) {
  scenarioError = error;
} finally {
  cleanupStarted = true;
  clearTimeout(hardTimeout);
  cleanupErrors = await cleanup();
}

const failures = [scenarioError, ...backgroundErrors, ...cleanupErrors].filter(Boolean);
if (failures.length > 0) {
  throw new AggregateError(failures, 'Seasonal import V2 concurrency harness failed');
}
