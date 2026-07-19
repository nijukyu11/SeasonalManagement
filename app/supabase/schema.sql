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
drop table if exists public.season_import_batch_rows cascade;
drop table if exists public.season_import_batches cascade;
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

create table if not exists public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  checksum text not null,
  status text not null check (status in ('staged', 'validated', 'committed', 'failed')),
  source_row_count integer not null default 0,
  generated_record_count integer not null default 0,
  diagnostics jsonb not null default '[]'::jsonb,
  result jsonb,
  constraint season_import_batches_result_object_check
    check (result is null or pg_catalog.jsonb_typeof(result) = 'object'),
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

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.season_import_batches'::pg_catalog.regclass
      and constraints.conname = 'season_import_batches_result_object_check'
  ) then
    alter table public.season_import_batches
      add constraint season_import_batches_result_object_check
      check (result is null or pg_catalog.jsonb_typeof(result) = 'object');
  end if;
end;
$$;

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
alter table public.season_import_batches enable row level security;
alter table public.season_import_batch_rows enable row level security;

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

create or replace function public.preserve_season_import_batch_staging_metadata_v2()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.result is not null
    and pg_catalog.jsonb_typeof(new.result) <> 'object'
  then
    raise exception 'season_import_batches.result must be null or a JSON object'
      using errcode = '22023';
  end if;

  if old.result ? '_staging' then
    new.result := (
      coalesce(new.result, '{}'::jsonb) - '_staging'
    ) || pg_catalog.jsonb_build_object('_staging', old.result->'_staging');
  end if;

  return new;
end;
$$;

drop trigger if exists preserve_season_import_batch_staging_metadata_v2
  on public.season_import_batches;

create trigger preserve_season_import_batch_staging_metadata_v2
before update of result on public.season_import_batches
for each row
execute function public.preserve_season_import_batch_staging_metadata_v2();

create or replace function public.normalize_seasonal_flight_number_v2(
  p_airline text,
  p_raw text
)
returns table (
  flight_number text,
  raw_flight_number text
)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with normalized_input as (
    select
      pg_catalog.upper(pg_catalog.btrim(p_airline)) as airline,
      pg_catalog.upper(pg_catalog.btrim(p_raw)) as raw_value
  ), without_airline_prefix as (
    select
      normalized_input.airline,
      case
        when normalized_input.airline <> ''
          and pg_catalog.char_length(normalized_input.raw_value)
            > pg_catalog.char_length(normalized_input.airline)
          and pg_catalog.left(
            normalized_input.raw_value,
            pg_catalog.char_length(normalized_input.airline)
          ) = normalized_input.airline
          then pg_catalog.substr(
            normalized_input.raw_value,
            pg_catalog.char_length(normalized_input.airline) + 1
          )
        else normalized_input.raw_value
      end as flight_part
    from normalized_input
  ), normalized_flight as (
    select
      without_airline_prefix.airline,
      case
        when without_airline_prefix.flight_part ~ '^[0-9]+$'
          and pg_catalog.char_length(without_airline_prefix.flight_part) < 3
          then pg_catalog.repeat(
            '0',
            3 - pg_catalog.char_length(without_airline_prefix.flight_part)
          ) || without_airline_prefix.flight_part
        else without_airline_prefix.flight_part
      end as flight_part
    from without_airline_prefix
  )
  select
    normalized_flight.airline || normalized_flight.flight_part,
    normalized_flight.flight_part
  from normalized_flight
  where normalized_flight.flight_part <> ''
$$;

create or replace function public.seasonal_operational_date_v2(
  p_scheduled_date date,
  p_schedule time
)
returns date
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_schedule < time '05:00' then p_scheduled_date - 1
    else p_scheduled_date
  end
$$;

create or replace function public.seasonal_record_id_v2(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select
    'LEG_'
    || pg_catalog.upper(pg_catalog.btrim(p_type))
    || '_'
    || p_scheduled_date::text
    || '_'
    || pg_catalog.substr(
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            p_season_id
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_type))
            || chr(31)
            || p_scheduled_date::text
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_airline))
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_flight_number)),
            'UTF8'
          )
        ),
        'hex'
      ),
      1,
      32
    )
$$;

create or replace function public.seasonal_import_expansion_preflight_v2(
  p_source_rows jsonb
)
returns table (
  max_date_span integer,
  atomic_side_count bigint
)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with canonical_rows as (
    select
      (source_rows.row_data->>'effective')::date as effective_date,
      (source_rows.row_data->>'discontinue')::date as discontinue_date,
      source_rows.row_data->'daysOfWeek' as days_of_week,
      (
        case
          when source_rows.row_data->>'arrFlight' is not null
            and source_rows.row_data->>'sta' is not null then 1
          else 0
        end
        + case
          when source_rows.row_data->>'depFlight' is not null
            and source_rows.row_data->>'std' is not null then 1
          else 0
        end
      )::integer as side_count
    from pg_catalog.jsonb_array_elements(p_source_rows) source_rows(row_data)
  ), row_spans as (
    select
      canonical_rows.*,
      (canonical_rows.discontinue_date - canonical_rows.effective_date + 1)::integer
        as date_span,
      (
        case when (canonical_rows.days_of_week->0)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->1)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->2)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->3)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->4)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->5)::boolean then 1 else 0 end
        + case when (canonical_rows.days_of_week->6)::boolean then 1 else 0 end
      )::integer as selected_day_count
    from canonical_rows
  ), operating_date_counts as (
    select
      row_spans.date_span,
      row_spans.side_count,
      (
        (row_spans.date_span / 7) * row_spans.selected_day_count
        + case
          when row_spans.date_span % 7 > 0
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date)::integer - 1
            ))::boolean then 1
          else 0
        end
        + case
          when row_spans.date_span % 7 > 1
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date + 1)::integer - 1
            ))::boolean then 1
          else 0
        end
        + case
          when row_spans.date_span % 7 > 2
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date + 2)::integer - 1
            ))::boolean then 1
          else 0
        end
        + case
          when row_spans.date_span % 7 > 3
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date + 3)::integer - 1
            ))::boolean then 1
          else 0
        end
        + case
          when row_spans.date_span % 7 > 4
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date + 4)::integer - 1
            ))::boolean then 1
          else 0
        end
        + case
          when row_spans.date_span % 7 > 5
            and (row_spans.days_of_week->(
              extract(isodow from row_spans.effective_date + 5)::integer - 1
            ))::boolean then 1
          else 0
        end
      )::bigint as operating_date_count
    from row_spans
  )
  select
    coalesce(pg_catalog.max(operating_date_counts.date_span), 0)::integer,
    coalesce(
      pg_catalog.sum(
        operating_date_counts.operating_date_count * operating_date_counts.side_count
      ),
      0
    )::bigint
  from operating_date_counts
$$;

create or replace function public.seasonal_import_atomic_preview_v2(p_batch_id uuid)
returns table (
  item_kind text,
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
  turnaround_id text,
  staging_row_index integer,
  issue_order integer,
  diagnostic_column_name text,
  issue jsonb
)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  with canonical_rows as (
    select
      rows.row_index as staging_row_index,
      coalesce(
        batches.result #>> '{_staging,targetSeasonId}',
        batches.season_id,
        'pending:' || batches.season_code
      ) as season_identity,
      (rows.row_data->>'rowIndex')::integer as source_row_index,
      (rows.row_data->>'effective')::date as effective_date,
      (rows.row_data->>'discontinue')::date as discontinue_date,
      rows.row_data->>'airline' as airline,
      rows.row_data->>'aircraft' as aircraft,
      rows.row_data->'daysOfWeek' as days_of_week,
      rows.row_data->>'sta' as sta,
      rows.row_data->>'arrFlight' as arr_flight,
      rows.row_data->>'arrRoute' as arr_route,
      rows.row_data->>'arrFlightCategory' as arr_category,
      rows.row_data->>'arrCodeShares' as arr_code_shares,
      rows.row_data->>'arrIntDomInd' as arr_int_dom_ind,
      rows.row_data->>'std' as std,
      rows.row_data->>'depFlight' as dep_flight,
      rows.row_data->>'depRoute' as dep_route,
      rows.row_data->>'depFlightCategory' as dep_category,
      rows.row_data->>'depCodeShares' as dep_code_shares,
      rows.row_data->>'depIntDomInd' as dep_int_dom_ind,
      nullif(rows.row_data->>'overnightLinkRowIndex', '')::integer
        as explicit_linked_source_row_index,
      nullif(rows.row_data->>'linkType', '') as source_link_type,
      rows.row_data->>'arrFlight' is not null
        and rows.row_data->>'sta' is not null as has_arrival,
      rows.row_data->>'depFlight' is not null
        and rows.row_data->>'std' is not null as has_departure
    from public.season_import_batch_rows rows
    join public.season_import_batches batches on batches.batch_id = rows.batch_id
    where rows.batch_id = p_batch_id
      and batches.status in ('staged', 'validated')
      and pg_catalog.jsonb_array_length(batches.diagnostics) = 0
  ), linked_reference_counts as (
    select
      canonical_rows.explicit_linked_source_row_index as target_source_row_index,
      pg_catalog.count(*)::integer as reference_count
    from canonical_rows
    where canonical_rows.explicit_linked_source_row_index is not null
    group by canonical_rows.explicit_linked_source_row_index
  ), linked_relationships as (
    select
      canonical_rows.*,
      linked_row.source_row_index as target_source_row_index,
      linked_row.explicit_linked_source_row_index as target_linked_source_row_index,
      linked_row.source_link_type as target_link_type,
      linked_row.airline as target_airline,
      linked_row.sta as target_sta,
      linked_row.std as target_std,
      linked_row.has_arrival as target_has_arrival,
      linked_row.has_departure as target_has_departure,
      case
        when canonical_rows.has_arrival then coalesce(
          canonical_rows.source_link_type,
          linked_row.source_link_type,
          case
            when linked_row.std::time < canonical_rows.sta::time then 'overnight'
            else 'sameday'
          end
        )
        else coalesce(
          linked_row.source_link_type,
          canonical_rows.source_link_type,
          case
            when canonical_rows.std::time < linked_row.sta::time then 'overnight'
            else 'sameday'
          end
        )
      end as resolved_cross_row_link_type,
      linked_reference_count.reference_count,
      linked_row.source_row_index is not null
        and linked_row.source_row_index <> canonical_rows.source_row_index
        and linked_row.explicit_linked_source_row_index = canonical_rows.source_row_index
        and linked_reference_count.reference_count = 1
        and canonical_rows.has_arrival <> canonical_rows.has_departure
        and linked_row.has_arrival <> linked_row.has_departure
        and canonical_rows.has_arrival <> linked_row.has_arrival
        and canonical_rows.airline = linked_row.airline
        and not (
          canonical_rows.source_link_type is not null
          and linked_row.source_link_type is not null
          and canonical_rows.source_link_type <> linked_row.source_link_type
        ) as explicit_relationship_is_valid
    from canonical_rows
    left join canonical_rows linked_row
      on linked_row.source_row_index = canonical_rows.explicit_linked_source_row_index
    left join linked_reference_counts linked_reference_count
      on linked_reference_count.target_source_row_index = linked_row.source_row_index
  ), generated_dates AS MATERIALIZED (
    select
      linked_relationships.*,
      linked_relationships.effective_date + day_offsets.day_offset
        as source_scheduled_date
    from linked_relationships
    cross join lateral pg_catalog.generate_series(
      0,
      linked_relationships.discontinue_date - linked_relationships.effective_date
    ) day_offsets(day_offset)
    where (linked_relationships.days_of_week->(
      extract(
        isodow from linked_relationships.effective_date + day_offsets.day_offset
      )::integer - 1
    ))::boolean
  ), rows_without_operating_dates as (
    select linked_relationships.*
    from linked_relationships
    where not exists (
      select 1
      from generated_dates
      where generated_dates.staging_row_index = linked_relationships.staging_row_index
    )
  ), explicit_pair_anchors as (
    select
      generated_dates.*,
      case
        when generated_dates.has_arrival then generated_dates.source_scheduled_date
        when generated_dates.resolved_cross_row_link_type = 'overnight'
          then generated_dates.source_scheduled_date - 1
        else generated_dates.source_scheduled_date
      end as diagnostic_pair_anchor_date
    from generated_dates
    where generated_dates.explicit_linked_source_row_index is not null
      and generated_dates.explicit_relationship_is_valid
  ), unmatched_pair_dates as (
    select source_anchor.*
    from explicit_pair_anchors source_anchor
    where not exists (
      select 1
      from explicit_pair_anchors target_anchor
      where target_anchor.source_row_index = source_anchor.explicit_linked_source_row_index
        and target_anchor.explicit_linked_source_row_index = source_anchor.source_row_index
        and target_anchor.diagnostic_pair_anchor_date
          = source_anchor.diagnostic_pair_anchor_date
    )
  ), arr_dep_expansion as (
    select
      generated_dates.*,
      sides.type,
      sides.raw_flight,
      sides.route,
      sides.schedule,
      sides.category,
      sides.code_shares,
      sides.int_dom_ind,
      case
        when generated_dates.has_arrival and generated_dates.has_departure
          then case
            when generated_dates.std::time < generated_dates.sta::time
              then 'overnight'
            else 'sameday'
          end
        when generated_dates.explicit_linked_source_row_index is not null
          then generated_dates.resolved_cross_row_link_type
        else null
      end as resolved_link_type,
      case
        when generated_dates.has_arrival
          and generated_dates.has_departure
          and sides.type = 'D'
          and generated_dates.std::time < generated_dates.sta::time
          then generated_dates.source_scheduled_date + 1
        else generated_dates.source_scheduled_date
      end as resolved_scheduled_date,
      case
        when generated_dates.has_arrival and generated_dates.has_departure
          then generated_dates.source_scheduled_date
        when generated_dates.explicit_linked_source_row_index is not null
          and sides.type = 'D'
          and generated_dates.resolved_cross_row_link_type = 'overnight'
          then generated_dates.source_scheduled_date - 1
        when generated_dates.explicit_linked_source_row_index is not null
          then generated_dates.source_scheduled_date
        else null
      end as resolved_pair_anchor_date,
      case
        when generated_dates.has_arrival and generated_dates.has_departure
          then generated_dates.source_row_index
        else generated_dates.explicit_linked_source_row_index
      end as resolved_linked_source_row_index,
      generated_dates.has_arrival and generated_dates.has_departure
        or generated_dates.explicit_linked_source_row_index is not null as requires_pair,
      case
        when generated_dates.explicit_linked_source_row_index is null then true
        else generated_dates.explicit_relationship_is_valid
      end as relationship_is_valid
    from generated_dates
    cross join lateral (
      values
        (
          'A'::text,
          generated_dates.arr_flight,
          generated_dates.arr_route,
          generated_dates.sta,
          generated_dates.arr_category,
          generated_dates.arr_code_shares,
          generated_dates.arr_int_dom_ind,
          generated_dates.has_arrival
        ),
        (
          'D'::text,
          generated_dates.dep_flight,
          generated_dates.dep_route,
          generated_dates.std,
          generated_dates.dep_category,
          generated_dates.dep_code_shares,
          generated_dates.dep_int_dom_ind,
          generated_dates.has_departure
        )
    ) sides(type, raw_flight, route, schedule, category, code_shares, int_dom_ind, side_is_present)
    where sides.side_is_present
  ), normalized_flight_identity as (
    select
      arr_dep_expansion.*,
      normalized.flight_number,
      normalized.raw_flight_number,
      public.seasonal_operational_date_v2(
        arr_dep_expansion.resolved_scheduled_date,
        arr_dep_expansion.schedule::time
      ) as resolved_operational_date
    from arr_dep_expansion
    cross join lateral public.normalize_seasonal_flight_number_v2(
      arr_dep_expansion.airline,
      arr_dep_expansion.raw_flight
    ) normalized
  ), deterministic_ids as (
    select
      normalized_flight_identity.*,
      public.seasonal_record_id_v2(
        normalized_flight_identity.season_identity,
        normalized_flight_identity.type,
        normalized_flight_identity.resolved_scheduled_date,
        normalized_flight_identity.airline,
        normalized_flight_identity.flight_number
      ) as generated_record_id,
      normalized_flight_identity.season_identity
        || '|'
        || normalized_flight_identity.resolved_scheduled_date::text
        || '|'
        || normalized_flight_identity.airline
        || '|'
        || normalized_flight_identity.flight_number as generated_occurrence_key
    from normalized_flight_identity
  ), counterpart_candidates as (
    select
      source.staging_row_index,
      source.source_row_index,
      source.type,
      source.resolved_scheduled_date,
      source.generated_record_id,
      pg_catalog.min(candidate.generated_record_id) as record_id,
      pg_catalog.min(candidate.generated_occurrence_key) as occurrence_key,
      pg_catalog.count(*)::integer as candidate_count
    from deterministic_ids source
    join deterministic_ids candidate
      on candidate.source_row_index = source.resolved_linked_source_row_index
      and candidate.resolved_linked_source_row_index = source.source_row_index
      and candidate.type <> source.type
      and candidate.resolved_pair_anchor_date = source.resolved_pair_anchor_date
      and candidate.relationship_is_valid
    where source.requires_pair
    group by
      source.staging_row_index,
      source.source_row_index,
      source.type,
      source.resolved_scheduled_date,
      source.generated_record_id
  ), reciprocal_links as (
    select
      deterministic_ids.*,
      counterpart.record_id as counterpart_record_id,
      counterpart.occurrence_key as counterpart_occurrence_key,
      counterpart.candidate_count,
      not deterministic_ids.requires_pair
        or (
          deterministic_ids.relationship_is_valid
          and counterpart.candidate_count = 1
        ) as pair_is_valid,
      case
        when deterministic_ids.requires_pair
          and deterministic_ids.relationship_is_valid
          and counterpart.candidate_count = 1
          then 'TRN_' || pg_catalog.substr(
            pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  deterministic_ids.season_identity
                  || chr(31)
                  || deterministic_ids.resolved_pair_anchor_date::text
                  || chr(31)
                  || least(
                    deterministic_ids.generated_record_id,
                    counterpart.record_id
                  )
                  || chr(31)
                  || greatest(
                    deterministic_ids.generated_record_id,
                    counterpart.record_id
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ),
            1,
            32
          )
        else null
      end as generated_turnaround_id
    from deterministic_ids
    left join counterpart_candidates counterpart
      on counterpart.staging_row_index = deterministic_ids.staging_row_index
      and counterpart.source_row_index = deterministic_ids.source_row_index
      and counterpart.type = deterministic_ids.type
      and counterpart.resolved_scheduled_date = deterministic_ids.resolved_scheduled_date
      and counterpart.generated_record_id = deterministic_ids.generated_record_id
  ), committable_duplicate_keys as (
    select
      reciprocal_links.generated_occurrence_key as occurrence_key,
      pg_catalog.count(*)::integer as occurrence_count
    from reciprocal_links
    where reciprocal_links.pair_is_valid
    group by reciprocal_links.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), committable_records as (
    select reciprocal_links.*
    from reciprocal_links
    left join committable_duplicate_keys own_duplicate
      on own_duplicate.occurrence_key = reciprocal_links.generated_occurrence_key
    left join committable_duplicate_keys counterpart_duplicate
      on counterpart_duplicate.occurrence_key = reciprocal_links.counterpart_occurrence_key
    where reciprocal_links.pair_is_valid
      and own_duplicate.occurrence_key is null
      and counterpart_duplicate.occurrence_key is null
  ), duplicate_occurrences as (
    select
      pg_catalog.min(deterministic_ids.staging_row_index) as staging_row_index,
      pg_catalog.min(deterministic_ids.source_row_index) as source_row_index,
      deterministic_ids.generated_occurrence_key as occurrence_key,
      pg_catalog.array_agg(
        distinct deterministic_ids.source_row_index
        order by deterministic_ids.source_row_index
      ) as source_row_indexes
    from deterministic_ids
    group by deterministic_ids.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), zero_row_diagnostics as (
    select
      rows_without_operating_dates.staging_row_index,
      190 as issue_order,
      'daysOfWeek'::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', rows_without_operating_dates.source_row_index,
        'stagingRowIndex', rows_without_operating_dates.staging_row_index,
        'code', 'zero-generated-records',
        'column', 'daysOfWeek',
        'message', pg_catalog.format(
          'Row %s: no selected operating day occurs within Effective through Discontinue.',
          rows_without_operating_dates.source_row_index
        )
      ) as issue
    from rows_without_operating_dates
  ), relationship_diagnostics as (
    select
      linked_relationships.staging_row_index,
      relationship_issues.issue_order,
      'overnightLinkRowIndex'::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', linked_relationships.source_row_index,
        'stagingRowIndex', linked_relationships.staging_row_index,
        'code', relationship_issues.issue_code,
        'column', 'overnightLinkRowIndex',
        'message', relationship_issues.issue_message
      ) as issue
    from linked_relationships
    cross join lateral (
      values
        (
          200,
          linked_relationships.explicit_linked_source_row_index is not null
            and linked_relationships.target_source_row_index is null,
          'missing-linked-row',
          pg_catalog.format(
            'Row %s: linked source row %s does not exist.',
            linked_relationships.source_row_index,
            linked_relationships.explicit_linked_source_row_index
          )
        ),
        (
          210,
          linked_relationships.target_source_row_index is not null
            and (
              linked_relationships.target_source_row_index = linked_relationships.source_row_index
              or linked_relationships.target_linked_source_row_index
                is distinct from linked_relationships.source_row_index
              or linked_relationships.reference_count <> 1
            ),
          'ambiguous-pair',
          pg_catalog.format(
            'Row %s: linked source row %s is not a unique reciprocal pair.',
            linked_relationships.source_row_index,
            linked_relationships.explicit_linked_source_row_index
          )
        ),
        (
          220,
          linked_relationships.target_source_row_index is not null
            and (
              linked_relationships.has_arrival = linked_relationships.has_departure
              or linked_relationships.target_has_arrival
                = linked_relationships.target_has_departure
              or linked_relationships.has_arrival = linked_relationships.target_has_arrival
              or linked_relationships.airline is distinct from linked_relationships.target_airline
            ),
          'incompatible-pair-type',
          pg_catalog.format(
            'Row %s: linked rows must be opposite ARR-only and DEP-only sides for one airline.',
            linked_relationships.source_row_index
          )
        ),
        (
          230,
          linked_relationships.target_source_row_index is not null
            and linked_relationships.source_link_type is not null
            and linked_relationships.target_link_type is not null
            and linked_relationships.source_link_type <> linked_relationships.target_link_type,
          'incompatible-link-type',
          pg_catalog.format(
            'Row %s: linked rows must use the same linkType.',
            linked_relationships.source_row_index
          )
        )
    ) relationship_issues(issue_order, applies, issue_code, issue_message)
    where relationship_issues.applies
  ), pair_date_diagnostics as (
    select
      unmatched_pair_dates.staging_row_index,
      240 as issue_order,
      'daysOfWeek'::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', unmatched_pair_dates.source_row_index,
        'stagingRowIndex', unmatched_pair_dates.staging_row_index,
        'code', 'incompatible-pair-date',
        'column', 'daysOfWeek',
        'message', pg_catalog.format(
          'Row %s: linked row %s has no %s counterpart for pair anchor %s.',
          unmatched_pair_dates.source_row_index,
          unmatched_pair_dates.explicit_linked_source_row_index,
          unmatched_pair_dates.resolved_cross_row_link_type,
          unmatched_pair_dates.diagnostic_pair_anchor_date
        ),
        'pairAnchorDate', unmatched_pair_dates.diagnostic_pair_anchor_date::text
      ) as issue
    from unmatched_pair_dates
  ), duplicate_diagnostics as (
    select
      duplicate_occurrences.staging_row_index,
      250 as issue_order,
      null::text as diagnostic_column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', duplicate_occurrences.source_row_index,
        'stagingRowIndex', duplicate_occurrences.staging_row_index,
        'code', 'duplicate-occurrence-key',
        'column', null,
        'message', pg_catalog.format(
          'Rows %s generate duplicate occurrence %s.',
          pg_catalog.array_to_string(duplicate_occurrences.source_row_indexes, ', '),
          duplicate_occurrences.occurrence_key
        ),
        'occurrenceKey', duplicate_occurrences.occurrence_key,
        'sourceRowIndexes', pg_catalog.to_jsonb(duplicate_occurrences.source_row_indexes)
      ) as issue
    from duplicate_occurrences
  ), generation_diagnostics as (
    select * from zero_row_diagnostics
    union all
    select * from relationship_diagnostics
    union all
    select * from pair_date_diagnostics
    union all
    select * from duplicate_diagnostics
  ), record_items as (
    select
      'record'::text as item_kind,
      committable_records.generated_record_id as record_id,
      committable_records.generated_occurrence_key as occurrence_key,
      coalesce(
        committable_records.generated_turnaround_id,
        committable_records.generated_record_id
      ) as link_id,
      committable_records.type,
      committable_records.airline,
      committable_records.flight_number,
      committable_records.raw_flight_number,
      coalesce(committable_records.route, '') as route,
      committable_records.schedule,
      committable_records.aircraft,
      coalesce(committable_records.category, '') as category,
      committable_records.code_shares,
      committable_records.int_dom_ind,
      committable_records.resolved_scheduled_date::text as scheduled_date,
      committable_records.resolved_operational_date::text as operational_date,
      extract(dow from committable_records.resolved_scheduled_date)::integer
        as day_of_week,
      committable_records.source_row_index,
      committable_records.resolved_linked_source_row_index as linked_source_row_index,
      committable_records.resolved_link_type as link_type,
      committable_records.resolved_pair_anchor_date::text as pair_anchor_date,
      case
        when committable_records.requires_pair
          then committable_records.counterpart_record_id
        else null
      end as linked_record_id,
      committable_records.generated_turnaround_id as turnaround_id,
      null::integer as staging_row_index,
      null::integer as issue_order,
      null::text as diagnostic_column_name,
      null::jsonb as issue
    from committable_records
  ), diagnostic_items as (
    select
      'diagnostic'::text as item_kind,
      null::text as record_id,
      null::text as occurrence_key,
      null::text as link_id,
      null::text as type,
      null::text as airline,
      null::text as flight_number,
      null::text as raw_flight_number,
      null::text as route,
      null::text as schedule,
      null::text as aircraft,
      null::text as category,
      null::text as code_shares,
      null::text as int_dom_ind,
      null::text as scheduled_date,
      null::text as operational_date,
      null::integer as day_of_week,
      null::integer as source_row_index,
      null::integer as linked_source_row_index,
      null::text as link_type,
      null::text as pair_anchor_date,
      null::text as linked_record_id,
      null::text as turnaround_id,
      generation_diagnostics.staging_row_index,
      generation_diagnostics.issue_order,
      generation_diagnostics.diagnostic_column_name,
      generation_diagnostics.issue
    from generation_diagnostics
  )
  select * from record_items
  union all
  select * from diagnostic_items
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
set search_path = pg_catalog, pg_temp
as $$
  select
    atomic_preview.record_id,
    atomic_preview.occurrence_key,
    atomic_preview.link_id,
    atomic_preview.type,
    atomic_preview.airline,
    atomic_preview.flight_number,
    atomic_preview.raw_flight_number,
    atomic_preview.route,
    atomic_preview.schedule,
    atomic_preview.aircraft,
    atomic_preview.category,
    atomic_preview.code_shares,
    atomic_preview.int_dom_ind,
    atomic_preview.scheduled_date,
    atomic_preview.operational_date,
    atomic_preview.day_of_week,
    atomic_preview.source_row_index,
    atomic_preview.linked_source_row_index,
    atomic_preview.link_type,
    atomic_preview.pair_anchor_date,
    atomic_preview.linked_record_id,
    atomic_preview.turnaround_id
  from public.seasonal_import_atomic_preview_v2(p_batch_id) atomic_preview
  where atomic_preview.item_kind = 'record'
  order by
    atomic_preview.scheduled_date,
    atomic_preview.type,
    atomic_preview.airline,
    atomic_preview.flight_number,
    atomic_preview.source_row_index
$$;

create or replace function public.seasonal_import_generation_diagnostics_v2(
  p_batch_id uuid
)
returns table (
  staging_row_index integer,
  issue_order integer,
  column_name text,
  issue jsonb
)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select
    atomic_preview.staging_row_index,
    atomic_preview.issue_order,
    atomic_preview.diagnostic_column_name,
    atomic_preview.issue
  from public.seasonal_import_atomic_preview_v2(p_batch_id) atomic_preview
  where atomic_preview.item_kind = 'diagnostic'
$$;

create or replace function public.stage_seasonal_import_v2(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request_id uuid;
  v_request_id_text text;
  v_checksum text;
  v_season_code text;
  v_requested_season_id text;
  v_season_id text;
  v_target_season_id text;
  v_season_match_count integer := 0;
  v_expected_data_version integer;
  v_file_name text;
  v_source_rows jsonb;
  v_source_row_count integer;
  v_canonical_source_rows jsonb := '[]'::jsonb;
  v_persisted_source_rows jsonb := '[]'::jsonb;
  v_request_fingerprint text;
  v_persisted_request_fingerprint text;
  v_diagnostics jsonb := '[]'::jsonb;
  v_diagnostic_count integer := 0;
  v_generation_diagnostics jsonb := '[]'::jsonb;
  v_generation_diagnostic_count integer := 0;
  v_generated_record_count integer := 0;
  v_existing_created_by uuid;
  v_max_date_span integer := 0;
  v_atomic_side_count bigint := 0;
  v_oversized_staging_row_index integer;
  v_oversized_column text;
  v_oversized_maximum_length integer;
  v_max_actionable_diagnostics constant integer := 1999;
  v_max_seasonal_date_span constant integer := 550;
  v_max_generated_atomic_count constant bigint := 100000;
  v_batch public.season_import_batches%rowtype;
begin
  if not public.app_operator_has_permission('seasonal.write') then
    raise exception 'Missing required permission: seasonal.write'
      using errcode = '42501';
  end if;

  if p_import is null or pg_catalog.jsonb_typeof(p_import) <> 'object' then
    raise exception 'p_import must be a JSON object'
      using errcode = '22023';
  end if;

  if pg_catalog.octet_length(p_import::text) > 67108864 then
    raise exception 'p_import exceeds maximum size of 67108864 bytes'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'requestId') is distinct from 'string' then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'checksum') is distinct from 'string' then
    raise exception 'checksum is required'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'seasonCode') is distinct from 'string' then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if p_import ? 'seasonId'
    and pg_catalog.jsonb_typeof(p_import->'seasonId') not in ('string', 'null')
  then
    raise exception 'seasonId must be a string when provided'
      using errcode = '22023';
  end if;

  if p_import ? 'fileName'
    and pg_catalog.jsonb_typeof(p_import->'fileName') not in ('string', 'null')
  then
    raise exception 'fileName must be a string when provided'
      using errcode = '22023';
  end if;

  v_request_id_text := nullif(pg_catalog.btrim(p_import->>'requestId'), '');
  v_checksum := nullif(pg_catalog.btrim(p_import->>'checksum'), '');
  v_season_code := nullif(pg_catalog.upper(pg_catalog.btrim(p_import->>'seasonCode')), '');
  v_requested_season_id := nullif(pg_catalog.btrim(p_import->>'seasonId'), '');
  v_file_name := coalesce(p_import->>'fileName', '');
  v_source_rows := p_import->'sourceRows';

  if v_request_id_text is null then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  begin
    v_request_id := v_request_id_text::uuid;
  exception
    when invalid_text_representation then
      raise exception 'requestId must be a UUID'
        using errcode = '22023';
  end;

  select batches.created_by
  into v_existing_created_by
  from public.season_import_batches batches
  where batches.request_id = v_request_id;

  if found and v_existing_created_by is distinct from auth.uid() then
    raise exception 'Seasonal import request is not available to the current operator'
      using errcode = '42501';
  end if;

  if v_checksum is null then
    raise exception 'checksum is required'
      using errcode = '22023';
  end if;

  if char_length(v_checksum) > 256 then
    raise exception 'checksum exceeds maximum length of 256'
      using errcode = '22023';
  end if;

  if v_season_code is null then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_season_code) > 32 then
    raise exception 'seasonCode exceeds maximum length of 32'
      using errcode = '22023';
  end if;

  if v_requested_season_id is not null
    and pg_catalog.char_length(v_requested_season_id) > 256
  then
    raise exception 'seasonId exceeds maximum length of 256'
      using errcode = '22023';
  end if;

  if char_length(v_file_name) > 1024 then
    raise exception 'fileName exceeds maximum length of 1024'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_source_rows) is distinct from 'array' then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  v_source_row_count := pg_catalog.jsonb_array_length(v_source_rows);
  if v_source_row_count = 0 then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_source_rows) > 20000 then
    raise exception 'sourceRows exceeds maximum of 20000 rows'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'expectedDataVersion') is distinct from 'number'
    or coalesce(p_import->>'expectedDataVersion', '') !~ '^(0|[1-9][0-9]*)$'
  then
    raise exception 'expectedDataVersion must be a non-negative JSON integer'
      using errcode = '22023';
  end if;

  begin
    v_expected_data_version := (p_import->>'expectedDataVersion')::integer;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'expectedDataVersion must be a non-negative JSON integer'
        using errcode = '22023';
  end;

  select
    (source_rows.ordinality - 1)::integer,
    field_limits.column_name,
    field_limits.maximum_length
  into
    v_oversized_staging_row_index,
    v_oversized_column,
    v_oversized_maximum_length
  from pg_catalog.jsonb_array_elements(v_source_rows)
    with ordinality as source_rows(raw_row, ordinality)
  cross join lateral (
    values
      ('Effective', 'effective', 10),
      ('Discontinue', 'discontinue', 10),
      ('Airline', 'airline', 16),
      ('Aircraft', 'aircraft', 64),
      ('STA', 'sta', 5),
      ('ARRFlight', 'arrFlight', 64),
      ('ARRFlightType', 'arrFlightType', 32),
      ('ARRRoute', 'arrRoute', 512),
      ('ARRFlightCategory', 'arrFlightCategory', 64),
      ('ARRCodeShares', 'arrCodeShares', 4096),
      ('ARRIntDomInd', 'arrIntDomInd', 32),
      ('STD', 'std', 5),
      ('DEPFlight', 'depFlight', 64),
      ('DEPFlightType', 'depFlightType', 32),
      ('DEPRoute', 'depRoute', 512),
      ('DEPFlightCategory', 'depFlightCategory', 64),
      ('DEPCodeShares', 'depCodeShares', 4096),
      ('DEPIntDomInd', 'depIntDomInd', 32),
      ('linkType', 'linkType', 16)
  ) as field_limits(column_name, json_key, maximum_length)
  where pg_catalog.jsonb_typeof(source_rows.raw_row) = 'object'
    and pg_catalog.jsonb_typeof(source_rows.raw_row->field_limits.json_key) = 'string'
    and pg_catalog.char_length(
      pg_catalog.btrim(source_rows.raw_row->>field_limits.json_key)
    ) > field_limits.maximum_length
  order by source_rows.ordinality, field_limits.column_name
  limit 1;

  if found then
    raise exception 'sourceRows[%] canonical source field % exceeds maximum length of %',
      v_oversized_staging_row_index,
      v_oversized_column,
      v_oversized_maximum_length
      using errcode = '22023';
  end if;

  with input_rows as (
    select
      (source_rows.ordinality - 1)::integer as staging_row_index,
      source_rows.raw_row
    from pg_catalog.jsonb_array_elements(v_source_rows)
      with ordinality as source_rows(raw_row, ordinality)
  ), typed_rows as (
    select
      input_rows.*,
      pg_catalog.jsonb_typeof(raw_row) is not distinct from 'object' as row_is_object,
      case
        when pg_catalog.jsonb_typeof(raw_row->'rowIndex') = 'number' then
          (raw_row->>'rowIndex')::numeric = pg_catalog.trunc((raw_row->>'rowIndex')::numeric)
          and (raw_row->>'rowIndex')::numeric between 0 and 999999999
        else false
      end as row_index_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'effective') is not distinct from 'string'
        as effective_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'discontinue') is not distinct from 'string'
        as discontinue_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'airline') is not distinct from 'string'
        as airline_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'aircraft') is not distinct from 'string'
        as aircraft_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'daysOfWeek') is not distinct from 'array'
        as days_is_array,
      case
        when pg_catalog.jsonb_typeof(raw_row->'daysOfWeek') = 'array'
          then raw_row->'daysOfWeek'
        else '[]'::jsonb
      end as raw_days,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex'), 'null') = 'null'
          then true
        when pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex') = 'number' then
          (raw_row->>'overnightLinkRowIndex')::numeric
            = pg_catalog.trunc((raw_row->>'overnightLinkRowIndex')::numeric)
          and (raw_row->>'overnightLinkRowIndex')::numeric between 0 and 999999999
        else false
      end as overnight_link_index_type_is_valid,
      coalesce(pg_catalog.jsonb_typeof(raw_row->'linkType'), 'null')
        in ('string', 'null') as link_type_type_is_valid
    from input_rows
  ), normalized_rows as (
    select
      typed_rows.*,
      case
        when row_index_is_valid then (raw_row->>'rowIndex')::integer
        else null
      end as logical_row_index,
      case
        when row_index_is_valid then (raw_row->>'rowIndex')::integer
        else staging_row_index
      end as diagnostic_row_index,
      case
        when effective_type_is_valid
          then nullif(pg_catalog.btrim(raw_row->>'effective'), '')
        else null
      end as effective_value,
      case
        when discontinue_type_is_valid
          then nullif(pg_catalog.btrim(raw_row->>'discontinue'), '')
        else null
      end as discontinue_value,
      case
        when airline_type_is_valid
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'airline')), '')
        else null
      end as airline_value,
      case
        when aircraft_type_is_valid
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'aircraft')), '')
        else null
      end as aircraft_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'sta'), 'null') in ('string', 'null')
          then nullif(pg_catalog.btrim(raw_row->>'sta'), '')
        else null
      end as sta_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlight'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlight')), '')
        else null
      end as arr_flight_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlightType'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlightType')), '')
        else null
      end as arr_flight_type_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrRoute'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrRoute')), '')
        else null
      end as arr_route_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlightCategory'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlightCategory')), '')
        else null
      end as arr_flight_category_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrCodeShares'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrCodeShares')), '')
        else null
      end as arr_code_shares_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrIntDomInd'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrIntDomInd')), '')
        else null
      end as arr_int_dom_ind_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'std'), 'null') in ('string', 'null')
          then nullif(pg_catalog.btrim(raw_row->>'std'), '')
        else null
      end as std_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlight'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlight')), '')
        else null
      end as dep_flight_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlightType'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlightType')), '')
        else null
      end as dep_flight_type_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depRoute'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depRoute')), '')
        else null
      end as dep_route_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlightCategory'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlightCategory')), '')
        else null
      end as dep_flight_category_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depCodeShares'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depCodeShares')), '')
        else null
      end as dep_code_shares_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depIntDomInd'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depIntDomInd')), '')
        else null
      end as dep_int_dom_ind_value,
      case
        when overnight_link_index_type_is_valid
          and pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex') = 'number'
          then (raw_row->>'overnightLinkRowIndex')::integer
        else null
      end as overnight_link_row_index_value,
      case
        when link_type_type_is_valid
          and pg_catalog.jsonb_typeof(raw_row->'linkType') = 'string'
          then nullif(pg_catalog.lower(pg_catalog.btrim(raw_row->>'linkType')), '')
        else null
      end as link_type_value,
      days_is_array
        and pg_catalog.jsonb_array_length(raw_days) = 7
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(raw_days) as day_values(day_value)
          where pg_catalog.jsonb_typeof(day_value) <> 'boolean'
        ) as days_are_valid
    from typed_rows
  ), date_parts as (
    select
      normalized_rows.*,
      coalesce(
        effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
        false
      ) as effective_shape_is_valid,
      coalesce(
        discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
        false
      ) as discontinue_shape_is_valid,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 1, 4)::integer
        else null
      end as effective_year,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 6, 2)::integer
        else null
      end as effective_month,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 9, 2)::integer
        else null
      end as effective_day,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 1, 4)::integer
        else null
      end as discontinue_year,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 6, 2)::integer
        else null
      end as discontinue_month,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 9, 2)::integer
        else null
      end as discontinue_day
    from normalized_rows
  ), validated_rows as (
    select
      date_parts.*,
      effective_shape_is_valid
        and effective_day <= case effective_month
          when 2 then 28 + case
            when pg_catalog.mod(effective_year, 400) = 0
              or (pg_catalog.mod(effective_year, 4) = 0 and pg_catalog.mod(effective_year, 100) <> 0)
              then 1
            else 0
          end
          when 4 then 30
          when 6 then 30
          when 9 then 30
          when 11 then 30
          else 31
        end as effective_is_valid,
      discontinue_shape_is_valid
        and discontinue_day <= case discontinue_month
          when 2 then 28 + case
            when pg_catalog.mod(discontinue_year, 400) = 0
              or (pg_catalog.mod(discontinue_year, 4) = 0 and pg_catalog.mod(discontinue_year, 100) <> 0)
              then 1
            else 0
          end
          when 4 then 30
          when 6 then 30
          when 9 then 30
          when 11 then 30
          else 31
        end as discontinue_is_valid,
      sta_value is not null or arr_flight_value is not null or arr_route_value is not null
        as has_arrival,
      sta_value is not null and arr_flight_value is not null and arr_route_value is not null
        as has_complete_arrival,
      std_value is not null or dep_flight_value is not null or dep_route_value is not null
        as has_departure,
      std_value is not null and dep_flight_value is not null and dep_route_value is not null
        as has_complete_departure
    from date_parts
  ), counted_rows as (
    select
      validated_rows.*,
      pg_catalog.count(*) over (partition by logical_row_index) as logical_row_index_count
    from validated_rows
  ), canonical_rows as (
    select
      counted_rows.*,
      pg_catalog.jsonb_build_object(
        'rowIndex', logical_row_index,
        'effective', effective_value,
        'discontinue', discontinue_value,
        'airline', airline_value,
        'aircraft', aircraft_value,
        'daysOfWeek', case when days_are_valid then raw_days else '[]'::jsonb end,
        'sta', sta_value,
        'arrFlight', arr_flight_value,
        'arrFlightType', arr_flight_type_value,
        'arrRoute', arr_route_value,
        'arrFlightCategory', arr_flight_category_value,
        'arrCodeShares', arr_code_shares_value,
        'arrIntDomInd', arr_int_dom_ind_value,
        'std', std_value,
        'depFlight', dep_flight_value,
        'depFlightType', dep_flight_type_value,
        'depRoute', dep_route_value,
        'depFlightCategory', dep_flight_category_value,
        'depCodeShares', dep_code_shares_value,
        'depIntDomInd', dep_int_dom_ind_value,
        'overnightLinkRowIndex', overnight_link_row_index_value,
        'linkType', link_type_value
      ) as canonical_row
    from counted_rows
  ), row_diagnostic_items as (
    select
      canonical_rows.staging_row_index,
      row_issues.issue_order,
      row_issues.column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', canonical_rows.diagnostic_row_index,
        'stagingRowIndex', canonical_rows.staging_row_index,
        'code', row_issues.issue_code,
        'column', row_issues.column_name,
        'message', row_issues.issue_message
      ) as issue
    from canonical_rows
    cross join lateral (
      values
        (
          10,
          not canonical_rows.row_is_object,
          'invalid-row',
          null::text,
          pg_catalog.format(
            'Row %s: source row must be a JSON object.',
            canonical_rows.staging_row_index
          )
        ),
        (
          20,
          canonical_rows.row_is_object and not canonical_rows.row_index_is_valid,
          'invalid-row-index',
          'rowIndex',
          pg_catalog.format(
            'Row %s: rowIndex must be a non-negative JSON integer number.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          25,
          canonical_rows.row_is_object
            and canonical_rows.row_index_is_valid
            and canonical_rows.logical_row_index_count > 1,
          'duplicate-row-index',
          'rowIndex',
          pg_catalog.format(
            'Row %s: rowIndex is duplicated within sourceRows.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          30,
          canonical_rows.row_is_object and not canonical_rows.effective_is_valid,
          'invalid-effective-date',
          'Effective',
          pg_catalog.format(
            'Row %s: Effective must be a valid ISO calendar date.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          40,
          canonical_rows.row_is_object and not canonical_rows.discontinue_is_valid,
          'invalid-discontinue-date',
          'Discontinue',
          pg_catalog.format(
            'Row %s: Discontinue must be a valid ISO calendar date.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          50,
          canonical_rows.row_is_object
            and canonical_rows.effective_is_valid
            and canonical_rows.discontinue_is_valid
            and (
              canonical_rows.effective_year * 10000
              + canonical_rows.effective_month * 100
              + canonical_rows.effective_day
            ) > (
              canonical_rows.discontinue_year * 10000
              + canonical_rows.discontinue_month * 100
              + canonical_rows.discontinue_day
            ),
          'reversed-date-range',
          null::text,
          pg_catalog.format(
            'Row %s: Effective must be on or before Discontinue.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          60,
          canonical_rows.row_is_object and not canonical_rows.days_are_valid,
          'invalid-day-value',
          'daysOfWeek',
          pg_catalog.format(
            'Row %s: daysOfWeek must contain exactly seven JSON booleans.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          70,
          canonical_rows.row_is_object
            and canonical_rows.days_are_valid
            and not (canonical_rows.raw_days @> '[true]'::jsonb),
          'no-operating-days',
          null::text,
          pg_catalog.format(
            'Row %s: at least one operating day is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          80,
          canonical_rows.row_is_object
            and canonical_rows.airline_type_is_valid
            and canonical_rows.airline_value is null,
          'missing-airline',
          'Airline',
          pg_catalog.format(
            'Row %s: Airline is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          90,
          canonical_rows.row_is_object
            and canonical_rows.aircraft_type_is_valid
            and canonical_rows.aircraft_value is null,
          'missing-aircraft',
          'Aircraft',
          pg_catalog.format(
            'Row %s: Aircraft is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          100,
          canonical_rows.row_is_object
            and coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'sta'), 'null')
              in ('string', 'null')
            and canonical_rows.sta_value is not null
            and canonical_rows.sta_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',
          'invalid-time',
          'STA',
          pg_catalog.format(
            'Row %s: STA must use HH:mm from 00:00 through 23:59.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          110,
          canonical_rows.row_is_object
            and coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'std'), 'null')
              in ('string', 'null')
            and canonical_rows.std_value is not null
            and canonical_rows.std_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',
          'invalid-time',
          'STD',
          pg_catalog.format(
            'Row %s: STD must use HH:mm from 00:00 through 23:59.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          120,
          canonical_rows.row_is_object
            and canonical_rows.has_arrival
            and not canonical_rows.has_complete_arrival,
          'incomplete-flight-side',
          'ARR',
          pg_catalog.format(
            'Row %s: ARR must include STA, ARRFlight, and ARRRoute together.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          130,
          canonical_rows.row_is_object
            and canonical_rows.has_departure
            and not canonical_rows.has_complete_departure,
          'incomplete-flight-side',
          'DEP',
          pg_catalog.format(
            'Row %s: DEP must include STD, DEPFlight, and DEPRoute together.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          140,
          canonical_rows.row_is_object
            and not canonical_rows.has_complete_arrival
            and not canonical_rows.has_complete_departure,
          'no-flight-side',
          null::text,
          pg_catalog.format(
            'Row %s: at least one complete ARR or DEP side is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          150,
          canonical_rows.row_is_object
            and canonical_rows.link_type_type_is_valid
            and canonical_rows.link_type_value is not null
            and canonical_rows.link_type_value not in ('overnight', 'sameday'),
          'invalid-link-type',
          'linkType',
          pg_catalog.format(
            'Row %s: linkType must be overnight or sameday.',
            canonical_rows.diagnostic_row_index
          )
        )
    ) as row_issues(issue_order, applies, issue_code, column_name, issue_message)
    where row_issues.applies
  ), type_diagnostic_items as (
    select
      canonical_rows.staging_row_index,
      75 as issue_order,
      field_types.column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', canonical_rows.diagnostic_row_index,
        'stagingRowIndex', canonical_rows.staging_row_index,
        'code', 'invalid-field-type',
        'column', field_types.column_name,
        'message', pg_catalog.format(
          'Row %s: %s must be %s.',
          canonical_rows.diagnostic_row_index,
          field_types.column_name,
          field_types.expected_type
        )
      ) as issue
    from canonical_rows
    cross join lateral (
      values
        ('Effective', canonical_rows.effective_type_is_valid, 'a JSON string'),
        ('Discontinue', canonical_rows.discontinue_type_is_valid, 'a JSON string'),
        ('Airline', canonical_rows.airline_type_is_valid, 'a JSON string'),
        ('Aircraft', canonical_rows.aircraft_type_is_valid, 'a JSON string'),
        (
          'STA',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'sta'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlight',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlight'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlightType',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlightType'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRRoute',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrRoute'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlightCategory',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlightCategory'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRCodeShares',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrCodeShares'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRIntDomInd',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrIntDomInd'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'STD',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'std'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlight',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlight'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlightType',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlightType'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPRoute',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depRoute'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlightCategory',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlightCategory'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPCodeShares',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depCodeShares'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPIntDomInd',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depIntDomInd'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'overnightLinkRowIndex',
          canonical_rows.overnight_link_index_type_is_valid,
          'a non-negative JSON integer number, null, or absent'
        ),
        (
          'linkType',
          canonical_rows.link_type_type_is_valid,
          'a JSON string, null, or absent'
        )
    ) as field_types(column_name, type_is_valid, expected_type)
    where canonical_rows.row_is_object
      and not field_types.type_is_valid
  ), diagnostic_items as (
    select * from row_diagnostic_items
    union all
    select * from type_diagnostic_items
  )
  select
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          canonical_rows.canonical_row
          order by canonical_rows.staging_row_index
        )
        from canonical_rows
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select pg_catalog.jsonb_agg(limited_diagnostics.issue order by limited_diagnostics.item_order)
        from (
          select
            diagnostic_items.issue,
            pg_catalog.row_number() over (
              order by
                diagnostic_items.staging_row_index,
                diagnostic_items.issue_order,
                diagnostic_items.column_name
            ) as item_order
          from diagnostic_items
          order by
            diagnostic_items.staging_row_index,
            diagnostic_items.issue_order,
            diagnostic_items.column_name
          limit v_max_actionable_diagnostics
        ) limited_diagnostics
      ),
      '[]'::jsonb
    ),
    (select pg_catalog.count(*)::integer from diagnostic_items)
  into v_canonical_source_rows, v_diagnostics, v_diagnostic_count;

  if v_diagnostic_count > v_max_actionable_diagnostics then
    v_diagnostics := v_diagnostics || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'rowIndex', null,
        'stagingRowIndex', null,
        'code', 'diagnostics-truncated',
        'column', null,
        'message', pg_catalog.format(
          'Showing the first %s of %s diagnostics. Fix the listed rows and retry.',
          v_max_actionable_diagnostics,
          v_diagnostic_count
        ),
        'shownDiagnostics', v_max_actionable_diagnostics,
        'totalDiagnostics', v_diagnostic_count
      )
    );
  end if;

  if v_diagnostic_count = 0 then
    select preflight.max_date_span, preflight.atomic_side_count
    into v_max_date_span, v_atomic_side_count
    from public.seasonal_import_expansion_preflight_v2(
      v_canonical_source_rows
    ) preflight;

    if v_max_date_span > v_max_seasonal_date_span then
      raise exception 'Seasonal source date span % exceeds maximum date span of % days',
        v_max_date_span,
        v_max_seasonal_date_span
        using errcode = '22023';
    end if;

    if v_atomic_side_count > v_max_generated_atomic_count then
      raise exception 'Seasonal atomic record count % exceeds maximum of %',
        v_atomic_side_count,
        v_max_generated_atomic_count
        using errcode = '22023';
    end if;
  end if;

  -- Block concurrent season inserts/updates until lookup and batch insert finish.
  lock table public.seasons in share mode;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(seasons.id)
  into v_season_match_count, v_season_id
  from public.seasons seasons
  where pg_catalog.upper(pg_catalog.btrim(seasons.season_code)) = v_season_code;

  if v_season_match_count > 1 then
    raise exception 'Ambiguous seasonCode % matched % existing seasons', v_season_code, v_season_match_count
      using errcode = '21000';
  end if;

  if v_requested_season_id is not null
    and (v_season_match_count = 0 or v_season_id is distinct from v_requested_season_id)
  then
    raise exception 'seasonId % does not match seasonCode %', v_requested_season_id, v_season_code
      using errcode = '22023';
  end if;

  v_target_season_id := coalesce(
    v_season_id,
    'season-' || pg_catalog.gen_random_uuid()::text
  );

  v_request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'fingerprintVersion', 2,
          'sourceRows', v_source_rows,
          'seasonIdentity', pg_catalog.jsonb_build_object(
            'seasonCode', v_season_code,
            'targetSeasonId', v_target_season_id
          ),
          'expectedDataVersion', v_expected_data_version,
          'fileName', v_file_name
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    file_name,
    checksum,
    status,
    source_row_count,
    diagnostics,
    result,
    created_by
  )
  values (
    v_request_id,
    v_season_id,
    v_season_code,
    v_expected_data_version,
    v_file_name,
    v_checksum,
    case
      when pg_catalog.jsonb_array_length(v_diagnostics) = 0 then 'staged'
      else 'failed'
    end,
    v_source_row_count,
    v_diagnostics,
    pg_catalog.jsonb_build_object(
      '_staging', pg_catalog.jsonb_build_object(
        'fingerprintVersion', 2,
        'requestFingerprint', v_request_fingerprint,
        'targetSeasonId', v_target_season_id
      )
    ),
    auth.uid()
  )
  on conflict (request_id) do nothing
  returning * into v_batch;

  if not found then
    select batches.*
    into v_batch
    from public.season_import_batches batches
    where batches.request_id = v_request_id
      and batches.created_by = auth.uid();

    if not found then
      raise exception 'Seasonal import request is not available to the current operator'
        using errcode = '42501';
    end if;

    v_persisted_request_fingerprint :=
      v_batch.result #>> '{_staging,requestFingerprint}';
    v_target_season_id :=
      v_batch.result #>> '{_staging,targetSeasonId}';

    select coalesce(
      pg_catalog.jsonb_agg(rows.row_data order by rows.row_index),
      '[]'::jsonb
    )
    into v_persisted_source_rows
    from public.season_import_batch_rows rows
    where rows.batch_id = v_batch.batch_id;

    if v_batch.checksum is distinct from v_checksum then
      raise exception 'Import requestId % was already used with a different checksum', v_request_id
        using errcode = '23505';
    end if;

    if nullif(v_target_season_id, '') is null then
      raise exception 'Import requestId % is missing persisted target season identity', v_request_id
        using errcode = '23505';
    end if;

    if v_season_match_count = 1
      and v_season_id is distinct from v_target_season_id
    then
      raise exception 'Import requestId % target season identity conflict: seasonCode % now resolves to %, expected %',
        v_request_id,
        v_season_code,
        v_season_id,
        v_target_season_id
        using errcode = '23505';
    end if;

    v_request_fingerprint := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'fingerprintVersion', 2,
            'sourceRows', v_source_rows,
            'seasonIdentity', pg_catalog.jsonb_build_object(
              'seasonCode', v_season_code,
              'targetSeasonId', v_target_season_id
            ),
            'expectedDataVersion', v_expected_data_version,
            'fileName', v_file_name
          )::text,
          'UTF8'
        )
      ),
      'hex'
    );

    if v_persisted_request_fingerprint is distinct from v_request_fingerprint then
      raise exception 'Import requestId % was already used with a different payload', v_request_id
        using errcode = '23505';
    end if;

    if v_batch.season_code is distinct from v_season_code
      or (
        v_batch.season_id is not null
        and v_batch.season_id is distinct from v_target_season_id
      )
      or v_batch.expected_data_version is distinct from v_expected_data_version
      or v_batch.file_name is distinct from v_file_name
      or v_persisted_source_rows is distinct from v_canonical_source_rows
    then
      raise exception 'Import requestId % was already used with a different payload', v_request_id
        using errcode = '23505';
    end if;

    return pg_catalog.jsonb_build_object(
      'batchId', v_batch.batch_id,
      'status', v_batch.status,
      'sourceRowCount', v_batch.source_row_count,
      'generatedRecordCount', v_batch.generated_record_count,
      'diagnostics', v_batch.diagnostics,
      'valid', v_batch.status in ('validated', 'committed')
        and pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
    );
  end if;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select
    v_batch.batch_id,
    (source_rows.ordinality - 1)::integer,
    source_rows.row_data
  from pg_catalog.jsonb_array_elements(v_canonical_source_rows)
    with ordinality as source_rows(row_data, ordinality);

  if v_batch.status = 'staged' then
    with atomic_preview AS MATERIALIZED (
      select *
      from public.seasonal_import_atomic_preview_v2(v_batch.batch_id)
    ), ranked_diagnostics as (
      select
        atomic_preview.staging_row_index,
        atomic_preview.issue_order,
        atomic_preview.diagnostic_column_name as column_name,
        atomic_preview.issue,
        pg_catalog.row_number() over (
          order by
            atomic_preview.staging_row_index,
            atomic_preview.issue_order,
            atomic_preview.diagnostic_column_name
        ) as diagnostic_rank
      from atomic_preview
      where atomic_preview.item_kind = 'diagnostic'
    )
    select
      (
        select pg_catalog.count(*)::integer
        from atomic_preview
        where atomic_preview.item_kind = 'record'
      ),
      (
        select pg_catalog.count(*)::integer
        from ranked_diagnostics
      ),
      coalesce(
        (
          select pg_catalog.jsonb_agg(
            ranked_diagnostics.issue
            order by
              ranked_diagnostics.staging_row_index,
              ranked_diagnostics.issue_order,
              ranked_diagnostics.column_name
          )
          from ranked_diagnostics
          where ranked_diagnostics.diagnostic_rank <= v_max_actionable_diagnostics
        ),
        '[]'::jsonb
      )
    into
      v_generated_record_count,
      v_generation_diagnostic_count,
      v_generation_diagnostics;

    if v_generation_diagnostic_count > v_max_actionable_diagnostics then
      v_generation_diagnostics := v_generation_diagnostics || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', null,
          'stagingRowIndex', null,
          'code', 'diagnostics-truncated',
          'column', null,
          'message', pg_catalog.format(
            'Showing the first %s of %s generation diagnostics. Fix the listed rows and retry.',
            v_max_actionable_diagnostics,
            v_generation_diagnostic_count
          ),
          'shownDiagnostics', v_max_actionable_diagnostics,
          'totalDiagnostics', v_generation_diagnostic_count
        )
      );
    end if;

    if v_generated_record_count = 0 and v_generation_diagnostic_count = 0 then
      v_generation_diagnostics := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', null,
          'stagingRowIndex', null,
          'code', 'zero-generated-records',
          'column', null,
          'message', 'The canonical source rows do not generate any flight occurrences.'
        )
      );
      v_generation_diagnostic_count := 1;
    end if;

    v_diagnostics := v_batch.diagnostics || v_generation_diagnostics;

    update public.season_import_batches batches
    set
      status = case
        when v_generated_record_count > 0
          and v_generation_diagnostic_count = 0
          then 'validated'
        else 'failed'
      end,
      generated_record_count = v_generated_record_count,
      diagnostics = v_diagnostics
    where batches.batch_id = v_batch.batch_id
    returning batches.* into v_batch;
  end if;

  return pg_catalog.jsonb_build_object(
    'batchId', v_batch.batch_id,
    'status', v_batch.status,
    'sourceRowCount', v_batch.source_row_count,
    'generatedRecordCount', v_batch.generated_record_count,
    'diagnostics', v_batch.diagnostics,
    'valid', v_batch.status in ('validated', 'committed')
      and pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
  );
end;
$$;

create or replace function public.commit_seasonal_import_v2(
  p_batch_id uuid,
  p_expected_data_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_batch public.season_import_batches%rowtype;
  v_season public.seasons%rowtype;
  v_target_season_id text;
  v_target_season_code text;
  v_season_code_match_count integer := 0;
  v_season_code_match_id text;
  v_season_exists boolean := false;
  v_current_data_version integer;
  v_next_data_version integer;
  v_generated_record_count integer := 0;
  v_source_row_count integer := 0;
  v_flight_record_count integer := 0;
  v_effective_record_count integer := 0;
  v_preserved_operational_count integer := 0;
  v_removed_imported_count integer := 0;
  v_effective_start text;
  v_effective_end text;
  v_now_ms bigint;
  v_server_high_water bigint;
  v_collision_occurrence_key text;
  v_collision_record_id text;
  v_ambiguous_occurrence_key text;
  v_conflicting_record_id text;
  v_result jsonb;
begin
  if not public.app_operator_has_permission('seasonal.write') then
    raise exception 'Missing required permission: seasonal.write'
      using errcode = '42501';
  end if;

  if p_batch_id is null then
    raise exception 'p_batch_id is required'
      using errcode = '22023';
  end if;

  select batches.*
  into v_batch
  from public.season_import_batches batches
  where batches.batch_id = p_batch_id
    and batches.created_by = auth.uid()
  for update;

  if not found then
    raise exception 'Seasonal import request is not available to the current operator'
      using errcode = '42501';
  end if;

  if v_batch.status = 'committed' then
    if v_batch.result is null
      or v_batch.result->>'status' is distinct from 'committed'
    then
      raise exception 'Committed seasonal import batch % is missing its persisted result', p_batch_id
        using errcode = 'XX000';
    end if;

    return v_batch.result - '_staging';
  end if;

  if v_batch.status <> 'validated' then
    raise exception 'Seasonal import batch % must be validated before commit; current status is %',
      p_batch_id,
      v_batch.status
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_batch.diagnostics) is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_batch.diagnostics) <> 0
  then
    raise exception 'Seasonal import batch % contains blocking diagnostics', p_batch_id
      using errcode = '22023';
  end if;

  v_target_season_id := nullif(
    v_batch.result #>> '{_staging,targetSeasonId}',
    ''
  );
  v_target_season_code := pg_catalog.upper(pg_catalog.btrim(v_batch.season_code));

  if v_target_season_id is null then
    raise exception 'Seasonal import batch % is missing immutable _staging.targetSeasonId', p_batch_id
      using errcode = '22023';
  end if;

  if v_target_season_code = '' then
    raise exception 'Seasonal import batch % is missing seasonCode', p_batch_id
      using errcode = '22023';
  end if;

  if p_expected_data_version is null or p_expected_data_version < 0 then
    raise exception 'p_expected_data_version must be a non-negative integer'
      using errcode = '22023';
  end if;

  if v_batch.expected_data_version is null then
    raise exception 'Seasonal import batch % is missing an explicit expectedDataVersion', p_batch_id
      using errcode = '22023';
  end if;

  if p_expected_data_version is distinct from v_batch.expected_data_version then
    raise exception 'Commit expectedDataVersion % does not match staged version % for batch %',
      p_expected_data_version,
      v_batch.expected_data_version,
      p_batch_id
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_target_season_id, 0)
  );

  select seasons.*
  into v_season
  from public.seasons seasons
  where seasons.id = v_target_season_id
  for update;
  v_season_exists := found;

  perform 1
  from public.seasons seasons
  where pg_catalog.upper(pg_catalog.btrim(seasons.season_code)) = v_target_season_code
  for update;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(seasons.id)
  into v_season_code_match_count, v_season_code_match_id
  from public.seasons seasons
  where pg_catalog.upper(pg_catalog.btrim(seasons.season_code)) = v_target_season_code;

  if v_season_code_match_count > 1 then
    raise exception 'Ambiguous seasonCode % matched % existing seasons',
      v_target_season_code,
      v_season_code_match_count
      using errcode = '21000';
  end if;

  if v_season_exists then
    if pg_catalog.upper(pg_catalog.btrim(v_season.season_code))
        is distinct from v_target_season_code
      or v_season_code_match_count <> 1
      or v_season_code_match_id is distinct from v_target_season_id
    then
      raise exception 'Reserved target season % does not match seasonCode %',
        v_target_season_id,
        v_target_season_code
        using errcode = '23505';
    end if;

    if v_batch.season_id is not null
      and v_batch.season_id is distinct from v_target_season_id
    then
      raise exception 'Batch season identity % does not match reserved target %',
        v_batch.season_id,
        v_target_season_id
        using errcode = '23505';
    end if;

    v_current_data_version := v_season.data_version;
  else
    if v_batch.season_id is not null then
      raise exception 'Existing batch season % no longer exists', v_batch.season_id
        using errcode = '23503';
    end if;

    if v_season_code_match_count <> 0 then
      raise exception 'seasonCode % belongs to season %, not reserved target %',
        v_target_season_code,
        v_season_code_match_id,
        v_target_season_id
        using errcode = '23505';
    end if;

    v_current_data_version := 0;
  end if;

  if p_expected_data_version <> v_current_data_version then
    raise exception 'Stale seasonal data version for %: expected %, current %',
      v_target_season_id,
      p_expected_data_version,
      v_current_data_version
      using errcode = '40001';
  end if;

  if not v_season_exists then
    if p_expected_data_version <> 0 then
      raise exception 'New season % must commit from expectedDataVersion 0',
        v_target_season_id
        using errcode = '40001';
    end if;

    insert into public.seasons (
      id,
      season_code,
      name,
      file_name,
      uploaded_at,
      effective_start,
      effective_end,
      total_legs,
      total_source_rows,
      data_version,
      last_synced_at
    ) values (
      v_target_season_id,
      v_target_season_code,
      v_target_season_code,
      '',
      0,
      '',
      '',
      0,
      0,
      0,
      null
    );
  end if;

  drop table if exists pg_temp.seasonal_import_commit_records_v2;
  drop table if exists pg_temp.seasonal_import_commit_existing_v2;
  drop table if exists pg_temp.seasonal_import_commit_matches_v2;
  drop table if exists pg_temp.seasonal_import_commit_old_records_v2;
  drop table if exists pg_temp.seasonal_import_commit_affected_ids_v2;
  drop table if exists pg_temp.seasonal_import_commit_effective_manual_v2;
  drop table if exists pg_temp.seasonal_import_commit_effective_manual_ids_v2;

  create temporary table seasonal_import_commit_records_v2
  on commit drop
  as
  select
    generated.record_id as generated_record_id,
    generated.occurrence_key,
    generated.link_id,
    generated.type,
    generated.airline,
    generated.flight_number,
    generated.raw_flight_number,
    generated.route,
    generated.schedule,
    generated.aircraft,
    generated.category,
    generated.code_shares,
    generated.int_dom_ind,
    generated.scheduled_date,
    generated.operational_date,
    generated.day_of_week,
    generated.source_row_index,
    generated.linked_source_row_index,
    generated.link_type,
    generated.pair_anchor_date,
    generated.linked_record_id,
    generated.turnaround_id,
    generated.record_id as final_record_id,
    null::text as matched_record_id
  from public.generate_seasonal_import_records_v2(p_batch_id) generated;

  create unique index seasonal_import_commit_occurrence_v2
    on pg_temp.seasonal_import_commit_records_v2 (occurrence_key);
  create unique index seasonal_import_commit_generated_id_v2
    on pg_temp.seasonal_import_commit_records_v2 (generated_record_id);

  select pg_catalog.count(*)::integer
  into v_generated_record_count
  from pg_temp.seasonal_import_commit_records_v2;

  if v_generated_record_count = 0
    or v_generated_record_count <> v_batch.generated_record_count
  then
    raise exception 'Generated record count mismatch for batch %: staged %, materialized %',
      p_batch_id,
      v_batch.generated_record_count,
      v_generated_record_count
      using errcode = 'P0001';
  end if;

  create temporary table seasonal_import_commit_effective_manual_v2
  on commit drop
  as
  with manual_candidates as (
    select
      records.record_id as leg_id,
      records.record_id,
      coalesce(nullif(records.scheduled_date, ''), nullif(records.date, '')) as scheduled_date,
      pg_catalog.upper(pg_catalog.btrim(records.airline)) as airline,
      coalesce(nullif(records.flight_number, ''), records.raw_flight_number) as raw_flight_number,
      array[records.record_id]::text[] as protected_ids,
      0 as source_priority
    from public.season_flight_records records
    left join public.season_modifications modifications
      on modifications.season_id = records.season_id
      and modifications.leg_id = records.record_id
    where records.season_id = v_target_season_id
      and (records.source_kind = 'added' or records.action = 'added')
      and records.status = 'active'
      and records.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'
    union all
    select
      added_legs.leg_id,
      added_legs.record_id,
      coalesce(nullif(added_legs.scheduled_date, ''), nullif(added_legs.date, '')),
      pg_catalog.upper(pg_catalog.btrim(added_legs.airline)),
      coalesce(nullif(added_legs.flight_number, ''), added_legs.raw_flight_number),
      array[added_legs.leg_id, added_legs.record_id]::text[],
      1
    from public.season_modification_added_legs added_legs
    join public.season_modifications modifications
      on modifications.leg_id = added_legs.leg_id
      and modifications.season_id = added_legs.season_id
    where added_legs.season_id = v_target_season_id
      and added_legs.source_kind = 'added'
      and added_legs.status = 'active'
      and added_legs.action is distinct from 'deleted'
      and modifications.action = 'added'
  ), manual_ids_by_leg as (
    select
      manual_candidates.leg_id,
      pg_catalog.array_agg(
        distinct protected.manual_id
        order by protected.manual_id
      ) as protected_ids
    from manual_candidates
    cross join lateral pg_catalog.unnest(
      manual_candidates.protected_ids
    ) protected(manual_id)
    where nullif(pg_catalog.btrim(protected.manual_id), '') is not null
    group by manual_candidates.leg_id
  ), ranked_manual as (
    select
      manual_candidates.*,
      pg_catalog.row_number() over (
        partition by manual_candidates.leg_id
        order by manual_candidates.source_priority, manual_candidates.record_id
      ) as manual_rank
    from manual_candidates
  )
  select
    ranked_manual.leg_id,
    ranked_manual.record_id,
    ranked_manual.scheduled_date,
    ranked_manual.airline,
    normalized.flight_number,
    manual_ids_by_leg.protected_ids,
    case
      when ranked_manual.scheduled_date is null or normalized.flight_number is null then null
      else
      v_target_season_id
        || '|'
        || ranked_manual.scheduled_date
        || '|'
        || ranked_manual.airline
        || '|'
        || normalized.flight_number
    end as occurrence_key
  from ranked_manual
  join manual_ids_by_leg
    on manual_ids_by_leg.leg_id = ranked_manual.leg_id
  left join lateral public.normalize_seasonal_flight_number_v2(
    ranked_manual.airline,
    ranked_manual.raw_flight_number
  ) normalized on true
  where ranked_manual.manual_rank = 1;

  create unique index seasonal_import_commit_effective_manual_leg_v2
    on pg_temp.seasonal_import_commit_effective_manual_v2 (leg_id);
  create index seasonal_import_commit_effective_manual_occurrence_v2
    on pg_temp.seasonal_import_commit_effective_manual_v2 (occurrence_key);

  create temporary table seasonal_import_commit_effective_manual_ids_v2
  on commit drop
  as
  select
    protected.manual_id,
    pg_catalog.min(manual.leg_id) as owner_leg_id
  from pg_temp.seasonal_import_commit_effective_manual_v2 manual
  cross join lateral pg_catalog.unnest(
    manual.protected_ids
  ) protected(manual_id)
  group by protected.manual_id;

  create unique index seasonal_import_commit_effective_manual_id_v2
    on pg_temp.seasonal_import_commit_effective_manual_ids_v2 (manual_id);

  select generated.occurrence_key, manual.record_id
  into v_collision_occurrence_key, v_collision_record_id
  from pg_temp.seasonal_import_commit_records_v2 generated
  join pg_temp.seasonal_import_commit_effective_manual_v2 manual
    on manual.occurrence_key = generated.occurrence_key
  order by generated.occurrence_key, manual.record_id
  limit 1;

  if found then
    raise exception 'Manual added occurrence collision for % with record %',
      v_collision_occurrence_key,
      v_collision_record_id
      using errcode = '23505';
  end if;

  create temporary table seasonal_import_commit_existing_v2
  on commit drop
  as
  select
    records.record_id,
    records.type,
    records.status,
    coalesce(nullif(records.scheduled_date, ''), records.date) as scheduled_date,
    pg_catalog.upper(pg_catalog.btrim(records.airline)) as airline,
    normalized.flight_number
  from public.season_flight_records records
  cross join lateral public.normalize_seasonal_flight_number_v2(
    records.airline,
    coalesce(nullif(records.flight_number, ''), records.raw_flight_number)
  ) normalized
  where records.season_id = v_target_season_id
    and records.source_kind = 'imported';

  create unique index seasonal_import_commit_existing_id_v2
    on pg_temp.seasonal_import_commit_existing_v2 (record_id);
  create index seasonal_import_commit_existing_identity_v2
    on pg_temp.seasonal_import_commit_existing_v2 (
      scheduled_date,
      airline,
      flight_number,
      status
    );

  select generated.occurrence_key
  into v_ambiguous_occurrence_key
  from pg_temp.seasonal_import_commit_records_v2 generated
  join pg_temp.seasonal_import_commit_existing_v2 existing
    on existing.scheduled_date = generated.scheduled_date
    and existing.airline = generated.airline
    and existing.flight_number = generated.flight_number
    and existing.status = 'active'
  group by generated.generated_record_id, generated.occurrence_key
  having pg_catalog.count(*) > 1
  order by generated.occurrence_key
  limit 1;

  if found then
    raise exception 'Ambiguous existing imported occurrence % has multiple matching records',
      v_ambiguous_occurrence_key
      using errcode = '21000';
  end if;

  create temporary table seasonal_import_commit_matches_v2
  on commit drop
  as
  select
    generated.generated_record_id,
    pg_catalog.min(existing.record_id) as matched_record_id
  from pg_temp.seasonal_import_commit_records_v2 generated
  join pg_temp.seasonal_import_commit_existing_v2 existing
    on existing.scheduled_date = generated.scheduled_date
    and existing.airline = generated.airline
    and existing.flight_number = generated.flight_number
    and existing.status = 'active'
  group by generated.generated_record_id;

  update pg_temp.seasonal_import_commit_records_v2 generated
  set
    matched_record_id = matches.matched_record_id,
    final_record_id = matches.matched_record_id
  from pg_temp.seasonal_import_commit_matches_v2 matches
  where matches.generated_record_id = generated.generated_record_id;

  create unique index seasonal_import_commit_final_id_v2
    on pg_temp.seasonal_import_commit_records_v2 (final_record_id);

  select generated.final_record_id
  into v_conflicting_record_id
  from pg_temp.seasonal_import_commit_records_v2 generated
  join pg_temp.seasonal_import_commit_effective_manual_ids_v2 manual_ids
    on manual_ids.manual_id = generated.final_record_id
  order by generated.final_record_id
  limit 1;

  if found then
    raise exception 'Generated record ID % collides with an effective manual ID',
      v_conflicting_record_id
      using errcode = '23505';
  end if;

  select records.record_id
  into v_conflicting_record_id
  from pg_temp.seasonal_import_commit_records_v2 generated
  join public.season_flight_records records
    on records.record_id = generated.final_record_id
  where records.season_id is distinct from v_target_season_id
    or records.source_kind <> 'imported'
  order by records.record_id
  limit 1;

  if found then
    raise exception 'Generated record ID % already belongs to another season',
      v_conflicting_record_id
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from pg_temp.seasonal_import_commit_records_v2 generated
    left join pg_temp.seasonal_import_commit_records_v2 counterpart
      on counterpart.generated_record_id = generated.linked_record_id
    where generated.linked_record_id is not null
      and counterpart.generated_record_id is null
  ) then
    raise exception 'Generated import contains an unresolved linked record'
      using errcode = 'P0001';
  end if;

  create temporary table seasonal_import_commit_old_records_v2
  on commit drop
  as
  select existing.record_id
  from pg_temp.seasonal_import_commit_existing_v2 existing;

  create unique index seasonal_import_commit_old_record_id_v2
    on pg_temp.seasonal_import_commit_old_records_v2 (record_id);

  create temporary table seasonal_import_commit_affected_ids_v2
  on commit drop
  as
  select old_records.record_id
  from pg_temp.seasonal_import_commit_old_records_v2 old_records
  union
  select generated.final_record_id
  from pg_temp.seasonal_import_commit_records_v2 generated;

  create unique index seasonal_import_commit_affected_id_v2
    on pg_temp.seasonal_import_commit_affected_ids_v2 (record_id);

  select pg_catalog.count(*)::integer
  into v_preserved_operational_count
  from pg_temp.seasonal_import_commit_records_v2 generated
  where generated.matched_record_id is not null;

  select pg_catalog.count(*)::integer
  into v_removed_imported_count
  from pg_temp.seasonal_import_commit_old_records_v2 old_records
  where not exists (
    select 1
    from pg_temp.seasonal_import_commit_records_v2 generated
    where generated.final_record_id = old_records.record_id
  );

  update public.season_modifications modifications
  set
    action = 'modified',
    changed_fields = array(
      select allowed.field_name
      from pg_catalog.unnest(array[
        'pax',
        'gate',
        'stand',
        'counter',
        'checkInStart',
        'checkInEnd',
        'checkInAllocationMode',
        'checkInCounterWindows',
        'carousel',
        'mct',
        'fb',
        'lb',
        'bhs',
        'ghs'
      ]::text[]) with ordinality allowed(field_name, field_order)
      where allowed.field_name = any(modifications.changed_fields)
      order by allowed.field_order
    ),
    schedule = null,
    aircraft = null,
    route = null,
    code_shares = null
  where modifications.season_id = v_target_season_id
    and modifications.action = 'modified'
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_affected_ids_v2 affected
      where affected.record_id = modifications.leg_id
    );

  delete from public.season_modifications modifications
  where modifications.season_id = v_target_season_id
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_affected_ids_v2 affected
      where affected.record_id = modifications.leg_id
    )
    and (
      not exists (
        select 1
        from pg_temp.seasonal_import_commit_records_v2 generated
        where generated.final_record_id = modifications.leg_id
      )
      or modifications.action <> 'modified'
      or pg_catalog.cardinality(modifications.changed_fields) = 0
    );

  delete from public.season_modification_counters counters
  using public.season_modifications modifications
  where modifications.leg_id = counters.leg_id
    and modifications.season_id = v_target_season_id
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_affected_ids_v2 affected
      where affected.record_id = modifications.leg_id
    )
    and not ('counter' = any(modifications.changed_fields));

  delete from public.season_modification_checkin_windows windows
  using public.season_modifications modifications
  where modifications.leg_id = windows.leg_id
    and modifications.season_id = v_target_season_id
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_affected_ids_v2 affected
      where affected.record_id = modifications.leg_id
    )
    and not ('checkInCounterWindows' = any(modifications.changed_fields));

  delete from public.season_modification_added_legs added_legs
  where added_legs.season_id = v_target_season_id
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_affected_ids_v2 affected
      where affected.record_id = added_legs.leg_id
    );

  delete from public.season_flight_records records
  where records.season_id = v_target_season_id
    and records.source_kind = 'imported'
    and exists (
      select 1
      from pg_temp.seasonal_import_commit_old_records_v2 old_records
      where old_records.record_id = records.record_id
    )
    and (
      not exists (
        select 1
        from pg_temp.seasonal_import_commit_records_v2 generated
        where generated.final_record_id = records.record_id
      )
      or exists (
        select 1
        from pg_temp.seasonal_import_commit_records_v2 generated
        where generated.final_record_id = records.record_id
          and generated.matched_record_id is null
      )
    );

  insert into public.season_flight_records (
    season_id,
    record_id,
    link_id,
    type,
    airline,
    flight_number,
    raw_flight_number,
    request_status_code,
    route,
    schedule,
    aircraft,
    category,
    code_shares,
    int_dom_ind,
    pax,
    gate,
    stand,
    carousel,
    mct,
    fb,
    lb,
    bhs,
    ghs,
    date,
    scheduled_date,
    scheduled_time,
    operational_date,
    iata_season_code,
    flight_series_id,
    day_of_week,
    action,
    source_row_index,
    linked_source_row_index,
    link_type,
    pair_anchor_date,
    linked_record_id,
    source_kind,
    source_side,
    status,
    turnaround_id
  )
  select
    v_target_season_id,
    generated.final_record_id,
    coalesce(generated.turnaround_id, generated.final_record_id),
    generated.type,
    generated.airline,
    generated.flight_number,
    generated.raw_flight_number,
    existing.request_status_code,
    generated.route,
    generated.schedule,
    generated.aircraft,
    generated.category,
    generated.code_shares,
    generated.int_dom_ind,
    existing.pax,
    existing.gate,
    existing.stand,
    existing.carousel,
    existing.mct,
    existing.fb,
    existing.lb,
    existing.bhs,
    existing.ghs,
    generated.scheduled_date,
    generated.scheduled_date,
    generated.schedule,
    generated.operational_date,
    v_target_season_code,
    'SER_'
      || pg_catalog.regexp_replace(generated.type, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(generated.airline, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(generated.flight_number, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(generated.route, '[^A-Z0-9]+', '_', 'g'),
    generated.day_of_week,
    null,
    generated.source_row_index,
    generated.linked_source_row_index,
    generated.link_type,
    generated.pair_anchor_date,
    counterpart.final_record_id,
    'imported',
    case when generated.type = 'D' then 'DEP' else 'ARR' end,
    'active',
    generated.turnaround_id
  from pg_temp.seasonal_import_commit_records_v2 generated
  left join public.season_flight_records existing
    on existing.record_id = generated.final_record_id
    and existing.season_id = v_target_season_id
    and existing.source_kind = 'imported'
    and generated.matched_record_id is not null
  left join pg_temp.seasonal_import_commit_records_v2 counterpart
    on counterpart.generated_record_id = generated.linked_record_id
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

  delete from public.season_source_rows source_rows
  where source_rows.season_id = v_target_season_id;

  insert into public.season_source_rows (
    season_id,
    row_index,
    effective,
    discontinue,
    airline,
    aircraft,
    sta,
    arr_flight,
    arr_route,
    arr_category,
    arr_code_shares,
    arr_int_dom_ind,
    std,
    dep_flight,
    dep_route,
    dep_category,
    dep_code_shares,
    dep_int_dom_ind,
    overnight_link_row_index,
    link_type
  )
  select
    v_target_season_id,
    (batch_rows.row_data->>'rowIndex')::integer,
    batch_rows.row_data->>'effective',
    batch_rows.row_data->>'discontinue',
    batch_rows.row_data->>'airline',
    batch_rows.row_data->>'aircraft',
    batch_rows.row_data->>'sta',
    batch_rows.row_data->>'arrFlight',
    batch_rows.row_data->>'arrRoute',
    batch_rows.row_data->>'arrFlightCategory',
    batch_rows.row_data->>'arrCodeShares',
    batch_rows.row_data->>'arrIntDomInd',
    batch_rows.row_data->>'std',
    batch_rows.row_data->>'depFlight',
    batch_rows.row_data->>'depRoute',
    batch_rows.row_data->>'depFlightCategory',
    batch_rows.row_data->>'depCodeShares',
    batch_rows.row_data->>'depIntDomInd',
    nullif(batch_rows.row_data->>'overnightLinkRowIndex', '')::integer,
    nullif(batch_rows.row_data->>'linkType', '')
  from public.season_import_batch_rows batch_rows
  where batch_rows.batch_id = p_batch_id;

  select pg_catalog.count(*)::integer
  into v_source_row_count
  from public.season_source_rows source_rows
  where source_rows.season_id = v_target_season_id;

  if v_source_row_count <> v_batch.source_row_count then
    raise exception 'Read-back source row count mismatch for batch %: staged %, committed %',
      p_batch_id,
      v_batch.source_row_count,
      v_source_row_count
      using errcode = 'P0001';
  end if;

  insert into public.season_source_row_days (
    season_id,
    row_index,
    iso_dow
  )
  select
    v_target_season_id,
    (batch_rows.row_data->>'rowIndex')::integer,
    days.ordinality::integer
  from public.season_import_batch_rows batch_rows
  cross join lateral pg_catalog.jsonb_array_elements(
    batch_rows.row_data->'daysOfWeek'
  ) with ordinality days(day_value, ordinality)
  where batch_rows.batch_id = p_batch_id
    and (days.day_value #>> '{}')::boolean;

  select pg_catalog.count(*)::integer
  into v_source_row_count
  from public.season_source_rows source_rows
  where source_rows.season_id = v_target_season_id;

  select pg_catalog.count(*)::integer
  into v_flight_record_count
  from public.season_flight_records records
  where records.season_id = v_target_season_id
    and records.source_kind = 'imported';

  with effective_schedule_candidates as (
    select
      records.record_id as leg_id,
      coalesce(nullif(records.scheduled_date, ''), nullif(records.date, '')) as scheduled_date,
      0 as source_priority
    from public.season_flight_records records
    left join public.season_modifications modifications
      on modifications.season_id = records.season_id
      and modifications.leg_id = records.record_id
    where records.season_id = v_target_season_id
      and records.source_kind = 'imported'
      and records.status = 'active'
      and records.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'
    union all
    select
      manual.leg_id,
      manual.scheduled_date,
      1
    from pg_temp.seasonal_import_commit_effective_manual_v2 manual
  ), ranked_effective_schedule as (
    select
      effective_schedule_candidates.*,
      pg_catalog.row_number() over (
        partition by effective_schedule_candidates.leg_id
        order by effective_schedule_candidates.source_priority
      ) as effective_rank
    from effective_schedule_candidates
  )
  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(ranked_effective_schedule.scheduled_date),
    pg_catalog.max(ranked_effective_schedule.scheduled_date)
  into v_effective_record_count, v_effective_start, v_effective_end
  from ranked_effective_schedule
  where ranked_effective_schedule.effective_rank = 1;

  if v_source_row_count <> v_batch.source_row_count then
    raise exception 'Read-back source row count mismatch for batch %: staged %, committed %',
      p_batch_id,
      v_batch.source_row_count,
      v_source_row_count
      using errcode = 'P0001';
  end if;

  if v_flight_record_count <> v_batch.generated_record_count
    or v_flight_record_count <> v_generated_record_count
  then
    raise exception 'Read-back imported flight record count mismatch for batch %: staged %, generated %, committed %',
      p_batch_id,
      v_batch.generated_record_count,
      v_generated_record_count,
      v_flight_record_count
      using errcode = 'P0001';
  end if;

  v_now_ms := pg_catalog.floor(
    extract(epoch from pg_catalog.clock_timestamp()) * 1000
  )::bigint;
  v_next_data_version := v_current_data_version + 1;

  update public.seasons seasons
  set
    season_code = v_target_season_code,
    file_name = v_batch.file_name,
    uploaded_at = v_now_ms,
    effective_start = coalesce(v_effective_start, ''),
    effective_end = coalesce(v_effective_end, ''),
    total_legs = v_effective_record_count,
    total_source_rows = v_source_row_count,
    data_version = v_next_data_version,
    last_synced_at = v_now_ms
  where seasons.id = v_target_season_id
    and seasons.data_version = v_current_data_version;

  if not found then
    raise exception 'Season % changed while committing batch %',
      v_target_season_id,
      p_batch_id
      using errcode = '40001';
  end if;

  insert into public.season_change_events (
    event_id,
    season_id,
    client_id,
    op_id,
    actor_user_id,
    target_type,
    target_id,
    changed_fields,
    op_payload
  ) values (
    'seasonal-import-v2:' || p_batch_id::text,
    v_target_season_id,
    'seasonal-import-v2',
    p_batch_id::text,
    auth.uid(),
    'seasonImport',
    v_target_season_id,
    array['sourceRows', 'flightRecords', 'modifications', 'seasonMetadata'],
    pg_catalog.jsonb_build_object(
      'kind', 'commit_seasonal_import_v2',
      'batchId', p_batch_id,
      'seasonId', v_target_season_id,
      'seasonCode', v_target_season_code,
      'sourceRowCount', v_source_row_count,
      'flightRecordCount', v_flight_record_count,
      'preservedOperationalCount', v_preserved_operational_count,
      'removedImportedCount', v_removed_imported_count,
      'dataVersion', v_next_data_version,
      'checksum', v_batch.checksum
    )
  )
  returning server_seq into v_server_high_water;

  insert into public.season_entity_versions (
    season_id,
    target_type,
    target_id,
    entity_version,
    field_versions,
    updated_by,
    updated_at
  ) values (
    v_target_season_id,
    'seasonImport',
    v_target_season_id,
    v_server_high_water,
    pg_catalog.jsonb_build_object(
      'sourceRows', v_server_high_water,
      'flightRecords', v_server_high_water,
      'modifications', v_server_high_water,
      'seasonMetadata', v_server_high_water
    ),
    auth.uid(),
    pg_catalog.now()
  )
  on conflict (season_id, target_type, target_id) do update set
    entity_version = public.season_entity_versions.entity_version + 1,
    field_versions = excluded.field_versions,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  v_result := pg_catalog.jsonb_build_object(
    'batchId', p_batch_id,
    'seasonId', v_target_season_id,
    'seasonCode', v_target_season_code,
    'status', 'committed',
    'sourceRowCount', v_source_row_count,
    'flightRecordCount', v_flight_record_count,
    'preservedOperationalCount', v_preserved_operational_count,
    'removedImportedCount', v_removed_imported_count,
    'dataVersion', v_next_data_version,
    'serverHighWater', v_server_high_water,
    'checksum', v_batch.checksum
  );

  update public.season_import_batches batches
  set
    season_id = v_target_season_id,
    status = 'committed',
    generated_record_count = v_flight_record_count,
    result = v_result,
    committed_at = pg_catalog.now()
  where batches.batch_id = p_batch_id
    and batches.status = 'validated';

  if not found then
    raise exception 'Seasonal import batch % changed before commit receipt was persisted', p_batch_id
      using errcode = '40001';
  end if;

  return v_result;
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

create or replace function public.get_seasonal_export_snapshot_v2(
  p_season_id text,
  p_expected_data_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_snapshot_state jsonb;
begin
  if auth.uid() is null
    or not public.app_operator_has_permission('seasonal.read')
  then
    raise exception 'seasonal.read permission is required'
      using errcode = '42501';
  end if;

  if p_season_id is null or pg_catalog.btrim(p_season_id) = '' then
    raise exception 'p_season_id is required'
      using errcode = '22023';
  end if;

  if p_expected_data_version is null or p_expected_data_version < 0 then
    raise exception 'p_expected_data_version must be a non-negative integer'
      using errcode = '22023';
  end if;

  -- STABLE keeps every relation below on the calling statement's MVCC snapshot.
  select pg_catalog.jsonb_build_object(
    'found', true,
    'versionMatches', seasons.data_version = p_expected_data_version,
    'actualVersion', seasons.data_version,
    'payload', case
      when seasons.data_version <> p_expected_data_version then null
      else pg_catalog.jsonb_build_object(
        'seasonId', seasons.id,
        'dataVersion', seasons.data_version,
        'totalCount', (
          select pg_catalog.count(*)
          from public.season_flight_records records
          where records.season_id = seasons.id
        ),
        'serverHighWater', coalesce((
          select pg_catalog.max(events.server_seq)
          from public.season_change_events events
          where events.season_id = seasons.id
        ), 0::bigint),
        'truncated', false,
        'flightRecords', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(records) order by records.record_id)
          from public.season_flight_records records
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'flightRecordCounters', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(counters)
            order by counters.record_id, counters.counter_group, counters.item_index
          )
          from public.season_flight_record_counters counters
          join public.season_flight_records records
            on records.record_id = counters.record_id
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'flightRecordWindows', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(windows)
            order by windows.record_id, windows.counter_key
          )
          from public.season_flight_record_checkin_windows windows
          join public.season_flight_records records
            on records.record_id = windows.record_id
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'modifications', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(modifications) order by modifications.leg_id)
          from public.season_modifications modifications
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationCounters', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(counters)
            order by counters.leg_id, counters.counter_group, counters.item_index
          )
          from public.season_modification_counters counters
          join public.season_modifications modifications
            on modifications.leg_id = counters.leg_id
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationWindows', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(windows)
            order by windows.leg_id, windows.counter_key
          )
          from public.season_modification_checkin_windows windows
          join public.season_modifications modifications
            on modifications.leg_id = windows.leg_id
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationAddedLegs', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(added_legs) order by added_legs.leg_id)
          from public.season_modification_added_legs added_legs
          where added_legs.season_id = seasons.id
        ), '[]'::jsonb)
      )
    end
  )
  into v_snapshot_state
  from public.seasons seasons
  where seasons.id = p_season_id;

  if v_snapshot_state is null then
    raise exception 'Season % does not exist', p_season_id
      using errcode = 'P0002';
  end if;

  if not (v_snapshot_state->>'versionMatches')::boolean then
    raise exception 'Season % data version changed: expected %, got %',
      p_season_id,
      p_expected_data_version,
      v_snapshot_state->>'actualVersion'
      using errcode = '40001';
  end if;

  return v_snapshot_state->'payload';
end;
$$;

revoke execute on function public.get_seasonal_export_snapshot_v2(text, integer) from public, anon;
grant execute on function public.get_seasonal_export_snapshot_v2(text, integer) to authenticated;

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
revoke all on table public.season_import_batches from public, anon, authenticated;
revoke all on table public.season_import_batch_rows from public, anon, authenticated;

revoke execute on function public.preserve_season_import_batch_staging_metadata_v2()
  from public, anon, authenticated;
revoke execute on function public.normalize_seasonal_flight_number_v2(text, text)
  from public, anon, authenticated;
revoke execute on function public.seasonal_operational_date_v2(date, time)
  from public, anon, authenticated;
revoke execute on function public.seasonal_record_id_v2(text, text, date, text, text)
  from public, anon, authenticated;
revoke execute on function public.seasonal_import_expansion_preflight_v2(jsonb)
  from public, anon, authenticated;
revoke execute on function public.seasonal_import_atomic_preview_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.generate_seasonal_import_records_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.seasonal_import_generation_diagnostics_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from public;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated;
revoke execute on function public.commit_seasonal_import_v2(uuid, integer) from public;
revoke execute on function public.commit_seasonal_import_v2(uuid, integer) from anon;
grant execute on function public.commit_seasonal_import_v2(uuid, integer) to authenticated;

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
