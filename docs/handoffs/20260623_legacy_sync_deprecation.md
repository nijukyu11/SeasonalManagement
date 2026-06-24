# Legacy Sync Deprecation Handoff

Frontend target after the online-first cleanup:

- Normal primary routes no longer call native catch-up, native summary polling, or conflict review for route activation, tab switching, `Fetch data`, or server-live invalidation.
- Normal route writes should use `apply_season_server_mutation_v1(jsonb)` through `applySeasonServerMutationV1()`.
- Normal route reads should use `get_season_schedule_allocation_window_v1(...)` through `loadSeasonWorkspaceWindow()`.
- `season_change_events` remains useful for audit, realtime invalidation, and diagnostics.
- `season_mutation_receipts` remains required for idempotent online-first writes.

Backend action requested after one verified frontend release:

1. Confirm from Supabase logs that active clients no longer call `sync_season_workspace_v2` for normal route operation.
2. Confirm active clients no longer enter the legacy conflict-review path through `sync_season_workspace_v2`; there are no public conflict-review RPCs as separate functions.
3. Keep `sync_season_workspace_v2` callable during the rollback window, but mark it deprecated for normal clients.
4. Keep `sync_season_workspace(text, integer, jsonb)` callable during the rollback window, but mark it deprecated for normal clients.
5. Do not drop tables, revoke grants, or remove RPCs until at least one production release cycle passes without calls from active clients.

Backend state received on 2026-06-23:

- Migration `opsdata-supabase/supabase/migrations/20260623045649_deprecate_legacy_sync_rpcs.sql` adds `COMMENT ON FUNCTION` deprecation metadata for the legacy sync RPCs.
- `sync_season_workspace_v2(text, text, bigint, jsonb)` still exists and remains callable by `authenticated` and `service_role`.
- `sync_season_workspace(text, integer, jsonb)` still exists and remains callable.
- No grants were revoked, no RPCs were dropped, and no tables were changed.
- Recent database evidence matches the online-first write path: `season_mutation_receipts` has recent check-in receipts, and `season_change_events` has recent audit events.

No immediate schema change is required for the frontend cleanup.
