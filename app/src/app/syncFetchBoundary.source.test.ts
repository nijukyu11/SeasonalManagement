import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const routeFiles = [
  'src/app/(desktop)/SeasonalSchedulePage.tsx',
  'src/app/(desktop)/detailed/page.tsx',
  'src/app/(desktop)/daily/page.tsx',
  'src/app/(desktop)/checkin/page.tsx',
  'src/app/(desktop)/gate/page.tsx',
  'src/app/(desktop)/dashboard/page.tsx',
];

function extractFunctionBody(source: string, functionName: string): string {
  const start = source.indexOf(`const ${functionName} =`);
  assert(start >= 0, functionName);
  const arrow = source.indexOf('=>', start);
  assert(arrow > start, functionName);
  const open = source.indexOf('{', arrow);
  assert(open > arrow, functionName);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`Could not extract ${functionName}`);
}

test('SyncActionButton remains submit-pending and never becomes Fetch data', () => {
  const buttonSource = readFileSync(join(process.cwd(), 'src/app/(desktop)/components/SyncActionButton.tsx'), 'utf8');
  const stateSource = readFileSync(join(process.cwd(), 'src/app/(desktop)/components/syncActionButtonState.ts'), 'utf8');
  const submitUiSource = `${buttonSource}\n${stateSource}`;
  assert.match(buttonSource, /pendingCount/);
  assert.match(buttonSource, /getSyncActionButtonState/);
  assert.match(buttonSource, /state\.label/);
  assert.match(buttonSource, /state\.title/);
  assert.match(stateSource, /Save pending/);
  assert.match(stateSource, /Submit pending changes to server/);
  assert.doesNotMatch(submitUiSource, /Fetch data/);
  assert.doesNotMatch(submitUiSource, /onFetch/);
  assert.doesNotMatch(submitUiSource, /fetchUpdatesNow/);
});

test('FetchServerUpdatesButton is read-only server refresh UI', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/(desktop)/components/FetchServerUpdatesButton.tsx'), 'utf8');
  assert.match(source, /Fetch data/);
  assert.match(source, /Fetch latest data from server/);
  assert.match(source, /onFetch/);
  assert.doesNotMatch(source, /onSync/);
  assert.doesNotMatch(source, /syncNow/);
  assert.doesNotMatch(source, /fetchUpdatesNow/);
});

test('primary route pages expose server fetch separately from Sync submit', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /FetchServerUpdatesButton/, file);
    assert.match(source, /onFetch=\{[^}]*fetchServerData/, file);
    assert.match(source, /<SyncActionButton/, file);
    assert.match(source, /pendingCount=\{syncPendingCount\}/, file);
    const fetchBody = extractFunctionBody(source, 'fetchServerData');
    if (file === 'src/app/(desktop)/SeasonalSchedulePage.tsx') {
      assert.match(fetchBody, /loadSeasonRows\([^,]+,\s*true,/, file);
    } else {
      assert.match(fetchBody, /revalidateSeasonWorkspaceWindow\([\s\S]*force:\s*true,[\s\S]*initiator:\s*'immediate'/, file);
      assert.doesNotMatch(fetchBody, /loadSeasonWorkspaceWindow/, file);
    }
    assert.doesNotMatch(fetchBody, /syncNow\(/, file);
    assert.doesNotMatch(fetchBody, /fetchUpdatesNow/, file);
    assert.doesNotMatch(fetchBody, /syncNativePendingChanges/, file);
  }
});

test('realtime direct updates never use route reload APIs', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /router\.refresh\(\)|location\.reload\(\)|window\.location\.reload\(\)/, file);
  }
});
