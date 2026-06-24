# Online-First Server-Authoritative Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert SeasonalManagement from native/offline-first sync to online-first, server-authoritative writes on the self-hosted Supabase server, while fixing the page state/cache boundary so tab switching does not repeatedly reload full data.

**Architecture:** Supabase self-hosted becomes the only write authority. SQLite stays as a read-through desktop cache and local SQL/reporting accelerator, not as a durable offline write source. Route pages render from a shared workspace read model keyed by season/window first, then refresh from server/native cache only when stale.

**Tech Stack:** Next.js App Router, React, Zustand, Tauri v2, Rust SQLite cache, Supabase RPC/Postgres, TypeScript source-regression tests, native Rust tests.

---

## Current Boundary

- The app is already pointed at `https://supabase.ahtops.xyz`.
- Seasonal import/re-import already goes through `apply_seasonal_import_remote(jsonb)`.
- Normal operational edits still use native SQLite pending ops plus `sync_season_workspace_v2`.
- Conflict review is still valid in the current code because local pending writes can diverge from server state.
- The new target is: no durable local/offline writes, no user conflict review in the main workflow, server latest write wins.

## File Structure

- Modify: `app/src/lib/remoteStore.ts`
  - Add server-authoritative mutation contract types and exported wrapper.
- Modify: `app/src/lib/supabaseStore.ts`
  - Implement `applySeasonServerMutationV1()` RPC call and response normalization.
- Create: `app/src/lib/serverAuthoritativeMode.ts`
  - One explicit app mode switch and helper labels for online-first behavior.
- Create: `app/src/lib/seasonWorkspaceReadModel.ts`
  - Shared read-through cache selectors keyed by `{seasonId, windowKey}`.
- Modify: `app/src/lib/seasonWorkspaceStore.ts`
  - Store server cursor/high-water, stale window keys, and per-window cached records.
- Modify: `app/src/app/components/AppRouteCache.tsx`
  - Keep all primary modules mounted or move cache eviction to an explicit least-recent inactive policy that does not evict normal tab workflows.
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
  - Split legacy sync provider from online-first live refresh provider.
- Modify: `app/src/app/components/SeasonConflictReviewControl.tsx`
  - Hide conflict review in server-authoritative mode, keep legacy fallback for rollback builds.
- Modify: route pages:
  - `app/src/app/SeasonalSchedulePage.tsx`
  - `app/src/app/detailed/page.tsx`
  - `app/src/app/daily/page.tsx`
  - `app/src/app/checkin/page.tsx`
  - `app/src/app/gate/page.tsx`
  - `app/src/app/dashboard/page.tsx`
- Modify: native bridge:
  - `app/src/lib/nativeSeasonRepository.ts`
  - `app/src/lib/nativeSeasonCatchup.ts`
  - `app/src-tauri/src/native_catchup.rs`
- Test:
  - `app/src/lib/onlineFirstMode.source.test.ts`
  - `app/src/lib/seasonWorkspaceReadModel.test.ts`
  - `app/src/app/onlineFirstRoutes.source.test.ts`
  - `app/src-tauri/tests/native_catchup.rs`
- Docs:
  - `docs/handoffs/online-first-server-authoritative-writes.md`
  - `context.md`
  - `architecture.md`

---

## Task 1: Lock The Online-First Contract

**Files:**
- Create: `app/src/lib/serverAuthoritativeMode.ts`
- Test: `app/src/lib/onlineFirstMode.source.test.ts`
- Modify: `context.md`
- Modify: `architecture.md`

- [ ] **Step 1: Write the source-regression test**

Create `app/src/lib/onlineFirstMode.source.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('online-first mode is explicit and disables durable offline writes', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/serverAuthoritativeMode.ts'), 'utf8');
  assert.match(source, /SERVER_AUTHORITATIVE_MODE\s*=\s*true/);
  assert.match(source, /ALLOW_DURABLE_OFFLINE_WRITES\s*=\s*false/);
  assert.match(source, /server latest write wins/i);
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
```

Expected: FAIL because `serverAuthoritativeMode.ts` does not exist.

- [ ] **Step 3: Add the mode contract**

Create `app/src/lib/serverAuthoritativeMode.ts`:

```ts
export const SERVER_AUTHORITATIVE_MODE = true;
export const ALLOW_DURABLE_OFFLINE_WRITES = false;

export const SERVER_AUTHORITATIVE_POLICY_LABEL =
  'Online-first: server latest write wins, local storage is read cache only.';

export function shouldAllowDurableOfflineWrites(): boolean {
  return !SERVER_AUTHORITATIVE_MODE && ALLOW_DURABLE_OFFLINE_WRITES;
}

export function requireOnlineForServerWrite(isOnline: boolean): void {
  if (!isOnline) {
    throw new Error('Online connection is required. Server is the source of truth.');
  }
}
```

- [ ] **Step 4: Run the test and confirm green**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update docs**

Update `context.md` and `architecture.md` with this decision:

```md
- Online-first server-authoritative target, 2026-06-22: self-hosted Supabase is the only durable write source. SQLite remains a read-through desktop cache/reporting accelerator. Durable offline writes, pending-op conflict review, and manual merge workflow are legacy fallback paths only until removed from the main UI.
```

---

## Task 2: Add The Server-Authoritative RPC Client Contract

**Files:**
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Test: `app/src/lib/onlineFirstMode.source.test.ts`

- [ ] **Step 1: Extend the test for the RPC contract**

Append to `app/src/lib/onlineFirstMode.source.test.ts`:

```ts
test('remote store exposes server-authoritative mutation contract', () => {
  const remoteStore = readFileSync(join(process.cwd(), 'src/lib/remoteStore.ts'), 'utf8');
  const supabaseStore = readFileSync(join(process.cwd(), 'src/lib/supabaseStore.ts'), 'utf8');
  assert.match(remoteStore, /applySeasonServerMutationV1/);
  assert.match(remoteStore, /clientMutationId/);
  assert.match(supabaseStore, /apply_season_server_mutation_v1/);
  assert.match(supabaseStore, /serverHighWater/);
  assert.match(supabaseStore, /changedTargets/);
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
```

Expected: FAIL because the new contract is not present.

- [ ] **Step 3: Add types and wrapper in `remoteStore.ts`**

Add the RPC payload and result types:

```ts
export interface ServerSeasonMutationPayload {
  seasonId: string;
  clientId: string;
  clientMutationId: string;
  source: string;
  baseServerSeq?: number | null;
  operations: unknown[];
}

export interface ServerSeasonMutationResult {
  seasonId: string;
  serverHighWater: number;
  nextServerSeq: number;
  changedTargets: string[];
  affectedIds: string[];
  appliedEvents: unknown[];
  rejectedEvents: unknown[];
}
```

Extend the remote store interface:

```ts
applySeasonServerMutationV1?(payload: ServerSeasonMutationPayload): Promise<ServerSeasonMutationResult>;
```

Export the wrapper:

```ts
export async function applySeasonServerMutationV1(
  payload: ServerSeasonMutationPayload
): Promise<ServerSeasonMutationResult> {
  const store = await getRemoteStore();
  if (!store.applySeasonServerMutationV1) {
    throw new Error('Server-authoritative mutation RPC is not available.');
  }
  return store.applySeasonServerMutationV1(payload);
}
```

- [ ] **Step 4: Add Supabase RPC implementation**

In `app/src/lib/supabaseStore.ts`, add:

```ts
async applySeasonServerMutationV1(payload) {
  const { data, error } = await supabase.rpc('apply_season_server_mutation_v1', {
    p_mutation: payload,
  });
  if (error) throw error;
  return normalizeServerSeasonMutationResult(data);
}
```

Add a normalizer near other RPC normalizers:

```ts
function normalizeServerSeasonMutationResult(raw: any): ServerSeasonMutationResult {
  return {
    seasonId: raw.seasonId ?? raw.season_id,
    serverHighWater: raw.serverHighWater ?? raw.server_high_water ?? 0,
    nextServerSeq: raw.nextServerSeq ?? raw.next_server_seq ?? raw.serverHighWater ?? raw.server_high_water ?? 0,
    changedTargets: raw.changedTargets ?? raw.changed_targets ?? [],
    affectedIds: raw.affectedIds ?? raw.affected_ids ?? [],
    appliedEvents: raw.appliedEvents ?? raw.applied_events ?? [],
    rejectedEvents: raw.rejectedEvents ?? raw.rejected_events ?? [],
  };
}
```

- [ ] **Step 5: Run the contract test**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
```

Expected: PASS.

---

## Task 3: Fix The State/Cache Boundary For Tab Switching

**Files:**
- Create: `app/src/lib/seasonWorkspaceReadModel.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: `app/src/app/components/AppRouteCache.tsx`
- Test: `app/src/lib/seasonWorkspaceReadModel.test.ts`

- [ ] **Step 1: Write read-model tests**

Create `app/src/lib/seasonWorkspaceReadModel.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceWindowCacheKey,
  shouldRefreshWorkspaceWindow,
} from './seasonWorkspaceReadModel.ts';

test('workspace window cache key is stable for same logical window', () => {
  assert.equal(
    buildWorkspaceWindowCacheKey({
      route: 'daily',
      seasonId: 'season-1',
      dateFrom: '2026-06-22',
      dateTo: '2026-06-23',
      resourceType: null,
      filter: '',
    }),
    'daily|season-1|2026-06-22|2026-06-23||'
  );
});

test('fresh windows do not refresh on tab activation', () => {
  assert.equal(
    shouldRefreshWorkspaceWindow({
      cachedAt: 1000,
      now: 1500,
      stale: false,
      ttlMs: 10_000,
    }),
    false
  );
});

test('stale windows refresh even inside ttl', () => {
  assert.equal(
    shouldRefreshWorkspaceWindow({
      cachedAt: 1000,
      now: 1500,
      stale: true,
      ttlMs: 10_000,
    }),
    true
  );
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```powershell
cd app
node --test src/lib/seasonWorkspaceReadModel.test.ts
```

Expected: FAIL because the file does not exist.

- [ ] **Step 3: Implement the read-model helper**

Create `app/src/lib/seasonWorkspaceReadModel.ts`:

```ts
export interface WorkspaceWindowCacheKeyInput {
  route: string;
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  resourceType?: string | null;
  filter?: string | null;
}

export interface WorkspaceWindowRefreshInput {
  cachedAt: number | null | undefined;
  now: number;
  stale: boolean;
  ttlMs: number;
}

export function buildWorkspaceWindowCacheKey(input: WorkspaceWindowCacheKeyInput): string {
  return [
    input.route,
    input.seasonId,
    input.dateFrom ?? '',
    input.dateTo ?? '',
    input.resourceType ?? '',
    input.filter ?? '',
  ].join('|');
}

export function shouldRefreshWorkspaceWindow(input: WorkspaceWindowRefreshInput): boolean {
  if (input.stale) return true;
  if (!input.cachedAt) return true;
  return input.now - input.cachedAt > input.ttlMs;
}
```

- [ ] **Step 4: Preserve route cache for normal tab workflows**

In `app/src/app/components/AppRouteCache.tsx`, change:

```ts
const MAX_CACHED_ROUTE_ENTRIES = 5;
```

to:

```ts
const MAX_CACHED_ROUTE_ENTRIES = CACHEABLE_MODULE_PATHS.size;
```

Expected effect: normal sidebar tab switching no longer evicts primary modules.

- [ ] **Step 5: Run tests**

Run:

```powershell
cd app
node --test src/lib/seasonWorkspaceReadModel.test.ts
```

Expected: PASS.

---

## Task 4: Convert Route Loaders To Store-First Rendering

**Files:**
- Modify:
  - `app/src/app/SeasonalSchedulePage.tsx`
  - `app/src/app/detailed/page.tsx`
  - `app/src/app/daily/page.tsx`
  - `app/src/app/checkin/page.tsx`
  - `app/src/app/gate/page.tsx`
  - `app/src/app/dashboard/page.tsx`
- Test: `app/src/app/onlineFirstRoutes.source.test.ts`

- [ ] **Step 1: Write source-regression tests**

Create `app/src/app/onlineFirstRoutes.source.test.ts`:

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

test('route pages consult shared workspace read model before native query', () => {
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /buildWorkspaceWindowCacheKey/, file);
    assert.match(source, /shouldRefreshWorkspaceWindow/, file);
    assert.match(source, /useSeasonWorkspaceStore/, file);
  }
});
```

- [ ] **Step 2: Run test and confirm red**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: FAIL until each route uses the shared read model.

- [ ] **Step 3: Refactor each loader**

For each route loader, use this sequence:

```ts
const windowKey = buildWorkspaceWindowCacheKey({
  route: 'daily',
  seasonId: targetSeason.id,
  dateFrom: fromDateTime.slice(0, 10),
  dateTo: toDateTime.slice(0, 10),
  resourceType: null,
  filter: '',
});

const cachedWorkspace = useSeasonWorkspaceStore.getState().workspaces[targetSeason.id];
const cachedWindowIds = cachedWorkspace?.windowIds.get(windowKey) ?? null;
const stale = cachedWorkspace?.staleWindowKeys.has(windowKey) ?? true;

if (cachedWorkspace && cachedWindowIds && !shouldRefreshWorkspaceWindow({
  cachedAt: cachedWorkspace.updatedAt,
  now: Date.now(),
  stale,
  ttlMs: 30_000,
})) {
  const records = cachedWindowIds
    .map((id) => cachedWorkspace.recordsById.get(id))
    .filter((record): record is FlightRecord => Boolean(record));
  setFlightRecords(records);
  setModifications(new Map(cachedWorkspace.modificationsByLegId));
  setSyncSummary({
    pendingCount: 0,
    conflictCount: 0,
    lastLocalChangeAt: cachedWorkspace.syncMeta?.lastLocalChangeAt ?? null,
  });
  setLoading(false);
  return;
}
```

Then keep the existing `queryNativeScheduleWindow()` or `queryNativeAllocationWindow()` as the refresh path and call `replaceSeasonWindow({ windowKey })` after refresh.

- [ ] **Step 4: Run route regression test**

Run:

```powershell
cd app
node --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: PASS.

---

## Task 5: Replace Save/Mutation Flow With Server RPC

**Files:**
- Modify route mutation handlers in:
  - `app/src/app/SeasonalSchedulePage.tsx`
  - `app/src/app/detailed/page.tsx`
  - `app/src/app/daily/page.tsx`
  - `app/src/app/checkin/page.tsx`
  - `app/src/app/gate/page.tsx`
- Modify:
  - `app/src/lib/nativeSeasonRepository.ts`
  - `app/src/lib/nativeSeasonCatchup.ts`
  - `app/src-tauri/src/native_catchup.rs`
- Test:
  - `app/src/lib/onlineFirstMode.source.test.ts`
  - `app/src-tauri/tests/native_catchup.rs`

- [ ] **Step 1: Add source-regression test for no durable local write**

Append to `app/src/lib/onlineFirstMode.source.test.ts`:

```ts
test('online-first route writes use server mutation before native cache update', () => {
  const files = [
    'src/app/daily/page.tsx',
    'src/app/checkin/page.tsx',
    'src/app/gate/page.tsx',
    'src/app/detailed/page.tsx',
    'src/app/SeasonalSchedulePage.tsx',
  ];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(source, /applySeasonServerMutationV1/, file);
    assert.doesNotMatch(source, /syncNow\(/, `${file} should not use legacy manual Save as primary write`);
  }
});
```

- [ ] **Step 2: Run test and confirm red**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
```

Expected: FAIL until route writes are switched.

- [ ] **Step 3: Convert one route at a time**

For each route mutation:

```ts
requireOnlineForServerWrite(navigator.onLine);
const result = await applySeasonServerMutationV1({
  seasonId: season.id,
  clientId: getOrCreateSeasonClientId(),
  clientMutationId: crypto.randomUUID(),
  source: 'checkin',
  baseServerSeq: syncSummary?.lastServerSeq ?? null,
  operations: buildServerMutationOperationsFromDraft(draft),
});
```

After success:

```ts
publishSeasonWorkspaceChanged({
  seasonId: season.id,
  localRevision: result.nextServerSeq,
  source: 'server-authoritative-write',
  affectedIds: result.affectedIds,
  changedTargets: result.changedTargets,
});
```

Then refresh the route window from server/native read cache and update `useSeasonWorkspaceStore`.

- [ ] **Step 4: Keep native SQLite as cache update only**

Add native command behavior:

```ts
await refreshNativeSeasonCacheFromServer({
  seasonId: season.id,
  throughServerSeq: result.serverHighWater,
  changedTargets: result.changedTargets,
});
```

Expected: SQLite mirrors the server result after RPC success; it does not create pending ops before RPC success.

- [ ] **Step 5: Run app tests and native tests**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts src/app/onlineFirstRoutes.source.test.ts
npx tsc --noEmit --pretty false
cargo test --manifest-path src-tauri/Cargo.toml --test native_catchup
```

Expected: all pass.

---

## Task 6: Retire Main-Workflow Conflict Review

**Files:**
- Modify: `app/src/app/components/SeasonConflictReviewControl.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify route save/fetch UI labels in route pages
- Test: `app/src/lib/onlineFirstMode.source.test.ts`

- [ ] **Step 1: Add source-regression test**

Append:

```ts
test('conflict review is legacy fallback in server-authoritative mode', () => {
  const conflictControl = readFileSync(join(process.cwd(), 'src/app/components/SeasonConflictReviewControl.tsx'), 'utf8');
  const provider = readFileSync(join(process.cwd(), 'src/app/components/SeasonSyncProvider.tsx'), 'utf8');
  assert.match(conflictControl, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(conflictControl, /return null/);
  assert.match(provider, /SERVER_AUTHORITATIVE_MODE/);
  assert.match(provider, /server-authoritative live refresh/i);
});
```

- [ ] **Step 2: Hide conflict UI when server-authoritative**

At the top of `SeasonConflictReviewControl` render:

```ts
if (SERVER_AUTHORITATIVE_MODE) return null;
```

- [ ] **Step 3: Replace Save/Fetch language**

Remove user-facing main workflow labels that imply offline pending sync:

```ts
'Save'
'Fetch Updates'
'Sync conflicts'
'Needs Review'
```

Use online-first equivalents:

```ts
'Apply'
'Refresh'
'Server updated'
'Refresh required'
```

- [ ] **Step 4: Run tests**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts
npm run test:rules
npx tsc --noEmit --pretty false
```

Expected: PASS.

---

## Task 7: Backend Handoff And Integration Gate

**Files:**
- Create: `docs/handoffs/online-first-server-authoritative-writes.md`
- Modify: `docs/handoffs/selfhosted-server-side-write-hardening.md`

- [ ] **Step 1: Send backend handoff**

Give backend the handoff file `docs/handoffs/online-first-server-authoritative-writes.md`.

- [ ] **Step 2: Wait for backend completion**

Do not switch app writes to `apply_season_server_mutation_v1` in production until backend confirms:

```sql
select public.run_selfhosted_integrity_checks();
select public.apply_season_server_mutation_v1(
  jsonb_build_object(
    'seasonId', '<real-season-id>',
    'clientId', 'smoke-client',
    'clientMutationId', gen_random_uuid()::text,
    'source', 'smoke',
    'operations', '[]'::jsonb
  )
);
```

Expected:
- integrity check returns zero orphan/duplicate issues;
- empty mutation validates auth and idempotency;
- anon execute remains revoked;
- authenticated/service_role execute is granted.

---

## Task 8: Verification And Rollout

**Files:**
- Modify: `docs/runbooks/selfhosted-cloudflare-cutover.md`
- Modify: `context.md`
- Modify: `architecture.md`

- [ ] **Step 1: Run full app verification**

Run:

```powershell
cd app
node --test src/lib/onlineFirstMode.source.test.ts src/lib/seasonWorkspaceReadModel.test.ts src/app/onlineFirstRoutes.source.test.ts
npm run test:rules
npx tsc --noEmit --pretty false
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --test native_catchup
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Smoke through app**

Manual smoke:

- Login through self-hosted Supabase.
- Open Dashboard, Seasonal, Detailed, Daily, Check-in, Gate.
- Switch tabs repeatedly and verify cached views render immediately.
- Apply one small Check-in edit and verify server event/cursor advances.
- Apply one small Gate edit and verify another route refreshes from server event.
- Disconnect network and verify writes are blocked with online-required messaging.
- Reconnect and verify refresh works.
- Verify conflict review is absent from the main flow.

- [ ] **Step 3: Update durable docs**

Add final status to `context.md`:

```md
- Online-first server-authoritative cutover completed: route pages render from shared workspace cache first, durable offline writes are disabled, operational mutations commit through server RPC, and conflict review is retained only as a legacy fallback path.
```

Update `architecture.md` to state:

```md
SQLite is now a read-through desktop cache and reporting accelerator. Supabase self-hosted is the durable write authority. Conflict review is not part of the normal online-first workflow; audit/change events are the recovery surface.
```

---

## Self-Review

- Spec coverage:
  - Online-first server authority: Tasks 1, 2, 5, 6.
  - State/cache boundary: Tasks 3, 4.
  - Conflict review retirement: Task 6.
  - Backend/database handoff: Task 7 and `docs/handoffs/online-first-server-authoritative-writes.md`.
  - Verification: Task 8.
- Placeholder scan:
  - No `TBD`, `TODO`, or undefined deferred behavior is used as acceptance criteria.
- Type consistency:
  - `applySeasonServerMutationV1`, `ServerSeasonMutationPayload`, `ServerSeasonMutationResult`, `serverHighWater`, `changedTargets`, and `clientMutationId` are used consistently across tasks.

## Execution Choice

Recommended execution: Subagent-Driven.

Task grouping:

- Subagent A: mode contract, source tests, docs.
- Subagent B: read-model/cache boundary and route cache.
- Subagent C: route loader conversions.
- Subagent D: server mutation contract and Supabase adapter.
- Subagent E: route write conversion and native cache refresh.
- Subagent F: conflict review retirement and final verification.
