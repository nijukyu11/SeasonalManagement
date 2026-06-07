with unique_season_codes as (
  select season_code, min(id) as season_id
  from public.seasons
  where season_code is not null and btrim(season_code) <> ''
  group by season_code
  having count(*) = 1
)
update public.season_flight_records r
set season_id = u.season_id
from unique_season_codes u
where r.season_id is null
  and r.iata_season_code = u.season_code;

with unique_season_codes as (
  select season_code, min(id) as season_id
  from public.seasons
  where season_code is not null and btrim(season_code) <> ''
  group by season_code
  having count(*) = 1
)
update public.season_modification_added_legs al
set season_id = u.season_id
from unique_season_codes u
where al.season_id is null
  and al.iata_season_code = u.season_code;

update public.season_modifications m
set season_id = r.season_id
from public.season_flight_records r
where m.season_id is null
  and m.leg_id = r.record_id
  and r.season_id is not null;

update public.season_modifications m
set season_id = al.season_id
from public.season_modification_added_legs al
where m.season_id is null
  and m.leg_id = al.leg_id
  and al.season_id is not null;

update public.season_mod_history_entries h
set season_id = e.season_id
from public.season_change_events e
where h.season_id is null
  and e.target_type = 'modHistory'
  and e.target_id = h.entry_id
  and e.season_id is not null;

update public.season_change_events e
set season_id = e.op_payload->>'seasonId'
where e.season_id is null
  and e.op_payload ? 'seasonId'
  and exists (
    select 1
    from public.seasons s
    where s.id = e.op_payload->>'seasonId'
  );

update public.season_mod_history_entries h
set season_id = e.season_id
from public.season_change_events e
where h.season_id is null
  and e.target_type = 'modHistory'
  and e.target_id = h.entry_id
  and e.season_id is not null;

do $$
begin
  if exists (select 1 from public.season_flight_records where season_id is null) then
    raise exception 'Cannot enforce exact season filtering: season_flight_records contains rows with null season_id.';
  end if;
  if exists (select 1 from public.season_modifications where season_id is null) then
    raise exception 'Cannot enforce exact season filtering: season_modifications contains rows with null season_id.';
  end if;
  if exists (select 1 from public.season_modification_added_legs where season_id is null) then
    raise exception 'Cannot enforce exact season filtering: season_modification_added_legs contains rows with null season_id.';
  end if;
  if exists (select 1 from public.season_mod_history_entries where season_id is null) then
    raise exception 'Cannot enforce exact season filtering: season_mod_history_entries contains rows with null season_id.';
  end if;
  if exists (select 1 from public.season_change_events where season_id is null) then
    raise exception 'Cannot enforce exact season filtering: season_change_events contains rows with null season_id.';
  end if;
end $$;

alter table public.season_flight_records drop constraint if exists season_flight_records_season_id_fkey;
alter table public.season_flight_records alter column season_id set not null;
alter table public.season_flight_records
  add constraint season_flight_records_season_id_fkey
  foreign key (season_id) references public.seasons(id) on delete restrict;

alter table public.season_modifications drop constraint if exists season_modifications_season_id_fkey;
alter table public.season_modifications alter column season_id set not null;
alter table public.season_modifications
  add constraint season_modifications_season_id_fkey
  foreign key (season_id) references public.seasons(id) on delete restrict;

alter table public.season_modification_added_legs drop constraint if exists season_modification_added_legs_season_id_fkey;
alter table public.season_modification_added_legs alter column season_id set not null;
alter table public.season_modification_added_legs
  add constraint season_modification_added_legs_season_id_fkey
  foreign key (season_id) references public.seasons(id) on delete restrict;

alter table public.season_mod_history_entries drop constraint if exists season_mod_history_entries_season_id_fkey;
alter table public.season_mod_history_entries alter column season_id set not null;
alter table public.season_mod_history_entries
  add constraint season_mod_history_entries_season_id_fkey
  foreign key (season_id) references public.seasons(id) on delete restrict;

alter table public.season_change_events drop constraint if exists season_change_events_season_id_fkey;
alter table public.season_change_events alter column season_id set not null;
alter table public.season_change_events
  add constraint season_change_events_season_id_fkey
  foreign key (season_id) references public.seasons(id) on delete restrict;

create index if not exists season_flight_records_season_operational_idx
  on public.season_flight_records (season_id, operational_date, type, status, flight_number);
create index if not exists season_modifications_season_leg_idx
  on public.season_modifications (season_id, leg_id, action);
create index if not exists season_modification_added_legs_season_leg_idx
  on public.season_modification_added_legs (season_id, leg_id, operational_date, type, status);

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
       or m.leg_id in (select record_id from flight_record_ids)
       or exists (
         select 1
         from public.season_modification_added_legs al
         where al.leg_id = m.leg_id
           and al.season_id = p_season_id
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
    ) order by ev.target_type, ev.target_id) from public.season_entity_versions ev where ev.season_id = p_season_id), '[]'::jsonb)
  )
  into snapshot;

  return snapshot;
end;
$$;

grant execute on function public.get_season_workspace_snapshot(text, integer) to authenticated;
