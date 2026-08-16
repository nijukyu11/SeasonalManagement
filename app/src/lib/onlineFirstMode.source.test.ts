import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('online-first mode is explicit and disables durable offline writes', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/serverAuthoritativeMode.ts'), 'utf8');
  assert.match(source, /SERVER_AUTHORITATIVE_MODE\s*=\s*true/);
  assert.match(source, /ALLOW_DURABLE_OFFLINE_WRITES\s*=\s*false/);
  assert.match(source, /server latest write wins/i);
});

test('remote store exposes server-authoritative mutation contract', () => {
  const remoteStore = readFileSync(join(process.cwd(), 'src/lib/remoteStore.ts'), 'utf8');
  const supabaseStore = readFileSync(join(process.cwd(), 'src/lib/supabaseStore.ts'), 'utf8');
  assert.match(remoteStore, /applySeasonServerMutationV1/);
  assert.match(remoteStore, /clientMutationId/);
  assert.match(supabaseStore, /apply_season_server_mutation_v1/);
  assert.match(supabaseStore, /serverHighWater/);
  assert.match(supabaseStore, /changedTargets/);
});

test('conflict review is legacy-native fallback outside normal server-authoritative routes', () => {
  const conflictControl = readFileSync(join(process.cwd(), 'src/app/components/SeasonConflictReviewControl.tsx'), 'utf8');
  const provider = readFileSync(join(process.cwd(), 'src/app/components/SeasonSyncProvider.tsx'), 'utf8');
  assert.match(conflictControl, /LEGACY_NATIVE_SYNC_ENABLED/);
  assert.doesNotMatch(conflictControl, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(conflictControl, /return null/);
  assert.match(provider, /server-authoritative live refresh/i);
});

test('native route mutation seams commit through server-authoritative RPC', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  assert.match(nativeLocalStore, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(nativeLocalStore, /applySeasonServerMutationV1/);
  assert.match(nativeLocalStore, /toServerAuthoritativeSyncMeta/);
  assert.doesNotMatch(nativeLocalStore, /\bqueryNativeSyncSummary\b/);
  assert.doesNotMatch(nativeLocalStore, /\brunNativeSeasonCatchup\b/);
});

test('schedule route mutations pass server-authoritative module sources', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  const seasonalPage = readFileSync(join(process.cwd(), 'src/app/SeasonalSchedulePage.tsx'), 'utf8');
  const detailedPage = readFileSync(join(process.cwd(), 'src/app/detailed/page.tsx'), 'utf8');
  const dailyPage = readFileSync(join(process.cwd(), 'src/app/daily/page.tsx'), 'utf8');
  const localSeasonStore = readFileSync(join(process.cwd(), 'src/lib/localSeasonStore.ts'), 'utf8');

  assert.doesNotMatch(nativeLocalStore, /applyServerAuthoritativeOperations\(seasonId,\s*'schedule'/);
  assert.match(seasonalPage, /runNativeScheduleMutation\([\s\S]*'seasonal'\s*\)/);
  assert.match(detailedPage, /runNativeScheduleMutation\([\s\S]*'detailed'\s*\)/);
  assert.match(dailyPage, /runNativeScheduleMutation\([\s\S]*'daily'\s*\)/);
  assert.match(localSeasonStore, /runNativeScheduleMutation\([\s\S]*'seasonal'\s*\)/);
});

test('server-authoritative writes do not depend on SQLite cursor or catch-up', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  assert.doesNotMatch(nativeLocalStore, /\bqueryNativeSyncSummary\b/);
  assert.doesNotMatch(nativeLocalStore, /\brunNativeSeasonCatchup\b/);
  assert.doesNotMatch(nativeLocalStore, /\bbaseServerSeq\b/);
});

test('normal native startup and close do not preload or mutate SQLite', () => {
  const tauriConfig = readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8');
  const sessionCleanup = readFileSync(join(process.cwd(), 'src/lib/appSessionCleanup.ts'), 'utf8');
  const closeGuard = readFileSync(join(process.cwd(), 'src/app/components/NativeCloseCleanupGuard.tsx'), 'utf8');
  assert.doesNotMatch(tauriConfig, /sqlite:seasonal-management-local\.db/);
  assert.doesNotMatch(sessionCleanup, /discardAllLocalPendingChanges|localSeasonStore/);
  assert.doesNotMatch(closeGuard, /discardPendingLocalChanges|SQLite database|local database/);
});

test('gate commit resolves canonical server events before optimistic view can clear', () => {
  const gatePage = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');
  assert.match(gatePage, /findLatestSequencedModificationPatch\(result\.appliedEvents/);
  assert.match(gatePage, /applyServerModificationPatch\(/);
  assert.match(gatePage, /promoteLatestGateModificationsForView\(\)/);
});

test('allocation mutations keep their module source in server-authoritative RPC', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  const gatePage = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');
  const checkInPage = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
  assert.match(nativeLocalStore, /type NativeLocalModificationSource = 'gate' \| 'checkin' \| 'allocation'/);
  assert.match(nativeLocalStore, /applyServerAuthoritativeOperations\(seasonId,\s*source,/);
  assert.match(gatePage, /runNativeLocalModificationBatchDeltaResult\(seasonId,\s*mods,[\s\S]*?,\s*'gate'\s*\)/);
  assert.match(checkInPage, /runNativeLocalModificationBatchDeltaResult\(seasonId,\s*mods,[\s\S]*?,\s*'checkin'\s*\)/);
});

test('check-in writes try the shared mutation boundary before worker fallback', () => {
  const checkInPage = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
  const persistCheckInStart = checkInPage.indexOf('const persistCheckInModifications = useCallback');
  const persistCheckInEnd = checkInPage.indexOf(
    '}, [commitCheckInModificationsInWorker',
    persistCheckInStart
  );
  const persistCheckInSource = checkInPage.slice(persistCheckInStart, persistCheckInEnd);
  const nativeBoundaryIndex = persistCheckInSource.indexOf(
    'const nativeResult = await commitCheckInModificationsNative'
  );
  const workerFallbackIndex = persistCheckInSource.indexOf('const worker = getCheckInCommitWorker()');

  assert.match(checkInPage, /runNativeLocalModificationBatchDeltaResult\(seasonId,\s*mods,[\s\S]*?,\s*'checkin'\s*\)/);
  assert.notEqual(nativeBoundaryIndex, -1);
  assert.notEqual(workerFallbackIndex, -1);
  assert.ok(nativeBoundaryIndex < workerFallbackIndex);
});

test('check-in persistence without sync metadata rolls back instead of silently succeeding', () => {
  const checkInPage = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
  assert.match(
    checkInPage,
    /if \(!result\.syncMeta\) \{[\s\S]*?throw withCheckInCommitFailureSource\([\s\S]*?new Error\('Check-in server mutation completed without sync metadata\.'\),[\s\S]*?result\.source \?\? 'checkin'[\s\S]*?\);[\s\S]*?\}/
  );
});
