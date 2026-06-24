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

function extractBalancedBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  assert.fail('Could not extract balanced block');
}

function extractFunctionBody(source: string, functionName: string): string {
  const start = source.indexOf(`const ${functionName} =`);
  assert(start >= 0, functionName);
  const arrow = source.indexOf('=>', start);
  assert(arrow > start, functionName);
  const open = source.indexOf('{', arrow);
  assert(open > arrow, functionName);
  return extractBalancedBlock(source, open);
}

function extractEffectContaining(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert(markerIndex >= 0, marker);
  const effectStart = source.lastIndexOf('useEffect(() => {', markerIndex);
  assert(effectStart >= 0, marker);
  const open = source.indexOf('{', effectStart);
  assert(open > effectStart, marker);
  return extractBalancedBlock(source, open);
}

function extractCallObjects(source: string, callName: string): string[] {
  const blocks: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const callStart = source.indexOf(`${callName}({`, offset);
    if (callStart < 0) break;
    const open = source.indexOf('{', callStart);
    const block = extractBalancedBlock(source, open);
    blocks.push(block);
    offset = open + block.length;
  }
  return blocks;
}

function assertBefore(source: string, earlier: string, later: string, label: string): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(earlierIndex >= 0, `${label}: missing ${earlier}`);
  assert(laterIndex >= 0, `${label}: missing ${later}`);
  assert(earlierIndex < laterIndex, `${label}: ${earlier} must come before ${later}`);
}

test('route pages consult shared workspace read model before native query', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /readCachedWorkspaceWindow/, file);
    assert.match(source, /useSeasonWorkspaceStore/, file);
  }
});

test('server-authoritative routes do not silently fall back to native SQLite when server fetch fails', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /SERVER_AUTHORITATIVE_MODE/, file);
    assert.match(source, /loadSeasonWorkspaceWindow/, file);
    assert.match(source, /Loading server workspace/, file);
    assert.match(
      source,
      /loadSeasonWorkspaceWindow[\s\S]*?queryNative(?:Schedule|Allocation)Window/,
      file
    );
    assert.match(
      source,
      /loadSeasonWorkspaceWindow\([\s\S]*?\)\.catch\(\(error\) => \{[\s\S]*?if \(SERVER_AUTHORITATIVE_MODE\) throw error;[\s\S]*?falling back to native SQLite/,
      file
    );
  }
});

test('server workspace windows publish clean sync metadata to the global sync badge', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(
      source,
      /loadSeasonWorkspaceWindow[\s\S]*?if \(serverWindow\)[\s\S]*?publishSeasonWorkspaceChanged\({[\s\S]*?source:\s*'server-window'[\s\S]*?syncMeta:\s*serverWindow\.syncMeta/,
      file
    );
  }
});

test('server workspace windows request full self-hosted season capacity instead of 10k slices', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const callSources = extractCallObjects(source, 'loadSeasonWorkspaceWindow');
    assert(callSources.length > 0, file);
    for (const callSource of callSources) {
      assert.match(callSource, /limit:\s*100000/, file);
      assert.doesNotMatch(callSource, /limit:\s*10000\s*[,}]/, file);
    }
  }
});

test('Fetch data actions force server workspace reload and bypass native submit sync', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /loadSeasonWorkspaceWindow/, file);
    const fetchSource = extractFunctionBody(source, 'fetchServerData');
    if (file === 'src/app/SeasonalSchedulePage.tsx') {
      assert.match(fetchSource, /loadSeasonRows\(activeSeason,\s*true,/, file);
    } else {
      assert.match(fetchSource, /loadSeasonWorkspaceWindow/, file);
    }
    assert.doesNotMatch(fetchSource, /syncNow\(/, file);
    assert.doesNotMatch(fetchSource, /fetchUpdatesNow/, file);
    assert.doesNotMatch(fetchSource, /syncNativePendingChanges/, file);
  }
});

test('heavy operational routes use a cache-first initial load before showing loading state or server workspace fetch', () => {
  const files = [
    ['src/app/daily/page.tsx', 'tryApplyCachedDailyRouteWindow'],
    ['src/app/checkin/page.tsx', 'tryApplyCachedCheckInRouteWindow'],
    ['src/app/gate/page.tsx', 'tryApplyCachedGateRouteWindow'],
  ] as const;

  for (const [file, helperName] of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const effectSource = extractEffectContaining(source, 'Loading seasons and settings');
    assert.match(source, new RegExp(`const ${helperName} = useCallback`), file);
    assertBefore(effectSource, `${helperName}()`, 'setLoading(true)', file);
    assertBefore(effectSource, `${helperName}()`, 'loadSeasonWorkspaceWindow', file);
  }
});

test('remounted heavy routes seed initial route state from cached workspace before first loading render', () => {
  const files = [
    ['src/app/daily/page.tsx', 'Daily', 'initialDailyRouteState'],
    ['src/app/checkin/page.tsx', 'CheckIn', 'initialCheckInRouteState'],
    ['src/app/gate/page.tsx', 'Gate', 'initialGateRouteState'],
    ['src/app/dashboard/page.tsx', 'Dashboard', 'initialDashboardRouteState'],
  ] as const;

  for (const [file, routeName, stateName] of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, new RegExp(`readInitial${routeName}RouteState`), `${file}: initial cache helper`);
    assert.match(
      source,
      new RegExp(`const ${stateName} = readInitial${routeName}RouteState\\(`),
      `${file}: initial state must be read before useState initializers`
    );
    assert.match(
      source,
      new RegExp(`const \\[loading, setLoading\\] = useState\\(\\(\\) => !${stateName}\\)`),
      `${file}: initial loading state must stay false when cached route state exists`
    );
  }
});

test('Fetch data does not submit unsent route-local commits before server reads', () => {
  const dailySource = readFileSync(join(process.cwd(), 'src/app/daily/page.tsx'), 'utf8');
  const dailyFetch = extractFunctionBody(dailySource, 'fetchServerData');
  assertBefore(dailyFetch, 'await currentMutationRef.current', 'loadSeasonWorkspaceWindow', 'daily');
  assertBefore(dailyFetch, 'await commitQueueRef.current', 'loadSeasonWorkspaceWindow', 'daily');

  const checkInSource = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
  const checkInFetch = extractFunctionBody(checkInSource, 'fetchServerData');
  assert.doesNotMatch(checkInFetch, /flushPendingCheckInLocalCommit/, 'checkin');
  assertBefore(checkInFetch, 'checkInCommitAccumulatorRef.current', 'loadSeasonWorkspaceWindow', 'checkin');
  assertBefore(checkInFetch, 'await currentMutationRef.current', 'loadSeasonWorkspaceWindow', 'checkin');
  assertBefore(checkInFetch, 'await commitQueueRef.current', 'loadSeasonWorkspaceWindow', 'checkin');

  const gateSource = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');
  const gateFetch = extractFunctionBody(gateSource, 'fetchServerData');
  assert.doesNotMatch(gateFetch, /flushPendingGateLocalCommit/, 'gate');
  assertBefore(gateFetch, 'gateCommitAccumulatorRef.current', 'loadSeasonWorkspaceWindow', 'gate');
  assertBefore(gateFetch, 'await currentMutationRef.current', 'loadSeasonWorkspaceWindow', 'gate');
  assertBefore(gateFetch, 'await commitQueueRef.current', 'loadSeasonWorkspaceWindow', 'gate');

  const seasonalSource = readFileSync(join(process.cwd(), 'src/app/SeasonalSchedulePage.tsx'), 'utf8');
  const seasonalFetch = extractFunctionBody(seasonalSource, 'fetchServerData');
  assert.match(seasonalFetch, /hasDraftChanges/, 'seasonal');

  const detailedSource = readFileSync(join(process.cwd(), 'src/app/detailed/page.tsx'), 'utf8');
  const detailedFetch = extractFunctionBody(detailedSource, 'fetchServerData');
  assert.match(detailedFetch, /hasDraftChanges/, 'detailed');
});

test('manual Fetch failures do not replace already loaded route data with load error state', () => {
  const files = [
    'src/app/daily/page.tsx',
    'src/app/detailed/page.tsx',
    'src/app/checkin/page.tsx',
    'src/app/gate/page.tsx',
    'src/app/dashboard/page.tsx',
  ];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const fetchSource = extractFunctionBody(source, 'fetchServerData');
    assert.match(fetchSource, /hasRouteDataLoaded/, file);
    assert.match(fetchSource, /loadedWindowKeyRef\.current === \w+WindowKey|loadedWindowKeyRef\.current === windowKey|loadedWindowKeyRef\.current === overviewWindowKey/, file);
    assert.doesNotMatch(fetchSource, /(?:records|flightRecords)\.length\s*>\s*0/, file);
    assert.doesNotMatch(fetchSource, /!loading && !loadError|!loading && !error/, file);
    const catchStart = fetchSource.indexOf('catch');
    assert(catchStart >= 0, file);
    const catchSource = fetchSource.slice(catchStart);
    assert.match(catchSource, /if \(!hasRouteDataLoaded\)/, file);
  }

  const seasonalSource = readFileSync(join(process.cwd(), 'src/app/SeasonalSchedulePage.tsx'), 'utf8');
  const seasonalFetch = extractFunctionBody(seasonalSource, 'fetchServerData');
  assert.match(seasonalFetch, /loadSeasonRows\(activeSeason,\s*true,/, 'seasonal');
  assert.doesNotMatch(seasonalFetch, /setLoadError/, 'seasonal');
});

test('manual Fetch responses are ignored after season or window changes', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /fetchServerDataRequestRef/, file);
    assert.match(source, /latestRouteWindowRef/, file);
    const fetchSource = extractFunctionBody(source, 'fetchServerData');
    assert.match(fetchSource, /requestId/, file);
    if (file === 'src/app/SeasonalSchedulePage.tsx') {
      assert.match(source, /requestGuard[\s\S]*?latestRouteWindowRef\.current\.seasonId/, file);
    } else {
      assert.match(fetchSource, /latestRouteWindowRef\.current\.seasonId !== requestedSeasonId/, file);
      assert.match(fetchSource, /latestRouteWindowRef\.current\.windowKey !== \w+WindowKey|latestRouteWindowRef\.current\.windowKey !== windowKey|latestRouteWindowRef\.current\.windowKey !== overviewWindowKey/, file);
    }
  }
});
