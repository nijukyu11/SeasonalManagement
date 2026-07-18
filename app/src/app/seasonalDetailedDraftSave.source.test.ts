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

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T | null {
  let found: T | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isIdentifierCall(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  return Boolean(
    node
    && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === name,
  );
}

function extractUseCallbackBody(sourceFile: ts.SourceFile, callbackName: string): ts.Block {
  const declaration = findNode(sourceFile, (node): node is ts.VariableDeclaration => (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === callbackName
    && isIdentifierCall(node.initializer, 'useCallback')
  ));
  const initializer = declaration?.initializer;
  assert.ok(isIdentifierCall(initializer, 'useCallback'));
  const callback = initializer.arguments[0];
  assert.ok(
    callback
    && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    && ts.isBlock(callback.body),
    `${callbackName} should be declared with a block-bodied useCallback`,
  );
  return callback.body;
}

function callMatchesTarget(
  call: ts.CallExpression,
  kind: 'identifier' | 'property',
  name: string,
): boolean {
  if (kind === 'identifier') {
    return ts.isIdentifier(call.expression) && call.expression.text === name;
  }
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === name;
}

function branchReturns(statement: ts.Statement): boolean {
  return ts.isReturnStatement(statement)
    || (ts.isBlock(statement) && statement.statements.some(ts.isReturnStatement));
}

type GuardBoundary = readonly [
  callbackName: string,
  guardName: 'getSeasonalFileActionBlock' | 'validateSeasonalFileAction',
  resultName: string,
  sideEffectKind: 'identifier' | 'property',
  sideEffectName: string,
  boundaryLabel: string,
];

function assertGuardResultReturnsBeforeSideEffect(
  sourceFile: ts.SourceFile,
  boundary: GuardBoundary,
): void {
  const [callbackName, guardName, resultName, sideEffectKind, sideEffectName, boundaryLabel] = boundary;
  const body = extractUseCallbackBody(sourceFile, callbackName);
  const resultDeclaration = findNode(body, (node): node is ts.VariableDeclaration => (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === resultName
    && isIdentifierCall(node.initializer, guardName)
  ));
  const sideEffectCall = findNode(body, (node): node is ts.CallExpression => (
    ts.isCallExpression(node) && callMatchesTarget(node, sideEffectKind, sideEffectName)
  ));
  assert.ok(resultDeclaration, `${callbackName} should assign ${guardName} to ${resultName}`);
  assert.ok(sideEffectCall, `${callbackName} should contain ${boundaryLabel}`);

  const resultEnd = resultDeclaration.getEnd();
  const sideEffectStart = sideEffectCall.getStart(sourceFile);
  const earlyReturn = findNode(body, (node): node is ts.IfStatement => (
    ts.isIfStatement(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === resultName
    && branchReturns(node.thenStatement)
    && node.getStart(sourceFile) > resultEnd
    && node.getEnd() < sideEffectStart
  ));
  assert.ok(
    earlyReturn,
    `${callbackName} should return on ${resultName} before ${boundaryLabel}`,
  );
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

test('every Seasonal file action guard result returns before its side-effect boundary', () => {
  const source = readSource('app/SeasonalSchedulePage.tsx');
  const sourceFile = ts.createSourceFile(
    'SeasonalSchedulePage.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const cases: readonly GuardBoundary[] = [
    ['handleImportClick', 'getSeasonalFileActionBlock', 'block', 'property', 'click', 'opening the import picker'],
    ['handleFile', 'getSeasonalFileActionBlock', 'block', 'identifier', 'findSeasonByCode', 'the first import server lookup'],
    ['handleFile', 'validateSeasonalFileAction', 'commitInvalidation', 'identifier', 'applySeasonalImportRemote', 'the import server commit'],
    ['handleFile', 'validateSeasonalFileAction', 'applyInvalidation', 'identifier', 'setCachedSeasons', 'applying the committed cache snapshot'],
    ['handleFile', 'validateSeasonalFileAction', 'finalApplyInvalidation', 'identifier', 'setSeasons', 'applying the committed UI snapshot'],
    ['handleExportUpdated', 'getSeasonalFileActionBlock', 'initialBlock', 'identifier', 'loadSeasonWorkspaceWindow', 'the export server request'],
    ['handleExportUpdated', 'validateSeasonalFileAction', 'snapshotInvalidation', 'identifier', 'downloadCanonicalSeasonalExcel', 'the export download'],
    ['handleExportUpdated', 'getSeasonalFileActionBlock', 'snapshotBlock', 'identifier', 'downloadCanonicalSeasonalExcel', 'the export download'],
    ['handleExportUpdated', 'validateSeasonalFileAction', 'downloadInvalidation', 'identifier', 'downloadCanonicalSeasonalExcel', 'the export download'],
  ];

  for (const entry of cases) {
    assertGuardResultReturnsBeforeSideEffect(sourceFile, entry);
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
