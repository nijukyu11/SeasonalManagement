import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
  assert.match(settingsSource, /sourceRows: \[\]/);
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
