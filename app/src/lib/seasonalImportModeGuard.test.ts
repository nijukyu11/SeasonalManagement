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

test('Seasonal import V3 schema is additive and preserves V2 RPC signatures', () => {
  const migrationSource = readFileSync(
    join(
      root,
      '..',
      'supabase',
      'migrations',
      '20260724090000_seasonal_partial_import_v3.sql',
    ),
    'utf8',
  );
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');

  for (const source of [migrationSource, schemaSource]) {
    assert.match(source, /contract_version smallint not null default 2/);
    assert.match(source, /apply_strategy text/);
    assert.match(source, /target_existed_at_stage boolean/);
    assert.match(
      source,
      /create table if not exists public\.season_import_batch_records_v3/,
    );
    assert.match(
      source,
      /create table if not exists public\.season_import_batch_preimages_v3/,
    );
    assert.match(source, /source_import_batch_id uuid/);
    assert.match(source, /source_import_staging_row_index integer/);
    assert.match(source, /source_provenance_mode text/);
    assert.match(source, /guard_legacy_existing_season_import_v3/);
  }

  assert.doesNotMatch(
    migrationSource,
    /drop function[^;]*(?:stage|commit|resume)_seasonal_import_v2/i,
  );
  assert.doesNotMatch(
    migrationSource,
    /create or replace function public\.(?:stage|commit|resume)_seasonal_import_v2/i,
  );
});

test('Seasonal import V3 RPCs stay identical in migration and canonical schema', () => {
  const migrationSource = readFileSync(
    join(
      root,
      '..',
      'supabase',
      'migrations',
      '20260724090000_seasonal_partial_import_v3.sql',
    ),
    'utf8',
  );
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const functionNames = [
    'seasonal_import_v3_response',
    'stage_seasonal_import_v3',
    'get_seasonal_import_v3_status',
    'cancel_seasonal_import_v3',
    'commit_seasonal_import_v3',
  ] as const;

  for (const functionName of functionNames) {
    const pattern = new RegExp(
      `create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`,
      'i',
    );
    assert.equal(
      requireSqlSection(schemaSource, pattern, `${functionName} in schema.sql`),
      requireSqlSection(migrationSource, pattern, `${functionName} in migration`),
      `${functionName} must stay byte-for-byte equivalent`,
    );
  }

  const stageSource = requireSqlSection(
    migrationSource,
    /create or replace function public\.stage_seasonal_import_v3\([\s\S]*?\n\$\$;/i,
    'stage_seasonal_import_v3',
  );
  assert.match(stageSource, /public\.stage_seasonal_import_v2\(/);
  assert.match(stageSource, /public\.generate_seasonal_import_records_v2\(/);
  assert.match(stageSource, /insert into public\.season_import_batch_records_v3/);
  assert.match(stageSource, /target_existed_at_stage = v_target_exists/);
  assert.doesNotMatch(stageSource, /insert into public\.season_flight_records/);
  assert.doesNotMatch(stageSource, /update public\.seasons/);
  assert.doesNotMatch(stageSource, /delete from public\.season_flight_records/);
  const commitSource = requireSqlSection(
    migrationSource,
    /create or replace function public\.commit_seasonal_import_v3\([\s\S]*?\n\$\$;/i,
    'commit_seasonal_import_v3',
  );
  assert.match(commitSource, /from public\.season_import_batch_records_v3/);
  assert.match(commitSource, /insert into public\.season_import_batch_preimages_v3/);
  assert.doesNotMatch(commitSource, /generate_seasonal_import_records_v2/);
  assert.match(
    commitSource,
    /if v_batch\.apply_strategy = 'replace' then[\s\S]*delete from public\.season_source_rows[\s\S]*insert into public\.season_source_rows[\s\S]*insert into public\.season_source_row_days/i,
  );
  assert.match(commitSource, /Missing required permission: season\.repair/);
  assert.match(commitSource, /Seasonal import preview counts changed before commit/);
  assert.match(commitSource, /source_provenance_mode = case[\s\S]*then 'full'[\s\S]*else 'fragmented'/);
  assert.match(
    migrationSource,
    /grant execute on function public\.stage_seasonal_import_v3\(jsonb\)[\s\S]*to authenticated/,
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.get_seasonal_import_v3_status\(uuid\)[\s\S]*to authenticated/,
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.cancel_seasonal_import_v3\(uuid\)[\s\S]*to authenticated/,
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.commit_seasonal_import_v3\(uuid, integer, text\)[\s\S]*to authenticated/,
  );
});

test('main Seasonal import sends canonical source rows and never builds client atomic import arrays', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const contractSource = readFileSync(join(root, 'lib', 'seasonalImportV3Contract.ts'), 'utf8');
  const importStart = source.indexOf('const handleFile = useCallback');
  const importEnd = source.indexOf('const handleRowDoubleClick', importStart);
  const importSource = source.slice(importStart, importEnd);
  const commitStart = source.indexOf('const handleCommitImportPreview = useCallback', importStart);
  const commitSource = source.slice(commitStart, importEnd);
  const refreshStart = source.indexOf('const applyTargetedCommittedImportRefresh = useCallback');
  const refreshEnd = source.indexOf('const loadSeasonRows = useCallback', refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  const rpcStart = importSource.indexOf('attemptedImport = await prepareSeasonalImportV3Attempt');
  const rpcEnd = importSource.indexOf('stagePreparedSeasonalImport(attemptedImport', rpcStart);
  const rpcInputSource = importSource.slice(rpcStart, rpcEnd);

  assert.match(importSource, /prepareSeasonalImportV3Attempt\(\{/);
  assert.match(importSource, /strategy:\s*'merge'/);
  assert.match(contractSource, /export async function prepareSeasonalImportV3Attempt/);
  assert.match(contractSource, /canonicalizeSeasonalImportSourceRows\(input\.sourceRows\)/);
  assert.match(contractSource, /buildSeasonalImportV2Checksum\(seasonCode, sourceRows\)/);
  assert.match(contractSource, /deriveSeasonalImportV3RequestId\(\{/);
  assert.match(importSource, /stagePreparedSeasonalImport\(attemptedImport, operation, operatorSessionEpoch\)/);
  assert.match(commitSource, /commitSeasonalImportV3\(\{[\s\S]*batchId:\s*preview\.batchId[\s\S]*previewHash:\s*preview\.previewHash/);
  assert.doesNotMatch(importSource.slice(0, commitStart - importStart), /commitSeasonalImportV3/);
  assert.match(rpcInputSource, /sourceRows/);
  assert.match(refreshSource, /revalidateSeasonWorkspaceAfterMutation\(/);
  assert.match(refreshSource, /refreshedWindow\.records/);
  assert.match(refreshSource, /refreshedWindow\.modifications/);
  assert.doesNotMatch(importSource, /flattenRowsToFlightRecords/);
  assert.doesNotMatch(importSource, /mergeDuplicateImportRecords/);
  assert.doesNotMatch(importSource, /buildSeasonalImportPatch/);
  assert.doesNotMatch(importSource, /modificationDeleteRecordIds/);
  assert.doesNotMatch(rpcInputSource, /flightRecords\s*:/);
  assert.doesNotMatch(importSource, /sourceRows:\s*\[\]/);
  assert.doesNotMatch(importSource, /await clearSourceRows\(/);
  assert.doesNotMatch(importSource, /await batchWriteFlightRecords\(/);
});

test('Seasonal import V3 exposes four isolated server-only transport operations', () => {
  const remoteStoreSource = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  const supabaseStoreSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  const operations = [
    ['stageSeasonalImportV3', 'stage_seasonal_import_v3'],
    ['commitSeasonalImportV3', 'commit_seasonal_import_v3'],
    ['getSeasonalImportV3Status', 'get_seasonal_import_v3_status'],
    ['cancelSeasonalImportV3', 'cancel_seasonal_import_v3'],
  ] as const;

  for (const [methodName, rpcName] of operations) {
    assert.match(
      remoteStoreSource,
      new RegExp(`${methodName}\\?\\([\\s\\S]*?OperatorSessionCheckpointOptions`),
    );
    assert.match(
      remoteStoreSource,
      new RegExp(`export function ${methodName}\\(`),
    );

    const methodStart = supabaseStoreSource.indexOf(`async ${methodName}(`);
    assert.ok(methodStart >= 0, `${methodName} must exist in supabaseStore`);
    const methodEnd = supabaseStoreSource.indexOf('\n  async ', methodStart + 1);
    const methodSource = supabaseStoreSource.slice(
      methodStart,
      methodEnd >= 0 ? methodEnd : undefined,
    );
    assert.match(methodSource, new RegExp(`rpc\\('${rpcName}'`));
    assert.ok(
      (methodSource.match(/options\.assertOperatorSessionCurrent\(\)/g) ?? []).length >= 2,
      `${methodName} must checkpoint the operator session before and after network activity`,
    );
    assert.doesNotMatch(
      methodSource,
      /seasonal_import_v2|applySeasonalImportRemote|resumeSeasonalImportRemote|invokeSupabaseFunction|\.from\(|native|sqlite/i,
    );
  }

  const statusStart = supabaseStoreSource.indexOf('async getSeasonalImportV3Status(');
  const statusEnd = supabaseStoreSource.indexOf('\n  async ', statusStart + 1);
  const statusSource = supabaseStoreSource.slice(statusStart, statusEnd);
  assert.doesNotMatch(statusSource, /stage_seasonal_import_v3|commit_seasonal_import_v3/);
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

  assert.match(remoteStoreSource, /type RemoteSeasonalImportInput = SeasonalImportV2RpcAttempt/);
  assert.match(remoteStoreSource, /applySeasonalImportRemote\?\(input: RemoteSeasonalImportInput, options\?: OperatorSessionCheckpointOptions\): Promise<RemoteSeasonalImportResult>/);
  assert.deepEqual(payloadKeys, [
    'requestId',
    'checksum',
    'mode',
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
  const resumeEnd = source.indexOf('const stagePreparedSeasonalImport = useCallback', resumeStart);
  const refreshStart = source.indexOf('const handlePendingCommittedRefresh = useCallback');
  const refreshEnd = source.indexOf('const handleResumeImportAttempt = useCallback', refreshStart);
  const targetedStart = source.indexOf('const applyTargetedCommittedImportRefresh = useCallback');
  const targetedEnd = source.indexOf('const loadSeasonRows = useCallback', targetedStart);
  const resumeSource = source.slice(resumeStart, resumeEnd);
  const refreshSource = source.slice(refreshStart, refreshEnd);
  const targetedSource = source.slice(targetedStart, targetedEnd);

  assert.match(resumeSource, /checkSeasonalImportV3RecoveryStatusOnce\([\s\S]*getSeasonalImportV3Status\(requestId, \{ operatorSessionEpoch \}\)/);
  assert.match(resumeSource, /setPendingImportAttempt\(receipt\)/);
  assert.doesNotMatch(resumeSource, /stageSeasonalImportV3|commitSeasonalImportV3|applySeasonalImportRemote/);
  assert.doesNotMatch(resumeSource, /while\s*\(|for\s*\(|retry/i);
  assert.match(refreshSource, /applyTargetedCommittedImportRefresh\(committedImport, operation, operatorSessionEpoch\)/);
  assert.doesNotMatch(
    refreshSource,
    /applySeasonalImportRemote|resumeSeasonalImportAttemptOnce|stage_seasonal_import_v2|commit_seasonal_import_v2/,
  );
  assert.match(targetedSource, /revalidateSeasonWorkspaceAfterMutation/);
  assert.doesNotMatch(targetedSource, /loadTargetedCommittedImportRefresh/);
  assert.match(targetedSource, /setPendingCommittedImport\(null\)/);
  assert.doesNotMatch(source, /buildCommittedSeasonFallback|replaceSeasonInList/);
  assert.match(source, />\s*Resume\/Check\s*</);
  assert.match(source, />\s*Refresh\s*</);
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

test('Supabase auth survives self-hosted cutover without remounting on token refresh', () => {
  const supabaseSource = readFileSync(join(root, 'lib', 'supabase.ts'), 'utf8');
  const authGateSource = readFileSync(join(root, 'app', 'components', 'OperatorAuthGate.tsx'), 'utf8');
  assert.match(supabaseSource, /seasonal-management-supabase-auth-token/);
  assert.match(supabaseSource, /sb-rhmehiinfchiiuqmdukz-auth-token/);
  assert.match(supabaseSource, /sb-supabase-auth-token/);
  assert.match(authGateSource, /resolveOperatorAuthSessionAction\(/);
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

test('Settings Seasonal Full Replace uses the permissioned V3 preview pipeline only', () => {
  const settingsSource = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
  const repairSource = readFileSync(join(root, 'app', 'settings', 'components', 'SeasonRepairTab.tsx'), 'utf8');
  const handlerStart = settingsSource.indexOf('const handleSeasonRepairImport');
  const handlerEnd = settingsSource.indexOf('const updateAirlineColor', handlerStart);
  const handlerSource = settingsSource.slice(handlerStart, handlerEnd);

  assert.match(settingsSource, /handleSeasonRepairImport/);
  assert.match(settingsSource, /access\.permissions\.has\('season\.repair'\)/);
  assert.match(handlerSource, /prepareSeasonalImportV3Attempt\(\{/);
  assert.match(handlerSource, /strategy:\s*'replace'/);
  assert.match(handlerSource, /stageSeasonalImportV3\(attemptedImport, \{ operatorSessionEpoch \}\)/);
  assert.match(handlerSource, /commitSeasonalImportV3\(\{[\s\S]*previewHash:\s*preview\.previewHash/);
  assert.match(settingsSource, /revalidateSeasonWorkspaceAfterMutation\(\{/);
  assert.doesNotMatch(settingsSource, /loadTargetedCommittedImportRefresh\(\{/);
  assert.match(handlerSource, /buildSeasonalImportV3RecoveryReceipt\(preview\)/);
  assert.match(handlerSource, /persistSeasonalImportV3RecoveryReceipt\(sessionStorage, receipt\)/);
  assert.ok(
    handlerSource.indexOf('persistSeasonalImportV3RecoveryReceipt(sessionStorage, receipt)')
      < handlerSource.indexOf('commitSeasonalImportV3({'),
    'the minimal recovery receipt must be durable before Settings issues commit',
  );
  assert.match(handlerSource, /checkSeasonalImportV3RecoveryStatusOnce\([\s\S]*getSeasonalImportV3Status/);
  assert.match(handlerSource, /buildSeasonalImportCommittedRefreshFailure/);
  assert.match(handlerSource, /committedSeasonalImportV3FromRecoveryReceipt\(receipt\)/);
  assert.match(settingsSource, /strategyLocked/);
  assert.doesNotMatch(handlerSource, /flattenRowsToFlightRecords|mergeDuplicateImportRecords|assertNoDuplicateFlightNumbers/);
  assert.doesNotMatch(handlerSource, /clearSeasonBaseline|batchWriteFlightRecords|verifySeasonImportCounts/);
  assert.doesNotMatch(handlerSource, /callSeasonalImportRpcRawPayload|apply_seasonal_import_remote/);
  assert.doesNotMatch(handlerSource, /\b(?:queryNative|importNative|checkNative)\b|SQLite|catch-?up|fallback/i);
  assert.doesNotMatch(settingsSource, /useSessionState<RemoteSeasonalImportInput \| null>/);
  assert.doesNotMatch(handlerSource, /sessionStorage\.setItem\([^\n]*(?:sourceRows|attemptedImport)/);
  assert.match(repairSource, /Seasonal Full Replace/);
  assert.match(repairSource, /canRepairSeason/);
  assert.match(repairSource, /Resume\/Check/);
  assert.match(repairSource, />\s*Refresh\s*</);
});

test('Seasonal remote stores expose provenance reads and no direct source-row/import compatibility mutations', () => {
  const remoteSource = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  const supabaseSource = readFileSync(join(root, 'lib', 'supabaseStore.ts'), 'utf8');
  const seasonalSource = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  const settingsSource = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
  const interfaceStart = remoteSource.indexOf('export interface RemoteStore');
  const interfaceEnd = remoteSource.indexOf('let cachedStore', interfaceStart);
  const exportsStart = remoteSource.indexOf('export function getRemoteStore');
  const exportsEnd = remoteSource.indexOf('export async function getModifications', exportsStart);
  const publicSeasonalApi = `${remoteSource.slice(interfaceStart, interfaceEnd)}\n${remoteSource.slice(exportsStart, exportsEnd)}`;
  const forbidden = [
    'clearFlightRecords',
    'clearSourceRows',
    'clearModifications',
    'clearModHistory',
    'clearSeasonBaseline',
    'batchWriteSourceRows',
    'batchWriteFlightRecords',
    'verifySeasonImportCounts',
    'callSeasonalImportRpcRawPayload',
    'addSourceRow',
    'deleteSourceRow',
    'linkSourceRows',
    'mergeSameDaySourceRows',
    'unlinkSourceRows',
    'splitSourceRowTurnaround',
    'applySourceRowOperationPlan',
  ];

  assert.match(publicSeasonalApi, /getSourceRows/);
  assert.match(supabaseSource, /load seasonal source provenance/);
  for (const symbol of forbidden) {
    const pattern = new RegExp(`\\b${symbol}\\b`);
    assert.doesNotMatch(publicSeasonalApi, pattern, `${symbol} must not be exposed by remoteStore`);
    assert.doesNotMatch(supabaseSource, new RegExp(`async\\s+${symbol}\\b`), `${symbol} must not be implemented by supabaseStore`);
    assert.doesNotMatch(seasonalSource, pattern, `Seasonal page must not reach ${symbol}`);
    assert.doesNotMatch(settingsSource, pattern, `Settings repair must not reach ${symbol}`);
  }
  assert.doesNotMatch(supabaseSource, /rpc\('apply_seasonal_import_remote'|\/rest\/v1\/rpc\/apply_seasonal_import_remote/);
});

test('additive V2 migration keeps V1 callable until Task 12 post-canary revocation', () => {
  const migrationSource = readFileSync(
    join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'),
    'utf8',
  );
  const architectureSource = readFileSync(join(root, '..', '..', 'architecture.md'), 'utf8');

  assert.doesNotMatch(
    migrationSource,
    /revoke execute on function public\.apply_seasonal_import_remote\s*\(/i,
  );
  assert.match(migrationSource, /importMode/);
  assert.match(migrationSource, /season\.repair/);
  assert.match(architectureSource, /post-canary/i);
  assert.match(architectureSource, /apply_seasonal_import_remote/);
});

test('Seasonal baseline and overlay RLS hardening is mirrored in migration and schema', () => {
  const migrationSource = readFileSync(
    join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'),
    'utf8',
  );
  const schemaSource = readFileSync(join(root, '..', 'supabase', 'schema.sql'), 'utf8');
  const hardeningPattern = /do \$\$\r?\ndeclare\r?\n  v_table text;\r?\n  v_parent_write text := '\('[\s\S]*?\r?\nend\r?\n\$\$;/i;
  const migrationBoundary = requireSqlSection(migrationSource, hardeningPattern, 'migration RLS boundary');
  const schemaBoundary = requireSqlSection(schemaSource, hardeningPattern, 'schema RLS boundary');

  assert.equal(schemaBoundary, migrationBoundary);
  assert.match(migrationBoundary, /'season_source_rows'/);
  assert.match(migrationBoundary, /'season_source_row_days'/);
  assert.match(migrationBoundary, /'season_flight_records'/);
  assert.match(migrationBoundary, /revoke insert, update, delete on table public\.%I from authenticated/);
  assert.match(migrationBoundary, /revoke all on table public\.%I from public, anon, authenticated/);
  assert.match(migrationBoundary, /public\.app_operator_has_permission\(''seasonal\.read''\)/);
  for (const permission of [
    'seasonal.write',
    'detailed.write',
    'daily.write',
    'checkin.write',
    'gate.write',
  ]) {
    assert.match(migrationBoundary, new RegExp(`app_operator_has_permission\\(''${permission.replace('.', '\\.') }''\\)`));
  }
  assert.doesNotMatch(migrationBoundary, /app_operator_has_permission\(''season\.repair''\)/);
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
  const commitFunctionPattern = /create or replace function public\.commit_seasonal_import_v2\([\s\S]*?\n\$\$;/i;
  const preserveFingerprintFunctionPattern = /create or replace function public\.preserve_season_import_batch_staging_metadata_v2\(\)[\s\S]*?\n\$\$;/i;
  const preserveFingerprintTriggerPattern = /drop trigger if exists preserve_season_import_batch_staging_metadata_v2[\s\S]*?execute function public\.preserve_season_import_batch_staging_metadata_v2\(\);/i;

  for (const [label, pattern] of [
    ['season_import_batches table', importBatchTablePattern],
    ['season_import_batch_rows table', importBatchRowsTablePattern],
    ['result object constraint backfill', resultConstraintBackfillPattern],
    ['staging metadata trigger function', preserveFingerprintFunctionPattern],
    ['staging metadata trigger', preserveFingerprintTriggerPattern],
    ['stage_seasonal_import_v2 function', stageFunctionPattern],
    ['commit_seasonal_import_v2 function', commitFunctionPattern],
  ] as const) {
    assert.equal(
      requireSqlSection(schemaSource, pattern, `${label} in schema.sql`),
      requireSqlSection(migrationSource, pattern, `${label} in migration`),
      `${label} must stay byte-for-byte equivalent between migration and schema.sql`
    );
  }

  for (const source of [migrationSource, schemaSource]) {
    const stageFunctionSource = source.match(stageFunctionPattern)?.[0];
    const commitFunctionSource = source.match(commitFunctionPattern)?.[0];
    const preserveFingerprintFunctionSource = source.match(preserveFingerprintFunctionPattern)?.[0];
    assert.ok(stageFunctionSource, 'stage_seasonal_import_v2 body must be present');
    assert.ok(commitFunctionSource, 'commit_seasonal_import_v2 body must be present');
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
    assert.match(stageFunctionSource, /public\.app_operator_has_permission\('season\.repair'\)/);
    assert.match(stageFunctionSource, /'importMode', v_import_mode/);
    assert.match(stageFunctionSource, /'fingerprintVersion', 3/);
    assert.match(commitFunctionSource, /result #>> '\{_staging,importMode\}'/);
    assert.match(commitFunctionSource, /public\.app_operator_has_permission\('seasonal\.write'\)/);
    assert.match(commitFunctionSource, /public\.app_operator_has_permission\('season\.repair'\)/);
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
  assert.match(sqlTestSource, /operator without season\.repair staged a repair import/);
  assert.match(sqlTestSource, /operator without season\.repair committed a repair import/);
  assert.match(sqlTestSource, /standard import requestId was replayed as repair/);
  assert.match(sqlTestSource, /repair import requestId was replayed as standard/);
  assert.match(sqlTestSource, /persisted standard importMode was tampered/);
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

test('Task 9 repair takes V2 season locks before a fail-fast NOWAIT table graph', () => {
  const repairSource = readFileSync(
    join(
      root,
      '..',
      '..',
      'docs',
      'superpowers',
      'artifacts',
      '2026-07-18-seasonal-import-export-repair.sql'
    ),
    'utf8'
  ).replace(/\r\n/g, '\n');
  const migrationSource = readFileSync(
    join(root, '..', 'supabase', 'migrations', '20260718090000_seasonal_source_import_v2.sql'),
    'utf8'
  ).replace(/\r\n/g, '\n');
  const commitFunction = requireSqlSection(
    migrationSource,
    /create or replace function public\.commit_seasonal_import_v2\([\s\S]*?\n\$\$;/i,
    'commit_seasonal_import_v2 function'
  );
  const advisorySection = requireSqlSection(
    repairSource,
    /do \$\$\ndeclare\n  v_season_id text;[\s\S]*?\n\$\$;/,
    'Task 9 advisory lock section'
  );
  const advisoryLock = repairSource.indexOf('perform pg_catalog.pg_advisory_xact_lock(');
  const seasonRowLock = repairSource.indexOf('order by id\nfor update;');
  const firstTableLock = repairSource.indexOf(
    'lock table public.seasons in share row exclusive mode nowait;'
  );
  const fingerprint = repairSource.indexOf(
    'create temporary table task9_locked_season_state on commit drop as'
  );
  const staticGraphLocks = [
    ...repairSource.matchAll(
      /^lock table public\.([a-z0-9_]+) in share row exclusive mode nowait;$/gim
    ),
  ].map((match) => match[1]);
  const optionalStagingLocks = [
    ...repairSource.matchAll(
      /execute 'lock table public\.(season_import_(?:batches|batch_rows)) in share row exclusive mode nowait';/g
    ),
  ].map((match) => match[1]);

  assert.match(
    advisorySection,
    /for v_season_id in[\s\S]*order by season_id[\s\S]*pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(v_season_id, 0\)\s*\)/
  );
  assert.match(
    commitFunction,
    /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(v_target_season_id, 0\)\s*\)/
  );
  assert.deepEqual(
    [...advisorySection.matchAll(/'((?:season-)[^']+)'::text/g)].map((match) => match[1]),
    [
      'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'season-f77c5ea9-be54-4615-ab0a-d83062b9b854',
      'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451',
    ]
  );
  assert.ok(advisoryLock >= 0, 'repair must acquire per-season advisory locks');
  assert.ok(seasonRowLock > advisoryLock, 'season rows must lock after advisory locks');
  assert.ok(firstTableLock > seasonRowLock, 'table graph must lock after season rows');
  assert.ok(fingerprint > firstTableLock, 'fingerprints must run after every lock layer');
  assert.equal(staticGraphLocks.length, 16, 'every static maintenance table lock must use NOWAIT');
  assert.deepEqual(optionalStagingLocks, ['season_import_batches', 'season_import_batch_rows']);
  assert.doesNotMatch(
    repairSource,
    /^\s*lock table public\.[a-z0-9_]+ in share row exclusive mode;\s*$/gim
  );
  assert.ok(repairSource.indexOf('\\set ON_ERROR_STOP on') < firstTableLock);
  assert.match(repairSource, /lock_timeout is per lock wait/i);
  assert.match(repairSource, /statement_timeout is per statement/i);
  assert.match(repairSource, /operator must monitor total wall time/i);
  assert.match(repairSource, /quiesce direct writers and retry/i);
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
    assert.match(body, /'seasonCode', seasons\.season_code/);
    assert.match(body, /'sourceRowCount'/);
    assert.match(body, /from public\.season_source_rows source_rows/);
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
  assert.match(
    concurrencySource,
    /import\s*\{\s*parseDisposableDatabaseConfig,\s*verifyDatabaseIdentityOrClose,?\s*\}\s*from\s*['"]\.\.\/\.\.\/scripts\/seasonal-test-database-guard\.mjs['"];/
  );
  assert.match(
    concurrencySource,
    /const databaseConfig = parseDisposableDatabaseConfig\(process\.env\);/
  );
  assert.match(
    concurrencySource,
    /const expectedDatabaseName = databaseConfig\.databaseName;/
  );
  assert.match(
    concurrencySource,
    /await verifyDatabaseIdentityOrClose\(janitor\.client, expectedDatabaseName\);/
  );
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
