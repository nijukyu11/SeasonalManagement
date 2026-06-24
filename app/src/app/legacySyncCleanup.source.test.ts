import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const sourceRoot = join(process.cwd(), 'src');

function readSource(relativePath: string): string {
  return readFileSync(join(sourceRoot, relativePath), 'utf8');
}

const seasonSyncProviderSource = readSource('app/components/SeasonSyncProvider.tsx');
const seasonAutoSyncSource = readSource('lib/seasonAutoSync.ts');
const useSeasonWorkspaceRefreshSource = readSource('app/hooks/useSeasonWorkspaceRefresh.ts');
const seasonRepairTabSource = readSource('app/settings/components/SeasonRepairTab.tsx');

const primaryRouteFiles = [
  'app/SeasonalSchedulePage.tsx',
  'app/detailed/page.tsx',
  'app/daily/page.tsx',
  'app/checkin/page.tsx',
  'app/gate/page.tsx',
  'app/dashboard/page.tsx',
];

test('SeasonSyncProvider no longer exposes old native catch-up actions', () => {
  for (const staleSymbol of [
    'fetchUpdatesNow',
    'runManualFetchSeason',
    'catchUpSeason',
    'pendingCatchUpSeasonIdsRef',
  ]) {
    assert.doesNotMatch(seasonSyncProviderSource, new RegExp(`\\b${staleSymbol}\\b`), staleSymbol);
  }
});

test('season auto sync scheduler no longer models catch-up or conflict review states', () => {
  for (const staleState of [
    'catching_up',
    'needs_review',
    'conflict',
    'conflictDuringRun',
  ]) {
    assert.doesNotMatch(seasonAutoSyncSource, new RegExp(`\\b${staleState}\\b`), staleState);
  }
});

test('season auto sync run status stays narrow for scheduler results', () => {
  assert.doesNotMatch(seasonAutoSyncSource, /string\s*&\s*\{\}/);
  assert.match(
    seasonAutoSyncSource,
    /export type SeasonAutoSyncRunStatus = 'synced' \| 'busy' \| 'failed';/
  );
});

test('SeasonSyncProvider no longer runs native catch-up or manual replay helpers', () => {
  for (const staleSymbol of [
    'runNativeSeasonCatchup',
    'ensureNativeSeasonBaseline',
    'checkNativeSeasonIntegrity',
    'MANUAL_FETCH_REPLAY_EVENT_WINDOW',
  ]) {
    assert.doesNotMatch(seasonSyncProviderSource, new RegExp(`\\b${staleSymbol}\\b`), staleSymbol);
  }
});

test('season repair tab owns the legacy conflict review control', () => {
  assert.match(seasonRepairTabSource, /\bSeasonConflictReviewControl\b/);
});

test('primary routes do not contain legacy native seed, summary, or conflict review controls', () => {
  for (const routeFile of primaryRouteFiles) {
    const source = readSource(routeFile);
    assert.doesNotMatch(source, /\bseedSeasonSyncFromNative\b/, routeFile);
    assert.doesNotMatch(source, /\bqueryNativeSyncSummary\b/, routeFile);
    assert.doesNotMatch(source, /\bSeasonConflictReviewControl\b/, routeFile);
  }
});

test('season workspace refresh uses route-provided refresh callback without native naming', () => {
  assert.doesNotMatch(useSeasonWorkspaceRefreshSource, /\bonNativeRefresh\b/);
  assert.match(
    useSeasonWorkspaceRefreshSource,
    /onRefresh\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*Promise<void>\s*\|\s*void/
  );
});

test('legacy native sync adapter is the only allowed bridge for repair-only native catch-up', () => {
  const adapterPath = join(sourceRoot, 'lib/legacyNativeSyncAdapter.ts');
  assert.equal(existsSync(adapterPath), true, 'legacyNativeSyncAdapter.ts should exist');
  const source = readFileSync(adapterPath, 'utf8');

  for (const requiredSymbol of [
    'runLegacyNativeCatchup',
    'LEGACY_NATIVE_SYNC_ENABLED',
    'runNativeSeasonCatchup',
  ]) {
    assert.match(source, new RegExp(`\\b${requiredSymbol}\\b`), requiredSymbol);
  }
});
