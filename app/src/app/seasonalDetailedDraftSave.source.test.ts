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

function extractCallback(source: string, callbackName: string, nextCallbackName: string): string {
  const start = source.indexOf(`const ${callbackName} = useCallback`);
  assert.notEqual(start, -1, `${callbackName} should exist`);
  const end = source.indexOf(`const ${nextCallbackName} = useCallback`, start + 1);
  assert.notEqual(end, -1, `${nextCallbackName} should follow ${callbackName}`);
  return source.slice(start, end);
}

function extractOpeningTagContaining(source: string, tagName: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} should exist`);
  const start = source.lastIndexOf(`<${tagName}`, markerIndex);
  assert.notEqual(start, -1, `${tagName} should contain ${marker}`);
  const end = source.indexOf('>', markerIndex);
  assert.notEqual(end, -1, `${tagName} opening tag should close`);
  return source.slice(start, end + 1);
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

test('Seasonal file actions block busy, draft, and invalid selection state', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importPicker = extractCallback(source, 'handleImportClick', 'handleFile');
  const importFile = extractCallback(source, 'handleFile', 'handleRowDoubleClick');
  const exportAction = extractCallback(source, 'handleExportUpdated', 'handleUndo');

  assert.match(source, /import\s*\{\s*getSeasonalFileActionBlock,\s*reconcileSeasonalSelection\s*\}/);
  assert.match(importPicker, /getSeasonalFileActionBlock\(\{[\s\S]*?action:\s*'import'/);
  assert.match(importFile, /getSeasonalFileActionBlock\(\{[\s\S]*?action:\s*'import'/);
  assert.match(exportAction, /getSeasonalFileActionBlock\(\{[\s\S]*?action:\s*'export'/);
  assert.ok(
    exportAction.indexOf('getSeasonalFileActionBlock') < exportAction.indexOf('loadSeasonWorkspaceWindow'),
    'export guard should run before the server export request',
  );
});

test('Seasonal Import and Export controls are disabled for draft changes', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importButton = extractOpeningTagContaining(source, 'button', 'onClick={handleImportClick}');
  const exportButton = extractOpeningTagContaining(source, 'button', 'onClick={handleExportUpdated}');

  assert.match(importButton, /disabled=\{[^}]*hasDraftChanges[^}]*\}/);
  assert.match(exportButton, /disabled=\{[^}]*hasDraftChanges[^}]*\}/);
});

test('Seasonal selection is reset or reconciled at every snapshot boundary', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const seasonChange = extractCallback(source, 'handleSeasonChange', 'handleRetryLoad');

  assert.match(seasonChange, /setSelectedRecordIds\(new Set\(\)\)/);
  assert.match(source, /reconcileSeasonalSelection\(\s*Array\.from\(previous\),\s*new Set\(records\.map/);
  assert.match(source, /return\s+unknownIds\.length\s*===\s*0\s*\?\s*previous\s*:\s*new Set\(\);/);
  assert.match(
    source,
    /applySeasonData\(patternRows,\s*refreshedRecords,\s*refreshedModifications\);[\s\S]*?setSelectedRecordIds\(new Set\(\)\);[\s\S]*?setDraftState\(null\);/,
  );
});

test('Seasonal import rejects parser issues before calculating or committing records', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importFile = extractCallback(source, 'handleFile', 'handleRowDoubleClick');
  const issueCheck = importFile.indexOf('issues.length > 0');

  assert.notEqual(issueCheck, -1, 'parser issues should be checked');
  assert.ok(issueCheck < importFile.indexOf('mergeDuplicateImportPeriods'));
  assert.ok(issueCheck < importFile.indexOf('applySeasonalImportRemote'));
  assert.doesNotMatch(importFile, /Discard local changes and re-import/);
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
