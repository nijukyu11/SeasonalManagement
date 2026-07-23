import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';
import { bootstrapFixtureSql } from './seasonal_source_import_v2_pglite.mjs';

const v2MigrationUrl = new URL(
  '../migrations/20260718090000_seasonal_source_import_v2.sql',
  import.meta.url,
);
const v3MigrationUrl = new URL(
  '../migrations/20260724090000_seasonal_partial_import_v3.sql',
  import.meta.url,
);
const testUrl = new URL('./seasonal_partial_import_v3.sql', import.meta.url);

const preV3FixtureSql = `
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
  data_version
) values
  ('season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6', 'S26', 'S26', 7),
  ('season-29cbca13-e11d-4b75-bcaa-00a6c5ca68c6', 'W26', 'W26', 9);

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

const db = await createSupabasePGlite();
const startedAt = Date.now();

try {
  await db.exec(bootstrapFixtureSql);
  await db.exec(await readFile(v2MigrationUrl, 'utf8'));
  await db.exec(preV3FixtureSql);
  const migrationSql = await readFile(v3MigrationUrl, 'utf8');
  await db.exec(migrationSql);
  await db.exec(migrationSql);
  await db.exec(await readFile(testUrl, 'utf8'));
  console.log(JSON.stringify({
    suite: 'seasonal_partial_import_v3.sql',
    engine: 'PGlite',
    v2MigrationRuns: 1,
    v3MigrationRuns: 2,
    elapsedMs: Date.now() - startedAt,
    status: 'passed',
  }));
} finally {
  await db.close();
}
