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
  assert.match(provider, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(provider, /server-authoritative live refresh/i);
});

test('native route mutation seams commit through server-authoritative RPC', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  assert.match(nativeLocalStore, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(nativeLocalStore, /applySeasonServerMutationV1/);
  assert.match(nativeLocalStore, /runNativeSeasonCatchup/);
  assert.match(nativeLocalStore, /toServerAuthoritativeSyncMeta/);
});

test('server-authoritative writes surface catch-up failures instead of reporting stale success', () => {
  const nativeLocalStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');
  assert.doesNotMatch(nativeLocalStore, /runNativeSeasonCatchup\(\{[\s\S]*?\}\)\.catch\(\(\) => null\)/);
});

test('gate commit promotes committed modifications before optimistic view can clear', () => {
  const gatePage = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');
  assert.match(gatePage, /promoteLatestGateModificationsForView\(\);\s*useSeasonWorkspaceStore\.getState\(\)\.patchSeasonWorkspace/);
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
