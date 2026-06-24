# Handoff: Server Workspace Window RPC

Date: 2026-06-22

## Goal

Add a narrow read-only RPC so the desktop app can load schedule/allocation windows from the self-hosted Supabase server first, without querying native SQLite on cache miss.

Frontend now calls `get_season_schedule_allocation_window_v1` through `loadSeasonWorkspaceWindow(...)`. If this RPC is missing, the app falls back to Supabase table reads, then native SQLite fallback only if server read fails.

## RPC Contract

```sql
public.get_season_schedule_allocation_window_v1(
  p_season_id text,
  p_start_date text default null,
  p_end_date text default null,
  p_resource_type text default 'all',
  p_limit integer default null
) returns jsonb
```

Allowed `p_resource_type` values:

- `all`
- `schedule`
- `gate`
- `checkin`
- `stand`
- `counter`
- `carousel`

Reject any other value.

## Response Shape

Return the same relational payload names used by `get_season_workspace_snapshot`, but scoped to the requested window:

```json
{
  "seasonId": "season-id",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "resourceType": "gate",
  "cursor": { "serverHighWater": 123 },
  "flightRecords": [],
  "flightRecordCounters": [],
  "flightRecordWindows": [],
  "modifications": [],
  "modificationCounters": [],
  "modificationWindows": [],
  "modificationAddedLegs": []
}
```

Keep camelCase keys. The frontend also tolerates `server_high_water` inside `cursor`.

## Filtering Rules

Flight records:

- `season_flight_records.season_id = p_season_id`
- if date range is provided, filter by `coalesce(operational_date, scheduled_date, date)`
- include `status = 'active'` and deleted rows only if current server read contract expects deleted rows for undo/review; current frontend can tolerate deleted rows
- order by date, schedule, flight_number, record_id
- apply `p_limit` if provided

Children:

- `season_flight_record_counters` where `record_id` is in selected records
- `season_flight_record_checkin_windows` where `record_id` is in selected records

Modifications:

- include modifications where `leg_id` is in selected record ids
- include season-owned modifications for added legs when the added leg's `coalesce(operational_date, scheduled_date, date)` is inside the requested date range
- include required children:
  - `season_modification_counters`
  - `season_modification_checkin_windows`
  - `season_modification_added_legs`

Cursor:

- `cursor.serverHighWater` should be `max(server_seq)` from `season_change_events` for `p_season_id`, default `0`.

## Grants

- revoke execute from `anon`
- grant execute to `authenticated` and `service_role`

The function is read-only. Prefer `security invoker` unless the existing RLS policy model requires a controlled `security definer`; if using `security definer`, keep the same operator/auth checks as the existing server mutation RPCs.

## Frontend Call Site

- `app/src/lib/supabaseStore.ts`
- method: `getSeasonWorkspaceWindow(...)`
- public wrapper: `app/src/lib/remoteStore.ts` `loadSeasonWorkspaceWindow(...)`

No frontend contract change is expected after this RPC lands.
