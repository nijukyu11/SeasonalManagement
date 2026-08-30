# Canonical flight-leg store inventory

**Captured:** 2026-08-29 (Asia/Ho_Chi_Minh)

**Scope:** Read-only code/schema inventory plus read-only production baseline. No
production migration or import was executed.

## Locked contract

- Canonical live table: `public.season_flight_records`.
- Source kinds: `seasonal | daily | manual`.
- Active predicate: `status='active' AND action IS DISTINCT FROM 'deleted'`.
- Canonical Ops Date: explicit `operational_date` when valid; otherwise local
  scheduled date with the 05:00 Asia/Ho_Chi_Minh boundary.
- Full occurrence identity: season, Ops Date, side, airline/flight, route and
  scheduled time. Loose identity is preview/rebase evidence only and must match
  exactly one old record.

## Store classification

| Relation/module | Classification before cutover | Canonical target |
|---|---|---|
| `season_flight_records` | Seasonal base plus some manually added base rows | Only live leg store for Seasonal/Daily/Manual |
| `season_modifications` and child tables | Operational overlay/draft delta | Retained overlay; never a second base snapshot |
| `season_modification_added_legs` | Legacy live manual-leg child | Backfill then empty/read-only legacy structure |
| `daily_schedule_import_batches` | Daily stage/receipt | Retained staging, audit and idempotency |
| `daily_schedule_import_batch_legs` | Daily stage and former live snapshot payload | Retained staging/audit only |
| `daily_schedule_active_days` | Legacy live day pointer | Rollback evidence only; canonical commit must not update it |
| `schedule_replacement_scopes` | Not present | Daily authority metadata, including zero-flight scope |
| `reporting.effective_flight_operations` | Effective projection with legacy added-leg union | Delegate/align with canonical effective boundary |
| public traffic report materialization | Projection from a live relation selected by its migration | Projection from canonical effective view plus source version |

## Consumer/write inventory

| Consumer/write path | Current dependency found | Required cutover |
|---|---|---|
| Daily stage/commit RPC | Daily batch tables and active-day pointer | Stage against canonical active rows; atomic soft-delete/insert |
| Seasonal workspace window V2 | Base branch plus legacy added-leg branch | Canonical base branch only; overlays still returned separately |
| Seasonal export snapshot | Base plus legacy added-leg payload | Canonical base plus provenance; no live legacy child |
| Detailed/Gate/Check-in save | `season_modifications` and its children | Same overlay keyed by canonical record ID; reject deleted/superseded base |
| Manual add | `season_modification_added_legs` | Canonical `source_kind='manual'` row plus audit/overlay contract |
| Reporting views | Base/legacy union with partially independent deletion rules | One canonical effective predicate and overlay precedence |
| Public traffic report | Materialized projection refreshed independently | Canonical source version/watermark and explicit stale state |
| Realtime | `season_change_events` | One logical event per canonical commit and affected scope |

## Read-only production baseline

Host inspected over SSH: self-hosted Supabase/PostgreSQL 17.6. Counts are a
point-in-time checkpoint and must be refreshed before any rehearsal or rollout.

| Check | Value |
|---|---:|
| `season_flight_records` | 60,963 |
| legacy `source_kind='imported'` | 52,725 |
| legacy `source_kind='added'` | 8,238 |
| active/action-null records | 60,869 |
| deleted/action-deleted records | 94 |
| `season_modifications` | 3,416 |
| `season_modification_added_legs` | 0 |
| Daily batches | 1 |
| Daily staged legs | 596 |
| Daily active days | 5 |
| season change event watermark | 47,545 |

The production baseline confirms that the currently active LB Daily payload is
still a pointer-backed snapshot, while reporting/base consumers can observe a
different store. This is the direct cause of the previously observed “atomic
commit but different report snapshot” behavior.

## Cutover safety rule

Production remains no-go until PostgreSQL 17 clone rehearsal proves: manual
backfill parity, Daily rollback at every fault point, Seasonal Merge/Replace
respecting Daily authority, and report count/Pax parity at the same source
version.
