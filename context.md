# Seasonal Schedule Management - Project Context

## Overview

A web-based aviation operations app for importing seasonal Excel schedules, reviewing aggregated flight patterns, editing individual operating legs, and exporting a system-recognizable Excel schedule.

**Stack:** Next.js, React, Tailwind CSS, Tauri native desktop, Rust, SQLite local store, Supabase relational backend/Edge Functions, Recharts for dashboard charts, SheetJS (`xlsx`) for Excel workbooks.

---

## Latest Native Context - 2026-05-30

This section supersedes older IndexedDB/Firestore-first wording that may still appear deeper in this file.

- Native/Tauri desktop is the operational runtime. Browser/static fallback is no longer allowed to drive local-first behavior.
- Rust + SQLite is the local source of truth for schedule data, mutations, pending sync, catch-up, integrity checks, and effective counts. TypeScript should behave as a viewport/IPC layer.
- SQLite uses shared continuous tables with `season_id` as the canonical season attribute. `iata_season_code`, filename, upload batch, and import session metadata must not group operational rows.
- User-facing season filters and loaders must query by exact `season_id`. Reporting/AI may use IATA season codes only when the user explicitly asks for cross-season/IATA-period analysis.
- Native catch-up uses delta event pages, WAL/busy-timeout behavior, writer locking, token refresh handling, passive checkpoints, and cursor advancement only after committed transactions.
- Routine catch-up and operator edits must not replace a full workspace snapshot. Full snapshot replacement is allowed only for explicit import, reset, or repair flows behind integrity checks.
- Native reads must return effective schedule data: active records after current modifications. Deleted modifications subtract from user-facing totals; added modifications add to totals; raw row counts are diagnostics only.
- S26 acceptance evidence after the 8M455 fix: raw active rows can be higher, but effective Total Flight is `25,824` with ARR `12,923` and DEP `12,901`.
- Native modification DTOs must always include `legId`, including sparse deletion payloads restored from `local_modifications.leg_id`.
- The main user action is `Save`, not `Sync`. Pressing Save first commits any Seasonal/Detailed draft to native SQLite, then uploads pending changes to Supabase.
- Seasonal/Detailed draft banners show draft count and `Discard`; there is no separate `Save & Publish` button.
- Detailed and Daily Schedule support route-wide unmodified `Delete` key for selected flights. The hotkey skips edit modals but must keep the existing confirmation/pair-delete prompt.
- Pair deletion semantics remain UI-driven: `Delete Entire Flight Pair` creates one combined modification/history batch and one pair-aware notification payload; `Delete Selected Leg Only` stays single-leg by design.
- Telegram message composition remains in the existing TypeScript/Supabase notification pipeline. Rust must preserve `scheduleNotification` payloads through native IPC/history/pending events and best-effort flush `schedule-telegram-notify` after successful native pending upload.
- Native pending sync must fail closed unless Supabase acknowledges every pending `opId` as either applied or conflicted. The local finalizer must not promote current rows to base, clear `local_pending_ops`, or mark `syncStatus = synced` from a partial/empty RPC acknowledgement.
- `sync_season_workspace_v2` duplicate-op handling must be idempotent at the row-mutation layer: if `(client_id, op_id)` already exists, the RPC still reapplies `apply_workspace_op_json`, refreshes field versions with the original `server_seq`, and returns an applied event acknowledgement for that `opId`.
- Production S26 server repair was applied with backup tables under `repair.repair_20260530_133455_*`. After repair, remote S26 matches the local SQLite truth used for staging: `25,855` raw records, `25,849` active records, `532` modifications, `144` active deletion mods, effective Total Flight `25,705`, and repair events `server_seq 4461..7768`.
- Close/reopen preserves durable SQLite season data, but discards unsynced local edits, route/session cache, and UI undo history when the native close policy requests session cleanup.
- Verification loop for routine native sync hardening changes: `npm run test:rules`, `npm run test:notifications`, `npm run test:updater`, `cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup`, `npx tsc --noEmit --pretty false`, and `npm run build`. `npm run native:build` is a release/integration gate, not part of normal implementation passes unless explicitly requested.

## Native Sync Hardening - 2026-06-16

These invariants supersede older review-before-sync and Gate sync-status wording:

- Native conflict cleanup must structurally parse pending `modHistory` payloads. Do not use substring matching such as `payload_json LIKE "%leg-1%"` to decide whether to delete history. A pending history entry may be removed only when its resolved target set is non-empty and every parsed target belongs to the target being resolved; mixed/cross-target history must be preserved.
- `query_sync_summary` exposes `localRecordCount` and `entityVersionCount` in addition to pending/conflict/cursor fields. `SeasonSyncProvider` uses these counts to detect a truly fresh local workspace. If local records, entity versions, pending ops, and conflicts are all zero, catch-up starts from cursor `0` even when `lastServerSeq` appears seeded.
- JS delta mutation must keep read, compute, and pending-state write in one queued SQL transaction. `applyLocalModificationBatchDelta` uses `replaceLocalSeasonSqlPendingStateFromDelta`, which reads affected delta state and writes pending ops/sync meta in the same `sqlWriteQueueTail` slot and `BEGIN IMMEDIATE` transaction. Do not reintroduce a separate `readLocalSeasonSqlDeltaState` followed by `replaceLocalSeasonSqlPendingState` for hot-path Check-in/Gate commits.
- `SeasonAutoSyncState` carries `localRevision`. Provider summary patches and workspace-change flushes must copy native `localRevision` so route UIs can tell when SQLite has advanced.
- Gate sync status has one source: `useSeasonSync` seeded by `seedSeasonSyncFromNative`. Gate must not keep a parallel local `syncSummary`, local debounce timer, or `scheduleGateSyncSummaryUpdate` path for the badge.
- Gate optimistic allocation view is cleared when the provider `localRevision` advances past the optimistic base revision, or when the user changes the season/range/reset base. It should not reset merely because `allocationResult.view` re-derived during a fast local commit.
- The earlier derived-cache task is not implementation work for this pass. Native mutation paths already dirty/clear `local_derived_seasonal`; do not add a broad TS derived-cache rewrite unless a focused regression proves a live stale-cache bug.

---

## Codebase Refresh - 2026-05-28

This pass used GitNexus plus direct live-file inspection. GitNexus is installed for this repo, but the current index is stale for native code: it was indexed on 2026-05-21, has missing FTS indexes, and `npx -y gitnexus@latest analyze` currently fails with `Cannot destructure property 'package' of 'node.target' as it is null.` When using GitNexus before reindexing, filter out `_backups` and `_codex_backups`; the indexed graph contains far more backup files than live app files and does not include the newer `native*` modules.

- `architecture.md` is now the compact architecture map. Keep `context.md` for operating rules, invariants, and recent project-specific decisions.
- Native runtime entry points are registered in `app/src-tauri/src/lib.rs`; the main Rust persistence/sync implementation is `app/src-tauri/src/native_catchup.rs`.
- TypeScript native calls are concentrated in `app/src/lib/nativeSeasonRepository.ts`, which re-exports `nativeSeasonCatchup.ts` and `nativeLocalSeasonStore.ts`.
- The active local database is `sqlite:seasonal-management-local.db`, preloaded by Tauri SQL and mirrored by Rust `rusqlite` command handlers. Current/base rows, pending ops, sync metadata, and entity versions all stay in shared season-scoped tables.
- Current Supabase migrations after the first sync review include reliable sync cursor handling, catch-up event pages, exact `season_id` enforcement, public dashboard AI row/aggregate query RPCs, DeepSeek provider support, schedule Telegram delivery, and AI context documents.
- Dashboard AI custom Rules/Skills are stored in `operational_ai_context_documents`, edited in Settings, capped at 20 markdown documents and 64KB per document, and injected as prompt context by `dashboard-ai-analysis`.
- Dashboard AI can use either Supabase reporting RPCs or local native SQLite SQL plans. Local SQL is constrained to read-only `SELECT`/CTE queries over the temporary `dashboard_ai_flight_operations` view.
- Do not treat `season_code`, upload filename, or import batch as selected-season ownership for operational data. Exact `season_id` is the normal user-facing boundary.

---

## Dashboard AI Query-Only Context - 2026-06-01

This section supersedes older AI Notebook wording that described AI as coupled to the Dashboard MoM/WoW panel.

- AI Workspace is a rich chat surface, not a board tied to the MoM/WoW analysis panel. The normal dashboard still has Overview and MoM/WoW tabs, but AI Workspace does not receive `comparison`, `waterfallRows`, selected driver rows, `comparisonMode`, or `comparison-drivers` fallback blocks.
- The AI analysis source of truth in desktop/local mode is SQLite via the Tauri command `query_native_dashboard_ai_sql`. SQL remains validated read-only: one `SELECT` or `WITH ... SELECT`, allowlisted tables/views/columns, bounded by `LIMIT`, no DML/DDL/PRAGMA/ATTACH/transactions/extensions/filesystem/script execution.
- The local AI SQL view is `dashboard_ai_flight_operations`. It exposes analysis columns such as season, `ops_date`, month, ISO week, weekday, local hour, ARR/DEP type, flight, airline, route, country, aircraft, PAX, gate, stand, and status.
- Query planning is workflow/semantic driven. Current deterministic workflows include `peak-day-anomaly`, `day-vs-baseline-drivers`, `month-comparison-drivers`, `route-pax-ranking`, `flight-detail-investigation`, and `season-to-season-frequency`.
- Vietnamese intent mapping is explicit: examples include “ngày cao điểm” -> group by `ops_date`, “điểm bất thường/driver” -> compare selected day against the rest-of-period baseline, “top route PAX” -> group by route and order by `pax`, and “chuyến bay ngày...” -> detail query.
- A single prompt can create multiple query plans: primary aggregate, baseline, drilldown, driver decomposition, and validation query. For “tìm ngày cao điểm tháng 6 và điểm bất thường”, the expected result is daily distribution plus peak-day drilldown and baseline driver blocks, not a follow-up request for data.
- Query results are profiled before rendering: row count, coverage, null/distinct counts, min/max/mean/median where applicable, top contributors, share/delta, and outlier candidates.
- Answer verification runs before display. If numbers in the narrative do not match query results/profile, the app shows a Vietnamese warning or uses deterministic corrected narrative/blocks.
- Rich chat renders query-backed `custom-table`, chart, KPI, insight, data-quality, markdown, and sandboxed static `html-preview` blocks. Provider `boardPatch` blocks are ignored for query intents unless they reference a matching `sourceQueryId`.
- Routine successful tool traces are hidden by default. Warnings, rejected tools, data-quality issues, provider retries, unsafe render rejection, and unsynced-local-source notes stay visible.
- Session memory keeps bounded active context: recent cells, active artifact, capped query rows, result profiles, and pinned context. Follow-up prompts like “phân tích driver”, “ngày đó”, “bảng trên”, or “vẽ thêm chart” must resolve from the active artifact before any dashboard-default fallback.
- Supabase reporting RPCs remain for remote-safe mode and Edge Function compatibility, but local SQLite is authoritative whenever desktop data is loaded or has pending changes.

---

## Current Architecture

```text
Excel workbook
  -> parser.ts                  parses source rows
  -> sourceRows                 read-only import backup/reference
  -> atomicSchedule.ts          flattens source rows into canonical FlightRecord documents
  -> flightRecords              editable/exportable truth
  -> Rust/Tauri SQLite commands  local source of truth, row-level mutations, pending ops, catch-up
  -> nativeSeasonRepository.ts   TypeScript IPC facade for viewport reads and native intents
  -> page.tsx                   aggregated Seasonal Schedule
  -> detailed/page.tsx          ID-based Detailed Schedule calendar
  -> dashboard/page.tsx         dashboard overview, MoM/WoW analysis, and AI notebook
  -> exporter.ts                reconstructs Excel pattern rows
```

The important architectural shift is that `sourceRows` are no longer the main truth for editing/export. They remain as imported evidence and compatibility backup. `flightRecords` are the canonical operating records, persisted locally in SQLite and grouped by exact `season_id`.

---

## Import Layer

### `lib/parser.ts`

- `parseSeasonalSchedule(workbook)` reads the first worksheet into `ParsedRow[]`.
- `enrichRows(rows)` adds display-only cleaned flight numbers for the legacy source-row UI.
- `expandToFlightLegs(rows)` remains as a legacy adapter/fallback.
- Flight suffix letters are preserved as part of the flight number.

### `lib/atomicSchedule.ts`

- `mergeDuplicateImportPeriods(rows)` collapses identical duplicate imports and trims later overlapping simple ARR/DEP rows to their non-overlap dates before atomic expansion. Overlap precedence is by source order for every row field, not just aircraft: route, schedule, type, category, code shares, and int/dom values all stay with the earlier row during the overlap. Example: VJ055 `321` from 13-Jul to 28-Sep plus VJ055 `330` from 13-Jul to 05-Oct becomes `321` through 28-Sep and `330` on 05-Oct only.
- `flattenRowsToFlightRecords(rows)` expands seasonal patterns into one `FlightRecord` per real flight occurrence.
- `mergeDuplicateImportRecords(records)` is an import/hydration safety pass that keeps the first atomic occurrence for each flight number/date, reports duplicate periods, and prevents source fallback from restoring duplicates.
- Each atomic ID includes source row, side, date, flight, route, schedule, and aircraft to avoid repeated-flight collisions.
- ARR/DEP imported from the same source row get a shared `turnaroundId`, `linkId`, `linkType`, `pairAnchorDate`, and `linkedRecordId`.
- Manually linked separate ARR/DEP source rows are also flattened into explicit linked records.
- Separate ARR-only and DEP-only rows are not auto-linked on import.

---

## Supabase / Native SQLite Storage

```text
seasons / local_seasons
  seasonCode, name, fileName, uploadedAt
  effectiveStart, effectiveEnd, totalLegs, totalSourceRows
  dataVersion, lastSyncedAt
season_source_rows / local_source_rows
  ParsedRow backup/reference, keyed by season_id + row_index
season_flight_records / local_flight_records
  canonical FlightRecord rows, keyed by season_id + record_id
season_modifications / local_modifications
  FlightModification overlays, keyed by season_id + leg_id
season_mod_history_entries / local_mod_history_entries
  undo/history batches and scheduleNotification payloads
local_pending_ops / season_change_events
  native local outbox and remote delta event log
local_sync_meta
  cursor, pending count, conflict state, local revision, client metadata
local_entity_versions / season_entity_versions
  per-season remote field clocks for conflict detection
schedule_notification_deliveries
  queued Telegram delivery rows generated from scheduleNotification history
operational_ai_context_documents
  settings-managed Dashboard AI markdown Rules/Skills
```

Key functions:

| Function | Purpose |
|---|---|
| `query_schedule_window` / `query_allocation_window` / `query_source_rows_window` | Native viewport reads over bounded windows |
| `apply_schedule_mutation` / `apply_allocation_mutation` | Native row-level local mutations and pending-op generation |
| `run_season_catchup` | Native server delta catch-up from Supabase event pages |
| `sync_pending_changes` | Native pending upload to Supabase plus best-effort Telegram flush |
| `query_sync_summary` | Lightweight pending/conflict/cursor/localRevision/freshness summary for sync UI and catch-up cursor selection |
| `resolve_season_conflict` | Native conflict resolution using structural pending-op cleanup |
| `check_season_integrity` | Native startup/fetch/sync guard for local SQLite health |
| `query_dashboard_summary` / `query_native_dashboard_ai_sql` | Native dashboard summaries and read-only local AI SQL |

Supabase relational tables and local SQLite tables are unified datasets with `season_id` as a row attribute. Do not create per-season local databases or per-season physical tables.

Import UI progress uses `importProgress.ts`. The Seasonal Schedule import flow shows stage text, percentage, and batch write counts while parsing, calculating, replacing/creating the season, saving source rows, saving atomic records, and refreshing the schedule.

Client navigation uses `seasonDataCache.ts` as an in-memory viewport/cache helper only. Durable local data lives in SQLite. Old IndexedDB/local workspace modules remain compatibility/reference code, but operational desktop routes must not use them for routine load/save/mutation.

Standard user operations are local-first through native SQLite. Pages dispatch atomic intents or bounded viewport queries through `nativeSeasonRepository.ts`; Supabase is updated only when the user presses `Save`. Save commits drafts first, then uploads native pending ops. Local pending work and conflict state are preserved on failure/conflict.

Pending operations are derived from the difference between the current local workspace and the saved server baseline snapshot. They are not an append-only action log. If a user reverses an edit/link/unlink back to the baseline state, the pending operation and Unsynced count must disappear.

Undo history can contain both modification changes and `FlightRecord` changes. This is required because edit/delete uses modification overlays, while link/unlink changes canonical atomic records.

Import/re-import remains server-first because it establishes a new baseline. A successful import writes `sourceRows` and `flightRecords`, increments `dataVersion`, clears the local workspace for that season, and then saves a clean local baseline.

- `seasons.season_code` is the unique business key for import lookup; `seasons.id` remains the generated primary key and the user-facing operational boundary.
- No-schema season hardening scopes destructive remote modification deletes to `season_id` where the table already carries `season_id`. Counters/windows remain global-keyed until the composite-PK migration adds `season_id` to those child tables.
- Remote composite keys `(season_id, record_id)` and `(season_id, leg_id)` are the target schema for flight records, modifications, and their child tables, but that migration must be shipped separately from the no-schema safety pass.

---

## UI Rules

### Seasonal Schedule

- Aggregates `flightRecords` into independent ARR or DEP summary rows.
- A row represents one flight number and one side only; same-day and overnight partners are shown as relationship badges, not as a unified row.
- Validity display is aggregated from derived phases.
- Phase count is shown through existing badges.
- Row Link badges show matching unlinked opposite-side flight legs inside Seasonal Schedule and link every valid matched occurrence for the selected pair.
- Row Unlink badges clear explicit links for the full aggregated Seasonal row and its counterparts.
- Seasonal Schedule has the same local Undo history model as Detailed Schedule. Delete actions undo modification overlays; link/unlink actions undo `FlightRecord` relationship fields.
- Row checkboxes select atomic records for selective export.
- If a selected record is linked, export automatically includes the paired record.
- The Seasonal row aggregator is display-only. It can be rebuilt or discarded at any time and must not be used as export or persistence truth.

### Check-in Allocation

- Check-in Allocation is a departure-only Gantt route over canonical `flightRecords` plus local modification overlays.
- The Gantt time range controls only the visible x-axis. It does not mutate records by itself.
- Default allocation windows are derived from STD: `STD - 3 hours` to `STD - 50 minutes`.
- Counter demand is initialized from the operational Counter Rule engine. If no rule matches, the route uses one counter.
- Counter assignments persist through the existing `counter` field. Grouped contiguous and broken non-contiguous allocations use array payloads such as `[1, 2, 3]` or `[1, 2, 5]`.
- Check-in allocation time overrides use `checkInStart` and `checkInEnd`; resizing bars must not alter STD. Broken allocations may also persist per-counter windows in `checkInCounterWindows`.
- Grouped allocations are logical groups, but the UI must render one discrete row-confined bar per assigned counter. It must never render a merged multi-row rectangle.
- Every visible allocation bar repeats the flight identifier. Normal-width bars show left-edge start time and right-edge end time; medium-width bars keep those times visible with smaller compact text; extremely narrow bars keep the flight identifier and expose times in a tooltip.
- Flight bars use deterministic carrier-based colors so the same carrier is visually consistent and different carriers are easier to distinguish.
- The Unallocated Pool uses timeline masonry packing: flights float along the x-axis by time and only stack into another lane when their check-in windows overlap.
- The timeline header and Unallocated Pool are frozen above the Resource Grid while resource counter rows scroll vertically. The pool can be resized with its splitter or collapsed to return space to the Resource Grid.
- The Gantt toolbar has Zoom Out and Zoom In controls beside fullscreen. Zoom is UI-only and changes the timeline pixels-per-minute scale used for x-axis width, bars, drag deltas, resize deltas, and snap-line labels; it must not mutate flight records or pending Save state.
- Drag and resize interactions support edge auto-scroll, highlighted drop rows, animated bar movement, and a snapped vertical guideline during resize. Allocated Check-in bar drag/drop is vertical-only and must pass `minuteDelta: 0`; it can change counter assignment but must not change the current time window. Horizontal time edits are allowed only through resize handles or Override Times. Resize handles and their crosshair snap to every minute so exact open/close times can be set visually.
- The Gantt chart has a local fullscreen toggle that calls the browser Fullscreen API on the Gantt wrapper only. Global navigation/header UI stays outside that fullscreen element, while the timeline header, Unallocated Pool, Resource Grid, context menu, and override-times modal remain inside it.
- Break Shape changes the interaction mode to independent counter blocks by seeding each counter from the current shared flight time window. After a shape is broken, resize handles and Override Times apply only to the clicked counter block, allowing counters for the same flight to have different windows. Dragging one broken block back to the Unallocated Pool removes only that counter from the payload; dragging the final block back clears the allocation.
- Broken Check-in bars use a minimal live-only cue: a dashed white border in the Gantt. Normal grouped bars keep the solid white border, and Check-in PDF export bars remain solid regardless of broken/grouped state.
- Reshape changes a broken allocation back to grouped mode by compacting it into contiguous counters while preserving the current check-in start and end window.
- Right-click Unallocate commits immediately without an extra confirmation dialog.
- The Gantt toolbar has an Unallocate All action for the selected From/To period. It batch-clears all visible grouped allocations, and for broken allocations it removes only the individual counter blocks whose own check-in windows overlap the visible period.
- Counter overlaps are allowed in Check-in Allocation. When multiple bars overlap on the same counter row, the row expands and stacks the overlapping bars into visible lanes instead of rejecting the allocation.
- Global `OperationalSettings` owns check-in counter inventory, counter groups, BHS mappings, and time-bound counter locks.
- Check-in Allocation can use configured counter resources instead of fallback rows and can reorder the Resource Grid by counter group through the `Group by island` toggle.
- Allocating counters mapped to a counter group writes the group's BHS value to the departure modification locally; broken allocations spanning groups write a unique comma-separated BHS list.
- Active counter locks block new allocation edits that overlap the lock window, but existing allocations remain visible and are marked as lock conflicts until users manually resolve them.
- All allocation edits are local-first through native SQLite row-level modification commits and wait for manual Save before Supabase upload. The Check-in Gantt applies the already-validated modification to an immediate in-memory overlay, patches only the affected flight projection in the displayed Gantt view, then persists only affected rows/pending ops/sync meta through the native command path.
- Check-in hot-path drag/resize work must avoid full workspace hydration or full allocation rebuilds. Drag-over previews and resize snap lines are `requestAnimationFrame`-throttled with no-op state guards. Allocated drag-over uses vertical-only edge scrolling so horizontal pointer movement cannot shift the timeline while a bar is being reassigned. The Check-in route registers a save guard during allocated drag or resize and waits for the current local mutation before manual Save can run.
- Check-in local commits are accumulated briefly and written through native delta mutation commands so repeated rapid allocation actions do not hydrate and rewrite the full workspace. Pending-count refreshes should read native sync summary metadata, not full schedule snapshots. JS read-modify-write delta commits must stay inside `replaceLocalSeasonSqlPendingStateFromDelta` so the read and pending-state write share the same queued SQL transaction.
- Check-in workspace refresh uses `useSeasonWorkspaceRefresh({ policy: 'on-activation', source: 'checkin' })`. While the route is active it ignores its own `checkin`, `checkin-worker`, and `checkin-sync` change events; other stale workspace events are debounced and applied inside React transition, and inactive route refreshes wait until route activation.

### Gate Allocation

- Gate Allocation is a Gantt route over canonical `flightRecords` plus local modification overlays. Its visible time range and timeline zoom are UI-only and must not mutate records or pending Save state.
- Gate assignments persist through the gate allocation modification fields. Dragging from the unallocated pool can assign a gate, dragging an allocated bar to another gate row can reassign it, and dragging an allocated bar back to the pool clears only the gate assignment.
- Allocated Gate bar drag/drop is resource-only. The drag overlay locks its x-position for allocated bars while row hit testing still uses the live pointer position; the commit path calls `allocateGate(record, resource.gate)` or `unallocateGate(record)` and must not write gate start/end or minute-delta time changes.
- Gate bars use deterministic carrier-based colors, timeline masonry packing for the unallocated pool, session-restored Gantt scroll, UI-only zoom, and local fullscreen behavior matching Check-in.
- Gate edits are local-first through native SQLite row-level modification commits and wait for manual Save before Supabase upload. The Gate Gantt applies the modification to an immediate in-memory overlay, patches the affected flight projection in the displayed Gantt view, then persists only affected rows/pending ops/sync meta through the native command path. The optimistic overlay is tied to `SeasonAutoSyncState.localRevision` and should clear only after native summary state advances beyond the optimistic base revision, or after an explicit season/range/reset base change.
- Gate workspace refresh uses `useSeasonWorkspaceRefresh({ policy: 'on-activation', source: 'gate' })`, ignores its own `gate`, `gate-worker`, and `gate-sync` change events while active, debounces stale events, and applies external workspace refreshes inside React transition. The Gate route registers a save guard while a pointer drag is active and waits for the current local mutation before manual Save can run.
- Gate sync badge/state must come from `useSeasonSync(syncSeasonId, 'gate')`, seeded through `seedSeasonSyncFromNative`. Do not restore route-local `syncSummary`, `pendingGateSyncSummaryRef`, `gateSyncSummaryTimerRef`, or `scheduleGateSyncSummaryUpdate`.

### Gantt Anti-Lag Mechanics

- Check-in and Gate must keep visual response separate from durable persistence: apply the optimistic displayed projection immediately, then let native SQLite persistence, sync summary updates, audit logging, and bounded viewport refresh run outside the pointer/drag hot path.
- Do not put full allocation rebuilds, full workspace hydration, Supabase writes, or Save execution inside drag-over, pointer-move, resize-move, snap-line, or drop-preview handlers.
- Same-route workspace change sources are source-family filtered. Active Check-in ignores `checkin-*` changes, and active Gate ignores `gate-*` changes, so each Gantt does not immediately reload its own just-committed workspace and stutter after rapid actions.
- Manual Save must respect the Gantt save guards: Check-in blocks while an allocated drag or resize is active; Gate blocks while a pointer drag is active. Both routes must await the current local mutation before Save starts.
- The sync badge should use the lightweight native summary path after local edits. Reintroducing full workspace reads or route-local summary timers in the pending-count path can restore the post-action freeze or the old Gate `Synced` flash.

### Daily Schedule

- Daily Schedule is a date/time-range operational grid over canonical `flightRecords` plus local modification overlays.
- The `From` and `To` datetime inputs default the time portion to `05:00` only as a user convenience. The filter uses each record's actual `date + STA/STD`; early-morning flights are not reassigned to the previous operational day unless the selected range includes them.
- The toolbar summary shows `ARR`, `DEP`, and `TOTAL` counts for records included by the selected datetime range and current grid filters.
- Linked ARR/DEP records are consolidated into one visible row only as a display projection. `FlightRecord` remains the editable/exportable truth.
- Supported cells are edited directly in the grid. Edits and row operations write native SQLite first, update local React/cache state, and wait for the manual Save button before Supabase upload.
- Daily Schedule supports Add, Edit, Delete, Link, and Unlink in the tab through the same local-first workspace and undo/history model used by Detailed Schedule.
- Daily Schedule supports OperationalTurns Excel import from the tab. The import partitions rows by inferred IATA season from operational date, creates/ensures missing seasons locally, writes records through native schedule mutations, and waits for manual Save before Supabase upload.
- Daily Schedule selected rows can be deleted by the route-wide unmodified `Delete` key. The shortcut must reuse the existing Delete Selected Flights confirmation and native mutation path.
- `ARR-MCT` displays as `MCAT` beside `STA`; `DEP-MCT` displays as `MCDT` beside `STD`. Imported `ARR-BagFirst` and `ARR-BagLast` are stored as `fb` and `lb` on the arrival record.
- Daily Schedule must not use a turnaround details side panel, native browser dialogs, direct backend writes during normal edits, `window.location.reload()`, or full-season refetches after local mutations.

### Dashboard

- Dashboard has three views: `Tong quan`, `Phan tich MoM/WoW`, and `AI Workspace`.
- The dashboard data seam is `flightRecords + modifications -> buildEffectiveDashboardRecords() -> buildDashboardOverview()` / `buildDashboardComparison()`.
- Dashboard views are read-only against operational records. Analysis, AI, exports, and visual blocks must not mutate flight records, modifications, sync state, or database schema.
- The overview view focuses on season/month management and operational summaries. The MoM/WoW view owns fixed comparison controls, waterfall/driver analysis, and detailed drilldown links.
- Dashboard AI context is built from active comparison filters, compact season catalog, selected driver rows, waterfall rows, and optional multi-season summaries. Deleted records are excluded.
- Normal Dashboard UI remains local/cache/server first and computes summaries from `effectiveRecords`. AI Workspace is query-first for ad-hoc analysis and uses Supabase reporting views as the source of truth unless it explicitly falls back to local unsynced data.
- If AI needs data outside the current active comparison, the preferred path is `query_dashboard_data`, resolved read-only inside the Supabase Edge Function against `reporting.flight_operations` or `reporting.summary_*`. The legacy `dashboard-data-request` / `request_dashboard_data_slice` path is compatibility fallback for local-only slices.
- Dashboard report exports are local Excel generation only. Fixed templates are `mom-wow-analysis` and `sanluong-summary`; custom workbook suggestions are sanitized before download.

### Dashboard AI Notebook Canvas

- `AI Workspace` is now a full-width notebook canvas, not a split chat panel plus side board.
- User-facing AI presets, fallback narratives, assistant text, block titles, table headers, insights, data-quality notes, loading/status text, and tool trace reasons default to Vietnamese. Internal ids such as tool names, template ids, ARR/DEP, MoM/WoW, KPI, airline codes, and route codes stay stable.
- Each prompt creates a `DashboardAiNotebookCell` with the original prompt, assistant text, rendered blocks, tool trace summary, optional export action, timestamp, model id, and a bounded Skawld-inspired `runEvents` ledger.
- Notebook persistence is localStorage-only and keyed by selected season set with `dashboard:aiNotebook:*`.
- The old board persistence key `dashboard:aiWorkspaceBoard:*` must not be restored or rendered by the notebook UI.
- Notebook memory lite summarizes the latest 1-3 cells by prompt, assistant summary, block titles/types, filters, season set, and tool traces. It does not persist rendered table rows or raw dashboard records in the memory summary.
- The run ledger uses `DashboardAiRunEvent` entries for init/user/tool/result/error style events. `buildDashboardAiSessionLedger()` and `compactDashboardAiSessionLedger()` keep full local state while exposing only a compact provider view.
- AI transport can still return `boardPatch`; the frontend converts `response.boardPatch.blocks` into inline notebook cell blocks.
- If the provider returns only text or a `visualReport`, the frontend uses deterministic fallback board patches so visual/table/chart prompts still render inline blocks.
- Query-intent prompts such as date ranges, specific months/weeks, route, airline, PAX, peak hour, cross-season, or `mùa liên tiếp` must route to `query_dashboard_data`.
- `query_dashboard_data` accepts allowlisted filters: `seasonIds`, `iataSeasonCodes`, `dateFrom`, `dateTo`, `months`, `weeks`, `typeFilter`, `airlines`, `routes`, `countries`, `aircraft`, `localHourFrom`, and `localHourTo`.
- Query intent also covers country/quoc gia, aircraft/may bay, ARR/DEP mix, comparison, totals, and ranking/superlative prompts. Client and Edge share the same pure intent/query helper through `dashboardAiShared`.
- Date-range inference supports ISO dates, `dd/mm/yyyy`, and Vietnamese prompts like `từ ngày ... đến ngày ... tháng ...`. When a date range is explicit, AI must not answer with whole-season totals.
- Consecutive-season prompts use the selected AI season set, capped at 3 seasons. `season_id` filters take precedence when the selected season ids are known; IATA season codes are used when the user asks by code such as `S25` / `S26`.
- The Edge Function resolves query rows before or during provider analysis, then returns `queryResults`. Notebook rendering prefers `queryResults` for query-intent prompts. Provider `boardPatch` is ignored when it looks stale and its blocks do not carry a matching `sourceQueryId`.
- Aggregated `query_dashboard_data` requests with `groupBy` are resolved through `public.dashboard_ai_query_aggregated`, a Data API exposed `security invoker` wrapper that delegates to `reporting.query_aggregated`. The private reporting RPC still aggregates in Postgres from `reporting.flight_operations`, avoiding the old 500-row Edge-side aggregation cap; detail queries without `groupBy` still use bounded row reads.
- Query results materialize as `custom-table` and chart blocks with `sourceQueryId`, so the user sees the exact queried range/season set rather than context-wide fallback blocks.
- Fallback board patches are context-aware: month comparison/difference prompts create `comparison-drivers` tables and waterfall charts for the inferred periods instead of generic season summary blocks.
- Board and notebook blocks reuse the safe `DashboardAiWorkspaceBlock` renderer contract: `kpi`, `table`, `chart`, `insight-list`, `data-quality-notes`, `rich-markdown`, and `html-preview`.
- `rich-markdown` renders inline Markdown-style headings, lists, code blocks, and markdown tables inside the notebook cell.
- `html-preview` is the only HTML path. HTML is sanitized, wrapped in `srcDoc`, and rendered inside an iframe sandbox with a restrictive CSP. It must not run in the React DOM.
- HTML preview sanitization removes scripts, inline event handlers, forms, nested iframes, object/embed, meta refresh, javascript URLs, external scripts/resources, and unsafe control characters. Sanitized/rejected previews show a visible note.
- Chart blocks are whitelisted to `bar-ranking`, `line-trend`, `waterfall`, `heatmap`, `kpi-strip`, `stacked-bar`, `area`, and `pie`, rendered through the safe notebook chart renderer.
- Table blocks are whitelisted to `season-summary`, `comparison-drivers`, `monthly-trend`, `airline-ranking`, `route-country-ranking`, `peak-hour`, `multi-season-summary`, and `custom-table`.
- Notebook cell actions can duplicate the prompt, delete the cell, move/delete blocks inside a cell, and export table blocks to Excel.
- Excel export is available for table blocks and sanitized AI export actions only. PDF/image export is not part of V1.
- No AI output may execute JavaScript, SQL, formulas, file paths, write actions, external BI runtime code, or raw HTML in the app DOM. HTML is allowed only as sanitized sandbox preview content.
- Presets such as `Tạo báo cáo trực quan`, `Vẽ biểu đồ peak hour`, `Tạo bảng tác nhân`, and `So sánh mùa đã chọn` must route to `compose_dashboard_ai_board` and materialize blocks inline.
- Multi-season AI selection is capped at 3 seasons. Normal local summaries should use native/local SQLite or bounded cached season data before server fallback; modifications are applied through `buildEffectiveDashboardRecords()`. Desktop query-first AI analysis now prioritizes local SQLite through the Python Agent and labels any web/Supabase fallback explicitly.

### Dashboard AI Agent Boundary

- Dashboard AI is a read-only, dashboard-only agent workflow owned by `dashboard-report-analysis`.
- Desktop provider calls go through the local Python Agent sidecar. Gemini, Qwen/OpenAI-compatible, and DeepSeek keys are synced from Supabase DB/RLS into local execution and the provider call happens directly from the machine. Frontend payloads must not include service-role keys; provider key material is fetched only for the local agent request and cleared from UI state after sync/use.
- For desktop runtime, React no longer fetches the raw provider key. `call_dashboard_ai_agent` receives Supabase URL, anon key, and the current operator access token, then Rust calls `fetch_ai_provider_key`, injects `model.providerKey` only into the localhost Python request, and never returns the key to the UI.
- The bundled sidecar is managed Skawld-style as a local runtime process: Rust starts it on first health/analyze call, drains sidecar output, stores the child handle, and retries health until it is ready.
- The Supabase Edge Function `dashboard-ai-analysis` remains a legacy/web fallback model gateway. It still keeps provider secrets server-side for web fallback, but desktop AI should try `analyzeDashboardWithLocalAgent()` first.
- The current legacy Edge runtime request carries `maxRounds: 4`. The Edge Function clamps execution to 1-6 rounds, can infer/query data, call the provider, execute provider-requested read-only query tools, and produce structured notebook output without asking the user to approve read-only dashboard queries.
- Provider key sync uses `operational_ai_provider_keys` guarded by `app_operators.can_manage_ai` for writes and `app_operators.can_use_ai`/`can_manage_ai` for reads. Settings labels this as “Save & Sync Local Provider Key”; `rotate-dashboard-ai-key` is deprecated for desktop Dashboard AI.
- The Python Agent sidecar lives under `app/ai-agent`, exposes `/health` and `/v1/analyze`, calls providers directly, validates read-only SQL, mirrors the `dashboard_ai_flight_operations` projection, and returns the existing `DashboardAiAnalysisResponse` shape.
- Runtime gates are AI configured, operator authorization, selected season, local records, max 3 selected seasons, export eligibility, context-size cap, and allowed tool list.
- Hermes-inspired toolset gating annotates each tool with `toolset`, `requires`, `availability`, and optional `disabledReason`; only currently enabled tools are sent as allowed tools.
- Skawld-inspired permission/scheduler helpers live in `dashboardAiAnalysis.ts`: `evaluateDashboardAiToolPermission()` gates tools by `allowedTools`, read-only status, and confirmation needs; `scheduleDashboardAiRun()` batches parallel-safe read-only calls and records rejected calls with Vietnamese reasons.
- Allowed tools are:
  - `query_dashboard_data`
  - `request_dashboard_data_slice`
  - `suggest_template_report`
  - `suggest_custom_workbook`
  - `suggest_visual_report`
  - `compose_dashboard_ai_board`
- `query_dashboard_data` is read-only and resolves only allowlisted reporting views. It never accepts raw SQL from the model.
- Gemini-compatible models can use native `function_declarations` for `query_dashboard_data` and `compose_dashboard_ai_board`. OpenAI-compatible/Qwen-style providers keep the text JSON fallback path.
- Remote reporting views expose `season_id`, `season`, `season_code`, `iata_season_code`, operational date fields, month/week/hour fields, and operational dimensions. Reporting views are configured with `security_invoker = true` and `authenticated` grants.
- `public.dashboard_ai_query_aggregated` and its delegate `reporting.query_aggregated` are separate database migrations and must be applied before relying on live aggregate correctness for large date ranges or full-season group queries.
- Dashboard report skills are configuration-only procedural guides, not an imported Hermes runtime. Current skills are `month-comparison-drivers`, `peak-hour-analysis`, `route-country-report`, `airline-mix-report`, and `season-overview-report`.
- Prompt assembly is layered into stable contract (`LANGUAGE_POLICY`, safety, tools, skills, output whitelist) and ephemeral context (user prompt, selected skill, context profile, notebook context, dashboard context, optional `resolvedDataRequest`).
- The frontend can retry one transient provider failure (`408/429/500/502/503/504/timeout`) and annotates the trace with `providerAttempt`; malformed schema, auth, safety, and configuration errors are not retried.
- The Edge Function accepts structured `allowedTools`, `availableTools`, `selectedSkillId`, `contextProfile`, `notebookContext`, `language`, `providerFallback`, `allowedReportTemplates`, `allowedVisualReports`, and `maxRounds` fields.
- Tool routing and prompt fixtures cover English and Vietnamese requests, including unaccented/normalized variants such as `tao bang trang`, `ve bieu do peak hour`, `lap report dang bang`, and month-over-month difference-table prompts.
- `data-visualization-skills` is used as a workflow/design reference only. It is not imported as a runtime dependency.
- `hermes-agent` is used as an architectural reference for toolsets, skills, prompt assembly, and session memory. It is not imported as a Python runtime or Tauri sidecar in V1.
- `skawld-sdk` is used as an architectural reference for event streams, session stores, permissions, schedulers, compaction, and skills. Production `app/src` must not import `@skawld/agent-sdk` directly; the dev-only compatibility spike is `npm run check:skawld`.

### Detailed Schedule

- Detailed Schedule is an ID-based micro-edit surface.
- The edit modal can edit schedule/aircraft/codeshares and delete selected IDs.
- Manual Link and Unlink actions operate on selected `FlightRecord.id` values.
- Manual Link and Unlink actions write record-level history entries so Undo can restore the previous relationship state.
- Link/unlink changes only the selected phase/occurrences plus their explicit counterparts.
- Same-day and overnight companions use the same calendar companion UI; overnight shows `+1` for DEP linked flights and `-1` for ARR linked flights, same-day has no suffix.
- Mutating actions update native SQLite plus local React/cache state. They should not write Supabase directly, call `window.location.reload()`, or refetch the full season during normal editing.
- Detailed selected flights can be deleted by the route-wide unmodified `Delete` key. The shortcut skips the edit modal, reuses the linked-pair choice prompt when needed, and then opens the existing Confirm Changes modal.
- Detailed draft changes are committed automatically when the user presses Save. The old `Save & Publish` draft button must not be restored.
- User-facing notices and confirmations must use the shared custom app dialog UI. Do not use native browser `alert()` or `confirm()` in app screens.

---

## Business Rules

### Rule 1 - Atomic Truth

- `FlightRecord` is the editable/exportable truth.
- `sourceRows` are import backup/reference.
- Modifications overlay atomic IDs.
- SQLite is the durable local working store; Supabase relational tables are the synced backend baseline.
- `season_id` is the canonical season ownership attribute on every operational row. Filename, upload session, batch, and IATA season code must not determine normal selected-season membership.
- User-facing counts must be effective counts after applying modifications, not raw row counts.

### Rule 2 - Link Type Is Explicit

- `turnaroundId` identifies a relationship.
- `linkType` determines export behavior:
  - `sameday`: ARR and DEP operate on the same date and export as one consolidated ARR+DEP row.
  - `overnight`: DEP absolute record date is next day and exports as a separate DEP row whose pattern maps from ARR +1.
- Export must never infer overnight pairing from time similarity alone.

### Rule 3 - Detailed Is Micro, Seasonal Is Macro

- Detailed edits target specific flight IDs.
- Seasonal Schedule can apply full matched-period atomic linking for a chosen counterpart and can apply a full-row atomic unlink for a flight summary row.
- Period-specific link/unlink belongs in Detailed Schedule.

### Rule 4 - Export Integrity

- Export reconstructs system-recognizable pattern rows from atomic records.
- Deleted records are excluded.
- Selected export includes mandatory linked pairs.
- Same-day links consolidate into one exported row.
- Overnight links export as two rows.
- Explicit overnight DEP pattern rows use ARR effective/discontinue/DOW shifted +1.
- Raw database dates are not mutated for export projection.
- Import collapses identical overlapping duplicate periods, trims later simple-row overlaps into exact remaining phases, then removes any remaining duplicate atomic flight-number/date occurrences before enforcing uniqueness.
- Duplicate flight numbers are prohibited within the same calendar day after import normalization.

---

## Export

`groupFlightLegs(legs)` reconstructs pattern groups from atomic-leg adapters:

1. Exclude deleted legs.
2. Use explicit `linkType` to choose row shape.
3. Consolidate `sameday` ARR+DEP pairs and split `overnight` ARR/DEP rows.
4. Split phases using exact DOW/date coverage.
5. Apply explicit overnight projection only for `linkType: 'overnight'`.

`includeLinkedPairsForExport(records, selectedIds)` guarantees linked record inclusion for selective export.

The UI-only Seasonal aggregator must never replace this export path. Export remains:

```text
flightRecords -> apply modifications -> groupFlightLegs -> downloadSeasonalExcel
```

---

## Native Packaging

- Native desktop packaging uses Tauri. The package command is:

```text
npm run native:build
```

- `native:build` runs `python:agent:bundle` first, then `next build`, compiles the Tauri Rust app, and emits a release executable plus NSIS installer.
- `python:agent:bundle` uses PyInstaller to build `app/src-tauri/binaries/dashboard-ai-agent-x86_64-pc-windows-msvc.exe`; Tauri includes it through `bundle.externalBin`.
- A newly installed desktop app should not require system Python or `uvicorn`. Rust starts the bundled sidecar on demand, health-checks `127.0.0.1:8765`, and injects the session token plus SQLite path.
- Current verified package artifacts:
  - `app/src-tauri/target/release/seasonal-management.exe`
  - `app/src-tauri/target/release/bundle/nsis/SeasonalManagement_0.1.0_x64-setup.exe`
- A successful source build is not enough for a pack request. Always verify the packaged `.exe` or installer artifact exists after `native:build`.

---

## File Map

```text
app/src/
  app/
    page.tsx                    Seasonal Schedule
    checkin/page.tsx            Check-in Allocation Gantt
    dashboard/page.tsx          Dashboard overview, MoM/WoW, AI Notebook Canvas
    dashboard/components/        Notebook cells, block renderers, and date filters
    detailed/page.tsx           Detailed Calendar
    gate/page.tsx               Gate Allocation Gantt
    daily/page.tsx              Daily Schedule and OperationalTurns import
    audit/page.tsx              Audit log viewer
    detailed/EditModal.tsx      Micro edit modal
    detailed/ConfirmModal.tsx   Change preview
    components/NewFlightModal.tsx
    components/SeasonSyncProvider.tsx Native catch-up, Save state, global sync status
    components/FetchServerUpdatesButton.tsx Manual catch-up trigger
    components/SyncActionButton.tsx Save button
    settings/page.tsx           Operational settings
    settings/components/AiAnalysisTab.tsx AI providers, keys, Rules/Skills context docs
  lib/
    atomicSchedule.ts           Atomic flattening, adapters, export selection
    checkInCounterSettings.ts   Check-in counter inventory/group/lock helpers
    checkinAllocation.ts        Check-in Gantt allocation domain logic
    gateAllocation.ts           Gate Gantt allocation domain logic
    dashboardAiAnalysis.ts      Dashboard AI context, tool routing, action/block sanitizers
    dashboardAiShared.ts        Shared dashboard AI intent/filter helpers
    dashboardAnalysis.ts        Dashboard summaries, comparisons, and effective-record analysis
    dashboardReportExport.ts    Fixed/custom dashboard workbook generation
    exporter.ts                 Pattern grouping and Excel export
    localSeasonSqlStore.ts      Tauri SQL compatibility/schema helpers and IndexedDB backup path
    nativeSeasonRepository.ts   TypeScript IPC facade for native viewport reads/mutations/sync
    nativeSeasonCatchup.ts      Native catch-up/read/sync command wrappers
    nativeLocalSeasonStore.ts   Native local mutation command wrappers
    localSeasonStore.ts         Legacy/browser compatibility only; do not use for desktop hot paths
    seasonAutoSync.ts           Manual Save state machine and pending-upload coordinator
    seasonalDisplayAggregator.ts UI-only Seasonal row snapshots
    settingsPageActions.ts      Pure settings-page state transitions
    settingsRules.ts            Operational settings hydration/validation/rules
    parser.ts                   Excel parsing and legacy expansion
    sourceRowPatterns.ts        Legacy granular source-row planner
    types.ts                    Domain types
app/src-tauri/
  src/lib.rs                    Tauri command registration, export save/open/reveal commands, Python AI Agent sidecar supervisor/proxy
  src/native_catchup.rs         Rust SQLite source of truth, catch-up, sync, conflicts, local AI SQL
  tests/native_catchup.rs       Native persistence/catch-up regression tests
app/ai-agent/
  agent_sidecar.py              PyInstaller entrypoint for the bundled FastAPI sidecar
  agent/main.py                 FastAPI local Dashboard AI Agent
  agent/provider_clients.py     Local Gemini/Qwen/DeepSeek provider clients
  agent/sql_validator.py        Mirrored read-only SQL validator
app/supabase/
  schema.sql                    Clean-start database state
  migrations/                   Ordered Supabase upgrades; do not edit historical migrations
  functions/dashboard-ai-analysis/index.ts Legacy/web Dashboard AI Edge Function fallback
  functions/schedule-telegram-notify/index.ts Telegram delivery flusher
  functions/rotate-dashboard-ai-key/index.ts Deprecated Edge-secret rotation fallback
```

---

## Backup History

Recent implementation backups were created before broad dashboard AI changes:

```text
_backups/ai-agent-integration-20260518-204957
_backups/ai-workspace-20260519-000854
_backups/ai-workspace-render-fix-20260519-004222
_backups/ai-workspace-intent-fix-20260519-010054
_backups/ai-notebook-canvas-20260519-090038
_backups/ai-datarequest-autofetch-*
_backups/hermes-inspired-agent-*
_backups/ai-workspace-query-agent-20260522-014455
_backups/ai-query-rich-notebook-20260523-053204
_backups/ai-agent-query-correctness-20260523-175327
_backups/ai-query-only-analysis-intelligence-20260601-142935
_backups/ai-python-local-provider-agent-20260602-093124
_backups/ai-sidecar-key-sync-20260605-233757
```

Each AI backup includes a `BACKUP_MANIFEST.md`. The latest notebook backup includes `app/src`, `app/supabase`, `app/scripts`, package files, docs, root `AGENTS.md`, and related README/guide files when present.

---

## Verification

Use:

```text
npm run test:rules
npm run lint
npm run build
npm run native:build
```

Current known lint status after the AI query-rich notebook change: lint exits 0 with pre-existing warnings in `postcss.config.js`, `src/app/layout.tsx`, and `src/lib/linking.ts`.

Current local AI query-correctness verification: `npm run test:rules`, `npm run lint`, and `npm run build` pass. `deno check` could not run because `deno` is not available in PATH on this machine.

Current deployed AI backend status:

```text
Supabase project ref: rhmehiinfchiiuqmdukz
Edge Function: dashboard-ai-analysis
Latest verified deployed version: 25 (deployed 2026-06-01 09:35:57 UTC after query-only AI changes)
Reporting migrations applied directly with supabase db query --linked --file, including reporting.query_aggregated and public.dashboard_ai_query_aggregated wrapper
```
