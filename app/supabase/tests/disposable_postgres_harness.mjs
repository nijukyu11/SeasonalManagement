import pg from 'pg';
import {
  parseDisposableDatabaseConfig,
  verifyDatabaseIdentityOrClose,
} from '../../scripts/seasonal-test-database-guard.mjs';
import { supabaseBootstrapSql } from './pglite_test_support.mjs';
import { createSeasonalOperationalSeparationDb, listChainMigrations, SKIPPED_CHAIN_MIGRATIONS } from './seasonal_operational_separation_test_support.mjs';
import { M0_FIXTURE, seedM0OperatorsAndSeasons } from './seasonal_operational_separation_fixture.mjs';

const { Client } = pg;

const BOOTSTRAP_MARKER_TABLE = 'disposable_database_bootstrap_marker_v1';

/**
 * Ensures the disposable database exists on the target PostgreSQL server.
 * Connects to the default 'postgres' maintenance database on the same host/port.
 * Strictly verifies disposable name pattern (/^seasonal_task11_[a-z0-9_]+$/)
 * and localhost destination before issuing CREATE DATABASE.
 * NEVER drops or executes destructive operations on any database.
 */
export async function ensureDisposableDatabase(env) {
  const { connectionString, databaseName, url } = parseDisposableDatabaseConfig(env);

  const maintenanceUrl = new URL(connectionString);
  maintenanceUrl.pathname = '/postgres';

  const maintenanceClient = new Client({
    connectionString: maintenanceUrl.toString(),
    statement_timeout: 30_000,
  });

  try {
    await maintenanceClient.connect();
    const result = await maintenanceClient.query(
      'select 1 from pg_database where datname = $1',
      [databaseName]
    );

    if (result.rows.length === 0) {
      await maintenanceClient.query(`create database "${databaseName}"`);
      console.log(`[Harness] Created disposable database: ${databaseName}`);
    } else {
      console.log(`[Harness] Disposable database already exists: ${databaseName}`);
    }
  } finally {
    await maintenanceClient.end().catch(() => {});
  }

  return { connectionString, databaseName, url };
}

/**
 * Applies idempotent Supabase bootstrap and the complete migration chain.
 * Fails closed on any existing non-empty database that does not carry the
 * verified complete bootstrap marker and MVCC migration function marker.
 */
export async function bootstrapDatabaseIfNeeded(client) {
  // Check if database has any existing user tables in public or reporting
  const tableCountRes = await client.query(`
    select count(*)::integer as c
    from information_schema.tables
    where table_schema in ('public', 'reporting');
  `);
  const tableCount = tableCountRes.rows[0].c;
  const expectedChain = (await listChainMigrations()).filter(name => !SKIPPED_CHAIN_MIGRATIONS.has(name));
  const expectedTag = expectedChain.at(-1).replace(/\.sql$/, '');

  if (tableCount > 0) {
    // Non-empty database: verify complete bootstrap marker AND latest MVCC migration marker
    const markerRes = await client.query(`
      select 1
      from information_schema.tables
      where table_schema = 'public' and table_name = $1;
    `, [BOOTSTRAP_MARKER_TABLE]);

    const mvccMarkerRes = await client.query(`
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'reporting'
        and p.proname = 'refresh_operational_canonical_legs_internal_v1'
        and p.oid = to_regprocedure('reporting.refresh_operational_canonical_legs_internal_v1(boolean)')
        and position('-- marker: optimistic_projection_refresh_v1' in pg_get_functiondef(p.oid)) > 0;
    `);

    const hasMarker = markerRes.rowCount > 0 && (await client.query(
      `select 1 from public.${BOOTSTRAP_MARKER_TABLE} where bootstrap_tag = $1 and migration_count = $2`,
      [expectedTag, expectedChain.length]
    )).rowCount > 0;
    const hasMvcc = mvccMarkerRes.rows.length > 0;

    if (hasMarker && hasMvcc) {
      console.log('[Harness] Verified complete bootstrap marker and MVCC migration marker.');
      return;
    }

    // Fail closed: existing non-empty database with partial or unverified chain
    throw new Error(
      `[Harness] FAIL CLOSED: Target database is non-empty (${tableCount} tables) but lacks valid ${BOOTSTRAP_MARKER_TABLE} or MVCC migration marker. Refusing to run on partial migration chain.`
    );
  }

  console.log('[Harness] Clean empty database detected. Bootstrapping complete migration chain...');

  // 1. Roles: create idempotently
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await client.query(`
      do $$ begin
        create role ${role} nologin;
      exception when duplicate_object then null;
      end $$;
    `);
  }

  // 2. Realtime publication: create idempotently
  await client.query(`
    do $$ begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end $$;
  `);

  // 3. Auth schema & auth.users table & auth.uid() function from exported supabaseBootstrapSql
  // Strip role & publication creation (already handled idempotently above), use replacer callbacks
  const bootstrapSql = supabaseBootstrapSql
    .replace(/^\s*create\s+role\s+[^;]+;/gim, '')
    .replace(/^\s*create\s+publication\s+[^;]+;/gim, '')
    .replace(/create\s+schema\s+auth;/gi, () => 'create schema if not exists auth;')
    .replace(/create\s+table\s+auth\.users/gi, () => 'create table if not exists auth.users');

  await client.query(bootstrapSql);

  // 3. Adapter DB interface for createSeasonalOperationalSeparationDb
  const adapterDb = {
    exec: async (sql) => client.query(sql),
    query: async (text, params) => client.query(text, params),
    close: async () => {},
  };

  // 4. Run canonical schema.sql + all migrations up to 20261106090000
  const { applied } = await createSeasonalOperationalSeparationDb(adapterDb);
  console.log(`[Harness] Applied schema.sql and ${applied.length} chain migrations.`);

  // 5. Seed operator auth and permissions using fixture helper
  const userCheck = await client.query('select 1 from auth.users where id = $1', [M0_FIXTURE.writerId]);
  if (userCheck.rows.length === 0) {
    await seedM0OperatorsAndSeasons({ db: adapterDb });
    console.log('[Harness] Seeded M0 operator auth and permissions.');
  }

  // Ensure daily.write permission is explicitly present
  await client.query(`
    insert into public.app_operator_permission_overrides(user_id, permission_key, effect)
    values ($1, 'daily.write', 'allow')
    on conflict (user_id, permission_key) do update set effect = 'allow';
  `, [M0_FIXTURE.writerId]);

  // 6. Record verified bootstrap marker table (split DDL and parameterized DML)
  await client.query(`
    create table if not exists public.${BOOTSTRAP_MARKER_TABLE} (
      bootstrap_tag text primary key,
      bootstrapped_at timestamptz not null default now(),
      migration_count integer not null
    );
  `);
  await client.query(`
    insert into public.${BOOTSTRAP_MARKER_TABLE} (bootstrap_tag, migration_count)
    values ($1, $2)
    on conflict (bootstrap_tag) do update
      set bootstrapped_at = now(),
          migration_count = excluded.migration_count;
  `, [expectedTag, applied.length]);
  console.log(`[Harness] Bootstrap complete; recorded marker ${expectedTag}.`);
}

/**
 * Bounded loop concurrency barrier: polls pg_locks until the specified PID
 * holds a lock on relation relname in schema public.
 * Justified concurrency barrier: synchronizes writers/readers on active lock acquisition.
 */
export async function waitForObservedLock(client, pid, relname, timeoutMs = 30_000) {
  const start = performance.now();
  const pollIntervalMs = 25;

  while (performance.now() - start < timeoutMs) {
    const res = await client.query(`
      select l.mode, l.locktype, l.granted
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
      where l.pid = $1
        and n.nspname = 'public'
        and c.relname = $2
        and l.mode = 'RowShareLock'
        and l.granted = true;
    `, [pid, relname]);

    if (res.rows.length > 0) {
      return res.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[Harness] Timed out (${timeoutMs}ms) waiting for PID ${pid} to acquire lock on public.${relname}`);
}

/**
 * Concurrency barrier: polls pg_locks until the specified PID holds an advisory lock.
 * Synchronizes clients immediately upon refresh start (pg_advisory_xact_lock).
 */
export async function waitForObservedAdvisoryLock(client, pid, timeoutMs = 30_000) {
  const start = performance.now();
  const pollIntervalMs = 25;

  while (performance.now() - start < timeoutMs) {
    const res = await client.query(`
      select l.mode, l.locktype, l.granted
      from pg_locks l
      where l.pid = $1
        and l.locktype = 'advisory'
        and l.granted = true;
    `, [pid]);

    if (res.rows.length > 0) {
      return res.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[Harness] Timed out (${timeoutMs}ms) waiting for PID ${pid} to acquire advisory lock`);
}

/**
 * Concurrency barrier: polls pg_locks until the specified PID is WAITING (granted = false)
 * for a lock on relation relname in schema public.
 * Deterministically synchronizes on writer blocking at checkpoint without race conditions.
 */
export async function waitForWaitingLock(client, pid, relname, timeoutMs = 60_000) {
  const start = performance.now();
  const pollIntervalMs = 25;

  while (performance.now() - start < timeoutMs) {
    const res = await client.query(`
      select l.mode, l.locktype, l.granted
      from pg_locks l
      where l.pid = $1
        and l.locktype = 'transactionid'
        and l.granted = false
        and exists (
          select 1 from pg_locks held
          join pg_class c on c.oid = held.relation
          join pg_namespace n on n.oid = c.relnamespace
          where held.pid = $1 and held.granted
            and held.mode = 'RowShareLock'
            and n.nspname = 'public' and c.relname = $2
        );
    `, [pid, relname]);

    if (res.rows.length > 0) {
      return res.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[Harness] Timed out (${timeoutMs}ms) waiting for PID ${pid} to wait on public.${relname}`);
}

/**
 * Seeds 250,000 representative operational flight legs across 250 dates
 * with unique business keys, valid operational manual lineage, and diverse resources.
 */
export async function seed250kOperationalLegsIfNeeded(client) {
  const countRes = await client.query('select count(*)::integer as c from public.operational_flight_legs');
  const currentCount = countRes.rows[0].c;

  if (currentCount >= 250_000) {
    console.log(`[Harness] public.operational_flight_legs already populated (${currentCount} rows).`);
    return currentCount;
  }

  console.log(`[Harness] Seeding 250,000 representative operational legs (current: ${currentCount})...`);
  const startTime = Date.now();

  await client.query(`
    insert into public.operational_flight_legs (
      leg_id,
      leg_key,
      operational_date,
      scheduled_date,
      scheduled_time,
      side,
      airline,
      flight_number,
      route,
      aircraft_type,
      source_type,
      status,
      pax,
      flight_category,
      stand,
      gate
    )
    select
      gen_random_uuid(),
      (case when (i % 2) = 0 then 'A' else 'D' end)
        || chr(31) || ('2026-10-25'::date + (i / 1000)::integer)::text
        || chr(31) || 'VN'
        || chr(31) || ('VN' || lpad(((i % 1000) + 1)::text, 4, '0')),
      '2026-10-25'::date + (i / 1000)::integer,
      '2026-10-25'::date + (i / 1000)::integer,
      make_time(((i % 1000) / 42)::integer, ((i * 7) % 60)::integer, 0),
      (case when (i % 2) = 0 then 'ARR' else 'DEP' end),
      'VN',
      'VN' || lpad(((i % 1000) + 1)::text, 4, '0'),
      (case when (i % 2) = 0 then 'HAN-SGN' else 'SGN-HAN' end),
      (case when (i % 3) = 0 then 'A321' when (i % 3) = 1 then 'A350' else 'B787' end),
      'operational_manual',
      'active',
      120 + (i % 100),
      'C',
      ((i % 40) + 1)::text,
      ((i % 20) + 1)
    from generate_series(0, 249999) as s(i)
    on conflict (leg_id) do nothing;
  `);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const finalCountRes = await client.query('select count(*)::integer as c from public.operational_flight_legs');
  const finalCount = finalCountRes.rows[0].c;

  console.log(`[Harness] Seeded ${finalCount} operational flight legs in ${elapsedSec}s.`);
  return finalCount;
}

/**
 * Helper to execute code as an authenticated operator with daily.write permission
 */
export async function authenticateClientAsOperator(client, writerId = M0_FIXTURE.writerId) {
  await client.query('set role authenticated;');
  await client.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false);`, [writerId]);
}

/**
 * Helper to reset client back to postgres / admin role
 */
export async function resetClientRole(client) {
  await client.query('reset role;');
}
