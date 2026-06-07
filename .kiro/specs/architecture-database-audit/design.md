# Architecture & Database Audit Bugfix Design

## Overview

This design addresses 18 findings from an architecture- and database-level audit of the SeasonalManagement codebase (Tauri + SQLite + Supabase native-first runtime). Each finding is a concrete deviation from the documented invariants: native runtime as source of truth, exact `season_id` ownership, row-level sync, effective counts, AI safety, and pending ops as differences. The fix strategy is organized into six domains: Sync Correctness (Req 1–3), SQLite Schema (Req 4–5), Supabase Schema (Req 6–8), Dashboard AI Safety (Req 9–10), Code Health (Req 12–15), and Verification Gaps (Req 16–18).

## Glossary

- **Bug_Condition (C)**: The predicate over inputs/state that identifies the defective situation for each requirement
- **Property (P)**: The desired behavior when the bug condition holds — what the fix must establish
- **Preservation**: Existing correct behavior that must remain unchanged by the fix
- **`finalize_successful_pending_sync`**: Rust function in `native_catchup.rs` that promotes pending ops to base after successful V2 RPC
- **`build_native_pending_change_events`**: Rust function that constructs V2 change event DTOs from `local_pending_ops`
- **`validate_dashboard_ai_sql`**: Rust function that validates AI-generated SQL before execution against the temp view
- **`seasonSync.ts`**: Legacy TypeScript sync module that performs full-workspace saves; must be unreachable on native runtime
- **`promote_pending_ops_to_base`**: Rust function that rewrites current rows from base rows after successful sync
- **Effective count**: User-facing count after applying modifications (deleted mods subtract, added mods add)

## Bug Details

### Bug Condition

The audit surfaces 18 distinct bug conditions across six domains. The composite bug condition is:

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type SystemState (code path, schema state, or test coverage gap)
  OUTPUT: boolean

  RETURN syncPromotesEntireSeasonBase(input)              -- Req 1
         OR modificationDeleteLosesFieldEvidence(input)   -- Req 2
         OR legacySyncPathReachableOnNative(input)        -- Req 3
         OR hotQueryMissingCoveringIndex(input)           -- Req 4
         OR orphanIndexedDbBackupExists(input)            -- Req 5
         OR schemaBaselineDrifted(input)                  -- Req 6
         OR supersededRpcNotAnnotated(input)              -- Req 7
         OR aiRpcLacksOperatorGate(input)                 -- Req 8
         OR aiViewCountsDeletedMods(input)               -- Req 9
         OR aiValidatorBypassableViaComments(input)       -- Req 10
         OR firestoreAdapterMissingFlush(input)           -- Req 12
         OR firestoreAdapterLiveFallback(input)           -- Req 13
         OR corruptedSidecarInSourceTree(input)           -- Req 14
         OR applyLocalFallbackThrowsOpaque(input)         -- Req 15
         OR noTestForRevertClearsPendingOp(input)         -- Req 16
         OR noTestForTelegramPayloadRoundTrip(input)      -- Req 17
         OR noTestForMigrationIdempotency(input)          -- Req 18
END FUNCTION
```

### Examples

- **Req 1**: Save promotes 500 base modification rows for a season when only 3 legs were edited, producing unnecessary write amplification.
- **Req 2**: User deletes a modification locally; meanwhile another operator modifies the same leg remotely. The delete silently wins because `changedFields` is `["payload"]` with no base field version to conflict against.
- **Req 3**: A developer imports `syncSeasonWorkspace` directly in a new component on the native runtime; the full-workspace save path executes, violating the row-level invariant.
- **Req 4**: A season with 12,000 flight records takes 800ms for schedule-window query due to filesort on `sort_order`.
- **Req 9**: AI reports "450 active flights" while the dashboard shows "447 active flights" because 3 deleted modifications are not subtracted from the AI view.
- **Req 10**: AI generates `SELECT * FROM/**/sqlite_master` which bypasses the allowlist check because `FROM` is never produced as a standalone token.
- **Req 15**: Native IPC bridge returns null transiently; user sees "Native desktop full-workspace saves are disabled" instead of a retry prompt.
- **Req 16**: A regression in `is_no_op_modification_against_base_record` causes "Unsynced (1)" to persist after a manual revert; no test catches it.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Save with zero conflicts continues to clear pending ops, advance `lastServerSeq`, and flush notifications
- Conflict detection continues to surface items in `local_sync_meta.conflicts`
- Catch-up continues to use row-level upserts with cursor advance after commit
- Existing indexes (`idx_local_flight_records_lookup`, `idx_local_modifications_lookup`, etc.) remain in place
- `validate_dashboard_ai_sql` continues to reject semicolons, multi-statement SQL, and banned keywords
- Normal `SELECT ... FROM dashboard_ai_flight_operations` continues to execute with auto-applied LIMIT
- `supabaseStore.flushScheduleNotifications` continues to invoke `schedule-telegram-notify`
- Native `sync_pending_changes` continues to best-effort flush notifications
- `seasonal/page.tsx` continues to load `SeasonalSchedulePage` unchanged
- Existing verification commands (`test:rules`, `test:notifications`, `tsc --noEmit`, `build`, `native:build`) continue to work

**Scope:**
All inputs that do NOT trigger the specific bug conditions above should be completely unaffected by these fixes. This includes:
- Normal row-level edits through `runNativeScheduleMutation` and `runNativeLocalModificationBatchDelta`
- Gate/Check-in drag-drop through `applyLocalModificationBatchDelta`
- Export operations through `save_export_file`
- AI key rotation through `rotate-dashboard-ai-key`
- Settings management through `remoteStore`

## Hypothesized Root Cause

Based on the audit findings, the root causes cluster into six categories:

1. **Sync Implementation Shortcuts (Req 1, 2, 3)**: The sync layer was built incrementally. `finalize_successful_pending_sync` deletes all pending ops by `season_id` rather than by `op_id` because the dispatcher already gates on zero conflicts — correct by coincidence, not by construction. `promote_pending_ops_to_base` rewrites the entire base set because the original implementation predates per-leg tracking. The `modificationDelete` DTO was never updated to carry field evidence because deletes were treated as unconditional. The legacy `seasonSync.ts` path was kept as a fallback but never gated off on the native runtime.

2. **Schema Evolution Without Index Review (Req 4, 5)**: Indexes were added for the original query patterns but never revisited when `sort_order`-based reads became hot paths. `local_indexeddb_backup` was created for the migration era and never cleaned up or cascaded.

3. **Supabase Schema Drift (Req 6, 7)**: `schema.sql` was not regenerated after the May 2026 migration batch. The superseded snapshot RPC in the migration history was never annotated because migrations are treated as append-only.

4. **Inconsistent Security Gating (Req 8)**: The AI query RPCs were added after the operator-gate pattern was established for key rotation and context docs, but the gate was omitted — likely because the RPCs are called from the Edge Function which already authenticates, but the RPC itself is also directly callable.

5. **AI Safety Validator Limitations (Req 9, 10)**: The AI flight operations view was built from `local_flight_records` without joining modifications because the view predates the effective-count invariant being formalized. The SQL validator uses string splitting because `sqlparser-rs` was not yet a dependency; the heuristic was "good enough" for the initial launch but has known bypass vectors.

6. **Code Health and Test Gaps (Req 12–18)**: The Firestore adapter remains because removal was deferred. The corrupted sidecar was committed accidentally. The `applyLocal` fallback was written before the native-only guard was added. Test coverage for revert-clears-pending-op, Telegram round-trip, and migration idempotency was never prioritized.

## Correctness Properties

Property 1: Bug Condition - Sync Promotes Only Touched Legs

_For any_ Save operation where `rpc_result.applied_events` covers a subset of legs in the season, the fixed `promote_pending_ops_to_base` function SHALL only rewrite base rows for legs whose `target_id` appears in `applied_events`, leaving all other base rows untouched.

**Validates: Requirements 1.2.1**

Property 2: Bug Condition - Pending Op Delete By Op ID

_For any_ successful sync where `finalize_successful_pending_sync` runs, the fixed function SHALL delete only `local_pending_ops` rows whose `op_key` matches an `op_id` in `rpc_result.applied_events`, and SHALL assert the precondition that `conflict_events` is empty.

**Validates: Requirements 1.2.2, 1.2.3**

Property 3: Bug Condition - ModificationDelete Carries Field Evidence

_For any_ local `modificationDelete` pending op, the fixed `build_native_pending_change_events` function SHALL populate `changedFields` with the union of fields from the matching base modification row (via `local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 1`) and SHALL include corresponding `baseFieldVersions` entries, enabling V2 conflict detection.

**Validates: Requirements 2.2.1, 2.2.2**

Property 4: Bug Condition - Legacy Sync Path Unreachable On Native

_For any_ code path on the native (Tauri) runtime, the fixed system SHALL prevent `seasonSync.syncSeasonWorkspace` from executing full-workspace `saveLocalSeasonWorkspace` calls during routine catch-up, either by throwing at module entry on native or by relocating the module under `legacy/`.

**Validates: Requirements 3.2.1, 3.2.2, 3.2.3**

Property 5: Bug Condition - Covering Indexes Eliminate Filesort

_For any_ schedule-window or modification-subset query on a season with >1000 rows, the fixed schema SHALL provide covering indexes on `(season_id, is_base, sort_order)` for `local_flight_records`, `local_modifications`, and `local_mod_history_entries` so that `EXPLAIN QUERY PLAN` shows index-ordered access without filesort.

**Validates: Requirements 4.2.1, 4.2.2**

Property 6: Bug Condition - AI View Excludes Deleted Modifications

_For any_ AI SQL query against `dashboard_ai_flight_operations`, the fixed view SHALL exclude flight records that have a non-base `local_modifications` row with `action = 'deleted'`, and SHALL surface modification overlays for `pax`, `gate`, `stand`, and `route` so AI sees effective values matching the dashboard UI.

**Validates: Requirements 9.2.1, 9.2.2**

Property 7: Bug Condition - AI SQL Validator Uses AST Parsing

_For any_ AI-generated SQL containing comments adjacent to keywords (`/**/FROM/**/table`), quoted identifiers fused to keywords (`FROM"table"`), or alternative whitespace patterns, the fixed validator SHALL correctly identify the `FROM`/`JOIN` source and reject it if not `dashboard_ai_flight_operations` or a declared CTE.

**Validates: Requirements 10.2.1, 10.2.2, 10.2.3**

Property 8: Bug Condition - AI RPCs Enforce Operator Authorization

_For any_ call to `dashboard_ai_query_rows` or `dashboard_ai_query_aggregated` by an authenticated user who is NOT in `app_operators`, the fixed RPCs SHALL return an authorization error rather than executing the query.

**Validates: Requirements 8.2.1**

Property 9: Preservation - Existing Sync Behavior Unchanged

_For any_ sync operation where the bug conditions do NOT hold (normal Save with zero conflicts, normal catch-up with row-level events, normal conflict surfacing), the fixed system SHALL produce the same results as the original system, preserving all existing sync, catch-up, and conflict behaviors.

**Validates: Requirements 1.3.1, 1.3.2, 1.3.3, 2.3.1, 2.3.2, 3.3.1, 3.3.2, 3.3.3**

Property 10: Preservation - Existing Query Performance Unchanged

_For any_ query that uses existing indexes (`idx_local_flight_records_lookup`, `idx_local_modifications_lookup`, `idx_local_pending_ops_type`, `idx_local_entity_versions_target`), the fixed schema SHALL preserve those indexes unchanged (additions only, no replacements).

**Validates: Requirements 4.3.1, 4.3.2**

Property 11: Preservation - AI SQL Normal Queries Continue Working

_For any_ normal AI SQL query (`SELECT ... FROM dashboard_ai_flight_operations WHERE ...` or `WITH ... SELECT` referencing declared CTEs), the fixed validator SHALL continue to accept and execute it with the auto-applied LIMIT, and SHALL continue to reject semicolons outright.

**Validates: Requirements 10.3.1, 10.3.2, 10.3.3**

Property 12: Bug Condition - Verification Gaps Covered

_For any_ regression in `is_no_op_modification_against_base_record`, Telegram payload serialization, or migration idempotency, the fixed test suite SHALL include automated tests that catch the regression: revert-clears-pending-op, Telegram payload round-trip, and migration replay idempotency.

**Validates: Requirements 16.2.1, 16.2.2, 17.2.1, 17.2.2, 18.2.1, 18.2.2**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

---

### Domain 1: Sync Correctness (Requirements 1, 2, 3)

**File**: `app/src-tauri/src/native_catchup.rs`

**Function**: `finalize_successful_pending_sync`

**Specific Changes**:

1. **Per-op-id delete instead of season-wide delete (Req 1.2.2)**:
   - Replace `DELETE FROM local_pending_ops WHERE season_id = ?` with a parameterized delete: `DELETE FROM local_pending_ops WHERE season_id = ? AND op_key IN (...)` where the IN-list is built from `rpc_result.applied_events.iter().map(|e| e.op_id)`.
   - Add a `debug_assert!(rpc_result.conflict_events.is_empty())` at function entry, plus an early-return with error if conflicts are non-empty in release builds.

2. **Scoped base promotion (Req 1.2.1)**:
   - In `promote_pending_ops_to_base`, collect the set of `target_id` values from `applied_events`.
   - Replace the season-wide `DELETE FROM local_modifications WHERE season_id = ? AND is_base = 0` with `DELETE FROM local_modifications WHERE season_id = ? AND is_base = 0 AND leg_id IN (...)`.
   - Similarly scope the `INSERT INTO local_modifications ... SELECT ... WHERE is_base = 1` to only the touched `leg_id` set.
   - Apply the same scoping to `local_flight_records` and `local_mod_history_entries` base promotion.

**Function**: `build_native_pending_change_events`

3. **ModificationDelete field evidence (Req 2.2.1)**:
   - For `"modificationDelete"` op type, after determining `target_id`, query `SELECT payload_json FROM local_modifications WHERE season_id = ? AND leg_id = ? AND is_base = 1`.
   - Parse the base modification payload and extract all top-level field keys (excluding `legId`) as `changed_fields`.
   - If no base modification exists (edge case: delete of a locally-added mod), fall back to `["payload"]` as today.
   - Populate `baseFieldVersions` from `read_entity_field_versions` using the derived `changed_fields`.

**File**: `app/src/lib/seasonSync.ts`

4. **Gate legacy path on native runtime (Req 3.2.3)**:
   - At the top of `syncSeasonWorkspace`, add: `if (isTauriRuntime()) throw new Error('seasonSync.syncSeasonWorkspace is disabled on native runtime. Use syncNativePendingChanges.')`.
   - Alternatively, relocate `seasonSync.ts` to `app/src/lib/legacy/seasonSync.ts` and update the single test import.

**File**: `app/src/lib/localSeasonStore.ts`

5. **Structured error on native IPC null (Req 15.2.1)**:
   - In `applyLocalFlightRecordMutation`, `applyLocalModificationBatch`, and `applyLocalSourceRows`: when native IPC returns null on `isTauriRuntime()`, throw a structured `NativeRuntimeUnavailableError` with a retry hint, instead of falling through to `saveLocalSeasonWorkspace`.

---

### Domain 2: SQLite Schema (Requirements 4, 5)

**File**: `app/src/lib/localSeasonSqlStore.ts` (DDL array) and `app/src-tauri/src/native_catchup.rs` (Rust schema init)

**Specific Changes**:

6. **Add covering indexes for sort_order reads (Req 4.2.1)**:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_local_flight_records_sort
     ON local_flight_records (season_id, is_base, sort_order);
   CREATE INDEX IF NOT EXISTS idx_local_modifications_sort
     ON local_modifications (season_id, is_base, sort_order);
   CREATE INDEX IF NOT EXISTS idx_local_mod_history_sort
     ON local_mod_history_entries (season_id, is_base, sort_order);
   ```

7. **Add timestamp index for undo/history reads (Req 4.2.2)**:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_local_mod_history_timestamp
     ON local_mod_history_entries (season_id, is_base, timestamp DESC);
   ```

8. **Orphan cleanup for local_indexeddb_backup (Req 5.2.1)**:
   - Add `FOREIGN KEY (season_id) REFERENCES local_seasons(season_id) ON DELETE CASCADE` to `local_indexeddb_backup` DDL.
   - Since SQLite does not support `ALTER TABLE ... ADD CONSTRAINT`, implement as a migration: create new table with FK, copy data, drop old, rename.
   - Add a comment documenting the table as "diagnostic-only, retained for restore capability until IndexedDB migration era is fully retired."

---

### Domain 3: Supabase Schema (Requirements 6, 7, 8)

**File**: `app/supabase/schema.sql`

9. **Consolidate AI reporting RPCs into baseline (Req 6.2.1)**:
   - Add `dashboard_ai_query_rows`, `dashboard_ai_query_aggregated`, and `reporting.query_aggregated` definitions to `schema.sql` with the same allowlists, `security invoker`, and grants as the migrations.
   - Ensure `CREATE OR REPLACE FUNCTION` so re-applying migrations on top is a no-op.

**File**: `app/supabase/migrations/20260524173126_catchup_snapshot_rpc.sql`

10. **Annotate superseded RPC (Req 7.2.2)**:
    - Add a top-of-file comment: `-- SUPERSEDED: This definition of get_season_workspace_snapshot is replaced by 20260527092757_exact_season_filtering.sql. DO NOT cherry-pick or replay in isolation.`

**File**: `app/supabase/migrations/20260527090000_public_dashboard_ai_query_rows.sql` and `app/supabase/migrations/20260523112828_public_dashboard_ai_query_aggregated.sql`

11. **Add operator authorization gate (Req 8.2.1)**:
    - Add at function entry: `IF NOT public.is_app_operator() THEN RAISE EXCEPTION 'Unauthorized: caller is not an app operator'; END IF;`
    - Create a new migration `20260529_ai_rpc_operator_gate.sql` with `CREATE OR REPLACE FUNCTION` that adds the gate to both RPCs.

---

### Domain 4: Dashboard AI Safety (Requirements 9, 10)

**File**: `app/src-tauri/src/native_catchup.rs`

**Function**: `ensure_dashboard_ai_flight_operations_view`

12. **Exclude deleted modifications from AI view (Req 9.2.1)**:
    - Add a `LEFT JOIN local_modifications lm ON lm.season_id = lfr.season_id AND lm.leg_id = lfr.record_id AND lm.is_base = 0 AND lm.action = 'deleted'` and filter with `WHERE ... AND lm.leg_id IS NULL`.
    - For modification overlays (Req 9.2.2), COALESCE gate/stand/pax from a second LEFT JOIN on non-base modifications with `action != 'deleted'`:
    ```sql
    LEFT JOIN local_modifications lm_overlay
      ON lm_overlay.season_id = lfr.season_id
      AND lm_overlay.leg_id = lfr.record_id
      AND lm_overlay.is_base = 0
      AND lm_overlay.action != 'deleted'
    ```
    Then use `COALESCE(lm_overlay.gate, lfr.gate)` etc. in the SELECT.

**Function**: `validate_dashboard_ai_sql`

13. **Replace string-based validator with AST parser (Req 10.2.1)**:
    - Add `sqlparser = "0.52"` (or latest) to `Cargo.toml` dependencies with `features = ["sqlite"]`.
    - Rewrite `validate_dashboard_ai_sql` to:
      1. Parse SQL with `sqlparser::parser::Parser::parse_sql(&SQLiteDialect{}, sql)`.
      2. If parse fails, reject with "Invalid SQL syntax".
      3. Walk the AST: for each `Statement::Query`, visit all `TableFactor::Table` nodes.
      4. For each table reference, normalize the name (strip quotes, case-fold) and check against the allowlist: `{"dashboard_ai_flight_operations"}` plus declared CTE names.
      5. Reject any non-`SELECT`/`WITH` statement type at the AST level.
      6. Reject if more than one statement is parsed.
    - Keep the semicolon pre-check as a fast-path rejection before parsing.
    - Keep the banned-keyword check as a defense-in-depth layer, but switch to `\b`-style word-boundary matching via regex: `Regex::new(r"(?i)\b(INSERT|UPDATE|DELETE|DROP|...)\b")`.

14. **Interim hardening before AST (Req 10.2.2, 10.2.3)**:
    - If `sqlparser-rs` integration is deferred, immediately:
      - Strip SQL comments (`--` to EOL, `/* ... */`) before tokenization.
      - Split fused `KEYWORD"identifier"` tokens by detecting uppercase letter followed by `"` or `` ` ``.
      - Use `\bKEYWORD\b` regex for banned-keyword detection.

---

### Domain 5: Code Health (Requirements 12, 13, 14, 15)

**File**: `app/src/lib/remoteStore.ts`

15. **Remove Firestore fallback (Req 13.2.1)**:
    - Remove the `getFirestoreStore()` function and the `shouldUseSupabase()` conditional.
    - Make `getRemoteStore()` return `supabaseStore` unconditionally.
    - Delete `app/src/lib/firestore.ts` and `app/src/lib/firebase.ts`.
    - Rename `firestoreWritePlanner.ts` to `batchWritePlanner.ts` and update imports.
    - This also resolves Req 12 (missing `flushScheduleNotifications` on Firestore adapter) by eliminating the adapter entirely.

**File**: `app/src/app/SeasonalSchedulePage.tsx.corrupted-20260524-171751`

16. **Remove corrupted sidecar (Req 14.2.1)**:
    - Delete `SeasonalSchedulePage.tsx.corrupted-20260524-171751` from `app/src/app/`.
    - If history preservation is desired, move to `_codex_backups/` (already gitignored).

**File**: `app/src/lib/localSeasonStore.ts`

17. **Structured error on native IPC null (Req 15.2.1)** (also listed under Domain 1):
    - In `applyLocalFlightRecordMutation`, `applyLocalModificationBatch`, `applyLocalSourceRows`:
    ```typescript
    if (isTauriRuntime() && nativeResult === null) {
      throw new NativeRuntimeUnavailableError(
        'Native IPC bridge returned null. The Tauri runtime may be temporarily unavailable. Please retry.'
      );
    }
    ```
    - For the legacy/browser fallback path, pass `nativeFullSaveReason: 'legacy-edit'` so write-label auditing is unambiguous.

---

### Domain 6: Verification Gaps (Requirements 16, 17, 18)

**File**: `app/src-tauri/tests/native_catchup.rs`

18. **Revert-clears-pending-op test (Req 16.2.1)**:
    - Add integration test `test_revert_modification_clears_pending_op`:
      1. Seed a season with base flight records and modifications.
      2. Apply a modification (e.g., change gate from 5 to 7).
      3. Assert `local_pending_ops` has 1 row.
      4. Apply the reverse modification (change gate back to 5).
      5. Assert `local_pending_ops` is empty and `pending_count = 0` in sync meta.
    - Add analogous test for flight-record field revert and link/unlink revert.

19. **Telegram payload round-trip test (Req 17.2.1)**:
    - Add integration test `test_schedule_notification_payload_round_trip`:
      1. Apply a modification batch with `scheduleNotification` payload via `apply_local_modification_batch_delta`.
      2. Call `build_native_pending_change_events`.
      3. Assert the V2 event's `opPayload.entry.scheduleNotification` matches the input payload byte-for-byte.
    - Add a Postgres-level test (in `test:notifications` suite) that inserts a `season_change_events` row with `scheduleNotification` and asserts `schedule_notification_deliveries` gets a row.

**File**: `app/package.json` (new script) and new test file

20. **Migration idempotency test (Req 18.2.1)**:
    - Add script `test:migrations` that:
      1. Starts a fresh Supabase local instance (or uses `supabase db reset`).
      2. Applies all migrations.
      3. Captures `pg_dump --schema-only` as `schema_a.sql`.
      4. Applies all migrations again (idempotency check).
      5. Captures `pg_dump --schema-only` as `schema_b.sql`.
      6. Diffs `schema_a.sql` vs `schema_b.sql`; fails if non-empty diff.
    - Add script `test:baseline-vs-migrations` that:
      1. Bootstraps from `schema.sql` then applies migrations → `schema_baseline.sql`.
      2. Applies migrations from scratch (no `schema.sql`) → `schema_migrations.sql`.
      3. Diffs the two; fails if non-empty diff (excluding known ordering differences).

---

### Domain 3 (continued): Supabase Schema Cleanup

**File**: `app/supabase/schema.sql`

21. **Consolidate exact-season_id snapshot RPC (Req 7.2.1)**:
    - Ensure `schema.sql` contains the canonical `get_season_workspace_snapshot` with exact `season_id` filtering (matching `20260527092757_exact_season_filtering.sql`).
    - Remove any IATA-code fallback from the baseline.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bugs on unfixed code, then verify the fixes work correctly and preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bugs BEFORE implementing the fixes. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write targeted tests for each domain that exercise the defective code paths on the UNFIXED codebase.

**Test Cases**:
1. **Sync Season-Wide Delete Test (Req 1)**: Create a season with 10 pending ops, apply 3 via mock RPC result, assert all 10 are deleted (demonstrates the bug — will fail after fix)
2. **ModificationDelete Field Evidence Test (Req 2)**: Build a pending change event for a `modificationDelete` op, assert `changedFields` is `["payload"]` only (demonstrates the bug — will show richer fields after fix)
3. **Legacy Sync Path Reachability Test (Req 3)**: Import `syncSeasonWorkspace` on a mocked native runtime, call it, assert `saveLocalSeasonWorkspace` is called with `sync-baseline` (demonstrates the bug — will throw after fix)
4. **AI View Deleted Mods Test (Req 9)**: Create a flight record with a `deleted` modification, query `dashboard_ai_flight_operations`, assert the record appears (demonstrates the bug — will be excluded after fix)
5. **AI Validator Bypass Test (Req 10)**: Submit `SELECT * FROM/**/sqlite_master` to `validate_dashboard_ai_sql`, assert it passes (demonstrates the bug — will be rejected after fix)
6. **AI RPC No Operator Gate Test (Req 8)**: Call `dashboard_ai_query_rows` as a non-operator authenticated user, assert it succeeds (demonstrates the bug — will fail after fix)

**Expected Counterexamples**:
- Pending ops deleted by season_id regardless of which ops were applied
- `modificationDelete` events with empty/`["payload"]` changedFields
- Full-workspace saves executing on native runtime through legacy path
- Deleted modifications appearing in AI view counts
- SQL with comment-fused keywords passing validation

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedSystem(input)
  ASSERT expectedBehavior(result)
END FOR
```

Concrete fix checks per domain:

- **Req 1**: After fix, `finalize_successful_pending_sync` with 3 applied ops out of 10 pending → only 3 `local_pending_ops` rows deleted, 7 remain.
- **Req 2**: After fix, `modificationDelete` for a leg with base fields `[gate, stand, pax, route]` → `changedFields = ["gate", "stand", "pax", "route"]` with matching `baseFieldVersions`.
- **Req 3**: After fix, calling `syncSeasonWorkspace` on native runtime → throws `Error('seasonSync.syncSeasonWorkspace is disabled on native runtime')`.
- **Req 4**: After fix, `EXPLAIN QUERY PLAN` for schedule-window query → shows `SEARCH ... USING INDEX idx_local_flight_records_sort`.
- **Req 9**: After fix, flight record with `deleted` modification → excluded from `dashboard_ai_flight_operations` view.
- **Req 10**: After fix, `SELECT * FROM/**/sqlite_master` → rejected by AST-based validator.
- **Req 16**: After fix, apply mod then revert → `local_pending_ops` is empty.

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalSystem(input) = fixedSystem(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for normal operations, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Normal Save Preservation**: Verify that Save with all ops applied and zero conflicts continues to clear all pending ops, advance `lastServerSeq`, and set `syncStatus = 'synced'`
2. **Conflict Handling Preservation**: Verify that Save with conflicts continues to call `mark_pending_sync_conflict` and leave pending ops intact
3. **Catch-up Preservation**: Verify that row-level catch-up event pages continue to apply via upserts with cursor advance after commit
4. **AI Normal Query Preservation**: Verify that `SELECT ... FROM dashboard_ai_flight_operations WHERE type = 'ARR'` continues to execute successfully
5. **CTE Query Preservation**: Verify that `WITH monthly AS (SELECT ...) SELECT * FROM monthly` continues to be accepted
6. **Existing Index Preservation**: Verify that queries using `idx_local_flight_records_lookup` continue to use that index after new indexes are added
7. **Notification Flush Preservation**: Verify that `supabaseStore.flushScheduleNotifications` continues to invoke the Edge Function

### Unit Tests

- Test `finalize_successful_pending_sync` with partial applied_events (only applied ops cleared)
- Test `build_native_pending_change_events` for `modificationDelete` with base modification present
- Test `build_native_pending_change_events` for `modificationDelete` with no base modification (fallback)
- Test `validate_dashboard_ai_sql` with comment-fused keywords (rejected)
- Test `validate_dashboard_ai_sql` with quoted-identifier-fused keywords (rejected)
- Test `validate_dashboard_ai_sql` with normal queries (accepted)
- Test `ensure_dashboard_ai_flight_operations_view` excludes deleted modifications
- Test `ensure_dashboard_ai_flight_operations_view` applies modification overlays
- Test `NativeRuntimeUnavailableError` is thrown when IPC returns null on native
- Test `syncSeasonWorkspace` throws on native runtime

### Property-Based Tests

- Generate random sets of pending ops and applied subsets; verify only applied ops are deleted from `local_pending_ops`
- Generate random base modification payloads; verify `modificationDelete` events carry all base field keys
- Generate random SQL strings with various whitespace/comment patterns; verify AST validator correctly identifies table sources
- Generate random flight record + modification combinations; verify AI view matches effective dashboard counts
- Generate random non-buggy inputs (normal edits, normal queries); verify preservation of existing behavior

### Integration Tests

- Full sync flow: edit → pending op → Save → verify only touched legs promoted to base
- Full AI flow: create records with modifications → query AI view → verify effective counts match dashboard
- Full revert flow: edit → revert → verify pending ops cleared
- Full notification flow: edit with scheduleNotification → build events → verify payload preserved
- Migration replay: apply all migrations twice → verify schema unchanged
- Baseline vs migrations: schema.sql + migrations vs migrations-only → verify equivalent
