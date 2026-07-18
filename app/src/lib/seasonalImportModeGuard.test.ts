import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function requireSqlSection(source: string, pattern: RegExp, label: string): string {
  const section = source.match(pattern)?.[0];
  assert.ok(section, `${label} must be present`);
  return section.replace(/\r\n/g, '\n');
}

test('main Seasonal import uses server-side transaction import and does not call direct remote write sequence', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  assert.match(source, /buildSeasonalImportPatch/);
  assert.match(source, /applySeasonalImportRemote\(/);
  assert.match(source, /sourceRows: \[\]/);
  assert.match(source, /totalSourceRows: 0/);
  assert.doesNotMatch(source, /await clearSourceRows\(seasonId\)/);
  assert.doesNotMatch(source, /await deleteModifications\(seasonId, modificationDeleteRecordIds\)/);
  assert.doesNotMatch(source, /await batchWriteFlightRecords\(seasonId, recordsToWrite/);
  assert.doesNotMatch(source, /clearSeasonBaseline/);
  assert.doesNotMatch(source, /batchWriteSourceRows/);
});

test('remote store exposes server-side seasonal import transaction contract', () => {
  const remoteStoreSource = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  assert.match(remoteStoreSource, /interface RemoteSeasonalImportInput/);
  assert.match(remoteStoreSource, /applySeasonalImportRemote\(input: RemoteSeasonalImportInput\): Promise<RemoteSeasonalImportResult>/);
  assert.match(supabaseStoreSource, /rpc\('apply_seasonal_import_remote'/);
  assert.match(supabaseStoreSource, /p_import/);
  assert.match(supabaseStoreSource, /p_payload/);
  assert.match(supabaseStoreSource, /callSeasonalImportRpcRawPayload/);
  assert.match(supabaseStoreSource, /\/rest\/v1\/rpc\/apply_seasonal_import_remote/);
});

test('server workspace window uses paged server fallback for transient RPC fetch failures', () => {
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  assert.match(supabaseStoreSource, /function isTransientFetchFailureError\(error: unknown\): boolean/);
  assert.match(
    supabaseStoreSource,
    /isMissingRpcSignatureError\(error\) \|\| isStatementTimeoutError\(error\) \|\| isTransientFetchFailureError\(error\)/
  );
  assert.match(supabaseStoreSource, /return loadSeasonWorkspaceWindowPaged\(input\)/);
});

test('Supabase auth survives self-hosted cutover storage and JWT refresh', () => {
  const supabaseSource = readFileSync(join(root, 'lib', 'supabase.ts'), 'utf8');
  const authGateSource = readFileSync(join(root, 'app', 'components', 'OperatorAuthGate.tsx'), 'utf8');
  assert.match(supabaseSource, /seasonal-management-supabase-auth-token/);
  assert.match(supabaseSource, /sb-rhmehiinfchiiuqmdukz-auth-token/);
  assert.match(supabaseSource, /sb-supabase-auth-token/);
  assert.match(authGateSource, /refreshSession\(data\.session\)/);
  assert.match(authGateSource, /refreshSession\(refreshed\.data\.session \?\? data\.session\)/);
  assert.match(authGateSource, /resolveOperatorLoginIdentity/);
  assert.match(authGateSource, /username,display_name/);
  assert.match(authGateSource, /operatorLabel/);
});

test('app operator schema supports username login metadata without changing auth uid authorization', () => {
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  assert.match(schemaSource, /username text/);
  assert.match(schemaSource, /display_name text/);
  assert.match(schemaSource, /app_operators_username_unique/);
  assert.match(schemaSource, /where username is not null/);
  assert.match(schemaSource, /where user_id = auth\.uid\(\)/);
});

test('app operator schema includes role permissions with server-side write boundary', () => {
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const migrationSource = readFileSync(join(root, '..', 'supabase', 'migrations', '20260624090000_operator_roles_user_management.sql'), 'utf8');
  assert.match(schemaSource, /create table if not exists public\.app_roles/);
  assert.match(schemaSource, /create table if not exists public\.app_role_permissions/);
  assert.match(schemaSource, /create table if not exists public\.app_operator_roles/);
  assert.match(schemaSource, /create table if not exists public\.app_operator_permission_overrides/);
  assert.match(schemaSource, /public\.app_operator_has_permission_for\(p_user_id uuid, p_permission_key text\)/);
  assert.match(schemaSource, /public\.app_operator_has_permission\(p_permission_key text\)/);
  assert.match(schemaSource, /'super_admin'/);
  assert.match(schemaSource, /'ops_admin'/);
  assert.match(schemaSource, /'schedule_planner'/);
  assert.match(schemaSource, /'resource_coordinator'/);
  assert.match(schemaSource, /'viewer'/);
  assert.match(schemaSource, /grant execute on function public\.app_operator_has_permission_for\(uuid, text\) to authenticated/);
  assert.match(schemaSource, /drop policy if exists "app operators can write" on public\.app_operator_roles/);
  assert.doesNotMatch(schemaSource, /create policy "app operators can write" on public\.app_operator_roles/);
  assert.match(migrationSource, /grant select on public\.app_operator_roles to authenticated/);
  assert.match(migrationSource, /username, ''\)\) = 'admin'/);
  assert.match(migrationSource, /'users.manage'/);
});

test('operator display uses app profile username and display name when available', () => {
  const sidebarSource = readFileSync(join(root, 'app', 'components', 'AppSidebar.tsx'), 'utf8');
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  const auditSource = readFileSync(join(root, 'app', 'audit', 'page.tsx'), 'utf8');
  assert.match(sidebarSource, /operatorAuth\.operatorLabel/);
  assert.match(supabaseStoreSource, /username,display_name/);
  assert.match(supabaseStoreSource, /operator\?\.display_name/);
  assert.match(supabaseStoreSource, /user_metadata\?\.full_name \?\? username/);
  assert.match(auditSource, /session\.actor\.displayName \?\? session\.actor\.email \?\? 'Anonymous'/);
});

test('Settings keeps the explicit full-season repair import path', () => {
  const settingsSource = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
  const repairSource = readFileSync(join(root, 'app', 'settings', 'components', 'SeasonRepairTab.tsx'), 'utf8');
  assert.match(settingsSource, /handleSeasonRepairImport/);
  assert.match(settingsSource, /clearSeasonBaseline\(seasonId\)/);
  assert.match(settingsSource, /loadSeasonWorkspaceWindow\(\{/);
  assert.doesNotMatch(settingsSource, /\b(?:query|import|check)Native/);
  assert.match(settingsSource, /totalSourceRows: 0/);
  assert.doesNotMatch(settingsSource, /batchWriteSourceRows/);
  assert.match(repairSource, /Seasonal Full Replace/);
});

test('remote source-row mutation APIs remain disabled for seasonal atomic data', () => {
  const source = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  assert.match(source, /return \[\]/);
  assert.match(source, /Source row writes are disabled\. Seasonal data is stored as atomic flight records\./);
  assert.match(source, /export async function addSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function deleteSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function linkSourceRows[\s\S]*throw sourceRowWritesDisabled\(\)/);
});

test('seasonal source import V2 stages canonical rows behind a permissioned RPC', () => {
  const migrationSource = readFileSync(
    join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'),
    'utf8'
  );
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const importBatchTablePattern = /create table if not exists public\.season_import_batches[\s\S]*?\n\);/i;
  const importBatchRowsTablePattern = /create table if not exists public\.season_import_batch_rows[\s\S]*?\n\);/i;
  const stageFunctionPattern = /create or replace function public\.stage_seasonal_import_v2\(p_import jsonb\)[\s\S]*?\n\$\$;/i;
  const preserveFingerprintFunctionPattern = /create or replace function public\.preserve_season_import_batch_staging_metadata_v2\(\)[\s\S]*?\n\$\$;/i;
  const preserveFingerprintTriggerPattern = /drop trigger if exists preserve_season_import_batch_staging_metadata_v2[\s\S]*?execute function public\.preserve_season_import_batch_staging_metadata_v2\(\);/i;

  for (const [label, pattern] of [
    ['season_import_batches table', importBatchTablePattern],
    ['season_import_batch_rows table', importBatchRowsTablePattern],
    ['staging metadata trigger function', preserveFingerprintFunctionPattern],
    ['staging metadata trigger', preserveFingerprintTriggerPattern],
    ['stage_seasonal_import_v2 function', stageFunctionPattern],
  ] as const) {
    assert.equal(
      requireSqlSection(schemaSource, pattern, `${label} in schema.sql`),
      requireSqlSection(migrationSource, pattern, `${label} in migration`),
      `${label} must stay byte-for-byte equivalent between migration and schema.sql`
    );
  }

  for (const source of [migrationSource, schemaSource]) {
    const stageFunctionSource = source.match(stageFunctionPattern)?.[0];
    const preserveFingerprintFunctionSource = source.match(preserveFingerprintFunctionPattern)?.[0];
    assert.ok(stageFunctionSource, 'stage_seasonal_import_v2 body must be present');
    assert.ok(
      preserveFingerprintFunctionSource,
      'preserve_season_import_batch_staging_metadata_v2 body must be present'
    );
    assert.match(source, /create table if not exists public\.season_import_batches/);
    assert.match(source, /create table if not exists public\.season_import_batch_rows/);
    assert.match(source, /alter table public\.season_import_batches enable row level security/);
    assert.match(source, /alter table public\.season_import_batch_rows enable row level security/);
    assert.match(source, /revoke all on table public\.season_import_batches from public, anon, authenticated/);
    assert.match(source, /revoke all on table public\.season_import_batch_rows from public, anon, authenticated/);
    assert.match(source, /grant execute on function public\.stage_seasonal_import_v2\(jsonb\) to authenticated/);
    assert.match(stageFunctionSource, /public\.app_operator_has_permission\('seasonal\.write'\)/);
    assert.match(stageFunctionSource, /set search_path = pg_catalog, pg_temp/);
    assert.match(stageFunctionSource, /on conflict \(request_id\) do nothing/);
    assert.match(stageFunctionSource, /requestFingerprint/);
    assert.match(stageFunctionSource, /v_request_fingerprint/);
    assert.match(stageFunctionSource, /pg_catalog\.sha256/);
    assert.match(stageFunctionSource, /v_batch\.result #>> '\{_staging,requestFingerprint\}'/);
    assert.match(stageFunctionSource, /jsonb_agg\(rows\.row_data order by rows\.row_index\)/);
    assert.match(stageFunctionSource, /v_persisted_source_rows is distinct from v_canonical_source_rows/);
    assert.match(stageFunctionSource, /duplicate-row-index/);
    assert.match(stageFunctionSource, /Ambiguous seasonCode/);
    assert.match(stageFunctionSource, /lock table public\.seasons in share mode/);
    assert.match(stageFunctionSource, /octet_length\(p_import::text\) > 67108864/);
    assert.match(stageFunctionSource, /char_length\(v_season_code\) > 32/);
    assert.match(stageFunctionSource, /char_length\(v_requested_season_id\) > 256/);
    assert.match(stageFunctionSource, /field-too-long/);
    assert.match(stageFunctionSource, /jsonb_array_length\(v_source_rows\) > 100000/);
    assert.match(stageFunctionSource, /char_length\(v_checksum\) > 256/);
    assert.match(stageFunctionSource, /char_length\(v_file_name\) > 1024/);
    assert.match(
      stageFunctionSource,
      /insert into public\.season_import_batch_rows[\s\S]*select[\s\S]*jsonb_array_elements\([\s\S]*with ordinality/i
    );
    assert.doesNotMatch(stageFunctionSource, /\bto_date\s*\(/i);
    assert.doesNotMatch(stageFunctionSource, /v_batch\.created_by is distinct from auth\.uid\(\)/);
    assert.doesNotMatch(stageFunctionSource, /flightRecords/);
    assert.doesNotMatch(
      stageFunctionSource,
      /for\s+v_record\s+in\s+select[\s\S]*jsonb_array_elements/i
    );
    assert.match(preserveFingerprintFunctionSource, /old\.result->'_staging'/);
    assert.match(source, /before update of result on public\.season_import_batches/);
    assert.match(
      source,
      /revoke execute on function public\.preserve_season_import_batch_staging_metadata_v2\(\)[\s\S]*from public, anon, authenticated/
    );
  }
});

test('seasonal source import V2 SQL suite preserves runtime regression fixtures', () => {
  const sqlTestSource = readFileSync(
    join(root, '..', 'supabase', 'tests', 'seasonal_source_import_v2.sql'),
    'utf8'
  );

  assert.match(sqlTestSource, /^begin;/);
  assert.match(sqlTestSource, /set local role authenticated/);
  assert.match(sqlTestSource, /2026-02-31/);
  assert.match(sqlTestSource, /2026-04-31/);
  assert.match(sqlTestSource, /2028-02-29/);
  assert.match(sqlTestSource, /strict-canonical-json-types/);
  assert.match(sqlTestSource, /duplicate-logical-row-index/);
  assert.match(sqlTestSource, /same-checksum retry with changed sourceRows was not rejected/);
  assert.match(sqlTestSource, /invalid payload corrected under the same request identity was not rejected/);
  assert.match(sqlTestSource, /request fingerprint was not preserved across result update/);
  assert.match(sqlTestSource, /p_import exceeds maximum size of 67108864 bytes/);
  assert.match(sqlTestSource, /seasonCode exceeds maximum length of 32/);
  assert.match(sqlTestSource, /seasonId exceeds maximum length of 256/);
  assert.match(sqlTestSource, /field-too-long/);
  assert.match(sqlTestSource, /sourceRows exceeds maximum of 100000 rows/);
  assert.match(sqlTestSource, /Ambiguous seasonCode/);
  assert.match(sqlTestSource, /rollback;\s*$/);
});

test('seasonal source import V2 tracks a bounded real-PostgreSQL concurrency harness', () => {
  const concurrencySource = readFileSync(
    join(root, '..', 'supabase', 'tests', 'seasonal_source_import_v2_concurrency.mjs'),
    'utf8'
  );

  assert.match(concurrencySource, /new Client\(/);
  assert.match(concurrencySource, /Promise\.all\(/);
  assert.match(concurrencySource, /stage_seasonal_import_v2/);
  assert.match(concurrencySource, /connectionTimeoutMillis: 5_000/);
  assert.match(concurrencySource, /query_timeout: 35_000/);
  assert.match(concurrencySource, /60_000/);
  assert.match(concurrencySource, /SEASONAL_TEST_TEMP_DB/);
  assert.match(concurrencySource, /PGlite cannot prove multi-session locking/);
  assert.match(concurrencySource, /season lookup race/);
  assert.match(
    concurrencySource,
    /count\(\*\)[\s\S]*season_import_batches[\s\S]*count\(\*\)[\s\S]*season_import_batch_rows/i
  );
});
