import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/components/SeasonSyncProvider.tsx'), 'utf8');

function extractFunctionBody(functionName: string) {
  const marker = `const ${functionName} = useCallback(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const arrowStart = source.indexOf('=>', start);
  assert.notEqual(arrowStart, -1, `${functionName} should use an arrow callback`);
  const bodyStart = source.indexOf('{', arrowStart);
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  assert.fail(`${functionName} body should close`);
}

test('provider source no longer contains native catch-up or manual fetch actions', () => {
  for (const staleSymbol of [
    'fetchUpdatesNow',
    'runManualFetchSeason',
    'runCatchUpSeason',
    'runNativeSeasonCatchup',
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${staleSymbol}\\b`), staleSymbol);
  }
});

test('server-authoritative workspace changes do not schedule native summary polling', () => {
  const callbackStart = source.indexOf('const unsubscribe = subscribeSeasonWorkspaceChanges((event) => {');
  assert.notEqual(callbackStart, -1, 'workspace-change subscription should exist');

  const callbackEnd = source.indexOf('    return () => {', callbackStart);
  assert.notEqual(callbackEnd, -1, 'workspace-change subscription cleanup should exist');

  const callbackSource = source.slice(callbackStart, callbackEnd);
  const serverBranchMatch = callbackSource.match(/if \(SERVER_AUTHORITATIVE_MODE\) \{([\s\S]*?)\n      \}/);
  assert.ok(serverBranchMatch?.[1], 'workspace-change callback should branch for SERVER_AUTHORITATIVE_MODE');

  const serverBranchSource = serverBranchMatch[1];
  assert.match(serverBranchSource, /\breturn;/, 'server-authoritative branch should return before native fallback');
  assert.doesNotMatch(serverBranchSource, /\bqueryNativeSyncSummary\b/, 'server branch should not query native summary');
  assert.doesNotMatch(serverBranchSource, /\bpendingWorkspaceChangeSeasonIdsRef\b/, 'server branch should not enqueue native summary refresh');
  assert.doesNotMatch(serverBranchSource, /\bworkspaceChangeDebounceTimerRef\b/, 'server branch should not debounce native summary refresh');
});

test('remote live server events publish workspace refresh events without native catch-up source', () => {
  assert.match(
    source,
    /subscribeToSeasonEvents\(seasonId, \(event\) => \{[\s\S]*?publishSeasonWorkspaceChanged\(\{[\s\S]*?source:\s*'server-live'[\s\S]*?localRevision:\s*event\.serverSeq[\s\S]*?affectedIds:\s*\[event\.targetId\][\s\S]*?changedTargets:\s*\[`\$\{event\.targetType\}:\$\{event\.targetId\}`\][\s\S]*?\}\);[\s\S]*?\}\)/
  );
  assert.doesNotMatch(source, /source:\s*'native-catchup'/);
});

test('ensureLiveSeason does not patch sync state before subscription checks', () => {
  const body = extractFunctionBody('ensureLiveSeason');
  const subscriptionCheckIndex = body.indexOf('liveUnsubscribersRef.current.has(seasonId)');
  assert.notEqual(subscriptionCheckIndex, -1, 'ensureLiveSeason should check existing live subscription');
  const beforeSubscriptionCheck = body.slice(0, subscriptionCheckIndex);
  assert.doesNotMatch(beforeSubscriptionCheck, /\bpatchLightweightSeasonState\b/);
  assert.doesNotMatch(beforeSubscriptionCheck, /\bpatchSeasonState\b/);
});

test('lightweight state patches are guarded to avoid overwriting active sync states', () => {
  const body = extractFunctionBody('patchLightweightSeasonState');
  const patchIndex = body.indexOf('patchSeasonState(seasonId');
  assert.notEqual(patchIndex, -1, 'lightweight patch helper should still patch eligible states');
  assert.match(body.slice(0, patchIndex), /\bcanPatchLightweightSeasonState\(current\)/);
});

test('server-authoritative sync state does not read stale native conflict counts', () => {
  assert.doesNotMatch(source, /summary\?\.conflictCount/);
  assert.doesNotMatch(source, /\bgetLocalSyncConflictCount\b/);
});

test('server-authoritative sync metadata events are not overwritten by native summary refresh', () => {
  assert.match(
    source,
    /if \(SERVER_AUTHORITATIVE_MODE && event\.syncMeta\) \{[\s\S]*?return;[\s\S]*?\}/
  );
});

test('server-authoritative sync metadata events track pending work only', () => {
  assert.match(
    source,
    /const pendingCount = event\.syncMeta\.pendingCount \?\? 0/
  );
  assert.match(
    source,
    /setSessionPendingSeason\(event\.seasonId,\s*pendingCount\)/
  );
  assert.doesNotMatch(source, /\bgetLocalSyncConflictCount\b/);
});

test('server-authoritative sync badge does not expose conflict review fallbacks', () => {
  assert.doesNotMatch(source, /return 'Fetch data required'/);
  assert.doesNotMatch(source, /return 'Review needed'/);
  assert.doesNotMatch(source, /\bfallbackConflictCount\b/);
  assert.doesNotMatch(source, /return 'Refresh required'/);
});

test('pending sync badge describes submit-pending work', () => {
  assert.match(source, /return `\$\{pendingCount\} pending submit`/);
  assert.doesNotMatch(source, /\$\{pendingCount\} unsynced/);
});

test('provider exposes strict season auto sync state instead of widened readable status', () => {
  assert.doesNotMatch(source, /\bSeasonSyncReadableState\b/);
  assert.doesNotMatch(source, /string\s*&\s*\{\}/);
  assert.doesNotMatch(source, /status:\s*status as /);
  assert.match(source, /getSeasonSyncPendingCount\(status:\s*SeasonAutoSyncState/);
  assert.match(source, /getSeasonSyncLabel\(status:\s*SeasonAutoSyncState/);
  assert.match(source, /getSeasonSyncTone\(status:\s*SeasonAutoSyncState/);
});

test('provider normalizes native conflict results to narrow sync failures', () => {
  assert.doesNotMatch(source, /status:\s*'conflict'/);
  assert.doesNotMatch(source, /result\.status === 'synced' \|\| result\.status === 'conflict'/);
  assert.doesNotMatch(source, /nativeResult\.status === 'conflict'\s*\?\s*'conflict'/);
  assert.match(source, /nativeResult\?\.status === 'synced'[\s\S]*status:\s*'synced'[\s\S]*status:\s*'failed'/);
});
