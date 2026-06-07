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
    left join season_row s on true
    where r.season_id = p_season_id
       or (s.season_code is not null and r.iata_season_code = s.season_code)
    order by r.record_id, (r.season_id = p_season_id) desc
  ),
  flight_record_ids as (
    select record_id from flight_record_rows
  ),
  modification_rows as (
    select distinct on (m.leg_id) m.*
    from public.season_modifications m
    left join season_row s on true
    where m.season_id = p_season_id
       or m.leg_id in (select record_id from flight_record_ids)
       or exists (
         select 1
         from public.season_modification_added_legs al
         where al.leg_id = m.leg_id
           and (
             al.season_id = p_season_id
             or (s.season_code is not null and al.iata_season_code = s.season_code)
           )
       )
    order by m.leg_id, (m.season_id = p_season_id) desc
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
