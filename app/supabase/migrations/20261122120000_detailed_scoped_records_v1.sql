begin;

create or replace function public.get_detailed_scoped_records_v1(
  p_season_id text,
  p_record_ids text[],
  p_planning boolean,
  p_expected_revision text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_epoch text;
  v_revision text;
  v_token text;
  v_records jsonb := '[]'::jsonb;
  v_modifications jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required' using errcode = '42501';
  end if;
  if p_season_id is null or btrim(p_season_id) = '' or p_record_ids is null
    or cardinality(p_record_ids) > 100
    or exists (select 1 from unnest(p_record_ids) id where id is null or btrim(id) = '')
  then
    raise exception 'seasonId and at most 100 non-empty recordIds are required' using errcode = '22023';
  end if;

  if p_planning then
    if not public.app_operator_has_permission('seasonal.read') then
      raise exception 'Planning read permission is required' using errcode = '42501';
    end if;
    select workspace.epoch::text, workspace.revision::text
      into v_epoch, v_revision
    from public.seasonal_draft_workspace workspace
    where workspace.season_id = p_season_id;
    if not found then
      raise exception 'Planning season % does not exist' , p_season_id using errcode = 'P0002';
    end if;
    v_token := v_epoch || ':' || v_revision;
    if p_expected_revision is not null and p_expected_revision <> v_token then
      raise exception 'DETAILED_SCOPE_REVISION_CHANGED' using errcode = '40001';
    end if;
    select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.draft_id), '[]'::jsonb)
      into v_records
    from (
      select d.draft_id, d.link_id, d.turnaround_id, d.type, d.airline, d.flight_number,
        d.raw_flight_number, d.request_status_code, d.route, d.schedule, d.aircraft, d.category,
        d.code_shares, d.int_dom_ind, d.pax, d.gate, d.stand, d.carousel, d.mct, d.fb, d.lb,
        d.bhs, d.ghs, d.date, d.scheduled_date, d.scheduled_time, d.operational_date,
        d.iata_season_code, d.flight_series_id, d.day_of_week, d.action, d.source_row_index,
        d.linked_source_row_index, d.link_type, d.pair_anchor_date, d.linked_draft_id,
        d.source_kind, d.source_side, d.status, d.counters, d.checkin_windows,
        d.check_in_start, d.check_in_end, d.check_in_allocation_mode
      from public.seasonal_flight_drafts d
      where d.season_id = p_season_id and d.draft_id = any(p_record_ids)
    ) row_data;
  else
    if not (
      public.app_operator_has_permission('seasonal.read')
      or public.app_operator_has_permission('detailed.read')
    ) then
      raise exception 'Detailed schedule read permission is required' using errcode = '42501';
    end if;
    select s.id,
      s.data_version::text || ':' || coalesce((
        select max(events.server_seq)::text
        from public.season_change_events events where events.season_id = s.id
      ), '0')
      into v_epoch, v_revision
    from public.seasons s where s.id = p_season_id;
    if not found then
      raise exception 'Season % does not exist', p_season_id using errcode = 'P0002';
    end if;
    v_token := v_epoch || ':' || v_revision;
    if p_expected_revision is not null and p_expected_revision <> v_token then
      raise exception 'DETAILED_SCOPE_REVISION_CHANGED' using errcode = '40001';
    end if;

    with ids as (
      select distinct unnest(p_record_ids) as record_id
    ), selected as (
      select r.* from public.season_flight_records r
      join ids on ids.record_id = r.record_id
      where r.season_id = p_season_id
    ), rows as (
      select jsonb_build_object(
        'record', to_jsonb(r),
        'counters', coalesce((select jsonb_agg(to_jsonb(c) order by c.counter_group, c.item_index)
          from public.season_flight_record_counters c
          where c.record_id = r.record_id), '[]'::jsonb),
        'windows', coalesce((select jsonb_agg(to_jsonb(w) order by w.counter_key)
          from public.season_flight_record_checkin_windows w
          where w.record_id = r.record_id), '[]'::jsonb)
      ) as item, r.record_id
      from selected r
    )
    select coalesce(jsonb_agg(item order by record_id), '[]'::jsonb) into v_records from rows;

    with ids as (
      select distinct unnest(p_record_ids) as record_id
    ), selected_mods as (
      select m.* from public.season_modifications m
      join ids on ids.record_id = m.leg_id
      where m.season_id = p_season_id
    ), rows as (
      select jsonb_build_object(
        'row', to_jsonb(m),
        'counters', coalesce((select jsonb_agg(to_jsonb(c) order by c.counter_group, c.item_index)
          from public.season_modification_counters c
          where c.leg_id = m.leg_id), '[]'::jsonb),
        'windows', coalesce((select jsonb_agg(to_jsonb(w) order by w.counter_key)
          from public.season_modification_checkin_windows w
          where w.leg_id = m.leg_id), '[]'::jsonb),
        'addedLeg', (select to_jsonb(a) from public.season_modification_added_legs a
          where a.leg_id = m.leg_id)
      ) as item, m.leg_id
      from selected_mods m
    )
    select coalesce(jsonb_agg(item order by leg_id), '[]'::jsonb) into v_modifications from rows;
  end if;

  return jsonb_build_object(
    'records', v_records,
    'modifications', v_modifications,
    'epoch', v_epoch,
    'revision', v_revision
  );
end;
$$;

revoke all on function public.get_detailed_scoped_records_v1(text, text[], boolean, text) from public, anon;
grant execute on function public.get_detailed_scoped_records_v1(text, text[], boolean, text) to authenticated;

comment on function public.get_detailed_scoped_records_v1(text, text[], boolean, text) is
  'Returns only requested Planning draft rows or legacy canonical records/overlays; pins bounded chunk reads to an epoch/revision.';

commit;
