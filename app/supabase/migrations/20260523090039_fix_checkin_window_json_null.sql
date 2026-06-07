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
