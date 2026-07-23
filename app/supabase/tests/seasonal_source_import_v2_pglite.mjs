import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const migrationUrl = new URL(
  '../migrations/20260718090000_seasonal_source_import_v2.sql',
  import.meta.url
);
const testUrl = new URL('./seasonal_source_import_v2.sql', import.meta.url);
const compatibilityTestUrl = new URL('./seasonal_source_import_v2_compatibility.sql', import.meta.url);
const qualityTestUrl = new URL('./seasonal_source_import_v2_quality.sql', import.meta.url);
export const bootstrapFixtureSql = `
create role service_role;
create table public.app_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  display_name text
);
create table public.app_operator_permission_overrides (
  user_id uuid not null references public.app_operators(user_id) on delete cascade,
  permission_key text not null,
  effect text not null check (effect in ('allow', 'deny')),
  primary key (user_id, permission_key)
);
create table public.seasons (
  id text primary key,
  season_code text not null,
  name text not null,
  file_name text not null default '',
  uploaded_at bigint not null default 0,
  effective_start text not null default '',
  effective_end text not null default '',
  total_legs integer not null default 0,
  total_source_rows integer not null default 0,
  data_version integer not null default 0,
  last_synced_at bigint
);
create unique index seasons_season_code_unique_idx on public.seasons (season_code);
create table public.season_source_rows (
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
create table public.season_source_row_days (
  season_id text not null,
  row_index integer not null,
  iso_dow integer not null check (iso_dow between 1 and 7),
  primary key (season_id, row_index, iso_dow),
  foreign key (season_id, row_index)
    references public.season_source_rows(season_id, row_index) on delete cascade
);
create table public.season_flight_records (
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
create table public.season_flight_record_counters (
  record_id text not null references public.season_flight_records(record_id) on delete cascade,
  counter_group text not null default '__single__',
  item_index integer not null default 0,
  counter_value text not null,
  primary key (record_id, counter_group, item_index)
);
create table public.season_flight_record_checkin_windows (
  record_id text not null references public.season_flight_records(record_id) on delete cascade,
  counter_key text not null,
  window_start text not null,
  window_end text not null,
  primary key (record_id, counter_key)
);
create table public.season_modifications (
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
  check_in_allocation_mode text
    check (check_in_allocation_mode is null or check_in_allocation_mode in ('grouped', 'broken'))
);
create table public.season_modification_counters (
  leg_id text not null references public.season_modifications(leg_id) on delete cascade,
  counter_group text not null default '__single__',
  item_index integer not null default 0,
  counter_value text not null,
  primary key (leg_id, counter_group, item_index)
);
create table public.season_modification_checkin_windows (
  leg_id text not null references public.season_modifications(leg_id) on delete cascade,
  counter_key text not null,
  window_start text not null,
  window_end text not null,
  primary key (leg_id, counter_key)
);
create table public.season_modification_added_legs (
  season_id text not null references public.seasons(id) on delete restrict,
  leg_id text primary key references public.season_modifications(leg_id) on delete cascade,
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
  action text,
  source_row_index integer not null default 0,
  linked_source_row_index integer,
  link_type text,
  pair_anchor_date text,
  linked_record_id text,
  source_kind text not null default 'added',
  source_side text not null default 'ARR',
  status text not null default 'active',
  turnaround_id text
);
create table public.season_mod_history_entries (
  season_id text not null references public.seasons(id) on delete restrict,
  entry_id text primary key,
  timestamp bigint not null,
  description text not null default ''
);
create table public.season_mod_history_changes (
  entry_id text not null references public.season_mod_history_entries(entry_id) on delete cascade,
  change_index integer not null,
  leg_id text not null,
  previous_mod_snapshot jsonb,
  new_mod_snapshot jsonb,
  primary key (entry_id, change_index)
);
create table public.season_mod_history_record_changes (
  entry_id text not null references public.season_mod_history_entries(entry_id) on delete cascade,
  change_index integer not null,
  record_id text not null,
  previous_record_snapshot jsonb,
  new_record_snapshot jsonb,
  primary key (entry_id, change_index)
);
create table public.season_change_events (
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
create table public.season_entity_versions (
  season_id text not null references public.seasons(id) on delete cascade,
  target_type text not null,
  target_id text not null,
  entity_version bigint not null default 0,
  field_versions jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (season_id, target_type, target_id)
);
create or replace function public.app_operator_has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.app_operator_permission_overrides overrides
    where overrides.user_id = auth.uid()
      and overrides.permission_key = p_permission_key
      and overrides.effect = 'allow'
  )
$$;
grant usage on schema public to authenticated;
grant execute on function public.app_operator_has_permission(text) to authenticated;
`;

export async function runSeasonalSourceImportV2PGliteSuite() {
  const db = await createSupabasePGlite();
  const startedAt = Date.now();

  try {
    await db.exec(bootstrapFixtureSql);
    const migrationSql = await readFile(migrationUrl, 'utf8');
    await db.exec(migrationSql);
    await db.exec(migrationSql);
    await db.exec(await readFile(testUrl, 'utf8'));
    await db.exec(await readFile(compatibilityTestUrl, 'utf8'));
    await db.exec(await readFile(qualityTestUrl, 'utf8'));
    console.log(JSON.stringify({
      suite: 'seasonal_source_import_v2.sql',
      engine: 'PGlite',
      migrationRuns: 2,
      elapsedMs: Date.now() - startedAt,
      status: 'passed',
    }));
  } finally {
    await db.close();
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedUrl === import.meta.url) {
  await runSeasonalSourceImportV2PGliteSuite();
}
