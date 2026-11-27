/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const desktopAppRoot = path.join(root, 'src', 'app', '(desktop)');

// 1. Transpile seasonDataCache.ts fixture
const seasonDataCacheSource = fs.readFileSync(path.join(root, 'src', 'lib', 'seasonDataCache.ts'), 'utf8');
const compiledSeasonDataCache = ts.transpileModule(seasonDataCacheSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
});
const seasonDataCacheMod = { exports: {} };
new Function('require', 'module', 'exports', compiledSeasonDataCache.outputText)(
  require,
  seasonDataCacheMod,
  seasonDataCacheMod.exports
);
const seasonDataCache = seasonDataCacheMod.exports;

// 2. Transpile useSeasonWorkspaceRefresh.ts
const refreshHookSourcePath = path.join(desktopAppRoot, 'hooks', 'useSeasonWorkspaceRefresh.ts');
const refreshHookSource = fs.readFileSync(refreshHookSourcePath, 'utf8');
const compiledRefreshHook = ts.transpileModule(refreshHookSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
});

function loadRefreshHookModule({ reactMock, seasonDataCacheMock, routeCacheContextMock }) {
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id === 'react') return reactMock;
    if (id === '@/lib/seasonDataCache' || id.endsWith('seasonDataCache')) return seasonDataCacheMock;
    if (id.endsWith('RouteCacheContext')) return routeCacheContextMock;
    return require(id);
  };
  const fn = new Function('require', 'module', 'exports', compiledRefreshHook.outputText);
  fn(customRequire, mod, mod.exports);
  return mod.exports;
}

// 3. Extract and transpile check-in page callbacks
const checkInPageSourcePath = path.join(desktopAppRoot, 'checkin', 'page.tsx');
const checkInPageSource = fs.readFileSync(checkInPageSourcePath, 'utf8');

function extractUseCallbackBody(source, callbackName) {
  const marker = `const ${callbackName} = useCallback(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Cannot find useCallback for ${callbackName}`);
  const fnStart = start + marker.length;

  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inString = false;
  let stringChar = '';

  for (let i = fnStart; i < source.length; i++) {
    const char = source[i];
    const prevChar = source[i - 1];

    if (inString) {
      if (char === stringChar && prevChar !== '\\') {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '(') depthParen++;
    else if (char === ')') depthParen--;
    else if (char === '{') depthBrace++;
    else if (char === '}') depthBrace--;
    else if (char === '[') depthBracket++;
    else if (char === ']') depthBracket--;

    if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && char === ',') {
      return source.slice(fnStart, i).trim();
    }
  }
  throw new Error(`Failed to extract callback body for ${callbackName}`);
}

function extractCheckInOnRefresh(source) {
  const marker = 'onRefresh: async (event) => {';
  const start = source.indexOf(marker);
  assert(start >= 0, 'Could not find onRefresh in checkInPageSource');
  const fnStart = start + 'onRefresh: '.length;

  let depthBrace = 0;
  for (let i = fnStart; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depthBrace++;
    else if (char === '}') {
      depthBrace--;
      if (depthBrace === 0) {
        return source.slice(fnStart, i + 1).trim();
      }
    }
  }
  throw new Error('Failed to extract onRefresh from checkInPageSource');
}

function transpileFunction(fnSource) {
  return ts.transpileModule(`const callback = (${fnSource});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}

function bindFunction(transpiledSource, scope) {
  const keys = Object.keys(scope);
  const values = Object.values(scope);
  return new Function(...keys, `${transpiledSource}\nreturn callback;`)(...values);
}

const shouldDeferCheckInRefreshSource = extractUseCallbackBody(checkInPageSource, 'shouldDeferCheckInRefresh');
const flushPendingCheckInLocalCommitSource = extractUseCallbackBody(checkInPageSource, 'flushPendingCheckInLocalCommit');
const refreshCheckInWindowSource = extractUseCallbackBody(checkInPageSource, 'refreshCheckInWindow');
const onRefreshSource = extractCheckInOnRefresh(checkInPageSource);

const transpiledShouldDefer = transpileFunction(shouldDeferCheckInRefreshSource);
const transpiledFlushPending = transpileFunction(flushPendingCheckInLocalCommitSource);
const transpiledRefreshWindow = transpileFunction(refreshCheckInWindowSource);
const transpiledOnRefresh = transpileFunction(onRefreshSource);

// 4. Mock Window and Controlled Timer Management
function createMockWindow() {
  let timerId = 0;
  const timers = new Map();
  let idleId = 0;
  const idles = new Map();

  return {
    setTimeout(fn, delay = 0) {
      const id = ++timerId;
      timers.set(id, { fn, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestIdleCallback(fn, options) {
      const id = ++idleId;
      idles.set(id, { fn, options });
      return id;
    },
    cancelIdleCallback(id) {
      idles.delete(id);
    },
    advanceTimers(ms = 500) {
      const ready = [];
      for (const [id, t] of Array.from(timers.entries())) {
        t.delay -= ms;
        if (t.delay <= 0) {
          timers.delete(id);
          ready.push(t.fn);
        }
      }
      for (const fn of ready) {
        fn();
      }
    },
    flushIdles() {
      const ready = [];
      for (const [id, idle] of Array.from(idles.entries())) {
        idles.delete(id);
        ready.push(idle.fn);
      }
      for (const fn of ready) {
        fn();
      }
    },
    get activeTimersCount() {
      return timers.size;
    },
  };
}

// 5. Hook Harness executing real useSeasonWorkspaceRefresh
function createHookHarness({ isRouteActive = true, seasonDataCacheInstance = seasonDataCache } = {}) {
  let hookIndex = 0;
  const hooks = [];
  const effects = [];
  let currentRouteActive = isRouteActive;

  const reactMock = {
    useRef(initialValue) {
      const idx = hookIndex++;
      if (!(idx in hooks)) {
        hooks[idx] = { current: initialValue };
      }
      return hooks[idx];
    },
    useEffect(effect, deps) {
      const idx = hookIndex++;
      const prev = hooks[idx];
      const hasChanged = !prev || !deps || deps.some((d, i) => d !== prev.deps[i]);
      if (hasChanged) {
        effects.push({ effect, idx, prevCleanup: prev?.cleanup });
        hooks[idx] = { deps, cleanup: undefined };
      }
    },
  };

  const routeCacheContextMock = {
    useCachedRouteActivity: () => currentRouteActive,
  };

  const loaded = loadRefreshHookModule({
    reactMock,
    seasonDataCacheMock: seasonDataCacheInstance,
    routeCacheContextMock,
  });
  const useSeasonWorkspaceRefresh = loaded.useSeasonWorkspaceRefresh;

  function flushEffects() {
    while (effects.length > 0) {
      const item = effects.shift();
      if (typeof item.prevCleanup === 'function') {
        item.prevCleanup();
      }
      const cleanup = item.effect();
      if (typeof cleanup === 'function') {
        hooks[item.idx].cleanup = cleanup;
      }
    }
  }

  function render(props) {
    hookIndex = 0;
    useSeasonWorkspaceRefresh(props);
    flushEffects();
  }

  function setRouteActive(active, currentProps) {
    currentRouteActive = active;
    render(currentProps);
  }

  function unmount() {
    for (const h of hooks) {
      if (h && typeof h.cleanup === 'function') {
        h.cleanup();
        h.cleanup = undefined;
      }
    }
  }

  return {
    render,
    setRouteActive,
    unmount,
  };
}

// 6. Test Suite
test('checkin workspace refresh: direct patches do not fetch and bypass interaction deferral', async () => {
  const mockWindow = createMockWindow();
  globalThis.window = mockWindow;

  // Case 1A: shouldDeferCheckInRefresh does not defer direct patches even while drag/resize/pending commit is active
  const deferScope = {
    checkInLocalCommitPending: true,
    draggedGroupId: 'group-123',
    resizeState: { recordId: 'flight-1' },
    Boolean,
  };
  const shouldDefer = bindFunction(transpiledShouldDefer, deferScope);

  const directEvent = {
    seasonId: 'season-s26',
    eventSeq: 10,
    localRevision: 1,
    changedAt: Date.now(),
    source: 'checkin-worker',
    affectedIds: ['flight-1'],
    changedTargets: ['flight:flight-1'],
    syncMeta: null,
    refreshMode: 'direct',
    serverEvent: null,
    revalidationReason: null,
  };

  assert.equal(
    shouldDefer(directEvent),
    false,
    'Direct workspace patches must not be deferred even during drag/resize/pending local commits'
  );

  // Case 1B: onRefresh with direct patch does not trigger force fetch of settings or remote workspace window
  let getOperationalSettingsForceCount = 0;
  let loadSeasonWorkspaceWindowCount = 0;

  const mockSettings = { counters: ['C01', 'C02'], version: 1 };
  const checkInScope = {
    isOperationalScheduleV1Enabled: () => true,
    clearOptimisticAllocationView: () => {},
    operationalRequestIdRef: { current: 0 },
    fromDateTime: '2026-07-01T00:00:00',
    toDateTime: '2026-07-02T23:59:59',
    currentRangeRef: { current: { fromDateTime: '2026-07-01T00:00:00', toDateTime: '2026-07-02T23:59:59' } },
    isRouteActiveRef: { current: true },
    settingsRef: { current: mockSettings },
    getOperationalSettings: async ({ force }) => {
      if (force) getOperationalSettingsForceCount++;
      return mockSettings;
    },
    getCachedOperationalSettings: () => mockSettings,
    loadFullOperationalScheduleWindow: async () => ({
      snapshot: { rows: [] },
      records: [{ id: 'FL-01' }],
    }),
    getOperationalScheduleAllocationWindowV1: async () => ({}),
    setSettings: () => {},
    operationalSnapshotRef: { current: null },
    useOperationalScheduleStore: { setState: () => {} },
    setFlightRecords: () => {},
    replaceCheckInModifications: () => {},
    setLoadProgress: () => {},
    setLoadError: () => {},
    setLoading: () => {},
    buildLoadProgress: (msg, percent, status) => ({ msg, percent, status }),
    season: { id: 'season-s26', dataVersion: 1 },
    buildCheckInWindowKey: (from, to) => `${from}_${to}`,
    loadSeasonWorkspaceWindow: async () => {
      loadSeasonWorkspaceWindowCount++;
    },
    readWorkspaceWindowSnapshot: () => ({
      syncMeta: { pendingCount: 0, lastLocalChangeAt: 0 },
      records: [{ id: 'FL-01' }],
      modifications: new Map(),
    }),
    useSeasonWorkspaceStore: { getState: () => ({ workspaces: { 'season-s26': {} } }) },
    setSyncSummary: () => {},
    setCachedSeasonData: () => {},
    loadedWindowKeyRef: { current: null },
    showAlert: async () => {},
    Promise,
    Error,
    Boolean,
    Map,
    console,
  };

  const refreshCheckInWindow = bindFunction(transpiledRefreshWindow, checkInScope);
  const flushPendingCheckInLocalCommit = async () => {};

  const onRefresh = bindFunction(transpiledOnRefresh, {
    flushPendingCheckInLocalCommit,
    refreshCheckInWindow,
  });

  await onRefresh(directEvent);

  assert.equal(
    getOperationalSettingsForceCount,
    0,
    'Direct workspace refresh must not force-fetch operational settings when already in memory'
  );

  // Planning mode verification: direct refresh must not call loadSeasonWorkspaceWindow
  checkInScope.isOperationalScheduleV1Enabled = () => false;
  await onRefresh(directEvent);

  assert.equal(
    loadSeasonWorkspaceWindowCount,
    0,
    'Direct workspace refresh in planning mode must consume memory workspace without fetching server window'
  );
});

test('checkin workspace refresh: drag, resize, and pending commit defer fallback refresh until idle', async () => {
  const mockWindow = createMockWindow();
  globalThis.window = mockWindow;

  const fallbackEvent = {
    seasonId: 'season-s26',
    eventSeq: 101,
    localRevision: null,
    changedAt: Date.now(),
    source: 'server-live',
    affectedIds: ['flight-2'],
    changedTargets: ['flight:flight-2'],
    syncMeta: null,
    refreshMode: 'fallback',
    serverEvent: null,
    revalidationReason: null,
  };

  // 1. Check callback behavior with each interaction flag
  const checkDefer = (overrides) => {
    const scope = {
      checkInLocalCommitPending: false,
      draggedGroupId: null,
      resizeState: null,
      Boolean,
      ...overrides,
    };
    return bindFunction(transpiledShouldDefer, scope)(fallbackEvent);
  };

  assert.equal(checkDefer({ draggedGroupId: 'GRP-1' }), true, 'Fallback refresh must defer during drag');
  assert.equal(checkDefer({ resizeState: { recordId: 'R1' } }), true, 'Fallback refresh must defer during resize');
  assert.equal(checkDefer({ checkInLocalCommitPending: true }), true, 'Fallback refresh must defer during pending commit');
  assert.equal(checkDefer({}), false, 'Fallback refresh must not defer when idle');

  // 2. Execute actual useSeasonWorkspaceRefresh hook with harness
  const refreshCalls = [];
  let isDragging = true;

  const harness = createHookHarness({ isRouteActive: true });

  const hookProps = {
    seasonId: 'season-s26',
    policy: 'on-activation',
    source: 'checkin',
    shouldDeferRefresh: (event) => (
      event.refreshMode !== 'direct' && isDragging
    ),
    shouldHandleWorkspaceChange: () => true,
    onRefresh: async (event) => {
      refreshCalls.push(event);
    },
  };

  harness.render(hookProps);

  // Emit fallback change event while dragging
  seasonDataCache.publishSeasonWorkspaceChanged({
    seasonId: 'season-s26',
    refreshMode: 'fallback',
    source: 'server-live',
    affectedIds: ['flight-2'],
  });

  // Advance past debounce timer
  mockWindow.advanceTimers(300);
  mockWindow.flushIdles();

  assert.equal(
    refreshCalls.length,
    0,
    'Deferred refresh must not trigger onRefresh while drag interaction is in progress'
  );

  // Now finish drag: rerender hook with isDragging = false
  isDragging = false;
  harness.render({
    ...hookProps,
    shouldDeferRefresh: (event) => (
      event.refreshMode !== 'direct' && isDragging
    ),
  });

  // Advance debounce timer scheduled upon un-deferral
  mockWindow.advanceTimers(200);
  mockWindow.flushIdles();

  assert.equal(
    refreshCalls.length,
    1,
    'Deferred workspace event must execute once drag interaction completes'
  );

  harness.unmount();
});

test('checkin workspace refresh: flush pending local commit before canonical refresh', async () => {
  const mockWindow = createMockWindow();
  globalThis.window = mockWindow;

  const executionSequence = [];
  let pendingAccumulatorCleared = false;
  let timerCleared = false;

  const pendingEntry = {
    legIds: ['leg-101'],
    modifications: [{ legId: 'leg-101', counter: 'C05' }],
  };

  const accumulatorRef = { current: pendingEntry };
  const timerRef = { current: 1234 };

  const flushScope = {
    checkInCommitFlushTimerRef: timerRef,
    window: {
      clearTimeout: (id) => {
        if (id === 1234) timerCleared = true;
      },
    },
    checkInCommitAccumulatorRef: accumulatorRef,
    setCheckInLocalCommitPending: () => {},
    flushAccumulatedCheckInCommit: async (entry) => {
      executionSequence.push({ action: 'flush', entry });
      if (accumulatorRef.current === null) {
        pendingAccumulatorCleared = true;
      }
    },
    commitQueueRef: { current: Promise.resolve() },
    updateCheckInLocalCommitPending: () => {},
  };

  const flushPendingCheckInLocalCommit = bindFunction(transpiledFlushPending, flushScope);

  let refreshExecuted = false;
  const refreshCheckInWindow = async () => {
    executionSequence.push({ action: 'refresh' });
    refreshExecuted = true;
  };

  const onRefresh = bindFunction(transpiledOnRefresh, {
    flushPendingCheckInLocalCommit,
    refreshCheckInWindow,
  });

  const refreshEvent = {
    seasonId: 'season-s26',
    eventSeq: 200,
    localRevision: null,
    changedAt: Date.now(),
    source: 'server-live',
    affectedIds: ['leg-101'],
    changedTargets: ['flight:leg-101'],
    syncMeta: null,
    refreshMode: 'revalidate',
    serverEvent: null,
    revalidationReason: null,
  };

  await onRefresh(refreshEvent);

  assert.equal(timerCleared, true, 'Timer must be cancelled when flushing pending commit');
  assert.equal(pendingAccumulatorCleared, true, 'Pending accumulator must be captured and cleared before flushing');
  assert.equal(refreshExecuted, true, 'Canonical refresh must execute');
  assert.deepEqual(
    executionSequence.map((e) => e.action),
    ['flush', 'refresh'],
    'Pending local commit must be flushed to persistence strictly before canonical refresh runs'
  );
});

test('checkin workspace refresh: initial load vs Realtime refresh cannot strand settings or loading state', async () => {
  const mockWindow = createMockWindow();
  globalThis.window = mockWindow;

  // Part A: Realtime refresh tolerates transient settings failure and reuses existing settings
  const existingSettings = { counters: ['C01'], version: 1 };
  let loadingState = false;
  let appliedRecords = null;

  const realtimeScope = {
    isOperationalScheduleV1Enabled: () => true,
    clearOptimisticAllocationView: () => {},
    operationalRequestIdRef: { current: 0 },
    fromDateTime: '2026-07-01T00:00:00',
    toDateTime: '2026-07-02T23:59:59',
    currentRangeRef: { current: { fromDateTime: '2026-07-01T00:00:00', toDateTime: '2026-07-02T23:59:59' } },
    isRouteActiveRef: { current: true },
    settingsRef: { current: existingSettings },
    getOperationalSettings: async () => {
      throw new Error('Supabase 503 Service Unavailable');
    },
    getCachedOperationalSettings: () => existingSettings,
    loadFullOperationalScheduleWindow: async () => ({
      snapshot: { rows: [] },
      records: [{ id: 'LIVE-FLIGHT' }],
    }),
    getOperationalScheduleAllocationWindowV1: async () => ({}),
    setSettings: () => {},
    operationalSnapshotRef: { current: null },
    useOperationalScheduleStore: { setState: () => {} },
    setFlightRecords: (r) => { appliedRecords = r; },
    replaceCheckInModifications: () => {},
    setLoadProgress: () => {},
    setLoadError: () => {},
    setLoading: (l) => { loadingState = l; },
    buildLoadProgress: (msg, percent, status) => ({ msg, percent, status }),
    season: null,
    buildCheckInWindowKey: () => '',
    loadSeasonWorkspaceWindow: async () => {},
    readWorkspaceWindowSnapshot: () => null,
    useSeasonWorkspaceStore: { getState: () => ({ workspaces: {} }) },
    setSyncSummary: () => {},
    setCachedSeasonData: () => {},
    loadedWindowKeyRef: { current: null },
    showAlert: async () => {},
    Promise,
    Error,
    Boolean,
    Map,
    console,
  };

  const realtimeRefresh = bindFunction(transpiledRefreshWindow, realtimeScope);

  loadingState = true;
  const realtimeResult = await realtimeRefresh({ revalidate: true });

  assert.notEqual(realtimeResult, null, 'Realtime refresh must succeed with recovered settings');
  assert.equal(loadingState, false, 'Realtime refresh must not leave loading stranded at true');
  assert.deepEqual(appliedRecords, [{ id: 'LIVE-FLIGHT' }], 'Records must be updated despite settings transient failure');

  // Part B: Initial load without settings throws clean error but clears loading in finally
  let initialLoadingState = true;
  let initialErrorThrown = null;

  const initialLoadScope = {
    ...realtimeScope,
    operationalRequestIdRef: { current: 10 },
    settingsRef: { current: null },
    getCachedOperationalSettings: () => null,
    getOperationalSettings: async () => {
      throw new Error('Initial settings fetch failed');
    },
    setLoading: (l) => { initialLoadingState = l; },
  };

  const initialRefresh = bindFunction(transpiledRefreshWindow, initialLoadScope);

  try {
    await initialRefresh();
  } catch (err) {
    initialErrorThrown = err;
  }

  assert.notEqual(initialErrorThrown, null, 'Initial load without settings must reject');
  assert.match(initialErrorThrown.message, /cấu hình vận hành/i);
  assert.equal(
    initialLoadingState,
    false,
    'Initial load must clear loading in finally block so UI is never stranded in infinite loading'
  );
});

test('checkin workspace refresh: stale range response is ignored and cannot overwrite current view or premature end loading', async () => {
  const mockWindow = createMockWindow();
  globalThis.window = mockWindow;

  let loadingState = false;
  let appliedRecords = [];

  let resolveRange1;
  const range1Promise = new Promise((res) => { resolveRange1 = res; });
  let resolveRange2;
  const range2Promise = new Promise((res) => { resolveRange2 = res; });

  const staleScope = {
    isOperationalScheduleV1Enabled: () => true,
    clearOptimisticAllocationView: () => {},
    operationalRequestIdRef: { current: 0 },
    fromDateTime: '2026-07-01T00:00:00',
    toDateTime: '2026-07-02T23:59:59',
    currentRangeRef: { current: { fromDateTime: '2026-07-01T00:00:00', toDateTime: '2026-07-02T23:59:59' } },
    isRouteActiveRef: { current: true },
    settingsRef: { current: { counters: ['C1'] } },
    getOperationalSettings: async () => ({ counters: ['C1'] }),
    getCachedOperationalSettings: () => ({ counters: ['C1'] }),
    loadFullOperationalScheduleWindow: async ({ startDate }) => {
      if (startDate === '2026-07-01') return range1Promise;
      if (startDate === '2026-07-10') return range2Promise;
      throw new Error(`Unexpected startDate: ${startDate}`);
    },
    getOperationalScheduleAllocationWindowV1: async () => ({}),
    setSettings: () => {},
    operationalSnapshotRef: { current: null },
    useOperationalScheduleStore: { setState: () => {} },
    setFlightRecords: (records) => { appliedRecords = records; },
    replaceCheckInModifications: () => {},
    setLoadProgress: () => {},
    setLoadError: () => {},
    setLoading: (l) => { loadingState = l; },
    buildLoadProgress: (msg, percent, status) => ({ msg, percent, status }),
    season: null,
    buildCheckInWindowKey: () => '',
    loadSeasonWorkspaceWindow: async () => {},
    readWorkspaceWindowSnapshot: () => null,
    useSeasonWorkspaceStore: { getState: () => ({ workspaces: {} }) },
    setSyncSummary: () => {},
    setCachedSeasonData: () => {},
    loadedWindowKeyRef: { current: null },
    showAlert: async () => {},
    Promise,
    Error,
    Boolean,
    Map,
    console,
  };

  const refreshCheckInWindow = bindFunction(transpiledRefreshWindow, staleScope);

  // 1. User starts Request 1 for Range 1
  loadingState = true;
  const req1 = refreshCheckInWindow();

  // 2. User quickly navigates to Range 2 while Request 1 is still in flight
  staleScope.fromDateTime = '2026-07-10T00:00:00';
  staleScope.toDateTime = '2026-07-11T23:59:59';
  staleScope.currentRangeRef.current = {
    fromDateTime: '2026-07-10T00:00:00',
    toDateTime: '2026-07-11T23:59:59',
  };
  const req2 = bindFunction(transpiledRefreshWindow, staleScope)();

  // 3. Stale Request 1 finishes first
  resolveRange1({
    snapshot: { id: 'snap-stale' },
    records: [{ id: 'STALE-RANGE-1-FLIGHT' }],
  });

  const res1 = await req1;

  assert.equal(res1, null, 'Stale range response must return null and be discarded');
  assert.equal(
    appliedRecords.length,
    0,
    'Stale range response must not apply records to state'
  );
  assert.equal(
    loadingState,
    true,
    'Stale response must not reset loading state to false while newer request is still in flight'
  );

  // 4. Newer Request 2 finishes
  resolveRange2({
    snapshot: { id: 'snap-current' },
    records: [{ id: 'CURRENT-RANGE-2-FLIGHT' }],
  });

  const res2 = await req2;

  assert.notEqual(res2, null, 'Active request must complete successfully');
  assert.deepEqual(
    appliedRecords,
    [{ id: 'CURRENT-RANGE-2-FLIGHT' }],
    'Active date range records must be applied'
  );
  assert.equal(
    loadingState,
    false,
    'Loading state must be set to false when active request settles'
  );

  // A Realtime handshake supersedes initial loading while settings is still pending.
  let resolveInitialSettings;
  const pendingSettings = new Promise((resolve) => { resolveInitialSettings = resolve; });
  staleScope.settingsRef.current = null;
  staleScope.getOperationalSettings = () => pendingSettings;
  staleScope.loadFullOperationalScheduleWindow = async () => ({
    snapshot: { id: 'initial' }, records: [{ id: 'INITIAL' }],
  });
  loadingState = true;
  const initial = bindFunction(transpiledRefreshWindow, staleScope)();
  staleScope.getOperationalSettings = async () => ({ counters: ['READY'] });
  staleScope.loadFullOperationalScheduleWindow = async () => ({
    snapshot: { id: 'realtime' }, records: [{ id: 'REALTIME' }],
  });
  await bindFunction(transpiledRefreshWindow, staleScope)({ revalidate: true });
  assert.equal(loadingState, false, 'Realtime owner must finish initial loading');
  assert.deepEqual(staleScope.settingsRef.current, { counters: ['READY'] });
  assert.deepEqual(appliedRecords, [{ id: 'REALTIME' }]);
  resolveInitialSettings({ counters: ['STALE'] });
  assert.equal(await initial, null);
  assert.deepEqual(staleScope.settingsRef.current, { counters: ['READY'] });
  assert.deepEqual(appliedRecords, [{ id: 'REALTIME' }]);
});
