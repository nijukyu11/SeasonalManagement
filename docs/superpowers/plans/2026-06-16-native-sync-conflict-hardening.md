# Native Sync Conflict & Race-Condition Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate known correctness bugs and race conditions in the native seasonal sync pipeline: substring-targeted pending-op cleanup, read/write races between JS and Rust, two-source sync summary drift, manual-fetch cursor loss, and optimistic UI flash. Land the fixes in vertical slices that each ship a regression test, code change, and a verification gate.

**Architecture:** Treat Rust `rusqlite` as the single writer; TypeScript `localSeasonSqlStore` continues to be a single-writer queue (`sqlWriteQueueTail`) but must extend the same queue to reads that participate in a read-modify-write flow. Snapshot-merge and conflict-cleanup paths in Rust use a structural `modHistory` match (parse the JSON, compute the legId set, drop only when the set is a subset of the resolving target) instead of `LIKE` pattern matches. Gate page surfaces a single `syncStatus` source of truth so debounced optimistic state never collides with native state. Manual fetch checks the workspace freshness signal (record count + entity version count + pending count) before choosing a cursor. Optimistic-view reset uses the `LocalSyncMeta.localRevision` counter, not a non-existent view field.

**Tech Stack:** Tauri + Rust (`rusqlite`, `tokio::sync::Mutex` writer lock), Next.js, TypeScript, `@tauri-apps/plugin-sql`, existing `app/src-tauri/tests/native_catchup.rs` Rust test harness, `app/scripts/rule-regression-tests.cjs` regression harness.

## Implementation Status - 2026-06-16

Implemented in the current workspace:

- Rust conflict cleanup now structurally parses pending `modHistory` payloads, including `changes[].legId`, `previousMod.legId`, `newMod.legId`, `recordChanges[].recordId`, `previousRecord.id`, and `newRecord.id`. Mixed/cross-target history is preserved unless every parsed target belongs to the resolved target set.
- `query_sync_summary` now returns `localRecordCount` and `entityVersionCount`. `SeasonSyncProvider` uses these counts to detect a truly fresh local workspace and starts catch-up from cursor `0` when appropriate.
- `applyLocalModificationBatchDelta` now uses `replaceLocalSeasonSqlPendingStateFromDelta`, keeping delta read, compute, and pending-state write inside one queued SQL transaction.
- `SeasonAutoSyncState` carries `localRevision`, and provider summary/workspace-change updates copy native `localRevision`.
- Gate sync status uses provider state seeded by `seedSeasonSyncFromNative`; the route-local `syncSummary` timer path was removed.
- Gate optimistic view reset is gated by provider `localRevision`, with explicit base-change resets still clearing the overlay.
- Task 3 from an earlier draft is intentionally dropped as implementation work. Native mutation paths already clear/dirty `local_derived_seasonal`, so no broad TS derived-cache rewrite was added.

Verification already run for this implementation pass:

```text
npm run test:rules
node --experimental-strip-types --test src/lib/localSeasonSqlStore.test.ts
cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup
npx tsc --noEmit --pretty false
npm run test:notifications
npm run test:updater
npm run build
```

Not run by design: no backup, no git commit, and no `npm run native:build`. Native build remains a release/integration gate only.

---

## File Structure

- Modify `app/src-tauri/src/native_catchup.rs`
  - Replace substring `LIKE` cleanup with structural `modHistory` matching (parse payload, compute legId set, drop only when the set is a subset of the resolving target); cover the auto-resolved and `acceptRemote` paths. Add `local_record_count` and `entity_version_count` to `QuerySyncSummaryResult`.
- Modify `app/src-tauri/tests/native_catchup.rs`
  - Add regression tests that prove substring `target_id`s do not delete unrelated history, including a cross-leg history case. Add coverage for the new `QuerySyncSummaryResult` counts.
- Modify `app/src/lib/localSeasonSqlStore.ts`
  - Add a queued read helper and a `replaceLocalSeasonSqlPendingStateFromDelta` helper that owns the full read-modify-write flow inside a single `BEGIN IMMEDIATE` transaction.
- Modify `app/src/lib/localSeasonSqlStore.test.ts`
  - Add mock-DB regression tests for the queued transaction contract.
- Modify `app/src/lib/localSeasonStore.ts`
  - Refactor `applyLocalModificationBatchDelta` to use the new queued transaction helper. Do not add a broad TS `local_derived_seasonal` rewrite in this pass; native mutation paths already clear the derived cache.
- Modify `app/src/lib/seasonAutoSync.ts`
  - Add `localRevision: number | null` to `SeasonAutoSyncState`.
- Modify `app/src/app/components/SeasonSyncProvider.tsx`
  - Use a workspace freshness signal (record count, entity version count, pending count) for manual fetch cursor selection. Expose a `seedSeasonSyncFromNative(seasonId)` action and copy `localRevision` into the public state from `patchStateFromNativeSummary`.
- Modify `app/src/app/gate/page.tsx`
  - Collapse the duplicated `syncSummary` local state into the shared `useSeasonSync` hook (seeded from the native query), and synchronize the optimistic-view reset with `SeasonAutoSyncState.localRevision` instead of a non-existent view field.
- Modify `app/scripts/rule-regression-tests.cjs`
  - Add source-text coverage for the three call sites of `applyLocalModificationBatchDelta` (gate, checkin, detailed) and for the gate-page single-source sync summary.
- Modify `context.md`
  - Document the read-queue contract, the structural cleanup rule, the freshness signal, and the single-source sync summary after implementation.

Git is unavailable on PATH in this workspace, so commit steps are intentionally replaced with verification checkpoints.

---

## Issue Index

| ID | Severity | File | One-line |
|----|----------|------|----------|
| ISS-1 | High | `app/src-tauri/src/native_catchup.rs:2294` | Substring `LIKE` deletes unrelated `modHistory` pending ops. |
| ISS-2 | High | `app/src/lib/localSeasonSqlStore.ts:804` | `readLocalSeasonSqlDeltaState` reads outside the `sqlWriteQueueTail` queue and races with the Rust writer. |
| ISS-3 | Dropped | `app/src/lib/localSeasonStore.ts:701-737` | Earlier derived-cache proposal was not implemented because native mutation paths already clear/dirty `local_derived_seasonal`. |
| ISS-4 | Medium | `app/src/app/components/SeasonSyncProvider.tsx:414-432` | Manual fetch can pick a wrong cursor when the workspace is fresh (no rows, no entity versions, no pending ops) but `lastServerSeq` has been seeded by a prior partial pass. |
| ISS-5 | Medium | `app/src/app/gate/page.tsx:430-471` | Gate page has two debounced sources for `syncPendingCount` that drift apart. |
| ISS-6 | Low | `app/src/app/gate/page.tsx:698-700` | Optimistic view clear race with `allocationResult.view` update. |

---

## Task 1: Structural cleanup rule for snapshot/resolve paths (ISS-1)

**Files:**
- Modify: `app/src-tauri/src/native_catchup.rs`
- Modify: `app/src-tauri/tests/native_catchup.rs`

**Issue:** `remove_pending_ops_for_conflict_target` deletes `modHistory` rows whose `payload_json` matches `LIKE '%"leg-1"%'`. This function is called with `event.target_type`/`event.target_id` (line 2193, 2339, 4601) and in the `target_type == "modification"` case `target_id` is the `legId`. A `modHistory` entry stores `changes: [{ legId, previousMod, newMod }, ...]` so the substring search matches any history whose `changes[]` contains a leg with id `leg-1`. If another leg shares a substring prefix (e.g. `leg-1` vs `leg-10`) and the same history entry contains both legs (cross-leg history produced by pair operations), the resolution of `leg-1` also drops the history entries that document `leg-10` edits. The op_key branch (line 2280-2291) is correct for `modHistory` (`op_key = modHistory:{history_id}`) but only matches when `target_type == "modHistory"`. The `LIKE` branch is the only safety net for cross-leg history.

### Sub-task 1.1: Add a failing regression test for the substring trap

- [ ] **Step 1:** Open `app/src-tauri/tests/native_catchup.rs` and add a new test `auto_resolved_modification_conflict_does_not_drop_unrelated_modhistory_pending_ops` immediately after `dirty_stale_snapshot_merge_auto_accepts_remote_latest_allocation_modification_conflict`.
  - Seed:
    - One `modification` op for `leg-1` whose `target_id` is `leg-1` (this is the conflict that will be auto-resolved).
    - One `modHistory` op whose `changes[]` includes only `leg-1` (this MUST be deleted when `leg-1` resolves).
    - One `modHistory` op whose `changes[]` includes only `leg-10` (this is the substring bait and MUST survive).
    - One `modHistory` op whose `changes[]` includes both `leg-1` and `leg-10` (cross-leg history; document the desired behavior in the test docstring — see Sub-task 1.2 for the design).
  - Trigger `auto_resolve_remote_latest_conflict_events` for the `leg-1` modification conflict.
  - Assert:
    - `modHistory` entry tied only to `leg-1` is gone.
    - `modHistory` entry tied only to `leg-10` is still present.
- [ ] **Step 2:** Add a second test `accept_remote_conflict_resolution_does_not_drop_unrelated_modhistory_pending_ops` after the existing `acceptRemote` test, with the same seed pattern.
- [ ] **Step 3:** Run `cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup auto_resolved_modification_conflict_does_not_drop_unrelated_modhistory_pending_ops` and confirm red.

### Sub-task 1.2: Replace substring `LIKE` with structural target matching

The pending `modHistory` payload is `{ type: "modHistory", entry: { id, timestamp, description, changes: [{ legId, previousMod, newMod }] } }`. A history entry is "related" to a target leg when any of these match:
- `changes[i].legId == target_id`
- `changes[i].previousMod.legId == target_id`
- `changes[i].newMod.legId == target_id`
- `entry.id == target_id` (only meaningful when `target_type == "modHistory"`)

Cross-leg history entries (a single `modHistory` whose `changes[]` covers two different legs) are produced by the pair-deletion path and the auto-remote-latest modification path. **Design decision for this plan:** cross-leg history entries are considered related to any leg they touch, and are dropped when any of their legs is auto-resolved. This matches current behavior for the intended target but is unsafe for the sibling leg. The plan therefore drops only when **all** touched legs are being resolved in the same call, and otherwise leaves the entry alone. The Rust helper implements this by parsing the JSON and comparing sets, not by string match.

- [ ] **Step 1:** Add a private helper `fn mod_history_entry_legs(payload_json: &str) -> rusqlite::Result<Vec<String>>` in `app/src-tauri/src/native_catchup.rs` that:
  - Parses the JSON.
  - Returns the union of `entry.changes[*].legId`, `entry.changes[*].previousMod.legId`, `entry.changes[*].newMod.legId`.
  - Falls back to empty on parse error and logs a warning.
- [ ] **Step 2:** Add a second helper `fn mod_history_entry_history_id(payload_json: &str) -> Option<String>` that returns `entry.id`.
- [ ] **Step 3:** In `remove_pending_ops_for_conflict_target`, replace the `LIKE` branch with two cases:
  - When `target_type == "modHistory"`: load the candidate rows (`op_type = 'modHistory'`), filter in Rust to entries whose `entry.id == target_id`, and `DELETE … WHERE rowid IN (… )`.
  - When `target_type != "modHistory"` (e.g. `modification`, `flightRecord`): load candidate rows, filter in Rust to entries whose `legId` set is a subset of `{target_id}`. The intent is: drop the history entry only if every leg it touches is the one being resolved; leave cross-leg entries alone.
  - Use a single transaction so the `SELECT` and `DELETE` see a stable snapshot.
- [ ] **Step 4:** Apply the same refactor inside `resolve_season_conflict_on_connection`'s `acceptRemote` branch (line 2339).
- [ ] **Step 5:** Add a unit test `mod_history_entry_legs_parses_pair_deletion` that proves a pair-deletion history entry yields both legs.
- [ ] **Step 6:** Add a unit test `remove_pending_ops_for_conflict_target_keeps_cross_leg_history_when_only_one_leg_resolves` that seeds a `modHistory` covering `[leg-1, leg-10]`, calls the function with `target_id = "leg-1"`, and asserts the row survives.

### Sub-task 1.3: Verify

- [ ] Run `cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup` and confirm green.
- [ ] Manually re-run the auto-resolved merge and the `acceptRemote` resolution on a season with `leg-1` and `leg-10`; confirm the cross-leg history is preserved when only one leg resolves.

---

## Task 2: Read queue serialization for delta state (ISS-2)

**Files:**
- Modify: `app/src/lib/localSeasonSqlStore.ts`
- Modify: `app/src/scripts/rule-regression-tests.cjs`

**Issue:** `readLocalSeasonSqlDeltaState` reads directly from the database, outside the `sqlWriteQueueTail` queue. The Rust writer holds a `tokio::sync::Mutex` writer lock, but it does not coordinate with the JS read queue. A pending sync catchup that is mid-transaction in Rust can publish rows while a JS read returns `pendingOps` from before the catchup completed. The subsequent `replaceLocalSeasonSqlPendingState` then writes a `pendingCount` that no longer matches the on-disk pending ops.

### Sub-task 2.1: Add a queued read-modify-write helper for the full mutation flow

- [ ] **Step 1:** In `app/src/lib/localSeasonSqlStore.ts`, add a public `enqueueLocalSeasonSqlRead<T>(label: string, read: () => Promise<T>): Promise<T>` helper that chains on `sqlWriteQueueTail`. Use the same `[local-season-sql] write queue waited …` warning path with a `SQL_READ_QUEUE_WARN_MS = 200` constant.
- [ ] **Step 2:** Wrap the body of `readLocalSeasonSqlDeltaState` and `readLocalSeasonSqlSyncMeta` with `enqueueLocalSeasonSqlRead`.
- [ ] **Step 3:** Update the JSDoc above each function to call out the queue contract.

### Sub-task 2.2: Collapse the read-modify-write into a single queued transaction

The `applyLocalModificationBatchDelta` in `app/src/lib/localSeasonStore.ts:606` is the **only** function in the JS layer that follows the dangerous read-then-replace pattern: it reads via `readLocalSeasonSqlDeltaState`, computes the new pending ops in memory, then writes via `replaceLocalSeasonSqlPendingState`. Anything that touches the same `seasonId` between the two calls can race with the mutation. The `sqlWriteQueueTail` already serializes the writes, but the read happens before the write joins the queue, so another `enqueueSqlWrite` from a different caller can still interleave.

The other mutation entry points (`applyLocalFlightRecordMutation` line 701, `applyLocalModificationBatch` line 739, `applyLocalSourceRows` line 770) use the full-workspace `saveLocalSeasonWorkspace` path, which is already serialized by the queue. They are out of scope for the queued-transaction refactor; they remain on the existing read-then-save pattern.

`applyLocalModificationBatchDelta` is called from `app/src/app/gate/page.tsx:827` (via `persistGateModifications` → `commitGateModificationsInWorker` → `gateLocalCommitWorker`), `app/src/app/checkin/page.tsx:1023` (via `checkInLocalCommitWorker`), and `app/src/app/detailed/page.tsx` (per the existing rule-regression coverage at `app/scripts/rule-regression-tests.cjs:7553`). The refactor must preserve all three call sites.

- [ ] **Step 1:** Add `replaceLocalSeasonSqlPendingStateFromDelta(label, seasonId, compute: (state: LocalSeasonSqlDeltaState) => LocalSeasonSqlDeltaState | Promise<LocalSeasonSqlDeltaState>): Promise<void>` in `app/src/lib/localSeasonSqlStore.ts`. The helper must:
  - Acquire the queue slot (enqueue as a single write).
  - Run a `BEGIN IMMEDIATE` transaction inside the slot.
  - Read `LocalSeasonSqlDeltaState` for the affected leg ids.
  - Call the user-supplied `compute`.
  - Run the existing `replaceLocalSeasonSqlPendingState` write inside the same transaction.
  - `COMMIT` on success, `ROLLBACK` on error.
- [ ] **Step 2:** Refactor `applyLocalModificationBatchDelta` (`app/src/lib/localSeasonStore.ts:606`) to call the new helper instead of reading then writing. Keep the function's external signature and return value unchanged. The compute callback receives the same `LocalSeasonSqlDeltaState` shape that the read returned.
- [ ] **Step 3:** Add a JSDoc note on the queue contract: any read that participates in a JS-side read-modify-write must use `enqueueLocalSeasonSqlRead` or be folded into the queued transaction. The three full-save entry points (line 701, 739, 770) are exempt because they already serialize.

### Sub-task 2.3: Regression coverage for the queue contract

The existing test infrastructure at `app/src/lib/localSeasonSqlStore.test.ts` already has rich mock-DB helpers (see the `serializes concurrent SQL workspace saves to avoid nested Tauri transactions` test at line 387) and we can reuse it. Add the new tests in the same file rather than in `rule-regression-tests.cjs` (the latter is for UI/source-text checks, not DB behaviour).

- [ ] **Step 1:** In `app/src/lib/localSeasonSqlStore.test.ts`, add a test that:
  - Submits a slow `enqueueLocalSeasonSqlRead` (e.g. 200 ms) using a mock DB that records call order.
  - Submits a `enqueueSqlWrite` immediately after.
  - Asserts the read finishes before the write begins.
- [ ] **Step 2:** Add a test that submits two `applyLocalModificationBatchDelta` calls in parallel for the same `seasonId` with disjoint leg ids, and asserts that the second call's read sees the first call's pending ops. This proves the queued transaction is the boundary that prevents lost updates. The mock must observe the `BEGIN IMMEDIATE` / `COMMIT` boundaries, not just call ordering.
- [ ] **Step 3:** Add a test that asserts `readLocalSeasonSqlDeltaState` cannot observe pending ops from before a preceding `replaceLocalSeasonSqlPendingState` for the same season id when both go through the new `replaceLocalSeasonSqlPendingStateFromDelta` helper.
- [ ] **Step 4:** Note: `applyLocalModificationBatchDelta` is also called from `app/src/app/checkin/page.tsx:1023` and `app/src/app/detailed/page.tsx` (per the existing gate/checkin/detailed page rule-regression coverage at `app/scripts/rule-regression-tests.cjs:8204, 8697, 7553`). The new helper must keep all three call sites working. Add a source-text assertion in `rule-regression-tests.cjs` that each page still calls the function name (so a future rename to a different helper does not silently break parity).

### Sub-task 2.4: Verify

- [ ] Run `npm run test:rules` and confirm green.
- [ ] Run `npx tsc --noEmit --pretty false` and confirm green.

---

## Task 3: Dropped derived-cache rewrite (ISS-3)

**Status:** Dropped from implementation.

The earlier proposal to refresh `local_derived_seasonal` from TypeScript was intentionally not implemented. Current native mutation paths already clear/dirty the derived cache, and a broad TypeScript rewrite would add surface area without a proven stale-cache regression. Keep this item closed unless a focused regression demonstrates that a native mutation returns stale `derivedSeasonal` to a live reader.

Verification remains covered by the existing rule regression that native mutation workspaces keep `derivedSeasonal === null` where required.

---

## Task 4: Manual fetch pre-flights the cursor (ISS-4)

**Files:**
- Modify: `app/src/app/components/SeasonSyncProvider.tsx`

**Issue:** `catchUpSeason` reads `initialSummary.lastServerSeq` and `cursorState.serverHighWater`. If a season is brand new to the local cache, `lastServerSeq` is `0` and `serverHighWater` is the latest value Supabase has. The current code path branches on `backlog > 0`, but if `backlog` is reported as zero (for example because `serverHighWater` was cached in a previous sync), the catch-up may fall into the `MANUAL_FETCH_REPLAY_EVENT_WINDOW` path and miss events that pre-date the install.

### Sub-task 4.1: Use the workspace freshness signal, not just `lastServerSeq`

The original branch (`backlog > 0` ⇒ start from `lastServerSeq`) is already correct for seasons that have been seen before. The actual gap is when the local workspace is **fresh** (no rows, no entity versions, no pending ops) but `lastServerSeq` may have been seeded by an earlier pass — for example after a workspace reset, a partial import, or when a different client was used. The diagnosis in the previous revision of this plan was wrong: `lastServerSeq === 0` is not a reliable fresh-season indicator.

The native side does not currently expose `localRecordCount` or `entityVersionCount`. The `QuerySyncSummaryResult` struct in `app/src-tauri/src/native_catchup.rs:313` only has `pending_count`, `conflict_count`, `sync_status`, `last_local_change_at`, `last_server_seq`, and `local_revision`. The freshness signal needs new native plumbing.

- [ ] **Step 1:** Extend `QuerySyncSummaryResult` in `app/src-tauri/src/native_catchup.rs` with two new fields: `local_record_count: i64` (count of `local_flight_records` where `is_base = 0`) and `entity_version_count: i64` (count of `local_entity_versions`). Compute them inside `query_sync_summary_on_connection` (line 2638) with two extra `SELECT COUNT(*)` calls inside the same connection scope.
- [ ] **Step 2:** Update the `#[serde(rename_all = "camelCase")]` derive to expose them as `localRecordCount` and `entityVersionCount`. The TS interface `NativeSyncSummaryResult` in `app/src/lib/nativeSeasonCatchup.ts:142` will pick them up automatically.
- [ ] **Step 3:** Add a `workspaceIsFresh` signal in `app/src/app/components/SeasonSyncProvider.tsx` that returns `true` when:
  - `initialSummary.localRecordCount === 0`, AND
  - `initialSummary.entityVersionCount === 0`, AND
  - `initialSummary.pendingCount === 0`.
  Document the contract inline.
- [ ] **Step 4:** When `workspaceIsFresh && manualFetch`, force `catchUpStartSeq = 0` and `replayingRecentEvents = false`. Use the native sync summary as the only authority; do not consult `lastServerSeq` for this branch.
- [ ] **Step 5:** When `workspaceIsFresh && !manualFetch`, do not call `catchUpSeason` immediately — queue a background catch-up from `0` via the existing `runCatchUpSeasonRef` so the next `catching_up` cycle is consistent.
- [ ] **Step 6:** Add a Rust integration test that asserts `query_sync_summary_on_connection` returns the new counts correctly for: a fresh season (both zero), a season with records but no entity versions (records > 0, versions = 0), and a season with both (records > 0, versions > 0).

### Sub-task 4.2: Verify

- [ ] Run `npx tsc --noEmit --pretty false` and confirm green.
- [ ] Manual smoke: reset a season workspace via the Settings reset flow, trigger a manual fetch, confirm the catch-up window covers from `server_seq = 0`.

---

## Task 5: Single source of sync summary on the gate page (ISS-5)

**Files:**
- Modify: `app/src/app/gate/page.tsx`
- Modify: `app/scripts/rule-regression-tests.cjs`

**Issue:** The gate page keeps its own `syncSummary` state (updated by a 300 ms debounced `scheduleGateSyncSummaryUpdate`) and also reads `useSeasonSync(syncSeasonId, 'gate')` (which is updated by a 200 ms debounced `queryNativeSyncSummary`). Both sources read from the same native row, but through two different timers. For ~100-300 ms after a commit, the badge can show one value while the status label shows another.

### Sub-task 5.1: Seed the provider from the native query before removing local state

`useSeasonSync` already calls `context.ensureLiveSeason(seasonId)` in a `useEffect` (line 824 of `app/src/app/components/SeasonSyncProvider.tsx`). `ensureLiveSeason` (line 572) reads from the remote store and runs `runCatchUpSeason` — it does **not** synchronously seed the local `pendingCount`. The gap is that during the ~200 ms between mount and the first `patchStateFromNativeSummary` call, the gate page's `syncSummary.pendingCount` is `0` and the `useSeasonSync` `status.pendingCount` is `null`. The badge flashes "Synced" for the duration.

- [ ] **Step 1:** In `app/src/app/components/SeasonSyncProvider.tsx`, add a `seedSeasonSyncFromNative(seasonId)` action that calls `queryNativeSyncSummary(seasonId)` and `patchStateFromNativeSummary(seasonId, summary)` synchronously. Expose it from the context.
- [ ] **Step 2:** In `app/src/app/gate/page.tsx`, add a `useEffect` keyed on `syncSeasonId` that calls the seed action on mount before rendering the badge. The seed must be idempotent — repeated calls with the same `seasonId` must not trigger a re-render storm.
- [ ] **Step 3:** Verify the provider exposes a public seed action by exporting it from the `useSeasonSyncActions` hook (`app/src/app/components/SeasonSyncProvider.tsx:845`) and consuming it from the gate page.
- [ ] **Step 4:** Only after Steps 1-3 are in place, remove the `syncSummary` `useState`, the `scheduleGateSyncSummaryUpdate` debounced effect, the `gateSyncSummaryTimerRef`, the `pendingGateSyncSummaryRef`, the `clearGateCommitAccumulator` reset of those refs, and the `setSyncSummary` call sites at lines 563, 615, 645, 948, 1024.
- [ ] **Step 5:** Derive `syncPendingCount`, `syncLabel`, and `syncTone` exclusively from `useSeasonSync(syncSeasonId, 'gate')`. Do not fall back to `0` for a transient value; render the previous value or a loading indicator until the provider returns.
- [ ] **Step 6:** If the provider's initial value is genuinely `pendingCount = 0` after the seed, render the existing "Synced" badge — but only when the seed has been applied. Track the seed with a `hasSeededRef` and only show the synced badge when `hasSeededRef.current === true`.

### Sub-task 5.2: Regression coverage

- [ ] **Step 1:** In `app/scripts/rule-regression-tests.cjs`, add a render-level assertion that `GateAllocationContent` exposes only one sync-summary source (a static count of `syncSummary` setters in the compiled output, or a mock-store test of the page module if rendering is feasible).
- [ ] **Step 2:** If a static check is too brittle, write a small unit test that imports the gate page module and confirms it does not export `setSyncSummary`.

### Sub-task 5.3: Verify

- [ ] Run `npm run test:rules` and confirm green.
- [ ] Run `npx tsc --noEmit --pretty false` and confirm green.
- [ ] Run `npm run build` and confirm green.

---

## Task 6: Synchronize optimistic view reset with allocationResult.view (ISS-6)

**Files:**
- Modify: `app/src/app/gate/page.tsx`

**Issue:** `applyOptimisticGateModification` writes to `optimisticGateAllocationViewRef.current` and `setOptimisticGateAllocationView`. The reset effect runs on every `allocationResult.view` change. When a commit resolves very fast (the next `allocationResult.view` arrives before the optimistic state is fully consumed), the reset can fire mid-frame, causing a one-frame flash of base allocation data right after a successful commit.

### Sub-task 6.1: Plumb `localRevision` into the provider state and use it as the staleness signal

`GateAllocationView` is a derived projection that does not carry a `modificationRevision` field, so the previous plan was wrong. The actual source of truth for "the workspace has advanced past the optimistic base" is `LocalSyncMeta.localRevision` (the integer counter that increments on every native mutation). The native side already exposes it via `query_sync_summary` (`QuerySyncSummaryResult.local_revision` in `app/src-tauri/src/native_catchup.rs:320`, `NativeSyncSummaryResult.localRevision` in `app/src/lib/nativeSeasonCatchup.ts:149`). However, the JS provider strips it out: `SeasonAutoSyncState` (`app/src/lib/seasonAutoSync.ts:22`) has no `localRevision` field, and `patchStateFromNativeSummary` (`app/src/app/components/SeasonSyncProvider.tsx:319`) does not copy it. The provider only uses `localRevision` internally for `publishSeasonWorkspaceChanged` (lines 398, 482, 637).

- [ ] **Step 1:** Add `localRevision: number | null` to `SeasonAutoSyncState` in `app/src/lib/seasonAutoSync.ts`. Default to `null` in `createInitialSeasonAutoSyncState`.
- [ ] **Step 2:** In `patchStateFromNativeSummary` (`app/src/app/components/SeasonSyncProvider.tsx:319`), copy `summary.localRevision` into the new field.
- [ ] **Step 3:** In the `useSeasonSync` return shape (`app/src/app/components/SeasonSyncProvider.tsx:810`), `status.localRevision` is now available to consumers. Document the field in the JSDoc.
- [ ] **Step 4:** In `app/src/app/gate/page.tsx`, add a `optimisticBaseLocalRevisionRef = useRef<number | null>(null)`. When `applyOptimisticGateModification` fires, set it to the current `syncStatus.localRevision` (or to `null` if absent).
- [ ] **Step 5:** In the reset effect, only call `clearOptimisticGateAllocationView` when `syncStatus.localRevision != null && syncStatus.localRevision > (optimisticBaseLocalRevisionRef.current ?? -1)`. Otherwise leave the optimistic state in place.
- [ ] **Step 6:** Reset the ref to `null` whenever the user-driven base changes (`requestedRange` change, season switch, manual reset). Use the existing `clearOptimisticGateAllocationView` effect to also clear the ref.
- [ ] **Step 7:** The provider does not currently re-read `localRevision` on every render. Add a subscription so the provider state updates whenever the underlying `seasonSyncStateStore` mutates. Verify by reading the existing `useSyncExternalStore` subscription in `useSeasonSync` (line 813).

### Sub-task 6.2: Add a regression test

- [ ] **Step 1:** In `app/scripts/rule-regression-tests.cjs`, add a test that simulates a fast commit by feeding two `allocationResult.view` updates in the same microtask and asserts no reset fires in between. The test should set `optimisticBaseLocalRevisionRef.current = 5`, then call the reset effect twice with the same `localRevision = 5`, and assert that the second call did not clear the optimistic state.
- [ ] **Step 2:** Add a test that proves the reset fires when `localRevision` advances from `5` to `6`.

### Sub-task 6.3: Verify

- [ ] Run `npm run test:rules` and confirm green.
- [ ] Run `npx tsc --noEmit --pretty false` and confirm green.

---

## Cross-Cutting Verification

The implementation pass runs unit/regression/type gates. The full native release build is its own release gate and is **not** run inside this implementation pass (it requires platform toolchains that are out of scope for a feature branch).

- [x] **Rust unit/integration test:** `cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup` succeeded.
- [x] **JS rules regression:** `npm run test:rules` succeeded.
- [x] **SQL store regression:** `node --experimental-strip-types --test src/lib/localSeasonSqlStore.test.ts` succeeded.
- [x] **Notifications regression:** `npm run test:notifications` succeeded.
- [x] **Updater regression:** `npm run test:updater` succeeded.
- [x] **TypeScript:** `npx tsc --noEmit --pretty false` succeeded.
- [x] **Web build:** `npm run build` succeeded.
- [x] **Context doc:** `context.md` documents the read-queue contract, structural cleanup rule, freshness signal, `localRevision`, and single-source Gate sync summary.

### Release gate (separate, not part of this plan)

- [ ] **Native build (release gate only):** `npm run native:build` must succeed before merge. This step is intentionally not in the implementation pass because the toolchain cost and CI environment assumptions differ from a feature branch.

---

## Risk and Rollback Notes

- Task 1 is the only change that has a real data-loss surface. The previous revision of this plan suggested a `LIKE` with quoted-boundary fix; that suggestion is wrong and has been replaced with a structural match (parse payload, compute legId set, drop only when the set is a subset of the resolving target). If the structural match regresses, fall back to keeping the existing `LIKE` behavior for `target_type == "modHistory"` (where the op_key branch at line 2280 is already exact) and only change the `target_type != "modHistory"` branch. That scope is the only part that is actually unsafe today.
- Task 2 introduces a queued transaction that holds the writer lock for the duration of the read-modify-write. The refactor scope is narrow: only `applyLocalModificationBatchDelta` follows the read-then-replace pattern. The other three mutation entry points use full-workspace save and are already serialized. If a regression test fails because a test mock does not honor `BEGIN IMMEDIATE`, expose a `setLocalSeasonSqlReadQueueDisabledForTests(true)` test hook guarded by `process.env.NODE_ENV === 'test'`.
- Task 4 changes the cursor selection logic. The current `lastServerSeq === 0` heuristic was incorrect; the new logic uses a workspace freshness signal that requires native support for `localRecordCount` and `entityVersionCount` (added to `QuerySyncSummaryResult` in the same task). The Rust struct change is small and additive, but if the IPC contract must remain stable for a release, defer the JS-side change and gate it behind a feature flag.
- Task 6 requires extending the public `SeasonAutoSyncState` interface. The TS field is additive, so the change is backward compatible for existing consumers, but a typecheck pass is required to confirm no consumer breaks.
- Tasks 3, 5 are UX/UI fixes; the worst-case failure is a visual flash or a stale label, never data loss.
