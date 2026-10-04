-- Rollback for M10 controlled reader cutover.
-- Refuses rollback if cutover is currently active.
-- Restores previous get_public_traffic_report_v2, refresh_public_traffic_canonical_legs_v1,
-- refresh_operational_canonical_legs_v1, reporting.flight_operations, and removes cutover state.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- 1. Refuse rollback if cutover is active
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'reporting'
      and table_name = 'operational_reader_cutover_state'
  ) then
    if (select is_cutover from reporting.operational_reader_cutover_state where singleton) then
      raise exception 'Cannot rollback migration while operational reader cutover is active. Run reporting.reverse_operational_readers_v1 first.'
        using errcode = '55000';
    end if;
  end if;
end;
$$;

-- 2. Drop legacy writer fencing triggers and trigger function
drop trigger if exists guard_legacy_writer_cutover on public.season_flight_records;
drop trigger if exists guard_legacy_writer_cutover on public.season_modifications;
drop trigger if exists guard_legacy_writer_cutover on public.season_modification_added_legs;
drop trigger if exists guard_legacy_writer_cutover on public.schedule_replacement_scopes;
drop trigger if exists guard_legacy_writer_cutover on public.daily_schedule_import_batches;
drop function if exists reporting.guard_legacy_writer_during_cutover_v1();

-- 3. Restore reporting.flight_operations to legacy definition
do $$
declare
  v_cols int;
begin
  select count(*) into v_cols
  from pg_attribute
  where attrelid = 'reporting.flight_operations'::regclass
    and attnum > 0 and not attisdropped;

  if v_cols = 37 then
    execute $viewdef$
      create or replace view reporting.flight_operations as
      WITH normalized AS (
         SELECT r.season_id,
            r.record_id,
            r.link_id,
            r.type,
            r.airline,
            r.flight_number,
            r.raw_flight_number,
            r.request_status_code,
            r.route,
            r.schedule,
            r.aircraft,
            r.category,
            r.code_shares,
            r.int_dom_ind,
            r.pax,
            r.gate,
            r.stand,
            r.carousel,
            r.mct,
            r.fb,
            r.lb,
            r.bhs,
            r.ghs,
            r.date,
            r.scheduled_date,
            r.scheduled_time,
            r.operational_date,
            r.iata_season_code,
            r.flight_series_id,
            r.day_of_week,
            r.action,
            r.source_row_index,
            r.linked_source_row_index,
            r.link_type,
            r.pair_anchor_date,
            r.linked_record_id,
            r.source_kind,
            r.source_side,
            r.status,
            r.turnaround_id,
            NULLIF(COALESCE(r.operational_date, r.scheduled_date, r.date), ''::text) AS effective_ops_date,
            NULLIF(COALESCE(r.scheduled_date, r.date), ''::text) AS effective_scheduled_date,
            NULLIF(COALESCE(r.scheduled_time, r.schedule), ''::text) AS effective_scheduled_time,
            NULLIF(split_part(COALESCE(r.scheduled_time, r.schedule, ''::text), ':'::text, 1), ''::text)::integer AS parsed_hour,
            NULLIF(split_part(COALESCE(r.scheduled_time, r.schedule, ''::text), ':'::text, 2), ''::text)::integer AS parsed_minute
           FROM reporting.effective_flight_operations r
        )
 SELECT n.season_id,
    COALESCE(n.iata_season_code, s.season_code, ''::text) AS season,
    n.record_id,
    n.flight_series_id,
    n.turnaround_id,
    n.type,
    n.flight_number AS flight,
    n.airline,
    n.route,
    COALESCE(rc.country, ''::text) AS country,
    n.aircraft,
    COALESCE(ag.name, agt.group_id, ''::text) AS ac_group,
    n.pax,
        CASE
            WHEN n.pax IS NULL THEN 'missing'::text
            WHEN n.pax = 0 THEN 'zero'::text
            ELSE 'available'::text
        END AS pax_status,
    n.effective_scheduled_date AS scheduled_date,
    n.effective_scheduled_time AS scheduled_time,
    n.effective_ops_date AS ops_date,
    n.effective_ops_date AS operational_date,
    to_char(to_date(n.effective_ops_date, 'YYYY-MM-DD'::text)::timestamp with time zone, 'YYYY-MM'::text) AS month,
    EXTRACT(week FROM to_date(n.effective_ops_date, 'YYYY-MM-DD'::text))::integer AS iso_week,
    EXTRACT(week FROM to_date(n.effective_ops_date, 'YYYY-MM-DD'::text))::integer AS weeknum,
    to_char(to_date(n.effective_ops_date, 'YYYY-MM-DD'::text)::timestamp with time zone, 'IYYY-"W"IW'::text) AS isoweek,
    n.parsed_hour AS local_hour,
    (n.parsed_hour + 17) % 24 AS utc_hour,
    (lpad(n.parsed_hour::text, 2, '0'::text) || ':'::text) ||
        CASE
            WHEN COALESCE(n.parsed_minute, 0) < 30 THEN '00'::text
            ELSE '30'::text
        END AS local_bucket_30,
    lpad(n.parsed_hour::text, 2, '0'::text) || ':00'::text AS local_bucket_60,
    (lpad(((n.parsed_hour + 17) % 24)::text, 2, '0'::text) || ':'::text) ||
        CASE
            WHEN COALESCE(n.parsed_minute, 0) < 30 THEN '00'::text
            ELSE '30'::text
        END AS utc_bucket_30,
    lpad(((n.parsed_hour + 17) % 24)::text, 2, '0'::text) || ':00'::text AS utc_bucket_60,
    COALESCE(n.day_of_week, EXTRACT(dow FROM to_date(n.effective_ops_date, 'YYYY-MM-DD'::text))::integer) AS weekday,
    n.status,
    n.gate,
    n.stand,
    n.carousel,
    n.source_kind,
    n.source_side,
    s.season_code,
    n.iata_season_code
   FROM normalized n
     LEFT JOIN seasons s ON s.id = n.season_id
     LEFT JOIN operational_route_countries rc ON rc.route = n.route
     LEFT JOIN operational_aircraft_group_types agt ON agt.aircraft_type = n.aircraft
     LEFT JOIN operational_aircraft_groups ag ON ag.id = agt.group_id
  WHERE n.effective_ops_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text AND n.parsed_hour >= 0 AND n.parsed_hour <= 23;
    $viewdef$;
  else
    execute $viewdef$
      create or replace view reporting.flight_operations as
      select * from reporting.effective_flight_operations;
    $viewdef$;
  end if;

  execute 'alter view reporting.flight_operations set (security_invoker = true)';
end;
$$;

drop view if exists reporting.legacy_flight_operations_v1 cascade;
drop view if exists reporting.operational_flight_operations_v1 cascade;
-- 4. Drop cutover control functions
drop function if exists reporting.reverse_operational_readers_v1(text, text);
drop function if exists reporting.cutover_operational_readers_v1(text);
drop function if exists reporting.is_operational_reader_cutover_active_v1();
-- 5. Restore reporting.get_public_traffic_canonical_bounds_v1 from captured legacy function
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'legacy_get_public_traffic_canonical_bounds_v1') then
    select pg_get_functiondef('reporting.legacy_get_public_traffic_canonical_bounds_v1'::regproc) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION reporting.legacy_get_public_traffic_canonical_bounds_v1', 'FUNCTION reporting.get_public_traffic_canonical_bounds_v1');
    execute v_fn;
    drop function reporting.legacy_get_public_traffic_canonical_bounds_v1();
  end if;
end;
$$;
-- 6. Restore reporting.refresh_operational_canonical_legs_v1 to 20260928170000 (M4) preimage
create or replace function reporting.refresh_operational_canonical_legs_v1()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_min_date date;
  v_max_date date;
  v_watermark bigint;
  v_operational_revision bigint;
  v_observed bigint;
  v_leg_count integer;
  v_quarantine_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  select coalesce(max(events.server_seq), 0)::bigint into v_watermark
  from public.season_change_events events;
  select revision into v_operational_revision from public.operational_workspace_revision where singleton;

  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_operational_canonical_bounds_v1() bounds;

  if v_min_date is null or v_max_date is null then
    truncate table reporting.operational_canonical_flight_legs;
    truncate table reporting.operational_canonical_flight_legs_quarantine;

    insert into reporting.operational_canonical_flight_legs_state (
      singleton, refreshed_at, source_operational_revision, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
    ) values (true, now(), v_operational_revision, v_watermark, v_watermark, null, null, 0, 0)
    on conflict (singleton) do update
      set refreshed_at = excluded.refreshed_at,
          source_operational_revision = excluded.source_operational_revision,
          source_watermark = excluded.source_watermark,
          observed_watermark = excluded.observed_watermark,
          ops_min_date = excluded.ops_min_date,
          ops_max_date = excluded.ops_max_date,
          leg_count = excluded.leg_count,
          quarantine_count = excluded.quarantine_count;
    return;
  end if;

  create temp table tmp_new_operational_slice on commit drop as
  with raw_candidates as materialized (
    select
      candidates.*,
      coalesce(legs.source_type = 'daily_import', false) as is_daily,
      coalesce(bool_or(legs.source_type = 'daily_import') over (partition by candidates.business_leg_key), false) as has_daily
    from reporting.get_operational_candidate_slice_v1(v_min_date - 1, v_max_date + 1) candidates
    left join public.operational_flight_legs legs
      on legs.leg_id::text = candidates.record_id
  ), eligible_slice as materialized (
    select
      raw.season_id,
      raw.record_id,
      raw.type,
      raw.airline,
      raw.flight_number,
      raw.route,
      raw.aircraft,
      raw.pax,
      raw.scheduled_date,
      raw.scheduled_time,
      raw.effective_route,
      raw.effective_aircraft,
      raw.effective_pax,
      raw.effective_action,
      raw.scheduled_date_value,
      raw.local_minutes,
      raw.authoritative_server_seq,
      raw.ops_date,
      raw.scheduled_local_at,
      raw.business_leg_key
    from raw_candidates raw
    where not raw.has_daily or raw.is_daily
  ), candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from eligible_slice candidates
  ), ranked_slice as (
    select candidates.*,
      count(*) over (partition by candidates.business_leg_key) as candidate_count,
      count(*) filter (where candidates.authoritative_server_seq is null)
        over (partition by candidates.business_leg_key) as missing_recency_count,
      count(*) filter (where candidates.authoritative_server_seq = candidates.max_authoritative_server_seq)
        over (partition by candidates.business_leg_key) as max_recency_count,
      row_number() over (
        partition by candidates.business_leg_key
        order by candidates.authoritative_server_seq desc nulls last, candidates.season_id, candidates.record_id
      ) as candidate_rank
    from candidate_slice candidates
  )
  select * from ranked_slice;

  create temp table tmp_new_operational_legs on commit drop as
  select
    ranked.business_leg_key,
    ranked.ops_date,
    upper(btrim(ranked.type)) as type,
    upper(btrim(ranked.airline)) as airline,
    upper(btrim(ranked.flight_number)) as flight_number,
    coalesce(nullif(upper(btrim(ranked.effective_route)), ''), '') as route,
    coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
    case upper(btrim(coalesce(legs.flight_category, '')))
      when 'J' then 'J'
      else 'C'
    end as flight_category,
    ranked.effective_pax as pax,
    ranked.local_minutes,
    ranked.scheduled_local_at
  from tmp_new_operational_slice ranked
  left join public.operational_flight_legs legs
    on legs.leg_id::text = ranked.record_id
  where ranked.candidate_rank = 1
    and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1));

  create temp table tmp_new_operational_quarantine on commit drop as
  select distinct on (quarantine.business_leg_key)
    quarantine.business_leg_key,
    quarantine.ops_date,
    quarantine.candidate_count
  from (
    select 0 as source_rank, ledger.business_leg_key, ledger.ops_date, ledger.candidate_count
    from public.operational_leg_quarantine ledger
    where ledger.ops_date between v_min_date - 1 and v_max_date + 1

    union all

    select 1 as source_rank, candidates.business_leg_key, candidates.ops_date, candidates.candidate_count
    from tmp_new_operational_slice candidates
    where candidates.candidate_rank = 1
      and candidates.candidate_count > 1
      and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
  ) quarantine
  order by quarantine.business_leg_key, quarantine.source_rank;

  truncate table reporting.operational_canonical_flight_legs;
  insert into reporting.operational_canonical_flight_legs (
    business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
  )
  select * from tmp_new_operational_legs;

  truncate table reporting.operational_canonical_flight_legs_quarantine;
  insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
  select quarantine.ops_date, quarantine.candidate_count
  from tmp_new_operational_quarantine quarantine;

  select count(*)::integer into v_leg_count from reporting.operational_canonical_flight_legs;
  select count(*)::integer into v_quarantine_count from reporting.operational_canonical_flight_legs_quarantine;

  select coalesce(max(events.server_seq), 0)::bigint into v_observed
  from public.season_change_events events;

  insert into reporting.operational_canonical_flight_legs_state (
    singleton, refreshed_at, source_operational_revision, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
  ) values (true, now(), v_operational_revision, v_watermark, v_observed, v_min_date, v_max_date, v_leg_count, v_quarantine_count)
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at,
        source_operational_revision = excluded.source_operational_revision,
        source_watermark = excluded.source_watermark,
        observed_watermark = excluded.observed_watermark,
        ops_min_date = excluded.ops_min_date,
        ops_max_date = excluded.ops_max_date,
        leg_count = excluded.leg_count,
        quarantine_count = excluded.quarantine_count;
end;
$function$;

revoke execute on function reporting.refresh_operational_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.refresh_operational_canonical_legs_v1() to service_role;

-- 7. Restore reporting.refresh_public_traffic_canonical_legs_v1 from captured legacy function
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'legacy_refresh_public_traffic_canonical_legs_v1') then
    select pg_get_functiondef('reporting.legacy_refresh_public_traffic_canonical_legs_v1'::regproc) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION reporting.legacy_refresh_public_traffic_canonical_legs_v1', 'FUNCTION reporting.refresh_public_traffic_canonical_legs_v1');
    execute v_fn;
    drop function reporting.legacy_refresh_public_traffic_canonical_legs_v1();
  end if;
end;
$$;
-- 8. Restore public.get_public_traffic_report_v2 to 20260925121500 preimage
CREATE OR REPLACE FUNCTION public.get_public_traffic_report_v2(
  p_from_date date DEFAULT NULL::date,
  p_to_date date DEFAULT NULL::date,
  p_type text DEFAULT 'all'::text,
  p_airlines text[] DEFAULT ARRAY[]::text[],
  p_routes text[] DEFAULT ARRAY[]::text[],
  p_countries text[] DEFAULT ARRAY[]::text[],
  p_comparison text DEFAULT 'previous'::text,
  p_time_basis text DEFAULT 'local'::text,
  p_expected_watermark bigint DEFAULT NULL::bigint,
  p_contract_version text DEFAULT 'traffic-report-v2'::text,
  p_payload_scope text DEFAULT 'full'::text,
  p_data_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
declare
  v_data_as_of timestamptz := coalesce(p_data_as_of, statement_timestamp());
  v_source_watermark bigint;
  v_data_version integer;
  v_min_date date;
  v_max_date date;
  v_latest_completed date;
  v_from_date date;
  v_to_date date;
  v_comparison_from date;
  v_comparison_to date;
  v_scan_from date;
  v_scan_to date;
  v_day_count integer;
  v_type text := upper(btrim(coalesce(p_type, 'all')));
  v_airlines text[];
  v_routes text[];
  v_countries text[];
  v_normalized_filter jsonb;
  v_filter_hash text;
  v_result jsonb;
begin
  if p_contract_version <> 'traffic-report-v2' then
    raise exception 'unsupported contract_version' using errcode = '22023';
  end if;
  if p_payload_scope not in ('full', 'timeline', 'dimensions') then
    raise exception 'invalid payload_scope' using errcode = '22023';
  end if;
  if v_type not in ('ALL', 'A', 'D') then
    raise exception 'invalid type' using errcode = '22023';
  end if;
  if p_comparison not in ('previous', 'year_ago', 'none') then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  if p_time_basis not in ('local', 'utc') then
    raise exception 'invalid time basis' using errcode = '22023';
  end if;
  if (p_from_date is null) <> (p_to_date is null) then
    raise exception 'from_date and to_date must be provided together' using errcode = '22023';
  end if;
  if cardinality(p_airlines) > 24 or cardinality(p_routes) > 24 or cardinality(p_countries) > 24 then
    raise exception 'filter cardinality exceeds 24' using errcode = '54000';
  end if;

  select coalesce(array_agg(value order by value), array[]::text[])
    into v_airlines
  from (select distinct upper(btrim(value)) as value from unnest(p_airlines) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_routes
  from (select distinct upper(btrim(value)) as value from unnest(p_routes) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_countries
  from (select distinct btrim(value) as value from unnest(p_countries) value where btrim(value) <> '') normalized;

  select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
  from public.season_change_events events;
  select coalesce(max(seasons.data_version), 0)::integer into v_data_version
  from public.seasons seasons;
  if p_expected_watermark is not null and p_expected_watermark is distinct from v_source_watermark then
    raise exception 'DATA_VERSION_CHANGED expected=% actual=%', p_expected_watermark, v_source_watermark
      using errcode = '40001';
  end if;

  v_latest_completed := ((v_data_as_of at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1;
  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_public_traffic_canonical_bounds_v1() bounds;
  if v_min_date is null or v_max_date is null then
    raise exception 'traffic report has no canonical effective operations' using errcode = 'P0002';
  end if;

  if p_from_date is null then
    v_from_date := greatest(v_min_date, make_date(extract(year from v_latest_completed)::integer, 1, 1));
    v_to_date := least(v_max_date, v_latest_completed);
  else
    v_from_date := p_from_date;
    v_to_date := p_to_date;
  end if;
  if v_from_date > v_to_date then
    raise exception 'from_date must not exceed to_date' using errcode = '22023';
  end if;
  v_day_count := v_to_date - v_from_date + 1;
  if v_day_count > 3660 then
    raise exception 'date range exceeds 3660 days' using errcode = '54000';
  end if;

  if p_comparison = 'previous' then
    v_comparison_to := v_from_date - 1;
    v_comparison_from := v_comparison_to - (v_day_count - 1);
  elsif p_comparison = 'year_ago' then
    v_comparison_from := v_from_date - interval '1 year';
    v_comparison_to := v_to_date - interval '1 year';
  end if;
  v_scan_from := least(v_from_date, coalesce(v_comparison_from, v_from_date));
  v_scan_to := greatest(v_to_date, coalesce(v_comparison_to, v_to_date));

  v_normalized_filter := jsonb_build_object(
    'from', v_from_date,
    'to', v_to_date,
    'type', case v_type when 'ALL' then 'all' else v_type end,
    'airline', to_jsonb(v_airlines),
    'route', to_jsonb(v_routes),
    'country', to_jsonb(v_countries),
    'comp', p_comparison,
    'tz', p_time_basis
  );
  v_filter_hash := encode(extensions.digest(convert_to(v_normalized_filter::text, 'UTF8'), 'sha256'), 'hex');

  with aircraft_map as materialized (
    select distinct on (upper(types.aircraft_type))
      upper(types.aircraft_type) as aircraft_type,
      groups.name as aircraft_group
    from public.operational_aircraft_group_types types
    join public.operational_aircraft_groups groups on groups.id = types.group_id
    order by upper(types.aircraft_type), groups.name
  ), canonical_rows as materialized (
    select
      legs.business_leg_key,
      legs.ops_date,
      legs.type,
      legs.airline,
      legs.flight_number,
      legs.route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      legs.aircraft_type,
      coalesce(nullif(btrim(aircraft_map.aircraft_group), ''), 'Unknown') as aircraft_group,
      legs.flight_category,
      legs.pax,
      legs.local_minutes,
      case when legs.local_minutes is null then null::integer
        else (legs.local_minutes + 1020) % 1440 end as utc_minutes,
      legs.scheduled_local_at,
      case
        when legs.pax is not null
          and legs.ops_date <= v_latest_completed
          and exists (
            select 1
            from reporting.public_traffic_coverage accepted_coverage
            where accepted_coverage.status = 'complete'
              and legs.ops_date between accepted_coverage.from_date and accepted_coverage.to_date
          )
          then true
        else legs.scheduled_local_at + interval '1 day'
          <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')
      end as is_due
    from reporting.canonical_flight_legs legs
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(legs.route)
    left join aircraft_map on aircraft_map.aircraft_type = legs.aircraft_type
    where legs.ops_date between v_scan_from and v_scan_to
  ), live_rows as materialized (
    select rows.*
    from canonical_rows rows
    where (v_type = 'ALL' or rows.type = v_type)
      and (cardinality(v_airlines) = 0 or rows.airline = any(v_airlines))
      and (cardinality(v_routes) = 0 or rows.route = any(v_routes))
      and (cardinality(v_countries) = 0 or rows.country = any(v_countries))
  ), current_rows as materialized (
    select * from live_rows where ops_date between v_from_date and v_to_date
  ), comparison_rows as materialized (
    select * from live_rows
    where v_comparison_from is not null and ops_date between v_comparison_from and v_comparison_to
  ), current_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      case when count(*) filter (where type = 'A' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'A' and is_due and pax is not null)::bigint end as arrival_reported_pax,
      case when count(*) filter (where type = 'D' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'D' and is_due and pax is not null)::bigint end as departure_reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows
  ), comparison_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      case when count(*) filter (where type = 'A' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'A' and is_due and pax is not null)::bigint end as arrival_reported_pax,
      case when count(*) filter (where type = 'D' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'D' and is_due and pax is not null)::bigint end as departure_reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from comparison_rows
  ), timeline_grouped as (
    select ops_date,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows group by ops_date
  ), timeline as (
    select spine.ops_date::date as ops_date,
      grouped.flights, grouped.arrivals, grouped.departures, grouped.reported_pax,
      grouped.reported_legs, grouped.due_legs, grouped.missing_due_legs,
      grouped.true_zero_reported_legs,
      coalesce((select ledger.status from reporting.public_traffic_coverage ledger
        where spine.ops_date::date between ledger.from_date and ledger.to_date and ledger.status <> 'excluded'
        order by ledger.certified_at desc nulls last, ledger.id desc limit 1),
        case when grouped.flights > 0 then 'partial' else 'missing' end) as coverage_status
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
    where p_payload_scope in ('full', 'timeline')
  ), current_coverage as (
    select bool_or(coverage_status in ('missing', 'partial')) as incomplete from timeline
  ), dimension_grouped as (
    select dimensions.dimension, dimensions.label,
      count(*)::integer as flights,
      count(*) filter (where rows.type = 'A')::integer as arrivals,
      count(*) filter (where rows.type = 'D')::integer as departures,
      case when count(*) filter (where rows.is_due and rows.pax is not null) > 0
        then sum(rows.pax) filter (where rows.is_due and rows.pax is not null)::bigint end as reported_pax,
      count(*) filter (where rows.is_due and rows.pax is not null)::integer as reported_legs,
      count(*) filter (where rows.is_due)::integer as due_legs,
      count(*) filter (where rows.is_due and rows.pax is null)::integer as missing_due_legs,
      count(*) filter (where rows.is_due and rows.pax = 0)::integer as true_zero_reported_legs
    from current_rows rows
    cross join lateral (values
      ('airline'::text, rows.airline),
      ('route'::text, rows.route),
      ('country'::text, rows.country),
      ('aircraft_group'::text, rows.aircraft_group),
      ('flight_category'::text, rows.flight_category)
    ) dimensions(dimension, label)
    where p_payload_scope in ('full', 'dimensions')
    group by dimensions.dimension, dimensions.label
  ), dimension_totals as (
    select dimension, sum(flights)::numeric as flights,
      sum(reported_pax) filter (where reported_pax is not null)::numeric as reported_pax
    from dimension_grouped group by dimension
  ), dimension_rows as (
    select grouped.*,
      grouped.flights::numeric / nullif(totals.flights, 0) as flight_share,
      grouped.reported_pax::numeric / nullif(totals.reported_pax, 0) as pax_share,
      row_number() over (partition by grouped.dimension order by grouped.flights desc, grouped.label) as row_rank
    from dimension_grouped grouped join dimension_totals totals using (dimension)
  ), filter_options as (
    select
      (coalesce(array_agg(distinct airline order by airline)
        filter (where airline <> ''), array[]::text[]))[1:250] as airlines,
      (coalesce(array_agg(distinct route order by route)
        filter (where route <> ''), array[]::text[]))[1:250] as routes,
      (coalesce(array_agg(distinct country order by country)
        filter (where country <> ''), array[]::text[]))[1:250] as countries
    from canonical_rows
    where p_payload_scope = 'full'
      and ops_date between v_from_date and v_to_date
  ), peak_day as (
    select ops_date, flights
    from timeline_grouped
    where p_payload_scope = 'full'
    order by flights desc, ops_date
    limit 1
  ), quality_metric as (
    select
      count(*) filter (where country = 'Unknown')::integer as unknown_country_legs,
      count(*) filter (where is_due and pax is null)::integer as pax_due_missing_legs
    from current_rows
    where p_payload_scope = 'full'
  ), quarantine_metric as (
    select coalesce(sum(candidate_count), 0)::integer as quarantined_candidates
    from reporting.canonical_flight_legs_quarantine
    where p_payload_scope = 'full'
      and ops_date between v_from_date and v_to_date
  ), daily_operations as (
    select spine.ops_date::date as ops_date,
      extract(isodow from spine.ops_date)::integer as day_index,
      coalesce(grouped.flights, 0)::integer as flights,
      coalesce(grouped.arrivals, 0)::integer as arrivals,
      coalesce(grouped.departures, 0)::integer as departures
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
    where p_payload_scope = 'full'
  ), day_of_week_grouped as (
    select day_index,
      count(*)::integer as calendar_days,
      sum(flights)::integer as total_flights,
      round(avg(flights), 2) as average_flights,
      min(flights)::integer as min_flights,
      max(flights)::integer as max_flights,
      sum(arrivals)::integer as arrivals,
      sum(departures)::integer as departures
    from daily_operations
    group by day_index
  ), day_of_week_rows as (
    select day_index,
      coalesce(grouped.calendar_days, 0)::integer as calendar_days,
      coalesce(grouped.total_flights, 0)::integer as total_flights,
      coalesce(grouped.average_flights, 0)::numeric as average_flights,
      coalesce(grouped.min_flights, 0)::integer as min_flights,
      coalesce(grouped.max_flights, 0)::integer as max_flights,
      coalesce(grouped.arrivals, 0)::integer as arrivals,
      coalesce(grouped.departures, 0)::integer as departures
    from generate_series(1, 7) day_index
    left join day_of_week_grouped grouped using (day_index)
  ), hour_counts as (
    select case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as bucket_index,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures
    from current_rows
    where p_payload_scope = 'full'
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
    group by case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end
  ), flight_occurrences as (
    select
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as bucket_index,
      case when p_time_basis = 'utc' then utc_minutes else local_minutes end as scheduled_minutes,
      type, airline, flight_number, route, ops_date,
      extract(isodow from ops_date)::integer as day_index
    from current_rows
    where p_payload_scope = 'full'
      and flight_number <> ''
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
  ), flight_weekday_stats as (
    select bucket_index, type, airline, flight_number, route, day_index,
      count(distinct ops_date)::integer as occurrence_days,
      (((max(ops_date) - min(ops_date)) / 7) + 1)::integer as eligible_days
    from flight_occurrences
    group by bucket_index, type, airline, flight_number, route, day_index
  ), qualifying_flight_weekdays as (
    select * from flight_weekday_stats
    where occurrence_days >= 4 and eligible_days >= 4
      and occurrence_days::numeric / nullif(eligible_days, 0) >= 0.70
  ), regular_flight_groups as (
    select bucket_index, type, airline, flight_number, route,
      array_agg(day_index order by day_index)::integer[] as operating_days,
      sum(occurrence_days)::integer as occurrence_days,
      sum(eligible_days)::integer as eligible_days,
      round(sum(occurrence_days) * 100.0 / nullif(sum(eligible_days), 0), 0)::integer as consistency_percent
    from qualifying_flight_weekdays
    group by bucket_index, type, airline, flight_number, route
  ), flight_time_counts as (
    select bucket_index, type, airline, flight_number, route, scheduled_minutes,
      count(distinct ops_date)::integer as occurrence_days
    from flight_occurrences
    group by bucket_index, type, airline, flight_number, route, scheduled_minutes
  ), typical_times as (
    select distinct on (bucket_index, type, airline, flight_number, route)
      bucket_index, type, airline, flight_number, route, scheduled_minutes
    from flight_time_counts
    order by bucket_index, type, airline, flight_number, route, occurrence_days desc, scheduled_minutes
  ), regular_flight_json as (
    select groups.bucket_index, groups.type,
      jsonb_agg(jsonb_build_object(
        'airline', groups.airline,
        'flight_number', groups.flight_number,
        'route', groups.route,
        'typical_time', lpad((times.scheduled_minutes / 60)::text, 2, '0') || ':'
          || lpad((times.scheduled_minutes % 60)::text, 2, '0'),
        'operating_days', to_jsonb(groups.operating_days),
        'occurrence_days', groups.occurrence_days,
        'eligible_days', groups.eligible_days,
        'consistency_percent', groups.consistency_percent
      ) order by times.scheduled_minutes, groups.airline, groups.flight_number, groups.route) as rows
    from regular_flight_groups groups
    join typical_times times using (bucket_index, type, airline, flight_number, route)
    group by groups.bucket_index, groups.type
  ), hour_rows as (
    select series.bucket_index,
      coalesce(counts.arrivals, 0)::integer as arrivals,
      coalesce(counts.departures, 0)::integer as departures,
      coalesce(arrivals.rows, '[]'::jsonb) as arrival_regular_flights,
      coalesce(departures.rows, '[]'::jsonb) as departure_regular_flights
    from generate_series(0, 23) series(bucket_index)
    left join hour_counts counts using (bucket_index)
    left join regular_flight_json arrivals
      on arrivals.bucket_index = series.bucket_index and arrivals.type = 'A'
    left join regular_flight_json departures
      on departures.bucket_index = series.bucket_index and departures.type = 'D'
  ), monthly_hour_counts as (
    select date_trunc('month', ops_date)::date as month_start, type,
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as hour_index,
      count(*)::integer as flights
    from current_rows
    where p_payload_scope = 'full'
      and type in ('A', 'D')
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
    group by date_trunc('month', ops_date)::date, type,
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end
  ), monthly_hour_ranked as (
    select counts.*,
      row_number() over (partition by month_start, type order by flights desc, hour_index) as row_rank
    from monthly_hour_counts counts
  ), report_months as (
    select generate_series(date_trunc('month', v_from_date::timestamp),
      date_trunc('month', v_to_date::timestamp), interval '1 month')::date as month_start
  ), aircraft_type_grouped as (
    select aircraft_group, aircraft_type,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax
    from current_rows
    where p_payload_scope = 'full'
    group by aircraft_group, aircraft_type
  ), aircraft_type_totals as (
    select sum(flights)::numeric as flights,
      sum(reported_pax) filter (where reported_pax is not null)::numeric as reported_pax
    from aircraft_type_grouped
  ), coverage_summary as (
    select count(*)::integer as selected_day_count,
      count(*) filter (where coverage_status not in ('missing', 'partial'))::integer as covered_day_count,
      count(*) filter (where coverage_status = 'partial')::integer as partial_day_count,
      count(*) filter (where coverage_status = 'missing')::integer as missing_day_count
    from timeline
    where p_payload_scope = 'full'
  ), coverage_counts as (
    select
      count(distinct route) filter (where route is not null and route <> '')::integer as routes,
      count(distinct airline) filter (where airline is not null and airline <> '')::integer as airlines,
      count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as countries
    from current_rows
    where p_payload_scope = 'full'
  )
  select jsonb_build_object(
    'contract_version', 'traffic-report-v2',
    'data_as_of', v_data_as_of,
    'source_watermark', v_source_watermark,
    'data_version', v_data_version,
    'filter_hash', v_filter_hash,
    'source_mode', 'live',
    'normalized_filter', v_normalized_filter,
    'current', (select jsonb_build_object(
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'arrival_reported_pax', metric.arrival_reported_pax,
      'departure_reported_pax', metric.departure_reported_pax,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero'
        when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 or coverage.incomplete then 'partial'
        else 'complete' end
    ) from current_metric metric cross join current_coverage coverage),
    'comparison', (select jsonb_build_object(
      'from', v_comparison_from, 'to', v_comparison_to,
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'arrival_reported_pax', metric.arrival_reported_pax,
      'departure_reported_pax', metric.departure_reported_pax,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero' when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 then 'partial' else 'complete' end
    ) from comparison_metric metric),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'ops_date', ops_date,
      'flights', case when coverage_status = 'missing' and flights is null then null else coalesce(flights, 0) end,
      'arrivals', case when coverage_status = 'missing' and flights is null then null else coalesce(arrivals, 0) end,
      'departures', case when coverage_status = 'missing' and flights is null then null else coalesce(departures, 0) end,
      'reported_pax', reported_pax,
      'reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(reported_legs, 0) end,
      'due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(due_legs, 0) end,
      'missing_due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(missing_due_legs, 0) end,
      'true_zero_reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(true_zero_reported_legs, 0) end,
      'completeness', coverage_status,
      'status', case when ops_date > v_latest_completed then 'future'
        when coverage_status = 'missing' then 'missing'
        when coverage_status = 'partial' or missing_due_legs > 0 then 'partial'
        when coalesce(flights, 0) = 0 then 'zero' else 'complete' end
    ) order by ops_date) from timeline), '[]'::jsonb),
    'dimensions', jsonb_build_object(
      'airline', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'airline' and row_rank <= 732), '[]'::jsonb),
      'route', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'route' and row_rank <= 732), '[]'::jsonb),
      'country', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'country' and row_rank <= 732), '[]'::jsonb)
    ),
    'report', jsonb_build_object(
      'min_ops_date', v_min_date,
      'max_ops_date', v_max_date,
      'latest_completed_ops_date', least(v_max_date, v_latest_completed),
      'day_count', v_day_count,
      'filter_options', (select jsonb_build_object(
        'airline', to_jsonb(airlines),
        'route', to_jsonb(routes),
        'country', to_jsonb(countries)
      ) from filter_options),
      'coverage', (select jsonb_build_object(
        'selected_day_count', selected_day_count,
        'covered_day_count', covered_day_count,
        'partial_day_count', partial_day_count,
        'missing_day_count', missing_day_count
      ) from coverage_summary),
      'peak_day', (select jsonb_build_object(
        'ops_date', peak_day.ops_date,
        'flights', peak_day.flights,
        'status', case when peak_day.ops_date is null then 'unavailable' else 'available' end
      ) from (select 1) seed left join peak_day on true),
      'pax_coverage', (select jsonb_build_object(
        'reported_legs', metric.reported_legs,
        'due_legs', metric.due_legs,
        'percent', case when metric.due_legs > 0
          then round(metric.reported_legs * 100.0 / metric.due_legs, 1) end,
        'status', case when metric.due_legs > 0 then 'available' else 'unavailable' end
      ) from current_metric metric),
      'coverage_counts', (select jsonb_build_object(
        'routes', coverage.routes,
        'airlines', coverage.airlines,
        'countries', coverage.countries
      ) from coverage_counts coverage),
      'quality', (select jsonb_build_object(
        'unknown_country_legs', quality.unknown_country_legs,
        'pax_due_missing_legs', quality.pax_due_missing_legs,
        'quarantined_duplicate_candidates', quarantine.quarantined_candidates
      ) from quality_metric quality cross join quarantine_metric quarantine),
      'breakdowns', jsonb_build_object(
        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
          'key', case label
            when 'J' then 'scheduled'
            else 'charter'
          end,
          'code', label,
          'label', case label
            when 'J' then 'Thường lệ'
            else 'Không thường lệ'
          end,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by case label when 'J' then 1 else 2 end) from dimension_rows
          where dimension = 'flight_category'), '[]'::jsonb),
        'aircraft_group', coalesce((select jsonb_agg(jsonb_build_object(
          'key', lower(replace(label, ' ', '-')),
          'label', label,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by row_rank) from dimension_rows
          where dimension = 'aircraft_group' and row_rank <= 50), '[]'::jsonb),
        'aircraft_type', coalesce((select jsonb_agg(jsonb_build_object(
          'key', lower(replace(grouped.aircraft_group || '-' || grouped.aircraft_type, ' ', '-')),
          'label', grouped.aircraft_type,
          'aircraft_group_key', lower(replace(grouped.aircraft_group, ' ', '-')),
          'aircraft_group', grouped.aircraft_group,
          'flights', grouped.flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', grouped.reported_pax,
          'share', grouped.flights::numeric / nullif(totals.flights, 0),
          'suppressed', false
        ) order by grouped.flights desc, grouped.aircraft_group, grouped.aircraft_type)
          from aircraft_type_grouped grouped cross join aircraft_type_totals totals), '[]'::jsonb),
        'peak_hour', coalesce((select jsonb_agg(jsonb_build_object(
          'hour_bucket', lpad(bucket_index::text, 2, '0') || ':00',
          'bucket_minutes', 60,
          'time_basis', p_time_basis,
          'arrivals', arrivals,
          'departures', departures,
          'regular_flights', jsonb_build_object(
            'arrivals', arrival_regular_flights,
            'departures', departure_regular_flights
          ),
          'suppressed', false
        ) order by bucket_index) from hour_rows), '[]'::jsonb),
        'peak_hour_monthly', coalesce((select jsonb_agg(jsonb_build_object(
          'month', to_char(months.month_start, 'YYYY-MM'),
          'time_basis', p_time_basis,
          'arrival_hour', case when arrivals.hour_index is null then null
            else lpad(arrivals.hour_index::text, 2, '0') || ':00' end,
          'arrival_flights', arrivals.flights,
          'departure_hour', case when departures.hour_index is null then null
            else lpad(departures.hour_index::text, 2, '0') || ':00' end,
          'departure_flights', departures.flights,
          'arrival_suppressed', false,
          'departure_suppressed', false
        ) order by months.month_start)
          from report_months months
          left join monthly_hour_ranked arrivals
            on arrivals.month_start = months.month_start and arrivals.type = 'A' and arrivals.row_rank = 1
          left join monthly_hour_ranked departures
            on departures.month_start = months.month_start and departures.type = 'D' and departures.row_rank = 1), '[]'::jsonb),
        'day_of_week', coalesce((select jsonb_agg(jsonb_build_object(
          'day_index', day_index,
          'calendar_days', calendar_days,
          'total_flights', total_flights,
          'average_flights', average_flights,
          'min_flights', min_flights,
          'max_flights', max_flights,
          'arrivals', arrivals,
          'departures', departures,
          'suppressed', false
        ) order by day_index) from day_of_week_rows), '[]'::jsonb)
      )
    )
  ) into v_result;

  return v_result;
end;
$function$;

-- 9. Drop cutover state table
drop table if exists reporting.operational_reader_cutover_state;

-- 10. Wallboard & Annual KPI rollback
drop trigger if exists capture_operational_daily_acceptance on public.operational_change_events;
drop function if exists reporting.capture_operational_daily_acceptance_v1();
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'legacy_get_public_annual_passenger_kpi_version_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_get_public_annual_passenger_kpi_version_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_get_public_annual_passenger_kpi_version_v1\(', 'FUNCTION public.get_public_annual_passenger_kpi_version_v1(', 'i');
      execute v_fn;
      drop function reporting.legacy_get_public_annual_passenger_kpi_version_v1(integer);
    end if;
  end if;

  if exists (select 1 from pg_proc where proname = 'legacy_get_public_annual_passenger_kpi_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_get_public_annual_passenger_kpi_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_get_public_annual_passenger_kpi_v1\(', 'FUNCTION public.get_public_annual_passenger_kpi_v1(', 'i');
      execute v_fn;
      drop function reporting.legacy_get_public_annual_passenger_kpi_v1(integer, date);
    end if;
  end if;

  if exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_candidate_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_select_public_dashboard_candidate_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_select_public_dashboard_candidate_v1\(', 'FUNCTION reporting.select_public_dashboard_candidate_v1(', 'i');
      execute v_fn;
      drop function reporting.legacy_select_public_dashboard_candidate_v1(timestamp with time zone);
    end if;
  end if;

  if exists (select 1 from pg_proc where proname = 'legacy_publish_public_dashboard_daily_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_publish_public_dashboard_daily_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_publish_public_dashboard_daily_v1\(', 'FUNCTION public.publish_public_dashboard_daily_v1(', 'i');
      execute v_fn;
      drop function reporting.legacy_publish_public_dashboard_daily_v1(integer, date, bigint, text, text, text);
    end if;
  end if;
end;
$$;

revoke execute on function public.get_public_annual_passenger_kpi_version_v1(integer) from public, anon, authenticated;
grant execute on function public.get_public_annual_passenger_kpi_version_v1(integer) to service_role;
revoke execute on function public.get_public_annual_passenger_kpi_v1(integer, date) from public, anon, authenticated;
grant execute on function public.get_public_annual_passenger_kpi_v1(integer, date) to service_role;
revoke execute on function reporting.select_public_dashboard_candidate_v1(timestamptz) from public, anon, authenticated, service_role;
grant execute on function reporting.select_public_dashboard_candidate_v1(timestamptz) to service_role;
revoke execute on function public.publish_public_dashboard_daily_v1(integer, date, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.publish_public_dashboard_daily_v1(integer, date, bigint, text, text, text) to service_role;
commit;
