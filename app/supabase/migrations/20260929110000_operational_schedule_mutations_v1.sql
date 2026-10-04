-- 20260929110000_operational_schedule_mutations_v1.sql
-- M9: Additive operational schedule mutations for Daily schedule grid.
-- Reuses canonical M1/M5 table constraints and normalization (upper/btrim, no artificial regex).
-- Preserves M4 lock hierarchy: workspace revision -> all affected days (source, destination, counterpart) ascending -> all leg IDs ascending.
-- Preserves M4 reciprocal pair validation, terminal status lineage (no deleted resurrection), preimage verification, durable receipts, RLS, and change events.
begin;

create or replace function public.apply_operational_flight_schedule_changes_v1(
  p_request_id uuid,
  p_expected_revision bigint,
  p_changes jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_request jsonb := jsonb_build_object('revision', p_expected_revision::text, 'changes', p_changes);
  v_receipt public.operational_mutation_receipts%rowtype;
  v_change jsonb;
  v_patch jsonb;
  v_expected jsonb;
  v_field text;
  v_leg public.operational_flight_legs%rowtype;
  v_new public.operational_flight_legs%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_revision bigint;
  v_result jsonb;
  v_ids uuid[];
  v_lock_ids uuid[] := array[]::uuid[];
  v_all_days date[] := array[]::date[];
  v_pair_ids uuid[] := array[]::uuid[];
  v_day date;
  v_target_leg_id uuid;
  v_dest_date date;
  v_new_key text;
  v_sched_date date;
  v_sched_time time;
  v_allowed text[] := array[
    'airline', 'flight_number', 'scheduled_date', 'scheduled_time', 'route', 'aircraft_type',
    'flight_category', 'int_dom_ind', 'code_shares', 'status', 'deletion_reason',
    'gate', 'stand', 'carousel', 'pax', 'counter_token', 'mct', 'fb', 'lb', 'bhs', 'ghs',
    'check_in_start', 'check_in_end', 'check_in_allocation_mode',
    'linked_leg_id', 'turnaround_id', 'link_type', 'pair_anchor_date',
    'counters', 'checkin_windows'
  ];
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  if p_request_id is null or p_expected_revision is null or jsonb_typeof(p_changes) is distinct from 'array'
     or jsonb_array_length(p_changes) not between 1 and 100 then
    raise exception 'Request ID, expected revision and 1-100 changes are required' using errcode = '22023';
  end if;

  -- 1. Lock workspace revision singleton first
  select revision into strict v_revision from public.operational_workspace_revision where singleton for update;

  -- 2. Idempotency check: replay exact receipt if same payload
  select * into v_receipt from public.operational_mutation_receipts where actor_id = v_actor and request_id = p_request_id;
  if found then
    if v_receipt.request_payload is distinct from v_request then
      raise exception 'Request ID reused with different payload' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;

  -- 3. Stale snapshot check
  if v_revision <> p_expected_revision then
    raise exception 'Operational snapshot changed' using errcode = '40001';
  end if;

  -- 4. Validate input leg IDs
  select array_agg((x->>'legId')::uuid) into v_ids from jsonb_array_elements(p_changes) x;
  if exists(select 1 from unnest(v_ids) x group by x having count(*) > 1) or array_position(v_ids, null) is not null then
    raise exception 'Leg IDs must be present and distinct' using errcode = '22023';
  end if;

  -- 5. Terminal check: All target legs must exist and be currently active
  -- Resurrecting deleted legs or updating deleted legs violates lineage protocol
  if (select count(*) from public.operational_flight_legs where leg_id = any(v_ids) and status = 'active') <> array_length(v_ids, 1) then
    raise exception 'All target operational legs must exist and be active' using errcode = 'P0002';
  end if;

  -- 6. Collect all days (source, destination, counterpart) and leg IDs to lock in ascending order
  v_lock_ids := v_ids;
  for v_leg in select * from public.operational_flight_legs where leg_id = any(v_ids) loop
    v_all_days := array_append(v_all_days, v_leg.operational_date);
    if v_leg.linked_leg_id is not null then
      v_lock_ids := array_append(v_lock_ids, v_leg.linked_leg_id);
      v_all_days := array_append(v_all_days, (select operational_date from public.operational_flight_legs where leg_id = v_leg.linked_leg_id));
    end if;
  end loop;

  -- Destination dates from changes
  for v_change in select x from jsonb_array_elements(p_changes) x loop
    v_patch := v_change->'patch';
    v_target_leg_id := (v_change->>'legId')::uuid;
    if v_patch ? 'scheduled_date' or v_patch ? 'scheduled_time' then
      select * into v_leg from public.operational_flight_legs where leg_id = v_target_leg_id;
      v_sched_date := coalesce((v_patch->>'scheduled_date')::date, v_leg.scheduled_date);
      v_sched_time := coalesce((v_patch->>'scheduled_time')::time, v_leg.scheduled_time);
      v_dest_date := public.seasonal_operational_date_v2(v_sched_date, v_sched_time);
      v_all_days := array_append(v_all_days, v_dest_date);
    end if;
  end loop;

  -- 7. Advisory lock all affected operational days in ascending order
  for v_day in select distinct d from unnest(v_all_days) d where d is not null order by d loop
    perform pg_advisory_xact_lock(hashtextextended('operational-day:' || v_day::text, 0));
  end loop;

  -- 8. Lock all target and counterpart legs in ascending order
  perform 1 from public.operational_flight_legs where leg_id = any(v_lock_ids) order by leg_id for update;

  -- 9. Process each change in deterministic order
  for v_change in select x from jsonb_array_elements(p_changes) x order by x->>'legId' loop
    v_patch := v_change->'patch';
    v_expected := v_change->'expected';
    if jsonb_typeof(v_patch) is distinct from 'object' or v_patch = '{}'::jsonb or jsonb_typeof(v_expected) is distinct from 'object' then
      raise exception 'A nonempty patch and field preimage are required' using errcode = '22023';
    end if;

    select * into v_leg from public.operational_flight_legs where leg_id = (v_change->>'legId')::uuid and status = 'active';
    if not found then
      raise exception 'Active operational leg not found' using errcode = 'P0002';
    end if;

    if v_patch ?| array['linked_leg_id', 'turnaround_id', 'link_type', 'pair_anchor_date', 'status'] then
      v_pair_ids := array_append(array_append(v_pair_ids, v_leg.leg_id), v_leg.linked_leg_id);
    end if;

    select to_jsonb(v_leg) || jsonb_build_object(
      'counters', coalesce((select jsonb_agg(to_jsonb(c) - 'leg_id' order by counter_group, item_index) from public.operational_leg_counters c where c.leg_id = v_leg.leg_id), '[]'::jsonb),
      'checkin_windows', coalesce((select jsonb_agg(to_jsonb(w) - 'leg_id' order by counter_key) from public.operational_leg_checkin_windows w where w.leg_id = v_leg.leg_id), '[]'::jsonb)
    ) into v_before;

    for v_field in select jsonb_object_keys(v_patch) loop
      if not (v_field = any(v_allowed)) then
        raise exception 'Unsupported operational field: %', v_field using errcode = '22023';
      end if;
      if not (v_expected ? v_field) or v_expected->v_field is distinct from v_before->v_field then
        raise exception 'Operational field preimage changed: %', v_field using errcode = '40001';
      end if;
    end loop;

    -- Lineage rule: Status can only transition active -> deleted/cancelled with non-empty deletion_reason
    if v_patch ? 'status' then
      if v_patch->>'status' = 'active' then
        raise exception 'Leg is already active' using errcode = '22023';
      elsif v_patch->>'status' in ('deleted', 'cancelled') then
        if coalesce(v_patch->>'deletion_reason', v_leg.deletion_reason, '') = '' then
          raise exception 'deletion_reason is required when deleting an operational leg' using errcode = '22023';
        end if;
      else
        raise exception 'Invalid status value: %', v_patch->>'status' using errcode = '22023';
      end if;
    end if;

    select * into v_new from jsonb_populate_record(v_leg, v_patch - 'counters' - 'checkin_windows');

    -- Canonical flight normalization matching M1/M5 table constraints
    v_new.airline := upper(btrim(coalesce(v_new.airline, '')));
    v_new.flight_number := upper(btrim(coalesce(v_new.flight_number, '')));
    v_new.route := upper(btrim(coalesce(v_new.route, '')));
    v_new.aircraft_type := coalesce(btrim(v_new.aircraft_type), 'Unknown');
    v_new.flight_category := coalesce(btrim(v_new.flight_category), 'C');

    if v_new.airline = '' then
      raise exception 'Airline code must not be empty' using errcode = '22023';
    end if;
    if v_new.flight_number = '' then
      raise exception 'Flight number must not be empty' using errcode = '22023';
    end if;
    if v_new.stand is not null and v_new.stand !~ '^[1-9][0-9]*[A-Z]?$' then
      raise exception 'Invalid stand' using errcode = '22023';
    end if;
    if v_new.gate is not null and v_new.gate <= 0 then
      raise exception 'Gate must be greater than zero' using errcode = '22023';
    end if;
    if v_new.carousel is not null and v_new.carousel <= 0 then
      raise exception 'Carousel must be greater than zero' using errcode = '22023';
    end if;

    -- Recompute operational_date if scheduled_date or scheduled_time changed
    if v_patch ? 'scheduled_date' or v_patch ? 'scheduled_time' then
      v_new.operational_date := public.seasonal_operational_date_v2(v_new.scheduled_date, v_new.scheduled_time);
    end if;

    -- Recompute canonical business key (leg_key)
    v_new_key := (case v_new.side when 'ARR' then 'A' else 'D' end)
      || chr(31) || v_new.operational_date::text
      || chr(31) || v_new.airline
      || chr(31) || v_new.flight_number;

    if v_new.status = 'active' and exists(
      select 1 from public.operational_flight_legs
      where leg_key = v_new_key and status = 'active' and leg_id <> v_new.leg_id
    ) then
      raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: leg_key already active' using errcode = '23505';
    end if;

    update public.operational_flight_legs set
      airline = v_new.airline,
      flight_number = v_new.flight_number,
      raw_flight_number = coalesce(v_new.raw_flight_number, v_new.airline || v_new.flight_number),
      scheduled_date = v_new.scheduled_date,
      scheduled_time = v_new.scheduled_time,
      operational_date = v_new.operational_date,
      leg_key = v_new_key,
      route = v_new.route,
      aircraft_type = v_new.aircraft_type,
      flight_category = v_new.flight_category,
      int_dom_ind = v_new.int_dom_ind,
      code_shares = v_new.code_shares,
      status = v_new.status,
      deletion_reason = v_new.deletion_reason,
      gate = v_new.gate,
      stand = v_new.stand,
      carousel = v_new.carousel,
      pax = v_new.pax,
      counter_token = v_new.counter_token,
      mct = v_new.mct,
      fb = v_new.fb,
      lb = v_new.lb,
      bhs = v_new.bhs,
      ghs = v_new.ghs,
      check_in_start = v_new.check_in_start,
      check_in_end = v_new.check_in_end,
      check_in_allocation_mode = v_new.check_in_allocation_mode,
      linked_leg_id = v_new.linked_leg_id,
      turnaround_id = v_new.turnaround_id,
      link_type = v_new.link_type,
      pair_anchor_date = v_new.pair_anchor_date,
      updated_at = now(),
      updated_by = v_actor
    where leg_id = v_leg.leg_id;

    if v_patch ? 'counters' then
      if jsonb_typeof(v_patch->'counters') is distinct from 'array' then
        raise exception 'Counters must be an array' using errcode = '22023';
      end if;
      delete from public.operational_leg_counters where leg_id = v_leg.leg_id;
      insert into public.operational_leg_counters
      select v_leg.leg_id, coalesce(x.counter_group, '__single__'), x.item_index, x.counter_value
      from jsonb_to_recordset(v_patch->'counters') as x(counter_group text, item_index integer, counter_value text);
    end if;

    if v_patch ? 'checkin_windows' then
      if jsonb_typeof(v_patch->'checkin_windows') is distinct from 'array' then
        raise exception 'Check-in windows must be an array' using errcode = '22023';
      end if;
      delete from public.operational_leg_checkin_windows where leg_id = v_leg.leg_id;
      insert into public.operational_leg_checkin_windows
      select v_leg.leg_id, x.counter_key, x.window_start, x.window_end
      from jsonb_to_recordset(v_patch->'checkin_windows') as x(counter_key text, window_start text, window_end text);
    end if;

    select to_jsonb(l) || jsonb_build_object(
      'counters', coalesce((select jsonb_agg(to_jsonb(c) - 'leg_id' order by counter_group, item_index) from public.operational_leg_counters c where c.leg_id = l.leg_id), '[]'::jsonb),
      'checkin_windows', coalesce((select jsonb_agg(to_jsonb(w) - 'leg_id' order by counter_key) from public.operational_leg_checkin_windows w where w.leg_id = l.leg_id), '[]'::jsonb)
    ) into v_after from public.operational_flight_legs l where l.leg_id = v_leg.leg_id;

    insert into public.operational_change_events(
      actor_id, request_id, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      v_actor, p_request_id, v_leg.leg_id::text, v_new.operational_date,
      array(select jsonb_object_keys(v_patch)), v_before, v_after
    );
  end loop;

  -- 10. Turnaround pairing reciprocal validation (exact M4 invariant)
  -- Turnaround changes must preserve a reciprocal active pair. No dangling or one-way pair is allowed.
  if exists (
    select 1 from public.operational_flight_legs l
    left join public.operational_flight_legs r on r.leg_id = l.linked_leg_id
    where l.leg_id = any(v_pair_ids) and (
      (l.linked_leg_id is null and (l.turnaround_id is not null or l.link_type is not null or l.pair_anchor_date is not null))
      or (l.linked_leg_id is not null and (r.status is distinct from 'active' or r.linked_leg_id is distinct from l.leg_id
        or r.side = l.side or l.turnaround_id is null or r.turnaround_id is distinct from l.turnaround_id
        or r.link_type is distinct from l.link_type or r.pair_anchor_date is distinct from l.pair_anchor_date))
    )
  ) then
    raise exception 'Turnaround changes must preserve a reciprocal active pair' using errcode = '22023';
  end if;

  select revision into v_revision from public.operational_workspace_revision where singleton;

  select jsonb_build_object(
    'status', 'committed',
    'requestId', p_request_id,
    'revision', v_revision::text,
    'events', jsonb_agg(jsonb_build_object('targetId', target_id, 'serverSeq', server_seq::text, 'after', after_state) order by server_seq)
  ) into v_result
  from public.operational_change_events
  where actor_id = v_actor and request_id = p_request_id;

  insert into public.operational_mutation_receipts values (v_actor, p_request_id, v_request, v_result, now());
  perform pg_notify('operational_projection_wake', p_request_id::text);
  return v_result;
end;
$$;

create or replace function public.create_operational_flight_legs_v1(
  p_request_id uuid,
  p_expected_revision bigint,
  p_legs jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_actor uuid := auth.uid();
  v_request jsonb := jsonb_build_object('revision', p_expected_revision::text, 'legs', p_legs);
  v_receipt public.operational_mutation_receipts%rowtype;
  v_revision bigint;
  v_leg jsonb;
  v_leg_id_raw text;
  v_leg_id uuid;
  v_scheduled_date date;
  v_scheduled_time time;
  v_operational_date date;
  v_side text;
  v_airline text;
  v_flight_number text;
  v_route text;
  v_aircraft text;
  v_category text;
  v_stand text;
  v_gate integer;
  v_carousel integer;
  v_leg_key text;
  v_linked_id uuid;
  v_turnaround_id text;
  v_link_type text;
  v_pair_anchor_date date;
  v_after jsonb;
  v_result jsonb;
  v_date date;
  v_created_ids uuid[] := array[]::uuid[];
  v_keys_in_batch text[] := array[]::text[];
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  if p_request_id is null or p_expected_revision is null or p_legs is null or jsonb_typeof(p_legs) is distinct from 'array' or jsonb_array_length(p_legs) = 0 then
    raise exception 'Request ID, expected revision and non-empty legs array are required' using errcode = '22023';
  end if;

  select revision into strict v_revision from public.operational_workspace_revision where singleton for update;

  select * into v_receipt from public.operational_mutation_receipts where actor_id = v_actor and request_id = p_request_id;
  if found then
    if v_receipt.request_payload is distinct from v_request then
      raise exception 'Request ID reused with different payload' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;

  if v_revision <> p_expected_revision then
    raise exception 'Operational snapshot changed' using errcode = '40001';
  end if;

  -- 1. Validate client UUIDs (id only) and collect created IDs
  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    if jsonb_typeof(v_leg) is distinct from 'object' then
      raise exception 'Each leg item must be a JSON object' using errcode = '22023';
    end if;

    v_leg_id_raw := v_leg->>'id';
    if v_leg_id_raw is null or v_leg_id_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Each leg requires a valid client UUID id' using errcode = '22023';
    end if;
    v_leg_id := v_leg_id_raw::uuid;

    if v_leg_id = any(v_created_ids) then
      raise exception 'Duplicate leg id in input legs' using errcode = '22023';
    end if;
    v_created_ids := array_append(v_created_ids, v_leg_id);
  end loop;

  -- Check if any of v_created_ids already exists in operational_flight_legs
  if exists (select 1 from public.operational_flight_legs where leg_id = any(v_created_ids)) then
    raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: leg id already exists' using errcode = '23505';
  end if;

  -- 2. Sort & acquire advisory day locks in ascending order (strictly derived from scheduled date & time)
  for v_date in
    select distinct public.seasonal_operational_date_v2((elem->>'scheduledDate')::date, (elem->>'scheduledTime')::time)
    from jsonb_array_elements(p_legs) as elem
    where (elem->>'scheduledDate') is not null and (elem->>'scheduledTime') is not null
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('operational-day:' || v_date::text, 0));
  end loop;

  -- 3. Validate leg fields, identity collisions, and turnaround constraints
  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    v_scheduled_date := (v_leg->>'scheduledDate')::date;
    v_scheduled_time := (v_leg->>'scheduledTime')::time;
    v_side := upper(btrim(coalesce(v_leg->>'side', '')));
    v_airline := upper(btrim(coalesce(v_leg->>'airline', '')));
    v_flight_number := upper(btrim(coalesce(v_leg->>'flightNumber', '')));
    v_stand := nullif(upper(btrim(v_leg->>'stand')), '');
    v_gate := (v_leg->>'gate')::integer;
    v_carousel := (v_leg->>'carousel')::integer;

    if v_scheduled_date is null or v_scheduled_time is null or v_side not in ('ARR', 'DEP') then
      raise exception 'scheduledDate, scheduledTime and side (ARR/DEP) are required' using errcode = '22023';
    end if;
    if v_airline = '' then
      raise exception 'Airline code must not be empty' using errcode = '22023';
    end if;
    if v_flight_number = '' then
      raise exception 'Flight number must not be empty' using errcode = '22023';
    end if;
    if v_stand is not null and v_stand !~ '^[1-9][0-9]*[A-Z]?$' then
      raise exception 'Invalid stand' using errcode = '22023';
    end if;
    if v_gate is not null and v_gate <= 0 then
      raise exception 'Gate must be greater than zero' using errcode = '22023';
    end if;
    if v_carousel is not null and v_carousel <= 0 then
      raise exception 'Carousel must be greater than zero' using errcode = '22023';
    end if;

    v_operational_date := public.seasonal_operational_date_v2(v_scheduled_date, v_scheduled_time);
    v_leg_key := (case v_side when 'ARR' then 'A' else 'D' end)
      || chr(31) || v_operational_date::text
      || chr(31) || v_airline
      || chr(31) || v_flight_number;

    if v_leg_key = any(v_keys_in_batch) then
      raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: duplicate flight leg in batch' using errcode = '23505';
    end if;
    v_keys_in_batch := array_append(v_keys_in_batch, v_leg_key);

    if exists(select 1 from public.operational_flight_legs where leg_key = v_leg_key and status = 'active') then
      raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: flight leg already active for date' using errcode = '23505';
    end if;

    -- Turnaround link restriction: must reference another ID in p_legs
    if v_leg ? 'linkedLegId' and v_leg->>'linkedLegId' is not null then
      v_linked_id := (v_leg->>'linkedLegId')::uuid;
      if not (v_linked_id = any(v_created_ids)) then
        raise exception 'Counterpart must be active, opposite side with turnaroundId' using errcode = '22023';
      end if;
      if v_leg->>'turnaroundId' is null then
        raise exception 'TurnaroundId is required when linkedLegId is provided' using errcode = '22023';
      end if;
    else
      if v_leg ? 'turnaroundId' and v_leg->>'turnaroundId' is not null then
        raise exception 'TurnaroundId requires linkedLegId' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- 4. Phase 1: Insert all legs without pairing fields (FK immediate safety)
  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    v_leg_id := (v_leg->>'id')::uuid;
    v_scheduled_date := (v_leg->>'scheduledDate')::date;
    v_scheduled_time := (v_leg->>'scheduledTime')::time;
    v_operational_date := public.seasonal_operational_date_v2(v_scheduled_date, v_scheduled_time);
    v_side := upper(btrim(coalesce(v_leg->>'side', '')));
    v_airline := upper(btrim(coalesce(v_leg->>'airline', '')));
    v_flight_number := upper(btrim(coalesce(v_leg->>'flightNumber', '')));
    v_route := upper(btrim(coalesce(v_leg->>'route', '')));
    v_aircraft := coalesce(btrim(v_leg->>'aircraftType'), 'Unknown');
    v_category := coalesce(btrim(v_leg->>'flightCategory'), 'C');
    v_stand := nullif(upper(btrim(v_leg->>'stand')), '');
    v_gate := (v_leg->>'gate')::integer;
    v_carousel := (v_leg->>'carousel')::integer;
    v_leg_key := (case v_side when 'ARR' then 'A' else 'D' end)
      || chr(31) || v_operational_date::text
      || chr(31) || v_airline
      || chr(31) || v_flight_number;

    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
      raw_flight_number, route, aircraft_type, flight_category, pax, gate, stand, carousel,
      counter_token, mct, fb, lb, bhs, ghs, check_in_start, check_in_end, check_in_allocation_mode,
      int_dom_ind, code_shares, turnaround_id, linked_leg_id, link_type, pair_anchor_date,
      source_type, status, created_at, created_by, updated_at, updated_by
    ) values (
      v_leg_id, v_leg_key, v_operational_date, v_scheduled_date, v_scheduled_time, v_side, v_airline, v_flight_number,
      coalesce(v_leg->>'rawFlightNumber', v_airline || v_flight_number), v_route, v_aircraft, v_category,
      (v_leg->>'pax')::integer, v_gate, v_stand, v_carousel,
      v_leg->>'counterToken', v_leg->>'mct', v_leg->>'fb', v_leg->>'lb', v_leg->>'bhs', v_leg->>'ghs',
      v_leg->>'checkInStart', v_leg->>'checkInEnd', v_leg->>'checkInAllocationMode',
      v_leg->>'intDomInd', v_leg->>'codeShares',
      null, null, null, null,
      'operational_manual', 'active', now(), v_actor, now(), v_actor
    );

    if v_leg ? 'counters' and jsonb_typeof(v_leg->'counters') = 'array' then
      insert into public.operational_leg_counters
      select v_leg_id, coalesce(x.counter_group, '__single__'), x.item_index, x.counter_value
      from jsonb_to_recordset(v_leg->'counters') as x(counter_group text, item_index integer, counter_value text);
    end if;

    if v_leg ? 'checkin_windows' and jsonb_typeof(v_leg->'checkin_windows') = 'array' then
      insert into public.operational_leg_checkin_windows
      select v_leg_id, x.counter_key, x.window_start, x.window_end
      from jsonb_to_recordset(v_leg->'checkin_windows') as x(counter_key text, window_start text, window_end text);
    end if;
  end loop;

  -- 5. Phase 2: Update pairing fields once all batch leg IDs exist
  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    if v_leg ? 'linkedLegId' and v_leg->>'linkedLegId' is not null then
      update public.operational_flight_legs set
        linked_leg_id = (v_leg->>'linkedLegId')::uuid,
        turnaround_id = v_leg->>'turnaroundId',
        link_type = v_leg->>'linkType',
        pair_anchor_date = (v_leg->>'pairAnchorDate')::date
      where leg_id = (v_leg->>'id')::uuid;
    end if;
  end loop;

  -- 6. Phase 3: Turnaround reciprocal pair invariant validation
  if exists (
    select 1 from public.operational_flight_legs l
    left join public.operational_flight_legs r on r.leg_id = l.linked_leg_id
    where l.leg_id = any(v_created_ids) and (
      (l.linked_leg_id is null and (l.turnaround_id is not null or l.link_type is not null or l.pair_anchor_date is not null))
      or (l.linked_leg_id is not null and (r.status is distinct from 'active' or r.linked_leg_id is distinct from l.leg_id
        or r.side = l.side or l.turnaround_id is null or r.turnaround_id is distinct from l.turnaround_id
        or r.link_type is distinct from l.link_type or r.pair_anchor_date is distinct from l.pair_anchor_date))
    )
  ) then
    raise exception 'Turnaround changes must preserve a reciprocal active pair' using errcode = '22023';
  end if;

  -- 7. Phase 4: Build v_after and emit change events after pairing is fully applied
  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    v_leg_id := (v_leg->>'id')::uuid;
    v_scheduled_date := (v_leg->>'scheduledDate')::date;
    v_scheduled_time := (v_leg->>'scheduledTime')::time;
    v_operational_date := public.seasonal_operational_date_v2(v_scheduled_date, v_scheduled_time);

    select to_jsonb(l) || jsonb_build_object(
      'counters', coalesce((select jsonb_agg(to_jsonb(c) - 'leg_id' order by counter_group, item_index) from public.operational_leg_counters c where c.leg_id = l.leg_id), '[]'::jsonb),
      'checkin_windows', coalesce((select jsonb_agg(to_jsonb(w) - 'leg_id' order by counter_key) from public.operational_leg_checkin_windows w where w.leg_id = l.leg_id), '[]'::jsonb)
    ) into v_after from public.operational_flight_legs l where l.leg_id = v_leg_id;

    insert into public.operational_change_events (
      actor_id, request_id, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      v_actor, p_request_id, v_leg_id::text, v_operational_date, array['created'], 'null'::jsonb, v_after
    );
  end loop;

  select revision into v_revision from public.operational_workspace_revision where singleton;

  select jsonb_build_object(
    'status', 'committed',
    'requestId', p_request_id,
    'createdLegIds', to_jsonb(v_created_ids),
    'revision', v_revision::text,
    'events', coalesce(jsonb_agg(jsonb_build_object('targetId', target_id, 'serverSeq', server_seq::text, 'after', after_state) order by server_seq), '[]'::jsonb)
  ) into v_result
  from public.operational_change_events
  where actor_id = v_actor and request_id = p_request_id;

  insert into public.operational_mutation_receipts values (v_actor, p_request_id, v_request, v_result, now());
  perform pg_notify('operational_projection_wake', p_request_id::text);
  return v_result;
end;
$$;

revoke all on function public.apply_operational_flight_schedule_changes_v1(uuid, bigint, jsonb) from public, anon;
grant execute on function public.apply_operational_flight_schedule_changes_v1(uuid, bigint, jsonb) to authenticated;

revoke all on function public.create_operational_flight_legs_v1(uuid, bigint, jsonb) from public, anon;
grant execute on function public.create_operational_flight_legs_v1(uuid, bigint, jsonb) to authenticated;

commit;
