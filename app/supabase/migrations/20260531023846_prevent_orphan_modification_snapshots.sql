create schema if not exists maintenance;

create table if not exists maintenance.orphan_season_modifications_backup (
  backup_id bigserial primary key,
  backed_up_at timestamptz not null default now(),
  backup_reason text not null,
  season_id text not null,
  leg_id text not null,
  action text not null,
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
);

create unique index if not exists orphan_season_modifications_backup_once_idx
  on maintenance.orphan_season_modifications_backup (season_id, leg_id);

insert into maintenance.orphan_season_modifications_backup (
  backup_reason,
  season_id,
  leg_id,
  action,
  changed_fields,
  schedule,
  aircraft,
  route,
  code_shares,
  pax,
  gate,
  stand,
  carousel,
  mct,
  fb,
  lb,
  bhs,
  ghs,
  check_in_start,
  check_in_end,
  check_in_allocation_mode
)
select
  'missing matching flight record or added-leg row',
  m.season_id,
  m.leg_id,
  m.action,
  m.changed_fields,
  m.schedule,
  m.aircraft,
  m.route,
  m.code_shares,
  m.pax,
  m.gate,
  m.stand,
  m.carousel,
  m.mct,
  m.fb,
  m.lb,
  m.bhs,
  m.ghs,
  m.check_in_start,
  m.check_in_end,
  m.check_in_allocation_mode
from public.season_modifications m
where not exists (
    select 1
    from public.season_flight_records r
    where r.season_id = m.season_id
      and r.record_id = m.leg_id
  )
  and not (
    m.action = 'added'
    and exists (
      select 1
      from public.season_modification_added_legs al
      where al.season_id = m.season_id
        and al.leg_id = m.leg_id
    )
  )
  and not exists (
    select 1
    from maintenance.orphan_season_modifications_backup b
    where b.season_id = m.season_id
      and b.leg_id = m.leg_id
  );

with orphan_modifications as (
  select m.season_id, m.leg_id
  from public.season_modifications m
  where not exists (
      select 1
      from public.season_flight_records r
      where r.season_id = m.season_id
        and r.record_id = m.leg_id
    )
    and not (
      m.action = 'added'
      and exists (
        select 1
        from public.season_modification_added_legs al
        where al.season_id = m.season_id
          and al.leg_id = m.leg_id
      )
    )
)
delete from public.season_entity_versions ev
using orphan_modifications o
where ev.season_id = o.season_id
  and ev.target_type = 'modification'
  and ev.target_id = o.leg_id;

with orphan_modifications as (
  select m.season_id, m.leg_id
  from public.season_modifications m
  where not exists (
      select 1
      from public.season_flight_records r
      where r.season_id = m.season_id
        and r.record_id = m.leg_id
    )
    and not (
      m.action = 'added'
      and exists (
        select 1
        from public.season_modification_added_legs al
        where al.season_id = m.season_id
          and al.leg_id = m.leg_id
      )
    )
)
delete from public.season_modifications m
using orphan_modifications o
where m.season_id = o.season_id
  and m.leg_id = o.leg_id;

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

revoke execute on function public.get_season_workspace_snapshot(text, integer) from public;
revoke execute on function public.get_season_workspace_snapshot(text, integer) from anon;
grant execute on function public.get_season_workspace_snapshot(text, integer) to authenticated;
