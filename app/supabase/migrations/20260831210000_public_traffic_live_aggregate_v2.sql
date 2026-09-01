-- Additive live aggregate contract for Report and Dashboard Report Mode.
-- The function consumes the canonical ranked candidate boundary, never raw
-- history, and returns only aggregates captured in one PostgreSQL snapshot.

create or replace function public.get_public_traffic_report_v2(
  p_from_date date default null,
  p_to_date date default null,
  p_type text default 'all',
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_comparison text default 'previous',
  p_time_basis text default 'local',
  p_expected_watermark bigint default null,
  p_contract_version text default 'traffic-report-v2'
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, extensions, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_data_as_of timestamptz := statement_timestamp();
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

  v_latest_completed := (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - 1;
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

  with candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from reporting.get_public_traffic_candidate_slice_v1(
      v_scan_from - 1,
      v_scan_to + 1
    ) candidates
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
  ), aircraft_map as materialized (
    select distinct on (upper(types.aircraft_type))
      upper(types.aircraft_type) as aircraft_type,
      groups.name as aircraft_group
    from public.operational_aircraft_group_types types
    join public.operational_aircraft_groups groups on groups.id = types.group_id
    order by upper(types.aircraft_type), groups.name
  ), canonical_rows as materialized (
    select
      ranked.business_leg_key,
      ranked.ops_date,
      upper(btrim(ranked.type)) as type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.flight_number)) as flight_number,
      upper(btrim(ranked.effective_route)) as route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
      coalesce(nullif(btrim(aircraft_map.aircraft_group), ''), 'Unknown') as aircraft_group,
      ranked.effective_pax as pax,
      ranked.local_minutes,
      case when ranked.local_minutes is null then null::integer
        else (ranked.local_minutes + 1020) % 1440 end as utc_minutes,
      ranked.scheduled_local_at,
      ranked.scheduled_local_at + interval '1 day' <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh') as is_due
    from ranked_slice ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join aircraft_map on aircraft_map.aircraft_type = upper(btrim(ranked.effective_aircraft))
    where ranked.candidate_rank = 1
      and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1))
      and ranked.effective_action is distinct from 'deleted'
      and ranked.ops_date between v_scan_from and v_scan_to
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
      ('aircraft_group'::text, rows.aircraft_group)
    ) dimensions(dimension, label)
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
    where ops_date between v_from_date and v_to_date
  ), peak_day as (
    select ops_date, flights
    from timeline_grouped
    order by flights desc, ops_date
    limit 1
  ), quality_metric as (
    select
      count(*) filter (where country = 'Unknown')::integer as unknown_country_legs,
      count(*) filter (where is_due and pax is null)::integer as pax_due_missing_legs
    from current_rows
  ), quarantine_metric as (
    select coalesce(sum(candidate_count), 0)::integer as quarantined_candidates
    from ranked_slice
    where candidate_rank = 1
      and candidate_count > 1
      and (missing_recency_count > 0 or max_recency_count > 1)
      and ops_date between v_from_date and v_to_date
  ), daily_operations as (
    select spine.ops_date::date as ops_date,
      extract(isodow from spine.ops_date)::integer as day_index,
      coalesce(grouped.flights, 0)::integer as flights,
      coalesce(grouped.arrivals, 0)::integer as arrivals,
      coalesce(grouped.departures, 0)::integer as departures
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
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
    where case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
    group by case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end
  ), flight_occurrences as (
    select
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as bucket_index,
      case when p_time_basis = 'utc' then utc_minutes else local_minutes end as scheduled_minutes,
      type, airline, flight_number, route, ops_date,
      extract(isodow from ops_date)::integer as day_index
    from current_rows
    where flight_number <> ''
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
    where type in ('A', 'D')
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
      'quality', (select jsonb_build_object(
        'unknown_country_legs', quality.unknown_country_legs,
        'pax_due_missing_legs', quality.pax_due_missing_legs,
        'quarantined_duplicate_candidates', quarantine.quarantined_candidates
      ) from quality_metric quality cross join quarantine_metric quarantine),
      'breakdowns', jsonb_build_object(
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
          'arrivals', grouped.arrivals,
          'departures', grouped.departures,
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
$$;

alter function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) owner to postgres;
revoke execute on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) to service_role;

revoke all on reporting.public_traffic_ranked_candidates from public, anon, authenticated, service_role;
revoke all on reporting.public_traffic_duplicate_quarantine from public, anon, authenticated, service_role;
revoke all on reporting.public_traffic_candidates from public, anon, authenticated, service_role;

comment on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) is 'Live canonical aggregate bundle for Report and Dashboard; NULL Pax remains missing and true zero remains reported.';
