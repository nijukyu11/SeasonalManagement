# Online-First Legacy Sync Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove old offline-first sync, native catch-up, conflict-review, and SQLite/server-version comparison mechanisms from the normal app path so the self-hosted Supabase server is the single operational authority.

**Architecture:** Keep the app online-first and server-authoritative. Normal pages use server-window reads and server mutation RPCs; native SQLite remains a cache/read model/reporting accelerator only. Legacy native catch-up/conflict tooling is isolated behind a repair-only adapter until it can be removed after production confidence.

**Tech Stack:** Next.js App Router, React, Tauri native SQLite, Supabase RPC `apply_season_server_mutation_v1`, Supabase RPC `get_season_schedule_allocation_window_v1`, Node source-regression tests, TypeScript.

---

## Current State And Removal Boundary

- `SERVER_AUTHORITATIVE_MODE = true` is already the intended normal mode.
- `SyncActionButton` is already moving toward `Save pending`, while `FetchServerUpdatesButton` is route-level read-only `Fetch data`.
- `SeasonSyncProvider` still exposes `fetchUpdatesNow()` and `seedSeasonSyncFromNative()`.
- `SeasonSyncProvider` still imports and runs native catch-up dependencies: `runNativeSeasonCatchup`, `queryNativeSyncSummary`, `ensureNativeSeasonBaseline`, `checkNativeSeasonIntegrity`, and `SeasonAutoSyncScheduler`.
- Primary route files still carry local/native summary state, `queryNativeSyncSummary`, `seedSeasonSyncFromNative`, `syncSummary`, and route-level conflict count derivation.
- `useSeasonWorkspaceRefresh()` is still named and structured around `onNativeRefresh`.
- `SeasonConflictReviewControl` is hidden in server-authoritative mode, but primary routes can still import/render it.
- `native_catchup.rs` and `nativeSeasonCatchup.ts` still contain event replay, entity version comparison, conflict creation/resolution, and pending upload logic. These should not be deleted immediately because they are still useful for repair/rollback diagnostics.

## Target Boundary

- `Sync` / `Save pending`: submit pending mutations only. It does not fetch/replay server updates.
- `Fetch data`: read latest server-window data only. It does not submit pending mutations and does not run native catch-up.
- `useSeasonSync(...)`: returns only state needed for pending-submit UI and `syncNow()`.
- `useSeasonWorkspaceRefresh(...)`: invalidates or refreshes from server/cache events; it is no longer a native catch-up hook.
- `SeasonConflictReviewControl`: not present on primary operational routes. Keep it only in Settings/Repair while legacy data may still exist.
- Native catch-up, conflict review, entity-version reconcile: repair-only legacy adapter. No normal route or provider should import it directly.

## File Structure

- Create: `app/src/app/legacySyncCleanup.source.test.ts`
  - Source-regression tests that block reintroducing normal-path catch-up/conflict/version-compare code.
- Create: `app/src/lib/legacyNativeSyncAdapter.ts`
  - Repair-only wrapper around old native catch-up/conflict APIs.
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
  - Remove `fetchUpdatesNow()` and normal auto catch-up.
  - Stop querying native sync summary on workspace changes in server-authoritative mode.
  - Keep `syncNow()` as pending-submit only.
- Modify: `app/src/lib/seasonAutoSync.ts`
  - Simplify normal states so `catching_up`, `needs_review`, and `conflict` are legacy-only or removed from server-authoritative UI.
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`
  - Rename native-centric callback to server/cache refresh semantics.
- Modify primary route pages:
  - `app/src/app/SeasonalSchedulePage.tsx`
  - `app/src/app/detailed/page.tsx`
  - `app/src/app/daily/page.tsx`
  - `app/src/app/checkin/page.tsx`
  - `app/src/app/gate/page.tsx`
  - `app/src/app/dashboard/page.tsx`
- Modify repair/settings files:
  - `app/src/app/settings/components/SeasonRepairTab.tsx`
  - `app/src/app/components/SeasonConflictReviewControl.tsx`
- Modify tests:
  - `app/src/app/components/SeasonSyncProvider.source.test.ts`
  - `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`
  - `app/src/app/onlineFirstRoutes.source.test.ts`
  - `app/scripts/rule-regression-tests.cjs`
- Modify docs:
  - `context.md`
  - `architecture.md`

---

## Task 1: Lock The New Online-First Boundary With Source Tests

**Files:**
- Create: `app/src/app/legacySyncCleanup.source.test.ts`
- Modify: `app/scripts/rule-regression-tests.cjs`

- [ ] **Step 1: Add the failing source-regression test**

Create `app/src/app/legacySyncCleanup.source.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const primaryRouteFiles = [
  'src/app/SeasonalSchedulePage.tsx',
  'src/app/detailed/page.tsx',
  'src/app/daily/page.tsx',
  'src/app/checkin/page.tsx',
  'src/app/gate/page.tsx',
  'src/app/dashboard/page.tsx',
];

const providerSource = readFileSync(join(process.cwd(), 'src/app/components/SeasonSyncProvider.tsx'), 'utf8');

test('SeasonSyncProvider normal interface does not expose native catch-up fetch APIs', () => {
  assert.doesNotMatch(providerSource, /fetchUpdatesNow/);
  assert.doesNotMatch(providerSource, /runManualFetchSeason/);
  assert.doesNotMatch(providerSource, /catchUpSeason/);
  assert.doesNotMatch(providerSource, /pendingCatchUpSeasonIdsRef/);
});

test('SeasonSyncProvider does not import native catch-up or baseline repair APIs in the normal path', () => {
  assert.doesNotMatch(providerSource, /runNativeSeasonCatchup/);
  assert.doesNotMatch(providerSource, /ensureNativeSeasonBaseline/);
  assert.doesNotMatch(providerSource, /checkNativeSeasonIntegrity/);
  assert.doesNotMatch(providerSource, /MANUAL_FETCH_REPLAY_EVENT_WINDOW/);
});

test('primary routes do not seed or query native sync summary for badge state', () => {
  for (const file of primaryRouteFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /seedSeasonSyncFromNative/, file);
    assert.doesNotMatch(source, /queryNativeSyncSummary/, file);
    assert.doesNotMatch(source, /SeasonConflictReviewControl/, file);
  }
});

test('workspace refresh hook is no longer native-centric', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/hooks/useSeasonWorkspaceRefresh.ts'), 'utf8');
  assert.doesNotMatch(source, /onNativeRefresh/);
  assert.match(source, /onRefresh\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*Promise<void>\s*\|\s*void/);
});

test('legacy native catch-up remains isolated behind the repair adapter', () => {
  const adapterSource = readFileSync(join(process.cwd(), 'src/lib/legacyNativeSyncAdapter.ts'), 'utf8');
  assert.match(adapterSource, /runLegacyNativeCatchup/);
  assert.match(adapterSource, /LEGACY_NATIVE_SYNC_ENABLED/);
  assert.match(adapterSource, /runNativeSeasonCatchup/);
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```powershell
cd app
node --test src/app/legacySyncCleanup.source.test.ts
```

Expected: FAIL because the provider still exposes `fetchUpdatesNow`, routes still reference native summary plumbing, and `legacyNativeSyncAdapter.ts` does not exist.

- [ ] **Step 3: Add rule-regression coverage for stale terminology**

Add this assertion to `app/scripts/rule-regression-tests.cjs` near the existing online-first rules:

```js
assertNoMatch(
  'server-authoritative docs and app source must not restore Fetch Updates terminology',
  [
    readText('src/app/components/SeasonSyncProvider.tsx'),
    readText('src/app/components/FetchServerUpdatesButton.tsx'),
    readText('src/app/syncFetchBoundary.source.test.ts'),
  ].join('\n'),
  /Fetch Updates|Refresh required/
);
```

If the helper names differ in the current script, use the existing local helper that checks a source string does not match a regular expression. The assertion must scan app source, not only docs.

- [ ] **Step 4: Run rule tests and confirm red if stale text still exists**

Run:

```powershell
cd app
npm run test:rules
```

Expected before cleanup: FAIL if any normal source still contains the old `Fetch Updates` or `Refresh required` copy.

---

## Task 2: Isolate Legacy Native Catch-Up Behind A Repair Adapter

**Files:**
- Create: `app/src/lib/legacyNativeSyncAdapter.ts`
- Modify: `app/src/lib/nativeSeasonCatchup.ts` only if exports need type cleanup
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`

- [ ] **Step 1: Create the adapter**

Create `app/src/lib/legacyNativeSyncAdapter.ts`:

```ts
import {
  runNativeSeasonCatchup,
  queryNativeSyncSummary,
  resolveNativeSeasonConflict,
  type NativeSeasonCatchupResult,
  type RunNativeSeasonCatchupInput,
  type NativeSyncSummaryResult,
  type NativeSeasonConflictResolution,
  type NativeSeasonConflictResolveResult,
} from './nativeSeasonRepository';

export const LEGACY_NATIVE_SYNC_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_LEGACY_NATIVE_SYNC_REPAIR === 'true';

export function assertLegacyNativeSyncEnabled(): void {
  if (!LEGACY_NATIVE_SYNC_ENABLED) {
    throw new Error('Legacy native sync repair is disabled in online-first mode.');
  }
}

export async function runLegacyNativeCatchup(
  input: RunNativeSeasonCatchupInput
): Promise<NativeSeasonCatchupResult | null> {
  assertLegacyNativeSyncEnabled();
  return runNativeSeasonCatchup(input);
}

export async function queryLegacyNativeSyncSummary(
  seasonId: string
): Promise<NativeSyncSummaryResult | null> {
  assertLegacyNativeSyncEnabled();
  return queryNativeSyncSummary(seasonId);
}

export async function resolveLegacyNativeSeasonConflict(input: {
  seasonId: string;
  conflictId: string;
  resolution: NativeSeasonConflictResolution;
}): Promise<NativeSeasonConflictResolveResult | null> {
  assertLegacyNativeSyncEnabled();
  return resolveNativeSeasonConflict(input);
}
```

- [ ] **Step 2: Wire repair UI through the adapter**

In `app/src/app/settings/components/SeasonRepairTab.tsx`, replace direct imports from `nativeSeasonRepository` for catch-up/conflict summary with adapter imports:

```ts
import {
  LEGACY_NATIVE_SYNC_ENABLED,
  queryLegacyNativeSyncSummary,
  runLegacyNativeCatchup,
} from '@/lib/legacyNativeSyncAdapter';
```

When the repair toggle is disabled, show the existing repair section as unavailable:

```tsx
if (!LEGACY_NATIVE_SYNC_ENABLED) {
  return (
    <section className="space-y-3">
      <h2 className="text-title-medium text-on-surface">Legacy native sync repair</h2>
      <p className="text-body-medium text-on-surface-variant">
        Legacy native sync repair is disabled in online-first mode.
      </p>
    </section>
  );
}
```

Use the existing section/container classes already present in `SeasonRepairTab.tsx`; do not introduce a new visual style.

- [ ] **Step 3: Run adapter source test**

Run:

```powershell
cd app
node --test src/app/legacySyncCleanup.source.test.ts
```

Expected: Still FAIL until provider/routes are cleaned, but the adapter isolation assertion should pass.

---

## Task 3: Remove Native Catch-Up From SeasonSyncProvider Normal Path

**Files:**
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`

- [ ] **Step 1: Add provider-specific tests**

Append to `app/src/app/components/SeasonSyncProvider.source.test.ts`:

```ts
test('server-authoritative provider does not run native catch-up on activation or manual fetch', () => {
  assert.doesNotMatch(source, /fetchUpdatesNow/);
  assert.doesNotMatch(source, /runManualFetchSeason/);
  assert.doesNotMatch(source, /runCatchUpSeason/);
  assert.doesNotMatch(source, /runNativeSeasonCatchup/);
});

test('server-authoritative provider avoids native summary polling on workspace-change events', () => {
  assert.doesNotMatch(source, /queryNativeSyncSummary\(seasonId\)[\s\S]*pendingWorkspaceChangeSeasonIds/);
});
```

- [ ] **Step 2: Remove catch-up imports and constants**

In `SeasonSyncProvider.tsx`, remove these imports/constants from the normal provider:

```ts
import {
  checkNativeSeasonIntegrity,
  queryNativeSyncSummary,
  runNativeSeasonCatchup,
  syncNativePendingChanges,
  type NativeSyncSummaryResult,
} from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';

const CATCH_UP_EVENT_PAGE_SIZE = 200;
const MANUAL_FETCH_REPLAY_EVENT_WINDOW = 1_000;
```

Keep `syncNativePendingChanges` only if `syncNow()` still depends on the legacy pending outbox for a transition release. If kept, import it through a small pending-submit adapter in Task 4.

- [ ] **Step 3: Shrink the context interface**

Change:

```ts
type SeasonSyncContextValue = {
  registerGuard: (seasonId: string, source: string, options: SeasonSyncGuardOptions) => () => void;
  ensureLiveSeason: (seasonId: string) => void;
  syncNow: (seasonId: string, source: string) => Promise<SyncResult>;
  fetchUpdatesNow: (seasonId: string, source: string) => Promise<SyncResult>;
  seedSeasonSyncFromNative: (seasonId: string) => Promise<void>;
};
```

to:

```ts
type SeasonSyncContextValue = {
  registerGuard: (seasonId: string, source: string, options: SeasonSyncGuardOptions) => () => void;
  ensureLiveSeason: (seasonId: string) => void;
  syncNow: (seasonId: string, source: string) => Promise<SyncResult>;
};
```

- [ ] **Step 4: Replace `ensureLiveSeason` with a light server-authoritative noop**

Remove `catchUpSeason`, `runCatchUpSeason`, and `runManualFetchSeason`.

Keep `ensureLiveSeason` as a light coordinator:

```ts
const ensureLiveSeason = useCallback((seasonId: string) => {
  if (!seasonId) return;
  patchSeasonState(seasonId, (current) => ({
    ...current,
    status: current.pendingCount && current.pendingCount > 0 ? 'dirty' : 'live',
    message: current.message,
    progress: null,
    mode: null,
    conflictCount: SERVER_AUTHORITATIVE_MODE ? 0 : current.conflictCount,
  }));
}, [patchSeasonState]);
```

If `patchSeasonState` only accepts a partial object, use:

```ts
const ensureLiveSeason = useCallback((seasonId: string) => {
  if (!seasonId) return;
  const current = seasonSyncStateStore.get(seasonId);
  patchSeasonState(seasonId, {
    status: (current.pendingCount ?? 0) > 0 ? 'dirty' : 'live',
    progress: null,
    mode: null,
    conflictCount: SERVER_AUTHORITATIVE_MODE ? 0 : current.conflictCount,
  });
}, [patchSeasonState]);
```

- [ ] **Step 5: Remove exported fetch/seed actions**

Change `useSeasonSync()` return value:

```ts
return {
  status,
  syncNow,
};
```

Change `useSeasonSyncActions()` return value:

```ts
return useMemo(() => ({
  syncNow: async (seasonId: string, source: string) => (
    context?.syncNow(seasonId, source) ??
    { status: 'failed' as const, message: 'Sync coordinator is not ready.' }
  ),
}), [context]);
```

- [ ] **Step 6: Replace workspace-change native summary polling**

In the workspace-change listener effect, remove the debounced `queryNativeSyncSummary(seasonId)` call.

Patch from event `syncMeta` when available:

```ts
const syncMeta = event.syncMeta;
if (syncMeta) {
  const pendingCount = syncMeta.pendingCount ?? 0;
  patchSeasonState(seasonId, {
    status: pendingCount > 0 ? 'dirty' : 'live',
    pendingCount,
    lastLocalChangeAt: syncMeta.lastLocalChangeAt ?? null,
    localRevision: syncMeta.localRevision ?? event.localRevision ?? null,
    message: null,
    progress: null,
    mode: null,
    conflictCount: 0,
  });
  setSessionPendingSeason(seasonId, pendingCount, 0);
  return;
}
```

If no `syncMeta` exists, do not query native summary in server-authoritative mode:

```ts
if (SERVER_AUTHORITATIVE_MODE) {
  patchSeasonState(seasonId, {
    status: 'live',
    progress: null,
    mode: null,
    conflictCount: 0,
  });
  return;
}
```

- [ ] **Step 7: Run provider tests**

Run:

```powershell
cd app
node --test src/app/components/SeasonSyncProvider.source.test.ts src/app/legacySyncCleanup.source.test.ts
```

Expected: provider assertions pass; route assertions may still fail until Task 5.

---

## Task 4: Simplify Pending-Submit State

**Files:**
- Modify: `app/src/lib/seasonAutoSync.ts`
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Optional create: `app/src/lib/pendingSubmitSync.ts`

- [ ] **Step 1: Add state-shape source test**

Append to `app/src/app/legacySyncCleanup.source.test.ts`:

```ts
test('normal auto-sync state no longer models catch-up or user conflict review', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/seasonAutoSync.ts'), 'utf8');
  assert.doesNotMatch(source, /'catching_up'/);
  assert.doesNotMatch(source, /'needs_review'/);
  assert.doesNotMatch(source, /'conflict'/);
  assert.doesNotMatch(source, /conflictDuringRun/);
});
```

- [ ] **Step 2: Reduce `SeasonAutoSyncStatus`**

Change `SeasonAutoSyncStatus` to:

```ts
export type SeasonAutoSyncStatus =
  | 'synced'
  | 'dirty'
  | 'scheduled'
  | 'syncing'
  | 'live'
  | 'offline'
  | 'failed';
```

Remove `conflictCount` from `SeasonAutoSyncState` unless a transition compile error proves another normal UI still needs it. If one route still reads `conflictCount`, replace that read with `0` in server-authoritative mode.

- [ ] **Step 3: Remove conflict carry logic from scheduler**

In `SeasonAutoSyncRecord`, remove:

```ts
conflictDuringRun: number;
```

Remove all branches that set `needs_review`, `conflict`, or preserve `conflictCount` after a run. In online-first mode, `syncNow()` outcomes should be:

```ts
if (result.status === 'synced') {
  this.updateState(seasonId, {
    status: 'live',
    pendingCount: 0,
    lastLocalChangeAt: null,
    message: result.message ?? null,
    progress: null,
    mode: null,
    retryAttempt: 0,
  });
  return result;
}

if (result.status === 'busy') {
  this.updateState(seasonId, {
    status: 'syncing',
    message: result.message,
    progress: result.message,
    mode,
  });
  return result;
}

this.handleFailure(seasonId, result.message);
return result;
```

- [ ] **Step 4: Keep submit pending backend unchanged for this phase**

Do not rewrite mutation submission in this task. If `SeasonSyncProvider.syncNow()` still uses `syncNativePendingChanges`, keep it as transitional submit-pending behavior. The only goal here is to stop normal UI/state from modeling conflict review and catch-up.

- [ ] **Step 5: Run scheduler/provider tests**

Run:

```powershell
cd app
node --test src/app/legacySyncCleanup.source.test.ts src/app/components/SeasonSyncProvider.source.test.ts
```

Expected: PASS for state-shape and provider assertions after route cleanup is complete.

---

## Task 5: Remove Native Summary And Conflict Review From Primary Routes

**Files:**
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`

- [ ] **Step 1: Add route cleanup assertions**

Append to `app/src/app/onlineFirstRoutes.source.test.ts`:

```ts
test('primary routes do not use native sync summary or conflict review in online-first mode', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /queryNativeSyncSummary/, file);
    assert.doesNotMatch(source, /seedSeasonSyncFromNative/, file);
    assert.doesNotMatch(source, /SeasonConflictReviewControl/, file);
    assert.doesNotMatch(source, /conflictCount:\s*getLocalSyncConflictCount/, file);
  }
});
```

- [ ] **Step 2: Remove conflict review control imports/rendering**

For each primary route, remove:

```tsx
import SeasonConflictReviewControl from './components/SeasonConflictReviewControl';
```

or:

```tsx
import SeasonConflictReviewControl from '../components/SeasonConflictReviewControl';
```

Remove render calls like:

```tsx
<SeasonConflictReviewControl seasonId={activeSeason?.id} />
```

- [ ] **Step 3: Remove route-local native summary state**

Remove route state that exists only for native sync badge fallback:

```tsx
const [syncSummary, setSyncSummary] = useState(...);
```

Remove effects or callbacks that call:

```ts
queryNativeSyncSummary(...)
seedSeasonSyncFromNative(...)
getLocalSyncConflictCount(...)
```

Set route pending count from provider status only:

```ts
const syncPendingCount = syncStatus.pendingCount ?? 0;
```

Set route conflict/review count to zero in normal mode:

```ts
const syncReviewCount = 0;
```

If a page uses `syncReviewCount` only for button disabled/warning copy, remove that branch.

- [ ] **Step 4: Preserve route-local commit guards**

Do not remove route commit accumulators such as:

```ts
currentMutationRef
commitQueueRef
checkInCommitAccumulatorRef
gateCommitAccumulatorRef
```

These protect in-flight online mutations and are still needed to prevent stale fetch responses from overwriting edits.

- [ ] **Step 5: Run route tests**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts src/app/legacySyncCleanup.source.test.ts
```

Expected: primary route assertions pass.

---

## Task 6: Rename Workspace Refresh Away From Native Semantics

**Files:**
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.ts`
- Modify: `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts`
- Modify every route using `useSeasonWorkspaceRefresh`

- [ ] **Step 1: Update hook tests**

Replace native-centric assertions in `app/src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts` with:

```ts
test('season workspace refresh awaits refresh callback before handling the next event', () => {
  assert.match(source, /onRefresh\?:\s*\(event:\s*SeasonWorkspaceChangeEvent\)\s*=>\s*Promise<void>\s*\|\s*void/);
  assert.match(source, /async function refreshFromWorkspaceEvent/);
  assert.match(source, /await onRefreshRef\.current\?\.\(event\)/);
});

test('season workspace refresh ignores server window hydration events', () => {
  assert.match(source, /if \(event\.source === 'server-window'\) return;/);
});

test('season workspace refresh does not expose native callback naming', () => {
  assert.doesNotMatch(source, /onNativeRefresh/);
  assert.doesNotMatch(source, /refreshFromNativeEvent/);
});
```

- [ ] **Step 2: Rename hook option**

In `useSeasonWorkspaceRefresh.ts`, change:

```ts
onNativeRefresh?: (event: SeasonWorkspaceChangeEvent) => Promise<void> | void;
```

to:

```ts
onRefresh?: (event: SeasonWorkspaceChangeEvent) => Promise<void> | void;
```

Rename refs/functions:

```ts
const onRefreshRef = useRef(onRefresh);
async function refreshFromWorkspaceEvent(event: SeasonWorkspaceChangeEvent) {
  await onRefreshRef.current?.(event);
}
```

- [ ] **Step 3: Update route call sites**

Replace:

```tsx
useSeasonWorkspaceRefresh({
  seasonId,
  policy,
  source,
  onNativeRefresh: refreshWindow,
});
```

with:

```tsx
useSeasonWorkspaceRefresh({
  seasonId,
  policy,
  source,
  onRefresh: refreshWindow,
});
```

- [ ] **Step 4: Run hook and route tests**

Run:

```powershell
cd app
node --test src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/app/onlineFirstRoutes.source.test.ts src/app/legacySyncCleanup.source.test.ts
```

Expected: PASS.

---

## Task 7: Move Conflict Review To Repair-Only UI

**Files:**
- Modify: `app/src/app/components/SeasonConflictReviewControl.tsx`
- Modify: `app/src/app/settings/components/SeasonRepairTab.tsx`
- Modify: `app/src/app/legacySyncCleanup.source.test.ts`

- [ ] **Step 1: Add repair-only assertion**

Append to `app/src/app/legacySyncCleanup.source.test.ts`:

```ts
test('conflict review control is repair-only and not part of primary route UI', () => {
  const repairSource = readFileSync(join(process.cwd(), 'src/app/settings/components/SeasonRepairTab.tsx'), 'utf8');
  assert.match(repairSource, /SeasonConflictReviewControl/);
  for (const file of primaryRouteFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /SeasonConflictReviewControl/, file);
  }
});
```

- [ ] **Step 2: Render the component only inside SeasonRepairTab**

Import inside `SeasonRepairTab.tsx`:

```tsx
import SeasonConflictReviewControl from '@/app/components/SeasonConflictReviewControl';
```

Render under the legacy repair section only when legacy repair is enabled and a season is selected:

```tsx
{LEGACY_NATIVE_SYNC_ENABLED && selectedSeasonId ? (
  <SeasonConflictReviewControl seasonId={selectedSeasonId} />
) : null}
```

Use the current selected-season variable name in `SeasonRepairTab.tsx`; do not introduce a second season selector.

- [ ] **Step 3: Keep the component guarded**

Inside `SeasonConflictReviewControl.tsx`, keep the server-authoritative guard, but make it depend on repair enablement instead of normal app mode:

```tsx
if (!LEGACY_NATIVE_SYNC_ENABLED) return null;
```

Import:

```ts
import { LEGACY_NATIVE_SYNC_ENABLED } from '@/lib/legacyNativeSyncAdapter';
```

- [ ] **Step 4: Run repair/route source tests**

Run:

```powershell
cd app
node --test src/app/legacySyncCleanup.source.test.ts src/app/onlineFirstRoutes.source.test.ts
```

Expected: PASS.

---

## Task 8: Documentation Cleanup And Backend Handoff

**Files:**
- Modify: `context.md`
- Modify: `architecture.md`
- Create: `docs/handoffs/20260623_legacy_sync_deprecation.md`

- [ ] **Step 1: Replace stale offline-first invariants in `context.md`**

Replace sections that describe normal operation as local-first/native-sync/conflict-review with this current-state note:

```md
- Online-first cleanup status, 2026-06-23: self-hosted Supabase is the single durable source for normal operations. `Sync`/`Save pending` submits pending client mutations only; `Fetch data` reloads the active route window from the server. Native SQLite is retained as a cache/read model/reporting accelerator and repair substrate, but normal route activation, tab switch, and fetch paths must not run native catch-up, conflict review, or SQLite/server entity-version comparison.
```

- [ ] **Step 2: Update `architecture.md` boundaries**

Add or update:

```md
### Online-first sync boundary

- Server-window reads are the freshness source for primary routes.
- Server mutation receipts provide idempotency for writes.
- Native SQLite is a local read model/cache and must not decide whether server data is fresh.
- Legacy native catch-up and conflict review are repair-only mechanisms behind `NEXT_PUBLIC_ENABLE_LEGACY_NATIVE_SYNC_REPAIR=true`.
```

- [ ] **Step 3: Create backend handoff**

Create `docs/handoffs/20260623_legacy_sync_deprecation.md`:

```md
# Legacy Sync Deprecation Handoff

Frontend target:

- Normal app routes no longer call `sync_season_workspace_v2` for catch-up/event replay.
- Normal app routes no longer expose conflict review or native entity-version comparison.
- `apply_season_server_mutation_v1` remains the write RPC for online-first mutations.
- `get_season_schedule_allocation_window_v1` remains the read RPC for route windows.

Backend action requested after frontend release is verified:

1. Confirm from Supabase logs that no current frontend build calls `sync_season_workspace_v2` for normal route operation.
2. Keep `season_change_events` because it is still useful for audit, realtime invalidation, and diagnostics.
3. Keep `season_mutation_receipts` because it is required for idempotent online-first writes.
4. Mark `sync_season_workspace_v2` and conflict-review RPCs as deprecated.
5. Do not revoke or drop old RPCs until one production release cycle has passed without calls from active clients.

No immediate schema change is required for the frontend cleanup.
```

- [ ] **Step 4: Scan docs for mojibake and stale terms**

Run:

```powershell
rg -n "Fetch Updates|Refresh required|needs_review|catching_up|offline-first|local-first" context.md architecture.md docs/handoffs/20260623_legacy_sync_deprecation.md
```

Expected: stale terms may remain only in explicitly labeled legacy/deprecated sections. Also scan changed Vietnamese/non-ASCII files for mojibake markers before finalizing.

---

## Task 9: Full Verification

**Files:**
- All files modified above

- [ ] **Step 1: Run targeted source tests**

Run:

```powershell
cd app
node --test src/app/legacySyncCleanup.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts src/app/components/SeasonSyncProvider.source.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/lib/onlineFirstMode.source.test.ts src/lib/seasonWorkspaceReadModel.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run rule regression**

Run:

```powershell
cd app
npm run test:rules
```

Expected: `rule regression tests passed`.

- [ ] **Step 3: Run TypeScript**

Run:

```powershell
cd app
npx tsc --noEmit --pretty false
```

Expected: exit code `0`.

- [ ] **Step 4: Run production build**

Run:

```powershell
cd app
npm run build
```

Expected: build completes successfully.

- [ ] **Step 5: Manual smoke in the app**

Run the app using the current dev command:

```powershell
cd app
npm run dev
```

Manual checks:

- Open S26.
- Daily, Detailed, Check-in, Gate, Dashboard tabs should not reload from blank on tab switch when data is already cached.
- `Fetch data` should reload from server and should not submit pending work.
- `Save pending` should be disabled or show `No pending` when there are no pending mutations.
- Gate allocation edited to `null` should stay `null` after `Fetch data`.
- S26 server-window load should request capacity `100000`, not a 10k slice.

---

## Execution Order

1. Task 1: Source tests first.
2. Task 2: Create repair adapter.
3. Task 3: Remove provider catch-up surface.
4. Task 4: Simplify pending-submit state.
5. Task 5: Remove native summary/conflict review from primary routes.
6. Task 6: Rename workspace refresh hook.
7. Task 7: Move conflict review to repair-only.
8. Task 8: Docs and backend handoff.
9. Task 9: Verification.

## Self-Review

- Spec coverage: The plan removes normal-path native catch-up, conflict review, version comparison, stale sync badge states, and route-native summary polling while keeping server-window reads and server mutation RPCs.
- Placeholder scan: No placeholders or unspecified error-handling steps remain.
- Type consistency: `Fetch data` remains route-level; `Sync` remains pending-submit; `legacyNativeSyncAdapter` is repair-only; primary route files must not import direct native sync summary/catch-up APIs.
- Risk control: The plan does not delete Rust/native catch-up code immediately. It first removes normal-path references and keeps backend RPC deprecation as a handoff after frontend verification.

## Execution Recommendation

Use Subagent-Driven execution. The work splits cleanly into independent checkpoints:

1. Tests and adapter isolation.
2. Provider cleanup.
3. Route cleanup.
4. Hook rename and conflict repair relocation.
5. Docs, backend handoff, and verification.
