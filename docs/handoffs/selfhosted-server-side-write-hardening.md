# Self-hosted Server-side Write Hardening Handoff

Status: backend migration applied; app Seasonal import/auth wiring implemented; authenticated live smoke passed.

This handoff captured DB/RPC/schema work intentionally excluded from the first `https://supabase.ahtops.xyz` no-schema endpoint cutover.

Backend has now applied migration `opsdata-supabase/supabase/migrations/20260622_server_side_write_hardening.sql`. Keep this document as the implementation handoff and verification checklist for app-side follow-through and any remaining backend review.

## Backend Update - 2026-06-22

Implemented backend scope reported by backend:

- Added read-only `run_selfhosted_integrity_checks()`.
- Added transactional `apply_seasonal_import_remote(jsonb)`.
- Hardened `sync_season_workspace_v2` validation, acknowledgement, idempotency, duplicate-op season ownership, and response fields.
- Granted execute to `authenticated` and `service_role`; anon execute is intentionally not granted.

App-side status:

- Seasonal import/re-import now calls `applySeasonalImportRemote()` instead of direct remote `clearSourceRows` / `deleteModifications` / `batchWriteFlightRecords` sequences.
- `supabaseStore` calls `apply_seasonal_import_remote` with the live signature parameter `p_import`, sends both camelCase and snake_case payload fields, and consumes both response styles.
- `syncSeasonWorkspaceRemoteV2` now consumes `changedTargets` and `acknowledgedOps` from the hardened RPC response.
- `supabase.ts` now uses a stable app auth storage key with legacy fallback for the old managed project key, and `OperatorAuthGate` refreshes any saved session before checking `app_operators`.
- Authenticated live RPC smoke passed with a refreshed operator session from the desktop WebView profile. Anon calls still fail as expected under the new grants.

## Original Deferral Reason

The first endpoint cutover was no-schema-change because the self-hosted server was already set up from a cloud server dump. Endpoint, tunnel, release variables, smoke testing, rollback, and docs were enough for that cutover step.

The work below can change database behavior, RPC contracts, app assumptions, or local mirror recovery semantics. It needs its own implementation plan, migration review, RLS/security review, and regression verification.

## Scope

### Transactional Import/Re-import RPC

Design and implement a server-side transaction for Seasonal import and re-import, exposed as `apply_seasonal_import_remote`.

The implementation should cover:

- Find/create/update the target season by canonical `season_id` / `season_code` rules.
- Replace source rows and source-row child tables atomically.
- Remove only scoped modifications intended by the import/re-import operation.
- Upsert flight records and child counter/window tables atomically.
- Write `season_change_events` for downstream catch-up.
- Return a committed `seasonId`, server high-water cursor, and commit status.
- Preserve fail-closed behavior: partial remote state must not be treated as committed by the client.

### `sync_season_workspace_v2` Hardening

Review and harden the existing save/pending-op RPC.

Required topics:

- Ensure every pending `opId` is acknowledged as applied or conflicted.
- Preserve idempotent duplicate-op behavior.
- Return complete `appliedEvents`, `conflictEvents`, `serverHighWater`, and `nextServerSeq` coverage.
- Add or standardize `changedTargets` metadata if route refresh filters need server-produced target coverage.
- Keep client chunking, token refresh, retry, and fail-closed local outbox preservation even though self-hosting can raise server/proxy limits.

### Local Mirror Recovery Support

If DB state is needed for local mirror repair, define the server contract before adding UI.

Potential needs:

- Snapshot RPC coverage for `get_season_workspace_snapshot`.
- Cursor/high-water consistency between snapshot and event pages.
- Known behavior when remote commit succeeds but `importNativeSeasonSnapshot` or SQLite rebuild fails.
- Explicit local mirror state vocabulary if product UX needs it, for example `current`, `remote_committed_local_pending`, `stale`, or `repairing`.
- Operator action for rebuilding SQLite from committed server state.

### Integrity SQL

Prepare read-only integrity checks for restored and post-cutover data.

Candidate checks:

```sql
-- duplicate season codes
select season_code, count(*)
from public.seasons
group by season_code
having count(*) > 1;

-- orphan flight records
select r.record_id
from public.season_flight_records r
left join public.seasons s on s.id = r.season_id
where s.id is null
limit 20;

-- event cursor sanity
select season_id, max(server_seq) as high_water, count(*) as event_count
from public.season_change_events
group by season_id
order by high_water desc
limit 20;
```

Expand these checks after reviewing the current restored schema and known active seasons.

### RLS And Security Review

Before adding or changing exposed tables, views, or RPCs:

- Confirm RLS remains enabled on exposed `public` tables.
- Prefer `security invoker` for RPCs unless a specific privileged operation is required and reviewed.
- Avoid granting broad `PUBLIC` execution on privileged functions.
- Review whether anon/authenticated roles can call each RPC intentionally.
- Confirm functions that use operator identity do not authorize from user-editable metadata.
- Keep service-role keys out of the desktop app and frontend bundle.
- Verify Edge Function secrets exist on the self-hosted runtime and are not exposed to clients.

## Suggested Execution Order After Cutover Stabilizes

1. Inventory current self-hosted schema, functions, RLS policies, and grants.
2. Run read-only integrity SQL and record findings.
3. Draft RPC contracts and migration plan.
4. Add regression tests for expected client behavior before wiring app changes.
5. Implement migrations in a dedicated backend branch.
6. Refresh `app/supabase/schema.sql` only after migrations are verified.
7. Wire app changes behind regression coverage.
8. Smoke with an authenticated operator session on the self-hosted endpoint.

## Non-goals For Endpoint Cutover

- No local mirror recovery UI is added.
- No service-role key is added to the desktop app or frontend bundle.
- No anon execute grant is added for privileged write RPCs.
