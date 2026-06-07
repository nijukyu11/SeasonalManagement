# Requirements Document

## Introduction

This spec captures the defects, drift, and risk findings produced by an architecture- and database-level audit of the SeasonalManagement codebase as it stands on the native-first runtime (Tauri + SQLite + Supabase). It is framed as a multi-issue bugfix because each finding is a concrete deviation from the documented invariants in `architecture.md` and `context.md` (native runtime as source of truth, exact `season_id` ownership, row-level sync, effective counts, AI safety, etc.) that has reproducible file-level evidence in the live tree.

Each requirement below uses the bug-condition methodology:

- Current Behavior (Defect) — observable wrong state today, with file evidence
- Expected Behavior (Correct) — what the fix must establish, in EARS form
- Unchanged Behavior (Regression Prevention) — what existing correct behavior must not regress

The following audit dimensions were inspected and are reported as healthy (no defect found, no requirement raised):

- Routes (`checkin/page.tsx`, `gate/page.tsx`, `daily/page.tsx`, `detailed/page.tsx`, `seasonal/page.tsx`, `dashboard/page.tsx`) read seasons and operational settings via `remoteStore`, but all schedule edits go through `runNativeScheduleMutation` / `runNativeLocalModificationBatchDelta`. No Supabase table/RPC writes occur on edit hot paths, and no `window.location.reload()` or full-workspace refetch after an edit was found.
- The Gate Gantt drag/drop handler commits via `applyLocalModificationBatchDelta` only and respects `useSeasonSyncGuard` while `pointerDragState` is active. The Check-in worker uses the same delta path. No Supabase writes or full-workspace hydration was found inside `pointermove`/`dragover`/`drop-preview` handlers.
- Native modification DTOs for the `apply_*` commands always carry `legId` thanks to `normalize_modification_payload`, which restores `legId` from `local_modifications.leg_id` when sparse. Effective totals from `query_schedule_window` correctly subtract deleted modifications and add added modifications.
- The dashboard, daily, detailed, and seasonal pages compute user-facing counts from `effectiveRecords` (`buildEffectiveDashboardRecords`, `dailySchedule.ts`) rather than raw record arrays.
- The exporter (`exporter.ts`) does not infer overnight pairing from time similarity at the FlightRecord level; it requires explicit `linkedRecordId` / `linkType`. `includeLinkedLegsForExport` correctly auto-includes the partner leg of a selected record.
- The export Tauri command (`save_export_file`) sanitizes filenames, validates `.xlsx`/`.pdf` extensions, and confines writes to the OS Downloads folder.
- AI key rotation (`rotate-dashboard-ai-key/index.ts`) authenticates the request, filters `app_operators` by `auth.uid()`, and gates on `can_manage_ai`.
- Native catch-up correctly applies row-level events page by page inside committed SQLite transactions; `lastServerSeq` only advances after commit; passive checkpointing, busy-timeout, WAL, and `season-catchup-token-required` refresh are wired and tested in `app/src-tauri/tests/native_catchup.rs`.

These healthy areas are out of scope and produce no requirement clauses below.

## Glossary

- C(X): Bug condition — the predicate over inputs/state that identifies the defective situation.
- F: The current (unfixed) function or subsystem.
- F': The fixed function or subsystem this spec must produce.
- season_id: Canonical operational ownership attribute. Exact equality is required for user-facing flows; IATA `season_code` is for cross-season reporting/AI only.
- Effective count: User-facing count after applying current modifications (deleted modifications subtract, added modifications add). Raw row counts are diagnostics only.
- Pending op: Difference between current local workspace and saved server baseline; not an append-only log. Reversing an edit back to baseline must clear the pending op.
- Native runtime: Tauri desktop process. SQLite + Rust commands are the local source of truth here.

## Requirements

### Requirement 1: Sync Correctness — Fragile Season-Wide Pending Op Delete And Wholesale Base Rewrite On Save

Evidence:
- `app/src-tauri/src/native_catchup.rs:1980-2014` — sync flow deletes every non-base `local_modifications` row for the season then re-promotes `is_base = 1` rows wholesale on each Save.
- `app/src-tauri/src/native_catchup.rs:2390-2451` — `finalize_successful_pending_sync` clears every `local_pending_ops` row for the season in one statement, regardless of which ops the V2 RPC actually applied.
- `app/src-tauri/src/native_catchup.rs:4581-4621` — the dispatcher only invokes `finalize_successful_pending_sync` WHEN `rpc_result.conflict_events.is_empty()`. On any conflict, it calls `mark_pending_sync_conflict` instead, which does not clear pending ops.

#### Current Behavior (Defect)

1.1 WHEN Save promotes pending ops to base THEN the system rewrites the entire base modification set for the season instead of only the legs touched by the just-applied events, producing more SQLite write work than required and a wider critical section than the row-level invariant allows.
1.2 WHEN `finalize_successful_pending_sync` runs THEN the system unconditionally deletes every `local_pending_ops` row for the season; this is observationally correct only because the dispatcher gates the call on zero conflicts, so the per-op-id delete that would make the invariant explicit is missing. IF a future change ever loosens that gate (for example to apply non-conflicting ops while retaining conflict-bearing ones) THEN the system would silently discard retained business ops.

#### Expected Behavior (Correct)

2.1 WHEN Save promotes pending ops to base THEN the system SHALL only rewrite the base rows for the legs/source rows/records actually committed in this Save, leaving untouched base rows in place.
2.2 WHEN `finalize_successful_pending_sync` clears `local_pending_ops` THEN the system SHALL delete only rows whose `op_id` appears in `rpc_result.applied_events`, even though today's gating means the resulting set is identical, so the invariant is enforced by code rather than by an external precondition.
2.3 WHERE the dispatcher contract requires `conflict_events.is_empty()` before invoking `finalize_successful_pending_sync` THEN the system SHALL assert that precondition explicitly inside `finalize_successful_pending_sync` (debug assert or early return) so the invariant cannot be silently broken by a caller change.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN Save returns `applied_events` covering every pending op and zero conflicts THEN the system SHALL CONTINUE TO clear `local_pending_ops`, advance `lastServerSeq`, set `syncStatus = 'synced'`, and best-effort flush schedule notifications.
3.2 WHEN Save returns any conflict items THEN the system SHALL CONTINUE TO call `mark_pending_sync_conflict` instead of `finalize_successful_pending_sync`, leaving `local_pending_ops` rows intact.
3.3 WHEN catch-up applies remote event pages without a Save running THEN the system SHALL CONTINUE TO use row-level upserts and advance the cursor only after the SQLite transaction commits.

### Requirement 2: Sync Correctness — modificationDelete DTO Loses Field Evidence

Evidence:
- `app/src-tauri/src/native_catchup.rs:2218-2230` — `build_native_pending_change_events` constructs `op_payload` for `modificationDelete` as `{ "type": "modificationDelete", "legId": target_id }` only.
- `app/src-tauri/src/native_catchup.rs:2185-2210` — `changed_fields` for that op are derived from `pending_op_target` fallback fields (effectively `["payload"]` for delete) because `current` is `None` for a deleted modification.
- `app/supabase/schema.sql` (`apply_workspace_op_json`) consumes `modificationDelete` as `delete from public.season_modifications where leg_id = op->>'legId'` with no field-version protection.
- `app/supabase/migrations/20260524160004_reliable_sync_cursor.sql` (`sync_season_workspace_v2`) compares `current_field_version > base_field_version` per field listed in `changed_fields`. Because the native client supplies `["payload"]`, conflict detection on a delete reduces to "did the payload field clock advance?", which is never set by upstream upserts.

#### Current Behavior (Defect)

1.1 WHEN a local `modificationDelete` is uploaded THEN the system uses an empty/`payload` `changedFields` set, so V2 conflict detection cannot reject it against any concrete remote field clock.
1.2 WHEN the same leg has been remotely modified after the local base snapshot THEN the system silently overwrites the remote modification with a delete instead of producing a conflict the user can review.

#### Expected Behavior (Correct)

2.1 WHEN a local `modificationDelete` is uploaded THEN the system SHALL include the concrete modification field set covered by the delete (the union of fields known on the matching base modification, restored from `local_modifications.leg_id` with `is_base = 1`) in `changedFields`, with corresponding `baseFieldVersions` entries.
2.2 WHEN the V2 RPC observes any of those base field versions advanced server-side THEN the system SHALL surface the delete in `conflict_events` and keep the local pending op for review.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN a `modificationDelete` targets a leg with no concurrent remote modification THEN the system SHALL CONTINUE TO accept the delete and remove the row in `season_modifications`.
3.2 WHEN a `modificationDelete` is executed locally with no current modification (no-op) THEN the system SHALL CONTINUE TO not generate a pending event (current behavior in `is_modification_delete_event` and pending-op merge).

### Requirement 3: Native Runtime — Legacy seasonSync.ts Path Performs Full-Workspace sync-baseline Saves On Routine Catch-Up

This requirement merges the prior Requirements 3 and 11. Both targeted the same defect surface: the legacy `seasonSync.ts` path performing full-workspace `saveLocalSeasonWorkspace(..., { nativeFullSaveReason: 'sync-baseline' })` calls during routine catch-up, instead of using row-level deltas as the native invariant requires.

Evidence:
- `app/src-tauri/src/native_catchup.rs:2270-2299` — `sync_pending_changes_on_connection` (the non-RPC path used when the native uploader is short-circuited) returns `"failed"` with message "Native pending upload is not available yet; refusing JS full-workspace sync." for any season that already has pending ops.
- `app/src/lib/seasonSync.ts:537-748` — `syncSeasonWorkspace` is fully reachable, exported, and bundled. It performs full-workspace `saveLocalSeasonWorkspace(..., { nativeFullSaveReason: 'sync-baseline' })` calls during routine catch-up and after Save (5 sites). At least two of them (the `catchUpSeasonWorkspace` result and the post-V2-success `postCaughtUp` snapshot) run on the routine sync path, not on import or reset.
- On a native runtime, `saveLocalSeasonWorkspace` requires one of the allowed reasons (`indexeddb-seed`, `server-baseline`, `sync-baseline`, `import-reset`, `session-discard`); routine catch-up uses the `sync-baseline` escape hatch even for delta event pages.
- `architecture.md` invariant: routine catch-up and operator edits MUST NOT replace a full workspace snapshot. Full snapshot replacement is allowed only for explicit import, reset, or repair flows behind integrity checks.
- `SeasonSyncProvider.tsx` uses `syncNativePendingChanges` directly on the native runtime and partially mitigates this, but `seasonSync.ts` is still exported and remains the legacy fallback.

#### Current Behavior (Defect)

1.1 WHEN the legacy `seasonSync.syncSeasonWorkspace` path executes a routine V2 sync that succeeds without conflict THEN the system performs full-workspace SQLite rewrites tagged `sync-baseline` via `serializeWorkspaceForSql` and `saveLocalSeasonSqlWorkspace`, which directly violates the "routine catch-up must not snapshot-replace" invariant in `architecture.md`.
1.2 WHEN catch-up backlog is below the snapshot threshold THEN the legacy path still calls `saveLocalSeasonWorkspace(caughtUpWorkspace, { nativeFullSaveReason: 'sync-baseline' })` after applying delta events, again writing the full workspace instead of using row-level deltas.
1.3 WHEN the native runtime is active THEN the legacy `seasonSync.ts` path is still reachable from any code that imports `syncSeasonWorkspace` directly, so the mitigation in `SeasonSyncProvider.tsx` is by-convention rather than enforced; an unguarded import would silently re-engage the full-workspace save path.

#### Expected Behavior (Correct)

2.1 WHEN catch-up applies remote delta event pages THEN the system SHALL persist results through native row-level commands (already-applied event upserts and `lastServerSeq` advance) and SHALL NOT call `saveLocalSeasonWorkspace` with a full snapshot for routine deltas.
2.2 WHEN the native sync command is unavailable THEN the system SHALL surface a `failed` result to the UI rather than silently falling back to a full-workspace IndexedDB-style write through `seasonSync.ts`.
2.3 WHERE `seasonSync.ts` is retained as a fallback for non-native environments THEN the system SHALL gate it behind a clearly named "legacy / non-native" path that is unreachable on the desktop runtime (for example, by feature-detecting `isTauriRuntime()` at module entry and throwing on the native path, or by relocating it under `app/src/lib/legacy/`).

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user explicitly imports, resets, or repairs a season THEN the system SHALL CONTINUE TO accept full-workspace writes labelled `import-reset`, `server-baseline`, or `session-discard` as today.
3.2 WHEN running in a non-Tauri/test environment without native runtime THEN the system SHALL CONTINUE TO be able to drive sync through the legacy path for unit tests in `localSeasonSqlStore.test.ts`.
3.3 WHEN conflict items are surfaced THEN the system SHALL CONTINUE TO populate `local_sync_meta.conflicts` and expose them via `queryNativeConflictSummary`.

### Requirement 4: SQLite Schema — Missing Indexes on Hot Modification and Pending Pathways

Evidence:
- `app/src/lib/localSeasonSqlStore.ts:118-191` lists the live DDL. Existing indexes:
  - `idx_local_flight_records_lookup` on `(season_id, is_base, flight_date, type, gate, stand)`
  - `idx_local_flight_records_operational_lookup` on `(season_id, is_base, operational_date, type, status)`
  - `idx_local_modifications_lookup` on `(season_id, is_base, leg_id, action, gate, stand)`
  - `idx_local_pending_ops_type` on `(season_id, op_type, sort_order)`
  - `idx_local_entity_versions_target` on `(season_id, target_type, target_id)`
- `app/src-tauri/src/native_catchup.rs:573` and `:743-757` — hot reads load modifications by `(season_id, is_base, leg_id IN (...))` and by `season_id` only with `ORDER BY sort_order`.
- `app/src-tauri/src/native_catchup.rs:1276-1290` — schedule-window reads sort by `sort_order ASC` over `local_flight_records` after filtering on `(season_id, is_base, ...)`. No covering index includes `sort_order`.
- No index covers `local_mod_history_entries (season_id, is_base, sort_order)` even though Save and undo paths read it constantly.

#### Current Behavior (Defect)

1.1 WHEN the schedule window or modification subset query runs on a large season THEN the system performs a per-season filesort because there is no covering index on `(season_id, is_base, sort_order)` for `local_flight_records`, `local_modifications`, or `local_mod_history_entries`.
1.2 WHEN a hot-path query searches `local_modifications` by `season_id` plus `leg_id IN (...)` for non-base rows THEN the existing wider index `(season_id, is_base, leg_id, action, gate, stand)` is used, but `local_mod_history_entries` has no `season_id`-prefixed index at all and falls back to the implicit `(season_id, history_id)` PK ordering.

#### Expected Behavior (Correct)

2.1 WHEN the schema is migrated forward THEN the system SHALL add covering indexes on `(season_id, is_base, sort_order)` for `local_flight_records`, `local_modifications`, and `local_mod_history_entries` so that ordered reads avoid filesort.
2.2 WHEN the schema is migrated forward THEN the system SHALL add an index on `local_mod_history_entries (season_id, is_base, timestamp DESC)` to cover undo and sync history reads.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN existing queries read by `(season_id, is_base, flight_date, ...)` or `(season_id, is_base, leg_id, action, gate, stand)` THEN the system SHALL CONTINUE TO use the existing indexes (additions only, no replacements).
3.2 WHEN `local_pending_ops` is read in `op_type`/`sort_order` order THEN the system SHALL CONTINUE TO use `idx_local_pending_ops_type`.

### Requirement 5: SQLite Schema — Orphan local_indexeddb_backup Table On Native-Only Runtime

Evidence:
- `app/src/lib/localSeasonSqlStore.ts:175-181` creates `local_indexeddb_backup (season_id, backed_up_at, payload_json)` with PK `(season_id, backed_up_at)` and no FK to `local_seasons`.
- `app/src/lib/localSeasonStore.ts:574-595` (`ensureSqlSeededFromIndexedDb`) writes one row per IndexedDB seed migration on first SQLite open.
- After `INDEXEDDB_SQL_RESET_KEY` is set, the table is never written again, but it is also never cleaned up when seasons are removed via `clearAllLocalSeasonWorkspaces`.

#### Current Behavior (Defect)

1.1 WHEN a season is removed from `local_seasons` (via reset/repair) THEN the system leaves matching `local_indexeddb_backup` rows in place because there is no foreign key cascade.
1.2 WHEN a fresh native install opens the database THEN the system creates `local_indexeddb_backup` even though no IndexedDB seed will ever happen, and the table remains as dead schema.

#### Expected Behavior (Correct)

2.1 WHEN a season is removed THEN the system SHALL also clear that season's `local_indexeddb_backup` rows, either via FK `ON DELETE CASCADE` to `local_seasons(season_id)` or an explicit cleanup pass.
2.2 WHEN the native runtime upgrades past the IndexedDB-migration era THEN the system SHALL retire `local_indexeddb_backup` (drop on a future migration) once the seed flag has been set, OR explicitly document it as a long-term diagnostic-only table.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN a workspace is restored from `local_indexeddb_backup` via `restoreLatestLocalSeasonSqlBackup` (covered by `localSeasonSqlStore.test.ts`) THEN the system SHALL CONTINUE TO be able to read the latest payload for any seasons whose backups are still present.
3.2 WHEN a non-native browser-only fallback runs THEN the system SHALL CONTINUE TO be able to seed SQLite from IndexedDB once.

### Requirement 6: Supabase Schema — Drift Between schema.sql And Ordered Migrations

Evidence:
- `app/supabase/schema.sql:1-15` drops AI query artifacts via cascade and drops `enqueue_schedule_notification_delivery`, but does not re-define the AI query RPCs or `reporting.query_aggregated`.
- The actual definitions live in `app/supabase/migrations/20260523175500_reporting_query_aggregated.sql`, `app/supabase/migrations/20260523112828_public_dashboard_ai_query_aggregated.sql`, and `app/supabase/migrations/20260527090000_public_dashboard_ai_query_rows.sql`.
- `schema.sql` includes `operational_ai_context_documents` and `enqueue_schedule_notification_delivery` but is missing `dashboard_ai_query_rows`, `dashboard_ai_query_aggregated`, and `reporting.query_aggregated`.

#### Current Behavior (Defect)

1.1 WHEN a Supabase environment is bootstrapped from `schema.sql` only (without applying ordered migrations) THEN the system has no `public.dashboard_ai_query_rows`, `public.dashboard_ai_query_aggregated`, or `reporting.query_aggregated`, and the Edge Function will fail aggregated queries.
1.2 WHEN `architecture.md` claims `schema.sql` is the consolidated baseline THEN the actual on-disk file is missing the AI reporting RPCs introduced by the May 2026 migrations.

#### Expected Behavior (Correct)

2.1 WHEN `schema.sql` is consumed as a baseline THEN the system SHALL include `public.dashboard_ai_query_rows`, `public.dashboard_ai_query_aggregated`, and `reporting.query_aggregated` definitions with the same allowlists, `security invoker`, and grants the migrations install.
2.2 WHEN the migrations are re-applied on top of `schema.sql` THEN the system SHALL be a no-op (same definitions idempotently re-asserted).

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `schema.sql` declares RLS policies for the listed tables THEN the system SHALL CONTINUE TO enforce `is_app_operator()` on read and write.
3.2 WHEN existing reporting views are declared with `security_invoker = true` THEN the system SHALL CONTINUE TO keep that property.

### Requirement 7: Supabase Schema — Snapshot RPC History Contains Superseded IATA-Code Definition

Evidence:
- `app/supabase/migrations/20260524173126_catchup_snapshot_rpc.sql:13-55` — the original `get_season_workspace_snapshot` definition includes flight records and modification added legs whose `iata_season_code = s.season_code` even when `season_id` does not match the requested season. This definition is still present verbatim in the migrations history.
- `app/supabase/migrations/20260527092757_exact_season_filtering.sql:106-180` — a later migration redefines `get_season_workspace_snapshot` with exact `season_id` filtering only: `flight_record_rows` filters on `r.season_id = p_season_id`, modifications join via `m.season_id = p_season_id` OR `m.leg_id IN (filtered records)` OR an `exists` check against `season_modification_added_legs` keyed on `season_id = p_season_id`. There is no `iata_season_code` fallback in the live ordered-migration definition.
- `app/supabase/schema.sql` — the consolidated baseline does not contain the IATA-code fallback either.

#### Current Behavior (Defect)

1.1 WHEN a future reviewer reads the migrations directory in chronological order and stops at `20260524173126_catchup_snapshot_rpc.sql` THEN the system presents an `iata_season_code` fallback definition that is no longer in effect, which can confuse archaeology and review of the snapshot contract.
1.2 WHEN the consolidated baseline (`schema.sql`) is updated to assert the canonical post-migrations state THEN the system has no inline marker in the older migration file noting that it is superseded by `20260527092757_exact_season_filtering.sql`, so a partial replay or selective backport could re-introduce the old definition without anyone noticing.

Note: the runtime behavior of `get_season_workspace_snapshot` is correct after `20260527092757_exact_season_filtering.sql` is applied. User-facing routes are NOT currently inflated by sibling-season rows. This requirement is hygiene-only and does not describe a live defect.

#### Expected Behavior (Correct)

2.1 WHEN the snapshot RPC is documented THEN the system SHALL either consolidate the canonical exact-`season_id` definition into `schema.sql` so the migrations chain is purely additive, OR add a top-of-file comment in `20260524173126_catchup_snapshot_rpc.sql` explicitly stating "Superseded by `20260527092757_exact_season_filtering.sql`; this definition MUST NOT be cherry-picked or replayed in isolation".
2.2 WHEN the migrations history is preserved unchanged for replay reproducibility THEN the system SHALL accompany the historical IATA-fallback definition with a clear note linking forward to the exact-`season_id` redefinition.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `get_season_workspace_snapshot(p_season_id)` is invoked at runtime against a database that has applied all ordered migrations THEN the system SHALL CONTINUE TO return only rows with `season_id = p_season_id` and SHALL CONTINUE TO have no `iata_season_code` fallback.
3.2 WHEN AI reporting queries (`dashboard_ai_query_*`) explicitly filter by `iataSeasonCodes` THEN the system SHALL CONTINUE TO honor that as a documented cross-season analysis path.
3.3 WHEN `season_id` is fully populated (post-migration `20260527092757`) THEN the system SHALL CONTINUE TO use the FK-enforced exact match.

### Requirement 8: Supabase Schema — Reporting AI RPCs Lack Operator-Authorization Filter

Evidence:
- `app/supabase/migrations/20260527090000_public_dashboard_ai_query_rows.sql` — `dashboard_ai_query_rows(...)` is `security invoker` and `grant execute ... to authenticated`. It does not call `is_app_operator()`.
- `app/supabase/migrations/20260523112828_public_dashboard_ai_query_aggregated.sql` — `dashboard_ai_query_aggregated(...)` is also `security invoker` and `grant execute ... to authenticated` and never checks operator status.
- AI key rotation, AI context documents, and AI models all enforce `is_app_operator()`. The AI query RPCs are inconsistent with that pattern.

#### Current Behavior (Defect)

1.1 WHEN any authenticated Supabase user (not necessarily an `app_operators` row) calls `dashboard_ai_query_rows` or `dashboard_ai_query_aggregated` THEN the system executes the function without checking operator status. Data rows are RLS-filtered, but the function is enumerable and exposed to non-operator users.
1.2 WHEN AI key rotation, AI context documents, and AI models all enforce `is_app_operator()` THEN the AI query RPCs are inconsistent because they skip that gate.

#### Expected Behavior (Correct)

2.1 WHEN `dashboard_ai_query_rows` or `dashboard_ai_query_aggregated` is called THEN the system SHALL return an authorization error (or an empty result set with an explicit data-quality note) for callers where `public.is_app_operator()` returns false.
2.2 WHEN the Edge Function calls these RPCs on behalf of a verified operator user THEN the system SHALL CONTINUE TO succeed normally.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN reporting views (`reporting.flight_operations`, `reporting.summary_*`) are queried with `security_invoker = true` THEN the system SHALL CONTINUE TO enforce `season_flight_records` RLS.
3.2 WHEN allowlists (filters, columns, group-by, metrics) are evaluated THEN the system SHALL CONTINUE TO reject unknown values exactly as today.

### Requirement 9: Dashboard AI Safety — Local View Counts Deleted Modifications As Active Flights

Evidence:
- `app/src-tauri/src/native_catchup.rs:1750-1786` — `dashboard_ai_flight_operations` is built from `local_flight_records lfr WHERE lfr.is_base = 0`. It does not join `local_modifications` and does not subtract deleted modifications.
- `architecture.md` and `context.md` invariant: native reads must return effective schedule data; deleted modifications subtract from user-facing totals; raw row counts are diagnostics only.
- `query_schedule_window` and `query_dashboard_summary` both compute `effectiveTotal` honoring deleted modifications. The AI-readable view used by `queryNativeDashboardAiSql` does not.

#### Current Behavior (Defect)

1.1 WHEN AI runs an aggregate query through `dashboard_ai_flight_operations` THEN the system returns counts that include flight records that have been logically deleted by a current modification (`action = 'deleted'`) but whose `local_flight_records.status` is still `'active'`.
1.2 WHEN AI counts overlap with the dashboard's user-facing effective totals THEN the two disagree, undermining the "user-facing counts equal effective" invariant.

#### Expected Behavior (Correct)

2.1 WHEN the AI temp view is created THEN the system SHALL exclude rows that have a non-base `local_modifications` row with `action = 'deleted'`, OR shall expose an `is_effective_active` column the AI prompt is instructed to filter on, OR shall apply the modification overlay before exposing the row.
2.2 WHEN the AI reads `pax`, `gate`, `stand`, `route`, etc. THEN the system SHALL surface modification overlays so AI sees the same effective values as the dashboard UI.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `validate_dashboard_ai_sql` rejects writes or unknown tables THEN the system SHALL CONTINUE TO enforce read-only `SELECT`/CTE access to `dashboard_ai_flight_operations`.
3.2 WHEN `data_quality_notes` are returned THEN the system SHALL CONTINUE TO label the source as local SQLite via a validated SELECT gateway.

### Requirement 10: Dashboard AI Safety — validate_dashboard_ai_sql Is String-Based And Brittle

Evidence:
- `app/src-tauri/src/native_catchup.rs:1803-1860` — the validator uppercases the input, bans the input outright if it contains any semicolon (`semicolon_count > 0`), bans listed keywords by `" KEYWORD "` and `"\nKEYWORD "` substring matches, then walks two-token windows after replacing `,()`, `\n`, `\t` with spaces and checking that any token following `FROM` or `JOIN` is either `DASHBOARD_AI_FLIGHT_OPERATIONS` or a declared CTE name.
- The semicolon ban already rejects `;DROP`-style payloads outright. The `FROM (SELECT * FROM sqlite_master)` pattern is also already rejected: stripping parentheses to spaces makes the next token after the outer `FROM` equal to `SELECT`, which is neither the allowlisted view nor a CTE.
- The validator is purely string-based and does not tokenize SQL. Concrete brittle edges:
  - Comments adjacent to keywords. SQLite parses `/**/FROM/**/sqlite_master` and `--\nFROM sqlite_master` correctly, but the validator's two-token windows treat `/*`, `*/FROM/*`, `*/sqlite_master` as opaque tokens and the literal token `FROM` never appears, so the allowlist check is skipped and a banned table is reachable.
  - Quoted identifier adjacent to a keyword without whitespace. SQLite accepts `FROM"sqlite_master"` and `FROM\`sqlite_master\`` as valid `FROM <table>`. The validator's `split_whitespace()` produces a single fused token (e.g. `FROM"SQLITE_MASTER"`) which never matches the literal `FROM`, so the allowlist check is skipped.
  - The keyword-ban substring matches require a leading space or `\n`. Future syntax additions or parser-level surprises (alternative whitespace, keywords adjacent to punctuation that does not happen to be `,()`) would not be caught by `\b`-style boundaries because the matcher only looks for `" KEYWORD "` and `"\nKEYWORD "`.

#### Current Behavior (Defect)

1.1 WHEN the AI generates SQL where a SQLite comment delimiter is glued to the `FROM` or `JOIN` keyword (for example `/* */FROM/* */sqlite_master`) THEN the system can fail the allowlist check because the literal token `FROM` is never produced after whitespace splitting, and SQLite would still parse the construct as a normal `FROM <table>`.
1.2 WHEN the AI generates SQL where a backtick- or double-quote-quoted identifier sits directly against `FROM` or `JOIN` with no whitespace (for example `FROM"sqlite_master"`) THEN the system fuses keyword and identifier into a single whitespace-delimited token and the allowlist check is skipped, while SQLite still parses the construct as `FROM <table>`.
1.3 WHEN the validator is evolved to cover new SQLite syntax (window-function parts, JSON1 path operators, future virtual-table grammar) THEN the system relies on substring heuristics that are not robust to additions; banned-keyword detection in particular looks only for `" KEYWORD "` and `"\nKEYWORD "` rather than `\bKEYWORD\b`.

#### Expected Behavior (Correct)

2.1 WHEN the AI SQL validator runs THEN the system SHALL parse the SQL through a real lexer/AST (for example `sqlparser-rs` with the SQLite dialect) and walk the AST to confirm that every `FROM` and `JOIN` source is either `dashboard_ai_flight_operations` or a CTE declared in the same query, including in subqueries, with comments and quoted identifiers normalized by the lexer.
2.2 WHEN the validator detects banned statement keywords (until the lexer is in place) THEN the system SHALL match keywords by `\bKEYWORD\b` rather than `" KEYWORD "` substring matches so that adjacent punctuation, comments, and start-of-input cannot bypass the check.
2.3 WHEN the validator strips quoting before allowlist comparison THEN the system SHALL strip backticks, double quotes, and SQL Server-style square brackets, AND SHALL split fused `KEYWORD"identifier"` tokens before the allowlist check so that a keyword without whitespace separation is still recognized as the keyword.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN the AI submits a normal `SELECT ... FROM dashboard_ai_flight_operations WHERE ...` THEN the system SHALL CONTINUE TO accept and execute it with the auto-applied LIMIT.
3.2 WHEN the AI submits a `WITH ... SELECT` query referencing only declared CTEs and the projection view THEN the system SHALL CONTINUE TO accept it.
3.3 WHEN the AI submits SQL containing a semicolon THEN the system SHALL CONTINUE TO reject it outright (multi-statement guard already in place).

### Requirement 11: REMOVED — Merged Into Requirement 3

This requirement has been merged into Requirement 3 ("Native Runtime — Legacy seasonSync.ts Path Performs Full-Workspace sync-baseline Saves On Routine Catch-Up"). The original concern (legacy `seasonSync.ts` rewriting full workspaces tagged `sync-baseline` on routine catch-up) and its sub-concern (the legacy path must be unreachable on the native runtime) are both covered as Current Behavior 1.1–1.3 and Expected Behavior 2.1–2.3 of Requirement 3. This entry is retained as a placeholder so subsequent requirement numbers (12 and onward) do not shift.

### Requirement 12: Notification Pipeline — Legacy Firestore Adapter Has No flushScheduleNotifications Implementation

Evidence:
- `app/src/lib/seasonSync.ts:90-100` — `flushScheduleNotifications(remoteStore, seasonId)` calls `remoteStore.flushScheduleNotifications?.(...)` if the adapter implements it.
- `app/src/lib/supabaseStore.ts:1171-1185` — the Supabase adapter DOES implement `flushScheduleNotifications`. It invokes the Edge Function `schedule-telegram-notify` via `invokeSupabaseFunction`, passing `seasonId` and `limit`, and returns `{ sent, failed, skipped, deliveryIds }` with safe defaults. This is the working production implementation when `NEXT_PUBLIC_REMOTE_BACKEND === 'supabase'`.
- `app/src/lib/remoteStore.ts:156-204` — `getRemoteStore()` dispatches to `supabaseStore` when `shouldUseSupabase()` returns true, and otherwise dynamically imports the Firestore adapter via `getFirestoreStore()`. The Firestore-era adapter constructed there does NOT define `flushScheduleNotifications`, so the optional chaining in `seasonSync.ts` returns `undefined` on that branch.
- The native command `sync_pending_changes` flushes notifications independently via `flush_schedule_notifications` (`app/src-tauri/src/native_catchup.rs:4125-4130`).

#### Current Behavior (Defect)

1.1 WHEN a season is opened against `NEXT_PUBLIC_REMOTE_BACKEND != 'supabase'` and the legacy Firestore adapter is loaded via `getFirestoreStore()` THEN the system has no `flushScheduleNotifications` implementation on that adapter, so the call chain in `seasonSync.ts` silently no-ops while still appearing to "best-effort flush" notifications.
1.2 WHEN auditors read the `RemoteStore` interface THEN the system makes `flushScheduleNotifications` an optional method, which lets a missing implementation pass code review without an obvious error; the gap is only observable at runtime against the legacy backend.

#### Expected Behavior (Correct)

2.1 WHEN the codebase is cleaned THEN the system SHALL either retire the legacy Firestore adapter entirely (see Requirement 13) so that only `supabaseStore.flushScheduleNotifications` is reachable, OR add an explicit `flushScheduleNotifications` implementation on the Firestore adapter that throws or logs a clearly named "not supported on legacy Firestore backend" error so the legacy path cannot pretend coverage.
2.2 WHEN `RemoteStore` is the canonical interface THEN the system SHALL make `flushScheduleNotifications` non-optional once Supabase is the only supported backend, so the type system enforces an implementation on every adapter.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN sync runs through `supabaseStore.flushScheduleNotifications` THEN the system SHALL CONTINUE TO invoke `schedule-telegram-notify` and return `{ sent, failed, skipped, deliveryIds }`.
3.2 WHEN sync runs through the native `sync_pending_changes` path THEN the system SHALL CONTINUE TO best-effort flush schedule notifications and report counts in `notification_sent` and `notification_failed`.
3.3 WHEN `enqueue_schedule_notification_delivery` trigger fires on `season_change_events` insert THEN the system SHALL CONTINUE TO populate `schedule_notification_deliveries`.

### Requirement 13: Code Health — Firestore Adapter Is A Live Fallback With No Operational Use Case

Evidence:
- `app/src/lib/remoteStore.ts:195-200` — `getRemoteStore()` dynamically imports `./firestore` via `getFirestoreStore()` when `shouldUseSupabase()` returns false (i.e., when `NEXT_PUBLIC_REMOTE_BACKEND` is not `supabase`). The Firestore code path is therefore reachable at runtime, just gated by an environment variable.
- `app/src/lib/firestore.ts`, `app/src/lib/firebase.ts`, and `app/src/lib/firestoreWritePlanner.ts` exist with `firebase/*` imports.
- `architecture.md` declares Supabase as the operational backend. There is no documented use case for the Firestore branch in the current deployment, and the broader audit healthy-areas list does not call it out as a supported fallback.
- `supabaseStore.ts` re-uses `firestoreWritePlanner` for batching constants (`FIRESTORE_WRITE_BATCH_SIZE`, `chunkFirestoreWrites`, `pauseBetweenFirestoreWriteBatches`) — that is a misnamed dependency on a constant, not actual Firestore traffic.
- `app/src/lib/sourceRowPatterns.ts` is imported only as a type by `supabaseStore.ts`, `remoteStore.ts`, `firestore.ts`, and `detailed/ConfirmModal.tsx`. No runtime use other than the modal label, so its bulk appears to be legacy reference data.

#### Current Behavior (Defect)

1.1 WHEN the Next.js bundle is built THEN the system retains a dynamic-import-reachable Firestore adapter, the Firebase SDK, and the `firestore.ts`/`firebase.ts`/`firestoreWritePlanner.ts` modules even though Supabase is the operational backend per `architecture.md` and no documented operational scenario uses the Firestore branch. The branch is live code, not dead code, but it has no operational use case and adds bundle bloat plus cognitive load.
1.2 WHEN auditors read the lib directory THEN the system presents two persistence backends as if they were both alive, contradicting `architecture.md` ("Supabase is the shared backend... Browser/static mode is not the operational source of truth"). A reviewer cannot tell from the code alone that the Firestore branch is not selected in any shipped configuration.

#### Expected Behavior (Correct)

2.1 WHEN the codebase is cleaned THEN the system SHALL either (a) delete `firestore.ts`, `firebase.ts`, `firestoreWritePlanner.ts` and the `firebase` npm dependency, AND remove the `getFirestoreStore()` branch from `remoteStore.ts` so `getRemoteStore()` returns `supabaseStore` unconditionally; OR (b) explicitly relocate those modules to `app/src/lib/legacy/` and gate the Firestore branch behind a build flag (for example, a `NEXT_PUBLIC_ENABLE_LEGACY_FIRESTORE` flag with a default of `false`) so that production bundles can no longer reach the legacy adapter.
2.2 WHERE option (a) is chosen THEN the system SHALL also rename `firestoreWritePlanner` to a backend-neutral name (`batchWritePlanner`) and retire `sourceRowPatterns.ts` if no live consumer remains, OR keep its surviving consumers documented under `lib/`.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `firestoreWritePlanner` constants are still required for Supabase batch writes THEN the system SHALL CONTINUE TO chunk uploads with the same batch size and pause behavior, just under a backend-neutral name.
3.2 WHEN `ConfirmModal.tsx` displays a delete-source-row preview THEN the system SHALL CONTINUE TO render the same operator-facing summary, with or without the `sourceRowPatterns` type.
3.3 WHEN `NEXT_PUBLIC_REMOTE_BACKEND` is set to `supabase` (the operational configuration) THEN the system SHALL CONTINUE TO route all remote calls through `supabaseStore`.

### Requirement 14: Code Health — Corrupted SeasonalSchedulePage Sidecar In Source Tree

Evidence:
- `app/src/app/SeasonalSchedulePage.tsx.corrupted-20260524-171751` is committed alongside the live `SeasonalSchedulePage.tsx`.
- `seasonal/page.tsx` re-exports `'../SeasonalSchedulePage'` (the live file), so the corrupted sidecar is unused but is still part of the repo and is picked up by some IDE indexers and GitNexus.

#### Current Behavior (Defect)

1.1 WHEN the repo is opened in an editor or indexer THEN the system surfaces a `*.corrupted-...` sidecar file under `app/src/app/` as if it were a valid module.
1.2 WHEN a future refactor accidentally globs `*.tsx` under `app/src/app/` THEN the system risks compiling or shipping the corrupted sidecar.

#### Expected Behavior (Correct)

2.1 WHEN the repo is cleaned THEN the system SHALL remove `SeasonalSchedulePage.tsx.corrupted-20260524-171751` from `app/src/app/` (move to `_codex_backups/` if any history is desired, otherwise delete).
2.2 WHEN a future incident produces a corrupted snapshot THEN the system SHALL place it under `_backups/` or `_codex_backups/` (the directories already excluded from search), not next to live source.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `seasonal/page.tsx` re-exports `SeasonalSchedulePage` THEN the system SHALL CONTINUE TO load the live module unchanged.
3.2 WHEN tooling enumerates `app/src/app/**/*.tsx` THEN the system SHALL CONTINUE TO build successfully (no missing module after removal of the sidecar).

### Requirement 15: Code Health — applyLocal Mutation Fallbacks Trigger Disallowed Full-Workspace Save

Evidence:
- `app/src/lib/localSeasonStore.ts:1019-1115` — `applyLocalFlightRecordMutation`, `applyLocalModificationBatch`, and `applyLocalSourceRows` first attempt `runNativeScheduleMutation` or `runNativeLocalModificationBatchDelta`. If the native call returns null, each calls `saveLocalSeasonWorkspace(next)` without any `nativeFullSaveReason`.
- `app/src/lib/localSeasonStore.ts:612-628` — `saveLocalSeasonWorkspace` throws `'Native desktop full-workspace saves are disabled. Use native row-level commands, or pass an explicit import/repair reason.'` when the SQL DB is in native runtime and no reason is supplied.
- Net effect on the native runtime: if the IPC bridge ever returns `null` (transient, partial native runtime, or edge case where `isTauriRuntime()` returns false), the fallback path immediately throws an opaque error instead of failing gracefully or surfacing a clear retry.

#### Current Behavior (Defect)

1.1 WHEN the native IPC bridge returns null on the desktop runtime THEN the system throws `'Native desktop full-workspace saves are disabled...'` from inside what is supposed to be a fallback, surfacing an opaque error to the user.
1.2 WHEN the IndexedDB legacy path is supposed to be available (test or browser) THEN the fallback writes the entire workspace through `saveLocalSeasonWorkspace(next)` with no `writeLabel`, blurring "delta" and "full-snapshot" semantics for callers reading the audit log.

#### Expected Behavior (Correct)

2.1 WHEN the native IPC bridge returns null on the desktop runtime THEN the system SHALL surface a structured "native runtime unavailable" error that the UI can present (with a retry option), rather than fall through to the disallowed full-workspace save path.
2.2 WHEN the fallback is intentionally exercised (browser or legacy environment) THEN the system SHALL pass an explicit reason such as `nativeFullSaveReason: 'legacy-edit'` so write-label auditing is unambiguous, OR refactor the legacy fallback to a row-level path under IndexedDB.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN the native IPC bridge returns a `LocalSyncMeta` THEN the system SHALL CONTINUE TO finish the mutation by reloading the workspace and returning it.
3.2 WHEN unit tests run against the IndexedDB-backed fallback THEN the system SHALL CONTINUE TO be able to apply mod and record changes and re-read them.

### Requirement 16: Verification Gap — No Test For Reverting An Edit Clearing The Pending Op

Evidence:
- `architecture.md` and `context.md` invariant: pending operations are derived from the difference between current local workspace and saved server baseline; reversing an edit must clear the pending op.
- `app/src-tauri/src/native_catchup.rs` implements a "no-op vs base" check (`is_no_op_modification_against_base_record`) that drops pending ops when a modification is reverted to baseline.
- `app/src-tauri/tests/native_catchup.rs` covers many positive scenarios (sparse delete normalization, effective totals, schedule mutation, allocation delta) but contains no test that exercises "apply a modification, then reverse it to baseline, and assert `local_pending_ops` is empty and pendingCount is 0".

#### Current Behavior (Defect)

1.1 WHEN a regression in `is_no_op_modification_against_base_record` fails to drop a reverted modification THEN the system has no automated test that catches it; the bug only surfaces when an operator notices `Unsynced (1)` after a manual revert.
1.2 WHEN flight-record, source-row, or link reversals are evaluated THEN the system has no automated test that the same invariant holds for those targets.

#### Expected Behavior (Correct)

2.1 WHEN the automated test suite runs THEN the system SHALL include at least one Rust integration test that applies a modification, then re-applies the baseline value, and asserts `local_pending_ops` for that season is empty.
2.2 WHEN the same test suite runs THEN the system SHALL include analogous coverage for flight-record updates and link/unlink reversals on `local_flight_records`.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN a real edit moves a value away from baseline THEN the system SHALL CONTINUE TO emit one pending op for the affected target.
3.2 WHEN multiple edits accumulate THEN the system SHALL CONTINUE TO merge them via `merge_pending_ops`.

### Requirement 17: Verification Gap — No Test For Telegram Payload Round-Trip Through Native Sync

Evidence:
- `architecture.md`: Rust and TypeScript must preserve the full `scheduleNotification` payload.
- `app/src-tauri/tests/native_catchup.rs` includes `native_schedule_mutation_preserves_schedule_notification_for_added_pairs` for one specific case (added pairs) but does not assert the round-trip across:
  1. TS supplies `scheduleNotification` to `runNativeLocalModificationBatchDelta` or `runNativeScheduleMutation`.
  2. Rust persists it on the modHistory pending op.
  3. Rust V2 event payload preserves it for `season_change_events` insert.
  4. The insert trigger `enqueue_schedule_notification_delivery` enqueues it into `schedule_notification_deliveries`.
- The existing notification unit test (`scheduleNotifications.test.ts`) operates on the TS payload only.

#### Current Behavior (Defect)

1.1 WHEN a future change to `mod_history_entry_payload` or `build_native_pending_change_events` drops or mangles `scheduleNotification` THEN the system has no end-to-end test that fails.
1.2 WHEN the trigger contract changes (`enqueue_schedule_notification_delivery` requires `module in ('seasonal','detailed')`) THEN the system has no automated test that covers the contract beyond manual verification.

#### Expected Behavior (Correct)

2.1 WHEN the test suite runs THEN the system SHALL include an integration test (Rust or Edge Function smoke) that supplies a `scheduleNotification` payload through `apply_local_modification_batch_delta` and asserts the V2 event built by `build_native_pending_change_events` carries the same payload byte-for-byte under `opPayload.entry.scheduleNotification`.
2.2 WHEN the test suite runs THEN the system SHALL include a Postgres-level test (e.g. via `rtk npm run test:notifications`) that asserts the trigger inserts a delivery row when the event is inserted.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN `scheduleNotification` is absent from a history entry THEN the system SHALL CONTINUE TO be a no-op for the trigger.
3.2 WHEN deliveries already exist for a `(season_id, history_entry_id)` THEN the system SHALL CONTINUE TO honor `on conflict do nothing`.

### Requirement 18: Verification Gap — Migration Idempotency And Replay Are Not Automated

Evidence:
- Migrations under `app/supabase/migrations/` contain function redefinitions (`create or replace function ...`) and one-shot data backfills (`20260527092757_exact_season_filtering.sql` updates rows then re-asserts NOT NULL FK), but the repo has no automated test that re-applying every migration after `schema.sql` is a no-op.
- `architecture.md` lists `rtk npm run test:rules`, `rtk npm run test:notifications`, `rtk npx tsc --noEmit --pretty false`, `rtk npm run build`, and `rtk npm run native:build`. None of these touches migration replay or idempotency.

#### Current Behavior (Defect)

1.1 WHEN a future migration accidentally introduces a non-idempotent statement (`alter table ... drop constraint ...` not guarded by `if exists`) THEN the system has no automated test that catches the failure on a re-applied database.
1.2 WHEN `schema.sql` and the ordered migrations diverge (Requirement 6) THEN the system has no automated check to assert "fresh-bootstrap from schema.sql then apply migrations" produces the same DB as "drop everything then apply migrations from scratch".

#### Expected Behavior (Correct)

2.1 WHEN CI runs THEN the system SHALL include a Supabase migration replay check (e.g. apply all migrations against a fresh DB twice and diff `pg_dump --schema-only`) that asserts idempotency.
2.2 WHEN CI runs THEN the system SHALL include a baseline-vs-migrations check that asserts `schema.sql` plus migrations matches a clean migration-only build.

#### Unchanged Behavior (Regression Prevention)

3.1 WHEN current migrations are applied in order to a fresh project THEN the system SHALL CONTINUE TO produce a working schema with all RLS policies, RPCs, and indexes.
3.2 WHEN `architecture.md` lists the verification commands THEN the system SHALL CONTINUE TO support those exact commands; the new check is additive.
