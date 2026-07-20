# Server-First Route Reload Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop SeasonalManagement pages from returning to a blocking loading state after two or three tab changes, eliminate the recurring workspace-window `57014` timeout/request storm, and keep Supabase/server data as the only normal read source without falling back to SQLite.

**Architecture:** Keep the existing one-active-route lifecycle for memory-heavy pages, but make remounts cheap. A shared server-window coordinator reads a per-window Zustand snapshot synchronously, renders stale data immediately, coalesces duplicate logical loads, and commits a completed load to the store even when the page that started it has unmounted. A versioned `get_season_schedule_allocation_window_v2` transport composes a complete logical window from bounded, sequential keyset pages pinned to one `dataVersion`/`serverHighWater`; no page fan-out or mixed-version merge is allowed. Same-user Supabase token events revalidate operator access in the background without unmounting `AppShell`. Provider cleanup closes scheduler and realtime races. Settings and Audit receive the same read-through-memory behavior.

**Tech Stack:** Next.js 16, React 19, TypeScript, Zustand 5, Supabase JS 2, Node `node:test`, Tauri 2, PowerShell.

---

## Global Constraints

- Supabase is the durable source of truth and the only normal route-read source.
- Do not read SQLite, native local tables, or a SQLite-derived cache when a route mounts or a server request fails.
- Memory/Zustand snapshots in this plan contain data previously returned by the server. They are not an offline database and are cleared on process restart.
- A stale snapshot must remain visible while the server is revalidated. Only a missing snapshot may show the blocking page loader.
- Page cleanup may suppress local `setState`, but it must not discard or abort a shared request merely because the user changed tabs. The coordinator commits the result before resolving its promise.
- A canonical server query has at most one in-flight request per invalidation generation. Repeated refreshes in the same generation join; a mutation/realtime invalidation increments the generation so post-mutation `force: true` cannot join a pre-mutation response.
- "One request" in the coordinator contract means one logical window load. That logical promise may issue multiple V2 page RPCs, but they run strictly one at a time, share one abort/session/generation boundary, and never expose or commit a partial snapshot.
- Before every forced post-mutation revalidation, advance the affected season's generation exactly once. A successful `patchSeasonWorkspace()` already performs that invalidation; a mutation path that has not patched the workspace, especially Seasonal import, uses `revalidateSeasonWorkspaceAfterMutation(windowInput, { operatorSessionEpoch, generationAlreadyAdvanced: false })` so the helper calls `markSeasonWorkspaceStale(seasonId, 'mutation', operatorSessionEpoch)` before revalidating. A patched path passes `true` and must not increment again.
- Every async operation that can populate an operator-scoped module cache, Zustand store, or read model captures `operatorSessionEpoch` before its first `await`. Every later commit checks that epoch. Multi-request server writes also run an epoch checkpoint before each sequential sub-request/chunk, so an operation that started under the old user cannot issue its next request under the new session. Sign-out/user change advances the epoch before clearing caches; stale work exits without committing, reporting a current-user error, or recursively starting a request for the new operator.
- A response from one window may never overwrite a newer overlapping entity from another window. Window snapshots stay isolated and normalized entities merge monotonically by `serverHighWater`.
- Realtime invalidation is persisted in Zustand before the event is published, so a route that is currently unmounted still remounts stale and revalidates. New/removed records invalidate every cached window for that season.
- Server-window keys contain only server query dimensions. Flight number, route, airline, aircraft, text, sort, and other client-only filters never create duplicate server windows.
- Preserve Detailed Schedule's existing no-date behavior: when neither From nor To is selected, the logical server window is the full season. Do not narrow the default to 7/30 days or require operators to add a date filter. The implementation may compose that logical window from bounded server pages/chunks, but the resulting snapshot and visible schedule must still cover the complete season.
- Every page after the first must pass the first page's `dataVersion` and `serverHighWater`. Any mismatch discards the entire partial assembly and restarts through the current coordinator generation; mixed-version pages may never be merged.
- A generic network error such as `Failed to fetch` must not fan out into paged Supabase reads. Task 5's direct-table fallback is a bounded V1 compatibility safeguard only. The V2 client may use V1 only when the V2 RPC signature is confirmed missing during the additive rollout; a V2 timeout/network failure must remain one failed logical load and must not trigger V1 or direct-table fan-out.
- Keep the existing global `authenticated.statement_timeout=8s` as an acceptance constraint. Fix query shape, request duplication, and import/read contention; do not raise the timeout as the primary remedy.
- In the combined import cutover, `commit_seasonal_import_v2` is the only import write and `revalidateSeasonWorkspaceAfterMutation()` is the only initiating-client post-commit schedule read. The import handler must not also start `loadSeasonWorkspaceWindow()`, apply pre-RPC arrays, or publish another refresh-triggering event.
- The import batch/change event carries the initiating `clientId` and stable request ID. The initiating client ignores its own realtime import echo and relies on the explicit coordinated reconciliation; every other client persists one invalidation and starts at most one logical load for that generation.
- Automatic realtime/TTL revalidation waits a full-jitter `100-300ms` before joining or starting the current generation's logical chain; manual Refresh/Fetch and explicit post-mutation reconciliation are not delayed. After the delay, re-check operator epoch, generation, freshness, and the in-flight registry before issuing I/O.
- `snapshot_changed` discards the partial assembly and may automatically restart only once, after full-jitter `250-1000ms`. Re-check abort, operator epoch, generation, and whether another complete snapshot already satisfied the generation before restarting. A second mismatch preserves the stale snapshot and surfaces a retry warning; it never loops indefinitely.
- Do not build a shared server page cache initially. If the seven-client capacity gate fails its latency, CPU, concurrency, or `57014` acceptance, add an immutable page cache keyed by canonical window dimensions + snapshot token + page cursor before release, then rerun the full capacity/completeness matrix.
- Preserve the existing visible labels, route URLs, filters, selections, scroll restoration, draft state, optimistic mutations, and manual Refresh/Fetch actions.
- Clear all operator-scoped server snapshots, settings, audit data, and in-flight requests on sign-out or an authenticated user change; never show one operator another operator's warm cache.
- Preserve `AppRouteCache`'s current one-active-heavy-page policy. Do not keep every page mounted as the primary fix.
- Do not add Next `cacheComponents`/Activity as part of this change. Consider selective Activity only after this plan is complete and profiling proves that a specific lightweight route still needs it.
- Do not modify the user's existing uncommitted `AGENTS.md` change.
- Every implementation task follows RED -> GREEN -> focused verification -> commit. Run commands from `C:\Users\tuan\Documents\SeasonalManagement\app` unless a step says otherwise.

---

## Re-evaluated Baseline From Current `main`

- Baseline commit on 2026-07-13: `main == origin/main == 0127ddb`. Application code is unchanged from `a6080d1` (`app-v0.1.10`); the latest commit only updated the project-agent timestamp.
- Baseline checks already pass: focused server-first/cache tests, `npm run test:rules`, `npx tsc --noEmit --pretty false`, and `npm run build`. `npm run lint` exits successfully with five pre-existing warnings.
- `app/src/app/components/AppRouteCache.tsx` renders only the active route. `AppRouteCache.source.test.ts` intentionally prevents keeping all heavy pages mounted. Therefore a route remount is expected, but a blocking reload is not.
- Dashboard, Daily, Check-in, and Gate can seed some state from a fresh cache. Seasonal, Detailed, Settings, and Audit still enter loading-first paths on mount.
- `readCachedWorkspaceWindow()` rejects stale/expired data, although `readWorkspaceWindowSnapshot()` can still return it. Pages therefore hide usable server data while a refresh runs.
- `seasonWorkspaceStore.ts` uses one workspace-wide `updatedAt`; loading one window can incorrectly refresh the apparent TTL of another window.
- Requests are owned by page effects. Cleanup sets `cancelled`, so a completed request can be discarded before it warms Zustand. `remoteStore.loadSeasonWorkspaceWindow()` has no shared in-flight registry.
- Seasonal and Detailed keys include UI-only filters that are absent from their server request, producing duplicate cache entries for the same server query.
- `supabaseStore.ts` treats generic transient fetch failures as permission to fall back to paged reads, and the paged path can load all matching rows before applying `limit`.
- Detailed currently sends `dateFrom=null`, `dateTo=null`, `resourceType='schedule'`, and `limit=100000` when From/To are blank, so the production V1 RPC is asked to aggregate essentially the full season in one statement.
- Runtime evidence supplied on 2026-07-20 shows bursts of seven simultaneous calls to the same workspace-window RPC. During those bursts CPU saturates, each request slows, and requests cross the authenticated role's 8-second statement timeout. This is a request-amplification problem as well as a query-shape problem.
- The tracked application schema does not define `get_season_schedule_allocation_window_v1`; it exists only as a deployed backend contract referenced by the client/handoffs. V2 must therefore be added as a tracked, versioned migration and mirrored into `app/supabase/schema.sql` instead of relying on an untracked production-only function.
- The separate `2026-07-18-seasonal-source-row-import-export-v2.md` plan already records `57014` for the legacy server-side import and replaces its duplicated ~52 MB atomic-record payload with staged source-row V2 processing. This plan owns the read-side timeout/storm fix; the two plans share one rollout gate and one post-import coordinated refresh, but they remain separate RPCs and transactions.
- `OperatorAuthGate` sets `status='checking'` for every auth event. Since `AppShell` is below the gate and Supabase auto-refreshes tokens, same-user refresh events can temporarily replace and remount the whole application tree.
- `SeasonSyncProvider` can retain a late realtime subscription and does not dispose `SeasonAutoSyncScheduler` timers/idle callbacks on provider teardown.
- `app/src/app/components/NativeRuntimeGate.tsx` still says SQLite is the only operational store. That text is stale and must not be treated as the current architecture.

---

## Chosen Solution And Deferred Alternatives

1. **Implement now: shared server-window SWR coordinator.** This directly fixes discarded loads, duplicate calls, stale-content blanking, and inconsistent route initialization without changing the heavy-page lifecycle.
2. **Implement now: auth and provider lifecycle hardening.** This removes application-wide remounts caused by same-user token events and closes scheduler/subscription leaks that accumulate across lifecycle changes.
3. **Implement now: Settings and Audit read-through memory.** These pages are outside the season-window store but reproduce the same mount-loading symptom.
4. **Implement now: capacity-safe full-season workspace reads.** Add `get_season_schedule_allocation_window_v2` with bounded dual-stream keyset pages for records and modifications, deterministic child hydration, and snapshot-token validation. Keep the existing full-season Detailed result when no date filter is selected, but do not require one unbounded aggregate statement to materialize it.
5. **Implement together: import/read contention boundary.** Keep the staged source-row import V2 from the 2026-07-18 plan as the write transaction, then advance the season generation once and run exactly one coordinated V2 logical window load. Do not let a successful import launch page-owned, coordinator-owned, and realtime-owned full-season reads in parallel. De-synchronize automatic cross-client refresh with the fixed jitter policy above; add immutable server page caching only if the seven-client gate proves it necessary.
6. **Do not use: a longer TTL alone.** It reduces frequency but does not fix duplicate requests, discarded results, auth remounts, or stale-data blanking.
7. **Do not use: keep all pages mounted.** It trades loading flashes for retained Gantt/calendar trees, timers, subscriptions, and memory growth.
8. **Do not use: SQLite/native fallback.** It violates the current server-first boundary and can display data that is not the server truth.
9. **Defer: selective React Activity/Next cache components.** The current static-export configuration does not enable that path, and it is unnecessary if server snapshots make remounts non-blocking.

---

## Target Read Sequence

```text
route mounts
  -> build canonical server-window input
  -> read Zustand snapshot synchronously
       missing: show blocking loader
       fresh:   render immediately, no request
       stale:   render immediately, revalidate in background
  -> coordinator joins or starts one logical load per key + generation
  -> V2 assembler fetches bounded keyset pages sequentially
       first page: capture dataVersion + serverHighWater
       later pages: pass the same expected snapshot token
       mismatch: discard all partial rows and retry in the current generation
       complete: validate counts and assemble one immutable full snapshot
  -> coordinator commits the complete result + per-window metadata once
  -> current page applies result if still mounted
  -> later remount reads the already-committed snapshot
```

No branch in this sequence reaches SQLite.

---

## File Structure

### Auth lifecycle

- Create: `app/src/lib/operatorAuthSessionPolicy.ts`
- Create: `app/src/lib/operatorAuthSessionPolicy.test.ts`
- Create: `app/src/lib/operatorSessionCacheRegistry.ts`
- Create: `app/src/lib/operatorSessionCacheRegistry.test.ts`
- Modify: `app/src/lib/appSessionCleanup.ts`
- Modify: `app/src/lib/auditLog.ts`
- Create: `app/src/app/components/OperatorAuthGate.source.test.ts`
- Modify: `app/src/app/components/OperatorAuthGate.tsx`

### Provider lifecycle

- Create: `app/src/lib/seasonAutoSync.test.ts`
- Modify: `app/src/lib/seasonAutoSync.ts`
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`

### Shared server-window state and transport

- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.test.ts`
- Modify: `app/src/lib/seasonWorkspaceReadModel.ts`
- Modify: `app/src/lib/seasonWorkspaceReadModel.test.ts`
- Create: `app/src/lib/seasonWorkspaceWindowCoordinator.ts`
- Create: `app/src/lib/seasonWorkspaceWindowCoordinator.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/nativeLocalSeasonStore.ts`
- Create: `app/src/lib/supabaseErrorPolicy.ts`
- Create: `app/src/lib/supabaseErrorPolicy.test.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Create: `app/src/lib/supabaseWorkspaceWindowTransport.source.test.ts`
- Create: `app/src/lib/seasonWorkspaceWindowRpcV2Contract.ts`
- Create: `app/src/lib/seasonWorkspaceWindowRpcV2Contract.test.ts`
- Create: `app/supabase/migrations/20260720090000_workspace_window_keyset_v2.sql`
- Create: `app/supabase/tests/workspace_window_keyset_v2.sql`
- Modify: `app/supabase/schema.sql`
- Create: `app/scripts/workspace-window-v2-load-test.mjs`
- Modify: `app/package.json`
- Modify: `docs/backend-supabase-schema-functions.md`

### Route migrations

- Create: `app/src/app/serverWindowSWRRoutes.source.test.ts`
- Create: `app/src/app/postMutationWindowGeneration.source.test.ts`
- Create: `app/src/app/operatorSessionEpoch.source.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/nativeLocalSeasonStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/components/AppRouteCache.source.test.ts`
- Modify: `app/src/app/syncFetchBoundary.source.test.ts`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`

### Settings and Audit

- Create: `app/src/app/settings/settingsSnapshotFirst.source.test.ts`
- Create: `app/src/app/audit/auditSnapshotFirst.source.test.ts`
- Create: `app/src/lib/operationalSettingsReadModel.ts`
- Create: `app/src/lib/operationalSettingsReadModel.test.ts`
- Modify: `app/src/app/settings/page.tsx`
- Create: `app/src/lib/auditReadModel.ts`
- Create: `app/src/lib/auditReadModel.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `app/src/lib/auditLog.ts`
- Modify: `app/src/app/audit/page.tsx`

### Contract and verification

- Modify: `app/src/app/components/NativeRuntimeGate.tsx`
- Modify: `app/src/lib/serverAuthoritativeMode.ts`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`
- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `app/README.md`
- Create: `docs/superpowers/artifacts/2026-07-13-server-first-route-reload-verification.md`

---

## Shared Public Contracts

The implementation must converge on these names and shapes before route migration:

```ts
export interface ServerWorkspaceWindowInput {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  resourceType?: 'gate' | 'checkin' | 'schedule' | string | null;
  // Logical result ceiling for the complete assembled window, never page size.
  limit?: number | null;
}

export interface WorkspaceWindowV2SnapshotToken {
  dataVersion: number;
  serverHighWater: number;
}

export interface WorkspaceWindowV2RootCursor {
  effectiveDate: string;
  rootId: string;
  rootKind: 0 | 1;
}

export type WorkspaceWindowV2Page =
  | {
      status: 'ok';
      seasonId: string;
      startDate: string | null;
      endDate: string | null;
      resourceType: string;
      snapshot: WorkspaceWindowV2SnapshotToken;
      page: {
        returnedCount: number;
        hasMore: boolean;
        nextCursor: WorkspaceWindowV2RootCursor | null;
      };
      flightRecords: FlightRecordRelationalRow[];
      flightRecordCounters: FlightRecordCounterRelationalRow[];
      flightRecordWindows: FlightRecordWindowRelationalRow[];
      modifications: ModificationRelationalRow[];
      modificationCounters: ModificationCounterRelationalRow[];
      modificationWindows: ModificationWindowRelationalRow[];
      modificationAddedLegs: ModificationAddedLegRelationalRow[];
    }
  | {
      status: 'snapshot_changed';
      snapshot: WorkspaceWindowV2SnapshotToken;
    };

export type SeasonWorkspaceWindowFreshness = 'missing' | 'fresh' | 'stale';
export type SeasonWorkspaceWindowRequestStatus =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'error';

export interface SeasonWorkspaceWindowState {
  windowKey: string;
  generation: number;
  snapshot: CachedWorkspaceWindow | null;
  freshness: SeasonWorkspaceWindowFreshness;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  shouldRevalidate: boolean;
  fetchedAt: number | null;
  dataVersion: number | null;
  serverHighWater: number | null;
  staleReason: string | null;
  lastError: string | null;
}

export function buildServerWorkspaceWindowKey(
  input: ServerWorkspaceWindowInput,
): string;

export function readSeasonWorkspaceWindowState(
  input: ServerWorkspaceWindowInput,
  options?: { now?: number; ttlMs?: number },
): SeasonWorkspaceWindowState;

export function revalidateSeasonWorkspaceWindow(
  input: ServerWorkspaceWindowInput,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    initiator?: 'automatic' | 'immediate';
  },
): Promise<CachedWorkspaceWindow | null>;

export function revalidateSeasonWorkspaceAfterMutation(
  input: ServerWorkspaceWindowInput,
  options: {
    operatorSessionEpoch: number;
    generationAlreadyAdvanced: boolean;
    expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
  },
): Promise<CachedWorkspaceWindow | null>;
```

Canonical key:

```ts
[
  'server-window-v2',
  input.seasonId,
  input.dateFrom ?? '',
  input.dateTo ?? '',
  input.resourceType ?? 'all',
  input.limit ?? 'all',
].join('|');
```

`signal` is request lifecycle metadata and is never part of this key. V2 page size, page cursor, snapshot token, retry state, and jitter are transport metadata and are also never part of this key. Normal page unmounts do not pass or abort a signal.

The tracked SQL contract is:

```sql
public.get_season_schedule_allocation_window_v2(
  p_season_id text,
  p_start_date text default null,
  p_end_date text default null,
  p_resource_type text default 'all',
  p_page_size integer default 500,
  p_after_effective_date text default null,
  p_after_root_id text default null,
  p_after_root_kind smallint default null,
  p_expected_data_version integer default null,
  p_expected_server_high_water bigint default null
) returns jsonb
```

Clamp or reject page sizes outside `1..1000`; the normal client page size is `500`. Cursor fields are either all null or all present. Expected snapshot fields are also either both null or both present. Validate inclusive ISO date bounds, `start <= end`, and the existing resource values `all`, `schedule`, `gate`, `checkin`, `stand`, `counter`, and `carousel`.

Build one canonical root stream and fetch `page_size + 1` roots using tuple keyset comparison, never offset pagination:

```text
effectiveDate = coalesce(
  nullif(operational_date, ''),
  nullif(scheduled_date, ''),
  nullif(date, ''),
  ''
)
rootKind 0 = season_flight_records.record_id
rootKind 1 = season_modification_added_legs.leg_id
ORDER BY effectiveDate, rootId, rootKind
```

A base root returns the selected flight row, its counters/windows, and only the base modification whose `leg_id` matches that root. An added root returns its modification, added-leg row, and modification children. Never paginate child tables independently and never attach every season modification to each page. Include deleted/modified states needed by current effective-leg materialization.

The first page captures `seasons.data_version` and the season's maximum `season_change_events.server_seq`. Later pages pass both values. If either differs, return only `status='snapshot_changed'` plus the current token; do not return arrays. The client discards all accumulated pages, waits full-jitter `250-1000ms`, and restarts at most once under the same coordinator promise/generation. A second mismatch preserves the stale snapshot and surfaces a retry warning. Every production schedule write must increment `seasons.data_version` or insert a `season_change_events` row in the same transaction; the SQL/integration tests must prove this fence for import and all active schedule mutation RPCs before V2 consistency can be accepted.

Implement the function as `security invoker`, preserve RLS, revoke execute from `PUBLIC` and `anon`, and grant execute to `authenticated` and `service_role`. Keep V1 callable for old clients through the compatibility window.

---

## Task 1: Define The Operator Auth Event Policy

**Files:**

- Create: `app/src/lib/operatorAuthSessionPolicy.ts`
- Create: `app/src/lib/operatorAuthSessionPolicy.test.ts`

**Interfaces:**

```ts
export type OperatorAuthSessionEvent = AuthChangeEvent | 'BOOTSTRAP';
export type OperatorAuthSessionAction =
  | { kind: 'sign-out' }
  | { kind: 'verify-operator'; blocking: boolean };

export function resolveOperatorAuthSessionAction(
  event: OperatorAuthSessionEvent,
  sessionUserId: string | null,
  authorizedUserId: string | null,
): OperatorAuthSessionAction;

export function createOperatorVerificationSingleFlight<T>(
  load: (userId: string) => Promise<T>,
): { verify(userId: string): Promise<T>; clear(): void };
```

- [ ] **Step 1: Write failing policy and single-flight tests**

Create `app/src/lib/operatorAuthSessionPolicy.test.ts` with these cases:

```ts
test('same-user token refresh verifies without blocking', () => {
  assert.deepEqual(
    resolveOperatorAuthSessionAction('TOKEN_REFRESHED', 'user-1', 'user-1'),
    { kind: 'verify-operator', blocking: false },
  );
  assert.deepEqual(
    resolveOperatorAuthSessionAction('USER_UPDATED', 'user-1', 'user-1'),
    { kind: 'verify-operator', blocking: false },
  );
});

test('duplicate sign-in and initial-session events verify in the background', () => {
  assert.deepEqual(
    resolveOperatorAuthSessionAction('SIGNED_IN', 'user-1', 'user-1'),
    { kind: 'verify-operator', blocking: false },
  );
  assert.deepEqual(
    resolveOperatorAuthSessionAction('INITIAL_SESSION', 'user-1', 'user-1'),
    { kind: 'verify-operator', blocking: false },
  );
});

test('bootstrap, changed user, and missing session block or sign out', () => {
  assert.deepEqual(
    resolveOperatorAuthSessionAction('BOOTSTRAP', 'user-1', null),
    { kind: 'verify-operator', blocking: true },
  );
  assert.deepEqual(
    resolveOperatorAuthSessionAction('SIGNED_IN', 'user-2', 'user-1'),
    { kind: 'verify-operator', blocking: true },
  );
  assert.deepEqual(
    resolveOperatorAuthSessionAction('SIGNED_OUT', null, 'user-1'),
    { kind: 'sign-out' },
  );
});
```

Also test that two `verify('user-1')` calls return the same promise, the loader runs once, settled requests are removed, and a failed request can be retried.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/lib/operatorAuthSessionPolicy.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because the policy module does not exist.

- [ ] **Step 3: Implement the minimal policy**

```ts
export function resolveOperatorAuthSessionAction(
  event: OperatorAuthSessionEvent,
  sessionUserId: string | null,
  authorizedUserId: string | null,
): OperatorAuthSessionAction {
  if (event === 'SIGNED_OUT' || !sessionUserId) return { kind: 'sign-out' };
  if (sessionUserId !== authorizedUserId) {
    return { kind: 'verify-operator', blocking: true };
  }
  return { kind: 'verify-operator', blocking: false };
}
```

Implement `createOperatorVerificationSingleFlight()` with a `Map<string, Promise<T>>`; remove an entry in both resolve and reject paths only when it is still the current promise.

- [ ] **Step 4: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/operatorAuthSessionPolicy.test.ts
```

Expected: all policy tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/operatorAuthSessionPolicy.ts src/lib/operatorAuthSessionPolicy.test.ts
git commit -m "feat(auth): define operator session transition policy"
```

---

## Task 2: Keep `AppShell` Mounted During Same-User Token Refresh

**Files:**

- Create: `app/src/app/components/OperatorAuthGate.source.test.ts`
- Modify: `app/src/app/components/OperatorAuthGate.tsx`
- Create: `app/src/lib/operatorSessionCacheRegistry.ts`
- Create: `app/src/lib/operatorSessionCacheRegistry.test.ts`
- Modify: `app/src/lib/appSessionCleanup.ts`
- Modify: `app/src/lib/auditLog.ts`

**Interfaces:**

```ts
verifySession(
  session: Session | null,
  options: { blocking: boolean },
): Promise<void>;

handleAuthSession(
  event: OperatorAuthSessionEvent,
  session: Session | null,
): void;

createOperatorSessionCacheRegistry(): {
  register(key: string, clear: () => void): () => void;
  getEpoch(): number;
  isCurrent(epoch: number): boolean;
  advanceAndClear(): number;
};

registerOperatorSessionCacheClearer(
  key: string,
  clear: () => void,
): () => void;

getOperatorSessionEpoch(): number;

isOperatorSessionEpochCurrent(epoch: number): boolean;

advanceOperatorSessionEpochAndClearRegisteredCaches(): number;

clearOperatorScopedMemoryCaches(): void;

resetAuditSessionId(): void;

export function createOperatorSessionAbortError(): DOMException;

export interface OperatorSessionRemoteOptions {
  operatorSessionEpoch: number;
}

export interface OperatorSessionCheckpointOptions {
  assertOperatorSessionCurrent: () => void;
}

export function runOperatorSessionResourceOperation<Resource, Result>(input: {
  operatorSessionEpoch: number;
  acquire: () => Promise<Resource>;
  execute: (
    resource: Resource,
    assertOperatorSessionCurrent: () => void,
  ) => Promise<Result>;
}): Promise<Result>;
```

- [ ] **Step 1: Write the source-contract tests**

Create `OperatorAuthGate.source.test.ts`, read `OperatorAuthGate.tsx`, `appSessionCleanup.ts`, and `auditLog.ts` into `source`/`cleanupSource`/`auditLogSource`, and assert all of the following:

```ts
assert.match(source, /resolveOperatorAuthSessionAction\(/);
assert.match(source, /handleAuthSession\('BOOTSTRAP', data\.session\)/);
assert.match(source, /createOperatorVerificationSingleFlight/);
assert.match(source, /if \(options\.blocking\) setStatus\('checking'\);/);
assert.doesNotMatch(source, /supabase\.auth\.refreshSession\(/);
assert.match(source, /clearOperatorScopedMemoryCaches\(\)/);
assert.match(
  source,
  /refreshIdRef\.current \+= 1;[\s\S]*operatorVerification\.clear\(\);[\s\S]*subscription\.unsubscribe\(\)/,
);
assert.match(cleanupSource, /clearSeasonDataCache\(\)/);
assert.match(cleanupSource, /resetSeasonWorkspaceStore\(\)/);
assert.match(cleanupSource, /advanceOperatorSessionEpochAndClearRegisteredCaches\(\)/);
assert.match(cleanupSource, /resetAuditSessionId\(\)/);
assert.match(auditLogSource, /export function resetAuditSessionId\(\): void/);
assert.match(auditLogSource, /sessionStorage\.removeItem\(AUDIT_SESSION_STORAGE_KEY\)/);
```

Create `operatorSessionCacheRegistry.test.ts` and prove that stable string keys replace an older clearer (safe under HMR), unregister removes only the matching current clearer, one failing clearer does not prevent the others, and `advanceAndClear()` increments the epoch before invoking each current clearer exactly once. Prove a token captured before the call becomes stale and the returned/current epoch is accepted. With a fake `window.sessionStorage`, also prove `resetAuditSessionId()` removes `seasonalManagement.audit.sessionId` so the next operator cannot inherit the previous audit session.

Test `runOperatorSessionResourceOperation()` at every async boundary. Delay `acquire()`, advance the epoch, then resolve it; assert `execute()` is never called and the result rejects with `AbortError`. In a second case let `execute()` start, advance the epoch, then reject it with an old-session network error; assert that error is normalized to `AbortError`. Add a delayed internal-step case whose `execute(resource, assertOperatorSessionCurrent)` completes a first fake network step, waits, calls the supplied checkpoint, and only then would issue a second step. Advance the epoch while it waits and assert the second step is never issued. A current-epoch success returns its value. The helper must check before acquire, immediately after acquire and before execute, after execute resolves, and in `catch` before rethrowing any error; the supplied checkpoint performs the same current-epoch assertion inside multi-request implementations.

- [ ] **Step 2: Run RED**

```powershell
node --test src/app/components/OperatorAuthGate.source.test.ts
node --experimental-strip-types --test src/lib/operatorSessionCacheRegistry.test.ts
```

Expected: FAIL because every event currently calls the blocking `refreshSession()` path, bootstrap explicitly refreshes the Supabase token, and no operator-scoped registry/clear path exists.

- [ ] **Step 3: Split blocking and background verification**

Create the dependency-injected registry plus singleton wrappers. In the same module, implement `runOperatorSessionResourceOperation()` so `execute(resource, assertOperatorSessionCurrent)` is invoked synchronously after the post-acquire epoch check; this prevents an old operation from acquiring a lazily initialized remote store and then issuing a write under the new Supabase session. The checkpoint closure retains the original epoch and throws `createOperatorSessionAbortError()` whenever it is stale. Normalize stale success and stale rejection to that same error.

Add `resetAuditSessionId()` to `auditLog.ts` to remove `AUDIT_SESSION_STORAGE_KEY` from `sessionStorage`. In `appSessionCleanup.ts`, add `clearOperatorScopedMemoryCaches()` that first calls `advanceOperatorSessionEpochAndClearRegisteredCaches()`, then `clearSeasonDataCache()`, `useSeasonWorkspaceStore.getState().resetSeasonWorkspaceStore()`, and `resetAuditSessionId()`. Advancing first makes every outstanding async operation stale before any cache is cleared. Make the existing `clearNativeAppEphemeralData()` call this function instead of only `clearSeasonDataCache()`.

In `OperatorAuthGate.tsx`:

- add `authorizedUserIdRef`;
- create one memoized operator lookup with `createOperatorVerificationSingleFlight()`;
- replace `refreshSession()` with `verifySession(session, { blocking })`;
- call `setStatus('checking')` only when `blocking` is true;
- on a background network error, retain the current authorized user and children, store the error message, and return;
- when the server successfully confirms that `app_operators` has no row, clear `authorizedUserIdRef` and set `unauthorized` even for background verification;
- ignore an older lookup using the existing monotonically increasing `refreshIdRef`.
- call `clearOperatorScopedMemoryCaches()` before blocking verification of a different non-null user, on sign-out, and when a successful background verification confirms the current user no longer has an operator row. Same-user background refresh must not clear caches.

Every same-user non-signout event, including duplicate `SIGNED_IN` and `INITIAL_SESSION`, runs background verification so an operator revocation is still observed without replacing authorized children. The auth effect must use this shape:

```ts
supabase.auth.getSession().then(({ data, error }) => {
  if (!active) return;
  if (error) {
    setErrorMessage(error.message);
    setStatus('signedOut');
    return;
  }
  handleAuthSession('BOOTSTRAP', data.session);
});

const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
  handleAuthSession(event, session);
});
```

Cleanup increments `refreshIdRef`, clears the single-flight registry, and unsubscribes. Sign-in calls `verifySession(data.session, { blocking: true })`; sign-out clears `authorizedUserIdRef`.

- [ ] **Step 4: Run GREEN and typecheck**

```powershell
node --experimental-strip-types --test src/lib/operatorAuthSessionPolicy.test.ts
node --experimental-strip-types --test src/lib/operatorSessionCacheRegistry.test.ts
node --test src/app/components/OperatorAuthGate.source.test.ts
npx tsc --noEmit --pretty false
```

Expected: auth tests PASS and TypeScript exits `0`.

- [ ] **Step 5: Commit**

```powershell
git add src/app/components/OperatorAuthGate.tsx src/app/components/OperatorAuthGate.source.test.ts src/lib/operatorSessionCacheRegistry.ts src/lib/operatorSessionCacheRegistry.test.ts src/lib/appSessionCleanup.ts src/lib/auditLog.ts
git commit -m "fix(auth): keep app mounted during token refresh"
```

---

## Task 3: Dispose Auto-Sync And Realtime Lifecycle Work

**Files:**

- Create: `app/src/lib/seasonAutoSync.test.ts`
- Modify: `app/src/lib/seasonAutoSync.ts`
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`

**Interfaces:**

```ts
class SeasonAutoSyncScheduler {
  dispose(): void;
}
```

`dispose()` is idempotent, cancels timeout and idle handles, clears queued reruns, rejects/no-ops future work, and suppresses state publication after an already-running task finishes. It does not try to abort the existing `runtime.run()` because that runtime has no abort contract.

- [ ] **Step 1: Write failing scheduler lifecycle tests**

Create `seasonAutoSync.test.ts` with fake timeout/idle handles and test:

1. `notifyLocalChange()` schedules work, then `dispose()` cancels the handle exactly once.
2. Invoking the captured callback after dispose does not call `run` or `onState`.
3. Future `notifyLocalChange()`, `notifyGuardChanged()`, `notifyOnline()`, and `setProgress()` are no-ops.
4. `syncNow()` after dispose returns:

```ts
{
  status: 'failed',
  message: 'Sync coordinator has been disposed.',
}
```

5. If `runtime.run()` was already in flight, resolving it after dispose does not read pending count again, publish state, or run a queued pass.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/lib/seasonAutoSync.test.ts
```

Expected: FAIL with `TypeError: scheduler.dispose is not a function`.

- [ ] **Step 3: Implement scheduler disposal**

Add `private disposed = false`. Add guards at the start of every public mutating method, `schedule()`, scheduled timeout/idle callbacks, `runSeason()`, `updateState()`, and after each awaited runtime boundary. `getState()` after dispose returns an existing record or a new immutable default without inserting a record.

```ts
dispose(): void {
  if (this.disposed) return;
  this.disposed = true;
  for (const record of this.records.values()) {
    this.cancelScheduled(record);
    record.queued = false;
  }
}
```

- [ ] **Step 4: Write failing provider source tests**

Append assertions to `SeasonSyncProvider.source.test.ts` proving that:

- the scheduler effect returns `nextScheduler.dispose()`;
- the provider lifecycle effect sets `providerMountedRef.current = true` on every setup before returning cleanup (including the second React Strict Mode setup);
- each pending realtime subscription has its own `{ cancelled: boolean }` attempt object;
- a subscription that resolves after cleanup immediately invokes its returned unsubscribe;
- a late rejection does not call `patchSeasonState`;
- provider cleanup cancels attempts, clears `liveSubscribingRef`, invokes all current unsubscribers, and clears the map.

- [ ] **Step 5: Run provider RED**

```powershell
node --test src/app/components/SeasonSyncProvider.source.test.ts
```

Expected: the new lifecycle assertions FAIL before production code changes.

- [ ] **Step 6: Close the provider races**

Add:

```ts
const providerMountedRef = useRef(true);
const liveSubscriptionAttemptsRef = useRef(
  new Map<string, { cancelled: boolean }>(),
);
```

`ensureLiveSeason()` creates an attempt before starting `getRemoteStore()`. After `subscribeToSeasonEvents()` resolves:

```ts
if (subscriptionAttempt.cancelled || !providerMountedRef.current) {
  unsubscribe();
  return;
}
liveUnsubscribersRef.current.set(seasonId, unsubscribe);
```

The catch branch returns immediately when the attempt is cancelled/unmounted. The scheduler effect returns `() => nextScheduler.dispose()`. Use this separate lifecycle effect so React Strict Mode setup -> cleanup -> setup restores the mounted flag correctly:

```ts
useEffect(() => {
  providerMountedRef.current = true;
  return () => {
    providerMountedRef.current = false;
    for (const attempt of liveSubscriptionAttemptsRef.current.values()) {
      attempt.cancelled = true;
    }
    liveSubscriptionAttemptsRef.current.clear();
    liveSubscribingRef.current.clear();
    for (const unsubscribe of liveUnsubscribersRef.current.values()) unsubscribe();
    liveUnsubscribersRef.current.clear();
  };
}, []);
```

- [ ] **Step 7: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonAutoSync.test.ts
node --test src/app/components/SeasonSyncProvider.source.test.ts
npm run test:rules
npx tsc --noEmit --pretty false
```

Expected: scheduler/provider tests and rule suite PASS; TypeScript exits `0`.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/seasonAutoSync.ts src/lib/seasonAutoSync.test.ts src/app/components/SeasonSyncProvider.tsx src/app/components/SeasonSyncProvider.source.test.ts
git commit -m "fix(sync): dispose provider lifecycle work"
```

---

## Task 4: Isolate Server Windows And Track Freshness Generations

**Files:**

- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.test.ts`
- Modify: `app/src/lib/seasonWorkspaceReadModel.ts`
- Modify: `app/src/lib/seasonWorkspaceReadModel.test.ts`
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/app/components/SeasonSyncProvider.source.test.ts`

**Interfaces:**

```ts
export type SeasonWorkspaceWindowRequestStatus =
  | 'idle'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'error';

export type SeasonWindowStaleReason =
  | 'manual'
  | 'mutation'
  | 'realtime'
  | 'ttl'
  | 'request-error'
  | null;

export interface SeasonWorkspaceWindowMetadata {
  generation: number;
  fetchedAt: number | null;
  dataVersion: number | null;
  serverHighWater: number | null;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  staleReason: SeasonWindowStaleReason;
  lastError: string | null;
}

export interface SeasonWorkspaceWindowSnapshot {
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
}

export interface CommitSeasonWindowResultInput {
  seasonId: string;
  windowKey: SeasonWindowKey;
  requestGeneration: number;
  operatorSessionEpoch: number;
  rows?: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
  fetchedAt: number;
  dataVersion: number;
  serverHighWater: number;
}

export interface ReplaceSeasonWindowInput {
  seasonId: string;
  season?: Season | null;
  rows?: ParsedRow[];
  records: FlightRecord[];
  modifications: FlightModification[] | Map<string, FlightModification>;
  syncMeta?: LocalSyncMeta | null;
  windowKey?: SeasonWindowKey;
  // Optional only during Tasks 4-7; Task 8 makes this required.
  operatorSessionEpoch?: number;
}

export interface PatchSeasonWorkspaceInput {
  seasonId: string;
  affectedIds?: string[];
  rows?: ParsedRow[];
  records?: FlightRecord[];
  deletedIds?: string[];
  modifications?: FlightModification[] | Map<string, FlightModification>;
  syncMeta?: LocalSyncMeta | null;
  windowKey?: SeasonWindowKey;
  // Optional only during Tasks 4-7; Task 8 makes this required.
  operatorSessionEpoch?: number;
}
```

Type ownership is explicit: Task 4 defines and exports `SeasonWorkspaceWindowRequestStatus`, `SeasonWindowStaleReason`, `SeasonWorkspaceWindowMetadata`, and `SeasonWorkspaceWindowSnapshot` from `seasonWorkspaceStore.ts`. Task 6 imports and re-exports the request-status type from its coordinator module; Settings and Audit import it from the store. Add these fields to each workspace:

```ts
windowSnapshots: Map<SeasonWindowKey, SeasonWorkspaceWindowSnapshot>;
windowMetadata: Map<SeasonWindowKey, SeasonWorkspaceWindowMetadata>;
recordServerHighWater: Map<string, number>;
modificationServerHighWater: Map<string, number>;
```

Add actions:

```ts
beginSeasonWindowRequest(seasonId, windowKey): number;
commitSeasonWindowResult(input: CommitSeasonWindowResultInput): boolean;
failSeasonWindowRequest(seasonId, windowKey, generation, error): void;
cancelSeasonWindowRequest(seasonId, windowKey, generation): void;
markSeasonWindowStale(
  seasonId: string,
  windowKey: SeasonWindowKey,
  reason: SeasonWindowStaleReason,
  operatorSessionEpoch: number,
): boolean;
markSeasonWorkspaceStale(
  seasonId: string,
  reason: SeasonWindowStaleReason,
  operatorSessionEpoch: number,
): boolean;
replaceSeasonWindow(input: ReplaceSeasonWindowInput): boolean;
patchSeasonWorkspace(input: PatchSeasonWorkspaceInput): boolean;
// Epoch is optional only during Tasks 4-7; Task 8 makes it required.
setSeasons(seasons: Season[], operatorSessionEpoch?: number): boolean;
setOperationalSettings(
  settings: OperationalSettings | null,
  operatorSessionEpoch?: number,
): boolean;
```

`beginSeasonWindowRequest()` returns the current generation captured by the request. Commit/fail/cancel are ignored when their generation no longer matches. Keep `updatedAt` only as a workspace mutation timestamp; it never decides window TTL.

- [ ] **Step 1: Write RED tests for independent TTL and isolated snapshots**

Commit two keys with `fetchedAt=1_000` and `5_000`, then read at `now=5_500`, `ttlMs=1_000`; assert the first is stale and the second fresh. This catches the current workspace-wide `updatedAt` bug.

Add an out-of-order cross-window test. Start with two generation-0 requests containing an overlapping leg. Commit the Gate key first at `serverHighWater=11` with `gate=7`, then commit an older Dashboard result at `serverHighWater=10` with `gate=1` plus one Dashboard-only leg. Assert:

- both window snapshots exist independently;
- `readWorkspaceWindowSnapshot()` for either key returns `gate=7` for the overlap;
- the Dashboard-only leg remains available;
- the older result did not lower `recordServerHighWater` or `modificationServerHighWater`;
- a newer result for one key never rewrites the other key's membership.

The read model overlays a normalized entity only when that entity's recorded high-water is greater than the window snapshot's `serverHighWater`; otherwise it returns the window's exact record.

- [ ] **Step 2: Write RED tests for invalidation generations**

Assert `markSeasonWindowStale()` increments only that window's generation. Assert `markSeasonWorkspaceStale()` increments every known window generation, including a window that does not contain the realtime `targetId`. Both require the current operator epoch and return `false` without writing for a stale token. Assert `patchSeasonWorkspace()` marks every cached window stale/increments generation when records are inserted, removed, or mutated; affected-ID membership alone is insufficient for a new record.

Capture `const staleEpoch = getOperatorSessionEpoch()`, advance the registry epoch, then attempt `commitSeasonWindowResult()`, `replaceSeasonWindow()`, `patchSeasonWorkspace()`, `setSeasons()`, and `setOperationalSettings()` with `staleEpoch`. Assert all five return `false` and leave the new operator's state byte-for-byte unchanged. Repeat with the current epoch and assert the writes succeed. This is the store-level backstop for an async page or transport that completes after auth cleanup.

Append a provider source test requiring `operatorSessionEpoch` to be captured when each subscription attempt is created, retained on that attempt, and checked inside the realtime callback. Require this order:

```ts
if (!isOperatorSessionEpochCurrent(subscriptionAttempt.operatorSessionEpoch)) {
  return;
}
const invalidated = useSeasonWorkspaceStore.getState().markSeasonWorkspaceStale(
  event.seasonId || seasonId,
  'realtime',
  subscriptionAttempt.operatorSessionEpoch,
);
if (!invalidated) return;
publishSeasonWorkspaceChanged({
```

This persists invalidation while every route is unmounted, before the non-replaying event bus notifies mounted listeners. Add source assertions that the callback cannot publish and the subscription promise's `catch` cannot patch failure state when the captured subscription epoch is stale; this closes the auth-cleanup-to-provider-cleanup race for both resolved events and rejected setup.

- [ ] **Step 3: Run RED**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts
node --test src/app/components/SeasonSyncProvider.source.test.ts
```

Expected: FAIL because isolated snapshots, per-entity high-water maps, generation/auth-epoch guards, workspace-wide invalidation, and provider persistence do not exist.

- [ ] **Step 4: Implement generation-guarded window commits**

`commitSeasonWindowResult()` first calls `isOperatorSessionEpochCurrent(input.operatorSessionEpoch)`, then compares `requestGeneration` with current metadata. Return `false` and change nothing if either guard fails. Otherwise:

1. replace only `windowSnapshots.get(windowKey)` and that key's membership;
2. merge each normalized record/modification only when `input.serverHighWater >=` its per-entity high-water;
3. add previously unseen entities even when another window has a higher unrelated cursor;
4. update the key metadata with the complete result's `dataVersion`/`serverHighWater`, set `ready`, clear stale/error, and retain its generation;
5. remove an entity from the normalized maps only when it is no longer referenced by any snapshot and its stored entity high-water is not newer than the replacing result.

Keep `replaceSeasonWindow()` as a compatibility wrapper while Tasks 7-8 still have legacy callers. When it receives `windowKey`, it populates the same isolated snapshot using the key's current generation and an inferred cursor from `syncMeta`; it may not bypass the monotonic entity merge. When `operatorSessionEpoch` is supplied, reject a stale epoch before cloning or mutating any state. The field remains optional only for the intermediate Task 4 commit and becomes required in Task 8. The coordinator must use only the guarded `commitSeasonWindowResult()` API.

`markSeasonWindowStale()` and `markSeasonWorkspaceStale()` require and verify the operator epoch before cloning state; both return whether invalidation committed. `patchSeasonWorkspace()` checks a supplied operator epoch first, updates matching entities inside known snapshots for immediate optimistic continuity, then marks all season windows stale and increments their generation exactly once. A newly inserted record is not guessed into unknown query windows; background revalidation decides membership. It returns `false` without writing when the supplied epoch is stale.

Apply the same supplied-epoch guard to `setSeasons()` and `setOperationalSettings()`. Their epoch parameter remains optional only until the six route migrations are complete; Task 8 makes it required so an old route loader cannot recreate cleared season/settings state.

Remove `staleWindowKeys` in this task. Confirm `rg -n "staleWindowKeys" src` has no production match before commit.

- [ ] **Step 5: Make both read functions snapshot-aware**

`readWorkspaceWindowSnapshot()` reads the isolated `windowSnapshots` entry even when stale. For every record/modification, overlay the normalized value only when its per-entity high-water is newer than the snapshot metadata cursor. `readCachedWorkspaceWindow()` calls that snapshot reader, then rejects only when the key metadata is missing, explicitly stale, or expired by its own `fetchedAt`.

- [ ] **Step 6: Persist realtime invalidation before publishing**

Import the operator-epoch helpers and store in `SeasonSyncProvider.tsx`. Capture the epoch in `subscriptionAttempt` before the subscription's first `await`. In the callback, reject a stale attempt, call `markSeasonWorkspaceStale(event.seasonId || seasonId, 'realtime', subscriptionAttempt.operatorSessionEpoch)`, and publish only when that action returns `true`. In the subscription setup `catch`, return before `patchSeasonState()` when that same epoch is stale. The provider does not fetch; it only persists invalidation and publishes the event. Mounted routes may revalidate immediately; unmounted routes discover the stale generation on their next mount.

- [ ] **Step 7: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts
node --test src/app/components/SeasonSyncProvider.source.test.ts
npx tsc --noEmit --pretty false
```

Expected: store/read-model/provider tests PASS and TypeScript exits `0`.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/seasonWorkspaceStore.ts src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.ts src/lib/seasonWorkspaceReadModel.test.ts src/app/components/SeasonSyncProvider.tsx src/app/components/SeasonSyncProvider.source.test.ts
git commit -m "refactor: isolate server windows by generation"
```

---

## Task 5: Make Server-Window Transport Abortable And Eliminate Fallback Fan-Out

**Files:**

- Modify: `app/src/lib/remoteStore.ts`
- Create: `app/src/lib/supabaseErrorPolicy.ts`
- Create: `app/src/lib/supabaseErrorPolicy.test.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Create: `app/src/lib/supabaseWorkspaceWindowTransport.source.test.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `app/src/lib/seasonalImportModeGuard.test.ts`

**Interfaces:**

```ts
export interface RemoteRequestOptions {
  signal?: AbortSignal;
  expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
}

getSeasonWorkspaceWindow?(
  input: RemoteSeasonWorkspaceWindowInput,
  options?: RemoteRequestOptions,
): Promise<RemoteSeasonWorkspaceWindowResult | null>;

export async function loadSeasonWorkspaceWindow(
  input: RemoteSeasonWorkspaceWindowInput,
  options?: RemoteRequestOptions,
): Promise<RemoteSeasonWorkspaceWindowResult | null>;
```

Keep `RemoteSeasonWorkspaceWindowInput` data-only. `AbortSignal` and an optional post-mutation snapshot expectation belong in the second request-options argument and cannot affect cache identity.

- [ ] **Step 1: Write failing transport/error-policy tests**

Create `supabaseErrorPolicy.test.ts` first. The only automatic compatibility transition is a confirmed missing RPC signature. A statement timeout or network failure must stop the logical load:

```ts
assert.equal(
  shouldUseLegacyWorkspaceWindowRpc(
    new Error('PGRST202: could not find the function in the schema cache'),
  ),
  true,
);
assert.equal(
  shouldUseLegacyWorkspaceWindowRpc(
    new Error('canceling statement due to statement timeout'),
  ),
  false,
);
assert.equal(
  shouldUseLegacyWorkspaceWindowRpc(new TypeError('Failed to fetch')),
  false,
);
```

Create `supabaseWorkspaceWindowTransport.source.test.ts` and isolate the current `getSeasonWorkspaceWindow` function body. Assert abort propagation now, and lock the final no-fan-out policy that Task 5A will bind to V2:

```ts
assert.match(body, /options: RemoteRequestOptions = \{\}/);
assert.match(body, /request = request\.abortSignal\(options\.signal\)/);
assert.match(body, /if \(options\.signal\?\.aborted\) throw error/);
assert.doesNotMatch(body, /loadSeasonWorkspaceWindowPaged\(/);
assert.doesNotMatch(body, /isStatementTimeoutError\(error\)[\s\S]*fallback/i);
assert.doesNotMatch(body, /isTransientFetchFailureError\(error\)/);
```

Update `seasonalImportModeGuard.test.ts` and `supabaseStore.source.test.ts` in this RED step: neither `57014` nor `Failed to fetch` may select a direct-table workspace fallback. Keep missing-signature classification for the single V2 -> V1 compatibility hop added in Task 5A.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/lib/supabaseErrorPolicy.test.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts src/lib/seasonalImportModeGuard.test.ts
```

Expected: FAIL because the policy module and remote request options do not exist, RPC queries do not receive a signal, and the current timeout catch still selects direct-table paging.

- [ ] **Step 3: Propagate request options through the remote boundary**

Move `isMissingRpcSignatureError()` and `isStatementTimeoutError()` from `supabaseStore.ts` into `supabaseErrorPolicy.ts`, export them for their existing non-workspace call sites, and implement:

```ts
export function shouldUseLegacyWorkspaceWindowRpc(
  error: unknown,
): boolean {
  return isMissingRpcSignatureError(error);
}
```

Update the `RemoteStore` interface, the exported `loadSeasonWorkspaceWindow()` wrapper, and Supabase implementation to accept `RemoteRequestOptions`. The non-Supabase wrapper fallback checks `options.signal?.throwIfAborted()` immediately before and after its snapshot await.

Build the transitional V1 RPC request before awaiting so abort works. Task 5A replaces this as the primary call; this intermediate commit is not releaseable by itself:

```ts
let request = client().rpc('get_season_schedule_allocation_window_v1', {
  p_season_id: input.seasonId,
  p_start_date: input.dateFrom ?? null,
  p_end_date: input.dateTo ?? null,
  p_resource_type: input.resourceType ?? 'all',
  p_limit: input.limit ?? null,
});
if (options.signal) request = request.abortSignal(options.signal);
const payload = assertOk(
  await request,
  'load server workspace window',
) as SeasonWorkspaceWindowRpc | null;
```

The catch order is mandatory and contains no automatic direct-table read:

```ts
if (options.signal?.aborted) throw error;
throw error;
```

- [ ] **Step 4: Keep generic row helpers bounded without making them an automatic workspace fallback**

Extend the helper with a fourth argument:

```ts
interface SelectAllRowsOptions {
  signal?: AbortSignal;
  limit?: number;
}

type SelectAllQuery<T> = FilterableQuery & {
  abortSignal(signal: AbortSignal): SelectAllQuery<T>;
  range(from: number, to: number): Promise<SupabaseResult<T[]>>;
};

async function selectAllRows<T>(
  table: string,
  filters: SelectFilter[] = [],
  action = `load ${table}`,
  options: SelectAllRowsOptions = {},
): Promise<T[]>;
```

For any existing explicit caller of `selectAllRows()`, calculate `remaining = requestedLimit - rows.length`, set `to = from + Math.min(SUPABASE_SELECT_PAGE_SIZE, remaining) - 1`, attach `.abortSignal(options.signal)` before `.range()`, and stop when `rows.length >= requestedLimit`. Do not request a page when the remaining limit is zero. This protects generic helpers but does not authorize `getSeasonWorkspaceWindow()` to call them after an RPC error.

Pass request options through the workspace-window versions of:

- `readRowsByInFilter()`;
- `hydrateFlightRecordRows()`;
- `readFlightRecordCounters()`;
- `readFlightRecordWindows()`;
- `readModificationRowsForDashboardSeason()`;
- `readModificationChildren()`;
- `readModificationsForDashboardSeason()`.

- [ ] **Step 5: Prove no workspace catch retains timeout/transient fallback**

Run `rg -n "isTransientFetchFailureError|loadSeasonWorkspaceWindowPaged|shouldUsePagedWorkspaceWindowFallback" src/lib/supabaseStore.ts`. A helper may remain only if another explicit non-workspace path needs it; the `getSeasonWorkspaceWindow` block must have no match. Also assert the block does not catch `isStatementTimeoutError()` to start a second transport.

- [ ] **Step 6: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/supabaseErrorPolicy.test.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts src/lib/seasonalImportModeGuard.test.ts
npx tsc --noEmit --pretty false
```

Expected: transport tests PASS, a workspace timeout/network error propagates without any second read path, and TypeScript exits `0`.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/remoteStore.ts src/lib/supabaseErrorPolicy.ts src/lib/supabaseErrorPolicy.test.ts src/lib/supabaseStore.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts src/lib/seasonalImportModeGuard.test.ts
git commit -m "fix: stop server-window fallback fan-out"
```

---

## Task 5A: Add A Versioned Keyset-Paged Workspace RPC And Logical Assembler

Task `5A` is an inserted stable dependency; existing Task 1-12 identifiers do not change. Task 5's current worktree changes and Tasks 5A-8 form one app release unit and must not be deployed independently.

**Files:**

- Create: `app/supabase/migrations/20260720090000_workspace_window_keyset_v2.sql`
- Create: `app/supabase/tests/workspace_window_keyset_v2.sql`
- Modify: `app/supabase/schema.sql`
- Modify: `docs/backend-supabase-schema-functions.md`
- Create: `app/src/lib/seasonWorkspaceWindowRpcV2Contract.ts`
- Create: `app/src/lib/seasonWorkspaceWindowRpcV2Contract.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseWorkspaceWindowTransport.source.test.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Create: `app/scripts/workspace-window-v2-load-test.mjs`
- Modify: `app/package.json`

- [ ] **Step 1: Write RED SQL contract tests**

Create rollback-safe fixtures that cover all of these behaviors:

1. More than one page of roots sharing the same effective date returns every root once in deterministic `(effectiveDate, rootId, rootKind)` order.
2. Empty/null `operational_date` falls back through `scheduled_date` and `date`; From/To bounds are inclusive.
3. Base active/deleted records, base modified/deleted modifications, and added modifications interleave across page boundaries without omissions or duplicates.
4. Every flight child belongs to a base root on that page; every modification child/added leg belongs to a modification on that page. No page contains whole-season children/modifications.
5. Page 1 returns `dataVersion` and `serverHighWater`. A mutation/import between pages returns `status='snapshot_changed'` with no row arrays when the caller passes the old token.
6. Every active import/schedule mutation fixture advances `dataVersion` or `serverHighWater` in the same transaction. A write path that changes schedule data without advancing either fence fails the test.
7. Invalid cursor groups, token groups, page sizes, resource types, or date ranges are rejected.
8. `PUBLIC`/`anon` cannot execute; an authenticated operator and `service_role` can execute under the intended RLS contract.

Run the SQL file against an isolated database with `ON_ERROR_STOP=1`; never point it at production.

- [ ] **Step 2: Add matching keyset indexes and the V2 RPC**

The migration and canonical schema must add exactly the indexes supported by `EXPLAIN` evidence:

```sql
create index if not exists season_flight_records_window_v2_idx
on public.season_flight_records (
  season_id,
  (coalesce(nullif(operational_date, ''), nullif(scheduled_date, ''), nullif(date, ''), '')),
  record_id
);

create index if not exists season_mod_added_legs_window_v2_idx
on public.season_modification_added_legs (
  season_id,
  (coalesce(nullif(operational_date, ''), nullif(scheduled_date, ''), nullif(date, ''), '')),
  leg_id
);
```

The child-table primary keys already support selected-root hydration. Do not add redundant child indexes without an `EXPLAIN (ANALYZE, BUFFERS)` showing they are needed.

Implement the exact SQL signature and response union from **Shared Public Contracts**. Select `page_size + 1` roots to derive `hasMore`, return at most `page_size`, and never use `OFFSET`. Resolve null From/To as no narrower filter so Detailed's default remains the full season. Do not calculate the page by sorting/materializing the entire season before applying the keyset limit.

- [ ] **Step 3: Write RED runtime-contract and assembler tests**

`seasonWorkspaceWindowRpcV2Contract.test.ts` must reject malformed status, snapshot token, cursor, row arrays, and child ownership. Add dependency-injected transport behavior tests that prove:

- three V2 pages are requested sequentially and maximum page concurrency is `1`;
- the assembler does not expose or commit pages 1-2 before page 3 completes;
- rows/children are accumulated by their real primary/composite keys and a duplicate page root fails instead of being silently accepted;
- `status='snapshot_changed'` discards all partial maps, waits injected full-jitter `250-1000ms`, and restarts at most once; a second mismatch follows the stale-snapshot warning path without another RPC;
- automatic realtime/TTL refresh uses injected full-jitter `100-300ms`, while manual Refresh/Fetch and post-mutation reconciliation have zero delay;
- after either delay, a changed abort/epoch/generation, a fresh snapshot, or an existing same-generation chain prevents a new request;
- an abort between pages prevents construction of the next request;
- `input.limit` applies to the total logical root count, not every page. Reaching the ceiling while `hasMore=true` throws `WINDOW_LIMIT_EXCEEDED` rather than returning a truncated Detailed snapshot;
- a missing V2 signature calls V1 at most once; V2/V1 `57014`, `Failed to fetch`, permission errors, and malformed payloads never call V1/direct-table fallback after a V2 request has begun;
- a successful final result carries the first page's `dataVersion` and `serverHighWater` and has the exact complete record/modification counts expected by the fixture.

Inject the delay/random policy rather than using real timers so restart and later cross-client de-synchronization tests remain deterministic.

Do not implement a shared page cache in the default path. If Task 12's seven-client gate fails, extend the migration/transport with an immutable cache keyed by `(seasonId, dateFrom, dateTo, resourceType, snapshot.dataVersion, snapshot.serverHighWater, pageCursor, pageSize)`. Never cache an unpinned/mutable page, and rerun SQL consistency plus seven-client completeness tests before release.

- [ ] **Step 4: Implement the strict parser and sequential logical assembler**

Keep page mechanics private to `supabaseStore.ts`; routes and the coordinator still call only `loadSeasonWorkspaceWindow(input, options)` and receive one `RemoteSeasonWorkspaceWindowResult` promise.

Implement the page transport through a dependency-injected factory (`client`, abort-aware `delay`, and `random`) so tests can prove the exact one-restart/full-jitter policy without real timers. The production singleton binds the Supabase client, the same abort-aware delay utility used by the coordinator, and `Math.random`.

The assembler must:

1. call `options.signal?.throwIfAborted()` before every physical page request;
2. request page 1 with no cursor and with `options.expectedSnapshot` when a mutation result supplied one; otherwise capture page 1's token, then pin every later request to the accepted token;
3. allow only one physical request at a time;
4. validate and merge each complete page into private maps;
5. discard all maps on `snapshot_changed`, wait full-jitter `250-1000ms`, re-check abort/epoch/generation/current snapshot, and perform at most one restart under the same logical promise;
6. stop only when `hasMore=false`, validate final ownership/count invariants, then map once to the current domain result;
7. return `cursor: { dataVersion, serverHighWater }` with the complete result;
8. never call a store action or expose partial domain arrays.

Use page size `500`; do not derive it from the UI's `limit`. Retain V1 only as an additive-rollout compatibility call selected by `shouldUseLegacyWorkspaceWindowRpc()` when the V2 signature is missing. Once any V2 page returns or fails for a reason other than missing signature, no heavier transport may begin.

- [ ] **Step 5: Add a representative load/plan harness**

Add the package command:

```json
{
  "test:workspace-window-v2-load": "node scripts/workspace-window-v2-load-test.mjs"
}
```

Against an isolated representative S26/W26 database, the harness records page count, root/record/modification counts, per-page latency, maximum page concurrency, duplicate IDs, and `57014`. It also captures `EXPLAIN (ANALYZE, BUFFERS)` for first, middle, and final cursors and fails on a whole-season sort/temp spill or a plan that ignores the matching V2 index.

Do not put connection strings or credentials in the script/artifact. Require explicit environment configuration and refuse known production database names/hosts.

- [ ] **Step 6: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceWindowRpcV2Contract.test.ts src/lib/supabaseErrorPolicy.test.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts
npm run test:workspace-window-v2-load
npx tsc --noEmit --pretty false
```

Expected: every test passes; representative full-season reads finish without `57014`, page concurrency is `1`, every page stays below 4 seconds, and the complete assembled IDs/counts match the direct baseline query.

- [ ] **Step 7: Commit the tracked V2 database/client boundary**

```powershell
git add supabase/migrations/20260720090000_workspace_window_keyset_v2.sql supabase/tests/workspace_window_keyset_v2.sql supabase/schema.sql ../docs/backend-supabase-schema-functions.md src/lib/seasonWorkspaceWindowRpcV2Contract.ts src/lib/seasonWorkspaceWindowRpcV2Contract.test.ts src/lib/remoteStore.ts src/lib/supabaseStore.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts scripts/workspace-window-v2-load-test.mjs package.json
git commit -m "feat: page server workspace windows by keyset"
```

Deploy the additive database migration before installing any client that calls V2. Verify the exact `pg_proc` signature, grants, authenticated smoke response, and index plans. Keep V1 and V2 in the database so the app can be rolled back during the compatibility window.

---

## Task 6: Add The Shared Server-Window Coordinator

**Files:**

- Create: `app/src/lib/seasonWorkspaceWindowCoordinator.ts`
- Create: `app/src/lib/seasonWorkspaceWindowCoordinator.test.ts`

**Interfaces:** Use the exact public contracts in **Shared Public Contracts**. Also export a dependency-injected factory for deterministic tests:

```ts
export function createSeasonWorkspaceWindowCoordinator(deps: {
  loadWindow: typeof loadSeasonWorkspaceWindow;
  store: Pick<typeof useSeasonWorkspaceStore, 'getState'>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  getOperatorSessionEpoch: () => number;
  isOperatorSessionEpochCurrent: (epoch: number) => boolean;
}): {
  read(
    input: ServerWorkspaceWindowInput,
    options?: { now?: number; ttlMs?: number },
  ): SeasonWorkspaceWindowState;
  revalidate(
    input: ServerWorkspaceWindowInput,
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      initiator?: 'automatic' | 'immediate';
    },
  ): Promise<CachedWorkspaceWindow | null>;
  revalidateAfterMutation(
    input: ServerWorkspaceWindowInput,
    options: {
      operatorSessionEpoch: number;
      generationAlreadyAdvanced: boolean;
      expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
    },
  ): Promise<CachedWorkspaceWindow | null>;
  clear(): void;
};
```

- [ ] **Step 1: Write RED tests for key identity and freshness**

Create `seasonWorkspaceWindowCoordinator.test.ts`. Test the exact key:

```ts
assert.equal(
  buildServerWorkspaceWindowKey({
    seasonId: 'season-1',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-23',
    resourceType: 'gate',
    limit: 500,
  }),
  'server-window-v2|season-1|2026-06-22|2026-06-23|gate|500',
);
```

Then seed explicit metadata and prove:

- missing -> `snapshot=null`, `freshness='missing'`, `shouldRevalidate=true`;
- fresh -> snapshot returned and `revalidate()` calls no loader unless forced;
- stale by TTL -> snapshot still returned, `freshness='stale'`, `staleReason='ttl'`;
- stale by mutation/realtime -> snapshot still returned with the stored reason.

- [ ] **Step 2: Write RED tests for single-flight and commit order**

Use a deferred logical loader. Call `revalidate(input)` seven times in the same tick, mixing normal calls and `force: true`, before resolving it. Assert strict promise identity across all seven plus one loader/page-chain call:

```ts
const calls = Array.from({ length: 7 }, (_, index) =>
  coordinator.revalidate(input, index % 2 === 0 ? undefined : { force: true }),
);
for (const call of calls.slice(1)) assert.strictEqual(call, calls[0]);
assert.equal(loadCalls, 1);
```

Instrument the Task 5A loader to represent three physical pages. Assert maximum page concurrency is `1`, its snapshot-change retry remains inside the same shared promise, and seven coordinator callers create neither seven page loops nor seven retry timers. If the retry delay elapses after the generation/epoch has changed or another complete snapshot has satisfied the generation, it must not issue another page.

Resolve with a record whose gate differs from the seeded stale record. After `await first`, assert Zustand already contains the new gate and metadata:

```ts
{
  generation: 0,
  fetchedAt: 2_000,
  dataVersion: 8,
  serverHighWater: 42,
  requestStatus: 'ready',
  staleReason: null,
  lastError: null,
}
```

Add a repeated-navigation case: after the first load, run three `read(input)` + `revalidate(input)` cycles and assert all render the same snapshot with the total loader count still `1`.

Add deterministic jitter cases. An automatic TTL/realtime call registers its in-flight entry immediately, samples one full-jitter delay in `100-300ms`, and only then starts the loader if epoch/generation/freshness still require it. Seven automatic callers share the same delayed promise and one random sample. A manual caller arriving during that delay promotes the existing entry to start immediately while preserving strict promise identity; it never creates a second chain. Manual calls and `revalidateAfterMutation()` have no initial jitter.

Add a mutation-during-flight case. Start generation 0, mark the season stale so the key becomes generation 1, then call `revalidate(input, { force: true })`. Assert the second call is a different promise and starts one generation-1 request. Resolve generation 0 first; it must not commit or clear staleness. Both callers ultimately observe the generation-1 result.

Test `revalidateAfterMutation()` in both modes. With `generationAlreadyAdvanced: false`, assert it calls `markSeasonWorkspaceStale(seasonId, 'mutation', operatorSessionEpoch)` exactly once before it starts the forced request. With `true`, seed the generation advance through a complete `patchSeasonWorkspace()` input containing `operatorSessionEpoch` and assert the helper does not mark again. In both cases the request uses the post-mutation generation and cannot join the pre-mutation promise. When supplied, `expectedSnapshot` is passed unchanged to the one logical loader so an import result fences page 1. A stale `operatorSessionEpoch` rejects with `AbortError` before marking or loading. Every coordinator test fixture must pass an explicit epoch to `patchSeasonWorkspace()`, `setSeasons()`, `setOperationalSettings()`, and both stale-mark actions even while Tasks 4-7 temporarily allow optional epochs elsewhere; Task 8's required-type change must not force a later repair to this test file.

Add operator-boundary cases with an epoch dependency controlled by the test. Start loaders in epoch 7, advance the dependency to epoch 8, and call `coordinator.clear()`. In one case resolve the old loader even if it ignores `AbortSignal`; in the other reject it with `Error('old operator network failure')`. Both shared promises must reject with an `AbortError`, no store commit/fail/cancel/error-metadata action may run against epoch 8, the old error must not escape to a new-operator UI, and no recursive revalidation starts. A later explicit epoch-8 call may start exactly one new request.

- [ ] **Step 3: Write RED tests for failures and explicit aborts**

Test that `Failed to fetch` rejects the current-generation refresh, records `lastError`, and leaves the old snapshot readable. A failure from an obsolete generation must not write an error into the current generation. Test that one aborted signalled consumer does not cancel a shared request still used by another consumer. If every consumer of an entry is explicitly signalled and all signals abort, the coordinator aborts its internal remote controller and returns request state to `ready`/`idle` without recording an error.

Signals are cancellation leases for the shared request, not per-caller promise cancellation. All callers receive the same promise. A caller whose lease aborts while another lease remains will still receive the eventual shared result; its abort only removes permission to keep the remote request alive. An unsignalled consumer is permanently non-abortable for that entry. This is how normal page loads continue warming the cache after route unmount.

- [ ] **Step 4: Run RED**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceWindowCoordinator.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 5: Implement the coordinator**

Implementation invariants:

- `read()` is synchronous and never starts I/O.
- `revalidate()` and its default wrapper are plain promise-returning functions, not `async` wrappers; returning `existing.promise` must preserve strict promise identity for single-flight callers.
- `inFlight` is a `Map<string, Entry>` keyed by the template string `${windowKey}@${generation}`.
- One entry owns the complete Task 5A page chain, not an individual page. Page cursors/retries never create another coordinator entry or promise.
- The default `initiator` is `automatic`. Create/register the entry before waiting full-jitter `100-300ms` so same-app consumers coalesce during the delay. Re-check abort, operator epoch, generation, current freshness, and entry identity after the wait. An `initiator: 'immediate'` caller (manual action or explicit mutation reconciliation) promotes an already-delayed entry to immediate start instead of waiting or starting another promise.
- Check `inFlight` for the current generation before creating a request, including for `force: true`. An obsolete generation never captures a post-mutation caller.
- Check fresh short-circuit after the existing-entry check.
- Capture `operatorSessionEpoch = getOperatorSessionEpoch()` at the public `revalidate()` entry, before `beginSeasonWindowRequest()`, the loader, or any `await`. Store it on the in-flight entry and pass the same token through an internal `revalidateForEpoch()` helper so a generation retry never silently adopts a newer operator.
- Capture the generation returned by `beginSeasonWindowRequest()` before calling the loader.
- `revalidateAfterMutation()` verifies its caller-captured epoch. If `generationAlreadyAdvanced` is false, it calls `markSeasonWorkspaceStale(input.seasonId, 'mutation', operatorSessionEpoch)` once and throws `AbortError` if the guarded action returns `false`; when true it never marks because `patchSeasonWorkspace()` already did. It then calls `revalidateForEpoch(input, { force: true, initiator: 'immediate', expectedSnapshot }, operatorSessionEpoch)`. Route mutation code must use this API instead of a naked forced revalidation.
- Do not publish `SeasonWorkspaceChanged` when a server window arrives; that event means invalidation and publishing here would cause a refresh loop.
- If `sourceRows` is empty, omit `rows` from the replace input so an existing parsed-row cache is not erased. Seasonal presentation can derive from returned records.
- Treat a null server result as `Error('Server workspace window is unavailable.')`; preserve any existing snapshot.
- After the loader resolves, call `entry.controller.signal.throwIfAborted()` and verify `isOperatorSessionEpochCurrent(entry.operatorSessionEpoch)` before committing. If the epoch is stale, throw an `AbortError` and do not call store commit/fail/cancel or recursively revalidate; auth cleanup has already cleared the old workspace and the old caller must not start work for the new operator.
- Commit before the shared promise resolves:

```ts
const committedCurrentGeneration = store.getState().commitSeasonWindowResult({
  seasonId: input.seasonId,
  windowKey,
  requestGeneration: entry.generation,
  operatorSessionEpoch: entry.operatorSessionEpoch,
  rows: result.sourceRows.length > 0 ? result.sourceRows : undefined,
  records: result.records,
  modifications: result.modifications,
  syncMeta: result.syncMeta,
  fetchedAt: now(),
  dataVersion: result.cursor.dataVersion,
  serverHighWater: result.cursor.serverHighWater,
});

if (!committedCurrentGeneration) {
  if (!isOperatorSessionEpochCurrent(entry.operatorSessionEpoch)) {
    throw new DOMException('Operator session changed.', 'AbortError');
  }
  return revalidateForEpoch(input, { force: true, initiator: 'immediate' }, entry.operatorSessionEpoch);
}

const committed = readWorkspaceWindowSnapshot(
  store.getState().workspaces[input.seasonId],
  windowKey,
);
if (!committed) {
  throw new Error(`Workspace window ${windowKey} was not committed to the store.`);
}
return committed;
```

In `catch`, check the captured operator epoch before classifying or publishing the loader error. If stale, normalize both a resolved-late and rejected-late transport to `new DOMException('Operator session changed.', 'AbortError')`; do not log it, call fail/cancel, or expose the old message. On a current-epoch non-abort error, call `failSeasonWindowRequest()` with the captured generation; the guarded store action ignores obsolete generations. On a current-epoch internal abort, call the generation-guarded `cancelSeasonWindowRequest()`. In `finally`, remove only the `${windowKey}@${generation}` entry that still points to this request.

- [ ] **Step 6: Bind the default singleton exports**

Instantiate the factory with `loadSeasonWorkspaceWindow`, `useSeasonWorkspaceStore`, `Date.now`, an abort-aware delay, `Math.random`, `getOperatorSessionEpoch`, and `isOperatorSessionEpochCurrent`, then implement the four public wrapper functions plus `clearSeasonWorkspaceWindowCoordinator()`. `clear()` aborts every in-flight controller, resolves/cancels pending jitter gates, clears the map, and is registered under the stable key `season-window-coordinator` with the operator-session cache registry created in Task 2. Do not expose page-owned maps or make each page instantiate its own coordinator.

- [ ] **Step 7: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/seasonWorkspaceWindowCoordinator.test.ts src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts
npx tsc --noEmit --pretty false
```

Expected: all coordinator/store/read-model tests PASS and TypeScript exits `0`.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/seasonWorkspaceWindowCoordinator.ts src/lib/seasonWorkspaceWindowCoordinator.test.ts
git commit -m "feat: coordinate server workspace revalidation"
```

---

## Task 7: Migrate Seasonal And Detailed To Snapshot-First SWR

**Files:**

- Create: `app/src/app/serverWindowSWRRoutes.source.test.ts`
- Create: `app/src/app/postMutationWindowGeneration.source.test.ts`
- Create: `app/src/app/operatorSessionEpoch.source.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/nativeLocalSeasonStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `app/src/app/SeasonalSchedulePage.tsx`
- Modify: `app/src/app/detailed/page.tsx`
- Modify: `app/src/app/seasonalDetailedDraftSave.source.test.ts`
- Modify: `app/src/app/syncFetchBoundary.source.test.ts`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`

**Interfaces:**

```ts
function buildSeasonalWindowInput(input: {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}): ServerWorkspaceWindowInput;

function buildDetailedWindowInput(input: {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}): ServerWorkspaceWindowInput;
```

Both return `resourceType: 'schedule'` and `limit: 100000`. That limit is a ceiling for the complete logical assembly, never an RPC page size. Detailed with blank From/To still sends `dateFrom=null`/`dateTo=null`; if `hasMore=true` at the ceiling, fail visibly with `WINDOW_LIMIT_EXCEEDED` and stop the release rather than silently truncating the season.

When this task executes with Import V2 Task 6, `RemoteSeasonalImportInput` also carries `clientId: string`, obtained from the same `getOrCreateSeasonClientId()` identity used by `SeasonSyncProvider`. The import batch persists it and the one committed change event uses `client_id=clientId`, `op_id=requestId`.

Import the `OperatorSessionRemoteOptions` type created in Task 2 for guarded remote reads/writes. Apply it to these native mutation signatures:

```ts
export async function runNativeLocalModificationBatchDeltaResult(
  seasonId: string,
  mods: FlightModification[],
  history?: Pick<
    ModHistoryEntry,
    'id' | 'timestamp' | 'description' | 'scheduleNotification'
  >,
  source: NativeLocalModificationSource = 'allocation',
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<NativeLocalModificationBatchDeltaResult | null>;

export async function runNativeScheduleMutation(
  seasonId: string,
  records: FlightRecord[],
  deletedIds: string[] = [],
  mods: FlightModification[] = [],
  history?: Pick<
    ModHistoryEntry,
    'id' | 'timestamp' | 'description' | 'scheduleNotification'
  >,
  sourceRows: ParsedRow[] = [],
  source: NativeScheduleMutationSource = 'seasonal',
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<LocalSyncMeta | null>;

// RemoteStore methods that can issue more than one sequential server request.
applySeasonalImportRemote?(
  input: RemoteSeasonalImportInput,
  options?: OperatorSessionCheckpointOptions,
): Promise<RemoteSeasonalImportResult>;

updateSeason(
  id: string,
  data: Partial<Season>,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

deleteSeason(
  id: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

clearSeasonBaseline(
  seasonId: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

batchWriteFlightRecords(
  seasonId: string,
  records: FlightRecord[],
  onProgress?: (written: number, total: number) => void,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;
```

- [ ] **Step 1: Write the route source regression**

For all six season-window pages, assert imports/usages of `buildServerWorkspaceWindowKey`, `readSeasonWorkspaceWindowState`, and `revalidateSeasonWorkspaceWindow`, and assert no use of `buildWorkspaceWindowCacheKey` or `readCachedWorkspaceWindow` remains after all route tasks finish. Implement one explicitly named `node:test` case per route; the Task 7 cases must start with `Seasonal` and `Detailed` so `--test-name-pattern="Seasonal|Detailed"` cannot silently skip a loop-wrapped generic test. Require `revalidateSeasonWorkspaceAfterMutation` only in the mutation-capable Seasonal, Detailed, Daily, Check-in, and Gate routes. Dashboard has no server mutation path, so assert it has zero post-mutation-helper calls instead of inventing an unused import.

For Seasonal, isolate `buildSeasonalWindowInput()` and assert it contains `seasonId`, `dateFrom`, `dateTo`, `resourceType`, and `limit`, but not `flight`, `route`, `airline`, `aircraft`, or sort state. Do the equivalent for Detailed and `flightNumberFilter`.

Count direct `loadSeasonWorkspaceWindow()` calls. Completion contract: every route page has zero. Interactive reads go through the coordinator; the 2026-07-18 plan's one-shot export uses its distinct `get_seasonal_export_snapshot_v2` artifact RPC and must not start another workspace-window page chain.

Update only the Detailed branch of `syncFetchBoundary.source.test.ts` to require `revalidateSeasonWorkspaceWindow(windowInput, { force: true, initiator: 'immediate' })`; keep Seasonal on `loadSeasonRows(activeSeason, true, { requestId, seasonId: activeSeason.id, windowKey })` and leave the four not-yet-migrated routes on their current expectation until Task 8.

Refactor `onlineFirstRoutes.source.test.ts` into explicit `coordinatedRouteFiles` (Seasonal and Detailed) and `legacyRouteFiles` (the four Task 8 routes). Preserve every existing assertion: apply the new snapshot/generation/coordinator expectations to the coordinated table and retain the old direct-load assertions only for the legacy table. This keeps the existing regression file green after each migration commit rather than deferring breakage to Task 11.

Create `postMutationWindowGeneration.source.test.ts` with named Seasonal/Detailed cases. For the Seasonal import block, slice from `await applySeasonalImportRemote(` through its coordinator refresh and require:

```ts
revalidateSeasonWorkspaceAfterMutation(windowInput, {
  operatorSessionEpoch,
  generationAlreadyAdvanced: false,
  expectedSnapshot: {
    dataVersion: importResult.dataVersion,
    serverHighWater: importResult.serverHighWater,
  },
});
```

This is deliberately `false`: import has completed a server mutation but has not called `patchSeasonWorkspace()`, so the coordinator helper must advance the season generation before starting the forced read. The import result fences page 1 to the committed version/high-water; an already-obsolete token follows Task 5A's discard/restart rule. For every other post-mutation refresh in Seasonal/Detailed, require an earlier `patchSeasonWorkspace()` input containing `operatorSessionEpoch` in the same handler/path and then `generationAlreadyAdvanced: true`. Require zero direct `revalidateSeasonWorkspaceWindow(windowInput, { force: true })` calls inside mutation handlers; naked forced calls are reserved for user Refresh/Fetch.

Create `operatorSessionEpoch.source.test.ts`. For Seasonal/Detailed, assert imports of `getOperatorSessionEpoch` and `isOperatorSessionEpochCurrent`; inspect every `patchSeasonWorkspace({` and compatibility `replaceSeasonWindow({` object and require an `operatorSessionEpoch` property, and require the captured token as the second argument of `setSeasons()`/`setOperationalSettings()`. For each async load/mutation handler that writes `setCachedSeasons`, `setCachedOperationalSettings`, `setCachedSeasonData`, `patchCachedSeasonData`, `setSeasons`, `setOperationalSettings`, `patchSeasonWorkspace`, `replaceSeasonWindow`, or publishes a workspace event after an `await`, use string-index helpers to prove `const operatorSessionEpoch = getOperatorSessionEpoch()` occurs before the handler's first `await` and an `isOperatorSessionEpochCurrent(operatorSessionEpoch)` guard occurs after the last relevant `await` and before its first shared cache/store/event write. Inspect each handler's `catch` block too: the same guard must occur before warning/error state, alert, event publication, or logging so a rejected old request is discarded. Use explicit handler start/end markers in a table so a renamed or newly unguarded path fails loudly rather than being skipped.

Read `remoteStore.ts`, `nativeLocalSeasonStore.ts`, and `supabaseStore.ts` from `operatorSessionEpoch.source.test.ts`. Require `getSeasons()`, `applySeasonalImportRemote()`, `applySeasonServerMutationV1()`, `getCurrentRemoteActor()`, `createSeason()`, `updateSeason()`, `deleteSeason()`, `findSeasonByCode()`, `clearSeasonBaseline()`, `batchWriteFlightRecords()`, and `verifySeasonImportCounts()` to accept `OperatorSessionRemoteOptions` and delegate lazy store acquisition plus the remote method to `runOperatorSessionResourceOperation()`. Forbid nested forms such as `await (await getRemoteStore()).method()` in guarded wrappers. Require the server-authoritative branches of `runNativeScheduleMutation()` and `runNativeLocalModificationBatchDeltaResult()` to capture/accept an epoch before their first await and pass it through `applyServerAuthoritativeOperations()` to `applySeasonServerMutationV1()`. Add a delayed-acquire source/behavior fixture proving an epoch advance after `getRemoteStore()` starts but before it resolves prevents the remote mutation method from being invoked.

Use method-body slicing in `supabaseStore.source.test.ts`, not file-wide token counts, to require an `assertOperatorSessionCurrent()` checkpoint immediately before every sequential server request in `applySeasonalImportRemote()`, `updateSeason()`, `deleteSeason()`, `clearSeasonBaseline()`, and every outer or helper-level request/chunk in `batchWriteFlightRecords()`. For Import V2, check immediately before stage, after stage and immediately before commit, and after commit before returning/progress. Require no `callSeasonalImportRpcRawPayload()`, V1 signature loop, or raw PostgREST fallback. For the remaining repair methods: `updateSeason()` checks before its read and update; `deleteSeason()` passes the same checkpoint options into `clearSeasonBaseline()` and checks again before deleting the season; `clearSeasonBaseline()` checks before each of its four table clears; and `batchWriteFlightRecords()` checks before each chunk upsert, counter clear/upsert, and window clear/upsert. Thread checkpoint options through the V2 stage/commit helpers, `deleteSeasonOwnedRows()`, `upsertRows()`, `writeFlightRecordCounters()`, and `writeFlightRecordWindows()` rather than relying on one check at the public method boundary. Task 2's delayed internal-step behavior test proves that a stale checkpoint prevents the next request from being issued; these source slices bind that behavior to the real Supabase implementation.

Lock the helper signatures and positional arguments so the new options cannot overwrite existing progress/column parameters:

```ts
async function upsertRows(
  table: string,
  rows: JsonRecord[],
  onConflict: string,
  onProgress?: (written: number, total: number) => void,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function deleteSeasonOwnedRows(
  table: string,
  seasonId: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function writeFlightRecordCounters(
  seasonId: string,
  records: FlightRecord[],
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function writeFlightRecordWindows(
  seasonId: string,
  records: FlightRecord[],
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;
```

For guarded calls to `upsertRows()` that do not use its existing progress callback, pass `undefined` in argument four and checkpoint options in argument five. The source test must assert those exact positions in the flight-record and nested counter/window paths.

- [ ] **Step 2: Run RED for the two target routes**

```powershell
node --experimental-strip-types --test --test-name-pattern="Seasonal|Detailed" src/app/serverWindowSWRRoutes.source.test.ts
node --experimental-strip-types --test --test-name-pattern="Seasonal|Detailed" src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --experimental-strip-types --test src/app/syncFetchBoundary.source.test.ts
node --experimental-strip-types --test src/app/onlineFirstRoutes.source.test.ts
```

Expected: FAIL because both pages still use route/UI cache keys and page-owned server reads, and the Supabase multi-request paths do not yet carry operator-session checkpoints.

- [ ] **Step 3: Make Seasonal initialize synchronously from a server snapshot**

Replace `buildSeasonalWindowKey()` with `buildSeasonalWindowInput()`. Move the filter/session-state initialization before data state. Add `readInitialSeasonalRouteState()` that resolves cached seasons and active season, builds the canonical input, then reads `readSeasonWorkspaceWindowState(input).snapshot`.

Initialize data and loading from that result:

```ts
const [rows, setRows] = useState(() => initialState?.rows ?? []);
const [flightRecords, setFlightRecords] = useState(
  () => initialState?.records ?? [],
);
const [loading, setLoading] = useState(() => initialState === null);
```

When `snapshot.rows` is empty, derive the Seasonal presentation rows with the page's existing `buildPatternRowsFromRecords(snapshot.records, snapshot.modifications)` helper instead of querying SQLite or clearing the table.

- [ ] **Step 4: Replace Seasonal mount/refresh reads**

The shared load function must follow this exact order:

```ts
const windowState = readSeasonWorkspaceWindowState(windowInput);
if (windowState.snapshot) {
  applySnapshot(windowState.snapshot);
  setLoading(false);
}
if (!force && !windowState.shouldRevalidate) return windowState.snapshot;

const refreshed = await revalidateSeasonWorkspaceWindow(windowInput, { force });
if (!requestIsCurrent()) return refreshed;
if (refreshed) applySnapshot(refreshed);
return refreshed;
```

Do not pass a signal from the page cleanup. Cleanup only makes `requestIsCurrent()` false. Manual Fetch uses `{ force: true, initiator: 'immediate' }`; post-mutation reconciliation uses the immediate `revalidateSeasonWorkspaceAfterMutation()` path with the epoch captured at the start of the mutation. Full-season export remains a distinct one-shot artifact read through `get_seasonal_export_snapshot_v2`; it never calls the workspace transport or replaces the interactive window.

Capture `operatorSessionEpoch` before the first `await` in every Seasonal async load/mutation operation. After each awaited remote mutation/read, check `isOperatorSessionEpochCurrent(operatorSessionEpoch)` before any module-cache, Zustand, publish, or follow-up network action. At the top of each corresponding `catch`, perform the same check before alerting, logging, or setting warning/error state. Pass the token to every `patchSeasonWorkspace()`/remaining compatibility `replaceSeasonWindow()` input and every `setSeasons()`/`setOperationalSettings()` call. A stale resolution or rejection returns without writing and without using the new operator's epoch.

Guard callbacks invoked while a remote promise is still pending as well. In Seasonal import's `onProgress`, return unless `isOperatorSessionEpochCurrent(operatorSessionEpoch)` before calling `setUploadProgress`; add this callback to `operatorSessionEpoch.source.test.ts` so an old RPC cannot update the new operator's presentation between the remote call and its final await continuation.

Pass `{ operatorSessionEpoch }` to `findSeasonByCode()`, `getCurrentRemoteActor()`, `applySeasonalImportRemote()`, `runNativeScheduleMutation()`, and `runNativeLocalModificationBatchDeltaResult()` wherever Seasonal/Detailed invoke them. In `remoteStore.ts`, implement the guarded wrappers with these exact boundaries:

```ts
export function applySeasonalImportRemote(
  input: RemoteSeasonalImportInput,
  options: OperatorSessionRemoteOptions,
): Promise<RemoteSeasonalImportResult> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => {
      if (!store.applySeasonalImportRemote) {
        throw new Error('Server-side seasonal import RPC is unavailable for the configured backend.');
      }
      return store.applySeasonalImportRemote(input, {
        assertOperatorSessionCurrent,
      });
    },
  });
}

export function applySeasonServerMutationV1(
  payload: ServerSeasonMutationPayload,
  options: OperatorSessionRemoteOptions,
): Promise<ServerSeasonMutationResult> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => {
      if (!store.applySeasonServerMutationV1) {
        throw new Error('Server-authoritative mutation RPC is not available.');
      }
      return store.applySeasonServerMutationV1(payload);
    },
  });
}

export function getCurrentRemoteActor(
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<RemoteActor | null> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getCurrentRemoteActor(),
  });
}

export function getSeasons(
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<Season[]> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getSeasons(),
  });
}

export function createSeason(
  season: Omit<Season, 'id'>,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<string> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.createSeason(season),
  });
}

export function updateSeason(
  id: string,
  data: Partial<Season>,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<void> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.updateSeason(
      id,
      data,
      { assertOperatorSessionCurrent },
    ),
  });
}

export function deleteSeason(
  id: string,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<void> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.deleteSeason(
      id,
      { assertOperatorSessionCurrent },
    ),
  });
}

export function findSeasonByCode(
  code: string,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<Season | null> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.findSeasonByCode(code),
  });
}

export function clearSeasonBaseline(
  seasonId: string,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<void> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.clearSeasonBaseline(
      seasonId,
      { assertOperatorSessionCurrent },
    ),
  });
}

export function batchWriteFlightRecords(
  seasonId: string,
  records: FlightRecord[],
  onProgress: ((written: number, total: number) => void) | undefined = undefined,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<void> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.batchWriteFlightRecords(
      seasonId,
      records,
      onProgress,
      { assertOperatorSessionCurrent },
    ),
  });
}

export function verifySeasonImportCounts(
  seasonId: string,
  expected: RemoteSeasonImportCounts,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<RemoteSeasonImportCounts> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.verifySeasonImportCounts
      ? store.verifySeasonImportCounts(seasonId, expected)
      : Promise.resolve(expected),
  });
}
```

The helper's post-acquire check occurs before `execute`, so an operation from the old page cannot issue its first mutation using the newly authenticated Supabase session. For multi-request methods, the closure passed as `OperatorSessionCheckpointOptions` must also run synchronously immediately before each later request or chunk. A request already sent when the epoch advances may settle, but no subsequent request may be constructed under the new session and no stale result/error may commit. The default options on the season/repair wrappers preserve intermediate callers while Tasks 8-9 migrate them; migrated async handlers must pass their earlier captured token explicitly. In `nativeLocalSeasonStore.ts`, thread the epoch through `applyServerAuthoritativeOperations()`; the server-authoritative branch may not recapture it after an await.

Implement the Supabase checkpoints with a small local helper such as `options?.assertOperatorSessionCurrent()`, called at each boundary listed by the source test. Pass the same options from the guarded wrapper into `store.applySeasonalImportRemote()` and through both V2 stage and commit helpers; Import V2 has no V1/raw fallback. Pass the same options through the other nested helpers and from `deleteSeason()` into `clearSeasonBaseline()`; checking only once before a nested call is insufficient. Keep the options optional on `RemoteStore` so the non-Tauri legacy backend remains structurally compatible, but acceptance is against the Supabase server-first path and this does not authorize a Firestore or SQLite fallback.

In the import flow specifically, immediately after `applySeasonalImportRemote()` succeeds and the epoch guard passes, call:

```ts
const refreshedWindow = await revalidateSeasonWorkspaceAfterMutation(windowInput, {
  operatorSessionEpoch,
  generationAlreadyAdvanced: false,
  expectedSnapshot: {
    dataVersion: importResult.dataVersion,
    serverHighWater: importResult.serverHighWater,
  },
});
```

Do not call `markSeasonWorkspaceStale()` separately around this helper and do not retain the direct `loadSeasonWorkspaceWindow()`/page-owned `replaceSeasonWindow()`/`applySeasonData()` import refresh or publish another refresh-triggering workspace event. The helper performs the one required generation advance before the forced coordinator request. Use the import batch's shared `clientId`/request ID so `SeasonSyncProvider` ignores the initiating client's realtime echo; other clients each persist one invalidation.

- [ ] **Step 5: Migrate Detailed with the same rules**

Build its input from `buildDetailedScheduleQueryWindow()` and omit `flightNumberFilter`. Add `readInitialDetailedRouteState()`, seed all legs/visible legs/modifications/sync summary before the first render, and derive blocking loading as `snapshot === null`.

On stale refresh failure, preserve the current calendar and surface a non-blocking warning. On missing refresh failure, keep the existing blocking error behavior. Manual refresh uses `{ force: true, initiator: 'immediate' }`; post-mutation reconciliation uses `revalidateSeasonWorkspaceAfterMutation()`. If its optimistic `patchSeasonWorkspace()` already ran, pass `generationAlreadyAdvanced: true` and do not mark again. Pass the handler-captured operator epoch to every shared write, including the second argument of `setSeasons()`. The page no longer calls `replaceSeasonWindow()` after a coordinator result because the coordinator has already committed.

- [ ] **Step 6: Run focused GREEN checks**

```powershell
node --experimental-strip-types --test --test-name-pattern="Seasonal|Detailed" src/app/serverWindowSWRRoutes.source.test.ts
node --experimental-strip-types --test --test-name-pattern="Seasonal|Detailed" src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts
node --experimental-strip-types --test src/lib/detailedScheduleState.test.ts src/app/seasonalDetailedDraftSave.source.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --experimental-strip-types --test src/app/syncFetchBoundary.source.test.ts
node --experimental-strip-types --test src/app/onlineFirstRoutes.source.test.ts
npx tsc --noEmit --pretty false
```

Expected: the Seasonal/Detailed source cases and existing draft/state regressions PASS. The full source file may still fail for routes intentionally scheduled for Task 8.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/remoteStore.ts src/lib/nativeLocalSeasonStore.ts src/lib/supabaseStore.ts src/lib/supabaseStore.source.test.ts src/app/SeasonalSchedulePage.tsx src/app/detailed/page.tsx src/app/serverWindowSWRRoutes.source.test.ts src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts src/app/seasonalDetailedDraftSave.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts
git commit -m "fix: render schedule routes from server snapshots"
```

---

## Task 8: Migrate Daily, Check-in, Gate, And Dashboard

**Files:**

- Modify: `app/src/app/daily/page.tsx`
- Modify: `app/src/app/checkin/page.tsx`
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/src/app/dashboard/page.tsx`
- Modify: `app/src/app/serverWindowSWRRoutes.source.test.ts`
- Modify: `app/src/app/postMutationWindowGeneration.source.test.ts`
- Modify: `app/src/app/operatorSessionEpoch.source.test.ts`
- Modify: `app/src/app/components/AppRouteCache.source.test.ts`
- Modify: `app/src/app/syncFetchBoundary.source.test.ts`
- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: `app/src/lib/seasonWorkspaceStore.test.ts`
- Modify: `app/src/lib/seasonWorkspaceReadModel.test.ts`

- [ ] **Step 1: Run RED for the four remaining routes**

First update the four remaining branches of `syncFetchBoundary.source.test.ts`: keep Seasonal's `loadSeasonRows(activeSeason, true, { requestId, seasonId: activeSeason.id, windowKey })` and Detailed's Task 7 coordinator contract; for Daily, Check-in, Gate, and Dashboard require `revalidateSeasonWorkspaceWindow(windowInput, { force: true, initiator: 'immediate' })` inside the manual `fetchServerData`, and continue forbidding `syncNow`, `fetchUpdatesNow`, and native pending-sync calls.

Move Daily, Check-in, Gate, and Dashboard from `legacyRouteFiles` to `coordinatedRouteFiles` in `onlineFirstRoutes.source.test.ts`, then remove the empty legacy-only branches. Add explicitly named `Daily`, `Check-in`, `Gate`, and `Dashboard` cases to `serverWindowSWRRoutes.source.test.ts`; do not collapse the six route contracts back into one unnamed/generic loop test. The updated assertions must cover all of the original behaviors listed in Task 11's contract audit.

Extend `postMutationWindowGeneration.source.test.ts` with explicit Daily, Check-in, and Gate mutation-handler tables. Every post-mutation helper call must be paired with exactly one earlier generation advance on that path: `generationAlreadyAdvanced: true` only after a guarded `patchSeasonWorkspace()`, otherwise `false` so the helper marks once. Add a Dashboard case proving it uses standard revalidation and has zero post-mutation-helper calls. Extend `operatorSessionEpoch.source.test.ts` across all four routes; every shared write after an async boundary must use the epoch captured before that handler's first `await` and must be preceded by a current-epoch guard. Require `{ operatorSessionEpoch }` on every Daily/Check-in/Gate call to `runNativeScheduleMutation()` or `runNativeLocalModificationBatchDeltaResult()` so the Task 7 remote-operation guard receives the originating handler token.

```powershell
node --experimental-strip-types --test src/app/serverWindowSWRRoutes.source.test.ts src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts
```

Expected: the Seasonal/Detailed cases PASS from Task 7 and the Daily, Check-in, Gate, and Dashboard cases FAIL because those routes still use page-owned keys/readers.

- [ ] **Step 2: Replace route-local keys with canonical inputs**

Use these exact query dimensions:

```ts
// Daily
{ seasonId, dateFrom: fromDateTime.slice(0, 10), dateTo: toDateTime.slice(0, 10), resourceType: 'schedule', limit: 100000 }

// Check-in
{ seasonId, dateFrom: fromDateTime.slice(0, 10), dateTo: toDateTime.slice(0, 10), resourceType: 'checkin', limit: 100000 }

// Gate
{ seasonId, dateFrom: fromDateTime.slice(0, 10), dateTo: toDateTime.slice(0, 10), resourceType: 'gate', limit: 100000 }

// Dashboard
{ seasonId, resourceType: 'schedule', limit: 100000 }
```

Every stored/ref key comes from `buildServerWorkspaceWindowKey(input)`.

All `limit: 100000` values above are logical-window ceilings. Dashboard, like Detailed, is a full-season logical read and must use the same Task 5A sequential keyset assembler. No route may own a page cursor, page loop, retry, V1 fallback, or direct-table fallback; those remain private transport details behind the one coordinator promise.

- [ ] **Step 3: Make `readInitialDailyRouteState`, `readInitialCheckInRouteState`, `readInitialGateRouteState`, and `readInitialDashboardRouteState` snapshot-first**

Replace strict `readCachedWorkspaceWindow()` calls with:

```ts
const windowState = readSeasonWorkspaceWindowState(windowInput);
const cachedWindow = windowState.snapshot;
```

Do not reject the initial state merely because freshness is stale. Preserve each route's existing settings/seasons requirements, selected item, scroll state, and optimistic overlays.

- [ ] **Step 4: Replace every normal, manual, post-mutation, and AI workspace window read**

For each route:

1. Apply a snapshot before setting any loading state.
2. Set blocking loading only when `snapshot === null`.
3. Return without I/O when fresh.
4. Revalidate stale data in the background.
5. Use `{ force: true, initiator: 'immediate' }` only for user Refresh/Fetch, import conflict reads, and Dashboard AI workspace reads. Use `revalidateSeasonWorkspaceAfterMutation()` for immediate post-mutation reconciliation, passing the operation's captured epoch and the truthful `generationAlreadyAdvanced` flag.
6. Remove the page's duplicate `replaceSeasonWindow()` after a coordinator result.
7. Preserve request-id guards only for presentation state; the coordinator owns cache commit order.
8. On an error with a snapshot, keep content and show the route's existing warning/status surface. On an error without a snapshot, keep the current blocking error surface.
9. Cleanup only sets its local cancelled/request-id guard. It does not abort the coordinator request.

At the start of each async load or mutation handler, before its first `await`, capture `const operatorSessionEpoch = getOperatorSessionEpoch()`. Check it after remote boundaries before any `seasonDataCache`, Zustand, event-bus, or follow-up revalidation write, and at the start of `catch` before any error/warning/log side effect. Pass it to every `patchSeasonWorkspace()` and compatibility `replaceSeasonWindow()` input and as the second argument of `setSeasons()`/`setOperationalSettings()`. If the token is stale, stop that resolution or rejection; never recapture and continue under the new operator.

Pass `{ operatorSessionEpoch }` through every server-authoritative mutation wrapper call, including Daily's `findSeasonByCode()` and `createSeason()` path. A route may not rely only on a guard after `await runNativeScheduleMutation()`/`await runNativeLocalModificationBatchDeltaResult()`: the callee needs the token before it lazily acquires `RemoteStore`, otherwise an old operation could issue its mutation through the new Supabase session.

After all six routes and production store callers have migrated, make `operatorSessionEpoch` required (remove `?`) in `ReplaceSeasonWindowInput` and `PatchSeasonWorkspaceInput`, and make the epoch argument required for `setSeasons()`/`setOperationalSettings()`. Update store/read-model tests and run `rg -n "(replaceSeasonWindow|patchSeasonWorkspace)\\(\\{|\\.(setSeasons|setOperationalSettings)\\(" src --glob '!**/*.test.ts' --glob '!**/*.source.test.ts'` plus TypeScript to prove no production caller can silently use the compatibility escape hatch.

- [ ] **Step 5: Consume provider-persisted realtime invalidation**

In each `useSeasonWorkspaceRefresh()` callback, read the current canonical state (already marked stale/generation-incremented by `SeasonSyncProvider`) and call `revalidateSeasonWorkspaceWindow(input, { force: true, initiator: 'automatic' })`. The coordinator registers the chain immediately, waits full-jitter `100-300ms`, then re-checks state before I/O. Do not mark it stale a second time, because that would create another generation. Continue ignoring events emitted by the route's own mutation source. Do not publish `server-window` as a new invalidation after the coordinator commits.

- [ ] **Step 6: Run complete route source GREEN**

```powershell
node --experimental-strip-types --test src/app/serverWindowSWRRoutes.source.test.ts src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts
node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts src/app/hooks/useSeasonWorkspaceRefresh.source.test.ts
node --experimental-strip-types --test src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts src/lib/seasonWorkspaceWindowCoordinator.test.ts
npx tsc --noEmit --pretty false
```

Expected: all six route contracts PASS and there are zero direct route-window calls. The distinct Seasonal export-snapshot RPC is outside this count.

Tasks 5-8 are not a partial-release ladder. Do not package the Task 5 transport changes or a Detailed-only migration while another production route can still start page-owned workspace reads; all six route callers must pass the final source tests before the app canary is built.

- [ ] **Step 7: Preserve the intentional heavy-page lifecycle**

Update `AppRouteCache.source.test.ts` wording/assertions to state that only the active heavy route renders and that snapshot-first SWR is responsible for non-blocking remounts. Do not modify `AppRouteCache.tsx` unless the test exposes an unrelated regression.

- [ ] **Step 8: Commit**

```powershell
git add src/app/daily/page.tsx src/app/checkin/page.tsx src/app/gate/page.tsx src/app/dashboard/page.tsx src/app/serverWindowSWRRoutes.source.test.ts src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts src/app/components/AppRouteCache.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/onlineFirstRoutes.source.test.ts src/lib/seasonWorkspaceStore.ts src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts
git commit -m "fix: migrate operational routes to server-window swr"
```

---

## Task 9: Make Settings Snapshot-First

**Dependency:** Complete Task 10 first. The Settings repair flow writes an audit entry and must use Task 10's originating-epoch audit contract before this task can be committed safely.

**Files:**

- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Create: `app/src/app/settings/settingsSnapshotFirst.source.test.ts`
- Create: `app/src/lib/operationalSettingsReadModel.ts`
- Create: `app/src/lib/operationalSettingsReadModel.test.ts`
- Modify: `app/src/app/settings/page.tsx`

**Interfaces:**

```ts
export const OPERATIONAL_SETTINGS_CACHE_TTL_MS = 10 * 60_000;

export interface OperationalSettingsReadState {
  snapshot: OperationalSettings | null;
  freshness: 'missing' | 'fresh' | 'stale';
  shouldRevalidate: boolean;
  fetchedAt: number | null;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  lastError: string | null;
}

export function readOperationalSettingsState(
  options?: { now?: number; ttlMs?: number },
): OperationalSettingsReadState;

export function revalidateOperationalSettings(
  options?: { force?: boolean },
): Promise<OperationalSettings>;

export function commitOperationalSettingsSnapshot(
  settings: OperationalSettings,
  options: {
    operatorSessionEpoch: number;
    fetchedAt?: number;
  },
): boolean;

export function clearOperationalSettingsReadModel(): void;

export async function getOperationalSettings(
  options?: {
    force?: boolean;
    operatorSessionEpoch?: number;
  },
): Promise<OperationalSettings>;

export async function saveOperationalSettings(
  settings: OperationalSettings,
  options: { operatorSessionEpoch: number },
): Promise<void>;

// RemoteStore implementation contract; options remain optional for legacy stores.
saveOperationalSettings(
  settings: OperationalSettings,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;
```

- [ ] **Step 1: Write RED behavior tests**

Export `createOperationalSettingsReadModel()` for dependency injection and test:

- missing snapshot returns `missing` and requires revalidation;
- stale snapshot is still returned;
- three simultaneous revalidations call the loader once;
- `force: true` bypasses freshness but joins an existing request;
- a server error preserves the snapshot and records `lastError`;
- commit writes the shared `seasonDataCache`, Zustand `operationalSettings`, and fresh metadata.
- clear increments an internal epoch, removes snapshot/metadata/in-flight references, and prevents a loader started by the previous operator from repopulating the cache after it resolves.
- a save/commit started with epoch 12, followed by a registry advance to epoch 13, may complete its server call but cannot write `seasonDataCache`, Zustand, read-model metadata, or a success state for epoch 13.
- a loader/save rejected after the same epoch advance is normalized to `AbortError`; its old message is not stored as `lastError`, logged, or shown by the epoch-13 page.

Create `settingsSnapshotFirst.source.test.ts` requiring `readOperationalSettingsState()`, initialization of `loading` from `initialSettingsState.snapshot === null`, `revalidateOperationalSettings()` on mount, guarded `commitOperationalSettingsSnapshot(nextSettings, { operatorSessionEpoch })` after a successful save, and stable registration of `clearOperationalSettingsReadModel` with the operator-session cache registry. Read `remoteStore.ts` and `supabaseStore.ts` from this test. Assert both operational-settings wrappers pass the supplied epoch to `runOperatorSessionResourceOperation()`, never use nested `await (await getRemoteStore())`, and call `isOperatorSessionEpochCurrent()` before `setCachedOperationalSettings()`. Require the save wrapper to pass the resource helper's `assertOperatorSessionCurrent` closure into `RemoteStore.saveOperationalSettings()`. Require the Settings page's load/save catches to return without status/error UI when their captured epoch is stale, require `{ operatorSessionEpoch }` on its season `createSeason()`/`updateSeason()` calls, and require every Settings-originated `appendAuditLogEntry()` call to receive that handler's same `{ operatorSessionEpoch }` as its second argument.

Use helper-body slices in `supabaseStore.source.test.ts` to prove `saveOperationalSettings()` passes its checkpoint options into `writeOperationalSettingsRelational()`, and that every sequential request inside the settings write checks immediately before it is constructed. This includes the primary and compatibility-fallback `operational_settings` upserts, each clear, each replace-table clear/upsert pair, and each membership-table upsert. Require `OperatorSessionCheckpointOptions` to flow through `upsertOperationalSettingsRowWithDashboardAlertFallback()`, `writeOperationalSettingsRelational()`, `clearTableRows()`, `upsertTableRows()`, and `replaceTableRows()`. A check at only the start or end of the top-level method must fail the source test.

Lock the settings helper signatures and call positions:

```ts
async function upsertOperationalSettingsRowWithDashboardAlertFallback(
  settings: OperationalSettings,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function clearTableRows(
  table: string,
  clearColumn: string = 'id',
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function upsertTableRows(
  table: string,
  rows: JsonRecord[],
  onConflict: string,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function replaceTableRows(
  table: string,
  rows: JsonRecord[],
  onConflict: string,
  clearColumn: string = 'id',
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

async function writeOperationalSettingsRelational(
  settings: OperationalSettings,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;
```

`replaceTableRows()` must call `clearTableRows(table, clearColumn, options)` and `upsertTableRows(table, rows, onConflict, options)`. Every guarded top-level call passes options in the final position; for a default `clearColumn`, pass `'id'` explicitly before options. Preserve all pre-existing positional arguments.

In the same source test, slice the complete `handleSeasonRepairImport` callback from its declaration through its dependency array. Require `const operatorSessionEpoch = getOperatorSessionEpoch()` before `file.arrayBuffer()`, then require the exact epoch-bearing calls `findSeasonByCode(seasonCode, { operatorSessionEpoch })`, `clearSeasonBaseline(seasonId, { operatorSessionEpoch })`, `updateSeason(seasonId, seasonFields, { operatorSessionEpoch })`, `createSeason(seasonFields as Omit<Season, 'id'>, { operatorSessionEpoch })`, `batchWriteFlightRecords(seasonId, records, undefined, { operatorSessionEpoch })`, `verifySeasonImportCounts(seasonId, expectedCounts, { operatorSessionEpoch })`, and `getSeasons({ operatorSessionEpoch })`. The implementation may name the counts object `expectedCounts`, but it must construct it before the call so the options remain the third argument. Require the audit append to receive the same originating token as its second argument: `appendAuditLogEntry(auditInput, { operatorSessionEpoch })` (the input may be inline or named).

Require a current-epoch guard after every await and before the next remote call, cache/store/event/audit write, success/error status, alert, warning log, or busy-state change. Require the post-write schedule read to use `revalidateSeasonWorkspaceAfterMutation(repairWindowInput, { operatorSessionEpoch, generationAlreadyAdvanced: false })`; forbid direct `loadSeasonWorkspaceWindow()` in this handler. Its `catch` returns before error UI when stale, and its `finally` calls `setSeasonRepairRunning(false)` only while the captured epoch remains current. These assertions must be tied to the sliced handler so a guard elsewhere in the large Settings page cannot satisfy them accidentally.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/lib/operationalSettingsReadModel.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --test src/app/settings/settingsSnapshotFirst.source.test.ts
```

Expected: all three commands FAIL because the read model/page integration do not exist and the settings write helpers do not yet checkpoint each sequential request.

- [ ] **Step 3: Add an explicit remote bypass for revalidation**

Change the wrapper only; do not bypass cache at ordinary call sites:

```ts
export async function getOperationalSettings(
  options: {
    force?: boolean;
    operatorSessionEpoch?: number;
  } = {},
): Promise<OperationalSettings> {
  const operatorSessionEpoch =
    options.operatorSessionEpoch ?? getOperatorSessionEpoch();
  if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
    throw createOperatorSessionAbortError();
  }
  const cached = getCachedOperationalSettings();
  if (cached && !options.force) return cached;
  const settings = await runOperatorSessionResourceOperation({
    operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getOperationalSettings(),
  });
  if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) {
    throw createOperatorSessionAbortError();
  }
  setCachedOperationalSettings(settings);
  return settings;
}

export async function saveOperationalSettings(
  settings: OperationalSettings,
  options: { operatorSessionEpoch: number },
): Promise<void> {
  if (!isOperatorSessionEpochCurrent(options.operatorSessionEpoch)) {
    throw createOperatorSessionAbortError();
  }
  await runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.saveOperationalSettings(
      settings,
      { assertOperatorSessionCurrent },
    ),
  });
  if (!isOperatorSessionEpochCurrent(options.operatorSessionEpoch)) {
    throw createOperatorSessionAbortError();
  }
  setCachedOperationalSettings(settings);
}
```

The read model captures `operatorSessionEpoch` before starting the loader and calls `getOperationalSettings({ force: true, operatorSessionEpoch })`; it owns TTL and single-flight. Check the global operator epoch and the read model's internal clear epoch after the loader resolves and in `catch` before writing error metadata. A stale resolution or rejection becomes `AbortError` without writing into the new operator's cache or `lastError`. `commitOperationalSettingsSnapshot()` requires and verifies the caller's epoch before writing `seasonDataCache`, then calls `setOperationalSettings(settings, operatorSessionEpoch)` for the guarded Zustand write. Register `clearOperationalSettingsReadModel` under the stable key `operational-settings-read-model` with `registerOperatorSessionCacheClearer()`.

In `supabaseStore.ts`, invoke the supplied checkpoint immediately before every request in the settings helper chain. If the epoch advances while one request is already in flight, let that request settle, then the next checkpoint must throw `AbortError` before any following clear/upsert is issued. Do not attempt to compensate by retrying under the new operator.

- [ ] **Step 4: Implement and migrate Settings**

At page initialization:

```ts
const initialSettingsState = readOperationalSettingsState();
const [settings, setSettings] = useState(
  () => initialSettingsState.snapshot ?? emptySettings(),
);
const [savedSettings, setSavedSettings] = useState(
  () => initialSettingsState.snapshot ?? emptySettings(),
);
const [loading, setLoading] = useState(
  () => initialSettingsState.snapshot === null,
);
```

The mount effect applies an available snapshot first and calls `revalidateOperationalSettings()` only when `shouldRevalidate`. A failure with a snapshot leaves the form visible and writes a non-blocking status; a missing snapshot retains the existing alert/blocking behavior.

At the beginning of the save handler, before confirmation or any other `await`, capture `const operatorSessionEpoch = getOperatorSessionEpoch()`. Call `saveOperationalSettings(nextSettings, { operatorSessionEpoch })`, then verify `isOperatorSessionEpochCurrent(operatorSessionEpoch)` before setting React success state, calling `commitOperationalSettingsSnapshot(nextSettings, { operatorSessionEpoch })`, or starting the audit append. Pass the same `{ operatorSessionEpoch }` as the second argument of `appendAuditLogEntry()`. The load/save catch blocks perform the same epoch check before setting error/status state; a stale rejection exits silently as a cancelled old-session operation. This makes the saved snapshot visible on the next route mount without allowing a late old-operator save to repopulate memory.

Apply the same capture/check/pass rule to Settings season creation and update: call `createSeason(seasonFields, { operatorSessionEpoch })` and `updateSeason(seasonId, seasonFields, { operatorSessionEpoch })`. The Task 7 wrappers use `runOperatorSessionResourceOperation()`, so a delayed `getRemoteStore()` cannot turn an old Settings action into a write under the new session.

Migrate `handleSeasonRepairImport` as one guarded transaction-shaped workflow, even though the server APIs are currently multiple calls:

1. Capture the epoch before `file.arrayBuffer()` and check it after the file read, `findSeasonByCode()`, confirmation, every server write/read, optional `getSeasons({ operatorSessionEpoch })`, and coordinator revalidation.
2. Pass the captured options to every Task 7 repair wrapper. Split `getCachedSeasons() ?? await getSeasons({ operatorSessionEpoch })` into explicit branches so the post-`getSeasons()` guard cannot be skipped.
3. After the final batch/count verification, build `repairWindowInput` with `{ seasonId, resourceType: 'schedule', limit: 500000 }` and call `revalidateSeasonWorkspaceAfterMutation()` with `generationAlreadyAdvanced: false`. This advances the affected season generation once after the repair writes and prevents a pre-repair request from committing as current.
4. Check the epoch again before `setCachedSeasons`, `setCachedSeasonData`, `publishSeasonWorkspaceChanged`, `appendAuditLogEntry`, success status, and alert. Pass `{ operatorSessionEpoch }` to `appendAuditLogEntry()` so Task 10 uses the exact originating token rather than recapturing after the repair began.
5. At the top of `catch`, return for a stale epoch before status/alert/logging. In `finally`, mutate the busy flag only if the epoch is still current.

- [ ] **Step 5: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/operationalSettingsReadModel.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --test src/app/settings/settingsSnapshotFirst.source.test.ts
npx tsc --noEmit --pretty false
```

Expected: read-model tests PASS and TypeScript exits `0`.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/remoteStore.ts src/lib/supabaseStore.ts src/lib/supabaseStore.source.test.ts src/lib/operationalSettingsReadModel.ts src/lib/operationalSettingsReadModel.test.ts src/app/settings/page.tsx src/app/settings/settingsSnapshotFirst.source.test.ts
git commit -m "fix: cache settings across route remounts"
```

---

## Task 10: Make Audit Sessions, Entries, And Deltas Snapshot-First

**Files:**

- Create: `app/src/app/audit/auditSnapshotFirst.source.test.ts`
- Create: `app/src/lib/auditReadModel.ts`
- Create: `app/src/lib/auditReadModel.test.ts`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`
- Modify: `app/src/lib/supabaseStore.source.test.ts`
- Modify: `app/src/lib/auditLog.ts`
- Modify: `app/src/app/audit/page.tsx`

**Interfaces:**

```ts
export const AUDIT_READ_CACHE_TTL_MS = 5 * 60_000;

export interface AuditReadState<T> {
  snapshot: T | null;
  freshness: 'missing' | 'fresh' | 'stale';
  shouldRevalidate: boolean;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  fetchedAt: number | null;
  lastError: string | null;
}

export function readAuditSessionsState(
  maxSessions?: number,
  now?: number,
): AuditReadState<AuditSession[]>;

export function readAuditEntriesState(
  sessionId: string,
  maxEntries?: number,
  now?: number,
): AuditReadState<AuditLogEntry[]>;

export function readAuditDeltaState(
  sessionId: string,
  entryId: string,
  now?: number,
): AuditReadState<AuditDeltaItem[]>;

export function revalidateAuditSessions(
  options?: { maxSessions?: number; force?: boolean },
): Promise<AuditSession[]>;

export function revalidateAuditEntries(
  sessionId: string,
  options?: { maxEntries?: number; force?: boolean },
): Promise<AuditLogEntry[]>;

export function revalidateAuditDeltas(
  sessionId: string,
  entry: AuditLogEntry,
  options?: { force?: boolean },
): Promise<AuditDeltaItem[]>;

export function patchAuditCacheAfterAppend(
  session: AuditSession,
  entry: AuditLogEntry,
  operatorSessionEpoch: number,
): boolean;

export function clearAuditReadModel(): void;

export function saveAuditLogEntry(
  session: AuditSession,
  entry: AuditLogEntry,
  options: OperatorSessionRemoteOptions,
): Promise<void>;

export function appendAuditLogEntry(
  input: AppendAuditLogEntryInput,
  options?: OperatorSessionRemoteOptions,
): Promise<void>;

// RemoteStore implementation contract; options remain optional for legacy stores.
saveAuditLogEntry(
  session: AuditSession,
  entry: AuditLogEntry,
  options?: OperatorSessionCheckpointOptions,
): Promise<void>;

export function getAuditSessions(
  options: OperatorSessionRemoteOptions & { maxSessions?: number },
): Promise<AuditSession[]>;

export function getAuditLogEntries(
  sessionId: string,
  options: OperatorSessionRemoteOptions & { maxEntries?: number },
): Promise<AuditLogEntry[]>;

export function getAuditDeltaChunks(
  sessionId: string,
  entryId: string,
  options: OperatorSessionRemoteOptions,
): Promise<AuditDeltaChunk[]>;
```

- [ ] **Step 1: Write RED cache and single-flight tests**

Export a dependency-injected `createAuditReadModel()` and test:

- stale sessions/entries remain readable;
- three loads of the same key call the remote loader once;
- entries for two sessions never overwrite one another;
- session and entry limits are part of their key (`50` and `200` defaults match Supabase);
- delta keys contain both `sessionId` and `entryId`;
- delta chunks are sorted and flattened when any chunk exists; otherwise use `entry.syncDelta?.exactChanges ?? entry.deltas` as the exact source, so the same logical deltas are never concatenated twice;
- force bypasses freshness but joins an existing request;
- `patchAuditCacheAfterAppend()` moves the session and new entry to the front without duplicating either.
- clear increments an internal epoch, removes all operator-scoped maps/in-flight references, and prevents late previous-operator responses from repopulating them.
- `appendAuditLogEntry()` started in an old operator epoch may finish an already-issued server write, but cannot recreate the cleared read cache or reuse the old audit session ID after the auth boundary.
- pending session/entry/delta loads and actor/save calls that reject after an epoch advance are treated as stale `AbortError`/silent best-effort cancellation; their old messages do not enter new-operator metadata, console diagnostics, or UI.

Create `auditSnapshotFirst.source.test.ts` requiring `readAuditSessionsState()`, `readAuditEntriesState()`, `readAuditDeltaState()`, `revalidateAuditSessions()`, `revalidateAuditEntries()`, `revalidateAuditDeltas()`, synchronous `getOrCreateAuditSessionId()` initialization, `{ force: true }` on the Refresh path, and stable registration of `clearAuditReadModel` with the operator-session cache registry. Read `auditLog.ts` too and require `appendAuditLogEntry()` to resolve `operatorSessionEpoch` from its options before the dynamic import, default those options at function invocation for unchanged callers, pass `{ operatorSessionEpoch }` to `getCurrentRemoteActor()` and `saveAuditLogEntry()`, check the epoch before the actor-derived entry is written and before `patchAuditCacheAfterAppend(session, entry, operatorSessionEpoch)`, and check it in `catch` before `console.debug`. Read `remoteStore.ts` and `supabaseStore.ts` from this test; require the audit save plus all three audit read wrappers to use `runOperatorSessionResourceOperation()` with `acquire: getRemoteStore`, and forbid their old nested-await forms. Require the save wrapper to pass the resource helper's checkpoint closure into the underlying `RemoteStore.saveAuditLogEntry()`. Require the read model to pass its captured epoch into every wrapper before lazy store acquisition. Require Audit page catches to skip error/status UI for stale epochs.

Add method-body assertions to `supabaseStore.source.test.ts` for `saveAuditLogEntry()`: it must checkpoint before the audit-session upsert, again before the audit-entry upsert, and pass the same options into `upsertRows()` so every audit-delta chunk checks before its request. Because Task 7 preserves `upsertRows()` argument four for progress, require the exact guarded form `upsertRows('audit_delta_chunks', deltaRows, 'session_id,entry_id,id', undefined, options)` (the mapped rows may use an equivalent named variable). The test must fail if all checkpoint calls are moved to the start/end of the method, if options occupy argument four, or if the delta helper receives no options. Task 2's delayed internal-step test is the behavioral proof that an epoch change between those stages prevents the next request.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/lib/auditReadModel.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --test src/app/audit/auditSnapshotFirst.source.test.ts
```

Expected: all three commands FAIL because the read model/Audit page integration do not exist and the audit write path does not yet checkpoint all sequential requests.

- [ ] **Step 3: Implement the read model**

Use module-level maps for snapshots, metadata, and in-flight promises. This cache is process memory only. Every revalidation captures the global operator epoch plus the model's internal clear epoch before its first `await`; it checks both after success and at the top of `catch`, before committing data or error metadata. A stale resolution or rejection is normalized to `AbortError` and does not write into the new operator's maps or `lastError`. Current-epoch errors update metadata but do not delete snapshots. Pass the captured token into the remote wrappers: `getAuditSessions({ maxSessions, operatorSessionEpoch })`, `getAuditLogEntries(sessionId, { maxEntries, operatorSessionEpoch })`, and `getAuditDeltaChunks(sessionId, entry.id, { operatorSessionEpoch })`. When chunks exist, `revalidateAuditDeltas()` sorts and flattens only the chunks; otherwise it returns `entry.syncDelta?.exactChanges ?? entry.deltas`. `patchAuditCacheAfterAppend()` returns `false` without writing when its required operator epoch is stale. Register `clearAuditReadModel` under the stable key `audit-read-model` with the operator-session cache registry.

Implement those remote reads with the same guarded lazy-acquisition boundary:

```ts
export function getAuditSessions(
  options: OperatorSessionRemoteOptions & { maxSessions?: number },
): Promise<AuditSession[]> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getAuditSessions(options.maxSessions),
  });
}

export function getAuditLogEntries(
  sessionId: string,
  options: OperatorSessionRemoteOptions & { maxEntries?: number },
): Promise<AuditLogEntry[]> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getAuditLogEntries(sessionId, options.maxEntries),
  });
}

export function getAuditDeltaChunks(
  sessionId: string,
  entryId: string,
  options: OperatorSessionRemoteOptions,
): Promise<AuditDeltaChunk[]> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store) => store.getAuditDeltaChunks(sessionId, entryId),
  });
}
```

- [ ] **Step 4: Keep the read cache coherent after an audit write**

At function invocation, default `appendAuditLogEntry()` options to the current epoch; at the first line of its body, before the dynamic import or actor lookup, resolve `const operatorSessionEpoch = options.operatorSessionEpoch`. Pass that same token to `getCurrentRemoteActor()` and check it after the lookup resolves. In `remoteStore.ts`, replace the audit wrapper with:

```ts
export function saveAuditLogEntry(
  session: AuditSession,
  entry: AuditLogEntry,
  options: OperatorSessionRemoteOptions,
): Promise<void> {
  return runOperatorSessionResourceOperation({
    operatorSessionEpoch: options.operatorSessionEpoch,
    acquire: getRemoteStore,
    execute: (store, assertOperatorSessionCurrent) => store.saveAuditLogEntry(
      session,
      entry,
      { assertOperatorSessionCurrent },
    ),
  });
}
```

Change `appendAuditLogEntry()` to this originating-token shape before its `try` block:

```ts
export async function appendAuditLogEntry(
  input: AppendAuditLogEntryInput,
  options: OperatorSessionRemoteOptions = {
    operatorSessionEpoch: getOperatorSessionEpoch(),
  },
): Promise<void> {
  const operatorSessionEpoch = options.operatorSessionEpoch;
  try {
    const { getCurrentRemoteActor, saveAuditLogEntry } = await import('./remoteStore');
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;

    const remoteActor = input.actor
      ? null
      : await getCurrentRemoteActor({ operatorSessionEpoch });
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;

    const actor = input.actor ?? resolveAuditActor(remoteActor);
    const entry = createAuditLogEntry({ ...input, actor });
    const session = buildAuditSession(entry.sessionId, actor, entry.timestamp);
    await saveAuditLogEntry(session, entry, { operatorSessionEpoch });
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;

    const { patchAuditCacheAfterAppend } = await import('./auditReadModel');
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    patchAuditCacheAfterAppend(session, entry, operatorSessionEpoch);
  } catch (error) {
    if (!isOperatorSessionEpochCurrent(operatorSessionEpoch)) return;
    console.debug('[audit-log] append failed', error);
  }
}
```

The default expression captures the epoch synchronously when an unchanged caller invokes the function. Settings repair in Task 9 passes its already-captured token explicitly. Check `isOperatorSessionEpochCurrent(operatorSessionEpoch)` after every awaited boundary. If it is stale before `saveAuditLogEntry()`, return without issuing the write; call the wrapper as `saveAuditLogEntry(session, entry, { operatorSessionEpoch })`. If the epoch changes while lazy store acquisition is pending, the resource-operation helper prevents the remote method from being invoked. If it changes while an already-issued audit-session/entry/chunk write is running, allow that request to settle, then its next internal checkpoint must stop later writes; do not patch any cache or surface a current-session error. In `supabaseStore.ts`, pass `OperatorSessionCheckpointOptions` through `saveAuditLogEntry()` and `upsertRows()` and invoke it at each boundary described by the source test.

Keep the existing best-effort audit error boundary; at the top of its `catch`, return immediately when `isOperatorSessionEpochCurrent(operatorSessionEpoch)` is false, and only log a current-operator failure. Cache patching happens only after the server write succeeds and while the originating operator epoch remains current. Task 2's `resetAuditSessionId()` guarantees the next operator creates a different session ID.

- [ ] **Step 5: Migrate Audit page initialization and refresh**

Create the current session ID synchronously:

```ts
const [currentSessionId] = useState(() => getOrCreateAuditSessionId());
```

Initialize sessions, selected session, entries, and delta expansion from the corresponding read states. A mount/selection change shows a blocking/inline loader only when its snapshot is null. A stale snapshot stays visible during background revalidation. The Refresh button calls `revalidateAuditEntries(selectedSessionId, { force: true })`. `toggleEntry()` applies a delta snapshot immediately and fetches only when needed. Capture the operator epoch before each page async operation and check it in success and catch paths before changing shared or React error/status state.

- [ ] **Step 6: Run GREEN**

```powershell
node --experimental-strip-types --test src/lib/auditReadModel.test.ts
node --experimental-strip-types --test src/lib/supabaseStore.source.test.ts
node --test src/app/audit/auditSnapshotFirst.source.test.ts
npx tsc --noEmit --pretty false
```

Expected: audit tests PASS and TypeScript exits `0`.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/remoteStore.ts src/lib/supabaseStore.ts src/lib/supabaseStore.source.test.ts src/lib/auditReadModel.ts src/lib/auditReadModel.test.ts src/lib/auditLog.ts src/app/audit/page.tsx src/app/audit/auditSnapshotFirst.source.test.ts
git commit -m "fix: cache audit reads across route remounts"
```

---

## Task 11: Lock The Server-First Contract And Correct Stale Copy

**Files:**

- Modify: `app/src/app/onlineFirstRoutes.source.test.ts`
- Modify: `app/src/app/components/NativeRuntimeGate.tsx`
- Modify: `app/src/lib/serverAuthoritativeMode.ts`
- Modify: `app/src/app/components/AppRouteCache.source.test.ts`

- [ ] **Step 1: Update the server-first source contract first**

Audit the coordinator expectations already migrated incrementally in Tasks 7-8. Assert all six data pages use the shared snapshot/revalidation contract and no route mount function imports or invokes a native/SQLite read fallback.

Keep the test scoped to read/load functions. Native workers may remain imported for existing write/desktop integration code, but they must never be selected as a normal server-read fallback.

Confirm every affected existing block still covers the following; repair any omission rather than deleting coverage:

- cache/read-model assertions -> `readSeasonWorkspaceWindowState()` plus stale snapshot visibility;
- direct server-load/publish assertions -> coordinator revalidation and `commitSeasonWindowResult()`; pages must not own page loops or publish a new `server-window` invalidation;
- 100k capacity assertions -> each canonical input builder still supplies logical `limit: 100000`; Task 5A page size stays independent and a ceiling breach errors instead of truncating;
- manual Fetch assertions -> `{ force: true, initiator: 'immediate' }` coordinator reads and the existing request-id/current-window guards;
- cache-first initial-render assertions -> loading is false for any snapshot, including stale;
- activation refresh assertions -> provider-persisted generation plus coordinator refresh, with no page `replaceSeasonWindow()`;
- missing-server-window assertions -> blocking error only when no snapshot exists and no native fallback;
- pre-fetch mutation queue ordering -> `currentMutationRef`/`commitQueueRef` still complete before forced coordinator revalidation;
- Seasonal export -> use the distinct V2 export-snapshot contract from the 2026-07-18 plan and continue forbidding workspace/native schedule reads.

Before editing production copy, add explicit assertions that read `NativeRuntimeGate.tsx` and `serverAuthoritativeMode.ts`:

```ts
assert.doesNotMatch(nativeGateSource, /SQLite engine as the only operational data store/);
assert.match(nativeGateSource, /reads operational data\s+from the server/);
assert.match(
  serverPolicySource,
  /Server-first: Supabase is the source of truth and normal read path; route snapshots are memory-only\./,
);
```

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types --test src/app/onlineFirstRoutes.source.test.ts src/app/components/AppRouteCache.source.test.ts
```

Expected: FAIL until the assertions and stale UI copy are aligned with the new contract.

- [ ] **Step 3: Correct the native-shell message**

Keep the Tauri requirement if native desktop integration is still required, but replace the false SQLite statement with server-first wording:

```tsx
<p className="mt-3 text-sm leading-6 text-on-surface-variant">
  Seasonal Management runs in the Tauri desktop app and reads operational data
  from the server. Open this workspace in the desktop app to use its native
  integrations.
</p>
```

Update the policy label to:

```ts
export const SERVER_AUTHORITATIVE_POLICY_LABEL =
  'Server-first: Supabase is the source of truth and normal read path; route snapshots are memory-only.';
```

Do not change the runtime gate behavior in this plan; only remove the obsolete data-source claim.

- [ ] **Step 4: Run GREEN and scan the active contract**

```powershell
node --experimental-strip-types --test src/app/onlineFirstRoutes.source.test.ts src/app/components/AppRouteCache.source.test.ts
rg -n "SQLite engine as the only operational data store|native SQLite.*read|SQLite.*fallback" src/app src/lib
```

Expected: source tests PASS. The scan may find explicitly historical/test fixtures, but no active route-load or user-facing current-contract statement.

- [ ] **Step 5: Commit**

```powershell
git add src/app/onlineFirstRoutes.source.test.ts src/app/components/NativeRuntimeGate.tsx src/lib/serverAuthoritativeMode.ts src/app/components/AppRouteCache.source.test.ts
git commit -m "fix: enforce the server-first route contract"
```

---

## Task 12: Verify Repeated Navigation And Update Architecture Docs

**Files:**

- Modify: `context.md`
- Modify: `architecture.md`
- Modify: `app/README.md`
- Create: `docs/superpowers/artifacts/2026-07-13-server-first-route-reload-verification.md`
- Modify: `docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md`

- [ ] **Step 1: Run every focused regression**

```powershell
cd C:\Users\tuan\Documents\SeasonalManagement\app
node --experimental-strip-types --test src/lib/operatorAuthIdentity.test.ts src/lib/operatorAuthSessionPolicy.test.ts src/lib/operatorSessionCacheRegistry.test.ts src/lib/seasonAutoSync.test.ts
node --test src/app/components/OperatorAuthGate.source.test.ts src/app/components/SeasonSyncProvider.source.test.ts
node --experimental-strip-types --test src/lib/seasonWorkspaceStore.test.ts src/lib/seasonWorkspaceReadModel.test.ts src/lib/seasonWorkspaceWindowCoordinator.test.ts
node --experimental-strip-types --test src/lib/seasonWorkspaceWindowRpcV2Contract.test.ts src/lib/supabaseErrorPolicy.test.ts src/lib/supabaseWorkspaceWindowTransport.source.test.ts src/lib/supabaseStore.source.test.ts src/lib/seasonalImportModeGuard.test.ts
node --experimental-strip-types --test src/app/serverWindowSWRRoutes.source.test.ts src/app/postMutationWindowGeneration.source.test.ts src/app/operatorSessionEpoch.source.test.ts src/app/onlineFirstRoutes.source.test.ts src/app/syncFetchBoundary.source.test.ts src/app/components/AppRouteCache.source.test.ts
node --experimental-strip-types --test src/lib/operationalSettingsReadModel.test.ts src/lib/auditReadModel.test.ts
node --test src/app/settings/settingsSnapshotFirst.source.test.ts src/app/audit/auditSnapshotFirst.source.test.ts
```

Expected: every test PASS. Record exact counts and durations in the artifact; do not paste aspirational results.

- [ ] **Step 2: Run whole-project gates as separate commands**

```powershell
npm run test:rules
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

Expected: rule suite, typecheck, lint, and production build exit `0`. Existing lint warnings may remain, but record and do not increase their count.

- [ ] **Step 3: Prove the V2 query plan and seven-client capacity before canary**

Run the isolated harness first with one client, then release seven independent authenticated client instances against the same representative full season from a barrier:

```powershell
npm run test:workspace-window-v2-load -- --clients 1
npm run test:workspace-window-v2-load -- --clients 7
```

Record both the server baseline query and each client's final assembled root/record/modification IDs and counts. Full keyset exhaustion (`hasMore=false`) and unique cursors are the completeness contract; do not compare workspace totals directly with Import V2's `flightRecordCount`, because a workspace may also contain preserved manual-added roots.

Acceptance:

- the one-client run has at most one V2 page statement in flight and returns no missing/duplicate root or child;
- the seven-client run has at most seven V2 page statements in flight across the barrier, never seven page statements per client;
- all seven clients return identical snapshot tokens and assembled ID/count sets;
- `statement_timeout` remains 8 seconds, with zero `57014`;
- page p95 is below 2 seconds and the slowest page is below 4 seconds, leaving at least 50% timeout headroom;
- database CPU does not remain above 80% for more than 10 seconds and there is no synchronized retry wave. Capture DB/host metrics; if those metrics are unavailable, record the capacity gate as blocked rather than PASS;
- no V1 workspace RPC or direct-table hydration begins after a V2 timeout/network failure;
- a confirmed missing V2 signature produces at most one V1 compatibility request;
- `EXPLAIN (ANALYZE, BUFFERS)` for first, middle, and last cursors uses the matching V2 indexes and shows no whole-season sort, sequential scan of the complete season, or temp-file spill.

If any latency/CPU/concurrency/`57014` item fails after the fixed jitter policy is active, do not tune the jitter upward indefinitely and do not raise `statement_timeout`. Implement the immutable pinned page cache defined in Task 5A, then repeat the one-client, seven-client, mutation-between-pages, and completeness gates before canary release.

The same-process seven-consumer case is separate and must already be green in `seasonWorkspaceWindowCoordinator.test.ts`: seven same-key/generation callers share one strict logical promise/page chain and maximum page concurrency remains `1`.

- [ ] **Step 4: Deploy both additive V2 database contracts and build one client canary**

For the combined campaign, deploy SQL in this order:

```text
1. 20260718090000_seasonal_source_import_v2.sql
2. 20260720090000_workspace_window_keyset_v2.sql
3. reload the PostgREST schema cache
4. verify both exact V2 signatures, owner/security mode, and grants
5. run authenticated import-preview and workspace-page smoke calls
6. only then install the client canary
```

`apply_seasonal_import_remote` is Import V1 and follows the 2026-07-18 plan's retirement gate. `get_season_schedule_allocation_window_v1` is workspace-read V1 and remains callable for old signed clients through its own compatibility window. Do not use the ambiguous phrase "retire V1" in evidence. A rollback may reinstall the prior client while both read RPC versions remain deployed; do not drop V2 while a new client exists and do not drop workspace-read V1 while an old client exists.

- [ ] **Step 5: Run an authenticated Tauri navigation smoke test**

Start the actual runtime:

```powershell
npm run native:dev
```

In the Tauri app, select one populated season and warm these routes once in order:

```text
Dashboard -> Seasonal Schedule -> Detailed Schedule -> Daily Schedule
-> Check-in Allocation -> Gate Allocation -> Audit Log -> Settings
```

Then repeat the same eight-route sequence three times. Record a table in the artifact with route, first-load behavior, warm-return behavior, full-page loader seen, logical-load count, physical V2 page count, maximum page concurrency for that logical window, and error/warning state.

Open WebView DevTools Network, enable **Preserve log**, filter by `get_season_schedule_allocation_window_v2`, and clear the log immediately after the warm pass. The three warm loops must add `0` matching requests for unchanged fresh keys. For each manual Refresh, identify exactly one logical chain: one first page without a cursor followed by the expected sequential cursors until `hasMore=false`. More than one physical RPC is valid; more than one page simultaneously in flight for the chain is not. In the `WS` filter, verify there is one active Supabase realtime WebSocket before and after the loops.

Acceptance for the warm loops:

- no route shows its blocking/full-page loading panel;
- no operator-auth screen appears during a same-user token event;
- a fresh canonical server window creates zero additional RPC calls;
- simultaneous consumers of the same key/generation create one logical promise/page chain;
- Detailed with blank From/To still renders the complete server baseline for the season;
- route selection, filters, drafts, and scroll restoration remain intact where already supported;
- WebView DevTools shows one active Supabase realtime WebSocket rather than an additional connection for each navigation loop.

- [ ] **Step 6: Verify stale and network-failure behavior in the real runtime**

Use only a season explicitly designated for testing. Record its season ID, one test flight-leg ID, and the original gate in the artifact. If no non-production test season is available, stop this manual mutation step and record the blocker instead of editing production data.

Warm Gate Allocation, then enable DevTools **Request blocking** for `*get_season_schedule_allocation_window_v2*`. Change the test leg's gate and save; the server mutation request itself must succeed, while the post-mutation logical revalidation is deterministically blocked. Navigate away and back. The optimistic/server-acknowledged route data must remain visible rather than showing a full loader, and the blocked current-generation refresh must not be replaced by any pre-mutation or partial-page response. Then:

- current snapshot remains visible;
- a warning/status appears without clearing the page;
- `Failed to fetch`/`57014` triggers neither workspace-read V1 nor direct `season_flight_records`/child-table reads;
- disable request blocking + one manual Refresh issues one complete sequential logical chain and succeeds;
- restore the original gate, save, and run one final successful Refresh before ending the test.

The persisted inactive-route realtime path is covered deterministically by the Task 4 store/provider regressions; do not require a second desktop instance because this app enables Tauri's single-instance plugin.

Do not claim this step passed from unit tests alone. Record the observed Network entries in the artifact without credentials, access tokens, or service-role keys.

- [ ] **Step 7: Verify post-import reconciliation has one owner**

Using only the designated test season, run an Import V2 commit and correlate its batch ID, request ID, client ID, returned `dataVersion`/`serverHighWater`, realtime event, and following workspace requests. Require:

- one successful stage/commit sequence and one change event for the request ID;
- the initiating client ignores its own realtime echo and calls `revalidateSeasonWorkspaceAfterMutation()` once with the import result token;
- exactly one resulting logical V2 workspace chain—no direct page-owned load, coordinator duplicate, or realtime duplicate;
- another client receives one invalidation and starts at most one chain for its new generation;
- the final complete snapshot contains the committed import plus preserved manual-added roots;
- if reconciliation is fault-injected after commit, the UI says `Import committed, refresh failed`, preserves the stale visible snapshot, offers manual Refresh, and never retries the commit automatically.

Record this result in both verification artifacts so neither plan can be declared complete from its half of the flow alone.

- [ ] **Step 8: Update current architecture and supersede historical claims**

Update `context.md`, `architecture.md`, and `app/README.md` with the final contract:

- Supabase/server is the durable source and normal read path;
- Zustand/module caches hold server-returned memory snapshots only;
- routes may remount;
- fresh snapshot renders without I/O;
- stale snapshot renders immediately with one background revalidation;
- only a missing snapshot blocks;
- coordinator owns one logical load per key/generation and commits only after all sequential V2 pages are complete and version-consistent;
- page unmount does not cancel a normal shared request;
- generic network failure/timeout preserves stale data and never selects V1, direct-table fan-out, or SQLite after V2 begins;
- per-window `fetchedAt` controls TTL;
- client-only filters do not affect the server key;
- every mutation advances its server-window generation exactly once before reconciliation;
- import commit is followed by one token-fenced coordinated reconciliation, and the initiating client ignores its own realtime echo;
- operator-session epoch guards prevent late reads and writes from restoring cleared state.

In `context.md`, remove or explicitly mark as superseded the historical claims that all primary pages stay mounted and native SQLite is the final normal-read fallback.

- [ ] **Step 9: Scan changed Vietnamese/non-ASCII files for mojibake**

From the repository root:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
rg -n "\x{00C3}|\x{00C2}|\x{00E1}\x{00BA}|\x{00C6}|\x{00C4}|\x{FFFD}" context.md architecture.md app/README.md docs/superpowers/artifacts/2026-07-13-server-first-route-reload-verification.md
```

Expected: no newly introduced mojibake. If an old unrelated match exists, document its exact pre-existing line instead of copying it into new text.

- [ ] **Step 10: Commit documentation and evidence**

```powershell
git add context.md architecture.md app/README.md docs/superpowers/artifacts/2026-07-13-server-first-route-reload-verification.md docs/superpowers/artifacts/2026-07-18-seasonal-import-export-verification.md
git commit -m "docs: record server-first route reload verification"
```

---

## Stop Conditions

Stop the task and diagnose before continuing if any of these occurs:

- a normal route mount or revalidation calls SQLite/native local reads;
- a warm or stale snapshot still enters a blocking loader;
- the same canonical key/generation in one app starts more than one logical page chain, or one chain runs more than one physical page request concurrently;
- page cleanup aborts a normal shared request solely because the route changed;
- `Failed to fetch`, `57014`, or an exhausted snapshot retry triggers workspace-read V1/direct-table fallback after V2 begins;
- a V2 page times out, returns `57014`, performs a whole-season sort/temp spill, or exceeds the 4-second page maximum in the representative load gate;
- a page token changes and any partial page data is committed, rendered, or merged with the replacement attempt;
- a schedule-relevant production write changes data without advancing `dataVersion` or `serverHighWater` in the same transaction;
- seven same-process callers create more than one logical chain, or seven independent clients create more than seven concurrent page statements/retry in a synchronized wave;
- automatic realtime/TTL refresh skips the `100-300ms` full-jitter/recheck policy, manual/post-mutation work is delayed by it, or `snapshot_changed` performs more than one automatic restart;
- any seven-client result has a different token, root/record/modification ID set, or count from its peers/baseline;
- another window's fetch changes this window's TTL;
- an older response overwrites a newer overlapping entity or an obsolete generation clears current staleness;
- a post-mutation forced refresh can join a request started before that mutation, or advances the generation twice;
- a read/write captured under an old operator epoch writes any cache/store/error state, logs/surfaces its rejection, publishes a realtime event, or launches a retry for the new operator;
- an epoch advance occurs during a multi-request server write and that operation still issues its next sequential request or chunk;
- a same-user `TOKEN_REFRESHED` event replaces authorized children with the auth screen;
- a late realtime subscription survives provider teardown;
- a page overwrites the coordinator's newer committed data with an older page-owned response;
- a successful import starts more than one initiating-client reconciliation chain through direct load + coordinator + realtime echo;
- the client canary is installed before both V2 migrations/signatures/grants are verified on the target server;
- Task 5 is packaged without Task 5A, Task 6, and all Task 7-8 route migrations;
- workspace-read V1 is revoked/dropped while an older signed client remains deployed, or V2 is dropped while a new client remains deployed;
- verification requires hard-coded credentials or writes secrets to logs/artifacts;
- the change needs `AppRouteCache` to retain every heavy page to appear successful.

---

## Definition Of Done

- Tasks 1-12 plus inserted Task 5A are implemented in the dependency order below with their focused tests and commits.
- The route cache still renders only the active heavy page.
- After one successful load, switching through all eight routes three times does not show blocking page reloads.
- Fresh reads make no extra server request; stale and forced reads are one logical single-flight page chain within the current invalidation generation, with at most one page statement in flight.
- Every post-mutation revalidation advances the affected season generation exactly once before loading.
- A request that outlives its initiating page still warms the shared snapshot.
- Auth token refresh for the same user keeps `AppShell` mounted.
- Provider teardown leaves no scheduler timer, idle callback, pending subscription attempt, or installed subscription behind.
- Network errors/timeouts retain server snapshots and do not fan out to workspace-read V1, direct-table reads, or SQLite after V2 begins.
- Settings and Audit no longer reload from an empty state on every remount.
- Detailed Schedule with no From/To filter still renders the complete season, while its server load stays within the bounded transport/capacity contract instead of relying on one unbounded aggregate statement.
- Every completed V2 logical window ends at `hasMore=false`, contains no duplicate/missing roots or orphan children, and is pinned to one `dataVersion`/`serverHighWater`; no partial snapshot is committed.
- Seven same-key callers in one app share one strict promise/page chain. Seven independent authenticated clients produce at most seven simultaneous page statements, identical complete results, zero `57014`, page p95 below 2 seconds, and maximum page latency below 4 seconds under the unchanged 8-second timeout.
- Automatic realtime/TTL refresh uses full-jitter `100-300ms`; manual/post-mutation actions start immediately. `snapshot_changed` waits full-jitter `250-1000ms`, restarts at most once, and preserves stale content with a warning after a second mismatch.
- The release either passes the seven-client gate without a server page cache or includes the immutable pinned cache and passes the complete gate again; a failed capacity result is never waived by increasing the global timeout.
- A missing V2 signature invokes at most one workspace-read V1 compatibility request; a V2 timeout does not. Both read versions remain available for the verified rollback window.
- Import V2 commit produces one initiating-client token-fenced coordinated reconciliation, its realtime echo is ignored locally, and reconciliation failure never retries or relabels the committed import.
- Sign-out, user change, or operator revocation clears all operator-scoped snapshots; late previous-user resolutions, rejections, and realtime callbacks cannot repopulate them or surface stale errors/events.
- A multi-request Supabase write checks its originating operator epoch before every later request/chunk and stops issuing new requests after that epoch changes.
- Server-first wording is consistent in active code and docs.
- Focused tests, SQL integration, query-plan/load gates, rule suite, typecheck, lint, build, real Tauri navigation/import smoke, server metrics, and UTF-8/mojibake scan are recorded with actual results.

---

## Execution Order

```text
Route Task 1 -> Route Task 2
Route Task 3 may run in parallel with Route Tasks 1-2 after baseline
Route Tasks 2 + 3 -> Route Task 4 -> Route Task 5
Import Tasks 1-5 may run in parallel, then join Route Task 5 at Route Task 5A
Route Task 5A -> Route Task 6
Route Task 6 + Import Task 6 -> Route Task 7 as one client cutover
Route Task 7 -> Route Task 8; Route Task 10 may run in parallel
Route Task 10 -> Route Task 9
Import Tasks 7-11 and Route Tasks 8-11 -> combined Route Task 12 gates
Combined V2 SQL deployment -> schema-cache reload -> authenticated smoke
-> native canary -> seven-client capacity gate -> one signed app release
```

Task numbers are stable reference IDs; `Route` means this plan and `Import` means `2026-07-18-seasonal-source-row-import-export-v2.md`. Task 4 needs both the operator-session registry from Task 2 and the provider lifecycle attempt created in Task 3. Route Task 9 waits for Route Task 10 because repair import passes its originating epoch into the audit append contract. Route Task 11 waits for Route Tasks 8, 9, and 10. Do not start route migration before the metadata, V2 transport, and coordinator tests are green. Do not delete legacy key/read helpers until `rg` confirms every production caller has migrated.

"Fix once" means one coordinated signed client release and one shared verification record, not one atomic server/client deployment. Database changes remain additive and go first. Roll back the app by reinstalling the previous signed release while keeping both workspace-read RPC versions. Do not roll back/drop the V2 function while a V2 client exists; do not revoke workspace-read V1 until client-version telemetry or an explicit fleet inventory proves old clients are drained.
