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
