# Cold Start Sync Load Failure Bugfix Design

## Overview

On a cold start — the first launch of the Tauri desktop app on a brand-new PC with no
local SQLite season rows, no IndexedDB workspace, and no cached workspace — the app
fails to present schedule data cleanly. Two visible symptoms combine: a spurious
"UI startup cleanup timed out" banner during startup, and a generic "Load Failed" modal
when a schedule page (gate / daily / check-in) tries to read data.

This design grounds the fix in the **actual current code**, which differs from the
original bug report in two important ways:

1. **The startup race no longer discards pending changes.**
   `#[[file:../../../app/src/app/components/NativeStartupSessionReset.tsx]]` calls
   `clearNativeAppSessionData({ preserveAuth: true, discardPendingLocalChanges: false,
   resetUndoSession: true })` inside `Promise.race([...], timeoutAfter(5000))`. Because
   `discardPendingLocalChanges` is `false`, the raced work is only web-storage clear +
   in-memory cache clear (see `clearNativeAppEphemeralData` in
   `#[[file:../../../app/src/lib/appSessionCleanup.ts]]`). The heavy one-time SQLite DB
   creation + migration + IndexedDB seeding does **not** run inside this race today; it
   happens later, lazily, on the first `getSqlDbForLocalStore()` call from a schedule
   loader. The design therefore re-targets the banner fix at the real cause: a fixed
   5000ms wall-clock race that can still lose on a slow/contended first launch (and is
   conceptually mismatched — it warns about "cleanup" timing out when nothing dangerous
   is happening), while still guarding against a genuine hang (regression 3.2).

2. **The cold-start baseline seed already exists.**
   `ensureNativeSeasonBaseline(season)` in
   `#[[file:../../../app/src/lib/nativeSeasonBootstrap.ts]]` already seeds the server
   baseline (it calls `ensureNativeLocalSeason`, `checkNativeSeasonIntegrity`, and on
   failure fetches `getSeasonWorkspaceSnapshot` + `importNativeSeasonSnapshot`, then
   re-checks integrity, caching healthy season ids and deduping in-flight calls). All
   three loaders (`daily`, `gate`, `checkin`) already `await ensureNativeSeasonBaseline`
   before querying. So the data-load fix is **not** "add seeding" — it is: (a) classify
   the failure cause into actionable kinds, (b) replace the generic "Load Failed"
   message with a specific, actionable message and action, and (c) guarantee the local
   store is initialized before the read.

The fix `F'` must satisfy the cold-start properties while preserving warm-start behavior
exactly (preservation checking for ¬C(X)).

## Glossary

- **Bug_Condition (C)**: The cold-start condition that triggers the bug — native (Tauri)
  runtime, local SQLite store not yet initialized, the selected season has zero local
  rows, and no cached workspace is present. Formalized as `isBugCondition` below.
- **Property (P)**: The desired behavior on a cold start — startup completes without a
  spurious timeout banner and against a ready store, and a schedule load either succeeds
  after seeding the baseline or fails with a specific, actionable message.
- **Preservation**: Existing warm-start behavior (an already-initialized store and/or an
  already-seeded season, or no seasons at all) plus genuine-hang warnings and
  edit-discard cleanup, all of which must remain byte-for-byte identical after the fix.
- **F / F'**: `F` is the original (unfixed) `startupReset` + `loadSchedule` behavior;
  `F'` is the fixed behavior.
- **`NativeStartupSessionReset`**: The component in
  `#[[file:../../../app/src/app/components/NativeStartupSessionReset.tsx]]` that runs
  startup cleanup inside `Promise.race` against `STARTUP_CLEANUP_TIMEOUT_MS = 5000` and
  renders the timeout/failure banner.
- **`clearNativeAppSessionData`**: The cleanup function in
  `#[[file:../../../app/src/lib/appSessionCleanup.ts]]`. With
  `discardPendingLocalChanges: false` it only clears web storage + in-memory cache; with
  `true` it additionally calls `discardAllLocalPendingChanges()`.
- **`discardAllLocalPendingChanges`**: In
  `#[[file:../../../app/src/lib/localSeasonStore.ts]]`; chains
  `getSqlDbForLocalStore()` → `getLocalSeasonSqlDatabase()` (load Tauri SQL plugin, open
  DB, run migration) → `ensureSqlSeededFromIndexedDb()`. This is the heavy path the bug
  report attributed to startup, but today it only runs when discarding edits.
- **`ensureNativeSeasonBaseline`**: In
  `#[[file:../../../app/src/lib/nativeSeasonBootstrap.ts]]`; seeds/repairs a season's
  native baseline from the server snapshot and verifies integrity. Already invoked by all
  three loaders.
- **`queryNativeScheduleWindow` / `queryNativeAllocationWindow`**: In
  `#[[file:../../../app/src/lib/nativeSeasonCatchup.ts]]`; return `null` when not in the
  Tauri runtime (via `invokeNative`), which loaders currently translate into
  `throw new Error('Native ... query is unavailable.')`.
- **`runNativeSeasonCatchup`**: In
  `#[[file:../../../app/src/lib/nativeSeasonCatchup.ts]]`; returns `null` when signed out
  (no Supabase access token) or when Supabase env vars are missing — the signal used to
  classify a `signed-out` failure.
- **AppStartupContext / cold start**: The abstract input `X` describing the machine and
  session state at launch (runtime kind, whether the local SQLite store is initialized,
  the selected season's local row count, and whether a cached workspace exists).

## Bug Details

### Bug Condition

The bug manifests on a **cold start**: the app runs in the native (Tauri) runtime, the
local SQLite store has never been initialized on this machine, the selected season has
zero rows locally, and there is no cached workspace. Under this condition two things go
wrong: (1) the fixed 5000ms startup race can resolve as `timeout` on a slow first launch
and show a misleading banner, and (2) when seeding the baseline cannot complete (no
session, no network, or query unavailable), the loader surfaces a generic, non-actionable
"Load Failed" modal rather than telling the operator the season must be downloaded.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type AppStartupContext
  OUTPUT: boolean

  // Cold start: first launch on a machine with no local data.
  RETURN X.isNativeRuntime = true
     AND X.localSqlStoreInitialized = false
     AND X.localSeasonRowCount = 0
     AND X.cachedWorkspacePresent = false
END FUNCTION
```

The non-buggy case ¬C(X) is a **warm start**: the local store is already initialized
and/or the selected season already has local rows (or there are no seasons at all, or the
runtime is not native).

### Examples

- **Spurious banner (cold start):** Install on a clean PC, launch. First-launch web/cache
  clear plus contention on a slow disk pushes the raced work past 5000ms; the race
  resolves `timeout`, and the banner "UI startup cleanup timed out. Continuing with
  existing local session data." appears even though there were never pending changes and
  nothing failed. *Expected:* startup completes with no misleading banner.
- **Generic Load Failed, signed out (cold start):** Clean PC, not yet signed in, open
  `/daily`. `ensureNativeSeasonBaseline` cannot fetch the server snapshot (no access
  token via `runNativeSeasonCatchup`'s token path / `getSeasonWorkspaceSnapshot` fails),
  the loader throws, and a generic "Load Failed" / "Could not load daily schedule data
  from the server." modal appears. *Expected:* a specific `signed-out` message with a
  sign-in action.
- **Generic Load Failed, offline (cold start):** Clean PC, signed in, but offline. Server
  snapshot fetch fails with a network error; loader shows generic "Load Failed".
  *Expected:* a specific `network-unavailable` message with a retry action.
- **Query unavailable (cold start):** Season not seeded; `queryNativeScheduleWindow`
  returns a falsy result and the loader throws `'Native ... query is unavailable.'`
  *Expected:* a `not-downloaded` message with a download action.
- **Warm start (edge / preservation):** PC already has the season locally; opening
  `/gate` loads from the native store with no re-seed and no banner. *Expected: unchanged.*

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors (warm start and non-cold-start cases must behave identically to `F`):**

- 3.1 Launch on a PC with an initialized native SQLite store and existing local data
  SHALL continue to run startup cleanup, discard pending edits when requested, and start
  without showing the timeout banner.
- 3.2 When startup cleanup genuinely hangs or throws for a reason unrelated to
  first-launch initialization, the system SHALL continue to surface a warning and let the
  user proceed rather than blocking startup indefinitely.
- 3.3 Loading a schedule page where the selected season already exists in the native
  store SHALL continue to load gate, daily, and check-in data from the native store
  without re-seeding from the server.
- 3.4 When there are genuinely no seasons available (empty remote season list), the system
  SHALL continue the existing empty-state behavior (no season selected, empty schedule),
  not a load error.
- 3.5 When local session edits exist and startup cleanup discards them with
  `discardPendingLocalChanges: true`, the system SHALL continue to discard those changes
  while preserving auth (`preserveAuth: true`) and resetting the undo session.
- 3.6 When the operator is signed in and the baseline is present locally, the system SHALL
  continue background catch-up sync (`runNativeSeasonCatchup`) and auto-save exactly as
  today.

**Scope:**
All inputs where `isBugCondition(X)` is false must be completely unaffected by this fix.
This includes:
- Warm starts with an initialized store / already-seeded seasons.
- The non-native (browser) runtime path in `NativeStartupSessionReset` (returns `ready`
  immediately) and the `null` early-returns in `ensureNativeSeasonBaseline` /
  `queryNative*` when not in Tauri.
- The empty-season-list empty state.
- Genuine cleanup hangs/errors (the warning path must remain).

**Note:** The actual expected correct behavior on a cold start is defined in the
Correctness Properties section below (Property 1 for the banner, Property 2 for the load).
This section enumerates what must NOT change (Property 3, preservation).

## Hypothesized Root Cause

Based on analysis of the current code (not the original report, which assumed the heavy
SQLite init runs inside the startup race), the most likely causes are:

1. **Fixed wall-clock race with a misleading label (banner).** The startup work is run as
   `Promise.race([clearNativeAppSessionData(...), timeoutAfter(5000)])`. A fixed 5000ms
   deadline can lose on a slow/contended first launch even though the actual raced work
   (web-storage clear + in-memory cache clear) is cheap and safe. When the timer wins,
   `result === 'timeout'` sets the warning banner. The banner text talks about "cleanup"
   timing out, which is misleading: nothing failed, and there were no pending changes.
   The race conflates "give up waiting" with "something went wrong."

2. **No distinction between first-launch initialization and edit-discard cleanup.** The
   timeout was conceptually meant to guard the *discard* path (which can do real work),
   but with `discardPendingLocalChanges: false` at startup the discard path is not even
   taken. There is no signal that lets the component treat a slow-but-progressing
   first-launch differently from a genuine hang (regression 3.2).

3. **Loader error messages are generic and lose the cause.** In the loaders' `catch`
   blocks (`#[[file:../../../app/src/app/daily/page.tsx]]`,
   `#[[file:../../../app/src/app/gate/page.tsx]]`,
   `#[[file:../../../app/src/app/checkin/page.tsx]]`), any error from
   `ensureNativeSeasonBaseline` or a falsy `queryNative*` result is funneled into
   `showAlert({ title: 'Load Failed', message, tone: 'error' })` with a generic string.
   The distinct underlying causes — not signed in (no access token), network unavailable,
   season not downloaded / query unavailable — are collapsed into one opaque message with
   no action.

4. **Read can run against an unready store.** Because seeding (`ensureNativeSeasonBaseline`)
   and the subsequent `queryNative*` read are sequential awaits with no explicit guarantee
   that the local SQLite store finished initializing/migrating, a partially initialized
   store can produce a falsy/empty query result that becomes a generic failure. The fix
   must ensure the store is initialized before the read.

## Correctness Properties

Property 1: Bug Condition — Startup completes without a spurious timeout banner

_For any_ input `X` where the bug condition holds (`isBugCondition(X)` returns true), the
fixed startup reset `startupReset'(X)` SHALL complete local startup without showing the
"UI startup cleanup timed out" banner when nothing actually failed, and SHALL ensure the
local store is initialized (`localStoreInitialized = true`) before the first schedule load
starts (`firstScheduleLoadStarted`). A warning SHALL only be shown for a genuine
hang/failure, not for slow-but-successful first-launch initialization.

**Validates: Requirements 2.1, 2.2, 2.5**

Property 2: Bug Condition — Cold-start data load succeeds or fails actionably

_For any_ input `X` where the bug condition holds (`isBugCondition(X)` returns true), the
fixed loader `loadSchedule'(X)` SHALL either (a) load successfully after seeding the
season's server baseline (`loadedFromSeededBaseline = true` and `records.count >= 0`), or
(b) fail with a specific, actionable error whose `kind` is one of
`{ 'not-downloaded', 'signed-out', 'network-unavailable' }`. In all cases the generic
"Load Failed" message SHALL NOT be the surfaced result
(`error.isGenericLoadFailed = false`).

**Validates: Requirements 2.3, 2.4**

Property 3: Preservation — Warm start and non-cold-start behavior unchanged

_For any_ input `X` where the bug condition does NOT hold (`isBugCondition(X)` returns
false), the fixed functions SHALL produce the same result as the original functions:
`startupReset(X) = startupReset'(X)` and `loadSchedule(X) = loadSchedule'(X)`, preserving
warm-start startup (no banner, correct edit-discard with `preserveAuth`/undo reset),
genuine-hang warnings, native-store loads without re-seed, the empty-season empty state,
and background catch-up/auto-save.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

Assuming the root-cause analysis is correct, the fix has two independent parts: the
startup banner and the cold-start data load.

### Part A — Startup banner (`NativeStartupSessionReset`)

**File**: `#[[file:../../../app/src/app/components/NativeStartupSessionReset.tsx]]`

**Function**: the `useEffect` startup routine and its `Promise.race`.

**Specific Changes**:

1. **Distinguish "still initializing" from "failed".** Replace the single
   `result === 'timeout' → show banner` rule. When the timer fires but the cleanup promise
   has not rejected, treat it as *still in progress*: keep awaiting the cleanup promise
   (do not show the timeout banner), updating progress to an indeterminate "Preparing
   local data" state. Only show a warning if the cleanup promise actually **rejects**
   (genuine error) — preserving regression 3.2.

2. **Guard genuine hangs without a misleading message.** Keep a hard upper bound for a
   genuine hang, but (a) raise/relax the soft deadline so a normal slow first launch does
   not trip it, and (b) reword the warning so it only appears on a real failure or a true
   hard-timeout hang, not on a normal slow init. The warning copy SHALL no longer claim
   "cleanup timed out" for the success-but-slow case.

3. **Ensure store readiness before proceeding.** Before setting `ready = true`, ensure the
   local store initialization the loaders depend on is either complete or explicitly
   awaited, so the first schedule load does not begin against an unready store
   (Property 1 / requirement 2.5). This can reuse the existing lazy
   `getSqlDbForLocalStore()` initialization by awaiting an initialization entrypoint
   rather than relying on the cleanup race as a proxy.

4. **Preserve the non-native and warm paths exactly.** The `!native` early return and the
   warm-start flow (where cleanup resolves well within the deadline) must remain
   byte-for-byte equivalent in observable output (no banner, same progress completion),
   satisfying Property 3.

### Part B — Cold-start data load (loaders + a shared classifier)

**Files**:
- `#[[file:../../../app/src/app/daily/page.tsx]]`
- `#[[file:../../../app/src/app/gate/page.tsx]]`
- `#[[file:../../../app/src/app/checkin/page.tsx]]`
- New shared helper (e.g. `app/src/lib/coldStartLoadError.ts`) for failure classification.
- `#[[file:../../../app/src/lib/nativeSeasonBootstrap.ts]]` (typed failure surfacing only,
  if needed — no behavior change to the happy path).

**Specific Changes**:

1. **Add a failure classifier.** Introduce a typed result/error with a `kind` field in
   `{ 'not-downloaded', 'signed-out', 'network-unavailable' }`. Classify by inspecting the
   thrown cause:
   - `signed-out`: no Supabase access token / session (mirror the `null` signal from
     `runNativeSeasonCatchup` and `getSession`), or the snapshot fetch fails auth.
   - `network-unavailable`: fetch/transport errors (reuse the offline/network heuristics
     already present in `#[[file:../../../app/src/lib/seasonAutoSync.ts]]`:
     "failed to fetch", "network", "timeout", and `navigator.onLine === false`).
   - `not-downloaded`: season not yet seeded locally and the baseline could not be
     obtained for a non-auth, non-network reason — including the
     `'Native ... query is unavailable.'` / snapshot-unavailable cases.

2. **Guarantee store initialization before read.** Ensure the local SQLite store is
   initialized before `queryNative*` runs (e.g. await the same initialization entrypoint
   used by Part A / `getSqlDbForLocalStore`), so a cold-start read never hits an unready
   store and silently returns falsy (requirement 2.5, Property 1's ordering clause).

3. **Replace the generic modal with specific, actionable messaging.** In each loader's
   `catch`, classify the error and call `showAlert` with a `kind`-specific title, message,
   and action instead of the generic `{ title: 'Load Failed', ... }`:
   - `not-downloaded` → "This season hasn't been downloaded to this PC yet." + a
     **Download** action that triggers `ensureNativeSeasonBaseline(targetSeason)` and
     retries the load.
   - `signed-out` → "Sign in to download this season's schedule." + a **Sign in** action.
   - `network-unavailable` → "Can't reach the server to download this season." + a
     **Retry** action.
   Set `loadError` to the specific message so the inline error state matches.

4. **Preserve the success and warm paths.** When `ensureNativeSeasonBaseline` succeeds and
   `queryNative*` returns records (warm start or successful cold-start seed), the loaders
   must behave exactly as today (same state updates, same cache patching), satisfying
   Property 3 (3.3) and the success branch of Property 2.

5. **Preserve the empty-season and non-native paths.** The `nextSeasons.length === 0`
   empty-state branch and the non-Tauri `null` returns must be untouched (3.4).

## Testing Strategy

### Validation Approach

The strategy is two-phase: first surface counterexamples that demonstrate the bug on the
**unfixed** code (confirm or refute the root-cause hypotheses), then verify the fix
satisfies the cold-start properties (fix checking) and leaves warm-start behavior
unchanged (preservation checking). Because `isBugCondition` is precisely defined, tests
partition inputs into C(X) (cold start) and ¬C(X) (warm start / other).

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix,
and confirm or refute the root cause. If refuted, re-hypothesize.

**Test Plan**: Drive `NativeStartupSessionReset` and the loaders under a simulated cold
start (native runtime stubbed true, local store uninitialized, zero local season rows, no
cached workspace). Run on the UNFIXED code to observe the banner and the generic modal.

**Test Cases**:
1. **Banner under slow init**: Simulate `clearNativeAppSessionData` resolving just after
   5000ms (or the timer winning) and assert the unfixed code shows
   "UI startup cleanup timed out..." (will fail to meet Property 1 on unfixed code).
2. **Generic Load Failed — signed out**: Stub `ensureNativeSeasonBaseline` to throw an
   auth/no-token failure; assert the unfixed loader shows generic "Load Failed" / "Could
   not load ... from the server." (will fail Property 2 on unfixed code).
3. **Generic Load Failed — offline**: Stub the snapshot fetch to throw a network error;
   assert unfixed loader shows generic "Load Failed".
4. **Generic Load Failed — query unavailable**: Stub `queryNative*` to return a falsy
   value so the loader throws `'Native ... query is unavailable.'`; assert generic modal.
5. **Edge — read before ready**: Force `queryNative*` to observe an unready store and
   return empty; assert the unfixed code surfaces a generic failure rather than seeding.

**Expected Counterexamples**:
- Startup shows the timeout banner on a slow-but-successful first launch.
- Loaders show a single generic "Load Failed" modal regardless of the real cause (signed
  out vs. offline vs. not-downloaded), with no actionable next step.
- Possible causes: fixed 5000ms race + misleading label; un-classified loader `catch`;
  read against unready store.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed functions
produce the expected behavior (Property 1 and Property 2).

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  // Property 1 — banner
  r1 := startupReset'(X)
  ASSERT r1.timeoutBannerShown = false
  ASSERT r1.localStoreInitialized = true BEFORE r1.firstScheduleLoadStarted

  // Property 2 — data load
  r2 := loadSchedule'(X)
  ASSERT (r2.loadedFromSeededBaseline = true AND r2.records.count >= 0)
      OR (r2.error.isActionable = true
          AND r2.error.kind IN { 'not-downloaded', 'signed-out', 'network-unavailable' })
  ASSERT r2.error.isGenericLoadFailed = false
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed
functions produce the same result as the original functions.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT startupReset(X) = startupReset'(X)
  ASSERT loadSchedule(X) = loadSchedule'(X)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking
because:
- It generates many warm-start / non-cold-start contexts automatically across the input
  domain (initialized vs. uninitialized store, seeded vs. unseeded season, native vs.
  browser, empty vs. non-empty season list, edits-present vs. none).
- It catches edge cases manual tests miss (e.g. season list empty AND store initialized).
- It gives strong assurance that observable behavior is unchanged for every non-buggy
  input.

**Test Plan**: Observe behavior on UNFIXED code first for warm starts (no banner, native
load without re-seed, edit-discard with `preserveAuth`/undo reset, empty-season empty
state, genuine-hang warning), then write tests asserting the fixed code matches.

**Test Cases**:
1. **Warm-start startup**: Observe that an initialized store starts with no banner on
   unfixed code; assert this is unchanged after the fix (3.1).
2. **Genuine hang/error warning**: Observe that a rejecting/hanging cleanup still surfaces
   a warning and proceeds on unfixed code; assert preserved after the fix (3.2).
3. **Native load without re-seed**: Observe that an already-seeded season loads from the
   native store without calling the server snapshot on unfixed code; assert unchanged (3.3).
4. **Empty-season empty state**: Observe the no-season empty state (no error) on unfixed
   code; assert unchanged (3.4).
5. **Edit-discard cleanup**: Observe `discardPendingLocalChanges: true` discards edits
   while preserving auth and resetting the undo session; assert unchanged (3.5).
6. **Background catch-up/auto-save**: Observe `runNativeSeasonCatchup` + auto-save run for
   a signed-in, seeded season; assert unchanged (3.6).

### Unit Tests

- Startup reset: timer-wins-but-cleanup-succeeds shows NO banner; cleanup-rejects shows a
  warning; non-native path returns ready immediately.
- Failure classifier: maps no-token → `signed-out`, network/offline → `network-unavailable`,
  snapshot-unavailable / `'... query is unavailable.'` → `not-downloaded`.
- Each loader `catch`: produces a `kind`-specific title/message/action and never the
  generic "Load Failed" for cold-start failures.
- Store-readiness: read is not attempted until store initialization resolves.

### Property-Based Tests

- Generate cold-start contexts (C(X)) and assert Property 1 (no spurious banner, store
  ready before first load) and Property 2 (seeded-success OR actionable `kind`, never
  generic) hold for all of them.
- Generate warm-start / non-cold-start contexts (¬C(X)) and assert Property 3:
  `startupReset` and `loadSchedule` outputs are identical between `F` and `F'`.
- Generate random failure causes and assert the classifier always yields exactly one of
  the three actionable kinds and never the generic message.

### Integration Tests

- Full cold-start flow on a simulated clean machine (no `seasonal-management-local.db`, no
  IndexedDB): launch → startup completes with no banner → open `/daily`, `/gate`,
  `/checkin` → either schedule renders after seeding or an actionable modal with a working
  Download / Sign in / Retry action appears, and the action recovers the load.
- Context switching: cold-start seed one season, switch to another unseeded season, and
  verify the seed + load (or actionable error) repeats correctly per season.
- Warm-start regression: relaunch after a successful cold start and verify native load
  without re-seed, no banner, and unchanged background catch-up/auto-save.
