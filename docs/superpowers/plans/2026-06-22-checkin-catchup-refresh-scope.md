# Check-in Catch-up Refresh Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop unrelated remote catch-up events from rebuilding the active Check-in allocation view while preserving real Check-in refreshes for manual fetch, baseline replacement, and remote changes that affect visible Check-in flights.

**Architecture:** Carry native catch-up target metadata through `SeasonWorkspaceChangeEvent`, publish `native-catchup` only when it represents a route-visible change, and let each active route decide whether a non-own-source workspace event is relevant. Check-in will ignore cursor-only catch-up and off-window target changes, while still refreshing on full-baseline events and manual fetch.

**Tech Stack:** Next.js/React TypeScript app, Tauri native catch-up bridge, Node source tests, existing `scripts/rule-regression-tests.cjs` guardrails.

---

## File Structure

- Modify `app/src/lib/seasonDataCache.ts`
  - Add `changedTargets` to `SeasonWorkspaceChangeEvent`.
  - Preserve existing `affectedIds` behavior for local UI publishes.
  - Dedupe raw native target keys such as `modification:LEG_ID` and `flightRecord:LEG_ID`.

- Modify `app/src/app/components/SeasonSyncProvider.tsx`
  - Pass `nativeResult.changedTargets` into `publishSeasonWorkspaceChanged`.
  - Stop publishing `native-catchup` when only `lastServerSeq` advanced and no native target changed.
  - Keep `native-baseline-refresh`, `native-baseline-merge`, and `manual-fetch` as full-refresh sources.

- Modify `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`
  - Add an optional route predicate, `shouldHandleWorkspaceChange`.
  - Apply it before scheduling refresh for an active route.
  - Preserve current same-source ignore, defer, retry, and on-activation behavior.

- Create `app/src/app/checkin/workspaceRefreshScope.ts`
  - Parse raw changed target keys.
  - Decide whether a workspace event should refresh Check-in.

- Modify `app/src/app/checkin/page.tsx`
  - Track visible Check-in record ids in a ref.
  - Pass `shouldHandleWorkspaceChange` to `useSeasonWorkspaceRefresh`.

- Modify tests:
  - `app/src/lib/seasonDataCache.test.ts`
  - `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`
  - Create `app/src/app/checkin/workspaceRefreshScope.test.ts`
  - `app/scripts/rule-regression-tests.cjs`

---

### Task 1: Carry Changed Targets Through Workspace Events

**Files:**
- Modify: `app/src/lib/seasonDataCache.ts`
- Test: `app/src/lib/seasonDataCache.test.ts`

- [ ] **Step 1: Write the failing cache event test**

Append this test to `app/src/lib/seasonDataCache.test.ts`:

```ts
test('workspace change events preserve deduped native changed targets', () => {
  const event = publishSeasonWorkspaceChanged({
    seasonId: 'season-1',
    source: 'native-catchup',
    changedTargets: ['modification:leg-1', 'flightRecord:leg-2', 'modification:leg-1'],
  });

  assert.deepEqual(event.changedTargets, ['modification:leg-1', 'flightRecord:leg-2']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
cd app
node --test src/lib/seasonDataCache.test.ts
```

Expected: FAIL because `changedTargets` is not currently part of `SeasonWorkspaceChangeEvent`.

- [ ] **Step 3: Add `changedTargets` to the event contract**

In `app/src/lib/seasonDataCache.ts`, change the interfaces and publisher to this shape:

```ts
export interface SeasonWorkspaceChangeEvent {
  seasonId: string;
  eventSeq: number;
  localRevision: number | null;
  changedAt: number;
  source: string;
  affectedIds: string[];
  changedTargets: string[];
  syncMeta: LocalSyncMeta | null;
}

type WritableSeasonWorkspaceChangeEvent = {
  seasonId: string;
  localRevision?: number | null;
  changedAt?: number;
  source?: string;
  affectedIds?: string[];
  changedTargets?: string[];
  syncMeta?: LocalSyncMeta | null;
};
```

Update `publishSeasonWorkspaceChanged`:

```ts
export function publishSeasonWorkspaceChanged(event: WritableSeasonWorkspaceChangeEvent): SeasonWorkspaceChangeEvent {
  const nextEvent: SeasonWorkspaceChangeEvent = {
    seasonId: event.seasonId,
    eventSeq: ++seasonWorkspaceEventSeq,
    localRevision: event.localRevision ?? null,
    changedAt: event.changedAt ?? Date.now(),
    source: event.source ?? 'unknown',
    affectedIds: event.affectedIds ? Array.from(new Set(event.affectedIds)) : [],
    changedTargets: event.changedTargets ? Array.from(new Set(event.changedTargets)) : [],
    syncMeta: event.syncMeta ?? null,
  };
  for (const listener of Array.from(seasonWorkspaceChangeListeners)) listener(nextEvent);
  return nextEvent;
}
```

- [ ] **Step 4: Verify the focused test passes**

Run:

```powershell
cd app
node --test src/lib/seasonDataCache.test.ts
```

Expected: PASS.

---

### Task 2: Publish Catch-up Only For Real Native Changes

**Files:**
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Test: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add source guardrails before production edit**

In `app/scripts/rule-regression-tests.cjs`, add assertions near the existing SeasonSyncProvider checks:

```js
assertContains(
  seasonSyncProviderSource,
  "changedTargets: nativeResult.changedTargets",
  "Native catch-up workspace publish must include changed target metadata"
);
assertContains(
  seasonSyncProviderSource,
  "const nativeCatchUpChanged = nativeResult.changedTargets.length > 0 || nativeResult.conflictCount > 0;",
  "Native catch-up should only publish workspace changes for real changed targets or conflicts"
);
assertNotContains(
  seasonSyncProviderSource,
  "nativeResult.appliedEvents > 0 || nativeResult.changedTargets.length > 0 || nativeResult.lastServerSeq > lastServerSeq",
  "Cursor-only native catch-up must not publish a global workspace refresh"
);
```

- [ ] **Step 2: Run rules and verify they fail**

Run:

```powershell
cd app
npm run test:rules
```

Expected: FAIL because the provider still publishes on cursor-only advancement.

- [ ] **Step 3: Tighten the `native-catchup` publish condition**

In `app/src/app/components/SeasonSyncProvider.tsx`, replace the catch-up publish block around the current `nativeResult` handling with:

```ts
if (nativeResult) {
  const summary = await queryNativeSyncSummary(seasonId);
  const nativeCatchUpChanged = nativeResult.changedTargets.length > 0 || nativeResult.conflictCount > 0;
  if (nativeCatchUpChanged || manualFetch) {
    publishSeasonWorkspaceChanged({
      seasonId,
      localRevision: summary?.localRevision ?? nativeResult.lastServerSeq,
      source: publishSource ?? 'native-catchup',
      changedTargets: nativeResult.changedTargets,
    });
  }
  patchStateFromNativeSummary(seasonId, summary);
  const conflictCount = summary?.conflictCount ?? 0;
  const changed = nativeCatchUpChanged || nativeResult.lastServerSeq > lastServerSeq;
  return {
    status: conflictCount > 0 ? 'conflict' : 'synced',
    message: conflictCount > 0
      ? `${conflictCount} remote conflict${conflictCount === 1 ? '' : 's'} need review.`
      : changed
        ? 'Server updates fetched.'
        : 'No server updates found.',
    reviewCount: conflictCount || undefined,
  };
}
```

Manual fetch stays explicit because the user invoked it. Background `native-catchup` no longer publishes a route refresh when it only advances the cursor.

- [ ] **Step 4: Verify rules pass**

Run:

```powershell
cd app
npm run test:rules
```

Expected: PASS.

---

### Task 3: Let Routes Filter Non-own-source Workspace Events

**Files:**
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`
- Test: `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`

- [ ] **Step 1: Add source-level regression checks**

Append this test to `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`:

```ts
test('season workspace refresh lets active routes filter non-own-source events before scheduling refresh', () => {
  assert.match(source, /shouldHandleWorkspaceChange\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*boolean/);
  assert.match(source, /const shouldHandleWorkspaceChangeRef = useRef\(shouldHandleWorkspaceChange\)/);
  assert.match(source, /shouldHandleWorkspaceChangeRef\.current = shouldHandleWorkspaceChange/);
  assert.match(
    source,
    /if \(currentRouteActive && shouldHandleWorkspaceChangeRef\.current && !shouldHandleWorkspaceChangeRef\.current\(event\)\) return;/
  );
});
```

- [ ] **Step 2: Run the focused hook source test and verify it fails**

Run:

```powershell
cd app
node --test src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts
```

Expected: FAIL because the predicate does not exist yet.

- [ ] **Step 3: Add the predicate option**

In `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`, update the options:

```ts
interface UseSeasonWorkspaceRefreshOptions {
  seasonId: string | null | undefined;
  policy: 'background' | 'on-activation';
  source: string;
  onNativeRefresh?: (event: SeasonWorkspaceChangeEvent) => Promise<void> | void;
  shouldDeferRefresh?: () => boolean;
  shouldHandleWorkspaceChange?: (event: SeasonWorkspaceChangeEvent) => boolean;
}
```

Add the ref:

```ts
const shouldHandleWorkspaceChangeRef = useRef(shouldHandleWorkspaceChange);
```

Update the ref effect:

```ts
useEffect(() => {
  onNativeRefreshRef.current = onNativeRefresh;
  shouldDeferRefreshRef.current = shouldDeferRefresh;
  shouldHandleWorkspaceChangeRef.current = shouldHandleWorkspaceChange;
  seasonIdRef.current = seasonId;
  policyRef.current = policy;
  sourceRef.current = source;
  isRouteActiveRef.current = isRouteActive;
}, [isRouteActive, onNativeRefresh, policy, seasonId, shouldDeferRefresh, shouldHandleWorkspaceChange, source]);
```

Update the subscriber before scheduling:

```ts
if (currentRouteActive && isSameWorkspaceChangeSource(event.source, sourceRef.current)) return;
if (currentRouteActive && shouldHandleWorkspaceChangeRef.current && !shouldHandleWorkspaceChangeRef.current(event)) return;
if (policyRef.current === 'background' || currentRouteActive) {
  scheduleRefreshRef.current(event);
  return;
}
```

- [ ] **Step 4: Verify focused hook test passes**

Run:

```powershell
cd app
node --test src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts
```

Expected: PASS.

---

### Task 4: Scope Check-in Refresh To Relevant Targets

**Files:**
- Create: `app/src/app/checkin/workspaceRefreshScope.ts`
- Create: `app/src/app/checkin/workspaceRefreshScope.test.ts`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Write focused Check-in scope tests**

Create `app/src/app/checkin/workspaceRefreshScope.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshCheckInForWorkspaceChange } from './workspaceRefreshScope.ts';
import type { SeasonWorkspaceChangeEvent } from '@/lib/seasonDataCache';

function event(partial: Partial<SeasonWorkspaceChangeEvent>): SeasonWorkspaceChangeEvent {
  return {
    seasonId: 'season-1',
    eventSeq: 1,
    localRevision: null,
    changedAt: Date.now(),
    source: 'native-catchup',
    affectedIds: [],
    changedTargets: [],
    syncMeta: null,
    ...partial,
  };
}

test('check-in ignores cursor-only native catch-up events', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(event({ source: 'native-catchup' }), new Set(['leg-1'])),
    false
  );
});

test('check-in ignores native catch-up targets outside the visible allocation window', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'native-catchup', changedTargets: ['modification:leg-9', 'flightRecord:leg-10'] }),
      new Set(['leg-1'])
    ),
    false
  );
});

test('check-in refreshes when native catch-up touches a visible modification or flight record', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'native-catchup', changedTargets: ['modification:leg-1'] }),
      new Set(['leg-1'])
    ),
    true
  );
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'native-catchup', changedTargets: ['flightRecord:leg-2'] }),
      new Set(['leg-2'])
    ),
    true
  );
});

test('check-in treats baseline and manual fetch as explicit full refreshes', () => {
  for (const source of ['manual-fetch', 'native-baseline-refresh', 'native-baseline-merge']) {
    assert.equal(
      shouldRefreshCheckInForWorkspaceChange(event({ source }), new Set(['leg-1'])),
      true
    );
  }
});

test('check-in refreshes for source row targets because row-to-window impact is not locally knowable', () => {
  assert.equal(
    shouldRefreshCheckInForWorkspaceChange(
      event({ source: 'native-catchup', changedTargets: ['sourceRow:42'] }),
      new Set(['leg-1'])
    ),
    true
  );
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
cd app
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: FAIL because `workspaceRefreshScope.ts` does not exist.

- [ ] **Step 3: Implement the Check-in scope helper**

Create `app/src/app/checkin/workspaceRefreshScope.ts`:

```ts
import type { SeasonWorkspaceChangeEvent } from '@/lib/seasonDataCache';

const FULL_REFRESH_SOURCES = new Set([
  'manual-fetch',
  'native-baseline-refresh',
  'native-baseline-merge',
]);

type ParsedChangedTarget = {
  targetType: string;
  targetId: string;
};

function parseChangedTarget(rawTarget: string): ParsedChangedTarget | null {
  const separatorIndex = rawTarget.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= rawTarget.length - 1) return null;
  return {
    targetType: rawTarget.slice(0, separatorIndex),
    targetId: rawTarget.slice(separatorIndex + 1),
  };
}

export function shouldRefreshCheckInForWorkspaceChange(
  event: SeasonWorkspaceChangeEvent,
  visibleRecordIds: ReadonlySet<string>
): boolean {
  if (FULL_REFRESH_SOURCES.has(event.source)) return true;
  if (event.affectedIds.some((id) => visibleRecordIds.has(id))) return true;

  if (event.source === 'native-catchup' && event.changedTargets.length === 0) return false;

  for (const rawTarget of event.changedTargets) {
    const target = parseChangedTarget(rawTarget);
    if (!target) return true;
    if (target.targetType === 'sourceRow') return true;
    if (
      (target.targetType === 'flightRecord' || target.targetType === 'modification') &&
      visibleRecordIds.has(target.targetId)
    ) {
      return true;
    }
  }

  return event.changedTargets.length === 0;
}
```

- [ ] **Step 4: Wire the helper into Check-in page**

In `app/src/app/checkin/page.tsx`, add the import:

```ts
import { shouldRefreshCheckInForWorkspaceChange } from './workspaceRefreshScope';
```

Near the allocation view memo/ref section, add:

```ts
const visibleCheckInRecordIdsRef = useRef<Set<string>>(new Set());

useEffect(() => {
  visibleCheckInRecordIdsRef.current = new Set(
    displayAllocationView?.resourceBars.map((bar) => bar.recordId) ?? []
  );
}, [displayAllocationView?.resourceBars]);

const shouldHandleCheckInWorkspaceChange = useCallback((event: SeasonWorkspaceChangeEvent) => (
  shouldRefreshCheckInForWorkspaceChange(event, visibleCheckInRecordIdsRef.current)
), []);
```

Update the existing `useSeasonWorkspaceRefresh` call:

```ts
useSeasonWorkspaceRefresh({
  seasonId: selectedSeasonId,
  policy: 'background',
  source: 'checkin',
  shouldDeferRefresh: shouldDeferCheckInRefresh,
  shouldHandleWorkspaceChange: shouldHandleCheckInWorkspaceChange,
  onNativeRefresh: async () => {
    await flushPendingCheckInLocalCommit();
    await refreshCheckInWindow();
  },
});
```

- [ ] **Step 5: Add rule guardrails for the Check-in scope**

In `app/scripts/rule-regression-tests.cjs`, add assertions:

```js
assertContains(
  checkInPageSource,
  "shouldHandleWorkspaceChange: shouldHandleCheckInWorkspaceChange",
  "Check-in workspace refresh must filter non-own-source events by target scope"
);
assertContains(
  checkInPageSource,
  "visibleCheckInRecordIdsRef",
  "Check-in refresh scope must track visible allocation record ids"
);
assertContains(
  readSource("src/app/checkin/workspaceRefreshScope.ts"),
  "event.source === 'native-catchup' && event.changedTargets.length === 0",
  "Check-in must ignore cursor-only native catch-up events"
);
```

- [ ] **Step 6: Verify Check-in scope tests pass**

Run:

```powershell
cd app
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: PASS.

---

### Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all focused source/unit tests**

Run:

```powershell
cd app
node --test src/lib/seasonDataCache.test.ts
node --test src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run repo guardrails**

Run:

```powershell
cd app
npm run test:rules
```

Expected: PASS.

- [ ] **Step 3: Run targeted lint**

Run:

```powershell
cd app
npx eslint src/lib/seasonDataCache.ts src/lib/seasonDataCache.test.ts src/app/components/SeasonSyncProvider.tsx src/app/hooks/useSeasonWorkspaceRefresh.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/app/checkin/page.tsx src/app/checkin/workspaceRefreshScope.ts src/app/checkin/workspaceRefreshScope.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript check**

Run:

```powershell
cd app
npx tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Run production build**

Run:

```powershell
cd app
npm run build
```

Expected: PASS.

---

## Self-review

Spec coverage:
- Identifies the actual random reload trigger path: background `native-catchup`.
- Stops cursor-only catch-up from publishing a global route refresh.
- Keeps manual fetch and baseline replacement as intentional full refresh sources.
- Preserves the existing local Check-in same-source ignore.
- Adds a route-level filter so non-Check-in changes do not automatically rebuild Check-in.

Type consistency:
- `SeasonWorkspaceChangeEvent.changedTargets` is a raw string array matching native `changedTargets`.
- `shouldHandleWorkspaceChange` receives the complete `SeasonWorkspaceChangeEvent`.
- Check-in helper receives `ReadonlySet<string>` of visible record ids.

Risk:
- `sourceRow` targets still force Check-in refresh because current metadata cannot map source row index to visible allocation records cheaply.
- Field-level distinction inside `modification` is not available from native `changedTargets`, so a visible-leg gate-only remote modification may still refresh Check-in. This is acceptable for the narrow fix because it prevents unrelated/off-window catch-up reloads without changing native event payload format.
