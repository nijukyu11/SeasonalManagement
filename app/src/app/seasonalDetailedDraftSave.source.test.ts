import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const sourceRoot = join(process.cwd(), 'src');

function readSource(relativePath: string): string {
  return readFileSync(join(sourceRoot, relativePath), 'utf8');
}

function extractFirstTag(source: string, tagName: string): string {
  const start = source.indexOf(`<${tagName}`);
  assert.notEqual(start, -1, `${tagName} should exist`);
  const end = source.indexOf('/>', start);
  assert.notEqual(end, -1, `${tagName} should be self-closing`);
  return source.slice(start, end + 2);
}

test('Seasonal Schedule passes draft changes through the save guard flow', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const syncButton = extractFirstTag(source, 'SyncActionButton');

  assert.match(syncButton, /draftCount=\{draftChangeCount\}/);
  assert.match(syncButton, /onSync=\{handleSync\}/);
  assert.match(
    source,
    /const\s+draftChangeCount\s*=\s*\(\(\s*draftState\?\.records\.length\s*\?\?\s*0\s*\)\s*\+\s*\(\s*draftState\?\.modifications\.length\s*\?\?\s*0\s*\)\s*\);/
  );
  assert.match(source, /const\s+hasDraftChanges\s*=\s*draftChangeCount\s*>\s*0;/);
  assert.match(
    source,
    /useSeasonSyncGuard\(activeSeason\?\.id,\s*'seasonal',\s*\{[\s\S]*?beforeSync:\s*commitDraftBeforeSave,[\s\S]*?\}\);/
  );
});

test('Detailed Schedule passes draft changes through the save guard flow', () => {
  const source = readSource('app/detailed/page.tsx');
  const syncButton = extractFirstTag(source, 'SyncActionButton');

  assert.match(syncButton, /draftCount=\{draftChangeCount\}/);
  assert.match(syncButton, /onSync=\{handleSync\}/);
  assert.match(
    source,
    /const\s+draftChangeCount\s*=\s*draftState\?\.modifications\.length\s*\?\?\s*0;/
  );
  assert.match(source, /const\s+hasDraftChanges\s*=\s*draftChangeCount\s*>\s*0;/);
  assert.match(
    source,
    /useSeasonSyncGuard\(season\?\.id\s*\?\?\s*targetSeasonId,\s*'detailed',\s*\{[\s\S]*?beforeSync:\s*commitDraftBeforeSave,[\s\S]*?\}\);/
  );
});

test('Detailed initial route load does not rerun when refreshDetailedState changes', () => {
  const source = readSource('app/detailed/page.tsx');
  const effectStart = source.indexOf('const cachedSeasons = getCachedSeasons();');
  assert.notEqual(effectStart, -1, 'initial detailed load effect body should exist');
  const effectEnd = source.indexOf('useEffect(() => {', effectStart + 1);
  assert.notEqual(effectEnd, -1, 'next detailed effect should exist');
  const effectSource = source.slice(effectStart, effectEnd);

  assert.match(effectSource, /refreshDetailedStateRef\.current\(cachedWindow\.records,\s*cachedWindow\.modifications/);
  assert.doesNotMatch(
    effectSource,
    /\}, \[[^\]]*refreshDetailedState[^\]]*\]\);/,
    'initial load effect must not depend on refreshDetailedState because that resets editable date filters'
  );
});
