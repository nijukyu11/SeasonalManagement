-- Canonical live flight-leg store shared by Seasonal, Daily, Manual and reporting.
-- This migration is additive and intentionally retains Daily staging/audit tables.

alter table public.season_flight_records
  add column if not exists source_file_hash text,
  add column if not exists superseded_by_batch_id uuid,
  add column if not exists supersedes_record_id text,
  add column if not exists deletion_reason text,
  add column if not exists lifecycle_changed_at timestamptz,
  add column if not exists lifecycle_changed_by uuid;

alter table public.season_flight_records
  drop constraint if exists season_flight_records_source_kind_check;

update public.season_flight_records
set source_kind = case source_kind
  when 'imported' then 'seasonal'
  when 'added' then 'manual'
  else source_kind
end
where source_kind in ('imported', 'added');

alter table public.season_flight_records
  add constraint season_flight_records_source_kind_check
  check (source_kind in ('seasonal', 'daily', 'manual', 'imported', 'added')) not valid;
alter table public.season_flight_records
  validate constraint season_flight_records_source_kind_check;

update public.season_flight_records
set action = 'deleted',
    status = 'deleted',
    deletion_reason = coalesce(deletion_reason, 'legacy_reconciliation'),
    lifecycle_changed_at = coalesce(lifecycle_changed_at, now())
where action = 'deleted' or status = 'deleted';

alter table public.season_flight_records
  drop constraint if exists season_flight_records_deleted_lifecycle_check;
alter table public.season_flight_records
  add constraint season_flight_records_deleted_lifecycle_check
  check ((status = 'deleted') = coalesce(action = 'deleted', false)) not valid;
alter table public.season_flight_records
  validate constraint season_flight_records_deleted_lifecycle_check;

-- Keep the legacy added-leg child immutable as an audit/rollback source. Its
-- historical source_kind='added' value is mapped to canonical source_kind='manual'
-- only when the row is copied into season_flight_records below.

create or replace function public.is_canonical_flight_leg_active_v1(
  p_status text,
  p_action text
) returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select p_status = 'active' and p_action is distinct from 'deleted'
$$;

create or replace function public.canonical_flight_leg_ops_date_v1(
  p_operational_date text,
  p_scheduled_date text,
  p_date text,
  p_scheduled_time text,
  p_schedule text
) returns date
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
declare
  v_date text := coalesce(nullif(p_operational_date, ''), nullif(p_scheduled_date, ''), nullif(p_date, ''));
  v_time text := coalesce(nullif(p_scheduled_time, ''), nullif(p_schedule, ''));
  v_minutes integer;
begin
  if nullif(p_operational_date, '') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    return p_operational_date::date;
  end if;
  if v_date !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  if v_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]' then
    v_minutes := split_part(v_time, ':', 1)::integer * 60
      + substring(v_time from '^[0-9]{1,2}:([0-9]{2})')::integer;
  elsif v_time ~ '^([01][0-9]|2[0-3])[0-5][0-9]$' then
    v_minutes := substring(v_time from 1 for 2)::integer * 60
      + substring(v_time from 3 for 2)::integer;
  else
    return v_date::date;
  end if;
  return v_date::date - case when v_minutes < 300 then 1 else 0 end;
end;
$$;

create or replace function public.canonical_flight_leg_occurrence_key_v1(
  p_season_id text,
  p_operational_date text,
  p_scheduled_date text,
  p_date text,
  p_scheduled_time text,
  p_schedule text,
  p_type text,
  p_airline text,
  p_flight_number text,
  p_raw_flight_number text,
  p_route text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select concat_ws('|',
    p_season_id,
    public.canonical_flight_leg_ops_date_v1(
      p_operational_date, p_scheduled_date, p_date, p_scheduled_time, p_schedule
    )::text,
    case when upper(btrim(p_type)) = 'D' then 'DEP' else 'ARR' end,
    upper(btrim(p_airline)),
    upper(btrim(coalesce(nullif(p_flight_number, ''), p_raw_flight_number))),
    upper(btrim(coalesce(p_route, ''))),
    case
      when coalesce(nullif(p_scheduled_time, ''), p_schedule) ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
        then to_char(coalesce(nullif(p_scheduled_time, ''), p_schedule)::time, 'HH24:MI')
      when coalesce(nullif(p_scheduled_time, ''), p_schedule) ~ '^([01][0-9]|2[0-3])[0-5][0-9]$'
        then substring(coalesce(nullif(p_scheduled_time, ''), p_schedule) from 1 for 2)
          || ':' || substring(coalesce(nullif(p_scheduled_time, ''), p_schedule) from 3 for 2)
      else upper(btrim(coalesce(nullif(p_scheduled_time, ''), p_schedule, '')))
    end
  )
$$;

create table if not exists public.schedule_replacement_scopes (
  season_id text not null references public.seasons(id) on delete restrict,
  ops_date date not null,
  authority_source text not null check (authority_source in ('daily')),
  source_batch_id uuid not null references public.daily_schedule_import_batches(batch_id) on delete restrict,
  expected_leg_count integer not null check (expected_leg_count >= 0),
  canonical_checksum text not null,
  data_version integer not null check (data_version >= 0),
  committed_at timestamptz not null default now(),
  committed_by uuid not null references auth.users(id) on delete restrict,
  reset_at timestamptz,
  reset_by uuid references auth.users(id) on delete restrict,
  reset_reason text,
  primary key (season_id, ops_date),
  check ((reset_at is null) = (reset_by is null))
);

create index if not exists schedule_replacement_scopes_batch_idx
  on public.schedule_replacement_scopes (source_batch_id, season_id, ops_date);

create table if not exists public.season_manual_leg_migrations (
  season_id text not null references public.seasons(id) on delete restrict,
  legacy_leg_id text not null,
  legacy_record_id text not null,
  canonical_record_id text not null references public.season_flight_records(record_id) on delete restrict,
  migrated_at timestamptz not null default now(),
  primary key (season_id, legacy_leg_id),
  unique (canonical_record_id)
);

do $manual_collision$
declare
  v_collision text;
begin
  select added.record_id into v_collision
  from public.season_modification_added_legs added
  join public.season_flight_records records on records.record_id = added.record_id
  where records.season_id is distinct from added.season_id
     or records.source_kind <> 'manual'
  order by added.record_id
  limit 1;
  if v_collision is not null then
    raise exception 'Legacy manual leg % collides with a canonical record', v_collision
      using errcode = '23505';
  end if;
end;
$manual_collision$;

-- The V2 guards compare the legacy added-leg child with the base table. During
-- canonicalization that is intentionally the same logical leg, so retire the
-- cross-table occurrence guards before copying. The canonical partial unique
-- index created below becomes the single active-occurrence guard.
drop trigger if exists guard_seasonal_effective_base_occurrence_v2
  on public.season_flight_records;
drop trigger if exists guard_seasonal_manual_added_occurrence_v2
  on public.season_modification_added_legs;
drop trigger if exists guard_seasonal_added_modification_v2
  on public.season_modifications;
drop trigger if exists enforce_seasonal_added_modification_parent_v2
  on public.season_modifications;
drop trigger if exists enforce_seasonal_added_modification_child_v2
  on public.season_modification_added_legs;

insert into public.season_flight_records (
  season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
  request_status_code, route, schedule, aircraft, category, code_shares, int_dom_ind,
  pax, gate, stand, carousel, mct, fb, lb, bhs, ghs, date, scheduled_date,
  scheduled_time, operational_date, iata_season_code, flight_series_id, day_of_week,
  action, source_row_index, linked_source_row_index, link_type, pair_anchor_date,
  linked_record_id, source_kind, source_side, status, turnaround_id
)
select
  added.season_id, added.record_id, added.link_id, added.type, added.airline,
  added.flight_number, added.raw_flight_number, added.request_status_code, added.route,
  added.schedule, added.aircraft, added.category, added.code_shares, added.int_dom_ind,
  added.pax, added.gate, added.stand, added.carousel, added.mct, added.fb, added.lb,
  added.bhs, added.ghs, added.date, added.scheduled_date, added.scheduled_time,
  added.operational_date, added.iata_season_code, added.flight_series_id,
  added.day_of_week, 'added', added.source_row_index, added.linked_source_row_index,
  added.link_type, added.pair_anchor_date, added.linked_record_id, 'manual',
  added.source_side, added.status, added.turnaround_id
from public.season_modification_added_legs added
where added.status = 'active'
  and added.action is distinct from 'deleted'
on conflict (record_id) do nothing;

insert into public.season_manual_leg_migrations (
  season_id, legacy_leg_id, legacy_record_id, canonical_record_id
)
select added.season_id, added.leg_id, added.record_id, added.record_id
from public.season_modification_added_legs added
join public.season_flight_records records
  on records.season_id = added.season_id and records.record_id = added.record_id
on conflict (season_id, legacy_leg_id) do update
set legacy_record_id = excluded.legacy_record_id,
    canonical_record_id = excluded.canonical_record_id;

-- The canonical copy plus the immutable migration map is now the rollback and
-- provenance boundary. Leaving the old child live would make legacy workspace
-- RPCs return the same manual leg twice, once as base and once as an added child.
delete from public.season_modification_added_legs;

revoke insert, update, delete on public.season_modification_added_legs
  from authenticated;
drop policy if exists "permissioned operational overlay writes"
  on public.season_modification_added_legs;

drop index if exists public.season_flight_records_active_imported_occurrence_v2_key;

-- A deleted overlay is the current terminal state of its atomic flight. Carry
-- that state onto the canonical base before enforcing occurrence uniqueness.
-- The overlay is retained for audit and explicit Undo; the canonical remove
-- RPC below only reactivates rows carrying this exact lifecycle reason.
update public.season_flight_records records
set status = 'deleted',
    action = 'deleted',
    deletion_reason = 'overlay_deleted',
    lifecycle_changed_at = coalesce(records.lifecycle_changed_at, now())
from public.season_modifications modifications
where modifications.season_id = records.season_id
  and modifications.leg_id = records.record_id
  and modifications.action = 'deleted'
  and records.status = 'active'
  and records.action is distinct from 'deleted';

do $canonical_duplicates$
declare
  v_key text;
begin
  select public.canonical_flight_leg_occurrence_key_v1(
    records.season_id, records.operational_date, records.scheduled_date, records.date,
    records.scheduled_time, records.schedule, records.type, records.airline,
    records.flight_number, records.raw_flight_number, records.route
  ) into v_key
  from public.season_flight_records records
  where public.is_canonical_flight_leg_active_v1(records.status, records.action)
  group by public.canonical_flight_leg_occurrence_key_v1(
    records.season_id, records.operational_date, records.scheduled_date, records.date,
    records.scheduled_time, records.schedule, records.type, records.airline,
    records.flight_number, records.raw_flight_number, records.route
  )
  having count(*) > 1
  order by 1
  limit 1;
  if v_key is not null then
    raise exception 'Canonical active occurrence collision: %', v_key
      using errcode = '23505';
  end if;
end;
$canonical_duplicates$;

create unique index if not exists season_flight_records_active_canonical_occurrence_v1_key
on public.season_flight_records (
  public.canonical_flight_leg_occurrence_key_v1(
    season_id, operational_date, scheduled_date, date, scheduled_time, schedule,
    type, airline, flight_number, raw_flight_number, route
  )
)
where status = 'active' and action is distinct from 'deleted';

create or replace view public.canonical_active_flight_records_v1
with (security_invoker = true)
as
select records.*
from public.season_flight_records records
where public.is_canonical_flight_leg_active_v1(records.status, records.action);

alter table public.schedule_replacement_scopes enable row level security;
alter table public.season_manual_leg_migrations enable row level security;
revoke all on public.schedule_replacement_scopes, public.season_manual_leg_migrations
  from public, anon, authenticated;
grant select on public.schedule_replacement_scopes, public.season_manual_leg_migrations
  to authenticated;
revoke all on public.canonical_active_flight_records_v1 from public, anon;
grant select on public.canonical_active_flight_records_v1 to authenticated;

drop policy if exists "replacement scopes read" on public.schedule_replacement_scopes;
create policy "replacement scopes read" on public.schedule_replacement_scopes
for select to authenticated using (
  public.app_operator_has_permission('seasonal.read')
  or public.app_operator_has_permission('daily.read')
);

drop policy if exists "manual leg migrations read" on public.season_manual_leg_migrations;
create policy "manual leg migrations read" on public.season_manual_leg_migrations
for select to authenticated using (public.app_operator_has_permission('seasonal.read'));

revoke execute on function public.is_canonical_flight_leg_active_v1(text,text)
  from public, anon, authenticated;
revoke execute on function public.canonical_flight_leg_ops_date_v1(text,text,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.canonical_flight_leg_occurrence_key_v1(text,text,text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
