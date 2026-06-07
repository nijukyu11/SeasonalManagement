# Bugfix Requirements Document

## Introduction

When the Tauri desktop app is installed on a brand-new PC (a cold start with no local
data — no native SQLite season rows, no IndexedDB, no cached workspace), the app fails
to load schedule data. Two visible symptoms appear:

1. A warning banner reading "UI startup cleanup timed out. Continuing with existing
   local session data." is shown during startup.
2. A "Load Failed" modal pops up when a schedule page (gate / daily / check-in) tries
   to read data.

Investigation of the startup and load paths shows two distinct defects that combine on
a fresh machine:

- **Startup cleanup timeout (banner):** `NativeStartupSessionReset` runs
  `clearNativeAppSessionData({ discardPendingLocalChanges: true, ... })` inside a
  `Promise.race` against a fixed 5000ms timeout. That call chains into
  `discardAllLocalPendingChanges()` → `getSqlDbForLocalStore()` →
  `getLocalSeasonSqlDatabase()` (loads the Tauri SQL plugin, opens the database, and
  runs the full schema migration) → `ensureSqlSeededFromIndexedDb()`. On a brand-new
  PC this is the first time the local SQLite database is created and migrated, so the
  one-time initialization can exceed 5000ms. The race resolves as `timeout`, the
  spurious banner is shown, and startup continues before the local store is ready —
  even though there were never any pending local changes to discard.

- **No cold-start baseline seed (Load Failed):** The schedule page loaders
  (`app/src/app/gate/page.tsx`, `daily/page.tsx`, `checkin/page.tsx`) only *query* the
  native SQLite store via `queryNativeAllocationWindow` / `queryNativeScheduleWindow`.
  No code path seeds the selected season's server baseline (source rows, flight
  records, modifications) into the native store on first launch — `ensureNativeLocalSeason`
  is only invoked inside the daily-import flow. On a fresh machine the season list may
  load from the remote store, but the native query returns no records or fails because
  the local season has never been populated, so the loader throws and surfaces a
  generic "Load Failed" modal. The message does not tell the operator that the season
  simply needs to be downloaded, nor does it offer a way to download it.

This bugfix targets the cold-start (first-launch with no local data) experience so the
app either loads season data successfully on a new PC, or presents an actionable,
specific message instead of a spurious timeout banner plus a generic load failure.

## Bug Analysis

### Current Behavior (Defect)

These describe what currently happens during a cold start (first launch on a machine
with no local SQLite data, no IndexedDB data, and no cached workspace).

1.1 WHEN the app launches on a new PC and `NativeStartupSessionReset` runs startup
cleanup, AND the one-time native SQLite database creation/migration plus IndexedDB
seeding takes longer than the fixed 5000ms `STARTUP_CLEANUP_TIMEOUT_MS`, THEN the
system loses the `Promise.race`, shows the banner "UI startup cleanup timed out.
Continuing with existing local session data.", and continues startup before the local
store is confirmed ready.

1.2 WHEN the app performs startup cleanup on a new PC where there are no pending local
changes to discard, THEN the system still forces full native SQLite database
initialization and migration inside the timed cleanup race, doing first-launch
initialization work under a deadline that was intended only for discarding edits.

1.3 WHEN a schedule page (gate, daily, or check-in) loads on a new PC and the selected
season has no rows in the native SQLite store, THEN the system's native query
(`queryNativeAllocationWindow` / `queryNativeScheduleWindow`) returns no usable data or
throws, because no cold-start path ever seeded the season's server baseline into the
native store.

1.4 WHEN the native query fails or returns no data during a cold-start load, THEN the
system shows a generic "Load Failed" modal whose message ("Could not load ... data from
the server." / "Native ... query is unavailable.") does not indicate that the season
has not yet been downloaded to this machine and offers no way to download it.

1.5 WHEN the startup cleanup race times out (1.1) and the schedule load proceeds before
the local store is ready, THEN the system attempts to read season data from an
uninitialized or partially initialized local store, contributing to the "Load Failed"
modal.

### Expected Behavior (Correct)

These describe what should happen for the same cold-start conditions.

2.1 WHEN the app launches on a new PC and first-launch native SQLite database
creation/migration plus IndexedDB seeding takes longer than usual, THEN the system
SHALL complete local store initialization without showing a misleading
"startup cleanup timed out" banner, distinguishing first-launch initialization from the
edit-discard cleanup that the timeout was meant to guard.

2.2 WHEN the app performs startup cleanup on a new PC where there are no pending local
changes to discard, THEN the system SHALL NOT fail or warn solely because one-time
local store initialization is in progress; initialization SHALL be allowed to finish
(or be awaited separately from the discard step) so startup does not proceed against an
unready store.

2.3 WHEN a schedule page (gate, daily, or check-in) loads on a new PC and the selected
season has no rows in the native SQLite store, THEN the system SHALL seed that season's
server baseline (source rows, flight records, modifications, sync cursor) into the
native store and then load the schedule successfully, OR present a specific, actionable
message that the season must be downloaded together with a way to start that download.

2.4 WHEN a cold-start load cannot obtain season data after attempting to seed the
baseline (for example the remote fetch fails or the operator session is not yet
established), THEN the system SHALL show a specific, actionable error explaining the
cause (not yet downloaded, not signed in, or network unavailable) and an appropriate
retry/sign-in/download action, rather than the generic "Load Failed" message.

2.5 WHEN startup cleanup and the first schedule load occur on a new PC, THEN the system
SHALL ensure the local store is initialized before reading season data, so the load
does not run against an unready store.

### Unchanged Behavior (Regression Prevention)

These describe existing behavior on machines that already have local data (warm start)
or other non-cold-start conditions, which must be preserved.

3.1 WHEN the app launches on a PC that already has an initialized native SQLite store
with existing local data, THEN the system SHALL CONTINUE TO run startup cleanup,
discard pending local session edits when requested, and start without showing the
timeout banner.

3.2 WHEN startup cleanup genuinely hangs or fails for a reason unrelated to first-launch
initialization (for example a real deadlock or a thrown error), THEN the system SHALL
CONTINUE TO surface a warning and allow the user to proceed rather than blocking
startup indefinitely.

3.3 WHEN a schedule page loads on a PC where the selected season already exists in the
native SQLite store, THEN the system SHALL CONTINUE TO load gate, daily, and check-in
schedule data from the native store without re-seeding from the server.

3.4 WHEN there are genuinely no seasons available (the remote season list is empty),
THEN the system SHALL CONTINUE TO show the existing empty-state behavior (no season
selected, empty schedule) rather than a load error.

3.5 WHEN local session edits exist and startup cleanup discards them with
`discardPendingLocalChanges: true`, THEN the system SHALL CONTINUE TO discard those
pending changes while preserving authentication (`preserveAuth: true`) and resetting the
undo session as before.

3.6 WHEN the operator is signed in and the season baseline is present locally, THEN the
system SHALL CONTINUE TO perform background catch-up sync (`runNativeSeasonCatchup`) and
auto-save of pending changes exactly as it does today.

## Bug Condition and Properties

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type AppStartupContext
  OUTPUT: boolean

  // A cold start is a first launch on a machine with no local data:
  // no native SQLite season rows, no IndexedDB workspace, no cached workspace.
  RETURN X.isNativeRuntime = true
     AND X.localSqlStoreInitialized = false
     AND X.localSeasonRowCount = 0
     AND X.cachedWorkspacePresent = false
END FUNCTION
```

In words, the bug condition C(X) holds for the **cold-start / first-launch** case:
native (Tauri) runtime, the local SQLite store has not been initialized before, the
selected season has no local rows, and there is no cached workspace. The non-buggy case
¬C(X) is a **warm start** where the local store is already initialized and/or the
season already exists locally (or there are no seasons at all).

### Property: Fix Checking — Startup banner

```pascal
// For every cold start, first-launch initialization must not produce the
// spurious "startup cleanup timed out" banner, and startup must not proceed
// against an unready local store.
FOR ALL X WHERE isBugCondition(X) DO
  result ← startupReset'(X)
  ASSERT result.timeoutBannerShown = false
  ASSERT result.localStoreInitialized = true BEFORE result.firstScheduleLoadStarted
END FOR
```

### Property: Fix Checking — Data load

```pascal
// For every cold start, loading a schedule page must either succeed after
// seeding the server baseline, or fail with a specific, actionable message
// (never the generic "Load Failed" with no guidance).
FOR ALL X WHERE isBugCondition(X) DO
  result ← loadSchedule'(X)
  ASSERT (result.loadedFromSeededBaseline = true AND result.records.count >= 0)
      OR (result.error.isActionable = true AND result.error.kind IN
           { 'not-downloaded', 'signed-out', 'network-unavailable' })
  ASSERT result.error.isGenericLoadFailed = false
END FOR
```

### Property: Preservation Checking

```pascal
// For every warm start / non-cold-start case, the fixed app must behave
// identically to the original app.
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT startupReset(X)  = startupReset'(X)
  ASSERT loadSchedule(X)  = loadSchedule'(X)
END FOR
```

**Key definitions**

- **F** (`startupReset`, `loadSchedule`): the original startup-cleanup and schedule-load
  behavior before the fix.
- **F'** (`startupReset'`, `loadSchedule'`): the fixed behavior after the fix.
- **Counterexample:** Install the app on a clean PC (no
  `seasonal-management-local.db`, no IndexedDB), sign in, open `/daily`. The startup
  banner appears and a "Load Failed" modal pops up instead of the season's schedule
  loading.
