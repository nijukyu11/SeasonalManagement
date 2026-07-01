import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const routeFiles = [
  'src/app/SeasonalSchedulePage.tsx',
  'src/app/detailed/page.tsx',
  'src/app/daily/page.tsx',
  'src/app/checkin/page.tsx',
  'src/app/gate/page.tsx',
  'src/app/dashboard/page.tsx',
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
  const source = readFileSync(join(process.cwd(), 'src/app/components/SyncActionButton.tsx'), 'utf8');
  assert.match(source, /pendingCount/);
  assert.match(source, /Save pending/);
  assert.match(source, /Submit pending changes to server/);
  assert.doesNotMatch(source, /Fetch data/);
  assert.doesNotMatch(source, /onFetch/);
  assert.doesNotMatch(source, /fetchUpdatesNow/);
});

test('FetchServerUpdatesButton is read-only server refresh UI', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/components/FetchServerUpdatesButton.tsx'), 'utf8');
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
    if (file === 'src/app/SeasonalSchedulePage.tsx') {
      assert.match(fetchBody, /loadSeasonRows\([^,]+,\s*true,/, file);
    } else {
      assert.match(fetchBody, /loadSeasonWorkspaceWindow/, file);
    }
    assert.doesNotMatch(fetchBody, /syncNow\(/, file);
    assert.doesNotMatch(fetchBody, /fetchUpdatesNow/, file);
    assert.doesNotMatch(fetchBody, /syncNativePendingChanges/, file);
  }
});
