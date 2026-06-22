import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/hooks/useSeasonWorkspaceRefresh.ts'), 'utf8');

test('season workspace refresh awaits native refresh before handling the next event', () => {
  assert.match(source, /onNativeRefresh\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*Promise<void>\s*\|\s*void/);
  assert.match(source, /async function refreshFromNativeEvent/);
  assert.match(source, /await onNativeRefreshRef\.current\?\.\(event\)/);
  assert.match(source, /void scheduleRefreshRef\.current\(pendingEvent\)/);
});

test('season workspace refresh preserves failed native events for a controlled retry', () => {
  const catchStart = source.indexOf('} catch (error) {');
  const catchEnd = source.indexOf('} finally {', catchStart);
  assert(catchStart >= 0 && catchEnd > catchStart, 'refreshFromNativeEvent catch block should be present');
  const catchBlock = source.slice(catchStart, catchEnd);

  assert.match(source, /failedRefreshEventSeqRef\s*=\s*useRef<number \| null>\(null\)/);
  assert.match(catchBlock, /staleEventRef\.current\s*=\s*event/);
  assert.match(catchBlock, /failedRefreshEventSeqRef\.current\s*=\s*event\.eventSeq/);
  assert.doesNotMatch(catchBlock, /lastHandledEventSeqRef\.current\s*=\s*Math\.max\(lastHandledEventSeqRef\.current,\s*event\.eventSeq\)/);
  assert.match(source, /pendingEvent\.eventSeq\s*!==\s*failedRefreshEventSeqRef\.current/);
  assert.match(source, /failedRefreshEventSeqRef\.current\s*=\s*null/);
});

test('season workspace refresh drops pending events from a previous season before native refresh', () => {
  assert.match(
    source,
    /if \(!currentSeasonId \|\| event\.seasonId !== currentSeasonId \|\| event\.eventSeq <= lastHandledEventSeqRef\.current\) \{/
  );
  assert.match(source, /if \(staleEventRef\.current\?\.eventSeq === event\.eventSeq\) staleEventRef\.current = null;/);
  assert.match(source, /if \(failedRefreshEventSeqRef\.current === event\.eventSeq\) failedRefreshEventSeqRef\.current = null;/);
});

test('season workspace refresh defers native refresh while a route interaction is active', () => {
  assert.match(source, /shouldDeferRefresh\?:\s*\(\)\s*=>\s*boolean/);
  assert.match(source, /const shouldDeferRefreshRef = useRef\(shouldDeferRefresh\)/);
  assert.match(source, /if \(shouldDeferRefreshRef\.current\?\.\(\)\) \{/);
  assert.match(source, /if \(refreshTimerRef\.current != null\) window\.clearTimeout\(refreshTimerRef\.current\);/);
  assert.match(source, /return;/);
  assert.match(source, /const pendingEvent = staleEventRef\.current;\s*if \(pendingEvent && !shouldDeferRefreshRef\.current\?\.\(\)\) scheduleRefreshRef\.current\(pendingEvent\);/);
});

test('season workspace refresh lets active routes filter non-own-source events before scheduling refresh', () => {
  assert.match(source, /shouldHandleWorkspaceChange\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*boolean/);
  assert.match(source, /const shouldHandleWorkspaceChangeRef = useRef\(shouldHandleWorkspaceChange\)/);
  assert.match(source, /shouldHandleWorkspaceChangeRef\.current = shouldHandleWorkspaceChange/);
  assert.match(
    source,
    /if \(currentRouteActive && shouldHandleWorkspaceChangeRef\.current && !shouldHandleWorkspaceChangeRef\.current\(event\)\) return;/
  );
});
