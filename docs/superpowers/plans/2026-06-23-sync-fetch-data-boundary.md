# Sync And Fetch Data Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate `Sync` as pending-submit from `Fetch data` as read-only server refresh, and remove remaining online-first state/cache behavior that can make pages reload from stale native SQLite.

**Architecture:** Supabase self-hosted remains the durable server authority. `SyncActionButton` keeps the submit-pending meaning and calls the existing `syncNow()` path only when local pending ops exist. New `FetchDataButton` is read-only and forces the active route to reload its server workspace window, bypassing the in-memory window cache without calling native pending sync.

**Tech Stack:** Next.js App Router, React, Zustand workspace store, Tauri native SQLite cache, Supabase RPC `get_season_schedule_allocation_window_v1`, Node source-regression tests, TypeScript.

**Execution status 2026-06-23:** Implemented in the frontend. The app reuses `FetchServerUpdatesButton` as the read-only `Fetch data` control instead of creating a separate `FetchDataButton`. Primary routes expose route-level `fetchServerData` actions, `SyncActionButton` remains pending-submit only, server-authoritative route loads no longer silently fall back to native SQLite on server-read failure, and badge copy now separates `Fetch data required` from `pending submit`.

---

## Current Boundary

- `SyncActionButton` currently labels the action `Save` and calls route `syncNow()` handlers.
- `syncNow()` is still the legacy submit-pending path through `SeasonAutoSyncScheduler` and `syncNativePendingChanges`.
- `fetchUpdatesNow()` currently runs native catch-up, not a route-level server-window fetch.
- Route pages already load `loadSeasonWorkspaceWindow(...)` before native fallback.
- Daily/Gate/Check-in still silently fallback to native SQLite with `limit: 10000` if server read fails.
- `server-window` hydration events are already ignored by `useSeasonWorkspaceRefresh`.

## File Structure

- Create: `app/src/app/components/FetchDataButton.tsx`
  - Small read-only action button for route-level server fetch.
- Modify: `app/src/app/components/SyncActionButton.tsx`
  - Keep submit-pending semantics explicit in label/title/disabled behavior.
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
  - Keep `syncNow()` as submit-pending only.
  - Stop using conflict-style `Refresh required` copy in server-authoritative mode.
- Modify route pages:
  - `app/src/app/SeasonalSchedulePage.tsx`
  - `app/src/app/detailed/page.tsx`
  - `app/src/app/daily/page.tsx`
  - `app/src/app/checkin/page.tsx`
  - `app/src/app/gate/page.tsx`
  - `app/src/app/dashboard/page.tsx`
- Test:
  - Create: `app/src/app/syncFetchBoundary.source.test.ts`
  - Modify: `app/src/app/onlineFirstRoutes.source.test.ts`
  - Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`
- Docs:
  - Modify: `context.md`
  - Modify: `architecture.md`

---

## Task 1: Lock Button Semantics With Source Tests

**Files:**
- Create: `app/src/app/syncFetchBoundary.source.test.ts`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`

- [ ] **Step 1: Write the failing source-regression test**

Create `app/src/app/syncFetchBoundary.source.test.ts`:

```ts
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

test('SyncActionButton remains submit-pending and never becomes Fetch data', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/components/SyncActionButton.tsx'), 'utf8');
  assert.match(source, /pendingCount/);
  assert.match(source, /Save pending/);
  assert.match(source, /Submit pending changes to server/);
  assert.doesNotMatch(source, /Fetch data/);
  assert.doesNotMatch(source, /fetchUpdatesNow/);
});

test('FetchDataButton is read-only server refresh UI', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/components/FetchDataButton.tsx'), 'utf8');
  assert.match(source, /Fetch data/);
  assert.match(source, /onFetch/);
  assert.doesNotMatch(source, /onSync/);
  assert.doesNotMatch(source, /syncNow/);
});

test('primary route pages expose Fetch data separately from Sync submit', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /FetchDataButton/, file);
    assert.match(source, /onFetch=\{[^}]*fetchServerData/, file);
    assert.match(source, /<SyncActionButton/, file);
    assert.match(source, /pendingCount=\{syncPendingCount\}/, file);
  }
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```powershell
cd app
node --test src/app/syncFetchBoundary.source.test.ts
```

Expected: FAIL because `FetchDataButton.tsx` does not exist and route pages do not expose separate `Fetch data`.

- [ ] **Step 3: Extend the existing route source test for server refresh**

Append to `app/src/app/onlineFirstRoutes.source.test.ts`:

```ts
test('Fetch data actions force server workspace reload and bypass native submit sync', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /fetchServerData/, file);
    assert.match(source, /loadSeasonWorkspaceWindow/, file);
    const fetchStart = source.indexOf('fetchServerData');
    assert(fetchStart >= 0, file);
    const fetchSource = source.slice(fetchStart, Math.min(source.length, fetchStart + 2500));
    assert.match(fetchSource, /loadSeasonWorkspaceWindow/, file);
    assert.doesNotMatch(fetchSource, /syncNow\(/, file);
    assert.doesNotMatch(fetchSource, /syncNativePendingChanges/, file);
  }
});
```

- [ ] **Step 4: Run the route test and confirm red**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: FAIL because route pages do not yet have `fetchServerData`.

---

## Task 2: Add FetchDataButton And Preserve SyncActionButton Meaning

**Files:**
- Create: `app/src/app/components/FetchDataButton.tsx`
- Modify: `app/src/app/components/SyncActionButton.tsx`

- [ ] **Step 1: Create the read-only Fetch data button**

Create `app/src/app/components/FetchDataButton.tsx`:

```tsx
'use client';

import { useCallback, useRef, useState } from 'react';

interface FetchDataButtonProps {
  fetching: boolean;
  onFetch: () => Promise<void> | void;
  className?: string;
}

export default function FetchDataButton({
  fetching,
  onFetch,
  className = '',
}: FetchDataButtonProps) {
  const [clickLocked, setClickLocked] = useState(false);
  const clickLockedRef = useRef(false);
  const busy = fetching || clickLocked;

  const handleClick = useCallback(async () => {
    if (busy || clickLockedRef.current) return;
    clickLockedRef.current = true;
    setClickLocked(true);
    try {
      await onFetch();
    } finally {
      clickLockedRef.current = false;
      setClickLocked(false);
    }
  }, [busy, onFetch]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      aria-busy={busy ? 'true' : 'false'}
      aria-live="polite"
      title={busy ? 'Fetching server data' : 'Fetch latest data from server'}
      className={`flex min-w-[116px] items-center justify-center gap-2 rounded-lg border border-outline bg-surface px-3 py-2 font-label-caps text-label-caps text-on-surface transition-colors hover:bg-surface-container disabled:cursor-wait disabled:opacity-70 ${className}`}
    >
      <span className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}>cloud_sync</span>
      <span>{busy ? 'Fetching...' : 'Fetch data'}</span>
    </button>
  );
}
```

- [ ] **Step 2: Make SyncActionButton explicitly submit-pending**

Modify `app/src/app/components/SyncActionButton.tsx` so the label and disabled behavior are explicit:

```tsx
  const hasPending = pendingCount > 0;
  const busy = syncing || clickLocked;
  const label = busy ? 'Submitting...' : hasPending ? 'Save pending' : 'No pending';
```

Update the `<button>` props:

```tsx
      disabled={busy || !hasPending}
      title={
        busy
          ? progress ?? 'Submitting pending changes'
          : hasPending
            ? progress ?? 'Submit pending changes to server'
            : 'No pending changes to submit'
      }
```

Keep the existing `onSync` prop unchanged. Do not add `onFetch` or call `fetchUpdatesNow` from this component.

- [ ] **Step 3: Run the button tests**

Run:

```powershell
cd app
node --test src/app/syncFetchBoundary.source.test.ts
```

Expected: the first two tests pass; route page test still fails until Task 3.

---

## Task 3: Wire Fetch Data To Server-Window Reload On Each Route

**Files:**
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`

- [ ] **Step 1: Import FetchDataButton on each route**

Add the import next to `SyncActionButton` imports:

```tsx
import FetchDataButton from './components/FetchDataButton';
```

For nested route folders, use:

```tsx
import FetchDataButton from '../components/FetchDataButton';
```

- [ ] **Step 2: Add a route-level fetch state**

On each route page, add:

```tsx
const [fetchingServerData, setFetchingServerData] = useState(false);
```

- [ ] **Step 3: Add fetchServerData wrapper around the existing server loader**

For pages with an existing load function that accepts `force`, add:

```tsx
const fetchServerData = useCallback(async () => {
  if (!season?.id && !activeSeason?.id) return;
  setFetchingServerData(true);
  try {
    await loadSeasonData(true);
  } finally {
    setFetchingServerData(false);
  }
}, [loadSeasonData, season?.id, activeSeason?.id]);
```

For pages whose loader is currently embedded inside `useEffect`, first extract the server-window path into a local callback named `loadSeasonData(force = false)` or `loadDashboardData(force = false)`. The callback must keep this order:

```tsx
const cachedWindow = force
  ? null
  : readCachedWorkspaceWindow(useSeasonWorkspaceStore.getState().workspaces[targetSeason.id], windowKey);

if (cachedWindow?.syncMeta) {
  // apply cached state and return
}

const serverWindow = await loadSeasonWorkspaceWindow({
  seasonId: targetSeason.id,
  dateFrom,
  dateTo,
  resourceType,
  limit: 100000,
});
```

- [ ] **Step 4: Render Fetch data separately from SyncActionButton**

Place `FetchDataButton` beside `SyncActionButton` on each page toolbar:

```tsx
<FetchDataButton
  fetching={fetchingServerData}
  onFetch={fetchServerData}
/>
<SyncActionButton
  syncing={syncStatus.status === 'syncing'}
  pendingCount={syncPendingCount}
  progress={syncStatus.progress}
  onSync={syncNow}
/>
```

Do not replace `SyncActionButton` with `FetchDataButton`. Do not call `syncNow` from `FetchDataButton`.

- [ ] **Step 5: Run route source tests**

Run:

```powershell
cd app
node --test src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts
```

Expected: PASS for route button semantics and server-window ordering.

---

## Task 4: Stop Silent Native SQLite Fallback In Online-First Mode

**Files:**
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`

- [ ] **Step 1: Write the failing source test**

Append to `app/src/app/onlineFirstRoutes.source.test.ts`:

```ts
test('online-first route pages do not silently fallback to native SQLite after server read failure', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const serverCatch = source.match(/loadSeasonWorkspaceWindow[\s\S]*?\.catch\(\(error\) => \{[\s\S]*?\}\);/);
    assert(serverCatch, file);
    assert.doesNotMatch(serverCatch[0], /falling back to native SQLite/i, file);
    assert.match(serverCatch[0], /throw error|return null/, file);
  }
});
```

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: FAIL because current route pages log `falling back to native SQLite`.

- [ ] **Step 3: Replace silent fallback copy and control flow**

On each route, change server read failure handling from:

```tsx
}).catch((error) => {
  console.warn('Server ... unavailable, falling back to native SQLite', error);
  return null;
});
```

to:

```tsx
}).catch((error) => {
  console.error('Server workspace fetch failed', error);
  throw error;
});
```

The catch block around the full loader should surface the existing page error state. Keep native fallback only for explicit non-server modes if such a mode is added later; do not silently use native SQLite in server-authoritative mode.

- [ ] **Step 4: Remove 10k native fallback from primary server-first paths**

After Step 3, remove the unreachable native fallback branch from route load functions or keep it behind an explicit helper:

```tsx
if (!SERVER_AUTHORITATIVE_MODE) {
  const result = await queryNativeScheduleWindow({ ... });
  // legacy fallback
}
```

If using the helper, import:

```tsx
import { SERVER_AUTHORITATIVE_MODE } from '@/lib/serverAuthoritativeMode';
```

- [ ] **Step 5: Run route tests**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: PASS.

---

## Task 5: Clean Server-Authoritative Badge Copy

**Files:**
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`

- [ ] **Step 1: Write the failing source test**

Append to `app/src/app/components/SeasonSyncProvider.source.test.ts`:

```ts
test('server-authoritative status copy separates pending submit from Fetch data', () => {
  assert.doesNotMatch(source, /return 'Refresh required'/);
  assert.match(source, /Fetch data required|Fetch data/);
  assert.match(source, /pendingCount > 0\) return `\$\{pendingCount\} pending submit`/);
});
```

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
cd app
node --test src/app/components/SeasonSyncProvider.source.test.ts
```

Expected: FAIL because the provider still returns `Refresh required`.

- [ ] **Step 3: Update label function**

Change `getSeasonSyncLabel(...)` in `app/src/app/components/SeasonSyncProvider.tsx`:

```ts
  if (SERVER_AUTHORITATIVE_MODE && (status.status === 'needs_review' || status.status === 'conflict' || conflictCount > 0)) {
    return 'Fetch data required';
  }
```

Change pending copy:

```ts
  if (pendingCount > 0) return `${pendingCount} pending submit`;
```

Do not change `syncNow()` behavior in this task.

- [ ] **Step 4: Run provider tests**

Run:

```powershell
cd app
node --test src/app/components/SeasonSyncProvider.source.test.ts
```

Expected: PASS.

---

## Task 6: Documentation And Verification

**Files:**
- Modify: `context.md`
- Modify: `architecture.md`

- [ ] **Step 1: Update architecture notes**

Add a short note to `architecture.md` under the online-first/server-authoritative section:

```md
### Sync vs Fetch data

- `Sync` / `Save pending` means submit local pending operations to the server. It is retained for legacy rollback and any real pending local ops.
- `Fetch data` means read the latest server workspace window. It does not submit pending operations and must not call native pending sync.
- In server-authoritative mode, normal route refresh uses Supabase server-window RPCs first. Native SQLite is a cache/reporting accelerator, not the source of truth.
```

- [ ] **Step 2: Update context**

Add a current-state note to `context.md`:

```md
- Online-first UI boundary: `Sync`/`Save pending` submits local pending operations only when pending ops exist. `Fetch data` is the read-only server refresh action for reloading the active route window from self-hosted Supabase.
```

- [ ] **Step 3: Run targeted tests**

Run:

```powershell
cd app
node --test src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts src/app/components/SeasonSyncProvider.source.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts src/lib/seasonWorkspaceReadModel.test.ts src/lib/onlineFirstMode.source.test.ts
```

Expected: all tests pass with `fail 0`.

- [ ] **Step 4: Run rule tests**

Run:

```powershell
cd app
npm run test:rules
```

Expected: `rule regression tests passed`.

- [ ] **Step 5: Run typecheck**

Run:

```powershell
cd app
npx tsc --noEmit --pretty false
```

Expected: exit code `0`, no TypeScript errors.

- [ ] **Step 6: Run production build**

Run:

```powershell
cd app
npm run build
```

Expected: Next.js build compiles successfully and generates all static pages.

---

## Self-Review

- Spec coverage: The plan preserves `Sync` as pending-submit, adds `Fetch data` as read-only server refresh, cleans badge copy, and prevents silent stale native fallback.
- Placeholder scan: No `TBD`, no `TODO`, no undefined feature names.
- Type consistency: `FetchDataButton` uses `onFetch`; `SyncActionButton` keeps `onSync`; route tests expect `fetchServerData`; provider tests expect `pending submit` and `Fetch data`.

## Execution Recommendation

Use Subagent-Driven execution. The work splits cleanly:

1. Tests and button components.
2. Route page wiring.
3. Native fallback and badge cleanup.
4. Docs and verification.
