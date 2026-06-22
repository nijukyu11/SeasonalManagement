# SeasonalManagement Supabase backend schema and functions

Generated for backend cutover comparison on 2026-06-20 from the current codebase.

This file is a backend reference built from:

- `app/supabase/schema.sql`
- `app/supabase/config.toml`
- `app/supabase/functions/**`
- Supabase client call sites under `app/src/**`
- `app/scripts/migrate-firestore-to-supabase.mjs`

Do not treat this as a replacement for `app/supabase/schema.sql`. Use it as the human-readable checklist to compare a self-hosted Supabase server against the real application contract.

## Current object counts

- Public tables: 40
- SQL functions/RPC helpers: 18
- Reporting views: 9
- Explicit grant statements in `schema.sql`: 18
- Explicit policy templates: operator read/write policies for application tables, plus AI provider-key policies
- Realtime publication table: `public.season_change_events`
- Edge Functions: 3

## Runtime environment contract

Frontend/native runtime:

```env
NEXT_PUBLIC_REMOTE_BACKEND=supabase
NEXT_PUBLIC_SUPABASE_URL=https://<supabase-public-domain>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key>
```

Operator-only scripts:

```env
SUPABASE_URL=<supabase-public-domain>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Edge Function secrets used by current code:

```env
SUPABASE_URL=<injected by Supabase runtime or configured in self-host>
SUPABASE_ANON_KEY=<anon-or-publishable-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_CHAT_ID=<telegram-chat-or-channel-id>
DASHBOARD_AI_GEMINI_API_KEY=<gemini-key>
DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY=<openai-compatible-key>
DASHBOARD_AI_DEEPSEEK_API_KEY=<deepseek-key>
DASHBOARD_AI_MANAGEMENT_ACCESS_TOKEN=<management-token-for-key-rotation>
DASHBOARD_AI_PROJECT_REF=<project-ref-for-key-rotation>
```

Self-host URL notes:

- App code passes `NEXT_PUBLIC_SUPABASE_URL` directly to `createClient()`.
- Keep the app URL at the Supabase root, for example `https://supabase.ahtops.xyz`; the app builds `/rest/v1`, `/auth/v1`, and `/functions/v1` paths through `supabase-js` or `app/src/lib/supabase.ts`.
- The self-host gateway must expose Auth, REST/PostgREST, Realtime WebSocket, Storage if enabled later, and Functions under the same public URL.

## Auth and operator access

Authentication uses Supabase Auth email/password:

- `app/src/app/components/OperatorAuthGate.tsx` calls `supabase.auth.signInWithPassword()`.
- After sign-in, the app requires a matching row in `public.app_operators`.
- Authorization gate is `app_operators.user_id = auth.users.id`.
- `can_use_ai` permits local AI provider-key sync.
- `can_manage_ai` permits saving/syncing provider keys.

Required operator seed pattern:

```sql
insert into public.app_operators (user_id, email, can_manage_ai, can_use_ai)
select id, email, true, true
from auth.users
where email = '<operator-email>'
on conflict (user_id) do update
set email = excluded.email,
    can_manage_ai = excluded.can_manage_ai,
    can_use_ai = excluded.can_use_ai;
```

## Public table schema

### Access and seasons

#### `public.app_operators`

- Primary key: `user_id`
- Foreign key: `user_id references auth.users(id) on delete cascade`
- Columns:
  - `user_id uuid primary key`
  - `email text`
  - `can_manage_ai boolean not null default false`
  - `can_use_ai boolean not null default true`
  - `created_at timestamptz not null default now()`

#### `public.seasons`

- Primary key: `id`
- Unique index: `seasons_season_code_unique_idx on (season_code)`
- Columns:
  - `id text primary key default gen_random_uuid()::text`
  - `season_code text not null`
  - `name text not null default ''`
  - `file_name text not null default ''`
  - `uploaded_at bigint not null`
  - `effective_start text not null default ''`
  - `effective_end text not null default ''`
  - `total_legs integer not null default 0`
  - `total_source_rows integer not null default 0`
  - `data_version integer not null default 0`
  - `last_synced_at bigint`

### Imported source rows

#### `public.season_source_rows`

- Primary key: `(season_id, row_index)`
- Foreign key: `season_id references public.seasons(id) on delete cascade`
- Columns: `season_id`, `row_index`, `effective`, `discontinue`, `airline`, `aircraft`, `sta`, `arr_flight`, `arr_route`, `arr_category`, `arr_code_shares`, `arr_int_dom_ind`, `std`, `dep_flight`, `dep_route`, `dep_category`, `dep_code_shares`, `dep_int_dom_ind`, `overnight_link_row_index`, `link_type`
- `link_type` is `null`, `overnight`, or `sameday`.

#### `public.season_source_row_days`

- Primary key: `(season_id, row_index, iso_dow)`
- Foreign key: `(season_id, row_index) references public.season_source_rows(season_id, row_index) on delete cascade`
- Columns: `season_id`, `row_index`, `iso_dow integer not null check (iso_dow between 1 and 7)`

### Flight records and child tables

#### `public.season_flight_records`

- Primary key: `record_id`
- Foreign key: `season_id references public.seasons(id) on delete restrict`
- Important indexes:
  - `(season_id, operational_date, type, status, flight_number)`
  - `(operational_date, date, flight_number)`
  - `(iata_season_code, operational_date, flight_number)`
  - `(flight_series_id, operational_date)`
  - `(status, type, airline, route, aircraft, operational_date)`
- Columns: `season_id`, `record_id`, `link_id`, `type`, `airline`, `flight_number`, `raw_flight_number`, `request_status_code`, `route`, `schedule`, `aircraft`, `category`, `code_shares`, `int_dom_ind`, `pax`, `gate`, `stand`, `carousel`, `mct`, `fb`, `lb`, `bhs`, `ghs`, `date`, `scheduled_date`, `scheduled_time`, `operational_date`, `iata_season_code`, `flight_series_id`, `day_of_week`, `action`, `source_row_index`, `linked_source_row_index`, `link_type`, `pair_anchor_date`, `linked_record_id`, `source_kind`, `source_side`, `status`, `turnaround_id`
- Checks:
  - `type in ('A', 'D')`
  - `action is null or action in ('modified', 'added', 'deleted')`
  - `source_kind in ('imported', 'added')`
  - `source_side in ('ARR', 'DEP')`
  - `status in ('active', 'deleted')`

#### `public.season_flight_record_counters`

- Primary key: `(record_id, counter_group, item_index)`
- Foreign key: `record_id references public.season_flight_records(record_id) on delete cascade`
- Columns: `record_id`, `counter_group`, `item_index`, `counter_value`

#### `public.season_flight_record_checkin_windows`

- Primary key: `(record_id, counter_key)`
- Foreign key: `record_id references public.season_flight_records(record_id) on delete cascade`
- Columns: `record_id`, `counter_key`, `window_start`, `window_end`

### Modifications and history

#### `public.season_modifications`

- Primary key: `leg_id`
- Foreign key: `season_id references public.seasons(id) on delete restrict`
- Columns: `season_id`, `leg_id`, `action`, `changed_fields`, `schedule`, `aircraft`, `route`, `code_shares`, `pax`, `gate`, `stand`, `carousel`, `mct`, `fb`, `lb`, `bhs`, `ghs`, `check_in_start`, `check_in_end`, `check_in_allocation_mode`
- Checks:
  - `action in ('modified', 'deleted', 'added')`
  - `check_in_allocation_mode is null or check_in_allocation_mode in ('grouped', 'broken')`

#### `public.season_modification_counters`

- Primary key: `(leg_id, counter_group, item_index)`
- Foreign key: `leg_id references public.season_modifications(leg_id) on delete cascade`
- Columns: `leg_id`, `counter_group`, `item_index`, `counter_value`

#### `public.season_modification_checkin_windows`

- Primary key: `(leg_id, counter_key)`
- Foreign key: `leg_id references public.season_modifications(leg_id) on delete cascade`
- Columns: `leg_id`, `counter_key`, `window_start`, `window_end`

#### `public.season_modification_added_legs`

- Primary key: `leg_id`
- Foreign key: `leg_id references public.season_modifications(leg_id) on delete cascade`
- Foreign key: `season_id references public.seasons(id) on delete restrict`
- Columns mirror flight-record fields for added legs: `season_id`, `leg_id`, `record_id`, `link_id`, `type`, `airline`, `flight_number`, `raw_flight_number`, `request_status_code`, `route`, `schedule`, `aircraft`, `category`, `code_shares`, `int_dom_ind`, `pax`, `gate`, `stand`, `carousel`, `mct`, `fb`, `lb`, `bhs`, `ghs`, `date`, `scheduled_date`, `scheduled_time`, `operational_date`, `iata_season_code`, `flight_series_id`, `day_of_week`, `action`, `source_row_index`, `linked_source_row_index`, `link_type`, `pair_anchor_date`, `linked_record_id`, `source_kind`, `source_side`, `status`, `turnaround_id`

#### `public.season_mod_history_entries`

- Primary key: `entry_id`
- Foreign key: `season_id references public.seasons(id) on delete restrict`
- Columns: `season_id`, `entry_id`, `timestamp`, `description`

#### `public.season_mod_history_changes`

- Primary key: `(entry_id, change_index)`
- Foreign key: `entry_id references public.season_mod_history_entries(entry_id) on delete cascade`
- Columns: `entry_id`, `change_index`, `leg_id`, `previous_mod_snapshot jsonb`, `new_mod_snapshot jsonb`

#### `public.season_mod_history_record_changes`

- Primary key: `(entry_id, change_index)`
- Foreign key: `entry_id references public.season_mod_history_entries(entry_id) on delete cascade`
- Columns: `entry_id`, `change_index`, `record_id`, `previous_record_snapshot jsonb`, `new_record_snapshot jsonb`

### Sync, events, and notifications

#### `public.season_change_events`

- Primary key: `event_id`
- Unique: `(client_id, op_id)`
- Foreign keys:
  - `season_id references public.seasons(id) on delete restrict`
  - `actor_user_id references auth.users(id) on delete set null`
- Realtime: added to `supabase_realtime` publication
- Columns: `event_id`, `season_id`, `client_id`, `op_id`, `actor_user_id`, `server_seq generated always as identity`, `target_type`, `target_id`, `changed_fields`, `op_payload jsonb`, `created_at`

#### `public.season_entity_versions`

- Primary key: `(season_id, target_type, target_id)`
- Foreign key: `season_id references public.seasons(id) on delete cascade`
- Columns: `season_id`, `target_type`, `target_id`, `entity_version`, `field_versions jsonb`, `updated_by`, `updated_at`

#### `public.schedule_notification_deliveries`

- Primary key: `id`
- Unique: `(season_id, history_entry_id)`
- Foreign keys:
  - `season_id references public.seasons(id) on delete cascade`
  - `history_entry_id references public.season_mod_history_entries(entry_id) on delete cascade deferrable initially deferred`
  - `actor_user_id references auth.users(id) on delete set null`
- Columns: `id`, `season_id`, `history_entry_id`, `actor_user_id`, `module`, `payload jsonb`, `status`, `attempts`, `telegram_message_ids jsonb`, `error`, `created_at`, `updated_at`, `sent_at`
- Checks:
  - `module in ('seasonal', 'detailed')`
  - `status in ('pending', 'sending', 'sent', 'failed')`

### Operational settings

#### `public.operational_settings`

- Primary key: `id`
- Columns: `id default 'operational'`, `updated_at`, `ai_enabled`, `ai_active_model_id`, `ai_updated_at`

#### `public.operational_route_countries`

- Primary key: `route`
- Columns: `route`, `country`

#### `public.operational_airline_colors`

- Primary key: `airline_code`
- Columns: `airline_code`, `color`

#### `public.operational_aircraft_groups`

- Primary key: `id`
- Columns: `id`, `name`, `created_at`, `updated_at`

#### `public.operational_aircraft_group_types`

- Primary key: `(group_id, aircraft_type)`
- Foreign key: `group_id references public.operational_aircraft_groups(id) on delete cascade`
- Columns: `group_id`, `aircraft_type`

#### `public.operational_counter_rules`

- Primary key: `id`
- Columns: `id`, `name`, `enabled`, `priority_score`, `sort_order`, `condition_aircraft_types`, `condition_aircraft_groups`, `condition_airline_codes`, `counter_value`, `created_at`, `updated_at`

#### `public.operational_checkin_counters`

- Primary key: `id`
- Columns: `id`, `label`, `enabled`, `sort_order`, `created_at`, `updated_at`

#### `public.operational_checkin_counter_groups`

- Primary key: `id`
- Columns: `id`, `name`, `bhs`, `sort_order`, `created_at`, `updated_at`

#### `public.operational_checkin_counter_group_members`

- Primary key: `(group_id, counter_id)`
- Foreign key: `group_id references public.operational_checkin_counter_groups(id) on delete cascade`
- Columns: `group_id`, `counter_id`, `sort_order`

#### `public.operational_checkin_counter_locks`

- Primary key: `id`
- Columns: `id`, `name`, `start_time`, `end_time`, `reason`, `enabled`, `created_at`, `updated_at`

#### `public.operational_checkin_counter_lock_members`

- Primary key: `(lock_id, counter_id)`
- Foreign key: `lock_id references public.operational_checkin_counter_locks(id) on delete cascade`
- Columns: `lock_id`, `counter_id`, `sort_order`

#### `public.operational_gate_resources`

- Primary key: `id`
- Columns: `id`, `label`, `enabled`, `sort_order`, `created_at`, `updated_at`

#### `public.operational_gate_groups`

- Primary key: `id`
- Columns: `id`, `name`, `sort_order`, `created_at`, `updated_at`

#### `public.operational_gate_group_members`

- Primary key: `(group_id, gate_id)`
- Foreign key: `group_id references public.operational_gate_groups(id) on delete cascade`
- Columns: `group_id`, `gate_id`, `sort_order`

#### `public.operational_gate_locks`

- Primary key: `id`
- Columns: `id`, `name`, `start_time`, `end_time`, `reason`, `enabled`, `created_at`, `updated_at`

#### `public.operational_gate_lock_members`

- Primary key: `(lock_id, gate_id)`
- Foreign key: `lock_id references public.operational_gate_locks(id) on delete cascade`
- Columns: `lock_id`, `gate_id`, `sort_order`

#### `public.operational_stand_gate_mappings`

- Primary key: `id`
- Columns: `id`, `stand`, `gate`, `sort_order`, `enabled`, `created_at`, `updated_at`

### AI settings and synced provider keys

#### `public.operational_ai_models`

- Primary key: `id`
- Columns: `id`, `label`, `provider`, `model`, `base_url`, `enabled`, `key_updated_at`, `sort_order`
- `provider in ('gemini', 'openai-compatible', 'deepseek')`

#### `public.operational_ai_context_documents`

- Primary key: `id`
- Columns: `id`, `kind`, `title`, `content_md`, `enabled`, `sort_order`, `created_at`, `updated_at`
- `kind in ('rule', 'skill')`

#### `public.operational_ai_provider_keys`

- Primary key: `provider`
- Columns: `provider`, `secret_value`, `key_fingerprint`, `updated_at`, `updated_by`
- `provider in ('gemini', 'openai-compatible', 'deepseek')`
- This table has dedicated RLS policies:
  - AI users can read provider keys.
  - AI managers can insert/update/delete provider keys.

### Audit cache

#### `public.audit_sessions`

- Primary key: `id`
- Columns: `id`, `started_at`, `last_seen_at`, `payload jsonb`

#### `public.audit_entries`

- Primary key: `(session_id, id)`
- Foreign key: `session_id references public.audit_sessions(id) on delete cascade`
- Columns: `session_id`, `id`, `timestamp`, `payload jsonb`

#### `public.audit_delta_chunks`

- Primary key: `(session_id, entry_id, id)`
- Foreign key: `(session_id, entry_id) references public.audit_entries(session_id, id) on delete cascade`
- Columns: `session_id`, `entry_id`, `id`, `chunk_index`, `payload jsonb`

## SQL functions and RPC contract

All functions below are defined in `app/supabase/schema.sql`.

### Operator and AI-key authorization

#### `public.is_app_operator() returns boolean`

- Language: SQL
- Security: `security definer`
- Purpose: checks that `auth.uid()` exists in `public.app_operators`.
- Used by generic RLS policies for app tables.

#### `public.app_operator_can_use_ai() returns boolean`

- Language: SQL
- Security: `security definer`
- Purpose: true when the current Auth user has `can_use_ai = true` or `can_manage_ai = true`.
- Used by AI provider-key read policy and provider-key sync.

#### `public.app_operator_can_manage_ai() returns boolean`

- Language: SQL
- Security: `security definer`
- Purpose: true when the current Auth user has `can_manage_ai = true`.
- Used by AI provider-key mutation policy and provider-key sync.

#### `public.sync_ai_provider_key(p_provider text, p_secret_value text, p_key_fingerprint text, p_updated_at bigint) returns jsonb`

- Language: PL/pgSQL
- Security: `security definer`
- Grant: `authenticated`
- Client call: `app/src/lib/dashboardAiAdmin.ts`
- Purpose: upsert synced provider key into `operational_ai_provider_keys` after checking `can_manage_ai`.
- Returns JSON status; can return `operator_missing_can_manage_ai`.

#### `public.fetch_ai_provider_key(p_provider text) returns jsonb`

- Language: PL/pgSQL
- Security: `security definer`
- Grant: `authenticated`
- Client call: `app/src/lib/dashboardAiAdmin.ts`, native provider-key catchup path
- Purpose: read one provider key for local desktop AI runtime after checking `can_use_ai`.
- Returns JSON status; can return `operator_missing_can_use_ai`.

#### `public.list_ai_provider_key_status() returns jsonb`

- Language: PL/pgSQL
- Security: `security definer`
- Grant: `authenticated`
- Client call: `app/src/lib/dashboardAiAdmin.ts`
- Purpose: list provider key status/fingerprint without exposing raw secret.

### JSON conversion and upsert helpers

#### `public.jsonb_text_array(p_value jsonb) returns text[]`

- Language: SQL
- Purpose: converts JSON array payloads to `text[]`.
- Used by JSON upsert functions and sync functions.

#### `public.upsert_season_source_row_from_json(p_season_id text, row_payload jsonb) returns void`

- Language: PL/pgSQL
- Purpose: upserts source row payload and replaces day rows.

#### `public.upsert_season_flight_record_from_json(p_season_id text, record_payload jsonb) returns void`

- Language: PL/pgSQL
- Purpose: upserts imported flight records, counters, and check-in windows from JSON payloads.

#### `public.upsert_season_modification_from_json(p_season_id text, mod_payload jsonb) returns void`

- Language: PL/pgSQL
- Purpose: upserts modification rows, counters, check-in windows, and added-leg payloads.

#### `public.upsert_season_mod_history_from_json(p_season_id text, history_payload jsonb) returns void`

- Language: PL/pgSQL
- Purpose: upserts modification history entry plus related change rows.

#### `public.apply_workspace_op_json(p_season_id text, op jsonb) returns void`

- Language: PL/pgSQL
- Purpose: applies one legacy workspace operation payload.
- Used by `sync_season_workspace`.

### Season sync RPCs

#### `public.sync_season_workspace(p_season_id text, p_base_version integer, p_pending_ops jsonb) returns jsonb`

- Language: PL/pgSQL
- Grant: `authenticated`
- Client call: `app/src/lib/supabaseStore.ts`
- Purpose: legacy version-based sync path.
- Reads/writes:
  - `public.seasons.data_version`
  - season source rows
  - flight records
  - modifications
  - history

#### `public.get_season_event_high_water(p_season_id text) returns bigint`

- Language: SQL
- Grant: `authenticated`
- Client call: `app/src/lib/supabaseStore.ts`
- Purpose: returns max `server_seq` for a season from `season_change_events`.

#### `public.get_season_workspace_snapshot(p_season_id text, p_mod_history_limit integer default 50) returns jsonb`

- Language: PL/pgSQL
- Grant: `authenticated`
- Client call: `app/src/lib/supabaseStore.ts`
- Purpose: returns a full season workspace snapshot, including source rows, records, modifications, history, operational settings, and sync cursor data.

#### `public.get_season_change_event_page(p_season_id text, p_after_seq bigint, p_through_seq bigint, p_limit integer default 200) returns jsonb`

- Language: PL/pgSQL
- Grant: `authenticated`
- Client call: `app/src/lib/supabaseStore.ts`
- Purpose: paged catchup for event sync after `p_after_seq` through `p_through_seq`.

#### `public.sync_season_workspace_v2(p_season_id text, p_client_id text, p_base_server_seq bigint, p_pending_events jsonb) returns jsonb`

- Language: PL/pgSQL
- Grant: `authenticated`
- Client call: `app/src/lib/supabaseStore.ts`
- Purpose: event-based sync path.
- Writes `season_change_events`, updates `season_entity_versions`, and applies entity changes.
- This is the current durable multi-client sync contract.

### Notification trigger

#### `public.enqueue_schedule_notification_delivery() returns trigger`

- Language: PL/pgSQL
- Trigger: `season_change_events_schedule_notification_delivery`
- Purpose: creates pending `schedule_notification_deliveries` rows from relevant `season_change_events`.
- Downstream Edge Function: `schedule-telegram-notify`.

## RLS, grants, and exposed Data API

General application tables receive this policy template from the `table_names` loop in `schema.sql`:

```sql
alter table public.<table> enable row level security;

create policy "app operators can read"
on public.<table>
for select
to authenticated
using (public.is_app_operator());

create policy "app operators can write"
on public.<table>
for all
to authenticated
using (public.is_app_operator())
with check (public.is_app_operator());
```

Tables covered by the generic operator policy loop:

- `app_operators`
- `seasons`
- `season_source_rows`
- `season_source_row_days`
- `season_flight_records`
- `season_flight_record_counters`
- `season_flight_record_checkin_windows`
- `season_modifications`
- `season_modification_counters`
- `season_modification_checkin_windows`
- `season_modification_added_legs`
- `season_mod_history_entries`
- `season_mod_history_changes`
- `season_mod_history_record_changes`
- `season_change_events`
- `schedule_notification_deliveries`
- `season_entity_versions`
- `operational_settings`
- `operational_route_countries`
- `operational_airline_colors`
- `operational_aircraft_groups`
- `operational_aircraft_group_types`
- `operational_counter_rules`
- `operational_checkin_counters`
- `operational_checkin_counter_groups`
- `operational_checkin_counter_group_members`
- `operational_checkin_counter_locks`
- `operational_checkin_counter_lock_members`
- `operational_gate_resources`
- `operational_gate_groups`
- `operational_gate_group_members`
- `operational_gate_locks`
- `operational_gate_lock_members`
- `operational_stand_gate_mappings`
- `operational_ai_models`
- `operational_ai_context_documents`
- `audit_sessions`
- `audit_entries`
- `audit_delta_chunks`

`public.operational_ai_provider_keys` is intentionally separate and uses AI-specific policies.

Global grants expected by the app:

```sql
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;
```

Supabase's 2026 Data API change means backend should keep explicit grants in migrations. Do not rely on automatic table exposure for new objects.

## Reporting schema

Schema: `reporting`

Views:

- `reporting.flight_operations`
- `reporting.summary_airline`
- `reporting.summary_country`
- `reporting.summary_route`
- `reporting.summary_month`
- `reporting.summary_week`
- `reporting.summary_peak_hour`
- `reporting.summary_aircraft`
- `reporting.summary_arr_dep_mix`

All reporting views are set to `security_invoker = true` in `schema.sql`.

Reporting role:

```sql
create role seasonal_bi_reader nologin;
grant usage on schema reporting to seasonal_bi_reader;
grant select on all tables in schema reporting to seasonal_bi_reader;
```

Authenticated app users also get:

```sql
grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;
```

## Realtime contract

`schema.sql` adds:

```sql
alter publication supabase_realtime add table public.season_change_events;
```

Client call site:

- `app/src/lib/supabaseStore.ts` uses `.channel(\`season-change-events:${seasonId}\`)`
- It subscribes to `postgres_changes` for `public.season_change_events`

Self-host requirements:

- Realtime service must be enabled.
- Cloudflare/reverse proxy must support WebSocket upgrade for `/realtime/v1`.
- RLS and grants must allow the authenticated operator to read `season_change_events`.

## Edge Functions

Defined in `app/supabase/config.toml`.

### `dashboard-ai-analysis`

- Path: `app/supabase/functions/dashboard-ai-analysis/index.ts`
- `verify_jwt = true`
- Client call: `app/src/lib/dashboardAiAnalysis.ts` via `supabase.functions.invoke('dashboard-ai-analysis')`
- Reads Supabase with anon key/session auth.
- Uses reporting views and dashboard query logic.
- Required secrets:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `DASHBOARD_AI_GEMINI_API_KEY`
  - `DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY`
  - `DASHBOARD_AI_DEEPSEEK_API_KEY`

### `rotate-dashboard-ai-key`

- Path: `app/supabase/functions/rotate-dashboard-ai-key/index.ts`
- `verify_jwt = true`
- Current UI avoids direct `functions.invoke('rotate-dashboard-ai-key')`; provider-key sync mainly uses SQL RPCs in `dashboardAiAdmin.ts`.
- Function still exists and should either be deployed or intentionally retired.
- Checks `public.app_operators.can_manage_ai`.
- Required secrets:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `DASHBOARD_AI_MANAGEMENT_ACCESS_TOKEN`
  - `DASHBOARD_AI_PROJECT_REF`
  - provider env names mapped by function: `DASHBOARD_AI_GEMINI_API_KEY`, `DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY`, `DASHBOARD_AI_DEEPSEEK_API_KEY`

### `schedule-telegram-notify`

- Path: `app/supabase/functions/schedule-telegram-notify/index.ts`
- `verify_jwt = true`
- Configured import map: `app/supabase/functions/schedule-telegram-notify/deno.json`
- Client call: `app/src/lib/supabaseStore.ts` via `invokeSupabaseFunction('schedule-telegram-notify')`
- Reads and updates `schedule_notification_deliveries`.
- Required secrets:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEYS.default`
  - `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEYS.default`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`

## Client-side Supabase table usage

Primary client module: `app/src/lib/supabase.ts`

- `createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY)`
- custom fetch wrapper: `boundSupabaseFetch`
- manual Edge Function invoker: `invokeSupabaseFunction()`

Primary store module: `app/src/lib/supabaseStore.ts`

Directly accessed tables:

- `seasons`
- `season_source_rows`
- `season_source_row_days`
- `season_flight_records`
- `season_flight_record_counters`
- `season_flight_record_checkin_windows`
- `season_modifications`
- `season_modification_counters`
- `season_modification_checkin_windows`
- `season_modification_added_legs`
- `season_mod_history_entries`
- `season_mod_history_changes`
- `season_mod_history_record_changes`
- `season_change_events`
- `schedule_notification_deliveries`
- `season_entity_versions`
- all `operational_*` tables listed above
- `audit_sessions`
- `audit_entries`
- `audit_delta_chunks`

RPC calls:

- `sync_season_workspace`
- `sync_season_workspace_v2`
- `get_season_event_high_water`
- `get_season_workspace_snapshot`
- `get_season_change_event_page`
- `sync_ai_provider_key`
- `fetch_ai_provider_key`
- `list_ai_provider_key_status`

## Migration and cutover comparison checklist

Backend should verify all of these on the new server:

1. `pgcrypto` extension exists.
2. `auth.users` exists and Supabase Auth is reachable.
3. All 40 public tables exist.
4. All primary keys, unique constraints, checks, and foreign keys above exist.
5. All 18 functions exist with matching signatures.
6. `reporting` schema exists with all 9 views.
7. Reporting views have `security_invoker = true`.
8. `seasonal_bi_reader` role exists if BI access is required.
9. RLS is enabled for all app tables.
10. Generic app-operator policies exist for the listed application tables.
11. AI provider-key table has its dedicated policies.
12. Authenticated role has explicit public/reporting grants.
13. `public.season_change_events` is in the `supabase_realtime` publication.
14. Edge Functions are deployed with `verify_jwt = true`.
15. Function secrets are present.
16. At least one Auth user has a matching `public.app_operators` row.
17. The app can sign in, read `app_operators`, create/load a season, sync workspace v2, receive Realtime events, and invoke deployed Edge Functions.

## Smoke SQL for backend comparison

Use a privileged SQL session for object checks:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'reporting')
order by table_schema, table_name;

select routine_schema, routine_name, data_type
from information_schema.routines
where routine_schema = 'public'
order by routine_name;

select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;

select pubname, schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename = 'season_change_events';
```

Use an authenticated operator session for application checks:

```sql
select public.is_app_operator();
select public.app_operator_can_use_ai();
select public.app_operator_can_manage_ai();
select public.get_season_event_high_water('<season-id>');
```

## Notes for self-hosted Supabase cutover

- Regenerate production JWT/API keys; do not keep default/demo keys.
- Keep explicit grants in migration SQL because newer Supabase behavior no longer guarantees automatic Data API exposure for new public tables.
- Avoid putting `SUPABASE_SERVICE_ROLE_KEY` in any `NEXT_PUBLIC_*` variable or frontend bundle.
- If using Cloudflare Tunnel, verify WebSocket support for Realtime before cutover.
- If using the desktop app, `dashboard-ai-agent.exe` is local on `127.0.0.1:8765`; it is separate from Supabase. Supabase only controls provider-key sync and remote data.
