import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('main Seasonal import sends canonical source rows and reconciles exactly once', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  assert.match(source, /buildSeasonalImportChecksum/);
  assert.match(source, /getOrCreateSeasonClientId\(\)/);
  assert.match(source, /applySeasonalImportRemote\(/);
  assert.match(source, /sourceRows: rows/);
  assert.match(source, /revalidateSeasonWorkspaceAfterMutation\(/);
  assert.doesNotMatch(source, /buildSeasonalImportPatch/);
  assert.doesNotMatch(source, /mergeDuplicateImportRecords/);
  assert.doesNotMatch(source, /modificationDeleteRecordIds/);
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
  assert.match(remoteStoreSource, /requestId: string/);
  assert.match(remoteStoreSource, /clientId: string/);
  assert.match(remoteStoreSource, /expectedDataVersion: number \| null/);
  assert.match(supabaseStoreSource, /rpc\('stage_seasonal_import_v2'/);
  assert.match(supabaseStoreSource, /rpc\('commit_seasonal_import_v2'/);
  assert.match(supabaseStoreSource, /\['validated', 'committed'\]\.includes/);
  assert.match(supabaseStoreSource, /p_import/);
  assert.match(supabaseStoreSource, /parseSeasonalImportV2Result/);
  assert.doesNotMatch(supabaseStoreSource, /callSeasonalImportRpcRawPayload/);
  assert.doesNotMatch(supabaseStoreSource, /rpc\('apply_seasonal_import_remote'/);
});

test('server workspace window never fans out to direct-table fallback', () => {
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  const methodStart = supabaseStoreSource.indexOf('async getSeasonWorkspaceWindow');
  const methodEnd = supabaseStoreSource.indexOf('async getSeasonWorkspaceSnapshot', methodStart);
  const method = supabaseStoreSource.slice(methodStart, methodEnd);
  assert.match(method, /shouldUseLegacyWorkspaceWindowRpc\(error\)/);
  assert.doesNotMatch(method, /loadSeasonWorkspaceWindowPaged\(/);
  assert.doesNotMatch(method, /isStatementTimeoutError\(error\)/);
  assert.doesNotMatch(method, /isTransientFetchFailureError\(error\)/);
});

test('import V2 schema stages canonical rows set-wise and commits atomically', () => {
  const migrationSource = readFileSync(join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'), 'utf8');
  assert.match(migrationSource, /create table if not exists public\.season_import_batches/);
  assert.match(migrationSource, /client_id text not null/);
  assert.match(migrationSource, /create table if not exists public\.season_import_batch_rows/);
  assert.match(migrationSource, /create or replace function public\.stage_seasonal_import_v2\(p_import jsonb\)/);
  assert.match(migrationSource, /create or replace function public\.generate_seasonal_import_records_v2\(p_batch_id uuid\)/);
  assert.match(migrationSource, /create or replace function public\.commit_seasonal_import_v2\(p_batch_id uuid, p_expected_data_version integer\)/);
  assert.match(migrationSource, /public\.app_operator_has_permission\('seasonal\.write'\)/);
  assert.match(migrationSource, /jsonb_array_elements\(p_import->'sourceRows'\) with ordinality/);
  assert.doesNotMatch(migrationSource, /for\s+v_record\s+in\s+select[\s\S]*jsonb_array_elements\([\s\S]*flightRecords/i);
});

test('Supabase auth survives self-hosted cutover without remounting on token refresh', () => {
  const supabaseSource = readFileSync(join(root, 'lib', 'supabase.ts'), 'utf8');
  const authGateSource = readFileSync(join(root, 'app', 'components', 'OperatorAuthGate.tsx'), 'utf8');
  assert.match(supabaseSource, /seasonal-management-supabase-auth-token/);
  assert.match(supabaseSource, /sb-rhmehiinfchiiuqmdukz-auth-token/);
  assert.match(supabaseSource, /sb-supabase-auth-token/);
  assert.match(authGateSource, /resolveOperatorAuthSessionAction\(/);
  assert.match(authGateSource, /handleAuthSession\('BOOTSTRAP', data\.session\)/);
  assert.match(authGateSource, /createOperatorVerificationSingleFlight/);
  assert.doesNotMatch(authGateSource, /supabase\.auth\.refreshSession\(/);
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
  assert.match(settingsSource, /applySeasonalImportRemote\(/);
  assert.match(settingsSource, /sourceRows: rows/);
  assert.match(settingsSource, /revalidateSeasonWorkspaceAfterMutation\(/);
  assert.doesNotMatch(settingsSource, /clearSeasonBaseline\(seasonId\)/);
  assert.doesNotMatch(settingsSource, /loadSeasonWorkspaceWindow\(\{/);
  assert.doesNotMatch(settingsSource, /\b(?:query|import|check)Native/);
  assert.doesNotMatch(settingsSource, /batchWriteSourceRows/);
  assert.match(repairSource, /Seasonal Full Replace/);
});

test('source rows remain readable provenance while row-level mutation APIs stay disabled', () => {
  const source = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  const supabaseSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  assert.match(source, /getRemoteStore\(\)\)\.getSourceRows\(seasonId\)/);
  assert.match(supabaseSource, /fromSourceRowRows\(row, dayRows\)/);
  assert.match(source, /Imported source rows are read-only provenance/);
  assert.match(source, /export async function addSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function deleteSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function linkSourceRows[\s\S]*throw sourceRowWritesDisabled\(\)/);
});
