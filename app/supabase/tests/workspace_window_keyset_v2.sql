begin;

do $$
declare
  test_suffix text := replace(gen_random_uuid()::text, '-', '');
  test_season_id text := '__workspace_v2_test__' || test_suffix;
  record_a text := 'A-' || test_suffix;
  record_b text := 'B-' || test_suffix;
  record_c text := 'C-' || test_suffix;
  added_d text := 'D-' || test_suffix;
  payload jsonb;
  cursor_value jsonb;
  root_ids text[] := '{}';
  page_root_ids text[];
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version
  ) values (
    test_season_id, 'T26', 'Workspace V2 test', '', 0, '2026-01-01', '2026-12-31', 4, 0, 7
  );

  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, date, operational_date, day_of_week,
    source_row_index, source_kind, source_side, status
  ) values
    (test_season_id, record_a, '', 'A', 'VN', 'VN1', 'VN1', 'HAN', '0100', 'A321', 'PAX', '2026-01-01', '2026-01-01', 4, 1, 'imported', 'ARR', 'active'),
    (test_season_id, record_b, '', 'D', 'VN', 'VN2', 'VN2', 'SGN', '0200', 'A321', 'PAX', '2026-01-02', '2026-01-02', 5, 2, 'imported', 'DEP', 'active'),
    (test_season_id, record_c, '', 'A', 'VN', 'VN3', 'VN3', 'DAD', '0300', 'A321', 'PAX', '2026-01-03', '2026-01-03', 6, 3, 'imported', 'ARR', 'active');

  insert into public.season_flight_record_counters (record_id, counter_group, item_index, counter_value)
  values (record_a, '__single__', 0, 'A01');

  insert into public.season_modifications (season_id, leg_id, action, changed_fields)
  values (test_season_id, added_d, 'added', '{}');

  insert into public.season_modification_added_legs (
    season_id, leg_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, date, operational_date, day_of_week,
    source_row_index, source_kind, source_side, status
  ) values (
    test_season_id, added_d, added_d, '', 'D', 'VJ', 'VJ4', 'VJ4', 'CXR', '0400', 'A320', 'PAX',
    '2026-01-04', '2026-01-04', 7, 4, 'added', 'DEP', 'active'
  );

  payload := public.get_season_schedule_allocation_window_v2(
    test_season_id, null, null, 'all', 2, null, null, null, null, null
  );

  if payload->>'status' <> 'ok'
     or (payload #>> '{snapshot,dataVersion}')::integer <> 7
     or (payload #>> '{snapshot,serverHighWater}')::bigint <> 0
     or (payload #>> '{page,returnedCount}')::integer <> 2
     or (payload #>> '{page,hasMore}')::boolean is not true
     or payload #> '{page,nextCursor}' is null then
    raise exception 'unexpected first V2 page: %', payload;
  end if;

  select coalesce(array_agg(root_id order by root_id), '{}')
  into page_root_ids
  from (
    select row->>'record_id' as root_id from jsonb_array_elements(payload->'flightRecords') row
    union all
    select row->>'leg_id' from jsonb_array_elements(payload->'modificationAddedLegs') row
  ) roots;
  root_ids := root_ids || page_root_ids;

  if exists (
    select 1
    from jsonb_array_elements(payload->'flightRecordCounters') child
    where not ((child->>'record_id') = any(page_root_ids))
  ) then
    raise exception 'first V2 page contains an orphan flight counter';
  end if;

  cursor_value := payload #> '{page,nextCursor}';
  payload := public.get_season_schedule_allocation_window_v2(
    test_season_id,
    null,
    null,
    'all',
    2,
    cursor_value->>'effectiveDate',
    cursor_value->>'rootId',
    (cursor_value->>'rootKind')::smallint,
    7,
    0
  );

  if payload->>'status' <> 'ok'
     or (payload #>> '{page,returnedCount}')::integer <> 2
     or (payload #>> '{page,hasMore}')::boolean is not false
     or payload #> '{page,nextCursor}' <> 'null'::jsonb then
    raise exception 'unexpected terminal V2 page: %', payload;
  end if;

  select coalesce(array_agg(root_id order by root_id), '{}')
  into page_root_ids
  from (
    select row->>'record_id' as root_id from jsonb_array_elements(payload->'flightRecords') row
    union all
    select row->>'leg_id' from jsonb_array_elements(payload->'modificationAddedLegs') row
  ) roots;
  root_ids := root_ids || page_root_ids;

  if cardinality(root_ids) <> 4
     or (select count(distinct root_id) from unnest(root_ids) root_id) <> 4 then
    raise exception 'V2 keyset pages returned missing or duplicate roots: %', root_ids;
  end if;

  payload := public.get_season_schedule_allocation_window_v2(
    test_season_id, '2026-01-03', '2026-01-03', 'schedule', 500,
    null, null, null, null, null
  );
  if (payload #>> '{page,returnedCount}')::integer <> 1
     or payload #>> '{flightRecords,0,record_id}' <> record_c then
    raise exception 'V2 date window returned unexpected roots: %', payload;
  end if;

  payload := public.get_season_schedule_allocation_window_v2(
    test_season_id, null, null, 'all', 500, null, null, null, 999, 0
  );
  if payload <> jsonb_build_object(
    'status', 'snapshot_changed',
    'snapshot', jsonb_build_object('dataVersion', 7, 'serverHighWater', 0)
  ) then
    raise exception 'snapshot_changed response must not include row arrays: %', payload;
  end if;

  begin
    perform public.get_season_schedule_allocation_window_v2(
      test_season_id, null, null, 'all', 500, '2026-01-01', null, null, null, null
    );
    raise exception 'partial V2 cursor should have failed';
  exception
    when sqlstate '22023' then null;
  end;

  if has_function_privilege(
    'anon',
    'public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)',
    'execute'
  ) then
    raise exception 'anon must not execute workspace window V2';
  end if;
end;
$$;

rollback;
