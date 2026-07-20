do $migration$
declare
  function_oid regprocedure := 'public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)'::regprocedure;
  function_definition text;
  old_flight_rows text := $old$
  flight_record_rows as materialized (
    select r.*
    from public.season_flight_records r
    join selected_base_ids ids on ids.root_id = r.record_id
  ),
$old$;
  new_flight_rows text := $new$
  flight_record_rows as materialized (
    -- season_scoped_children_v2: preserve composite-index access and cross-season isolation.
    select r.*
    from public.season_flight_records r
    join selected_base_ids ids on ids.root_id = r.record_id
    where r.season_id = p_season_id
  ),
$new$;
  invalid_flight_counters text := 'from public.season_flight_record_counters c where c.season_id = p_season_id and c.record_id in';
  valid_flight_counters text := 'from public.season_flight_record_counters c where c.record_id in';
  invalid_flight_windows text := 'from public.season_flight_record_checkin_windows w where w.season_id = p_season_id and w.record_id in';
  valid_flight_windows text := 'from public.season_flight_record_checkin_windows w where w.record_id in';
  invalid_modification_counters text := 'from public.season_modification_counters c where c.season_id = p_season_id and c.leg_id in';
  valid_modification_counters text := 'from public.season_modification_counters c where c.leg_id in';
  invalid_modification_windows text := 'from public.season_modification_checkin_windows w where w.season_id = p_season_id and w.leg_id in';
  valid_modification_windows text := 'from public.season_modification_checkin_windows w where w.leg_id in';
begin
  select pg_get_functiondef(function_oid)
  into function_definition;

  -- Repair the briefly deployed predicate variant on schemas where child tables do not carry season_id.
  function_definition := replace(function_definition, invalid_flight_counters, valid_flight_counters);
  function_definition := replace(function_definition, invalid_flight_windows, valid_flight_windows);
  function_definition := replace(function_definition, invalid_modification_counters, valid_modification_counters);
  function_definition := replace(function_definition, invalid_modification_windows, valid_modification_windows);

  if position('season_scoped_children_v2' in function_definition) > 0 then
    execute function_definition;
    return;
  end if;

  if position(old_flight_rows in function_definition) = 0 then
    raise exception 'Workspace window V2 definition did not match the reviewed flight-row hydration predicate';
  end if;

  function_definition := replace(function_definition, old_flight_rows, new_flight_rows);

  if position('season_scoped_children_v2' in function_definition) = 0 then
    raise exception 'Workspace window V2 season-scoped flight-row replacement was incomplete';
  end if;

  execute function_definition;
end
$migration$;

notify pgrst, 'reload schema';
