import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DISPOSABLE_DATABASE_PATTERN = /^seasonal_task11_[a-z0-9_]+$/;
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

function requiredDatabaseUrl() {
  const value = process.env.SEASONAL_TEST_DATABASE_URL;
  if (!value) throw new Error('SEASONAL_TEST_DATABASE_URL is required');
  if (process.env.SEASONAL_TEST_TEMP_DB !== '1') {
    throw new Error('Refusing to run without SEASONAL_TEST_TEMP_DB=1');
  }
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!DISPOSABLE_DATABASE_PATTERN.test(database)) {
    throw new Error(`Refusing non-Task11 database name ${database || '<empty>'}`);
  }
  return { value, url, database };
}

function psqlEnvironment(url, database) {
  const environment = {
    ...process.env,
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
  const child = spawnSync(command, args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (child.error) {
    console.error(`${command} could not start: ${child.error.message}`);
    process.exit(child.status ?? 1);
  }
  if (child.status !== 0) process.exit(child.status ?? 1);
}

const database = requiredDatabaseUrl();
const psqlEnv = psqlEnvironment(database.url, database.database);
const commonPsqlArgs = ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1'];

runChild('psql', [...commonPsqlArgs, '--command', `select current_database() = '${database.database}' as disposable_database_verified`], {
  env: psqlEnv,
});
runChild('psql', [...commonPsqlArgs, '--command', SUPABASE_TEST_BOOTSTRAP], { env: psqlEnv });
for (const sqlFile of [SCHEMA_FILE, MIGRATION_FILE, SQL_TEST_FILE]) {
  runChild('psql', [...commonPsqlArgs, '--file', sqlFile], { env: psqlEnv });
}
runChild(process.execPath, [CONCURRENCY_TEST_FILE], {
  env: {
    ...process.env,
    SEASONAL_TEST_DATABASE_URL: database.value,
    SEASONAL_TEST_TEMP_DB: '1',
  },
});
