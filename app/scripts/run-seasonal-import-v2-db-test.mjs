import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDisposableDatabaseConfig } from './seasonal-test-database-guard.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(APP_DIR, 'supabase', 'schema.sql');
const MIGRATION_FILE = path.join(
  APP_DIR,
  'supabase',
  'migrations',
  '20260718090000_seasonal_source_import_v2.sql',
);
const SQL_TEST_FILE = path.join(APP_DIR, 'supabase', 'tests', 'seasonal_source_import_v2.sql');
const CONCURRENCY_TEST_FILE = path.join(
  APP_DIR,
  'supabase',
  'tests',
  'seasonal_source_import_v2_concurrency.mjs',
);
const SUPABASE_TEST_BOOTSTRAP = `
do $$ begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role service_role nologin;
exception when duplicate_object then null;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz
);
create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
end $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
`;

function psqlEnvironment(env, url, database) {
  const environment = {
    ...env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '10',
  };
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) environment.PGSSLMODE = sslMode;
  delete environment.SEASONAL_TEST_DATABASE_URL;
  return environment;
}

function runChild(command, args, options = {}) {
  const { spawnSyncImpl = spawnSync, ...childOptions } = options;
  const child = spawnSyncImpl(command, args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    ...childOptions,
  });
  if (child.error) {
    const error = new Error(`${command} could not start: ${child.error.message}`, {
      cause: child.error,
    });
    error.exitCode = child.status ?? 1;
    throw error;
  }
  if (child.status !== 0) {
    const error = new Error(`${command} exited with status ${child.status ?? 1}`);
    error.exitCode = child.status ?? 1;
    throw error;
  }
  return child;
}

function normalizePsqlIdentity(stdout) {
  if (typeof stdout !== 'string') {
    throw new Error('Database identity preflight returned no captured output');
  }
  const normalizedLineEndings = stdout.replaceAll('\r\n', '\n');
  const identity = normalizedLineEndings.endsWith('\n')
    ? normalizedLineEndings.slice(0, -1)
    : normalizedLineEndings;
  if (
    identity.length === 0
    || identity.includes('\n')
    || identity.includes('\r')
    || identity.trim() !== identity
  ) {
    throw new Error('Database identity preflight did not return exactly one unadorned value');
  }
  return identity;
}

export function runSeasonalImportV2DbTest({
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const database = parseDisposableDatabaseConfig(env);
  const psqlEnv = psqlEnvironment(env, database.url, database.databaseName);
  const commonPsqlArgs = ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1'];

  const identityChild = runChild(
    'psql',
    [
      ...commonPsqlArgs,
      '--tuples-only',
      '--no-align',
      '--command',
      'select current_database()',
    ],
    {
      env: psqlEnv,
      spawnSyncImpl,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const actualDatabaseName = normalizePsqlIdentity(identityChild.stdout);
  if (actualDatabaseName !== database.databaseName) {
    throw new Error(
      `Database identity mismatch: expected ${database.databaseName}, got ${actualDatabaseName}`,
    );
  }

  runChild('psql', [...commonPsqlArgs, '--command', SUPABASE_TEST_BOOTSTRAP], {
    env: psqlEnv,
    spawnSyncImpl,
  });
  for (const sqlFile of [SCHEMA_FILE, MIGRATION_FILE, SQL_TEST_FILE]) {
    runChild('psql', [...commonPsqlArgs, '--file', sqlFile], {
      env: psqlEnv,
      spawnSyncImpl,
    });
  }
  runChild(process.execPath, [CONCURRENCY_TEST_FILE], {
    env: {
      ...env,
      SEASONAL_TEST_DATABASE_URL: database.connectionString,
      SEASONAL_TEST_TEMP_DB: '1',
    },
    spawnSyncImpl,
  });
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    runSeasonalImportV2DbTest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
