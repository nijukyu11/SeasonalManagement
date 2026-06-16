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

create or replace function public.is_app_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_operators where user_id = auth.uid())
$$;

create or replace function public.app_operator_can_use_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_operators
    where user_id = auth.uid()
      and (can_use_ai is true or can_manage_ai is true)
  )
$$;

create or replace function public.app_operator_can_manage_ai()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_operators
    where user_id = auth.uid()
      and can_manage_ai is true
  )
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
  ai_updated_at bigint
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

create or replace view reporting.flight_operations as
select
  r.season_id,
  coalesce(r.iata_season_code, s.season_code, '') as season,
  r.record_id,
  r.flight_series_id,
  r.turnaround_id,
  r.type,
  r.flight_number as flight,
  r.airline,
  r.route,
  coalesce(rc.country, '') as country,
  r.aircraft,
  r.pax,
  r.date as scheduled_date,
  r.schedule as scheduled_time,
  coalesce(r.operational_date, r.date) as ops_date,
  to_char(to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'), 'YYYY-MM') as month,
  extract(week from to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'))::integer as iso_week,
  nullif(split_part(r.schedule, ':', 1), '')::integer as local_hour,
  ((nullif(split_part(r.schedule, ':', 1), '')::integer + 17) % 24) as utc_hour,
  extract(dow from to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'))::integer as weekday,
  r.status,
  r.gate,
  r.stand,
  r.carousel,
  r.source_kind,
  r.source_side,
  s.season_code,
  r.iata_season_code
from public.season_flight_records r
left join public.seasons s on s.id = r.season_id
left join public.operational_route_countries rc on rc.route = r.route
where r.status <> 'deleted';

create or replace view reporting.summary_airline as
select season_id, season, airline, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, airline, type;

create or replace view reporting.summary_country as
select season_id, season, country, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, country, type;

create or replace view reporting.summary_route as
select season_id, season, route, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, route, type;

create or replace view reporting.summary_month as
select season_id, season, month, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, month, type;

create or replace view reporting.summary_week as
select season_id, season, iso_week, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, iso_week, type;

create or replace view reporting.summary_peak_hour as
select season_id, season, local_hour, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, local_hour, type;

create or replace view reporting.summary_aircraft as
select season_id, season, aircraft, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, aircraft, type;

create or replace view reporting.summary_arr_dep_mix as
select season_id, season, type, count(*) as flights, coalesce(sum(pax), 0) as pax
from reporting.flight_operations
group by season_id, season, type;

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

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
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
