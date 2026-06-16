# Season Assignment & Atomic Import/Flight Management Review

> **For agentic workers:** This document reviews the current season-assignment and atomicity model in the import + flight management pipeline. It is **not yet a task plan**. The proposed adjustments (section 5) can be promoted into a phased plan if the user agrees with the direction.

**Scope:** `app/src/app/SeasonalSchedulePage.tsx` (seasonal import), `app/src/app/daily/page.tsx` (daily import), the underlying remote (Supabase) and local (SQLite/Tauri) persistence layers, and the `applyLocal*` mutation functions in `app/src/lib/localSeasonStore.ts`.

**Goal:** Surface correctness, atomicity, and ownership gaps in how data is bound to a season, then propose adjustments that are minimally invasive, backward-compatible, and verifiable with the existing test harnesses.

---

## 1. Current Behavior Recap

### 1.1 Season ID generation

- `createSeason` (`app/src/lib/supabaseStore.ts:724`) generates `id = randomId('season')` — a fresh UUID-like string per call. Not derived from the source file or the IATA season code.
- `findSeasonByCode` (`app/src/lib/supabaseStore.ts:716`) uses `client().from('seasons').select('*').eq('season_code', code).maybeSingle()` (line 718). `.maybeSingle()` returns `null` only for zero rows — on multiple matches it raises a PostgREST error, it does not return the first row.

### 1.2 Flight record ID generation

There are **three** ID generation paths in the import flows. None of them is namespaced by season.

**Seasonal schedule path** (`app/src/app/SeasonalSchedulePage.tsx:1177-1449`):
- `parseSeasonalSchedule` parses the workbook into `ParsedRow[]` (`app/src/lib/parser.ts:109`).
- The handler then calls `flattenRowsToFlightRecords(rows)` at `app/src/app/SeasonalSchedulePage.tsx:1194`. This function (`app/src/lib/atomicSchedule.ts:550`) uses `recordId(row, side, date)` (`atomicSchedule.ts:437`) which builds IDs of the form `LEG_${type}_${operationalDate}_${rowIndex}_${airline}_${flightNumber}_${route}_${schedule}_${aircraft}` (e.g. `LEG_A_2025-03-29_3_NX_NX978_HAN_09:30_A320`).
- The `LEG_` prefix and the `rowIndex` segment make this ID per-file-instance even when the content is identical. Two files that re-import the same content will produce the same `record_id` (because the parser is deterministic and the rows have stable `rowIndex`), so re-import is idempotent for the ID space.
- **The parser's `expandToFlightLegs` (`app/src/lib/parser.ts:196`) is NOT in the active seasonal import path.** It is a legacy/fallback adapter used by other code paths. F-7 only applies to that path; it is not an active import risk.

**Daily schedule path** (`app/src/app/daily/page.tsx:810-1111`):
- New daily records are built by `buildNewRecord(leg)` in `app/src/lib/dailyScheduleImport.ts:511` with the format `DAILY_IMPORT_${type}_${operationalDate}_${flightNumber}_${route}_${schedule}_${aircraft}_...`.
- Existing daily records that are being updated reuse their existing `record_id`. The daily path does not use `atomicSchedule.recordId` either.
- The `DAILY_IMPORT_` prefix separates daily IDs from seasonal IDs, so cross-flow collision is not a concern.

**ID space summary:**
- Seasonal IDs: `LEG_*` (one prefix, content + `rowIndex`).
- Daily new IDs: `DAILY_IMPORT_*` (different prefix).
- The two ID spaces are disjoint, so cross-flow collision is not a concern.
- Within the seasonal flow, `LEG_*` IDs are **not** namespaced by season. Two seasons that contain the same flight with the same operationalDate, same rowIndex, same airline, same flight number, same route, same schedule, and same aircraft will produce **identical** `record_id` values. The parser is deterministic and the segments are content-based, so a rare-but-possible collision (e.g. on IATA switchover days where two seasons' files overlap on the same flight, or when a user re-imports the same file under a different `seasonCode` label) will hit the global `record_id` PK in `season_flight_records` and fail with a `23505` unique violation. **The remote global PK cannot represent the same `record_id` under two different `season_id` values** — that is the structural problem F-2 is trying to fix.

### 1.3 Local vs remote key shape

- **Local SQLite `local_flight_records`** (`app/src/lib/localSeasonSqlStore.ts:105`): `PRIMARY KEY (season_id, record_id, is_base)` — composite, season-scoped.
- **Remote Supabase `season_flight_records`** (`app/supabase/schema.sql:181`): `record_id text primary key` — **global** primary key, not season-scoped.
- **Local `local_modifications`** (`app/src/lib/localSeasonSqlStore.ts:108`): composite `(season_id, leg_id, is_base)`.
- **Remote `season_modifications`** (`app/supabase/schema.sql:240-242`): `leg_id text primary key` — also global.
- The two sides therefore treat ownership differently. Local enforces the season boundary; remote does not.

### 1.4 Import flow (seasonal)

`app/src/app/SeasonalSchedulePage.tsx:1177-1449` runs the following sequence, each step is a separate Supabase call:

1. `findSeasonByCode(seasonCode)` (line 1203)
2. `queryNativeSyncSummary(existing.id)` (line 1205)
3. `getDirtyImportGuard(...)` (line 1206)
4. `clearSourceRows(seasonId)` (line 1298) — only on patch path
5. `deleteModifications(seasonId, modificationDeleteRecordIds)` (line 1300) — only on patch path
6. `updateSeason(seasonId, seasonFields)` or `createSeason(...)` (lines 1302, 1306)
7. `batchWriteFlightRecords(seasonId, recordsToWrite, ...)` (line 1312) — chunked with `pauseBetweenFirestoreWriteBatches()` between batches
8. `importNativeSeasonSnapshot({...})` (line 1337) — single native command, atomic in itself (`BEGIN IMMEDIATE` / `COMMIT`/`ROLLBACK` at `app/src-tauri/src/native_catchup.rs:1795-1838`)

Failure between step 4 and step 8 leaves the remote in a partial state. The error handler at line 1443-1445 only logs the alert; there is no compensating rollback.

### 1.5 Daily import flow

`app/src/app/daily/page.tsx:810-1111` uses `enqueueLocalMutation` to serialize against the workspace lock. For each batch:
- Calls `createSeason(seasonFields)` (`daily/page.tsx:847`) **only when `findSeasonByCode` returned null**. Re-imports the same season just go through `findSeasonByCode` and update the in-memory `seasonsByCode` map.
- Then calls `runNativeScheduleMutation` (line 882) which mutates the local SQLite store. Remote writes are **deferred** — the user is told to "Use Save to push changes to the server" (line 937).

The daily import therefore does not have the same multi-step Supabase write sequence as the seasonal import. Atomicity discussion for daily is mostly about the native side, which is already atomic.

### 1.6 Flight mutation flows

- `applyLocalFlightRecordMutation` (`app/src/lib/localSeasonStore.ts:701`): native path first, JS fallback `saveLocalSeasonWorkspace` (line 735). Atomic at the workspace level via the SQL queue.
- `applyLocalModificationBatch` (`app/src/lib/localSeasonStore.ts:739`): same pattern.
- `applyLocalSourceRows` (`app/src/lib/localSeasonStore.ts:770`): same pattern.
- `applyLocalModificationBatchDelta` (`app/src/lib/localSeasonStore.ts:606`): read-then-replace pattern (Task 2 of the existing 2026-06-16 plan covers this).

---

## 2. Findings

### F-1 (High): `seasons.season_code` is not uniquely constrained

**Where:** `app/supabase/schema.sql:133-145` (no `UNIQUE` on `season_code`).

**Why it matters:** `findSeasonByCode` uses `.maybeSingle()`. If two rows with the same `season_code` ever land in the table, `.maybeSingle()` returns an error rather than a deterministic row. The follow-up behaviour is runtime-dependent — Supabase's `maybeSingle()` throws on multiple matches, so the import path will fail with a non-obvious error rather than silently patching a wrong season. The risk is real: any race between two import tabs, or any retry that re-inserts before the original insert is observed, can land two rows.

**The failure mode is "non-deterministic runtime error," not "silent corruption"** as previously documented. Both deserve the fix; the description should not overstate the silent-corruption risk.

### F-2 (High): `record_id` and `leg_id` are globally unique PKs, not season-scoped

**Where:** `app/supabase/schema.sql:181` (`record_id text primary key`), `:242` (`leg_id text primary key`).

**Why it matters:** Both ID generators are content-based, so two seasons with overlapping content on the same date (rare but possible: IATA switchover dates can overlap, or a user re-imports S25 and S26) will collide on the global PK. The collision shows up as a Supabase `23505` unique violation, not silent corruption.

**Scope of the fix is broader than the original review suggested.** The child tables currently do **not** have a `season_id` column at all — they are joined to `season_flight_records` / `season_modifications` only through the global `record_id` / `leg_id` foreign key. If the parent PK becomes composite, the child tables need to be reworked, not just re-indexed.

Concrete changes:

- **Schema changes per child table:**
  - `season_flight_record_counters` (`app/supabase/schema.sql:222-229`): add `season_id text not null` column, backfill it from `season_flight_records.season_id` via `UPDATE ... FROM season_flight_records`, then change PK to `PRIMARY KEY (season_id, record_id, counter_group, item_index)` and FK to `FOREIGN KEY (season_id, record_id) REFERENCES season_flight_records(season_id, record_id)`.
  - `season_flight_record_checkin_windows` (`schema.sql:231-238`): same pattern, PK `(season_id, record_id, counter_key)`.
  - `season_modification_counters` (`schema.sql:263`): same pattern, backfill from `season_modifications.season_id`, PK `(season_id, leg_id, counter_group, item_index)`.
  - `season_modification_checkin_windows` (`schema.sql:272`): same pattern, PK `(season_id, leg_id, counter_key)`.
- **Parent table PK changes:**
  - `season_flight_records`: drop `record_id` PK, add `PRIMARY KEY (season_id, record_id)`.
  - `season_modifications`: drop `leg_id` PK, add `PRIMARY KEY (season_id, leg_id)`. (`season_modifications` already has `season_id text not null` per `schema.sql:241`, so the backfill is a no-op — only the PK change is needed.)
  - `season_source_rows` already uses `(season_id, row_index)` per `app/src/lib/supabaseStore.ts:844` — no change.
- **SQL RPCs in `schema.sql`:** lines 935, 942, 952, 956, 960, 964, 975, 1039, 1046, 1056, 1060, 1064, 1068, 1079 are all `WHERE record_id = ...` or `WHERE leg_id = ...`. After the migration these must filter by `(season_id, record_id)` / `(season_id, leg_id)` or accept `season_id` as an additional parameter. Lines 1335-1339 (the reporting aggregation) and 1824-1828 (the cleanup RPC) need the same update.
- **Caller updates in `app/src/lib/supabaseStore.ts`:**
  - `upsertRows('season_flight_records', ..., 'record_id')` (line 862) → `'season_id,record_id'`.
  - `removeModification(seasonId, legId)` (line 1056) → add `.eq('season_id', seasonId)`.
  - `deleteModifications(seasonId, legIds)` (line 1060) → add `.eq('season_id', seasonId)` for every chunk.
  - `writeFlightRecordCounters` (line 566), `writeFlightRecordWindows`, `writeModificationChildren` (line 614) — switch their `delete().in('record_id', ...)` and `delete().in('leg_id', ...)` to also `.eq('season_id', seasonId)`. The child-table inserts must include the new `season_id` column in the row payload.
  - `readFlightRecordCounters` / `readFlightRecordWindows` / read equivalents — add `.eq('season_id', seasonId)` filters.
- **Edge Functions and RPCs:**
  - `app/supabase/functions/dashboard-ai-analysis/index.ts` and `app/supabase/functions/_shared/dashboardAiShared.ts` may join on the global keys; verify and add `season_id` filter.
  - Any reporting RPC that filters or groups by `record_id` / `leg_id` alone must add `season_id`.
- **Tests:**
  - Add a rule-regression test that asserts the conflict key strings contain `season_id` for every table that previously used a global key.
  - Add a remote-PK shape test that asserts the primary keys include `season_id` (if such a test framework exists; otherwise source-text).
  - Add a migration-shape test that asserts the child-table migrations include `ADD COLUMN season_id` and a `UPDATE ... FROM parent` backfill.

### F-3 (High): `deleteModifications(seasonId, legIds)` does not filter by `seasonId`

**Where:** `app/src/lib/supabaseStore.ts:1060-1066`.

The method receives `seasonId` as the first parameter but the delete is `from('season_modifications').delete().in('leg_id', chunk)` — **no `.eq('season_id', seasonId)`**. The parameter is effectively unused. If a `leg_id` ever exists in two seasons, deleting from one will delete from both. The `removeModification(seasonId, legId)` call at line 1056-1058 has the same bug.

### F-4 (Medium): Multi-step seasonal import is not atomic across the remote write boundary

**Where:** `app/src/app/SeasonalSchedulePage.tsx:1295-1358`.

The 5+ sequential Supabase calls each have their own failure mode. If the user re-imports the same file after a partial failure, the `findSeasonByCode` branch picks the partially-patched season and tries to patch it again. The integrity check at line 1359 only verifies the native side, not the Supabase side. Note: this section does not apply to the daily import flow (which is mostly local-side mutation, see §1.5).

### F-5 (Medium): Native import overwrites remote asynchronously

**Where:** `app/src/app/SeasonalSchedulePage.tsx:1310-1345`.

`batchWriteFlightRecords` runs against Supabase first, then `importNativeSeasonSnapshot` runs against native. If the user closes the app between these two calls, the remote has records that the local side does not. The next catch-up will treat the local side as the source of truth and the remote writes are now orphans.

### F-6 (Medium): Patch path is "delete and rewrite" instead of UPSERT-then-cleanup

**Where:** `app/src/app/SeasonalSchedulePage.tsx:1298-1300`, `:1311-1315`.

The current code deletes source rows and modifications, then writes the merged set. If a `recordId` exists in the merged set but the prior remote write is still propagating, the delete happens after the prior write completes — leaving a window where neither side has the row.

### F-7 (Low — legacy adapter only, not active import risk): `parser.expandToFlightLegs` infers season year from first row

**Where:** `app/src/lib/parser.ts:200-201` (`guessSeasonYear`).

**Scope correction:** The active seasonal import (`SeasonalSchedulePage.tsx`) does **not** call `expandToFlightLegs`. The active path uses `flattenRowsToFlightRecords` → `recordId()` (see §1.2). The `guessSeasonYear` shift can therefore only affect **callers that still use `expandToFlightLegs` as a legacy/fallback adapter**. Any remaining caller is at risk of stamping wrong dates, but the active seasonal import is not.

**Risk:** If a workbook starts with a "Discontinue" date earlier than "Effective" (or a row with no effective date), the inferred `seasonYear` will be wrong and every subsequent leg's `dateStr` will shift. The legs are then stamped with dates that don't match the `seasonCode`. This makes the produced `record_id` disagree with the date the user expects, but only on the legacy path.

### F-8 (Low): `applyLocalSourceRows` native branch returns a workspace with stale `derivedSeasonal`

**Where:** `app/src/lib/localSeasonStore.ts:777-794`.

Already covered by Task 3 of the existing 2026-06-16 plan. Mentioned here for completeness.

---

## 3. Why the Current Model Still Works in Practice

Despite F-1 through F-6, the import pipeline has held up in production because:

1. **The IATA switchover date is consistent.** S25 ends ~Oct 2025, S26 starts ~Mar 2026. The 5-month gap means re-imports rarely produce overlapping `record_id` values across seasons.
2. **Re-importing the same file is idempotent.** The `findSeasonByCode` + patch path produces the same records, so the global PK conflict is avoided within a single season.
3. **The native import is atomic.** Even if the remote writes are partial, the local side is always consistent, and the catch-up flow will re-apply any missing remote events.
4. **Most operations are read-then-display.** The race between batch write and native import is masked by the ~200ms `WORKSPACE_CHANGE_DEBOUNCE_MS` debounce in the provider (`app/src/app/components/SeasonSyncProvider.tsx:75`).

The model is fragile, not broken. The user-visible failure modes are:
- Accidental double-import of the same file (duplicate `record_id` PK conflict in Supabase — fails loudly, not silently).
- Patch import of a season that already has unsynced local changes (the dirty guard at `app/src/app/SeasonalSchedulePage.tsx:1206` covers the main case but not the rare two-tab race).
- Orphaned remote writes if the user closes the app between Supabase and native steps.

---

## 4. Existing Tests That Cover (or Don't Cover) These Findings

| Finding | Existing test surface |
|---|---|
| F-1 | `app/scripts/rule-regression-tests.cjs` has source-text checks for `findSeasonByCode` callers but no integration test that inserts two rows with the same `season_code` and asserts the second is rejected. |
| F-2 | `app/src/lib/localSeasonSqlStore.test.ts:241` asserts composite PK exists. No remote-side test. The child-table readers/writers (`supabaseStore.ts:566-617`) are also not covered by behaviour tests. |
| F-3 | No test. |
| F-4 | `app/src/lib/seasonalImportModeGuard.test.ts` checks for `deleteModifications(seasonId, modificationDeleteRecordIds)` in source text. No behavior test. |
| F-5 | No test. |
| F-6 | `rule-regression-tests.cjs:10172` checks for `importNativeSeasonSnapshot` call. No atomic-rollback test. |
| F-7 | No test. |
| F-8 | Covered by Task 3 of the existing 2026-06-16 plan. |

---

## 5. Proposed Adjustments

The proposals are ordered from highest ROI to lowest. Each is self-contained, can ship independently, and is verifiable with the existing test harnesses.

### 5.1 (Revised) Document the failure mode for F-1 honestly

The original review described F-1's failure mode as "silent patch of the first matching season." That description was wrong. `findSeasonByCode` uses `.maybeSingle()` which throws on multiple matches. The actual failure mode is **runtime error during import** — the import throws and the user sees an error toast, not a silent corruption.

The fix is still worth doing (race conditions and retries can still produce duplicate inserts), but the description must match the code. The plan below reflects this.

### 5.2 Add a `UNIQUE` constraint on `seasons.season_code` (F-1)

**Cost:** 1 Supabase migration + 1 helper rule-regression test.

- Add a new migration `app/supabase/migrations/20260616_uniq_seasons_season_code.sql` that:
  - Adds `UNIQUE` on `seasons(season_code)` after first running a de-dup pass that picks the most recent season for each `season_code` and reassigns the orphaned records (or deletes them, depending on user policy).
- Add a `rule-regression-tests.cjs` test that asserts the migration's SQL text contains the `UNIQUE` clause.
- Verify the `findSeasonByCode` callers surface a useful error message to the user (today the error bubbles up from `assertOk` with the raw Supabase error text).

**Trade-off:** Existing duplicates in production need a one-time cleanup script. The 2026-05-30 S26 repair (`context.md:31`) already wrote backup tables, so a follow-up cleanup can be planned from that baseline.

### 5.3 (Revised) F-2 migration scope: child tables and RPCs

**Cost:** 1 schema migration per affected table + coordinated caller updates + Edge Function regression sweep.

The original review listed only 3 call sites in `supabaseStore.ts`. The actual scope includes:

- **Table PK changes:**
  - `season_flight_records`: drop `record_id` PK, add `PRIMARY KEY (season_id, record_id)`.
  - `season_modifications`: drop `leg_id` PK, add `PRIMARY KEY (season_id, leg_id)`.
  - `season_flight_record_counters` and `season_flight_record_checkin_windows`: PK already includes `record_id` only — needs `PRIMARY KEY (season_id, record_id, ...other columns)`.
  - `season_modification_counters` and `season_modification_checkin_windows`: same pattern.
  - `season_source_rows` already uses `(season_id, row_index)` per `app/src/lib/supabaseStore.ts:844` — no change.
- **Caller updates in `app/src/lib/supabaseStore.ts`:**
  - `upsertRows('season_flight_records', ..., 'record_id')` (line 862) → `'season_id,record_id'`.
  - `removeModification(seasonId, legId)` (line 1056) → add `.eq('season_id', seasonId)`.
  - `deleteModifications(seasonId, legIds)` (line 1060) → add `.eq('season_id', seasonId)` for every chunk.
  - `writeFlightRecordCounters` (line 566), `writeFlightRecordWindows`, `writeModificationChildren` (line 614) — switch their `delete().in('record_id', ...)` and `delete().in('leg_id', ...)` to also `.eq('season_id', seasonId)`.
  - `readFlightRecordCounters` / `readFlightRecordWindows` / read equivalents — add `.eq('season_id', seasonId)` filters.
- **Edge Functions and RPCs:**
  - `app/supabase/functions/dashboard-ai-analysis/index.ts` and `app/supabase/functions/_shared/dashboardAiShared.ts` may join on the global keys; verify and add `season_id` filter.
  - Any reporting RPC that filters or groups by `record_id` / `leg_id` alone must add `season_id`.
- **Tests:**
  - Add a rule-regression test that asserts the conflict key strings contain `season_id` for every table that previously used a global key.
  - Add a remote-PK shape test that asserts the primary keys include `season_id` (if such a test framework exists; otherwise source-text).

**Trade-off:** This is a breaking schema change. Any external consumer of the Supabase schema (BI tools, exports) must be updated. The `.kiro/specs/architecture-database-audit/design.md` already documents the season-scoped ownership direction, so the migration is consistent with documented intent.

### 5.4 (Revised) Atomicity for the seasonal import is not a single transaction

The original review proposed a "true atomic" Supabase RPC + native command combination. The reviewer rightly noted that SQLite and Supabase transactions cannot be rolled back across systems. There is no two-phase commit.

**Critical constraint from `context.md`:** Import is **server-first**, not local-first. `context.md:176` states: *"Import/re-import remains server-first because it establishes a new baseline. A successful import writes `sourceRows` and `flightRecords`, increments `dataVersion`, clears the local workspace for that season, and then saves a clean local baseline."* The local side is wiped to mirror the server, not the other way around.

**Current code is already server-first** — `SeasonalSchedulePage.tsx:1295-1358` runs the remote writes first (`clearSourceRows`, `deleteModifications`, `updateSeason`/`createSeason`, `batchWriteFlightRecords`, `verifySeasonImportCounts`, `getSeasonEventHighWater`) and only then runs `importNativeSeasonSnapshot` (line 1337). The problem is that each remote call is a separate Supabase request — there is no remote-side transaction wrapping them. F-4 (partial remote commit) and F-6 (delete-then-rewrite window) remain unfixed by any of the options below; they can only be fixed by wrapping the remote writes in a single Supabase RPC or `BEGIN`/`COMMIT` block. That is a separate piece of work (not part of this review's recommendations; see Open Question 3 below).

**This rules out a naive "local-first, then re-push remote on next catch-up" design.** There is no automatic outbox/recovery marker that would re-push a remote write that failed after the local import succeeded. The local is not a queue; it is a mirror.

**The remote-side is the weak link for the local mirror.** A server-first import can fail at two distinct points:
- **Point R: between remote writes** (e.g. `batchWriteFlightRecords` fails halfway). F-4/F-6 territory. The remote is in a partial state.
- **Point L: between remote commit and `importNativeSeasonSnapshot`.** The remote is fully committed, but the local mirror is stale. This is the only failure mode that "Re-sync local mirror" can recover from automatically.

The achievable options below all address **Point L** only. F-4/F-6 require a separate fix (remote RPC + transaction).

The achievable options are:

- **Option A: Server-first with native-mirror retry (no schema change).** The current code is already this. Add a "Re-sync local mirror" action that re-runs `importNativeSeasonSnapshot` against the latest remote state. This recovers from Point L failures only. The user has to re-import to recover from Point R failures. **This matches the documented server-first contract; Phase 4 in §9 implements this.**
- **Option B: Server-first with deferred local mirror (local schema/state change only, no RPC, no remote schema).** Run the remote writes; on success, mark the season as "remote-committed, local-pending" in a new local SQLite flag (or a new column in `local_seasons`). The local import runs on a background schedule or on next app launch. If the user closes the app between steps, the next launch detects the flag and runs the local mirror. No data loss on the remote; the local side is briefly stale. Same recovery profile as Option A for Point L; does not address Point R.
- **Option C: Remote-side mirror job (new remote schema).** Add a new remote table — for example `season_local_mirror_jobs` or `season_import_jobs` — that records the intended local mirror as a row written **inside a Supabase transaction together with the flight records** (or as a follow-up RPC after the records commit). The row carries the snapshot data or a pointer to a storage object. A background worker (Tauri command or Edge Function) drains the queue and calls `importNativeSeasonSnapshot`. This is the only option that gives strong "remote-then-mirror" guarantees without requiring the user to re-trigger anything on Point L. **Important: this table is REMOTE (Supabase), not local. Putting it in local SQLite defeats the purpose because the local side is the mirror, not the queue.** Adding this table means a new migration, a new RPC, and a new worker.
- **Option D: Best-effort with explicit user action (current behaviour).** Keep the current sequence, but on any failure show a clear "Partial import — local mirror may be stale. Re-import to re-sync." warning, and refuse to operate on the season until the user re-imports. This is the cheapest and matches the existing error-handling pattern (line 1443-1445 of `SeasonalSchedulePage.tsx`).

**Recommendation:** **Option A** is already in the code; the work is to add the "Re-sync local mirror" action and a flag in the season state to detect Point L failures. **Option C** is the strongest but requires a new remote table and a worker; defer it unless the team has evidence that Point L failures are common in production.

**The proposal in the previous draft (Supabase RPC + native command) should be replaced with the four options above, a recommendation of Option A for Point L, and an explicit note that F-4/F-6 are still unaddressed and need a separate remote-transaction fix.**

### 5.5 (Renumbered — was 5.3) Make `applyLocalSourceRows` consistent with `applyLocalFlightRecordMutation` (F-8)

**Cost:** 1 small refactor + Task 3 of the existing 2026-06-16 plan.

This is already on the existing 2026-06-16 plan. No new work, just confirming it stays in scope.

### 5.6 (Renumbered — was 5.4) Document the season ownership contract in `context.md`

**Cost:** 1 doc edit.

After F-1 and F-2 land, add a section to `context.md` that codifies:

- `seasons.season_code` is a unique business key; `seasons.id` is a generated PK.
- `(season_id, record_id)` and `(season_id, leg_id)` are the canonical composite keys for `season_flight_records` and `season_modifications` and their child tables. Any new schema change must preserve this. Child tables (`season_flight_record_counters`, `season_flight_record_checkin_windows`, `season_modification_counters`, `season_modification_checkin_windows`) **must** carry a `season_id` column matching the parent.
- `findSeasonByCode` uses `.maybeSingle()` and raises a PostgREST error on multiple matches. Callers should treat that error as a duplicate-insert race and surface a "Duplicate season_code detected" message rather than retry blindly.
- The seasonal import is **server-first**: the Supabase writes are the authoritative commit. The local SQLite mirror is rebuilt from the committed remote state via `importNativeSeasonSnapshot`. A failed local mirror does not invalidate the remote commit; the user is prompted to re-trigger the local mirror.
- The daily import mutates the local store only; remote writes are deferred to the explicit Save flow. There is no outbox for daily imports — they are local-first only, with the remote pending-op queue handling the eventual upload.
- Re-import after a partial failure re-runs the full server-first sequence. After a completed remote commit, the local side is at most one mirror behind and the "Re-sync local mirror" action brings it in line. If the failure happens at Point R (between remote writes), the remote may be in a partial state and requires Phase 5 (remote transaction) or an explicit re-import repair.

---

## 6. Verification Plan (when the adjustments are implemented)

- [ ] **Migration test:** add a Supabase migration test that asserts `INSERT INTO seasons (season_code) VALUES ('S25')` twice fails on the second insert.
- [ ] **Composite-PK test:** add a Supabase test that asserts `INSERT INTO season_flight_records (season_id, record_id) VALUES ('season-a', 'r1'), ('season-b', 'r1')` succeeds, and re-inserting `'season-a', 'r1'` fails. Same for `season_modifications` and the four child tables.
- [ ] **Filter test:** add a unit test that asserts `deleteModifications('season-a', ['r1'])` only deletes rows where `season_id = 'season-a'`. Same for `removeModification`. Same for `writeFlightRecordCounters` and `writeModificationChildren`.
- [ ] **Source-text test:** add a rule-regression test that asserts every `upsertRows` / `delete` / `in('record_id', ...)` / `in('leg_id', ...)` call in `supabaseStore.ts` is paired with `.eq('season_id', seasonId)`.
- [ ] **Atomic import test (Option A):** add a Rust integration test that runs the import flow with a forced local-mirror failure (after the remote write commits). Asserts the remote state is correct and the local mirror is stale. The "Re-sync local mirror" action should then succeed and bring the local in line.
- [ ] **Existing regression:** `npm run test:rules`, `npx tsc --noEmit --pretty false`, `npm run build`, `cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup`.
- [ ] **Context doc:** update `context.md` and `architecture.md` with the new ownership contract.

---

## 7. Risk and Rollback

- **5.2 fix is the only schema migration with a small breaking surface.** Adding `UNIQUE` requires a one-time pre-migration cleanup. After the cleanup, no further breaking changes.
- **5.3 fix is a larger breaking schema change.** Multiple tables and call sites are affected (see §5.3). The local-side changes are a no-op since the composite keys are already in place; the remote-side changes require coordinated rollout.
- **5.4 fix is a feature, not a migration.** Worst-case failure (with Option A) is a stale **local** mirror after the remote commit succeeds. The remote is always correct; the local side is at most one mirror behind. Recovery is the explicit "Re-sync local mirror" action, not an automatic catch-up. **F-4/F-6 (partial remote commit) are NOT fixed by 5.4 and require a separate remote-transaction fix; see Open Question 3.**
- **5.5 fix is already in the existing 2026-06-16 plan.**

---

## 8. Open Questions

1. Order: does the team want 5.2 (UNIQUE constraint) before 5.3 (composite PKs)? 5.2 is smaller and prevents the runtime-error failure mode; 5.3 is the larger ownership work.
2. Are there any external consumers (BI tools, exports) that filter or join on `record_id` / `leg_id` alone and would break with 5.3?
3. **F-4/F-6 (partial remote commit) are NOT fixed by this review.** The current code runs the remote writes as separate Supabase requests with no transaction wrapper. Should the team schedule a follow-up to wrap the remote import steps (`clearSourceRows` → `deleteModifications` → `updateSeason`/`createSeason` → `batchWriteFlightRecords`) in a single `BEGIN`/`COMMIT` block or Supabase RPC? This is the only way to make F-4/F-6 truly atomic on the remote side. **Defer this if Point L failures are the only ones observed in production; prioritize if Point R failures are seen.**
4. For the local-mirror question (5.4, Option A vs Option C), does the team prefer Option A (no new schema, explicit "Re-sync local mirror" action) or Option C (new remote `season_local_mirror_jobs` table + worker)? Option A is the cheapest; Option C is the strongest.
5. Should the parser's `guessSeasonYear` be retired entirely (since the active seasonal import no longer goes through `expandToFlightLegs`), or kept as a legacy adapter with a deprecation notice? F-7 only affects legacy callers, so retiring the helper is safe.

---

## 9. Suggested Phasing (if the user wants to proceed)

1. **Phase 1 (low risk, ~1 day):** F-3 fix only. Add `.eq('season_id', seasonId)` to `deleteModifications`, `removeModification`, `writeFlightRecordCounters`, `writeFlightRecordWindows`, `writeModificationChildren` and their read counterparts. Add a rule-regression test. No schema change.
2. **Phase 2 (medium risk, ~1-2 days):** 5.2 (UNIQUE) + 5.5 (already in the 2026-06-16 plan). Add UNIQUE constraint on `seasons.season_code` (with pre-migration cleanup), refresh `derivedSeasonal` in `applyLocalSourceRows`. Update `context.md` and `architecture.md`.
3. **Phase 3 (medium-high risk, ~3-5 days):** 5.3 (composite PK migration). Migration adds `season_id` column + backfill to four child tables, changes PKs on two parent tables, updates SQL RPCs in `schema.sql`, coordinated caller updates in `supabaseStore.ts` and Edge Functions.
4. **Phase 4 (medium risk, ~3-5 days):** 5.4 (Option A: local-mirror recovery UX). Add a "Re-sync local mirror" action that re-runs `importNativeSeasonSnapshot` against the latest remote state. Add a flag in the season state to detect Point L failures. **No code reorder needed** — the current code is already server-first. UX changes only; no new schema.
5. **Phase 5 (medium-high risk, ~1-2 weeks — separate from this review's options):** F-4/F-6 fix. Wrap the remote import steps in a single Supabase `BEGIN`/`COMMIT` block or RPC. Defer until Phase 4 has shipped and the team has data on how often Point R failures occur in production.

Each phase is independently shippable. Phases 1-3 can be done in a single branch; Phase 4 is its own branch because it changes the user-visible error semantics on partial failure; Phase 5 is its own branch because it touches the remote RPC surface.

**Note on phasing vs. the previous draft:** the previous draft recommended Option B (local-first with retry) for Phase 4. That recommendation was wrong for this codebase because `context.md:176` documents import as server-first and there is no outbox. Phase 4 in this revision implements Option A instead, which matches the existing contract.

---

**End of review.**
