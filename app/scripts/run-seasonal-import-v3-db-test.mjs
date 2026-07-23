import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import {
  parseDisposableDatabaseConfig,
  verifyConnectedDatabaseIdentity,
} from './seasonal-test-database-guard.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(APP_DIR, 'supabase', 'schema.sql');
const MIGRATION_FILE = path.join(
  APP_DIR,
  'supabase',
  'migrations',
  '20260724090000_seasonal_partial_import_v3.sql',
);
const SQL_TEST_FILE = path.join(
  APP_DIR,
  'supabase',
  'tests',
  'seasonal_partial_import_v3.sql',
);
const LOAD_TEST_FILE = path.join(APP_DIR, 'scripts', 'seasonal-import-v3-load-test.mjs');
const SUPABASE_TEST_BOOTSTRAP = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
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
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    execute 'create publication supabase_realtime';
  end if;
end $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
`;
const PRE_V3_FIXTURE = `
alter table public.seasons alter column uploaded_at set default 0;

insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'writer@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'repair@example.test'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'reader@example.test');

insert into public.app_operators (user_id, email, username, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'writer@example.test', 'writer', 'Writer'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'repair@example.test', 'repair', 'Repair'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'reader@example.test', 'reader', 'Reader');

insert into public.app_operator_permission_overrides (
  user_id,
  permission_key,
  effect
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'seasonal.read', 'allow'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'seasonal.write', 'allow'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'season.repair', 'allow'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'season.repair', 'allow');

insert into public.seasons (
  id,
  season_code,
  name,
  uploaded_at,
  data_version
) values
  ('season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6', 'S26', 'S26', 0, 7),
  ('season-29cbca13-e11d-4b75-bcaa-00a6c5ca68c6', 'W26', 'W26', 0, 9);

insert into public.season_source_rows (
  season_id,
  row_index,
  effective,
  discontinue,
  airline,
  aircraft
) values (
  'season-29cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  1,
  '2026-10-25',
  '2027-03-27',
  'VN',
  '321'
);

insert into public.season_import_batches (
  request_id,
  season_id,
  season_code,
  expected_data_version,
  checksum,
  status,
  created_by
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'S26',
    7,
    'existing-before-migration',
    'validated',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    null,
    'W27',
    0,
    'new-before-migration',
    'validated',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
`;

function runChild(command, args, env) {
  const child = spawnSync(command, args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const error = new Error(`${command} exited with status ${child.status ?? 1}`);
    error.exitCode = child.status ?? 1;
    throw error;
  }
}

export async function runSeasonalImportV3DbTest(env = process.env) {
  const database = parseDisposableDatabaseConfig(env);
  const client = new Client({
    connectionString: database.connectionString,
    application_name: 'seasonal-import-v3-db-test',
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
  });
  await client.connect();
  try {
    await verifyConnectedDatabaseIdentity(client, database.databaseName);
    await client.query(SUPABASE_TEST_BOOTSTRAP);
    await client.query(await readFile(SCHEMA_FILE, 'utf8'));
    await client.query(PRE_V3_FIXTURE);
    await client.query(await readFile(MIGRATION_FILE, 'utf8'));
    await client.query(await readFile(SQL_TEST_FILE, 'utf8'));
  } finally {
    await client.end();
  }

  runChild(process.execPath, [LOAD_TEST_FILE, '--mode', 'concurrency'], {
    ...env,
    SEASONAL_TEST_DATABASE_URL: database.connectionString,
    SEASONAL_TEST_TEMP_DB: '1',
  });
}

try {
  await runSeasonalImportV3DbTest();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
