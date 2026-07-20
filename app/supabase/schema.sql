create extension if not exists pgcrypto;

-- Clean-start relational cutover.
-- This intentionally removes old app data/schema so a brand-new flight schedule can be uploaded.
-- Operator access rows are preserved in public.app_operators.
drop schema if exists reporting cascade;
drop function if exists public.sync_season_workspace(text, integer, jsonb) cascade;
drop function if exists public.sync_season_workspace_v2(text, text, bigint, jsonb) cascade;
drop function if exists public.apply_workspace_op_json(text, jsonb) cascade;
drop function if exists public.upsert_season_source_row_from_json(text, jsonb) cascade;
drop function if exists public.upsert_season_flight_record_from_json(text, jsonb) cascade;
drop function if exists public.upsert_season_modification_from_json(text, jsonb) cascade;
drop function if exists public.upsert_season_mod_history_from_json(text, jsonb) cascade;
drop function if exists public.enqueue_schedule_notification_delivery() cascade;
drop function if exists public.jsonb_text_array(jsonb) cascade;
drop table if exists public.audit_delta_chunks cascade;
drop table if exists public.audit_entries cascade;
drop table if exists public.audit_sessions cascade;
drop table if exists public.schedule_notification_deliveries cascade;
drop table if exists public.season_mod_history_record_changes cascade;
drop table if exists public.season_mod_history_changes cascade;
drop table if exists public.season_mod_history_entries cascade;
drop table if exists public.season_mod_history cascade;
drop table if exists public.season_modification_added_legs cascade;
drop table if exists public.season_modification_checkin_windows cascade;
drop table if exists public.season_modification_counters cascade;
drop table if exists public.season_modifications cascade;
drop table if exists public.season_flight_record_checkin_windows cascade;
drop table if exists public.season_flight_record_counters cascade;
drop table if exists public.season_flight_records cascade;
drop table if exists public.season_source_row_days cascade;
drop table if exists public.season_source_rows cascade;
drop table if exists public.season_change_events cascade;
drop table if exists public.season_entity_versions cascade;
drop table if exists public.seasons cascade;
drop table if exists public.operational_ai_context_documents cascade;
drop table if exists public.operational_ai_provider_keys cascade;
drop table if exists public.operational_ai_models cascade;
drop table if exists public.operational_stand_gate_mappings cascade;
drop table if exists public.operational_gate_lock_members cascade;
drop table if exists public.operational_gate_locks cascade;
drop table if exists public.operational_gate_group_members cascade;
drop table if exists public.operational_gate_groups cascade;
drop table if exists public.operational_gate_resources cascade;
drop table if exists public.operational_checkin_counter_lock_members cascade;
drop table if exists public.operational_checkin_counter_locks cascade;
drop table if exists public.operational_checkin_counter_group_members cascade;
drop table if exists public.operational_checkin_counter_groups cascade;
drop table if exists public.operational_checkin_counters cascade;
drop table if exists public.operational_counter_rules cascade;
drop table if exists public.operational_aircraft_group_types cascade;
drop table if exists public.operational_aircraft_groups cascade;
drop table if exists public.operational_airline_colors cascade;
drop table if exists public.operational_route_countries cascade;
drop table if exists public.operational_settings cascade;

create table if not exists public.app_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  display_name text,
  can_manage_ai boolean not null default false,
  can_use_ai boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_operators'
      and column_name = 'can_manage_ai'
  ) then
    update public.app_operators
    set can_manage_ai = true
    where can_manage_ai is false;
  else
    alter table public.app_operators add column can_manage_ai boolean not null default false;
    update public.app_operators
    set can_manage_ai = true;
  end if;
end $$;

alter table public.app_operators
  add column if not exists can_use_ai boolean not null default true;

alter table public.app_operators
  alter column can_use_ai set default true;

update public.app_operators
set can_use_ai = true
where can_use_ai is false;

alter table public.app_operators
  add column if not exists username text,
  add column if not exists display_name text;

create unique index if not exists app_operators_username_unique
  on public.app_operators (lower(username))
  where username is not null;

create or replace function public.app_operator_known_permission_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'dashboard.read',
    'seasonal.read',
    'seasonal.write',
    'detailed.read',
    'detailed.write',
    'daily.read',
    'daily.write',
    'checkin.read',
    'checkin.write',
    'gate.read',
    'gate.write',
    'settings.manage',
    'ai.use',
    'ai.manage',
    'audit.read',
    'users.manage',
    'roles.manage',
    'season.repair',
    'updates.manage',
    'diagnostics.read'
  ]::text[]
$$;

create table if not exists public.app_roles (
  id text primary key check (id ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text not null default '',
  is_system boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.app_role_permissions (
  role_id text not null references public.app_roles(id) on delete cascade,
  permission_key text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists public.app_operator_roles (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  role_id text not null references public.app_roles(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table if not exists public.app_operator_permission_overrides (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  permission_key text not null,
  effect text not null check (effect in ('allow', 'deny')),
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);

insert into public.app_roles (id, name, description, is_system)
values
  ('super_admin', 'Super Admin', 'Full system owner.', true),
  ('ops_admin', 'Ops Admin', 'Daily operations administrator.', true),
  ('schedule_planner', 'Schedule Planner', 'Seasonal, Detailed, and Daily schedule editor.', true),
  ('resource_coordinator', 'Resource Coordinator', 'Check-in and Gate allocation editor.', true),
  ('viewer', 'Viewer', 'Read-only operator.', true)
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    is_system = excluded.is_system;

delete from public.app_role_permissions
where role_id in ('super_admin', 'ops_admin', 'schedule_planner', 'resource_coordinator', 'viewer');

with seeded_permissions(role_id, permission_key) as (
  values
    ('viewer', 'dashboard.read'),
    ('viewer', 'seasonal.read'),
    ('viewer', 'detailed.read'),
    ('viewer', 'daily.read'),
    ('viewer', 'checkin.read'),
    ('viewer', 'gate.read'),
    ('resource_coordinator', 'dashboard.read'),
    ('resource_coordinator', 'seasonal.read'),
    ('resource_coordinator', 'detailed.read'),
    ('resource_coordinator', 'daily.read'),
    ('resource_coordinator', 'checkin.read'),
    ('resource_coordinator', 'checkin.write'),
    ('resource_coordinator', 'gate.read'),
    ('resource_coordinator', 'gate.write'),
    ('schedule_planner', 'dashboard.read'),
    ('schedule_planner', 'seasonal.read'),
    ('schedule_planner', 'seasonal.write'),
    ('schedule_planner', 'detailed.read'),
    ('schedule_planner', 'detailed.write'),
    ('schedule_planner', 'daily.read'),
    ('schedule_planner', 'daily.write'),
    ('schedule_planner', 'checkin.read'),
    ('schedule_planner', 'gate.read'),
    ('ops_admin', 'dashboard.read'),
    ('ops_admin', 'seasonal.read'),
    ('ops_admin', 'seasonal.write'),
    ('ops_admin', 'detailed.read'),
    ('ops_admin', 'detailed.write'),
    ('ops_admin', 'daily.read'),
    ('ops_admin', 'daily.write'),
    ('ops_admin', 'checkin.read'),
    ('ops_admin', 'checkin.write'),
    ('ops_admin', 'gate.read'),
    ('ops_admin', 'gate.write'),
    ('ops_admin', 'settings.manage'),
    ('ops_admin', 'audit.read'),
    ('ops_admin', 'users.manage'),
    ('ops_admin', 'diagnostics.read')
)
insert into public.app_role_permissions (role_id, permission_key)
select role_id, permission_key
from seeded_permissions
on conflict do nothing;

insert into public.app_role_permissions (role_id, permission_key)
select 'super_admin', unnest(public.app_operator_known_permission_keys())
on conflict do nothing;

insert into public.app_operator_roles (user_id, role_id)
select user_id, 'super_admin'
from public.app_operators
where lower(coalesce(username, '')) = 'admin'
   or lower(coalesce(email, '')) = 'admin@operators.local.ahtops'
on conflict do nothing;

insert into public.app_operator_roles (user_id, role_id)
select operators.user_id, 'ops_admin'
from public.app_operators operators
where not exists (
  select 1
  from public.app_operator_roles existing_roles
  where existing_roles.user_id = operators.user_id
)
on conflict do nothing;

create or replace function public.is_app_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_operators where user_id = auth.uid())
$$;

create or replace function public.app_operator_has_permission_for(p_user_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with operator_row as (
    select can_manage_ai, can_use_ai
    from public.app_operators
    where user_id = p_user_id
  )
  select case
    when p_user_id is null then false
    when not exists (select 1 from operator_row) then false
    when exists (
      select 1
      from public.app_operator_permission_overrides overrides
      where overrides.user_id = p_user_id
        and overrides.permission_key = p_permission_key
        and overrides.effect = 'deny'
    ) then false
    when exists (
      select 1
      from public.app_operator_permission_overrides overrides
      where overrides.user_id = p_user_id
        and overrides.permission_key = p_permission_key
        and overrides.effect = 'allow'
    ) then true
    when p_permission_key = 'ai.manage'
      and exists (select 1 from operator_row where can_manage_ai is true)
    then true
    when p_permission_key = 'ai.use'
      and exists (select 1 from operator_row where can_use_ai is true or can_manage_ai is true)
    then true
    when exists (
      select 1
      from public.app_operator_roles roles
      where roles.user_id = p_user_id
        and roles.role_id = 'super_admin'
    ) and p_permission_key = any(public.app_operator_known_permission_keys()) then true
    when exists (
      select 1
      from public.app_operator_roles roles
      join public.app_role_permissions permissions on permissions.role_id = roles.role_id
      where roles.user_id = p_user_id
        and permissions.permission_key = p_permission_key
    ) then true
    else false
  end
$$;

create or replace function public.app_operator_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission_for(auth.uid(), p_permission_key)
$$;

create or replace function public.app_operator_can_use_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission('ai.use')
$$;

create or replace function public.app_operator_can_manage_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_operator_has_permission('ai.manage')
$$;

create table if not exists public.seasons (
  id text primary key default gen_random_uuid()::text,
  season_code text not null,
  name text not null default '',
  file_name text not null default '',
  uploaded_at bigint not null,
  effective_start text not null default '',
  effective_end text not null default '',
  total_legs integer not null default 0,
  total_source_rows integer not null default 0,
  data_version integer not null default 0,
  last_synced_at bigint
);

create table if not exists public.season_source_rows (
  season_id text not null references public.seasons(id) on delete cascade,
  row_index integer not null,
  effective text not null default '',
  discontinue text not null default '',
  airline text not null default '',
  aircraft text not null default '',
  sta text,
  arr_flight text,
  arr_route text,
  arr_category text,
  arr_code_shares text,
  arr_int_dom_ind text,
  std text,
  dep_flight text,
  dep_route text,
  dep_category text,
  dep_code_shares text,
  dep_int_dom_ind text,
  overnight_link_row_index integer,
  link_type text check (link_type is null or link_type in ('overnight', 'sameday')),
  primary key (season_id, row_index)
);

create table if not exists public.season_source_row_days (
  season_id text not null,
  row_index integer not null,
  iso_dow integer not null check (iso_dow between 1 and 7),
  primary key (season_id, row_index, iso_dow),
  foreign key (season_id, row_index) references public.season_source_rows(season_id, row_index) on delete cascade
);

create table if not exists public.season_flight_records (
  season_id text not null references public.seasons(id) on delete restrict,
  record_id text primary key,
  link_id text not null default '',
  type text not null check (type in ('A', 'D')),
  airline text not null default '',
  flight_number text not null default '',
  raw_flight_number text not null default '',
  request_status_code text,
  route text not null default '',
  schedule text not null default '',
  aircraft text not null default '',
  category text not null default '',
  code_shares text,
  int_dom_ind text,
  pax integer,
  gate integer,
  stand integer,
  carousel integer,
  mct text,
  fb text,
  lb text,
  bhs text,
  ghs text,
  date text not null default '',
  scheduled_date text,
  scheduled_time text,
  operational_date text,
  iata_season_code text,
  flight_series_id text,
  day_of_week integer not null default 0,
  action text check (action is null or action in ('modified', 'added', 'deleted')),
  source_row_index integer not null default 0,
  linked_source_row_index integer,
  link_type text check (link_type is null or link_type in ('overnight', 'sameday')),
  pair_anchor_date text,
  linked_record_id text,
  source_kind text not null default 'imported' check (source_kind in ('imported', 'added')),
  source_side text not null default 'ARR' check (source_side in ('ARR', 'DEP')),
  status text not null default 'active' check (status in ('active', 'deleted')),
  turnaround_id text
);

create table if not exists public.season_flight_record_counters (
  record_id text not null,
  counter_group text not null default '__single__',
  item_index integer not null default 0,
  counter_value text not null,
  primary key (record_id, counter_group, item_index),
  foreign key (record_id) references public.season_flight_records(record_id) on delete cascade
);

create table if not exists public.season_flight_record_checkin_windows (
  record_id text not null,
  counter_key text not null,
  window_start text not null,
  window_end text not null,
  primary key (record_id, counter_key),
  foreign key (record_id) references public.season_flight_records(record_id) on delete cascade
);

create table if not exists public.season_modifications (
  season_id text not null references public.seasons(id) on delete restrict,
  leg_id text primary key,
  action text not null check (action in ('modified', 'deleted', 'added')),
  changed_fields text[] not null default '{}',
  schedule text,
  aircraft text,
  route text,
  code_shares text,
  pax integer,
  gate integer,
  stand integer,
  carousel integer,
  mct text,
  fb text,
  lb text,
  bhs text,
  ghs text,
  check_in_start text,
  check_in_end text,
  check_in_allocation_mode text check (check_in_allocation_mode is null or check_in_allocation_mode in ('grouped', 'broken'))
);

create table if not exists public.season_modification_counters (
  leg_id text not null,
  counter_group text not null default '__single__',
  item_index integer not null default 0,
  counter_value text not null,
  primary key (leg_id, counter_group, item_index),
  foreign key (leg_id) references public.season_modifications(leg_id) on delete cascade
);

create table if not exists public.season_modification_checkin_windows (
  leg_id text not null,
  counter_key text not null,
  window_start text not null,
  window_end text not null,
  primary key (leg_id, counter_key),
  foreign key (leg_id) references public.season_modifications(leg_id) on delete cascade
);

create table if not exists public.season_modification_added_legs (
  season_id text not null references public.seasons(id) on delete restrict,
  leg_id text primary key,
  record_id text not null,
  link_id text not null default '',
  type text not null check (type in ('A', 'D')),
  airline text not null default '',
  flight_number text not null default '',
  raw_flight_number text not null default '',
  request_status_code text,
  route text not null default '',
  schedule text not null default '',
  aircraft text not null default '',
  category text not null default '',
  code_shares text,
  int_dom_ind text,
  pax integer,
  gate integer,
  stand integer,
  carousel integer,
  mct text,
  fb text,
  lb text,
  bhs text,
  ghs text,
  date text not null default '',
  scheduled_date text,
  scheduled_time text,
  operational_date text,
  iata_season_code text,
  flight_series_id text,
  day_of_week integer not null default 0,
  action text check (action is null or action in ('modified', 'added', 'deleted')),
  source_row_index integer not null default 0,
  linked_source_row_index integer,
  link_type text check (link_type is null or link_type in ('overnight', 'sameday')),
  pair_anchor_date text,
  linked_record_id text,
  source_kind text not null default 'added' check (source_kind in ('imported', 'added')),
  source_side text not null default 'ARR' check (source_side in ('ARR', 'DEP')),
  status text not null default 'active' check (status in ('active', 'deleted')),
  turnaround_id text,
  foreign key (leg_id) references public.season_modifications(leg_id) on delete cascade
);

create table if not exists public.season_mod_history_entries (
  season_id text not null references public.seasons(id) on delete restrict,
  entry_id text primary key,
  timestamp bigint not null,
  description text not null default ''
);

create table if not exists public.season_mod_history_changes (
  entry_id text not null,
  change_index integer not null,
  leg_id text not null,
  previous_mod_snapshot jsonb,
  new_mod_snapshot jsonb not null,
  primary key (entry_id, change_index),
  foreign key (entry_id) references public.season_mod_history_entries(entry_id) on delete cascade
);

create table if not exists public.season_mod_history_record_changes (
  entry_id text not null,
  change_index integer not null,
  record_id text not null,
  previous_record_snapshot jsonb,
  new_record_snapshot jsonb,
  primary key (entry_id, change_index),
  foreign key (entry_id) references public.season_mod_history_entries(entry_id) on delete cascade
);

create table if not exists public.season_change_events (
  event_id text primary key default gen_random_uuid()::text,
  season_id text not null references public.seasons(id) on delete restrict,
  client_id text not null,
  op_id text,
  actor_user_id uuid references auth.users(id) on delete set null,
  server_seq bigint generated always as identity,
  target_type text not null,
  target_id text not null,
  changed_fields text[] not null default '{}',
  op_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, op_id)
);

create table if not exists public.schedule_notification_deliveries (
  id text primary key,
  season_id text not null references public.seasons(id) on delete cascade,
  history_entry_id text not null references public.season_mod_history_entries(entry_id) on delete cascade deferrable initially deferred,
  actor_user_id uuid references auth.users(id) on delete set null,
  module text not null check (module in ('seasonal', 'detailed')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  telegram_message_ids jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (season_id, history_entry_id)
);

create table if not exists public.season_entity_versions (
  season_id text not null references public.seasons(id) on delete cascade,
  target_type text not null,
  target_id text not null,
  entity_version bigint not null default 0,
  field_versions jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (season_id, target_type, target_id)
);

create table if not exists public.operational_settings (
  id text primary key default 'operational',
  updated_at bigint,
  ai_enabled boolean not null default true,
  ai_active_model_id text,
  ai_updated_at bigint,
  dashboard_arrival_bucket_flights integer,
  dashboard_departure_bucket_flights integer,
  dashboard_ad_gap_flights integer,
  dashboard_ctg_abs_pct numeric,
  dashboard_pax_coverage_min_pct numeric
);

create table if not exists public.operational_route_countries (
  route text primary key,
  country text not null
);

create table if not exists public.operational_airline_colors (
  airline_code text primary key,
  color text not null
);

create table if not exists public.operational_aircraft_groups (
  id text primary key,
  name text not null,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_aircraft_group_types (
  group_id text not null references public.operational_aircraft_groups(id) on delete cascade,
  aircraft_type text not null,
  primary key (group_id, aircraft_type)
);

create table if not exists public.operational_counter_rules (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  priority_score integer not null default 0,
  sort_order integer not null default 0,
  condition_aircraft_types text[] not null default '{}',
  condition_aircraft_groups text[] not null default '{}',
  condition_airline_codes text[] not null default '{}',
  counter_value integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_checkin_counters (
  id text primary key,
  label text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_checkin_counter_groups (
  id text primary key,
  name text not null,
  bhs text not null default '',
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_checkin_counter_group_members (
  group_id text not null references public.operational_checkin_counter_groups(id) on delete cascade,
  counter_id text not null,
  sort_order integer not null default 0,
  primary key (group_id, counter_id)
);

create table if not exists public.operational_checkin_counter_locks (
  id text primary key,
  name text not null,
  start_time text not null,
  end_time text not null,
  reason text,
  enabled boolean not null default true,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_checkin_counter_lock_members (
  lock_id text not null references public.operational_checkin_counter_locks(id) on delete cascade,
  counter_id text not null,
  sort_order integer not null default 0,
  primary key (lock_id, counter_id)
);

create table if not exists public.operational_gate_resources (
  id text primary key,
  label text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_gate_groups (
  id text primary key,
  name text not null,
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_gate_group_members (
  group_id text not null references public.operational_gate_groups(id) on delete cascade,
  gate_id text not null,
  sort_order integer not null default 0,
  primary key (group_id, gate_id)
);

create table if not exists public.operational_gate_locks (
  id text primary key,
  name text not null,
  start_time text not null,
  end_time text not null,
  reason text,
  enabled boolean not null default true,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_gate_lock_members (
  lock_id text not null references public.operational_gate_locks(id) on delete cascade,
  gate_id text not null,
  sort_order integer not null default 0,
  primary key (lock_id, gate_id)
);

create table if not exists public.operational_stand_gate_mappings (
  id text primary key,
  stand integer not null,
  gate integer not null,
  sort_order integer not null default 0,
  enabled boolean not null default true,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_ai_models (
  id text primary key,
  label text not null,
  provider text not null check (provider in ('gemini', 'openai-compatible', 'deepseek')),
  model text not null,
  base_url text,
  enabled boolean not null default true,
  key_updated_at bigint,
  sort_order integer not null default 0
);

create table if not exists public.operational_ai_context_documents (
  id text primary key,
  kind text not null check (kind in ('rule', 'skill')),
  title text not null,
  content_md text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create table if not exists public.operational_ai_provider_keys (
  provider text primary key check (provider in ('gemini', 'openai-compatible', 'deepseek')),
  secret_value text not null,
  key_fingerprint text not null,
  updated_at bigint not null default 0,
  updated_by uuid references auth.users(id) on delete set null
);

create or replace function public.sync_ai_provider_key(
  p_provider text,
  p_secret_value text,
  p_key_fingerprint text,
  p_updated_at bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text := lower(trim(coalesce(p_provider, '')));
  normalized_secret text := trim(coalesce(p_secret_value, ''));
  normalized_fingerprint text := trim(coalesce(p_key_fingerprint, ''));
  effective_updated_at bigint := coalesce(p_updated_at, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
begin
  if not public.app_operator_can_manage_ai() then
    return jsonb_build_object('ok', false, 'reason', 'operator_missing_can_manage_ai');
  end if;

  if normalized_provider not in ('gemini', 'openai-compatible', 'deepseek') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_provider');
  end if;

  if normalized_secret = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty_secret');
  end if;

  insert into public.operational_ai_provider_keys (
    provider,
    secret_value,
    key_fingerprint,
    updated_at,
    updated_by
  )
  values (
    normalized_provider,
    normalized_secret,
    coalesce(nullif(normalized_fingerprint, ''), 'unknown'),
    effective_updated_at,
    auth.uid()
  )
  on conflict (provider) do update
  set secret_value = excluded.secret_value,
      key_fingerprint = excluded.key_fingerprint,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  return jsonb_build_object(
    'ok', true,
    'provider', normalized_provider,
    'keyFingerprint', coalesce(nullif(normalized_fingerprint, ''), 'unknown'),
    'keyUpdatedAt', effective_updated_at,
    'updatedBy', auth.uid()
  );
end;
$$;

create or replace function public.fetch_ai_provider_key(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text := lower(trim(coalesce(p_provider, '')));
  key_row public.operational_ai_provider_keys%rowtype;
begin
  if not public.app_operator_can_use_ai() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'operator_missing_can_use_ai',
      'provider', normalized_provider
    );
  end if;

  if normalized_provider not in ('gemini', 'openai-compatible', 'deepseek') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_provider',
      'provider', normalized_provider
    );
  end if;

  select *
  into key_row
  from public.operational_ai_provider_keys
  where provider = normalized_provider;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_key_not_synced',
      'provider', normalized_provider
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'provider', key_row.provider,
    'secretValue', key_row.secret_value,
    'keyFingerprint', key_row.key_fingerprint,
    'keyUpdatedAt', key_row.updated_at,
    'updatedBy', key_row.updated_by
  );
end;
$$;

create or replace function public.list_ai_provider_key_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_operator_can_use_ai() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'operator_missing_can_use_ai',
      'items', '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'items',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'keyFingerprint', key_fingerprint,
        'keyUpdatedAt', updated_at,
        'updatedBy', updated_by
      ) order by provider)
      from public.operational_ai_provider_keys
    ), '[]'::jsonb)
  );
end;
$$;

create table if not exists public.audit_sessions (
  id text primary key,
  started_at bigint not null,
  last_seen_at bigint not null,
  payload jsonb not null
);

create table if not exists public.audit_entries (
  session_id text not null references public.audit_sessions(id) on delete cascade,
  id text not null,
  timestamp bigint not null,
  payload jsonb not null,
  primary key (session_id, id)
);

create table if not exists public.audit_delta_chunks (
  session_id text not null,
  entry_id text not null,
  id text not null,
  chunk_index integer not null,
  payload jsonb not null,
  primary key (session_id, entry_id, id),
  foreign key (session_id, entry_id) references public.audit_entries(session_id, id) on delete cascade
);

alter table public.seasons enable row level security;

create index if not exists seasons_uploaded_at_idx on public.seasons (uploaded_at desc);
create index if not exists seasons_season_code_idx on public.seasons (season_code);
create unique index if not exists seasons_season_code_unique_idx on public.seasons (season_code);
create index if not exists season_source_rows_season_idx on public.season_source_rows (season_id, row_index);
create index if not exists season_flight_records_season_operational_idx on public.season_flight_records (season_id, operational_date, type, status, flight_number);
create index if not exists season_flight_records_date_idx on public.season_flight_records (operational_date, date, flight_number);
create index if not exists season_flight_records_iata_idx on public.season_flight_records (iata_season_code, operational_date, flight_number);
create index if not exists season_flight_records_series_idx on public.season_flight_records (flight_series_id, operational_date);
create index if not exists season_flight_records_reporting_idx on public.season_flight_records (status, type, airline, route, aircraft, operational_date);
create index if not exists season_mod_history_timestamp_idx on public.season_mod_history_entries (season_id, timestamp desc);
create index if not exists season_change_events_seq_idx on public.season_change_events (season_id, server_seq);
create index if not exists season_change_events_target_idx on public.season_change_events (target_type, target_id);
create index if not exists schedule_notification_deliveries_status_idx on public.schedule_notification_deliveries (status, created_at);
create index if not exists schedule_notification_deliveries_season_idx on public.schedule_notification_deliveries (season_id, created_at);
create index if not exists season_entity_versions_target_idx on public.season_entity_versions (season_id, target_type, target_id);
create index if not exists audit_sessions_last_seen_at_idx on public.audit_sessions (last_seen_at desc);
create index if not exists audit_entries_timestamp_idx on public.audit_entries (session_id, timestamp desc);
create index if not exists audit_delta_chunks_order_idx on public.audit_delta_chunks (session_id, entry_id, chunk_index);

alter table public.operational_ai_provider_keys enable row level security;

drop policy if exists "app operators can read" on public.operational_ai_provider_keys;
drop policy if exists "app operators can write" on public.operational_ai_provider_keys;
drop policy if exists "ai users can read provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can insert provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can update provider keys" on public.operational_ai_provider_keys;
drop policy if exists "ai managers can delete provider keys" on public.operational_ai_provider_keys;

create policy "ai users can read provider keys"
  on public.operational_ai_provider_keys
  for select
  to authenticated
  using (public.app_operator_can_use_ai());

create policy "ai managers can insert provider keys"
  on public.operational_ai_provider_keys
  for insert
  to authenticated
  with check (public.app_operator_can_manage_ai());

create policy "ai managers can update provider keys"
  on public.operational_ai_provider_keys
  for update
  to authenticated
  using (public.app_operator_can_manage_ai())
  with check (public.app_operator_can_manage_ai());

create policy "ai managers can delete provider keys"
  on public.operational_ai_provider_keys
  for delete
  to authenticated
  using (public.app_operator_can_manage_ai());

create or replace function public.jsonb_text_array(p_value jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(value), '{}') from jsonb_array_elements_text(coalesce(p_value, '[]'::jsonb))
$$;

create or replace function public.upsert_season_source_row_from_json(p_season_id text, row_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row_index integer := (row_payload->>'rowIndex')::integer;
  v_day jsonb;
  v_index integer := 0;
begin
  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft, sta, arr_flight, arr_route,
    arr_category, arr_code_shares, arr_int_dom_ind, std, dep_flight, dep_route, dep_category,
    dep_code_shares, dep_int_dom_ind, overnight_link_row_index, link_type
  )
  values (
    p_season_id, v_row_index, coalesce(row_payload->>'effective', ''), coalesce(row_payload->>'discontinue', ''),
    coalesce(row_payload->>'airline', ''), coalesce(row_payload->>'aircraft', ''), row_payload->>'sta',
    row_payload->>'arrFlight', row_payload->>'arrRoute', row_payload->>'arrFlightCategory',
    row_payload->>'arrCodeShares', row_payload->>'arrIntDomInd', row_payload->>'std',
    row_payload->>'depFlight', row_payload->>'depRoute', row_payload->>'depFlightCategory',
    row_payload->>'depCodeShares', row_payload->>'depIntDomInd',
    nullif(row_payload->>'overnightLinkRowIndex', '')::integer, row_payload->>'linkType'
  )
  on conflict (season_id, row_index) do update set
    effective = excluded.effective,
    discontinue = excluded.discontinue,
    airline = excluded.airline,
    aircraft = excluded.aircraft,
    sta = excluded.sta,
    arr_flight = excluded.arr_flight,
    arr_route = excluded.arr_route,
    arr_category = excluded.arr_category,
    arr_code_shares = excluded.arr_code_shares,
    arr_int_dom_ind = excluded.arr_int_dom_ind,
    std = excluded.std,
    dep_flight = excluded.dep_flight,
    dep_route = excluded.dep_route,
    dep_category = excluded.dep_category,
    dep_code_shares = excluded.dep_code_shares,
    dep_int_dom_ind = excluded.dep_int_dom_ind,
    overnight_link_row_index = excluded.overnight_link_row_index,
    link_type = excluded.link_type;

  delete from public.season_source_row_days where season_id = p_season_id and row_index = v_row_index;
  for v_day in select * from jsonb_array_elements(coalesce(row_payload->'daysOfWeek', '[]'::jsonb))
  loop
    v_index := v_index + 1;
    if (v_day #>> '{}')::boolean then
      insert into public.season_source_row_days (season_id, row_index, iso_dow)
      values (p_season_id, v_row_index, v_index)
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

create or replace function public.upsert_season_flight_record_from_json(p_season_id text, record_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_record_id text := record_payload->>'id';
  v_counter jsonb;
  v_counter_key text;
  v_counter_value jsonb;
  v_item jsonb;
  v_index integer;
  v_window record;
begin
  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number, request_status_code,
    route, schedule, aircraft, category, code_shares, int_dom_ind, pax, gate, stand, carousel,
    mct, fb, lb, bhs, ghs, date, scheduled_date, scheduled_time, operational_date, iata_season_code,
    flight_series_id, day_of_week, action, source_row_index, linked_source_row_index,
    link_type, pair_anchor_date, linked_record_id, source_kind, source_side, status, turnaround_id
  )
  values (
    p_season_id, v_record_id, coalesce(record_payload->>'linkId', ''), coalesce(record_payload->>'type', 'A'),
    coalesce(record_payload->>'airline', ''), coalesce(record_payload->>'flightNumber', ''),
    coalesce(record_payload->>'rawFlightNumber', record_payload->>'flightNumber', ''), record_payload->>'requestStatusCode',
    coalesce(record_payload->>'route', ''), coalesce(record_payload->>'schedule', ''), coalesce(record_payload->>'aircraft', ''),
    coalesce(record_payload->>'category', ''), record_payload->>'codeShares', record_payload->>'intDomInd',
    nullif(record_payload->>'pax', '')::integer, nullif(record_payload->>'gate', '')::integer, nullif(record_payload->>'stand', '')::integer,
    nullif(record_payload->>'carousel', '')::integer, record_payload->>'mct', record_payload->>'fb', record_payload->>'lb',
    record_payload->>'bhs', record_payload->>'ghs', coalesce(record_payload->>'date', ''),
    coalesce(record_payload->>'scheduledDate', record_payload->>'date'),
    coalesce(record_payload->>'scheduledTime', record_payload->>'schedule'),
    coalesce(record_payload->>'operationalDate', record_payload->>'date'),
    record_payload->>'iataSeasonCode',
    record_payload->>'flightSeriesId',
    coalesce(nullif(record_payload->>'dayOfWeek', '')::integer, 0),
    record_payload->>'action', coalesce(nullif(record_payload->>'sourceRowIndex', '')::integer, 0),
    nullif(record_payload->>'linkedSourceRowIndex', '')::integer, record_payload->>'linkType',
    record_payload->>'pairAnchorDate', record_payload->>'linkedRecordId',
    coalesce(record_payload->>'sourceKind', 'imported'), coalesce(record_payload->>'sourceSide', 'ARR'),
    coalesce(record_payload->>'status', 'active'), record_payload->>'turnaroundId'
  )
  on conflict (record_id) do update set
    season_id = excluded.season_id,
    link_id = excluded.link_id,
    type = excluded.type,
    airline = excluded.airline,
    flight_number = excluded.flight_number,
    raw_flight_number = excluded.raw_flight_number,
    request_status_code = excluded.request_status_code,
    route = excluded.route,
    schedule = excluded.schedule,
    aircraft = excluded.aircraft,
    category = excluded.category,
    code_shares = excluded.code_shares,
    int_dom_ind = excluded.int_dom_ind,
    pax = excluded.pax,
    gate = excluded.gate,
    stand = excluded.stand,
    carousel = excluded.carousel,
    mct = excluded.mct,
    fb = excluded.fb,
    lb = excluded.lb,
    bhs = excluded.bhs,
    ghs = excluded.ghs,
    date = excluded.date,
    scheduled_date = excluded.scheduled_date,
    scheduled_time = excluded.scheduled_time,
    operational_date = excluded.operational_date,
    iata_season_code = excluded.iata_season_code,
    flight_series_id = excluded.flight_series_id,
    day_of_week = excluded.day_of_week,
    action = excluded.action,
    source_row_index = excluded.source_row_index,
    linked_source_row_index = excluded.linked_source_row_index,
    link_type = excluded.link_type,
    pair_anchor_date = excluded.pair_anchor_date,
    linked_record_id = excluded.linked_record_id,
    source_kind = excluded.source_kind,
    source_side = excluded.source_side,
    status = excluded.status,
    turnaround_id = excluded.turnaround_id;

  delete from public.season_flight_record_counters where record_id = v_record_id;
  v_counter := record_payload->'counter';
  if v_counter is not null and jsonb_typeof(v_counter) <> 'null' then
    if jsonb_typeof(v_counter) = 'array' then
      v_index := 0;
      for v_item in select * from jsonb_array_elements(v_counter)
      loop
        insert into public.season_flight_record_counters values (v_record_id, '__single__', v_index, trim(both '"' from v_item::text));
        v_index := v_index + 1;
      end loop;
    elsif jsonb_typeof(v_counter) = 'object' then
      for v_counter_key, v_counter_value in select * from jsonb_each(v_counter)
      loop
        if jsonb_typeof(v_counter_value) = 'array' then
          v_index := 0;
          for v_item in select * from jsonb_array_elements(v_counter_value)
          loop
            insert into public.season_flight_record_counters values (v_record_id, v_counter_key, v_index, trim(both '"' from v_item::text));
            v_index := v_index + 1;
          end loop;
        else
          insert into public.season_flight_record_counters values (v_record_id, v_counter_key, 0, trim(both '"' from v_counter_value::text));
        end if;
      end loop;
    else
      insert into public.season_flight_record_counters values (v_record_id, '__single__', 0, trim(both '"' from v_counter::text));
    end if;
  end if;

  delete from public.season_flight_record_checkin_windows where record_id = v_record_id;
  for v_window in
    select key, value
    from jsonb_each(
      case
        when jsonb_typeof(record_payload->'checkInCounterWindows') = 'object'
          then record_payload->'checkInCounterWindows'
        else '{}'::jsonb
      end
    )
  loop
    insert into public.season_flight_record_checkin_windows (record_id, counter_key, window_start, window_end)
    values (v_record_id, v_window.key, v_window.value->>'start', v_window.value->>'end')
    on conflict (record_id, counter_key) do update set window_start = excluded.window_start, window_end = excluded.window_end;
  end loop;
end;
$$;

create or replace function public.upsert_season_modification_from_json(p_season_id text, mod_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_leg_id text := mod_payload->>'legId';
  v_changed_fields text[] := '{}';
  v_key text;
  v_counter jsonb;
  v_counter_key text;
  v_counter_value jsonb;
  v_item jsonb;
  v_index integer;
  v_window record;
  added_leg jsonb;
begin
  for v_key in select jsonb_object_keys(mod_payload)
  loop
    if v_key not in ('legId', 'action') then
      v_changed_fields := array_append(v_changed_fields, v_key);
    end if;
  end loop;
  insert into public.season_modifications (
    season_id, leg_id, action, changed_fields, schedule, aircraft, route, code_shares, pax, gate, stand,
    carousel, mct, fb, lb, bhs, ghs, check_in_start, check_in_end, check_in_allocation_mode
  )
  values (
    p_season_id, v_leg_id, coalesce(mod_payload->>'action', 'modified'), v_changed_fields,
    mod_payload->>'schedule', mod_payload->>'aircraft', mod_payload->>'route', mod_payload->>'codeShares',
    nullif(mod_payload->>'pax', '')::integer, nullif(mod_payload->>'gate', '')::integer, nullif(mod_payload->>'stand', '')::integer,
    nullif(mod_payload->>'carousel', '')::integer, mod_payload->>'mct', mod_payload->>'fb', mod_payload->>'lb',
    mod_payload->>'bhs', mod_payload->>'ghs', mod_payload->>'checkInStart', mod_payload->>'checkInEnd',
    mod_payload->>'checkInAllocationMode'
  )
  on conflict (leg_id) do update set
    season_id = excluded.season_id,
    action = excluded.action,
    changed_fields = excluded.changed_fields,
    schedule = excluded.schedule,
    aircraft = excluded.aircraft,
    route = excluded.route,
    code_shares = excluded.code_shares,
    pax = excluded.pax,
    gate = excluded.gate,
    stand = excluded.stand,
    carousel = excluded.carousel,
    mct = excluded.mct,
    fb = excluded.fb,
    lb = excluded.lb,
    bhs = excluded.bhs,
    ghs = excluded.ghs,
    check_in_start = excluded.check_in_start,
    check_in_end = excluded.check_in_end,
    check_in_allocation_mode = excluded.check_in_allocation_mode;

  delete from public.season_modification_counters where leg_id = v_leg_id;
  v_counter := mod_payload->'counter';
  if v_counter is not null and jsonb_typeof(v_counter) <> 'null' then
    if jsonb_typeof(v_counter) = 'array' then
      v_index := 0;
      for v_item in select * from jsonb_array_elements(v_counter)
      loop
        insert into public.season_modification_counters values (v_leg_id, '__single__', v_index, trim(both '"' from v_item::text));
        v_index := v_index + 1;
      end loop;
    elsif jsonb_typeof(v_counter) = 'object' then
      for v_counter_key, v_counter_value in select * from jsonb_each(v_counter)
      loop
        if jsonb_typeof(v_counter_value) = 'array' then
          v_index := 0;
          for v_item in select * from jsonb_array_elements(v_counter_value)
          loop
            insert into public.season_modification_counters values (v_leg_id, v_counter_key, v_index, trim(both '"' from v_item::text));
            v_index := v_index + 1;
          end loop;
        else
          insert into public.season_modification_counters values (v_leg_id, v_counter_key, 0, trim(both '"' from v_counter_value::text));
        end if;
      end loop;
    else
      insert into public.season_modification_counters values (v_leg_id, '__single__', 0, trim(both '"' from v_counter::text));
    end if;
  end if;

  delete from public.season_modification_checkin_windows where leg_id = v_leg_id;
  for v_window in
    select key, value
    from jsonb_each(
      case
        when jsonb_typeof(mod_payload->'checkInCounterWindows') = 'object'
          then mod_payload->'checkInCounterWindows'
        else '{}'::jsonb
      end
    )
  loop
    insert into public.season_modification_checkin_windows (leg_id, counter_key, window_start, window_end)
    values (v_leg_id, v_window.key, v_window.value->>'start', v_window.value->>'end')
    on conflict (leg_id, counter_key) do update set window_start = excluded.window_start, window_end = excluded.window_end;
  end loop;

  delete from public.season_modification_added_legs where leg_id = v_leg_id;
  added_leg := mod_payload->'addedLeg';
  if added_leg is not null and jsonb_typeof(added_leg) = 'object' then
    insert into public.season_modification_added_legs (
      season_id, leg_id, record_id, link_id, type, airline, flight_number, raw_flight_number, request_status_code,
      route, schedule, aircraft, category, code_shares, int_dom_ind, pax, gate, stand, carousel,
      mct, fb, lb, bhs, ghs, date, scheduled_date, scheduled_time, operational_date, iata_season_code,
      flight_series_id, day_of_week, action, source_row_index, linked_source_row_index,
      link_type, pair_anchor_date, linked_record_id, source_kind, source_side, status, turnaround_id
    )
    values (
      p_season_id, v_leg_id, coalesce(added_leg->>'id', v_leg_id), coalesce(added_leg->>'linkId', ''), coalesce(added_leg->>'type', 'A'),
      coalesce(added_leg->>'airline', ''), coalesce(added_leg->>'flightNumber', ''),
      coalesce(added_leg->>'rawFlightNumber', added_leg->>'flightNumber', ''), added_leg->>'requestStatusCode',
      coalesce(added_leg->>'route', ''), coalesce(added_leg->>'schedule', ''), coalesce(added_leg->>'aircraft', ''),
      coalesce(added_leg->>'category', ''), added_leg->>'codeShares', added_leg->>'intDomInd',
      nullif(added_leg->>'pax', '')::integer, nullif(added_leg->>'gate', '')::integer, nullif(added_leg->>'stand', '')::integer,
      nullif(added_leg->>'carousel', '')::integer, added_leg->>'mct', added_leg->>'fb', added_leg->>'lb',
      added_leg->>'bhs', added_leg->>'ghs', coalesce(added_leg->>'date', ''),
      coalesce(added_leg->>'scheduledDate', added_leg->>'date'),
      coalesce(added_leg->>'scheduledTime', added_leg->>'schedule'),
      coalesce(added_leg->>'operationalDate', added_leg->>'date'),
      added_leg->>'iataSeasonCode',
      added_leg->>'flightSeriesId',
      coalesce(nullif(added_leg->>'dayOfWeek', '')::integer, 0),
      added_leg->>'action', coalesce(nullif(added_leg->>'sourceRowIndex', '')::integer, 0),
      nullif(added_leg->>'linkedSourceRowIndex', '')::integer, added_leg->>'linkType',
      added_leg->>'pairAnchorDate', added_leg->>'linkedRecordId', 'added',
      case when coalesce(added_leg->>'type', 'A') = 'D' then 'DEP' else 'ARR' end,
      'active', added_leg->>'turnaroundId'
    )
    on conflict (leg_id) do update set
      season_id = excluded.season_id,
      record_id = excluded.record_id,
      link_id = excluded.link_id,
      type = excluded.type,
      airline = excluded.airline,
      flight_number = excluded.flight_number,
      raw_flight_number = excluded.raw_flight_number,
      request_status_code = excluded.request_status_code,
      route = excluded.route,
      schedule = excluded.schedule,
      aircraft = excluded.aircraft,
      category = excluded.category,
      code_shares = excluded.code_shares,
      int_dom_ind = excluded.int_dom_ind,
      pax = excluded.pax,
      gate = excluded.gate,
      stand = excluded.stand,
      carousel = excluded.carousel,
      mct = excluded.mct,
      fb = excluded.fb,
      lb = excluded.lb,
      bhs = excluded.bhs,
      ghs = excluded.ghs,
      date = excluded.date,
      scheduled_date = excluded.scheduled_date,
      scheduled_time = excluded.scheduled_time,
      operational_date = excluded.operational_date,
      iata_season_code = excluded.iata_season_code,
      flight_series_id = excluded.flight_series_id,
      day_of_week = excluded.day_of_week,
      action = excluded.action,
      source_row_index = excluded.source_row_index,
      linked_source_row_index = excluded.linked_source_row_index,
      link_type = excluded.link_type,
      pair_anchor_date = excluded.pair_anchor_date,
      linked_record_id = excluded.linked_record_id,
      source_kind = excluded.source_kind,
      source_side = excluded.source_side,
      status = excluded.status,
      turnaround_id = excluded.turnaround_id;
  end if;
end;
$$;

create or replace function public.upsert_season_mod_history_from_json(p_season_id text, history_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry_id text := history_payload->>'id';
  v_change jsonb;
  v_index integer := 0;
begin
  insert into public.season_mod_history_entries (season_id, entry_id, timestamp, description)
  values (p_season_id, v_entry_id, (history_payload->>'timestamp')::bigint, coalesce(history_payload->>'description', ''))
  on conflict (entry_id) do update set season_id = excluded.season_id, timestamp = excluded.timestamp, description = excluded.description;
  delete from public.season_mod_history_changes where entry_id = v_entry_id;
  delete from public.season_mod_history_record_changes where entry_id = v_entry_id;
  for v_change in select * from jsonb_array_elements(coalesce(history_payload->'changes', '[]'::jsonb))
  loop
    insert into public.season_mod_history_changes (entry_id, change_index, leg_id, previous_mod_snapshot, new_mod_snapshot)
    values (v_entry_id, v_index, v_change->>'legId', v_change->'previousMod', coalesce(v_change->'newMod', '{}'::jsonb));
    v_index := v_index + 1;
  end loop;
  v_index := 0;
  for v_change in select * from jsonb_array_elements(coalesce(history_payload->'recordChanges', '[]'::jsonb))
  loop
    insert into public.season_mod_history_record_changes (entry_id, change_index, record_id, previous_record_snapshot, new_record_snapshot)
    values (v_entry_id, v_index, v_change->>'recordId', v_change->'previousRecord', v_change->'newRecord');
    v_index := v_index + 1;
  end loop;
end;
$$;

create or replace function public.apply_workspace_op_json(p_season_id text, op jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  op_type text := op->>'type';
begin
  if op_type = 'sourceRow' then
    perform public.upsert_season_source_row_from_json(p_season_id, op->'row');
  elsif op_type = 'flightRecord' then
    perform public.upsert_season_flight_record_from_json(p_season_id, op->'record');
  elsif op_type = 'modification' then
    perform public.upsert_season_modification_from_json(p_season_id, op->'mod');
  elsif op_type = 'modificationDelete' then
    delete from public.season_modifications where leg_id = op->>'legId';
  elsif op_type = 'modHistory' then
    perform public.upsert_season_mod_history_from_json(p_season_id, op->'entry');
  end if;
end;
$$;

create or replace function public.sync_season_workspace(
  p_season_id text,
  p_base_version integer,
  p_pending_ops jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_version integer;
  next_version integer;
  op jsonb;
begin
  select data_version into current_version from public.seasons where id = p_season_id for update;
  if current_version is null then
    raise exception 'Season % not found', p_season_id;
  end if;
  if current_version <> p_base_version then
    raise exception 'Server version changed from % to %', p_base_version, current_version;
  end if;
  for op in select * from jsonb_array_elements(coalesce(p_pending_ops, '[]'::jsonb))
  loop
    perform public.apply_workspace_op_json(p_season_id, op);
  end loop;
  next_version := current_version + 1;
  update public.seasons
  set data_version = next_version,
      last_synced_at = (extract(epoch from now()) * 1000)::bigint
  where id = p_season_id;
  return jsonb_build_object('next_server_version', next_version);
end;
$$;

create or replace function public.get_season_event_high_water(p_season_id text)
returns bigint
language sql
security invoker
set search_path = public
as $$
  select coalesce(max(server_seq), 0)::bigint
  from public.season_change_events
  where season_id = p_season_id;
$$;

grant execute on function public.get_season_event_high_water(text) to authenticated;
grant select on public.season_entity_versions to authenticated;

create or replace function public.get_season_workspace_snapshot(
  p_season_id text,
  p_mod_history_limit integer default 50
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  safe_history_limit integer := least(greatest(coalesce(p_mod_history_limit, 50), 0), 500);
  snapshot jsonb;
begin
  with season_row as (
    select *
    from public.seasons
    where id = p_season_id
  ),
  source_rows as (
    select *
    from public.season_source_rows
    where season_id = p_season_id
  ),
  source_row_days as (
    select *
    from public.season_source_row_days
    where season_id = p_season_id
  ),
  flight_record_rows as (
    select distinct on (r.record_id) r.*
    from public.season_flight_records r
    where r.season_id = p_season_id
    order by r.record_id
  ),
  flight_record_ids as (
    select record_id from flight_record_rows
  ),
  modification_rows as (
    select distinct on (m.leg_id) m.*
    from public.season_modifications m
    where m.season_id = p_season_id
      and (
        m.leg_id in (select record_id from flight_record_ids)
        or (
          m.action = 'added'
          and exists (
            select 1
            from public.season_modification_added_legs al
            where al.leg_id = m.leg_id
              and al.season_id = p_season_id
          )
        )
       )
    order by m.leg_id
  ),
  modification_leg_ids as (
    select leg_id from modification_rows
  ),
  history_entries as (
    select *
    from public.season_mod_history_entries
    where season_id = p_season_id
    order by timestamp desc
    limit safe_history_limit
  ),
  history_entry_ids as (
    select entry_id from history_entries
  )
  select jsonb_build_object(
    'season', (select to_jsonb(s) from season_row s),
    'sourceRows', coalesce((select jsonb_agg(to_jsonb(r) order by r.row_index) from source_rows r), '[]'::jsonb),
    'sourceRowDays', coalesce((select jsonb_agg(to_jsonb(d) order by d.row_index, d.iso_dow) from source_row_days d), '[]'::jsonb),
    'flightRecords', coalesce((select jsonb_agg(to_jsonb(r) order by r.operational_date, r.flight_number, r.record_id) from flight_record_rows r), '[]'::jsonb),
    'flightRecordCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.record_id, c.counter_group, c.item_index) from public.season_flight_record_counters c where c.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'flightRecordWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.record_id, w.counter_key) from public.season_flight_record_checkin_windows w where w.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'modifications', coalesce((select jsonb_agg(to_jsonb(m) order by m.leg_id) from modification_rows m), '[]'::jsonb),
    'modificationCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.leg_id, c.counter_group, c.item_index) from public.season_modification_counters c where c.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.leg_id, w.counter_key) from public.season_modification_checkin_windows w where w.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationAddedLegs', coalesce((select jsonb_agg(to_jsonb(al) order by al.leg_id) from public.season_modification_added_legs al where al.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modHistoryEntries', coalesce((select jsonb_agg(to_jsonb(h) order by h.timestamp desc) from history_entries h), '[]'::jsonb),
    'modHistoryChanges', coalesce((select jsonb_agg(to_jsonb(c) order by c.entry_id, c.change_index) from public.season_mod_history_changes c where c.entry_id in (select entry_id from history_entry_ids)), '[]'::jsonb),
    'modHistoryRecordChanges', coalesce((select jsonb_agg(to_jsonb(c) order by c.entry_id, c.change_index) from public.season_mod_history_record_changes c where c.entry_id in (select entry_id from history_entry_ids)), '[]'::jsonb),
    'cursor', jsonb_build_object(
      'serverHighWater',
      coalesce((select max(server_seq) from public.season_change_events where season_id = p_season_id), 0)
    ),
    'entityVersions', coalesce((select jsonb_agg(jsonb_build_object(
      'target_type', ev.target_type,
      'target_id', ev.target_id,
      'field_versions', ev.field_versions
    ) order by ev.target_type, ev.target_id)
      from public.season_entity_versions ev
      where ev.season_id = p_season_id
        and (
          ev.target_type not in ('flightRecord', 'modification')
          or ev.target_id in (select record_id from flight_record_ids)
          or (
            ev.target_type = 'modification'
            and ev.target_id in (select leg_id from modification_leg_ids)
          )
        )
    ), '[]'::jsonb)
  )
  into snapshot;

  return snapshot;
end;
$$;

create or replace function public.get_season_change_event_page(
  p_season_id text,
  p_after_seq bigint,
  p_through_seq bigint,
  p_limit integer default 200
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  safe_after_seq bigint := coalesce(p_after_seq, 0);
  safe_through_seq bigint := greatest(coalesce(p_through_seq, safe_after_seq), safe_after_seq);
  events jsonb := '[]'::jsonb;
  next_cursor bigint := safe_after_seq;
  has_more boolean := false;
  server_high_water bigint := 0;
begin
  select coalesce(max(server_seq), 0)
  into server_high_water
  from public.season_change_events
  where season_id = p_season_id;

  with page_rows as (
    select *
    from public.season_change_events
    where season_id = p_season_id
      and server_seq > safe_after_seq
      and server_seq <= safe_through_seq
    order by server_seq asc
    limit safe_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'eventId', event_id,
      'seasonId', season_id,
      'clientId', client_id,
      'opId', coalesce(op_id, event_id),
      'actorUserId', actor_user_id,
      'serverSeq', server_seq,
      'targetType', target_type,
      'targetId', target_id,
      'changedFields', changed_fields,
      'opPayload', op_payload,
      'createdAt', created_at
    ) order by server_seq), '[]'::jsonb),
    coalesce(max(server_seq), safe_after_seq)
  into events, next_cursor
  from page_rows;

  select exists (
    select 1
    from public.season_change_events
    where season_id = p_season_id
      and server_seq > next_cursor
      and server_seq <= safe_through_seq
  )
  into has_more;

  return jsonb_build_object(
    'events', events,
    'nextCursor', next_cursor,
    'hasMore', has_more,
    'serverHighWater', server_high_water
  );
end;
$$;

revoke execute on function public.get_season_workspace_snapshot(text, integer) from public;
revoke execute on function public.get_season_workspace_snapshot(text, integer) from anon;
grant execute on function public.get_season_workspace_snapshot(text, integer) to authenticated;

revoke execute on function public.get_season_change_event_page(text, bigint, bigint, integer) from public;
revoke execute on function public.get_season_change_event_page(text, bigint, bigint, integer) from anon;
grant execute on function public.get_season_change_event_page(text, bigint, bigint, integer) to authenticated;

create or replace function public.sync_season_workspace_v2(
  p_season_id text,
  p_client_id text,
  p_base_server_seq bigint,
  p_pending_events jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_version integer;
  next_version integer;
  event_doc jsonb;
  event_payload jsonb;
  v_event_id text;
  v_op_id text;
  v_target_type text;
  v_target_id text;
  changed_fields text[];
  changed_field text;
  current_field_versions jsonb;
  next_field_versions jsonb;
  base_field_versions jsonb;
  current_field_version bigint;
  base_field_version bigint;
  has_conflict boolean;
  applied_seq bigint;
  applied_count integer := 0;
  next_server_seq bigint;
  server_high_water bigint;
  applied_events jsonb := '[]'::jsonb;
  conflict_events jsonb := '[]'::jsonb;
begin
  select data_version into current_version from public.seasons where id = p_season_id for update;
  if current_version is null then
    raise exception 'Season % not found', p_season_id;
  end if;

  for event_doc in select * from jsonb_array_elements(coalesce(p_pending_events, '[]'::jsonb))
  loop
    event_payload := coalesce(event_doc->'opPayload', event_doc->'op_payload', '{}'::jsonb);
    v_event_id := coalesce(event_doc->>'eventId', event_doc->>'event_id', gen_random_uuid()::text);
    v_op_id := coalesce(event_doc->>'opId', event_doc->>'op_id', v_event_id);
    v_target_type := coalesce(event_doc->>'targetType', event_doc->>'target_type', 'flightRecord');
    v_target_id := coalesce(event_doc->>'targetId', event_doc->>'target_id', event_payload->>'legId', event_payload->'record'->>'id', event_payload->>'legId', v_event_id);
    changed_fields := coalesce(
      array(select jsonb_array_elements_text(coalesce(event_doc->'changedFields', event_doc->'changed_fields', '[]'::jsonb))),
      '{}'
    );
    base_field_versions := coalesce(event_payload->'baseFieldVersions', event_payload->'base_field_versions', '{}'::jsonb);

    select server_seq into applied_seq
    from public.season_change_events
    where client_id = p_client_id and op_id = v_op_id;

    if applied_seq is not null then
      insert into public.season_entity_versions (season_id, target_type, target_id)
      values (p_season_id, v_target_type, v_target_id)
      on conflict do nothing;

      select field_versions into current_field_versions
      from public.season_entity_versions
      where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id
      for update;

      perform public.apply_workspace_op_json(p_season_id, event_payload);
      next_field_versions := coalesce(current_field_versions, '{}'::jsonb);
      foreach changed_field in array changed_fields
      loop
        next_field_versions := jsonb_set(
          next_field_versions,
          array[changed_field],
          to_jsonb(applied_seq),
          true
        );
      end loop;
      update public.season_entity_versions
      set field_versions = next_field_versions,
          updated_by = auth.uid(),
          updated_at = now()
      where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id;

      applied_events := applied_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'actorUserId', auth.uid(),
        'serverSeq', applied_seq,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload,
        'createdAt', now()
      ));
      continue;
    end if;

    insert into public.season_entity_versions (season_id, target_type, target_id)
    values (p_season_id, v_target_type, v_target_id)
    on conflict do nothing;

    select field_versions into current_field_versions
    from public.season_entity_versions
    where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id
    for update;

    has_conflict := false;
    foreach changed_field in array changed_fields
    loop
      current_field_version := coalesce((current_field_versions->>changed_field)::bigint, 0);
      base_field_version := coalesce((base_field_versions->>changed_field)::bigint, 0);
      if current_field_version > base_field_version then
        has_conflict := true;
      end if;
    end loop;

    if has_conflict then
      conflict_events := conflict_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload
      ));
    else
      insert into public.season_change_events (
        event_id, season_id, client_id, op_id, actor_user_id, target_type, target_id, changed_fields, op_payload
      )
      values (
        v_event_id, p_season_id, p_client_id, v_op_id, auth.uid(), v_target_type, v_target_id, changed_fields, event_payload
      )
      on conflict (client_id, op_id) do nothing
      returning server_seq into applied_seq;

      if applied_seq is null then
        select server_seq into applied_seq
        from public.season_change_events
        where client_id = p_client_id and op_id = v_op_id;
        if applied_seq is null then
          raise exception 'Duplicate sync op % could not be resolved to a server sequence', v_op_id;
        end if;

        perform public.apply_workspace_op_json(p_season_id, event_payload);
        next_field_versions := coalesce(current_field_versions, '{}'::jsonb);
        foreach changed_field in array changed_fields
        loop
          next_field_versions := jsonb_set(
            next_field_versions,
            array[changed_field],
            to_jsonb(applied_seq),
            true
          );
        end loop;
        update public.season_entity_versions
        set field_versions = next_field_versions,
            updated_by = auth.uid(),
            updated_at = now()
        where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id;

        applied_events := applied_events || jsonb_build_array(jsonb_build_object(
          'eventId', v_event_id,
          'seasonId', p_season_id,
          'clientId', p_client_id,
          'opId', v_op_id,
          'actorUserId', auth.uid(),
          'serverSeq', applied_seq,
          'targetType', v_target_type,
          'targetId', v_target_id,
          'changedFields', changed_fields,
          'opPayload', event_payload,
          'createdAt', now()
        ));
        continue;
      end if;

      perform public.apply_workspace_op_json(p_season_id, event_payload);
      next_field_versions := current_field_versions;
      foreach changed_field in array changed_fields
      loop
        next_field_versions := jsonb_set(
          next_field_versions,
          array[changed_field],
          to_jsonb(applied_seq),
          true
        );
      end loop;
      update public.season_entity_versions
      set entity_version = entity_version + 1,
          field_versions = next_field_versions,
          updated_by = auth.uid(),
          updated_at = now()
      where season_id = p_season_id and target_type = v_target_type and target_id = v_target_id;

      applied_count := applied_count + 1;
      applied_events := applied_events || jsonb_build_array(jsonb_build_object(
        'eventId', v_event_id,
        'seasonId', p_season_id,
        'clientId', p_client_id,
        'opId', v_op_id,
        'actorUserId', auth.uid(),
        'serverSeq', applied_seq,
        'targetType', v_target_type,
        'targetId', v_target_id,
        'changedFields', changed_fields,
        'opPayload', event_payload,
        'createdAt', now()
      ));
    end if;
  end loop;

  next_version := current_version + greatest(applied_count, 0);
  update public.seasons
  set data_version = next_version,
      last_synced_at = (extract(epoch from now()) * 1000)::bigint
  where id = p_season_id;
  select coalesce(max(server_seq), p_base_server_seq) into server_high_water
  from public.season_change_events
  where season_id = p_season_id;
  next_server_seq := server_high_water;
  return jsonb_build_object(
    'applied_events', applied_events,
    'conflict_events', conflict_events,
    'next_server_seq', next_server_seq,
    'server_high_water', server_high_water,
    'next_server_version', next_version
  );
end;
$$;

create or replace function public.enqueue_schedule_notification_delivery()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry jsonb;
  v_payload jsonb;
  v_history_entry_id text;
  v_module text;
begin
  if new.target_type <> 'modHistory' then
    return new;
  end if;

  v_entry := coalesce(new.op_payload->'entry', '{}'::jsonb);
  v_payload := v_entry->'scheduleNotification';
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    return new;
  end if;

  v_history_entry_id := coalesce(v_entry->>'id', new.target_id);
  v_module := coalesce(v_payload->>'module', '');
  if new.season_id is null or v_history_entry_id is null or v_module not in ('seasonal', 'detailed') then
    return new;
  end if;

  insert into public.schedule_notification_deliveries (
    id,
    season_id,
    history_entry_id,
    actor_user_id,
    module,
    payload
  )
  values (
    'schedule-telegram:' || new.season_id || ':' || v_history_entry_id,
    new.season_id,
    v_history_entry_id,
    new.actor_user_id,
    v_module,
    v_payload
  )
  on conflict (season_id, history_entry_id) do nothing;

  return new;
end;
$$;

drop trigger if exists season_change_events_schedule_notification_delivery on public.season_change_events;
create trigger season_change_events_schedule_notification_delivery
after insert on public.season_change_events
for each row
execute function public.enqueue_schedule_notification_delivery();

create schema if not exists reporting;

create index if not exists season_modifications_reporting_idx
  on public.season_modifications (season_id, leg_id, action);

create index if not exists season_modification_added_legs_reporting_idx
  on public.season_modification_added_legs (season_id, leg_id, status, type);

create index if not exists operational_aircraft_group_types_aircraft_type_idx
  on public.operational_aircraft_group_types (aircraft_type);

drop view if exists reporting.summary_arr_dep_mix cascade;
drop view if exists reporting.summary_aircraft cascade;
drop view if exists reporting.summary_peak_hour cascade;
drop view if exists reporting.summary_week cascade;
drop view if exists reporting.summary_month cascade;
drop view if exists reporting.summary_route cascade;
drop view if exists reporting.summary_country cascade;
drop view if exists reporting.summary_airline cascade;
drop view if exists reporting.flight_operations cascade;
drop view if exists reporting.effective_flight_operations cascade;

-- Legacy rule anchor retained for the older Looker Studio source regression:
-- coalesce(r.iata_season_code, s.season_code
-- coalesce(r.operational_date, r.date) as ops_date
create or replace view reporting.effective_flight_operations as
with source_rows as (
  select
    'imported'::text as row_scope,
    r.season_id,
    r.record_id,
    r.flight_series_id,
    r.turnaround_id,
    r.type,
    r.flight_number,
    r.airline,
    r.route,
    r.aircraft,
    r.pax,
    r.date,
    r.scheduled_date,
    r.operational_date,
    r.schedule,
    r.status,
    r.gate,
    r.stand,
    r.carousel,
    r.source_kind,
    r.source_side,
    r.iata_season_code,
    coalesce(m.changed_fields, array[]::text[]) as changed_fields,
    m.schedule as mod_schedule,
    m.aircraft as mod_aircraft,
    m.route as mod_route,
    m.pax as mod_pax,
    m.gate as mod_gate,
    m.stand as mod_stand,
    m.carousel as mod_carousel
  from public.season_flight_records r
  left join public.season_modifications m
    on m.season_id = r.season_id
   and m.leg_id = r.record_id
   and m.action in ('modified', 'deleted')
  where r.status is distinct from 'deleted'
    and coalesce(m.action, 'modified') <> 'deleted'

  union all

  select
    'added'::text as row_scope,
    al.season_id,
    al.record_id,
    al.flight_series_id,
    al.turnaround_id,
    al.type,
    al.flight_number,
    al.airline,
    al.route,
    al.aircraft,
    al.pax,
    al.date,
    al.scheduled_date,
    al.operational_date,
    al.schedule,
    al.status,
    al.gate,
    al.stand,
    al.carousel,
    al.source_kind,
    al.source_side,
    al.iata_season_code,
    array[]::text[] as changed_fields,
    null::text as mod_schedule,
    null::text as mod_aircraft,
    null::text as mod_route,
    null::integer as mod_pax,
    null::integer as mod_gate,
    null::integer as mod_stand,
    null::integer as mod_carousel
  from public.season_modification_added_legs al
  join public.season_modifications m
    on m.season_id = al.season_id
   and m.leg_id = al.leg_id
  where m.action = 'added'
    and al.status is distinct from 'deleted'
),
effective_rows as (
  select
    sr.season_id,
    sr.record_id,
    sr.flight_series_id,
    sr.turnaround_id,
    sr.type,
    sr.flight_number as flight,
    upper(sr.airline) as airline,
    case when sr.row_scope = 'imported' and 'route' = any(sr.changed_fields) then upper(coalesce(sr.mod_route, '')) else upper(coalesce(sr.route, '')) end as route,
    case when sr.row_scope = 'imported' and 'aircraft' = any(sr.changed_fields) then upper(coalesce(sr.mod_aircraft, '')) else upper(coalesce(sr.aircraft, '')) end as aircraft,
    case when sr.row_scope = 'imported' and 'pax' = any(sr.changed_fields) then sr.mod_pax else sr.pax end as pax,
    coalesce(nullif(sr.scheduled_date, ''), nullif(sr.date, ''), '') as scheduled_date,
    case when sr.row_scope = 'imported' and 'schedule' = any(sr.changed_fields) then coalesce(sr.mod_schedule, '') else coalesce(sr.schedule, '') end as scheduled_time,
    sr.operational_date,
    coalesce(sr.status, 'active') as status,
    case when sr.row_scope = 'imported' and 'gate' = any(sr.changed_fields) then sr.mod_gate else sr.gate end as gate,
    case when sr.row_scope = 'imported' and 'stand' = any(sr.changed_fields) then sr.mod_stand else sr.stand end as stand,
    case when sr.row_scope = 'imported' and 'carousel' = any(sr.changed_fields) then sr.mod_carousel else sr.carousel end as carousel,
    sr.source_kind,
    sr.source_side,
    sr.iata_season_code
  from source_rows sr
),
parsed_rows as (
  select
    er.*,
    case
      when er.scheduled_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
        then (split_part(er.scheduled_time, ':', 1)::integer * 60) + substring(er.scheduled_time from '^[0-9]{1,2}:([0-9]{2})')::integer
      else null::integer
    end as local_minutes,
    case
      when er.scheduled_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        then to_date(er.scheduled_date, 'YYYY-MM-DD')
      else null::date
    end as scheduled_date_value
  from effective_rows er
),
dated_rows as (
  select
    pr.*,
    case when pr.local_minutes is null then null::integer else (pr.local_minutes + 1020) % 1440 end as utc_minutes,
    coalesce(
      case when pr.operational_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then pr.operational_date::date else null::date end,
      case
        when pr.scheduled_date_value is null then null::date
        when pr.local_minutes is not null and pr.local_minutes < 300 then pr.scheduled_date_value - 1
        else pr.scheduled_date_value
      end
    ) as ops_date_value,
    case
      when pr.scheduled_date_value is null or pr.local_minutes is null then null::timestamp
      else pr.scheduled_date_value::timestamp + make_interval(mins => pr.local_minutes)
    end as scheduled_local_at
  from parsed_rows pr
),
bucketed_rows as (
  select
    dr.*,
    case when dr.local_minutes is null then null::integer else (dr.local_minutes / 30)::integer end as local_bucket_30_index,
    case when dr.local_minutes is null then null::integer else (dr.local_minutes / 60)::integer end as local_bucket_60_index,
    case when dr.utc_minutes is null then null::integer else (dr.utc_minutes / 30)::integer end as utc_bucket_30_index,
    case when dr.utc_minutes is null then null::integer else (dr.utc_minutes / 60)::integer end as utc_bucket_60_index
  from dated_rows dr
)
select
  b.season_id,
  coalesce(nullif(b.iata_season_code, ''), s.season_code, '') as season,
  b.record_id,
  b.flight_series_id,
  b.turnaround_id,
  b.type,
  b.flight,
  b.airline,
  b.route,
  coalesce(rc.country, '') as country,
  b.aircraft,
  b.pax,
  b.scheduled_date,
  b.scheduled_time,
  coalesce(to_char(b.ops_date_value, 'YYYY-MM-DD'), b.scheduled_date) as ops_date,
  to_char(b.ops_date_value, 'YYYY-MM') as month,
  extract(week from b.ops_date_value)::integer as iso_week,
  case when b.local_minutes is null then null::integer else (b.local_minutes / 60)::integer end as local_hour,
  case when b.utc_minutes is null then null::integer else (b.utc_minutes / 60)::integer end as utc_hour,
  extract(dow from b.ops_date_value)::integer as weekday,
  b.status,
  b.gate,
  b.stand,
  b.carousel,
  b.source_kind,
  b.source_side,
  s.season_code,
  b.iata_season_code,
  to_char(b.ops_date_value, 'IYYY-"W"IW') as isoweek,
  extract(week from b.ops_date_value)::integer as weeknum,
  b.local_minutes,
  b.utc_minutes,
  b.local_bucket_30_index,
  case
    when b.local_bucket_30_index is null then null::text
    else lpad(((b.local_bucket_30_index * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.local_bucket_30_index * 30) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.local_bucket_30_index + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.local_bucket_30_index + 1) * 30) % 1440) % 60)::text, 2, '0')
  end as local_bucket_30,
  b.local_bucket_60_index,
  case
    when b.local_bucket_60_index is null then null::text
    else lpad(((b.local_bucket_60_index * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.local_bucket_60_index * 60) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.local_bucket_60_index + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.local_bucket_60_index + 1) * 60) % 1440) % 60)::text, 2, '0')
  end as local_bucket_60,
  b.utc_bucket_30_index,
  case
    when b.utc_bucket_30_index is null then null::text
    else lpad(((b.utc_bucket_30_index * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.utc_bucket_30_index * 30) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.utc_bucket_30_index + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.utc_bucket_30_index + 1) * 30) % 1440) % 60)::text, 2, '0')
  end as utc_bucket_30,
  b.utc_bucket_60_index,
  case
    when b.utc_bucket_60_index is null then null::text
    else lpad(((b.utc_bucket_60_index * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.utc_bucket_60_index * 60) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.utc_bucket_60_index + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.utc_bucket_60_index + 1) * 60) % 1440) % 60)::text, 2, '0')
  end as utc_bucket_60,
  (
    coalesce(b.pax, 0) = 0
    and b.scheduled_local_at is not null
    and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_at + interval '1 day'
  ) as pax_missing_after_1_day,
  case
    when coalesce(b.pax, 0) > 0 then 'reported'
    when coalesce(b.pax, 0) = 0
      and b.scheduled_local_at is not null
      and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_at + interval '1 day'
      then 'missing_after_1_day'
    else 'planned_zero'
  end as pax_status,
  coalesce(ag.ac_group, '') as ac_group
from bucketed_rows b
left join public.seasons s on s.id = b.season_id
left join public.operational_route_countries rc on upper(rc.route) = upper(b.route)
left join lateral (
  select g.name as ac_group
  from public.operational_aircraft_group_types gt
  join public.operational_aircraft_groups g on g.id = gt.group_id
  where upper(gt.aircraft_type) = upper(b.aircraft)
  order by g.name
  limit 1
) ag on true;

create or replace view reporting.flight_operations as
select * from reporting.effective_flight_operations;

create or replace view reporting.summary_airline as
select season_id, season, airline, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, airline, type;

create or replace view reporting.summary_country as
select season_id, season, country, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, country, type;

create or replace view reporting.summary_route as
select season_id, season, route, country, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, route, country, type;

create or replace view reporting.summary_month as
select season_id, season, month, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, month, type;

create or replace view reporting.summary_week as
select season_id, season, iso_week, isoweek, weeknum, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, iso_week, isoweek, weeknum, type;

create or replace view reporting.summary_peak_hour as
select
  season_id,
  season,
  local_hour,
  utc_hour,
  local_bucket_60_index,
  local_bucket_60,
  utc_bucket_60_index,
  utc_bucket_60,
  type,
  count(*)::integer as flights,
  coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, local_hour, utc_hour, local_bucket_60_index, local_bucket_60, utc_bucket_60_index, utc_bucket_60, type;

create or replace view reporting.summary_aircraft as
select season_id, season, aircraft, ac_group, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, aircraft, ac_group, type;

create or replace view reporting.summary_arr_dep_mix as
select season_id, season, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, type;

create or replace function reporting.query_aggregated(
  p_filters jsonb default '{}'::jsonb,
  p_group_by text[] default array[]::text[],
  p_metrics text[] default array['flights']::text[],
  p_order_by text default 'flights',
  p_order_dir text default 'desc',
  p_limit integer default 24
) returns jsonb
language plpgsql
security invoker
set search_path = reporting, public
as $$
declare
  allowed_group_by constant text[] := array[
    'airline',
    'route',
    'country',
    'aircraft',
    'ac_group',
    'month',
    'iso_week',
    'isoweek',
    'weeknum',
    'local_hour',
    'utc_hour',
    'local_bucket_30',
    'local_bucket_30_index',
    'local_bucket_60',
    'local_bucket_60_index',
    'utc_bucket_30',
    'utc_bucket_30_index',
    'utc_bucket_60',
    'utc_bucket_60_index',
    'ops_date',
    'season',
    'gate',
    'type',
    'weekday',
    'pax_status'
  ];
  allowed_metrics constant text[] := array['flights', 'pax', 'arrivals', 'departures'];
  group_columns text[] := array[]::text[];
  metric_columns text[] := array[]::text[];
  where_clauses text[] := array['true'];
  select_parts text[] := array[]::text[];
  group_clause text := '';
  order_column text := 'flights';
  order_direction text := 'desc';
  safe_limit integer := least(greatest(coalesce(p_limit, 24), 1), 500);
  row_count integer := 0;
  result_rows jsonb := '[]'::jsonb;
  sql text;
  value_list text;
  metric text;
  column_name text;
  target_column text;
begin
  select coalesce(array_agg(distinct entry), array[]::text[])
    into group_columns
  from unnest(coalesce(p_group_by, array[]::text[])) as entry
  where entry = any(allowed_group_by);

  select coalesce(array_agg(distinct entry), array[]::text[])
    into metric_columns
  from unnest(coalesce(p_metrics, array['flights']::text[])) as entry
  where entry = any(allowed_metrics);

  if array_length(metric_columns, 1) is null then
    metric_columns := array['flights'];
  end if;

  if p_order_by = any(metric_columns) or p_order_by = any(group_columns) then
    order_column := p_order_by;
  elsif metric_columns[1] is not null then
    order_column := metric_columns[1];
  end if;

  if lower(coalesce(p_order_dir, 'desc')) = 'asc' then
    order_direction := 'asc';
  end if;

  if jsonb_typeof(p_filters->'seasonIds') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'seasonIds') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('season_id in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'iataSeasonCodes') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'iataSeasonCodes') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('(upper(season) in (%1$s) or upper(season_code) in (%1$s) or upper(iata_season_code) in (%1$s))', value_list);
    end if;
  end if;

  if p_filters ? 'dateFrom' and p_filters->>'dateFrom' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date >= %L', p_filters->>'dateFrom');
  end if;

  if p_filters ? 'dateTo' and p_filters->>'dateTo' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date <= %L', p_filters->>'dateTo');
  end if;

  if jsonb_typeof(p_filters->'months') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'months') as value
    where value ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$';
    if value_list is not null then
      where_clauses := where_clauses || format('month in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'isoweeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'isoweeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'weeknums') = 'array' then
    select string_agg(value::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeknums') as value
    where value ~ '^[0-9]{1,2}$'
      and value::integer between 1 and 53;
    if value_list is not null then
      where_clauses := where_clauses || format('weeknum in (%s)', value_list);
    end if;
  end if;

  if p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach column_name in array array[
    'airlines',
    'routes',
    'countries',
    'aircraft',
    'acGroups',
    'paxStatuses',
    'localBuckets30',
    'localBuckets60',
    'utcBuckets30',
    'utcBuckets60'
  ] loop
    if jsonb_typeof(p_filters->column_name) = 'array' then
      target_column := case column_name
        when 'airlines' then 'airline'
        when 'routes' then 'route'
        when 'countries' then 'country'
        when 'aircraft' then 'aircraft'
        when 'acGroups' then 'ac_group'
        when 'paxStatuses' then 'pax_status'
        when 'localBuckets30' then 'local_bucket_30'
        when 'localBuckets60' then 'local_bucket_60'
        when 'utcBuckets30' then 'utc_bucket_30'
        else 'utc_bucket_60'
      end;
      select string_agg(quote_literal(case when column_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
        into value_list
      from jsonb_array_elements_text(p_filters->column_name) as value
      where value <> '';
      if value_list is not null then
        where_clauses := where_clauses || format('%I in (%s)', target_column, value_list);
      end if;
    end if;
  end loop;

  if jsonb_typeof(p_filters->'localHourFrom') = 'number' then
    where_clauses := where_clauses || format('local_hour >= %s', least(greatest((p_filters->>'localHourFrom')::integer, 0), 23));
  end if;

  if jsonb_typeof(p_filters->'localHourTo') = 'number' then
    where_clauses := where_clauses || format('local_hour < %s', least(greatest((p_filters->>'localHourTo')::integer, 1), 24));
  end if;

  foreach column_name in array group_columns loop
    select_parts := select_parts || format('%I', column_name);
  end loop;

  foreach metric in array metric_columns loop
    select_parts := select_parts || case metric
      when 'flights' then 'count(*)::integer as flights'
      when 'pax' then 'coalesce(sum(pax), 0)::integer as pax'
      when 'arrivals' then 'count(*) filter (where type = ''A'')::integer as arrivals'
      when 'departures' then 'count(*) filter (where type = ''D'')::integer as departures'
    end;
  end loop;

  if array_length(group_columns, 1) is not null then
    group_clause := ' group by ' || array_to_string(array(select format('%I', entry) from unnest(group_columns) as entry), ', ');
  end if;

  if array_length(group_columns, 1) is null then
    row_count := 1;
  else
    execute format(
      'select count(*) from (select 1 from reporting.flight_operations where %s%s) grouped',
      array_to_string(where_clauses, ' and '),
      group_clause
    ) into row_count;
  end if;

  sql := format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select %s from reporting.flight_operations where %s%s order by %I %s limit %s) q',
    array_to_string(select_parts, ', '),
    array_to_string(where_clauses, ' and '),
    group_clause,
    order_column,
    order_direction,
    safe_limit
  );
  execute sql into result_rows;

  return jsonb_build_object(
    'columns', to_jsonb(group_columns || metric_columns),
    'rows', result_rows,
    'rowCount', row_count,
    'truncated', array_length(group_columns, 1) is not null and row_count > safe_limit
  );
end;
$$;

create or replace function public.dashboard_ai_query_aggregated(
  p_filters jsonb default '{}'::jsonb,
  p_group_by text[] default array[]::text[],
  p_metrics text[] default array['flights']::text[],
  p_order_by text default 'flights',
  p_order_dir text default 'desc',
  p_limit integer default 24
) returns jsonb
language sql
security invoker
set search_path = public, reporting
as $$
  select reporting.query_aggregated(
    p_filters,
    p_group_by,
    p_metrics,
    p_order_by,
    p_order_dir,
    p_limit
  );
$$;

create or replace function public.dashboard_ai_query_rows(
  p_view text default 'flight_operations',
  p_filters jsonb default '{}'::jsonb,
  p_columns text[] default array[]::text[],
  p_order_by text default 'ops_date',
  p_order_dir text default 'asc',
  p_limit integer default 100
) returns jsonb
language plpgsql
security invoker
set search_path = public, reporting
as $$
declare
  allowed_views constant text[] := array[
    'flight_operations',
    'summary_airline',
    'summary_country',
    'summary_route',
    'summary_month',
    'summary_week',
    'summary_peak_hour',
    'summary_aircraft',
    'summary_arr_dep_mix'
  ];
  allowed_columns constant text[] := array[
    'season_id',
    'season',
    'season_code',
    'iata_season_code',
    'record_id',
    'flight_series_id',
    'turnaround_id',
    'type',
    'flight',
    'airline',
    'route',
    'country',
    'aircraft',
    'ac_group',
    'pax',
    'pax_status',
    'pax_missing_after_1_day',
    'scheduled_date',
    'scheduled_time',
    'ops_date',
    'month',
    'iso_week',
    'isoweek',
    'weeknum',
    'local_hour',
    'utc_hour',
    'local_minutes',
    'utc_minutes',
    'local_bucket_30',
    'local_bucket_30_index',
    'local_bucket_60',
    'local_bucket_60_index',
    'utc_bucket_30',
    'utc_bucket_30_index',
    'utc_bucket_60',
    'utc_bucket_60_index',
    'weekday',
    'status',
    'gate',
    'stand',
    'carousel',
    'source_kind',
    'source_side',
    'flights',
    'arrivals',
    'departures'
  ];
  view_name text := case when p_view = any(allowed_views) then p_view else 'flight_operations' end;
  view_columns text[];
  selected_columns text[];
  where_clauses text[] := array['true'];
  order_column text;
  order_direction text := case when lower(coalesce(p_order_dir, 'asc')) = 'desc' then 'desc' else 'asc' end;
  safe_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  value_list text;
  filter_name text;
  target_column text;
  row_count integer := 0;
  result_rows jsonb := '[]'::jsonb;
  sql text;
begin
  select array_agg(c.column_name::text order by c.ordinal_position)
    into view_columns
  from information_schema.columns c
  where c.table_schema = 'reporting'
    and c.table_name = view_name
    and c.column_name = any(allowed_columns);

  if array_length(view_columns, 1) is null then
    return jsonb_build_object(
      'columns', '[]'::jsonb,
      'rows', '[]'::jsonb,
      'rowCount', 0,
      'truncated', false,
      'dataQualityMessages', jsonb_build_array(format('View reporting.%s has no allowed columns.', view_name))
    );
  end if;

  select coalesce(array_agg(distinct entry), array[]::text[])
    into selected_columns
  from unnest(coalesce(p_columns, array[]::text[])) as entry
  where entry = any(allowed_columns)
    and entry = any(view_columns);

  if array_length(selected_columns, 1) is null then
    selected_columns := view_columns;
  end if;

  order_column := case
    when p_order_by = any(view_columns) and p_order_by = any(allowed_columns) then p_order_by
    when 'ops_date' = any(view_columns) then 'ops_date'
    when 'flights' = any(view_columns) then 'flights'
    else selected_columns[1]
  end;

  if 'season_id' = any(view_columns) and jsonb_typeof(p_filters->'seasonIds') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'seasonIds') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('season_id in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'iataSeasonCodes') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'iataSeasonCodes') as value
    where value <> '';
    if value_list is not null then
      if 'season' = any(view_columns) and 'season_code' = any(view_columns) and 'iata_season_code' = any(view_columns) then
        where_clauses := where_clauses || format('(upper(season) in (%1$s) or upper(season_code) in (%1$s) or upper(iata_season_code) in (%1$s))', value_list);
      elsif 'season' = any(view_columns) then
        where_clauses := where_clauses || format('upper(season) in (%s)', value_list);
      end if;
    end if;
  end if;

  if 'ops_date' = any(view_columns) and p_filters ? 'dateFrom' and p_filters->>'dateFrom' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date >= %L', p_filters->>'dateFrom');
  end if;

  if 'ops_date' = any(view_columns) and p_filters ? 'dateTo' and p_filters->>'dateTo' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date <= %L', p_filters->>'dateTo');
  end if;

  if 'month' = any(view_columns) and jsonb_typeof(p_filters->'months') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'months') as value
    where value ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$';
    if value_list is not null then
      where_clauses := where_clauses || format('month in (%s)', value_list);
    end if;
  end if;

  if 'isoweek' = any(view_columns) and jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  elsif 'iso_week' = any(view_columns) and jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg((substring(value from 'W([0-9]{2})$'))::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('iso_week in (%s)', value_list);
    end if;
  end if;

  if 'isoweek' = any(view_columns) and jsonb_typeof(p_filters->'isoweeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'isoweeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if 'weeknum' = any(view_columns) and jsonb_typeof(p_filters->'weeknums') = 'array' then
    select string_agg(value::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeknums') as value
    where value ~ '^[0-9]{1,2}$'
      and value::integer between 1 and 53;
    if value_list is not null then
      where_clauses := where_clauses || format('weeknum in (%s)', value_list);
    end if;
  end if;

  if 'type' = any(view_columns) and p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach filter_name in array array[
    'airlines',
    'routes',
    'countries',
    'aircraft',
    'acGroups',
    'paxStatuses',
    'localBuckets30',
    'localBuckets60',
    'utcBuckets30',
    'utcBuckets60'
  ] loop
    if jsonb_typeof(p_filters->filter_name) = 'array' then
      target_column := case filter_name
        when 'airlines' then 'airline'
        when 'routes' then 'route'
        when 'countries' then 'country'
        when 'aircraft' then 'aircraft'
        when 'acGroups' then 'ac_group'
        when 'paxStatuses' then 'pax_status'
        when 'localBuckets30' then 'local_bucket_30'
        when 'localBuckets60' then 'local_bucket_60'
        when 'utcBuckets30' then 'utc_bucket_30'
        else 'utc_bucket_60'
      end;
      if target_column = any(view_columns) then
        select string_agg(quote_literal(case when filter_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
          into value_list
        from jsonb_array_elements_text(p_filters->filter_name) as value
        where value <> '';
        if value_list is not null then
          where_clauses := where_clauses || format('%I in (%s)', target_column, value_list);
        end if;
      end if;
    end if;
  end loop;

  if 'local_hour' = any(view_columns) and jsonb_typeof(p_filters->'localHourFrom') = 'number' then
    where_clauses := where_clauses || format('local_hour >= %s', least(greatest((p_filters->>'localHourFrom')::integer, 0), 23));
  end if;

  if 'local_hour' = any(view_columns) and jsonb_typeof(p_filters->'localHourTo') = 'number' then
    where_clauses := where_clauses || format('local_hour < %s', least(greatest((p_filters->>'localHourTo')::integer, 1), 24));
  end if;

  execute format(
    'select count(*) from reporting.%I where %s',
    view_name,
    array_to_string(where_clauses, ' and ')
  ) into row_count;

  sql := format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select %s from reporting.%I where %s order by %I %s limit %s) q',
    array_to_string(array(select format('%I', entry) from unnest(selected_columns) as entry), ', '),
    view_name,
    array_to_string(where_clauses, ' and '),
    order_column,
    order_direction,
    safe_limit
  );
  execute sql into result_rows;

  return jsonb_build_object(
    'columns', to_jsonb(selected_columns),
    'rows', result_rows,
    'rowCount', row_count,
    'truncated', row_count > safe_limit
  );
end;
$$;

alter view reporting.effective_flight_operations set (security_invoker = true);
alter view reporting.flight_operations set (security_invoker = true);
alter view reporting.summary_airline set (security_invoker = true);
alter view reporting.summary_country set (security_invoker = true);
alter view reporting.summary_route set (security_invoker = true);
alter view reporting.summary_month set (security_invoker = true);
alter view reporting.summary_week set (security_invoker = true);
alter view reporting.summary_peak_hour set (security_invoker = true);
alter view reporting.summary_aircraft set (security_invoker = true);
alter view reporting.summary_arr_dep_mix set (security_invoker = true);

grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;

create index if not exists season_flight_records_workspace_keyset_idx
  on public.season_flight_records (
    season_id,
    (coalesce(nullif(operational_date, ''), nullif(scheduled_date, ''), nullif(date, ''), '')),
    record_id
  );

create index if not exists season_modification_added_legs_workspace_keyset_idx
  on public.season_modification_added_legs (
    season_id,
    (coalesce(nullif(operational_date, ''), nullif(scheduled_date, ''), nullif(date, ''), '')),
    leg_id
  );

create or replace function public.get_season_schedule_allocation_window_v2(
  p_season_id text,
  p_start_date text default null,
  p_end_date text default null,
  p_resource_type text default 'all',
  p_page_size integer default 500,
  p_after_effective_date text default null,
  p_after_root_id text default null,
  p_after_root_kind smallint default null,
  p_expected_data_version integer default null,
  p_expected_server_high_water bigint default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_data_version integer;
  current_server_high_water bigint;
  has_more boolean;
  returned_count integer;
  next_effective_date text;
  next_root_id text;
  next_root_kind smallint;
  result jsonb;
begin
  if p_season_id is null or btrim(p_season_id) = '' then
    raise exception 'p_season_id is required' using errcode = '22023';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 1000 then
    raise exception 'p_page_size must be between 1 and 1000' using errcode = '22023';
  end if;
  if coalesce(p_resource_type, 'all') not in ('all', 'schedule', 'gate', 'checkin', 'stand', 'counter', 'carousel') then
    raise exception 'unsupported p_resource_type: %', p_resource_type using errcode = '22023';
  end if;
  if (p_start_date is not null and (
        p_start_date !~ '^\d{4}-\d{2}-\d{2}$'
        or to_char(to_date(p_start_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> p_start_date
      ))
     or (p_end_date is not null and (
        p_end_date !~ '^\d{4}-\d{2}-\d{2}$'
        or to_char(to_date(p_end_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> p_end_date
      )) then
    raise exception 'date bounds must use valid YYYY-MM-DD values' using errcode = '22007';
  end if;
  if p_start_date is not null and p_end_date is not null and p_start_date > p_end_date then
    raise exception 'p_start_date must not exceed p_end_date' using errcode = '22023';
  end if;
  if num_nonnulls(p_after_effective_date, p_after_root_id, p_after_root_kind) not in (0, 3) then
    raise exception 'all keyset cursor fields must be null or non-null together' using errcode = '22023';
  end if;
  if p_after_root_kind is not null and p_after_root_kind not in (0, 1) then
    raise exception 'p_after_root_kind must be 0 or 1' using errcode = '22023';
  end if;
  if num_nonnulls(p_expected_data_version, p_expected_server_high_water) not in (0, 2) then
    raise exception 'both expected snapshot fields must be null or non-null together' using errcode = '22023';
  end if;

  select s.data_version
  into current_data_version
  from public.seasons s
  where s.id = p_season_id;

  if current_data_version is null then
    raise exception 'Season % not found', p_season_id using errcode = 'P0002';
  end if;

  select coalesce(max(e.server_seq), 0)::bigint
  into current_server_high_water
  from public.season_change_events e
  where e.season_id = p_season_id;

  if p_expected_data_version is not null and (
    p_expected_data_version <> current_data_version
    or p_expected_server_high_water <> current_server_high_water
  ) then
    return jsonb_build_object(
      'status', 'snapshot_changed',
      'snapshot', jsonb_build_object(
        'dataVersion', current_data_version,
        'serverHighWater', current_server_high_water
      )
    );
  end if;

  with root_candidates as materialized (
    -- bounded_root_candidates_v2: each indexed branch is limited before the bounded merge.
    select roots.*
    from (
      (
        select
          coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') as effective_date,
          r.record_id as root_id,
          0::smallint as root_kind
        from public.season_flight_records r
        where r.season_id = p_season_id
          and (p_start_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') >= p_start_date)
          and (p_end_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') <= p_end_date)
          -- cursor_index_range_v2: start at the two-column index key, then filter root-kind equality.
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id
            ) >= (p_after_effective_date, p_after_root_id))
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id
            ) <> (p_after_effective_date, p_after_root_id)
            or 0::smallint > p_after_root_kind)
        order by effective_date, root_id
        limit p_page_size + 1
      )

      union all

      (
        select
          coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') as effective_date,
          a.leg_id as root_id,
          1::smallint as root_kind
        from public.season_modification_added_legs a
        where a.season_id = p_season_id
          and (p_start_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') >= p_start_date)
          and (p_end_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') <= p_end_date)
          -- cursor_index_range_v2: start at the two-column index key, then filter root-kind equality.
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id
            ) >= (p_after_effective_date, p_after_root_id))
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id
            ) <> (p_after_effective_date, p_after_root_id)
            or 1::smallint > p_after_root_kind)
        order by effective_date, root_id
        limit p_page_size + 1
      )
    ) roots
    order by roots.effective_date, roots.root_id, roots.root_kind
    limit p_page_size + 1
  ),
  page_with_sentinel as materialized (
    select roots.*
    from root_candidates roots
    order by roots.effective_date, roots.root_id, roots.root_kind
  ),
  selected_roots as materialized (
    select roots.*
    from page_with_sentinel roots
    order by roots.effective_date, roots.root_id, roots.root_kind
    limit p_page_size
  ),
  selected_base_ids as materialized (
    select root_id from selected_roots where root_kind = 0
  ),
  selected_added_ids as materialized (
    select root_id from selected_roots where root_kind = 1
  ),
  selected_modification_ids as materialized (
    select root_id from selected_roots
  ),
  flight_record_rows as materialized (
    select r.*
    from public.season_flight_records r
    join selected_base_ids ids on ids.root_id = r.record_id
    where r.season_id = p_season_id
  ),
  modification_rows as materialized (
    select m.*
    from public.season_modifications m
    join selected_modification_ids ids on ids.root_id = m.leg_id
    where m.season_id = p_season_id
  ),
  added_leg_rows as materialized (
    select a.*
    from public.season_modification_added_legs a
    join selected_added_ids ids on ids.root_id = a.leg_id
    where a.season_id = p_season_id
  ),
  page_metadata as (
    select
      (select count(*) > p_page_size from page_with_sentinel) as has_more,
      (select count(*)::integer from selected_roots) as returned_count,
      (select effective_date from selected_roots order by effective_date desc, root_id desc, root_kind desc limit 1) as next_effective_date,
      (select root_id from selected_roots order by effective_date desc, root_id desc, root_kind desc limit 1) as next_root_id,
      (select root_kind from selected_roots order by effective_date desc, root_id desc, root_kind desc limit 1) as next_root_kind
  )
  select
    metadata.has_more,
    metadata.returned_count,
    metadata.next_effective_date,
    metadata.next_root_id,
    metadata.next_root_kind,
    jsonb_build_object(
      'status', 'ok',
      'seasonId', p_season_id,
      'startDate', p_start_date,
      'endDate', p_end_date,
      'resourceType', coalesce(p_resource_type, 'all'),
      'snapshot', jsonb_build_object(
        'dataVersion', current_data_version,
        'serverHighWater', current_server_high_water
      ),
      'page', jsonb_build_object(
        'returnedCount', metadata.returned_count,
        'hasMore', metadata.has_more,
        'nextCursor', case when metadata.has_more then jsonb_build_object(
          'effectiveDate', metadata.next_effective_date,
          'rootId', metadata.next_root_id,
          'rootKind', metadata.next_root_kind
        ) else null end
      ),
      'flightRecords', coalesce((select jsonb_agg(to_jsonb(r) order by r.operational_date, r.record_id) from flight_record_rows r), '[]'::jsonb),
      'flightRecordCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.record_id, c.counter_group, c.item_index) from public.season_flight_record_counters c where c.record_id in (select root_id from selected_base_ids)), '[]'::jsonb),
      'flightRecordWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.record_id, w.counter_key) from public.season_flight_record_checkin_windows w where w.record_id in (select root_id from selected_base_ids)), '[]'::jsonb),
      'modifications', coalesce((select jsonb_agg(to_jsonb(m) order by m.leg_id) from modification_rows m), '[]'::jsonb),
      'modificationCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.leg_id, c.counter_group, c.item_index) from public.season_modification_counters c where c.leg_id in (select root_id from selected_modification_ids)), '[]'::jsonb),
      'modificationWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.leg_id, w.counter_key) from public.season_modification_checkin_windows w where w.leg_id in (select root_id from selected_modification_ids)), '[]'::jsonb),
      'modificationAddedLegs', coalesce((select jsonb_agg(to_jsonb(a) order by a.leg_id) from added_leg_rows a), '[]'::jsonb)
    )
  into has_more, returned_count, next_effective_date, next_root_id, next_root_kind, result
  from page_metadata metadata;

  return result;
end;
$$;

revoke execute on function public.get_season_schedule_allocation_window_v2(text, text, text, text, integer, text, text, smallint, integer, bigint) from public;
revoke execute on function public.get_season_schedule_allocation_window_v2(text, text, text, text, integer, text, text, smallint, integer, bigint) from anon;
grant execute on function public.get_season_schedule_allocation_window_v2(text, text, text, text, integer, text, text, smallint, integer, bigint) to authenticated;
grant execute on function public.get_season_schedule_allocation_window_v2(text, text, text, text, integer, text, text, smallint, integer, bigint) to service_role;

create table if not exists public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  client_id text not null,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  uploaded_at bigint not null default 0,
  checksum text not null,
  status text not null check (status in ('staged', 'validated', 'committed', 'failed')),
  source_row_count integer not null default 0,
  generated_record_count integer not null default 0,
  diagnostics jsonb not null default '[]'::jsonb,
  result jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create table if not exists public.season_import_batch_rows (
  batch_id uuid not null references public.season_import_batches(batch_id) on delete cascade,
  row_index integer not null,
  row_data jsonb not null,
  primary key (batch_id, row_index)
);

create index if not exists idx_season_flight_records_occurrence_lookup
  on public.season_flight_records (season_id, scheduled_date, airline, flight_number, type);
create index if not exists idx_season_flight_records_operational_date
  on public.season_flight_records (season_id, operational_date);
create index if not exists idx_season_flight_records_turnaround
  on public.season_flight_records (season_id, turnaround_id)
  where turnaround_id is not null;

alter table public.season_import_batches enable row level security;
alter table public.season_import_batch_rows enable row level security;
revoke all on public.season_import_batches from anon, authenticated;
revoke all on public.season_import_batch_rows from anon, authenticated;

create or replace function public.normalize_seasonal_flight_number_v2(p_airline text, p_raw text)
returns table (flight_number text, raw_flight_number text)
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select
      upper(regexp_replace(coalesce(p_airline, ''), '[^A-Za-z0-9]', '', 'g')) as airline,
      upper(regexp_replace(coalesce(p_raw, ''), '\s+', '', 'g')) as raw_value
  ), stripped as (
    select airline, raw_value,
      case when airline <> '' and raw_value like airline || '%' then substr(raw_value, length(airline) + 1) else raw_value end as suffix
    from normalized
  )
  select
    airline || case when suffix ~ '^\d+$' then lpad(suffix, 3, '0') else suffix end,
    raw_value
  from stripped
$$;

create or replace function public.seasonal_operational_date_v2(p_scheduled_date date, p_schedule time)
returns date
language sql
immutable
as $$
  select case when p_schedule < time '05:00' then p_scheduled_date - 1 else p_scheduled_date end
$$;

create or replace function public.seasonal_record_id_v2(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
) returns text
language sql
immutable
as $$
  select 'LEG_' || upper(p_type) || '_' || to_char(p_scheduled_date, 'YYYY-MM-DD') || '_' || substr(md5(
    coalesce(p_season_id, '') || '|' || upper(p_type) || '|' || p_scheduled_date::text || '|' || upper(p_airline) || '|' || upper(p_flight_number)
  ), 1, 20)
$$;

create or replace function public.generate_seasonal_import_records_v2(p_batch_id uuid)
returns table (
  record_id text,
  occurrence_key text,
  link_id text,
  type text,
  airline text,
  flight_number text,
  raw_flight_number text,
  route text,
  schedule text,
  aircraft text,
  category text,
  code_shares text,
  int_dom_ind text,
  scheduled_date text,
  operational_date text,
  day_of_week integer,
  source_row_index integer,
  linked_source_row_index integer,
  link_type text,
  pair_anchor_date text,
  linked_record_id text,
  turnaround_id text
)
language sql
stable
security definer
set search_path = public
as $$
  with batch as (
    select b.batch_id, coalesce(b.season_id, 'pending:' || b.batch_id::text) as identity_season_id
    from public.season_import_batches b where b.batch_id = p_batch_id
  ), canonical_rows as (
    select r.batch_id, r.row_index, r.row_data,
      case when r.row_data->>'effective' ~ '^\d{4}-\d{2}-\d{2}$' then (r.row_data->>'effective')::date else to_date(r.row_data->>'effective', 'DD-Mon-YY') end as effective_date,
      case when r.row_data->>'discontinue' ~ '^\d{4}-\d{2}-\d{2}$' then (r.row_data->>'discontinue')::date else to_date(r.row_data->>'discontinue', 'DD-Mon-YY') end as discontinue_date
    from public.season_import_batch_rows r where r.batch_id = p_batch_id
  ), operating_days as (
    select rows.*, day_value::date as anchor_date
    from canonical_rows rows
    cross join lateral generate_series(rows.effective_date, rows.discontinue_date, interval '1 day') day_value
    where coalesce((rows.row_data->'daysOfWeek'->>(extract(isodow from day_value)::integer - 1))::boolean, false)
  ), side_expansion as (
    select days.*,
      side.side_name,
      side.type,
      side.schedule,
      side.raw_flight,
      side.route,
      side.category,
      side.code_shares,
      side.int_dom_ind,
      case
        when side.type = 'D'
          and nullif(days.row_data->>'arrFlight', '') is not null
          and coalesce(nullif(days.row_data->>'linkType', ''),
            case when (days.row_data->>'std')::time < (days.row_data->>'sta')::time then 'overnight' else 'sameday' end
          ) = 'overnight'
        then days.anchor_date + 1
        else days.anchor_date
      end as scheduled_day,
      coalesce(
        nullif(days.row_data->>'linkType', ''),
        case when nullif(days.row_data->>'arrFlight', '') is not null and nullif(days.row_data->>'depFlight', '') is not null
          then case when (days.row_data->>'std')::time < (days.row_data->>'sta')::time then 'overnight' else 'sameday' end
          else null end
      ) as resolved_link_type,
      case
        when nullif(days.row_data->>'arrFlight', '') is not null and nullif(days.row_data->>'depFlight', '') is not null then days.row_index
        when nullif(days.row_data->>'overnightLinkRowIndex', '') is not null then least(days.row_index, (days.row_data->>'overnightLinkRowIndex')::integer)
        else null
      end as link_group
    from operating_days days
    cross join lateral (
      values
        ('ARR', 'A', days.row_data->>'sta', days.row_data->>'arrFlight', days.row_data->>'arrRoute', days.row_data->>'arrFlightCategory', days.row_data->>'arrCodeShares', days.row_data->>'arrIntDomInd'),
        ('DEP', 'D', days.row_data->>'std', days.row_data->>'depFlight', days.row_data->>'depRoute', days.row_data->>'depFlightCategory', days.row_data->>'depCodeShares', days.row_data->>'depIntDomInd')
    ) side(side_name, type, schedule, raw_flight, route, category, code_shares, int_dom_ind)
    where nullif(side.raw_flight, '') is not null and nullif(side.schedule, '') is not null
  ), normalized as (
    select sides.*, numbers.flight_number, numbers.raw_flight_number,
      upper(regexp_replace(sides.row_data->>'airline', '[^A-Za-z0-9]', '', 'g')) as airline,
      (sides.schedule)::time as schedule_time
    from side_expansion sides
    cross join lateral public.normalize_seasonal_flight_number_v2(sides.row_data->>'airline', sides.raw_flight) numbers
  ), identified as (
    select normalized.*,
      public.seasonal_record_id_v2(batch.identity_season_id, normalized.type, normalized.scheduled_day, normalized.airline, normalized.flight_number) as generated_id,
      normalized.type || '|' || normalized.scheduled_day::text || '|' || normalized.airline || '|' || normalized.flight_number as generated_occurrence_key,
      case when normalized.link_group is null then '' else 'PAIR_' || substr(md5(batch.identity_season_id || '|' || normalized.anchor_date::text || '|' || normalized.link_group::text), 1, 20) end as generated_link_id,
      case when normalized.link_group is null then null else 'TRN_' || substr(md5(batch.identity_season_id || '|' || normalized.anchor_date::text || '|' || normalized.link_group::text), 1, 20) end as generated_turnaround_id
    from normalized cross join batch
  )
  select
    identified.generated_id,
    identified.generated_occurrence_key,
    identified.generated_link_id,
    identified.type,
    identified.airline,
    identified.flight_number,
    identified.raw_flight_number,
    coalesce(identified.route, ''),
    identified.schedule,
    coalesce(identified.row_data->>'aircraft', ''),
    coalesce(identified.category, 'PAX'),
    nullif(identified.code_shares, ''),
    nullif(identified.int_dom_ind, ''),
    identified.scheduled_day::text,
    public.seasonal_operational_date_v2(identified.scheduled_day, identified.schedule_time)::text,
    extract(isodow from identified.scheduled_day)::integer,
    identified.row_index,
    nullif(identified.row_data->>'overnightLinkRowIndex', '')::integer,
    identified.resolved_link_type,
    identified.anchor_date::text,
    counterpart.generated_id,
    identified.generated_turnaround_id
  from identified
  left join identified counterpart
    on counterpart.anchor_date = identified.anchor_date
   and counterpart.link_group = identified.link_group
   and counterpart.type <> identified.type
   and identified.link_group is not null
$$;

create or replace function public.stage_seasonal_import_v2(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_batch public.season_import_batches%rowtype;
  staged_batch public.season_import_batches%rowtype;
  diagnostics jsonb := '[]'::jsonb;
  duplicate_diagnostics jsonb := '[]'::jsonb;
  generated_count integer := 0;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.write') then
    raise exception 'seasonal.write permission required' using errcode = '42501';
  end if;
  if nullif(p_import->>'requestId', '') is null
     or nullif(p_import->>'clientId', '') is null
     or nullif(p_import->>'checksum', '') is null
     or nullif(p_import->>'seasonCode', '') is null
     or jsonb_typeof(p_import->'sourceRows') <> 'array'
     or jsonb_array_length(p_import->'sourceRows') = 0 then
    raise exception 'requestId, clientId, checksum, seasonCode, and non-empty sourceRows are required' using errcode = '22023';
  end if;

  select * into existing_batch from public.season_import_batches where request_id = (p_import->>'requestId')::uuid;
  if found then
    if existing_batch.checksum <> p_import->>'checksum' then
      raise exception 'requestId was already used with a different checksum' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'batchId', existing_batch.batch_id, 'status', existing_batch.status,
      'sourceRowCount', existing_batch.source_row_count, 'diagnostics', existing_batch.diagnostics,
      'generatedCount', existing_batch.generated_record_count,
      'duplicateCount', (select count(*) from jsonb_array_elements(existing_batch.diagnostics) item where item->>'code' = 'duplicate-occurrence'),
      'valid', existing_batch.status in ('validated', 'committed')
    );
  end if;

  insert into public.season_import_batches (
    request_id, client_id, season_id, season_code, expected_data_version, file_name, uploaded_at,
    checksum, status, source_row_count, created_by
  ) values (
    (p_import->>'requestId')::uuid, p_import->>'clientId', nullif(p_import->>'seasonId', ''), upper(p_import->>'seasonCode'),
    nullif(p_import->>'expectedDataVersion', '')::integer, coalesce(p_import->>'fileName', ''), coalesce((p_import->>'uploadedAt')::bigint, 0),
    p_import->>'checksum', 'staged', jsonb_array_length(p_import->'sourceRows'), auth.uid()
  ) returning * into staged_batch;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select staged_batch.batch_id, coalesce((row_value->>'rowIndex')::integer, ordinal::integer), row_value
  from jsonb_array_elements(p_import->'sourceRows') with ordinality rows(row_value, ordinal);

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', 'invalid-source-row', 'rowIndex', rows.row_index,
    'message', 'Required canonical source-row fields are missing or invalid.'
  ) order by rows.row_index), '[]'::jsonb)
  into diagnostics
  from public.season_import_batch_rows rows
  where rows.batch_id = staged_batch.batch_id
    and (
      nullif(rows.row_data->>'effective', '') is null
      or nullif(rows.row_data->>'discontinue', '') is null
      or nullif(rows.row_data->>'airline', '') is null
      or nullif(rows.row_data->>'aircraft', '') is null
      or jsonb_typeof(rows.row_data->'daysOfWeek') <> 'array'
      or jsonb_array_length(rows.row_data->'daysOfWeek') <> 7
      or (
        nullif(rows.row_data->>'arrFlight', '') is null
        and nullif(rows.row_data->>'depFlight', '') is null
      )
    );

  if jsonb_array_length(diagnostics) = 0 then
    select count(*) into generated_count from public.generate_seasonal_import_records_v2(staged_batch.batch_id);
    select coalesce(jsonb_agg(jsonb_build_object(
      'code', 'duplicate-occurrence', 'occurrenceKey', duplicates.occurrence_key,
      'message', 'Multiple source rows generate the same flight occurrence.'
    )), '[]'::jsonb)
    into duplicate_diagnostics
    from (
      select occurrence_key from public.generate_seasonal_import_records_v2(staged_batch.batch_id)
      group by occurrence_key having count(*) > 1
    ) duplicates;
    diagnostics := diagnostics || duplicate_diagnostics;
    if generated_count = 0 then
      diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code', 'zero-generated-records', 'message', 'Source rows generate no flights.'));
    end if;
  end if;

  update public.season_import_batches
  set generated_record_count = generated_count,
      diagnostics = diagnostics,
      status = case when jsonb_array_length(diagnostics) = 0 then 'validated' else 'failed' end
  where batch_id = staged_batch.batch_id
  returning * into staged_batch;

  return jsonb_build_object(
    'batchId', staged_batch.batch_id, 'status', staged_batch.status,
    'sourceRowCount', staged_batch.source_row_count, 'diagnostics', staged_batch.diagnostics,
    'generatedCount', staged_batch.generated_record_count,
    'duplicateCount', (select count(*) from jsonb_array_elements(staged_batch.diagnostics) item where item->>'code' = 'duplicate-occurrence'),
    'valid', staged_batch.status = 'validated'
  );
end;
$$;

create or replace function public.commit_seasonal_import_v2(p_batch_id uuid, p_expected_data_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch public.season_import_batches%rowtype;
  season_row public.seasons%rowtype;
  next_version integer;
  server_high_water bigint;
  removed_count integer := 0;
  preserved_count integer := 0;
  committed_source_count integer;
  committed_record_count integer;
  success_result jsonb;
  created_new_season boolean := false;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.write') then
    raise exception 'seasonal.write permission required' using errcode = '42501';
  end if;
  select * into batch from public.season_import_batches where batch_id = p_batch_id for update;
  if not found then raise exception 'Import batch % not found', p_batch_id using errcode = 'P0002'; end if;
  if batch.status = 'committed' then return batch.result; end if;
  if batch.status <> 'validated' or jsonb_array_length(batch.diagnostics) > 0 then
    raise exception 'Import batch % is not validated', p_batch_id using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(coalesce(batch.season_id, batch.season_code), 0));
  if batch.season_id is null then
    created_new_season := true;
    insert into public.seasons (
      season_code, name, file_name, uploaded_at, effective_start, effective_end,
      total_legs, total_source_rows, data_version, last_synced_at
    ) values (batch.season_code, batch.season_code, batch.file_name, batch.uploaded_at, '', '', 0, 0, 0, batch.uploaded_at)
    returning * into season_row;
    update public.season_import_batches set season_id = season_row.id where batch_id = p_batch_id;
    batch.season_id := season_row.id;
  else
    select * into season_row from public.seasons where id = batch.season_id for update;
    if not found then raise exception 'Season % not found', batch.season_id using errcode = 'P0002'; end if;
  end if;
  if not created_new_season and p_expected_data_version is distinct from season_row.data_version then
    raise exception 'Season data version changed from % to %', p_expected_data_version, season_row.data_version using errcode = '40001';
  end if;

  drop table if exists pg_temp.import_generated_records;
  create temporary table import_generated_records on commit drop as
    select * from public.generate_seasonal_import_records_v2(p_batch_id);
  create unique index on import_generated_records(occurrence_key);

  if exists (
    select 1 from import_generated_records generated
    join public.season_flight_records existing
      on existing.season_id = batch.season_id and existing.source_kind = 'added'
     and existing.type = generated.type and existing.date = generated.scheduled_date
     and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number
  ) then
    raise exception 'Manual-added flight collides with imported occurrence' using errcode = '23505';
  end if;

  if exists (
    select 1 from import_generated_records generated
    join public.season_flight_records existing
      on existing.season_id = batch.season_id and existing.source_kind = 'imported'
     and existing.type = generated.type and existing.date = generated.scheduled_date
     and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number
    group by generated.occurrence_key having count(*) > 1
  ) then
    raise exception 'Ambiguous legacy imported occurrence match' using errcode = '23505';
  end if;

  update import_generated_records generated
  set record_id = existing.record_id
  from public.season_flight_records existing
  where existing.season_id = batch.season_id and existing.source_kind = 'imported'
    and existing.type = generated.type and existing.date = generated.scheduled_date
    and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number;

  update import_generated_records generated
  set linked_record_id = counterpart.record_id
  from import_generated_records counterpart
  where generated.turnaround_id is not null and counterpart.turnaround_id = generated.turnaround_id and counterpart.type <> generated.type;

  select count(*) into preserved_count
  from import_generated_records generated
  join public.season_flight_records existing on existing.record_id = generated.record_id;

  delete from public.season_modifications modifications
  using import_generated_records generated
  where modifications.leg_id = generated.record_id
    and modifications.action in ('deleted', 'modified')
    and not (modifications.changed_fields && array['gate','stand','counter','carousel','mct','fb','lb','bhs','ghs','checkInStart','checkInEnd','checkInAllocationMode']);

  update public.season_modifications modifications
  set changed_fields = array(
    select field from unnest(modifications.changed_fields) field
    where field = any(array['gate','stand','counter','carousel','mct','fb','lb','bhs','ghs','checkInStart','checkInEnd','checkInAllocationMode'])
  ), action = 'modified', schedule = null, aircraft = null, route = null, code_shares = null
  where modifications.leg_id in (select record_id from import_generated_records)
    and modifications.action = 'modified';

  delete from public.season_flight_records existing
  where existing.season_id = batch.season_id and existing.source_kind = 'imported'
    and not exists (select 1 from import_generated_records generated where generated.record_id = existing.record_id);
  get diagnostics removed_count = row_count;

  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, code_shares, int_dom_ind, date, scheduled_date,
    scheduled_time, operational_date, day_of_week, source_row_index, linked_source_row_index,
    link_type, pair_anchor_date, linked_record_id, source_kind, source_side, status, turnaround_id
  )
  select batch.season_id, generated.record_id, generated.link_id, generated.type, generated.airline,
    generated.flight_number, generated.raw_flight_number, generated.route, generated.schedule,
    generated.aircraft, generated.category, generated.code_shares, generated.int_dom_ind,
    generated.scheduled_date, generated.scheduled_date, generated.schedule, generated.operational_date,
    generated.day_of_week, generated.source_row_index, generated.linked_source_row_index,
    generated.link_type, generated.pair_anchor_date, generated.linked_record_id, 'imported',
    case when generated.type = 'A' then 'ARR' else 'DEP' end, 'active', generated.turnaround_id
  from import_generated_records generated
  on conflict (record_id) do update set
    link_id = excluded.link_id, type = excluded.type, airline = excluded.airline,
    flight_number = excluded.flight_number, raw_flight_number = excluded.raw_flight_number,
    route = excluded.route, schedule = excluded.schedule, aircraft = excluded.aircraft,
    category = excluded.category, code_shares = excluded.code_shares, int_dom_ind = excluded.int_dom_ind,
    date = excluded.date, scheduled_date = excluded.scheduled_date, scheduled_time = excluded.scheduled_time,
    operational_date = excluded.operational_date, day_of_week = excluded.day_of_week,
    source_row_index = excluded.source_row_index, linked_source_row_index = excluded.linked_source_row_index,
    link_type = excluded.link_type, pair_anchor_date = excluded.pair_anchor_date,
    linked_record_id = excluded.linked_record_id, source_kind = 'imported', status = 'active', turnaround_id = excluded.turnaround_id;

  delete from public.season_source_rows where season_id = batch.season_id;
  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft, sta, arr_flight, arr_route,
    arr_category, arr_code_shares, arr_int_dom_ind, std, dep_flight, dep_route, dep_category,
    dep_code_shares, dep_int_dom_ind, overnight_link_row_index, link_type
  )
  select batch.season_id, rows.row_index, rows.row_data->>'effective', rows.row_data->>'discontinue',
    rows.row_data->>'airline', rows.row_data->>'aircraft', nullif(rows.row_data->>'sta',''), nullif(rows.row_data->>'arrFlight',''),
    nullif(rows.row_data->>'arrRoute',''), nullif(rows.row_data->>'arrFlightCategory',''), nullif(rows.row_data->>'arrCodeShares',''),
    nullif(rows.row_data->>'arrIntDomInd',''), nullif(rows.row_data->>'std',''), nullif(rows.row_data->>'depFlight',''),
    nullif(rows.row_data->>'depRoute',''), nullif(rows.row_data->>'depFlightCategory',''), nullif(rows.row_data->>'depCodeShares',''),
    nullif(rows.row_data->>'depIntDomInd',''), nullif(rows.row_data->>'overnightLinkRowIndex','')::integer,
    nullif(rows.row_data->>'linkType','')
  from public.season_import_batch_rows rows where rows.batch_id = p_batch_id;

  insert into public.season_source_row_days (season_id, row_index, iso_dow)
  select batch.season_id, rows.row_index, day_index
  from public.season_import_batch_rows rows
  cross join generate_series(1, 7) day_index
  where rows.batch_id = p_batch_id and coalesce((rows.row_data->'daysOfWeek'->>(day_index - 1))::boolean, false);

  next_version := season_row.data_version + 1;
  update public.seasons
  set season_code = batch.season_code, file_name = batch.file_name, uploaded_at = batch.uploaded_at,
      effective_start = coalesce((select min(scheduled_date) from import_generated_records), ''),
      effective_end = coalesce((select max(scheduled_date) from import_generated_records), ''),
      total_legs = (select count(*) from import_generated_records), total_source_rows = batch.source_row_count,
      data_version = next_version, last_synced_at = batch.uploaded_at
  where id = batch.season_id;

  insert into public.season_change_events (
    season_id, client_id, op_id, actor_user_id, target_type, target_id, changed_fields, op_payload
  ) values (
    batch.season_id, batch.client_id, batch.request_id::text, auth.uid(), 'season', batch.season_id,
    array['import'], jsonb_build_object('kind', 'seasonal-import-v2', 'batchId', batch.batch_id)
  ) returning server_seq into server_high_water;

  select count(*) into committed_source_count from public.season_source_rows where season_id = batch.season_id;
  select count(*) into committed_record_count from public.season_flight_records where season_id = batch.season_id and source_kind = 'imported';
  if committed_source_count <> batch.source_row_count or committed_record_count <> batch.generated_record_count then
    raise exception 'Import read-back verification failed: source %/% records %/%',
      committed_source_count, batch.source_row_count, committed_record_count, batch.generated_record_count;
  end if;

  success_result := jsonb_build_object(
    'batchId', batch.batch_id, 'seasonId', batch.season_id, 'seasonCode', batch.season_code,
    'status', 'committed', 'sourceRowCount', committed_source_count,
    'flightRecordCount', committed_record_count, 'preservedOperationalCount', preserved_count,
    'removedImportedCount', removed_count, 'dataVersion', next_version,
    'serverHighWater', server_high_water, 'checksum', batch.checksum
  );
  update public.season_import_batches
  set status = 'committed', result = success_result, committed_at = now()
  where batch_id = p_batch_id;
  return success_result;
end;
$$;

revoke execute on function public.stage_seasonal_import_v2(jsonb) from public, anon;
revoke execute on function public.commit_seasonal_import_v2(uuid, integer) from public, anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated, service_role;
grant execute on function public.commit_seasonal_import_v2(uuid, integer) to authenticated, service_role;

create or replace function public.get_seasonal_export_snapshot_v2(
  p_season_id text,
  p_expected_data_version integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version integer;
  current_high_water bigint;
  snapshot jsonb;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.read') then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  select data_version into current_version
  from public.seasons
  where id = p_season_id
  for share;
  if not found then
    raise exception 'Season % not found', p_season_id using errcode = 'P0002';
  end if;
  if p_expected_data_version is distinct from current_version then
    raise exception 'Season data version changed from % to %', p_expected_data_version, current_version using errcode = '40001';
  end if;

  select coalesce(max(server_seq), 0) into current_high_water
  from public.season_change_events
  where season_id = p_season_id;

  with flight_record_rows as (
    select r.* from public.season_flight_records r
    where r.season_id = p_season_id order by r.record_id
  ), flight_record_ids as (
    select record_id from flight_record_rows
  ), modification_rows as (
    select m.* from public.season_modifications m
    where m.season_id = p_season_id
      and (
        m.leg_id in (select record_id from flight_record_ids)
        or (m.action = 'added' and exists (
          select 1 from public.season_modification_added_legs al
          where al.season_id = p_season_id and al.leg_id = m.leg_id
        ))
      )
    order by m.leg_id
  ), modification_leg_ids as (
    select leg_id from modification_rows
  )
  select jsonb_build_object(
    'seasonId', p_season_id,
    'dataVersion', current_version,
    'serverHighWater', current_high_water,
    'totalCount', (select count(*) from flight_record_rows),
    'truncated', false,
    'flightRecords', coalesce((select jsonb_agg(to_jsonb(r) order by r.record_id) from flight_record_rows r), '[]'::jsonb),
    'flightRecordCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.record_id, c.counter_group, c.item_index) from public.season_flight_record_counters c where c.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'flightRecordWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.record_id, w.counter_key) from public.season_flight_record_checkin_windows w where w.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'modifications', coalesce((select jsonb_agg(to_jsonb(m) order by m.leg_id) from modification_rows m), '[]'::jsonb),
    'modificationCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.leg_id, c.counter_group, c.item_index) from public.season_modification_counters c where c.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.leg_id, w.counter_key) from public.season_modification_checkin_windows w where w.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationAddedLegs', coalesce((select jsonb_agg(to_jsonb(al) order by al.leg_id) from public.season_modification_added_legs al where al.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb)
  ) into snapshot;

  return snapshot;
end;
$$;

revoke execute on function public.get_seasonal_export_snapshot_v2(text, integer) from public, anon;
grant execute on function public.get_seasonal_export_snapshot_v2(text, integer) to authenticated, service_role;


revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from anon;
grant execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seasonal_bi_reader') then
    grant usage on schema reporting to seasonal_bi_reader;
    grant select on all tables in schema reporting to seasonal_bi_reader;
  end if;
end $$;

do $$
declare
  table_name text;
  table_names text[] := array[
    'app_operators',
    'seasons',
    'season_source_rows',
    'season_source_row_days',
    'season_flight_records',
    'season_flight_record_counters',
    'season_flight_record_checkin_windows',
    'season_modifications',
    'season_modification_counters',
    'season_modification_checkin_windows',
    'season_modification_added_legs',
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes',
    'season_change_events',
    'schedule_notification_deliveries',
    'season_entity_versions',
    'operational_settings',
    'operational_route_countries',
    'operational_airline_colors',
    'operational_aircraft_groups',
    'operational_aircraft_group_types',
    'operational_counter_rules',
    'operational_checkin_counters',
    'operational_checkin_counter_groups',
    'operational_checkin_counter_group_members',
    'operational_checkin_counter_locks',
    'operational_checkin_counter_lock_members',
    'operational_gate_resources',
    'operational_gate_groups',
    'operational_gate_group_members',
    'operational_gate_locks',
    'operational_gate_lock_members',
    'operational_stand_gate_mappings',
    'operational_ai_models',
    'operational_ai_context_documents',
    'audit_sessions',
    'audit_entries',
    'audit_delta_chunks'
  ];
begin
  foreach table_name in array table_names
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "app operators can read" on public.%I', table_name);
    execute format('drop policy if exists "app operators can write" on public.%I', table_name);
    execute format('create policy "app operators can read" on public.%I for select to authenticated using (public.is_app_operator())', table_name);
    execute format('create policy "app operators can write" on public.%I for all to authenticated using (public.is_app_operator()) with check (public.is_app_operator())', table_name);
  end loop;
end $$;

-- Evaluate stable operator permission checks once per statement instead of once per row.
-- The scalar subqueries become PostgreSQL InitPlans while preserving the existing RBAC result.
do $$
declare
  table_name text;
  read_tables text[] := array[
    'seasons',
    'season_source_rows',
    'season_source_row_days',
    'season_flight_records',
    'season_flight_record_counters',
    'season_flight_record_checkin_windows',
    'season_modifications',
    'season_modification_counters',
    'season_modification_checkin_windows',
    'season_modification_added_legs',
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes',
    'season_change_events',
    'schedule_notification_deliveries',
    'season_entity_versions'
  ];
  overlay_write_tables text[] := array[
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes',
    'season_modification_added_legs'
  ];
  checkin_write_tables text[] := array[
    'season_modification_counters',
    'season_modification_checkin_windows'
  ];
  base_write_expression text :=
    '(select public.app_operator_has_permission(''seasonal.write''))'
    || ' or (select public.app_operator_has_permission(''detailed.write''))'
    || ' or (select public.app_operator_has_permission(''daily.write''))';
  checkin_write_expression text;
  modification_write_expression text;
begin
  checkin_write_expression := base_write_expression
    || ' or (select public.app_operator_has_permission(''checkin.write''))';
  modification_write_expression := checkin_write_expression
    || ' or (select public.app_operator_has_permission(''gate.write''))';

  foreach table_name in array read_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'seasonal baseline read'
    ) then
      execute format(
        'alter policy "seasonal baseline read" on public.%I using ((select public.app_operator_has_permission(''seasonal.read'')))',
        table_name
      );
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'seasonal overlay read'
    ) then
      execute format(
        'alter policy "seasonal overlay read" on public.%I using ((select public.app_operator_has_permission(''seasonal.read'')))',
        table_name
      );
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'app operators can read'
    ) then
      execute format(
        'alter policy "app operators can read" on public.%I using ((select public.is_app_operator()))',
        table_name
      );
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'app operators can write'
    ) then
      execute format(
        'alter policy "app operators can write" on public.%I using ((select public.is_app_operator())) with check ((select public.is_app_operator()))',
        table_name
      );
    end if;
  end loop;

  foreach table_name in array overlay_write_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'permissioned operational overlay writes'
    ) then
      execute format(
        'alter policy "permissioned operational overlay writes" on public.%I using (%s) with check (%s)',
        table_name,
        base_write_expression,
        base_write_expression
      );
    end if;
  end loop;

  foreach table_name in array checkin_write_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'permissioned operational overlay writes'
    ) then
      execute format(
        'alter policy "permissioned operational overlay writes" on public.%I using (%s) with check (%s)',
        table_name,
        checkin_write_expression,
        checkin_write_expression
      );
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'season_modifications'
      and policyname = 'permissioned operational overlay writes'
  ) then
    execute format(
      'alter policy "permissioned operational overlay writes" on public.season_modifications using (%s) with check (%s)',
      modification_write_expression,
      modification_write_expression
    );
  end if;
end $$;

alter table public.app_roles enable row level security;
alter table public.app_role_permissions enable row level security;
alter table public.app_operator_roles enable row level security;
alter table public.app_operator_permission_overrides enable row level security;

drop policy if exists "app operators can read" on public.app_roles;
drop policy if exists "app operators can write" on public.app_roles;
drop policy if exists "app operators can read" on public.app_role_permissions;
drop policy if exists "app operators can write" on public.app_role_permissions;
drop policy if exists "app operators can read" on public.app_operator_roles;
drop policy if exists "app operators can write" on public.app_operator_roles;
drop policy if exists "app operators can read" on public.app_operator_permission_overrides;
drop policy if exists "app operators can write" on public.app_operator_permission_overrides;

create policy "app operators can read" on public.app_roles
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_role_permissions
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_operator_roles
  for select to authenticated
  using (public.is_app_operator());

create policy "app operators can read" on public.app_operator_permission_overrides
  for select to authenticated
  using (public.is_app_operator());

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.app_operator_known_permission_keys() to authenticated;
grant execute on function public.app_operator_has_permission_for(uuid, text) to authenticated;
grant execute on function public.app_operator_has_permission(text) to authenticated;
grant execute on function public.app_operator_can_use_ai() to authenticated;
grant execute on function public.app_operator_can_manage_ai() to authenticated;

revoke execute on function public.sync_ai_provider_key(text, text, text, bigint) from public;
revoke execute on function public.sync_ai_provider_key(text, text, text, bigint) from anon;
grant execute on function public.sync_ai_provider_key(text, text, text, bigint) to authenticated;

revoke execute on function public.fetch_ai_provider_key(text) from public;
revoke execute on function public.fetch_ai_provider_key(text) from anon;
grant execute on function public.fetch_ai_provider_key(text) to authenticated;

revoke execute on function public.list_ai_provider_key_status() from public;
revoke execute on function public.list_ai_provider_key_status() from anon;
grant execute on function public.list_ai_provider_key_status() to authenticated;

revoke execute on function public.sync_season_workspace(text, integer, jsonb) from public;
revoke execute on function public.sync_season_workspace(text, integer, jsonb) from anon;
grant execute on function public.sync_season_workspace(text, integer, jsonb) to authenticated;

revoke execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) from public;
revoke execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) from anon;
grant execute on function public.sync_season_workspace_v2(text, text, bigint, jsonb) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.season_change_events;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'seasonal_bi_reader') then
    create role seasonal_bi_reader nologin;
  end if;
end $$;

grant usage on schema reporting to seasonal_bi_reader;
grant select on all tables in schema reporting to seasonal_bi_reader;

alter view reporting.flight_operations set (security_invoker = true);
alter view reporting.summary_airline set (security_invoker = true);
alter view reporting.summary_country set (security_invoker = true);
alter view reporting.summary_route set (security_invoker = true);
alter view reporting.summary_month set (security_invoker = true);
alter view reporting.summary_week set (security_invoker = true);
alter view reporting.summary_peak_hour set (security_invoker = true);
alter view reporting.summary_aircraft set (security_invoker = true);
alter view reporting.summary_arr_dep_mix set (security_invoker = true);

grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;
