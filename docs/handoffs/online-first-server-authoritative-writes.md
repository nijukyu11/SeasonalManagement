# Backend Handoff: Online-First Server-Authoritative Writes

Date: 2026-06-22

## Goal

Move SeasonalManagement operational writes from native/offline-first pending-op sync to server-authoritative online-first writes on the self-hosted Supabase server.

The app target is:

- Supabase self-hosted is the only durable write authority.
- SQLite is read-through cache/reporting accelerator only.
- Durable offline writes are disabled.
- Conflict review is removed from the normal user workflow.
- Latest committed server write wins.
- Recovery/audit is handled through `season_change_events`, server cursors, and operator audit trails.

## Existing Backend State

Already applied by backend:

- `run_selfhosted_integrity_checks()`
- `apply_seasonal_import_remote(jsonb)`
- hardened `sync_season_workspace_v2`
- authenticated/service_role execute grants
- anon execute revoked

Keep `sync_season_workspace_v2` for rollback/legacy compatibility, but the online-first app should stop using it as the primary operational write path.

## Required New RPC

Create:

```sql
public.apply_season_server_mutation_v1(p_mutation jsonb)
returns jsonb
```

Recommended grant:

```sql
revoke all on function public.apply_season_server_mutation_v1(jsonb) from public, anon;
grant execute on function public.apply_season_server_mutation_v1(jsonb) to authenticated, service_role;
```

## Required Payload Contract

The app will call:

```json
{
  "seasonId": "season-...",
  "clientId": "desktop-client-...",
  "clientMutationId": "uuid",
  "source": "checkin|gate|daily|detailed|seasonal",
  "baseServerSeq": 123,
  "operations": []
}
```

Requirements:

- `seasonId` is required.
- `clientId` is required.
- `clientMutationId` is required.
- `source` is required.
- `operations` must be a JSON array.
- Empty `operations` is allowed for smoke/idempotency validation and should return a no-op success.
- Do not accept anon execution.

## Required Result Contract

Return both camelCase and snake_case fields during transition:

```json
{
  "seasonId": "season-...",
  "season_id": "season-...",
  "serverHighWater": 130,
  "server_high_water": 130,
  "nextServerSeq": 130,
  "next_server_seq": 130,
  "changedTargets": ["modification:leg-1"],
  "changed_targets": ["modification:leg-1"],
  "affectedIds": ["leg-1"],
  "affected_ids": ["leg-1"],
  "appliedEvents": [],
  "applied_events": [],
  "rejectedEvents": [],
  "rejected_events": []
}
```

## Idempotency

Add server-side idempotency for `(season_id, client_id, client_mutation_id)`.

Recommended table:

```sql
create table if not exists public.season_mutation_receipts (
  season_id text not null,
  client_id text not null,
  client_mutation_id text not null,
  source text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (season_id, client_id, client_mutation_id)
);
```

Behavior:

- First call applies the mutation transactionally and stores the response.
- Repeated call with the same request hash returns the stored response.
- Repeated call with same key but different payload returns a validation error.

## Transaction Semantics

Inside the RPC:

1. Validate authenticated operator.
2. Validate payload.
3. Lock the target season row or use a transaction-scoped advisory lock keyed by `seasonId`.
4. Apply all operations atomically.
5. Insert `season_change_events` for changed targets.
6. Advance server cursor/high-water.
7. Store idempotency receipt.
8. Return the mutation result.

If any operation is invalid, reject the whole mutation and do not partially apply.

## Last-Write-Wins Rule

The online-first client accepts server latest write wins.

Backend should not produce manual merge conflict rows for normal operational edits. Instead:

- validate write permission;
- apply the mutation;
- emit change events;
- let clients refresh stale windows from server events/cursors.

If `baseServerSeq` is older than current server high-water:

- still apply the mutation if business validation passes;
- include current `serverHighWater` in the response;
- emit all relevant changed targets.

Only reject for hard validation/security/business-rule errors.

## Audit Requirements

Every non-empty mutation should be traceable through existing or new audit fields:

- authenticated user id/email if available;
- `clientId`;
- `clientMutationId`;
- `source`;
- affected season id;
- changed targets;
- server sequence;
- timestamp.

Prefer reusing `season_change_events` plus receipt metadata before adding another audit table.

## Compatibility Requirements

Do not remove existing RPCs yet:

- `sync_season_workspace_v2`
- `get_season_workspace_snapshot`
- `get_season_change_event_page`
- `apply_seasonal_import_remote`
- `run_selfhosted_integrity_checks`

The app needs rollback compatibility while the online-first cutover is validated.

## Smoke Tests For Backend

Run with authenticated operator context:

```sql
select public.run_selfhosted_integrity_checks();
```

Expected:

- duplicate season codes: 0
- orphan flight records: 0
- orphan source rows: 0
- orphan change events: 0

Run no-op mutation:

```sql
select public.apply_season_server_mutation_v1(
  jsonb_build_object(
    'seasonId', '<real-season-id>',
    'clientId', 'smoke-client',
    'clientMutationId', gen_random_uuid()::text,
    'source', 'smoke',
    'operations', '[]'::jsonb
  )
);
```

Expected:

- RPC returns success JSON.
- `serverHighWater`/`server_high_water` exists.
- `changedTargets`/`changed_targets` is an array.
- No mutation data is changed for empty operations.

Run idempotency smoke:

```sql
select public.apply_season_server_mutation_v1('<same-json-payload>'::jsonb);
select public.apply_season_server_mutation_v1('<same-json-payload>'::jsonb);
```

Expected:

- second call returns the same response.
- second call does not duplicate change events.

Run permission smoke:

- anon call must fail.
- authenticated call must succeed.
- service_role call must succeed.

## App Integration Blocker

The app should not switch operational route writes to online-first production behavior until this RPC is live and the smoke tests above pass.
