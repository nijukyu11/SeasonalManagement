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

test('main Seasonal import sends canonical source rows and never builds client atomic import arrays', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const importStart = source.indexOf('const handleFile = useCallback');
  const importEnd = source.indexOf('const handleRowDoubleClick', importStart);
  const importSource = source.slice(importStart, importEnd);
  const refreshStart = source.indexOf('const applyTargetedCommittedImportRefresh = useCallback');
  const refreshEnd = source.indexOf('const loadSeasonRows = useCallback', refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  const rpcStart = importSource.indexOf('attemptedImport = {');
  const rpcEnd = importSource.indexOf('setPendingImportAttempt(attemptedImport)', rpcStart);
  const rpcInputSource = importSource.slice(rpcStart, rpcEnd);

  assert.match(importSource, /canonicalizeSeasonalImportSourceRows\(parsedRows\)/);
  assert.match(importSource, /buildSeasonalImportV2Checksum\(seasonCode, sourceRows\)/);
  assert.match(importSource, /deriveSeasonalImportV2RequestId\(/);
  assert.match(importSource, /setPendingImportAttempt\(attemptedImport\)[\s\S]*applySeasonalImportRemote\(attemptedImport\)/);
  assert.match(rpcInputSource, /sourceRows/);
  assert.match(refreshSource, /refreshed\.window\.records/);
  assert.match(refreshSource, /refreshed\.window\.modifications/);
  assert.doesNotMatch(importSource, /flattenRowsToFlightRecords/);
  assert.doesNotMatch(importSource, /mergeDuplicateImportRecords/);
  assert.doesNotMatch(importSource, /buildSeasonalImportPatch/);
  assert.doesNotMatch(importSource, /modificationDeleteRecordIds/);
  assert.doesNotMatch(rpcInputSource, /flightRecords\s*:/);
  assert.doesNotMatch(importSource, /sourceRows:\s*\[\]/);
  assert.doesNotMatch(importSource, /await clearSourceRows\(/);
  assert.doesNotMatch(importSource, /await batchWriteFlightRecords\(/);
});

test('remote store performs the exact stage-then-commit V2 RPC sequence without compatibility fallback', () => {
  const remoteStoreSource = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  const methodStart = supabaseStoreSource.indexOf('async applySeasonalImportRemote');
  const methodEnd = supabaseStoreSource.indexOf('async applySeasonServerMutationV1', methodStart);
  const methodSource = supabaseStoreSource.slice(methodStart, methodEnd);
  const stageCall = methodSource.indexOf("rpc('stage_seasonal_import_v2'");
  const commitCall = methodSource.indexOf("rpc('commit_seasonal_import_v2'");
  const payloadBody = methodSource.match(/const payload = \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(payloadBody, 'the V2 p_import payload must be declared inline');
  const payloadKeys = payloadBody.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9]*)(?::|,)/);
    return match ? [match[1]] : [];
  });

  assert.match(remoteStoreSource, /interface RemoteSeasonalImportInput/);
  assert.match(remoteStoreSource, /applySeasonalImportRemote\(input: RemoteSeasonalImportInput\): Promise<RemoteSeasonalImportResult>/);
  assert.deepEqual(payloadKeys, [
    'requestId',
    'checksum',
    'seasonId',
    'seasonCode',
    'expectedDataVersion',
    'fileName',
    'uploadedAt',
    'sourceRows',
  ]);
  assert.ok(stageCall >= 0, 'stage_seasonal_import_v2 must be called');
  assert.ok(commitCall > stageCall, 'commit_seasonal_import_v2 must run only after staging');
  assert.match(methodSource, /runSeasonalImportV2RpcFlow\(payload/);
  assert.match(methodSource, /p_import:\s*attempt/);
  assert.match(methodSource, /p_batch_id:\s*batchId/);
  assert.match(methodSource, /p_expected_data_version:\s*version/);
  assert.match(methodSource, /canonicalizeSeasonalImportSourceRows\(input\.sourceRows\)/);
  assert.match(methodSource, /assertSeasonalImportRpcOk/);
  assert.match(supabaseStoreSource, /result\.error\.code[\s\S]*SeasonalImportV2RpcRejectedError/);
  assert.doesNotMatch(methodSource, /\bactor\b/);
  assert.doesNotMatch(methodSource, /flightRecords|flight_records|source_rows/);
  assert.doesNotMatch(supabaseStoreSource, /callSeasonalImportRpcRawPayload/);
  assert.doesNotMatch(supabaseStoreSource, /rpc\('apply_seasonal_import_remote'/);
  assert.doesNotMatch(supabaseStoreSource, /\/rest\/v1\/rpc\/apply_seasonal_import_remote/);
});

test('committed seasonal import refresh failures have a dedicated non-retry UI branch', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const contractSource = readFileSync(join(root, 'lib', 'seasonalImportRpcContract.ts'), 'utf8');
  const importStart = source.indexOf('const handleFile = useCallback');
  const importEnd = source.indexOf('const handleRowDoubleClick', importStart);
  const importSource = source.slice(importStart, importEnd);

  assert.match(importSource, /buildSeasonalImportCommittedRefreshFailure/);
  assert.match(contractSource, /Import committed, refresh failed/);
  assert.match(importSource, /return;/);
  assert.doesNotMatch(importSource, /retry.*commit|commit.*retry/i);
});

test('seasonal import recovery exposes explicit resume and targeted read-only refresh paths', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const resumeStart = source.indexOf('const handleResumeImportAttempt = useCallback');
  const resumeEnd = source.indexOf('const handleFile = useCallback', resumeStart);
  const refreshStart = source.indexOf('const handlePendingCommittedRefresh = useCallback');
  const refreshEnd = source.indexOf('const handleResumeImportAttempt = useCallback', refreshStart);
  const targetedStart = source.indexOf('const applyTargetedCommittedImportRefresh = useCallback');
  const targetedEnd = source.indexOf('const loadSeasonRows = useCallback', targetedStart);
  const resumeSource = source.slice(resumeStart, resumeEnd);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  const targetedSource = source.slice(targetedStart, targetedEnd);

  assert.match(resumeSource, /resumeSeasonalImportAttemptOnce\(attempt, applySeasonalImportRemote\)/);
  assert.match(resumeSource, /SeasonalImportV2StatusUnknownError/);
  assert.match(resumeSource, /setPendingImportAttempt\(attempt\)/);
  assert.doesNotMatch(resumeSource, /while\s*\(|for\s*\(|retry/i);
  assert.match(refreshSource, /applyTargetedCommittedImportRefresh\(committedImport, operation\)/);
  assert.doesNotMatch(
    refreshSource,
    /applySeasonalImportRemote|resumeSeasonalImportAttemptOnce|stage_seasonal_import_v2|commit_seasonal_import_v2/,
  );
  assert.match(targetedSource, /loadTargetedCommittedImportRefresh/);
  assert.match(targetedSource, /setPendingCommittedImport\(null\)/);
  assert.doesNotMatch(source, /buildCommittedSeasonFallback|replaceSeasonInList/);
  assert.match(source, />\s*Resume\/Check\s*</);
  assert.match(source, />\s*Refresh\s*</);
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
  const resultConstraintBackfillPattern = /do \$\$(?:\r?\n)?begin(?:\r?\n)?  if not exists \((?:\r?\n)?    select 1(?:\r?\n)?    from pg_catalog\.pg_constraint constraints[\s\S]*?season_import_batches_result_object_check[\s\S]*?(?:\r?\n)?\$\$;/i;
  const stageFunctionPattern = /create or replace function public\.stage_seasonal_import_v2\(p_import jsonb\)[\s\S]*?\n\$\$;/i;
  const preserveFingerprintFunctionPattern = /create or replace function public\.preserve_season_import_batch_staging_metadata_v2\(\)[\s\S]*?\n\$\$;/i;
  const preserveFingerprintTriggerPattern = /drop trigger if exists preserve_season_import_batch_staging_metadata_v2[\s\S]*?execute function public\.preserve_season_import_batch_staging_metadata_v2\(\);/i;

  for (const [label, pattern] of [
    ['season_import_batches table', importBatchTablePattern],
    ['season_import_batch_rows table', importBatchRowsTablePattern],
    ['result object constraint backfill', resultConstraintBackfillPattern],
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
    assert.match(stageFunctionSource, /jsonb_array_length\(v_source_rows\) > 20000/);
    assert.match(stageFunctionSource, /char_length\(v_checksum\) > 256/);
    assert.match(stageFunctionSource, /char_length\(v_file_name\) > 1024/);
    assert.match(stageFunctionSource, /canonical source field/i);
    assert.match(stageFunctionSource, /diagnostics-truncated/);
    assert.match(stageFunctionSource, /v_diagnostic_count/);
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
    assert.match(preserveFingerprintFunctionSource, /jsonb_typeof\(new\.result\) <> 'object'/);
    assert.match(preserveFingerprintFunctionSource, /result must be null or a JSON object/);
    assert.match(source, /constraint season_import_batches_result_object_check/);
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
  assert.match(sqlTestSource, /sourceRows exceeds maximum of 20000 rows/);
  assert.match(sqlTestSource, /oversized Airline probe persisted a batch or row/);
  assert.match(sqlTestSource, /near-limit canonical fields were rejected/);
  assert.match(sqlTestSource, /diagnostics-truncated/);
  assert.match(sqlTestSource, /scalar result update was not rejected/);
  assert.match(sqlTestSource, /array result update was not rejected/);
  assert.match(sqlTestSource, /Ambiguous seasonCode/);
  assert.match(sqlTestSource, /rollback;\s*$/);
});

test('seasonal export V2 uses one strict permissioned full snapshot in migration and schema', () => {
  const migrationSource = readFileSync(
    join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'),
    'utf8'
  );
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const functionPattern = /create or replace function public\.get_seasonal_export_snapshot_v2\([\s\S]*?\n\$\$;/i;
  const migrationFunction = requireSqlSection(migrationSource, functionPattern, 'export snapshot function in migration');
  const schemaFunction = requireSqlSection(schemaSource, functionPattern, 'export snapshot function in schema');

  assert.equal(schemaFunction, migrationFunction);
  for (const source of [migrationSource, schemaSource]) {
    const body = requireSqlSection(source, functionPattern, 'export snapshot function');
    assert.match(body, /app_operator_has_permission\('seasonal\.read'\)/);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = pg_catalog, pg_temp/i);
    assert.match(body, /'flightRecords'/);
    assert.match(body, /'flightRecordCounters'/);
    assert.match(body, /'flightRecordWindows'/);
    assert.match(body, /'modifications'/);
    assert.match(body, /'modificationCounters'/);
    assert.match(body, /'modificationWindows'/);
    assert.match(body, /'modificationAddedLegs'/);
    assert.match(body, /'truncated', false/);
    assert.doesNotMatch(body, /operational_date\s*(?:>=|<=|between)/i);
    assert.doesNotMatch(body, /\blimit\b/i);
    assert.match(source, /revoke execute on function public\.get_seasonal_export_snapshot_v2\(text, integer\) from public, anon/);
    assert.match(source, /grant execute on function public\.get_seasonal_export_snapshot_v2\(text, integer\) to authenticated/);
  }
});

test('seasonal source import V2 tracks a bounded real-PostgreSQL concurrency harness', () => {
  const concurrencySource = readFileSync(
    join(root, '..', 'supabase', 'tests', 'seasonal_source_import_v2_concurrency.mjs'),
    'utf8'
  );
  const packageJson = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };

  assert.match(concurrencySource, /new Client\(/);
  assert.match(concurrencySource, /Promise\.all\(/);
  assert.match(concurrencySource, /stage_seasonal_import_v2/);
  assert.match(concurrencySource, /connectionTimeoutMillis: 5_000/);
  assert.match(concurrencySource, /const QUERY_TIMEOUT_MS = 35_000/);
  assert.match(concurrencySource, /query_timeout: QUERY_TIMEOUT_MS/);
  assert.match(concurrencySource, /const HARD_TIMEOUT_MS = 60_000/);
  assert.match(concurrencySource, /const CLEANUP_RESERVE_MS = 10_000/);
  assert.match(concurrencySource, /const SCENARIO_TIMEOUT_MS = HARD_TIMEOUT_MS - CLEANUP_RESERVE_MS/);
  assert.match(concurrencySource, /hardDeadline = harnessStartedAt \+ HARD_TIMEOUT_MS/);
  assert.match(concurrencySource, /hardDeadline - Date\.now\(\)/);
  assert.match(concurrencySource, /SEASONAL_TEST_TEMP_DB/);
  assert.match(concurrencySource, /PGlite cannot prove multi-session locking/);
  assert.match(concurrencySource, /season lookup race/);
  assert.match(concurrencySource, /AbortController/);
  assert.match(concurrencySource, /pg_terminate_backend/);
  assert.match(concurrencySource, /AggregateError/);
  assert.match(concurrencySource, /cleanupErrors/);
  assert.match(concurrencySource, /finally/);
  assert.doesNotMatch(concurrencySource, /process\.exit/);
  assert.doesNotMatch(concurrencySource, /\.catch\(\(\) => \{\}\)/);
  assert.ok(packageJson.devDependencies?.pg, 'pg must be an explicit devDependency');
  assert.ok(
    packageJson.devDependencies?.['@electric-sql/pglite'],
    '@electric-sql/pglite must be an explicit devDependency'
  );
  assert.match(
    concurrencySource,
    /count\(\*\)[\s\S]*season_import_batches[\s\S]*count\(\*\)[\s\S]*season_import_batch_rows/i
  );
});

test('schema reset drops staging children first and tracks an executable rerun regression', () => {
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const schemaTwiceSource = readFileSync(
    join(root, '..', 'supabase', 'tests', 'seasonal_schema_twice.mjs'),
    'utf8'
  );
  const rowDrop = schemaSource.indexOf('drop table if exists public.season_import_batch_rows cascade;');
  const batchDrop = schemaSource.indexOf('drop table if exists public.season_import_batches cascade;');
  const seasonDrop = schemaSource.indexOf('drop table if exists public.seasons cascade;');

  assert.ok(rowDrop >= 0, 'schema reset must drop season_import_batch_rows');
  assert.ok(batchDrop > rowDrop, 'schema reset must drop season_import_batches after rows');
  assert.ok(seasonDrop > batchDrop, 'schema reset must drop seasons after staging tables');
  assert.match(schemaTwiceSource, /await runSchema\('first'\)/);
  assert.match(schemaTwiceSource, /await runSchema\('second'\)/);
  assert.match(schemaTwiceSource, /season_import_batches_season_id_fkey/);
  assert.match(schemaTwiceSource, /23503/);
  assert.match(schemaTwiceSource, /orphan seasonal import batch was accepted/);
});
