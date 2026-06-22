# SeasonalManagement Architecture

Last updated: 2026-06-22

## Purpose

SeasonalManagement is a native-first aviation operations app for importing seasonal Excel schedules, editing atomic flight legs, allocating check-in counters and gates, exporting recognized Excel/PDF outputs, and running read-only dashboard analysis.

The current runtime target is the Tauri desktop app. Next.js/React is the UI shell; Rust + SQLite is the operational local source of truth; Supabase is the shared backend, reporting store, auth boundary, and Edge Function host.

## Runtime Shape

```text
User action
  -> Next.js route/component
  -> TypeScript domain helper
  -> nativeSeasonRepository.ts
  -> Tauri command in src-tauri/src/lib.rs
  -> Rust implementation in src-tauri/src/native_catchup.rs
  -> seasonal-management-local.db
  -> manual Save / Fetch Server Updates
  -> Supabase RPCs, tables, and Edge Functions
```

Browser/static mode is not the operational source of truth. Legacy IndexedDB modules remain for compatibility, migration, and backup paths, but normal desktop routes should use native SQLite commands or bounded native read APIs.

## Current Codebase Map

This 2026-06-21 refresh used GitNexus plus direct source inspection. GitNexus is installed for the repo, but the active index is stale and incomplete for the current native rewrite: it was indexed on 2026-05-21, keyword search reports missing FTS indexes, and the graph only recognizes `app/src-tauri/src/lib.rs` / `main.rs` instead of the large Rust core in `native_catchup.rs`. Treat GitNexus as a broad historical map until it is rebuilt cleanly; live source under `app/src`, `app/src-tauri`, and `app/supabase` is authoritative.

The active architecture is now organized around six seams:

| Seam | Current owner | Notes |
|---|---|---|
| Route workflows | `SeasonalSchedulePage`, `daily`, `detailed`, `checkin`, `gate`, `dashboard`, `settings`, `audit` | Pages own UI state, drafts, dialogs, and viewport-specific actions. |
| Domain transforms | `atomicSchedule`, `dailySchedule`, `checkinAllocation`, `gateAllocation`, `exporter`, `settingsRules` | Keep these pure where possible; they are the safest place for deterministic regression tests. |
| Native facade | `nativeSeasonRepository`, `nativeSeasonCatchup`, `nativeLocalSeasonStore` | TypeScript should call native through these modules instead of importing Tauri commands ad hoc. |
| Native core | `src-tauri/src/lib.rs`, `src-tauri/src/native_catchup.rs` | Owns SQLite, row-level mutations, sync, catch-up, conflict resolution, local dashboard SQL, and AI sidecar access. |
| Remote/backend | `remoteStore`, `supabaseStore`, `supabaseRelationalMappers`, `supabase/schema.sql`, migrations | Native runtime requires Supabase; non-native Firestore fallback still exists but is not the operational desktop path. |
| AI/reporting | `dashboardAiAnalysis`, `dashboardAiShared`, `ai-agent`, Supabase AI functions | Read-only analysis only; local SQLite is authoritative when desktop data is loaded or dirty. |

## Primary Boundaries

| Layer | Main Files | Responsibility |
|---|---|---|
| UI routes | `app/src/app/SeasonalSchedulePage.tsx`, `detailed/page.tsx`, `daily/page.tsx`, `checkin/page.tsx`, `gate/page.tsx`, `dashboard/page.tsx`, `settings/page.tsx` | User workflows, local draft state, dialogs, viewport rendering |
| UI components | `app/src/app/components/*`, `dashboard/components/*`, `settings/components/*` | Shared app shell, sync buttons, conflict review, notebook blocks, settings tabs |
| Domain logic | `app/src/lib/atomicSchedule.ts`, `exporter.ts`, `dashboardAnalysis.ts`, `checkinAllocation.ts`, `gateAllocation.ts`, `settingsRules.ts` | Pure transformations and business rules |
| Native TS facade | `app/src/lib/nativeSeasonRepository.ts`, `nativeSeasonCatchup.ts`, `nativeLocalSeasonStore.ts` | Tauri IPC wrappers and Supabase auth token handoff |
| Native Rust core | `app/src-tauri/src/lib.rs`, `app/src-tauri/src/native_catchup.rs` | SQLite schema usage, viewport queries, local mutations, sync, catch-up, conflicts, local AI SQL |
| Remote store | `app/src/lib/remoteStore.ts`, `supabaseStore.ts`, `supabaseRelationalMappers.ts` | Supabase Data API/RPC access and row/payload mapping |
| Supabase backend | `app/supabase/schema.sql`, `migrations/*`, `functions/*` | Relational backend, reporting RPCs, AI Edge Function, Telegram delivery |

## Data Model

`season_id` is the canonical ownership attribute for operational rows. Do not group selected-season data by filename, upload batch, import session, or IATA season code.

Season ownership hardening is staged. The current safe pass scopes destructive modification deletes and enforces unique `season_code`; the larger remote composite-key migration is deferred because it changes parent/child table keys, mappers, RPCs, and reporting surfaces together.

Local SQLite and Supabase intentionally mirror the same concepts:

| Concept | Local SQLite | Supabase |
|---|---|---|
| Season metadata | `local_seasons` | `seasons` |
| Imported source evidence | `local_source_rows` | `season_source_rows`, `season_source_row_days` |
| Editable operating legs | `local_flight_records` | `season_flight_records` plus child counter/window tables |
| Modification overlays | `local_modifications` | `season_modifications` plus child counter/window/added-leg tables |
| Undo/history | `local_mod_history_entries` | `season_mod_history_entries`, change tables |
| Pending sync | `local_pending_ops` | `season_change_events` |
| Conflict clocks | `local_entity_versions` | `season_entity_versions` |
| Sync state | `local_sync_meta` | event high-water and workspace snapshot RPCs |
| AI/settings/audit | local reads where needed | operational settings, AI models/context docs, audit tables |

Local current rows and base rows are stored side by side with `is_base`. Pending operations are derived by comparing current state to base state; they are not a permanent action log. Reversing an edit back to baseline should remove the pending operation.

## Import To Export Flow

```text
Excel workbook
  -> parser.ts parses source rows
  -> atomicSchedule.ts flattens rows into FlightRecord occurrences
  -> SQLite current/base rows are written for the exact season_id
  -> route pages query bounded native windows
  -> edits write row-level native mutations and pending ops
  -> Save uploads pending change events to Supabase
  -> exporter.ts rebuilds system-recognizable pattern rows
```

`sourceRows` are import evidence and compatibility backup. `FlightRecord` rows are the editable/exportable truth. Same-day and overnight relationships must be explicit through `turnaroundId`/`linkType`; export must not infer overnight pairings from time similarity.

## Sync And Catch-Up

The user-facing action is `Save`, not continuous publish.

1. Route-specific drafts are committed to native SQLite before Save.
2. `SeasonSyncProvider` and `SeasonAutoSyncScheduler` coordinate status, guards, and user-facing progress.
3. `syncNativePendingChanges()` sends the access token and client id to the Rust command `sync_pending_changes`.
4. Rust builds V2 change events from `local_pending_ops` and calls Supabase `sync_season_workspace_v2`.
5. On success, pending current rows are promoted to base rows, entity clocks are updated, pending ops are cleared, and Telegram delivery is flushed best-effort.
6. On conflict, conflict items stay in `local_sync_meta` and the UI exposes review controls.

Fetch/catch-up is separate from Save:

1. The app reads a server high-water cursor.
2. Rust fetches `get_season_change_event_page` pages from Supabase.
3. Each page is applied inside committed SQLite transactions.
4. `lastServerSeq` advances only after committed local work.
5. Token refresh, retryable page fetches, writer locking, WAL, busy timeout, and passive checkpoints are handled in the native layer.

Full workspace snapshot replacement is allowed for import, reset, repair, and guarded baseline seeding. Routine catch-up and normal edits must stay row-level/delta based.

Current sync hardening boundaries:

- `query_sync_summary` is the lightweight sync state contract. It includes pending/conflict counts, cursor fields, `localRevision`, `localRecordCount`, and `entityVersionCount`.
- Fresh local workspace detection is based on native counts, not `lastServerSeq` alone. When local records, entity versions, pending ops, and conflicts are all zero, catch-up starts from cursor `0`.
- Conflict cleanup in Rust structurally parses pending `modHistory` payloads and preserves mixed/cross-target history. Substring cleanup against `payload_json` is not safe for ids such as `leg-1` and `leg-10`.
- Manifest reconcile protects stale-row pruning through parsed pending targets. It must not use substring checks over `op_key` or `payload_json`, because `modification:leg-10` can otherwise protect an unrelated stale `leg-1` row.
- Native pending sync and TypeScript fallback sync report `conflict` when pending ops are empty but review items remain. Manual Save still calls native sync with zero pending ops so conflict-only states are not flattened to `synced`.
- Close/session cleanup may discard pending local edits, but unresolved conflict review items must stay in `local_sync_meta` and keep `syncStatus = needs_review`. Browser fallback discard-all, SQL discard, and native discard must follow the same conflict-preserving contract.
- `SeasonAutoSyncScheduler` preserves `conflictCount` on runtime `conflict` results, including review-only manual Save, so provider session warnings do not drop unresolved review items.
- Clean scheduler success paths must clear stale `conflictCount` because state patches are merged.
- Scheduler queue cleanup must not overwrite `needs_review` or `conflict` with a fresh auto-save schedule when local edits arrive during an in-flight sync.
- Scheduler runs must preserve conflict summaries observed during the active run even when the final sync result is clean. This uses current-run conflict tracking, not stale state, so an explicit clean sync can still clear resolved conflicts.
- Scheduler summary updates must consume native `conflictCount`; conflict-only summaries should publish `needs_review` directly, not `synced` followed by a corrective provider patch.
- Scheduler pre-run pending-count summary failures must publish `failed` sync state and return a failed result. A rejected `getPendingCount()` must not escape manual Save or auto-save while the UI remains in an old state.
- Workspace-change summary refresh must catch `queryNativeSyncSummary()` failures and publish a failed sync state. A native summary read failure must not leave only a stale session warning with no visible route/global error.
- Workspace-change events that carry `syncMeta` must patch provider route/global state and notify the scheduler immediately before the debounced native summary read. The later native summary remains the reconcile step, but badges must not show stale `Synced` state while pending or conflict metadata is already available.
- Workspace-change summary refresh must patch provider state from native summary on every successful read, including `conflictCount = 0`. Otherwise resolving the last conflict can update session/scheduler state while leaving route/global UI stuck at `needs_review`.
- Provider native summary seeding must also catch `queryNativeSyncSummary()` failures, publish a failed sync state, and rethrow. Gate relies on this seed path for its sync badge and should not remain in `Checking` after a native summary read failure.
- Live season subscription setup must catch remote store or realtime subscription failures and publish a failed sync state. If subscription setup fails, automatic catch-up is unavailable and stale data must be visible as a sync failure.
- Live season setup must still run background catch-up when the active `RemoteStore` has no realtime subscription API. Realtime is the push channel, not the prerequisite for initial server update fetch. The fallback must register a no-op live marker so repeated `ensureLiveSeason()` calls do not start duplicate catch-up runs for the same season.
- Manual Save and Fetch Updates must start their manual operation before calling `ensureLiveSeason()`. The live setup path may start background catch-up, so calling it first can race with manual sync/fetch before the manual guard is active.
- Seasonal import/re-import replaces or patches a local baseline, so its handler and visible button must be disabled while native catch-up/Fetch Updates is applying server changes.
- Daily OperationalTurns import writes batches of local schedule changes, so its handler and visible button must also be disabled while native catch-up/Fetch Updates is applying server changes.
- Daily local mutation controls and handlers must use same-season `syncWriteInProgress = syncInProgress || fetchingUpdates`, not manual-only `syncing`, for Add/Link/Unlink/Delete. Auto Save and catch-up are both write paths and should not leave local mutation controls visually or behaviorally active.
- Check-in and Gate allocation write interactions must also use same-season `syncWriteInProgress` for drag/drop, resize, context actions, unallocate-all, and override apply. Manual-only `syncing` is insufficient because auto Save and catch-up both write native sync state.
- The global sync banner must surface server freshness failures from catch-up replay, realtime subscription setup, native sync summary reads, local integrity checks, server update fetch availability, and missing server seasons. Its copy should use generic server sync wording, not catch-up-only wording, failed server freshness states must take priority over another season's background catch-up progress, and context fallbacks must be preserved when raw thrown errors would otherwise produce generic messages such as `Failed to fetch`.
- Server update fetch runtime checks must publish provider `failed` state before returning failed results. Runtime-unavailable paths should not leave badges/global sync UI in the previous state.
- `useSeasonWorkspaceRefresh()` must preserve a failed native refresh event without advancing its handled cursor. The hook may avoid immediate retry loops, but a failed event must remain available for a controlled retry on route activation or a newer workspace event.
- `useSeasonWorkspaceRefresh()` must re-check `event.seasonId` when a debounced or activation-delayed refresh actually runs. A queued event from a previous season must be discarded before the route native refresh callback is called.
- Save handlers on operational routes, including Seasonal and Detailed, must warn when `reviewCount > 0`, even if the sync result status is `synced` after non-conflicting changes were saved. Controlled sync failures must use the explicit `Save Failed` title instead of a generic status label.
- Seasonal and Detailed mutation controls must block on any same-season `syncing` state, not only manual Save mode. The shared provider state is season-scoped, so auto/manual sync from another surface must disable edits, undo, link/unlink/delete, import, fetch, and save controls for that season.
- Native sync publish events must preserve `reviewCount` for `synced` results when native `conflictCount` remains positive.
- Settings repair import confirmations must include native `conflictCount` as conflict review items, not only pending local changes.
- Settings repair import must pass the imported native `syncMeta` through `publishSeasonWorkspaceChanged` after replacing the local baseline, because provider route/global state consumes event metadata immediately before the debounced native summary reconcile.
- Seasonal re-import of an existing season must also pass native `conflictCount` into the dirty-import guard. A clean `pendingCount` does not make baseline replacement safe while conflict review items remain.
- Route-local sync badge fallbacks must derive conflict count from `LocalSyncMeta.conflicts` and pass it to shared label/tone helpers. `pendingCount = 0` is not enough to render success while conflicts are unresolved, and fallback `pendingCount > 0` must keep warning tone even if provider state is still `live`.
- Dashboard Fetch Updates must present native catch-up `conflict` results as a warning/status notice and disable while same-season `syncing` is active. It must not silently ignore review items or allow manual catch-up to overlap a save just because Dashboard is read-only.
- Fetch Updates controls on operational routes and Dashboard must use any `catching_up` state as their busy/disabled state, including background server update replay. Manual fetch should not remain clickable only because the current catch-up was not started by the button.
- A duplicate manual Fetch Updates call while catch-up is already in flight is `busy`, not `failed`. Routes must not show `Fetch Updates Failed` for this already-running state.
- A manual Fetch Updates call blocked by a local operation guard should queue catch-up and return `busy`, not `failed`, because the request is deferred rather than broken.
- Icon-only toolbar buttons must expose an explicit `aria-label` even when they also have `title` tooltips.
- Daily, Check-in, and Gate `Fetch Updates` buttons should use `syncInProgress`, not manual-only `syncing`, for disabled state so auto sync and manual fetch cannot overlap visually or behaviorally.
- Manual Fetch Server Updates reports `conflict` when native catch-up leaves review items. Route handlers should present that as a warning/review state, not as successful sync and not as a fetch failure.
- Session sync warnings track both pending local changes and conflict-only review items. Do not clear the session warning merely because `pendingCount` is zero when `conflictCount` remains positive.
- Shared sync UI tone treats conflict review as warning; only failed sync states should use error tone.
- JS allocation delta commits use one queued read-modify-write transaction through `replaceLocalSeasonSqlPendingStateFromDelta`; hot-path UI code must not split the delta read and pending write into separate queue slots.
- Gate sync status is owned by `SeasonSyncProvider` and seeded from native summary. The Gate page must not maintain a parallel debounced summary state.
- Gate optimistic allocation reset uses `SeasonAutoSyncState.localRevision` as the durability signal.

## Route Responsibilities

Route shells should use dynamic viewport height (`h-dvh`) rather than fixed `h-screen` so the desktop WebView and responsive layouts do not clip or leave stale viewport gaps. Rule tests guard `src/app/**/*.tsx` for this exact class.

| Route | Role | Native data access |
|---|---|---|
| Seasonal Schedule | Aggregated ARR/DEP macro view, import, export, row-level link/unlink/delete | `queryNativeScheduleWindow`, `queryNativeSourceRowsWindow`, `runNativeScheduleMutation` |
| Detailed Schedule | ID-level calendar editing, pair-aware delete, manual link/unlink | `queryNativeScheduleWindow`, `runNativeScheduleMutation` |
| Daily Schedule | Daily operational view and OperationalTurns import | `ensureNativeLocalSeason`, `queryNativeScheduleWindow`, `runNativeScheduleMutation` |
| Check-in Allocation | Departure-only Gantt, counter assignment/time windows | `queryNativeAllocationWindow`, `runNativeLocalModificationBatchDelta` |
| Gate Allocation | Gate/stand Gantt allocation | `queryNativeAllocationWindow`, `runNativeLocalModificationBatchDelta` |
| Dashboard | Overview, MoM/WoW comparison, AI notebook | native schedule/dashboard reads plus Supabase reporting/AI |
| Settings | Operational resources, rules, route countries, AI providers, AI context docs | Supabase settings tables through `remoteStore` |
| Audit | Audit session/log review | Supabase audit tables |

Check-in and Gate routes must keep pointer/drag hot paths separate from durable persistence. Optimistic UI projections are allowed, but full workspace hydration, Supabase writes, and manual Save execution do not belong in drag-over, resize-move, or drop-preview handlers.

## Dashboard AI

Dashboard AI is read-only and dashboard-scoped.

- Frontend context and sanitization live in `app/src/lib/dashboardAiAnalysis.ts`.
- Shared intent/filter helpers live in `app/src/lib/dashboardAiShared.ts` and `app/supabase/functions/_shared/dashboardAiShared.ts`.
- Provider calls run only through `app/supabase/functions/dashboard-ai-analysis/index.ts`.
- Remote data queries use allowlisted Supabase reporting RPCs such as `dashboard_ai_query_rows` and `dashboard_ai_query_aggregated`.
- Local native analysis uses SQL plans executed by `queryNativeDashboardAiSql`, which only allows read-only `SELECT`/CTE statements against the temporary `dashboard_ai_flight_operations` view.
- Custom AI Rules/Skills are markdown documents in `operational_ai_context_documents`, edited from Settings and injected into the Edge Function prompt context.
- HTML output is allowed only as sanitized iframe preview. AI output must not execute JavaScript, SQL writes, formulas, file paths, or operational mutations.

## Notifications

Schedule-change Telegram notifications are data-driven:

```text
TypeScript mutation history
  -> scheduleNotification payload on mod history
  -> native pending event
  -> season_change_events insert
  -> enqueue_schedule_notification_delivery trigger
  -> schedule_notification_deliveries
  -> schedule-telegram-notify Edge Function
```

Rust and TypeScript must preserve the full `scheduleNotification` payload. Best-effort notification flushing happens after successful pending upload.

## Security Boundaries

- Supabase provider keys and AI model secrets must stay behind Edge Functions and operator-gated settings flows.
- Dashboard AI key rotation is operator-gated and must filter `app_operators` by the authenticated user id.
- Reporting views and public RPC wrappers use allowlists and `security_invoker` behavior where applicable.
- `operational_ai_context_documents` is RLS-protected for authenticated app operators.
- Native local SQL for AI is read-only and limited to the dashboard temp view.

## GitNexus Notes

GitNexus is useful for the older graph and cross-file symbol relationships, but its current index is stale for the native rewrite. Current observed state:

- Repo: `SeasonalManagement`
- Indexed at: 2026-05-21T18:20:04.259Z
- Indexed files: 815
- Indexed symbols: 52,367
- Indexed processes: 300
- Many indexed symbols are under `_backups`, which causes ambiguous matches for current app symbols.
- Keyword `query()` returned no processes on 2026-06-21 because FTS indexes are missing.
- `route_map` and `tool_map` currently return empty results for this project.
- Cypher/file queries still work for broad topology, but the Rust native core is under-indexed.
- A prior reindex attempt on 2026-05-28 failed with `Cannot destructure property 'package' of 'node.target' as it is null.`

Until GitNexus is rebuilt cleanly, use it for broad historical topology and use direct live-file inspection for `app/src/lib/native*`, `app/src-tauri`, and newer Supabase migrations.

## Review Watchlist

- Dashboard AI production Vietnamese strings in `dashboardAiAnalysis.ts` and `dashboard-ai-analysis/index.ts` are normalized to UTF-8 and guarded by rule tests. Keep those guards when editing prompts, fallback text, or Edge Function responses; malformed Vietnamese in tests should be limited to explicit repair/fallback fixtures.
- `native_catchup.rs` is a large multi-responsibility module. Changes to sync, catch-up, manifest reconcile, conflict cleanup, and local AI SQL should be reviewed with direct Rust tests because GitNexus does not currently expose that internal symbol graph.
- Keep the manifest reconcile prefix-collision regression in `native_catchup.rs` tests whenever changing pending target parsing.
- Keep the conflict-only native sync regression in `native_catchup.rs` tests whenever changing pending upload or manual Save behavior.

## Verification

For architecture-sensitive changes, use:

```text
npm run test:rules
npm run test:notifications
npm run test:updater
cargo test --manifest-path app/src-tauri/Cargo.toml --test native_catchup
npx tsc --noEmit --pretty false
npm run build
```

`npm run native:build` is a release/integration gate for packaging changes or final release validation. Do not run it during routine implementation unless explicitly requested. For documentation-only changes, at minimum verify the edited files exist and contain the expected current sections.
