import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const migrationUrl = new URL(
  '../migrations/20260724090000_seasonal_partial_import_v3.sql',
  import.meta.url,
);
const testUrl = new URL('./seasonal_partial_import_v3.sql', import.meta.url);

const bootstrapFixtureSql = `
create table public.seasons (
  id text primary key,
  season_code text not null,
  name text not null default '',
  file_name text not null default '',
  uploaded_at bigint not null default 0,
  effective_start text not null default '',
  effective_end text not null default '',
  total_legs integer not null default 0,
  total_source_rows integer not null default 0,
  data_version integer not null default 0,
  last_synced_at bigint
);
create unique index seasons_season_code_unique_idx on public.seasons (season_code);

create table public.season_source_rows (
  season_id text not null references public.seasons(id) on delete cascade,
  row_index integer not null,
  primary key (season_id, row_index)
);

create table public.season_flight_records (
  season_id text not null references public.seasons(id) on delete restrict,
  record_id text primary key,
  source_row_index integer not null default 0
);

create table public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  checksum text not null,
  status text not null check (status in ('staged', 'validated', 'committed', 'failed')),
  source_row_count integer not null default 0,
  generated_record_count integer not null default 0,
  diagnostics jsonb not null default '[]'::jsonb,
  result jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

insert into public.seasons (
  id,
  season_code,
  data_version
) values
  ('season-existing', 'S26', 7),
  ('season-with-source', 'W26', 9);

insert into public.season_source_rows (season_id, row_index)
values ('season-with-source', 1);

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
    'season-existing',
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

const db = await createSupabasePGlite();
const startedAt = Date.now();

try {
  await db.exec(bootstrapFixtureSql);
  const migrationSql = await readFile(migrationUrl, 'utf8');
  await db.exec(migrationSql);
  await db.exec(migrationSql);
  await db.exec(await readFile(testUrl, 'utf8'));
  console.log(JSON.stringify({
    suite: 'seasonal_partial_import_v3.sql',
    engine: 'PGlite',
    migrationRuns: 2,
    elapsedMs: Date.now() - startedAt,
    status: 'passed',
  }));
} finally {
  await db.close();
}
