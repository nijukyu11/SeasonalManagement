# SeasonalManagement Architecture

Last updated: 2026-05-28

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

## Route Responsibilities

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
- Many indexed files are under `_backups`; native files such as `nativeSeasonRepository.ts` were not in the graph during this refresh.
- Reindex attempt on 2026-05-28 failed with `Cannot destructure property 'package' of 'node.target' as it is null.`

Until GitNexus is rebuilt cleanly, use it for broad historical topology and use direct live-file inspection for `app/src/lib/native*`, `app/src-tauri`, and newer Supabase migrations.

## Verification

For architecture-sensitive changes, use:

```text
rtk npm run test:rules
rtk npm run test:notifications
rtk npx tsc --noEmit --pretty false
rtk npm run build
rtk npm run native:build
```

For documentation-only changes, at minimum verify the edited files exist and contain the expected current sections.
