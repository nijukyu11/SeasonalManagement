import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

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

function extractOpeningTagContaining(source: string, tagName: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} should exist`);
  const start = source.lastIndexOf(`<${tagName}`, markerIndex);
  assert.notEqual(start, -1, `${tagName} should contain ${marker}`);
  const end = source.indexOf('>', markerIndex);
  assert.notEqual(end, -1, `${tagName} opening tag should close`);
  return source.slice(start, end + 1);
}

function extractUseCallbackSource(source: string, callbackName: string): string {
  const sourceFile = ts.createSourceFile(
    'SeasonalSchedulePage.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callbackSource: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === callbackName
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'useCallback'
    ) {
      callbackSource = node.initializer.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(callbackSource, `${callbackName} should be declared with useCallback`);
  return callbackSource;
}

test('Seasonal Schedule passes draft changes through the save guard flow', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const syncButton = extractFirstTag(source, 'SyncActionButton');

  assert.match(syncButton, /draftCount=\{draftChangeCount\}/);
  assert.match(syncButton, /onSync=\{handleSync\}/);
  assert.match(source, /const\s+draftChangeCount\s*=\s*countSeasonalDraftChanges\(draftState\);/);
  assert.match(source, /const\s+hasDraftChanges\s*=\s*draftChangeCount\s*>\s*0;/);
  assert.match(
    source,
    /useSeasonSyncGuard\(activeSeason\?\.id,\s*'seasonal',\s*\{[\s\S]*?beforeSync:\s*commitDraftBeforeSave,[\s\S]*?\}\);/
  );
});

test('Seasonal file actions wire the controller at commit, apply, and download boundaries', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importStart = source.indexOf('const handleFile = useCallback');
  const exportStart = source.indexOf('const handleExportUpdated = useCallback');
  const commit = source.indexOf('applySeasonalImportRemote', importStart);
  const importApply = source.indexOf('applySeasonData(patternRows, refreshedRecords, refreshedModifications)', commit);
  const download = source.indexOf('downloadCanonicalSeasonalExcel', exportStart);

  assert.match(source, /createSeasonalFileActionController/);
  assert.match(source, /beginSeasonalFileAction\('import'\)/);
  assert.match(source, /beginSeasonalFileAction\('export'\)/);
  assert.ok(source.lastIndexOf('validateSeasonalFileAction(', commit) > importStart);
  assert.ok(source.lastIndexOf('validateSeasonalFileAction(', importApply) > commit);
  assert.ok(source.lastIndexOf('validateSeasonalFileAction(', download) > exportStart);
});

test('every Seasonal file action entry point applies the state guard', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const entryPoints = [
    ['handleImportClick', 'import'],
    ['handleFile', 'import'],
    ['handleExportUpdated', 'export'],
  ] as const;

  for (const [callbackName, action] of entryPoints) {
    const callbackSource = extractUseCallbackSource(source, callbackName);
    assert.match(
      callbackSource,
      new RegExp(`getSeasonalFileActionBlock\\s*\\(\\s*\\{[\\s\\S]*?action:\\s*'${action}'`),
      `${callbackName} should guard ${action}`,
    );
  }
});

test('Seasonal Import and Export controls are disabled for draft changes', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importButton = extractOpeningTagContaining(source, 'button', 'onClick={handleImportClick}');
  const exportButton = extractOpeningTagContaining(source, 'button', 'onClick={handleExportUpdated}');
  const seasonSelect = extractOpeningTagContaining(source, 'select', 'disabled={seasonalFileActionActive}');

  assert.match(importButton, /disabled=\{[^}]*hasDraftChanges[^}]*\}/);
  assert.match(exportButton, /disabled=\{[^}]*hasDraftChanges[^}]*\}/);
  assert.match(seasonSelect, /disabled=\{seasonalFileActionActive\}/);
  assert.ok((source.match(/beginSeasonalMutation\(\)/g) ?? []).length >= 5);
});

test('Seasonal selection is reset or reconciled at every snapshot boundary', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');

  assert.match(source, /const handleSeasonChange[\s\S]{0,500}setSelectedRecordIds\(new Set\(\)\)/);
  assert.match(source, /reconcileSeasonalSelection\(\s*Array\.from\(previous\),\s*buildSeasonalAvailableRecordIds\(records,\s*mods\)/);
  assert.match(source, /buildSeasonalAvailableRecordIds\(flightRecords,\s*modifications\)/);
  assert.match(source, /buildSeasonalAvailableRecordIds\(exportRecords,\s*exportModifications\)/);
  assert.match(source, /return\s+unknownIds\.length\s*===\s*0\s*\?\s*previous\s*:\s*new Set\(\);/);
  assert.match(
    source,
    /applySeasonData\(patternRows,\s*refreshedRecords,\s*refreshedModifications\);[\s\S]*?setSelectedRecordIds\(new Set\(\)\);[\s\S]*?setDraftState\(null\);/,
  );
});

test('Seasonal import rejects parser issues before calculating or committing records', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const importStart = source.indexOf('const handleFile = useCallback');
  const issueCheck = source.indexOf('issues.length > 0', importStart);
  const calculation = source.indexOf('mergeDuplicateImportPeriods', importStart);
  const commit = source.indexOf('applySeasonalImportRemote', importStart);

  assert.notEqual(issueCheck, -1, 'parser issues should be checked');
  assert.ok(issueCheck < calculation);
  assert.ok(issueCheck < commit);
  assert.doesNotMatch(source, /Discard local changes and re-import/);
  assert.doesNotMatch(source, /Sync first/);
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
