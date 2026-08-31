-- Add recurring flight schedules to the existing aggregate peak-hour payload.
-- The browser still receives aggregates only: no record id or per-date rows are
-- exposed. A recurring flight must operate on at least four dates and cover at
-- least 70% of the same weekday between its first and last occurrence.

create or replace function reporting.get_traffic_report_breakdowns(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_top_n integer default 10,
  p_time_basis text default 'local',
  p_bucket_minutes integer default 60,
  p_data_as_of timestamptz default now()
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '5s'
as $$
with filtered as materialized (
  select operations.*
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
), expanded as (
  select dimension, coalesce(nullif(label, ''), 'Unknown') as label, type, pax, scheduled_local_at
  from filtered
  cross join lateral (values
    ('airline'::text, airline),
    ('route'::text, route),
    ('country'::text, country),
    ('aircraft_group'::text, aircraft_group)
  ) dimensions(dimension, label)
), grouped as (
  select dimension, label,
    count(*)::integer as flights,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    coalesce(sum(pax) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs
  from expanded
  group by dimension, label
), ranked as (
  select grouped.*, row_number() over (partition by dimension order by flights desc, label) as rank
  from grouped
), top_bucketed as (
  select dimension,
    case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end as label,
    sum(flights)::integer as flights,
    sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures,
    sum(reported_pax)::bigint as reported_pax,
    sum(reported_legs)::integer as reported_legs
  from ranked
  group by dimension, case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end
), dimension_totals as (
  select dimension, sum(flights)::integer as total
  from top_bucketed
  group by dimension
), dimension_json as (
  select top_bucketed.dimension, jsonb_agg(jsonb_build_object(
    'key', lower(replace(top_bucketed.label, ' ', '-')),
    'label', top_bucketed.label,
    'flights', top_bucketed.flights,
    'arrivals', top_bucketed.arrivals,
    'departures', top_bucketed.departures,
    'reported_pax', case when top_bucketed.reported_legs > 0 then top_bucketed.reported_pax end,
    'share', top_bucketed.flights::numeric / nullif(dimension_totals.total, 0),
    'suppressed', false
  ) order by top_bucketed.flights desc, top_bucketed.label) as rows
  from top_bucketed
  join dimension_totals using (dimension)
  group by top_bucketed.dimension
), daily_counts as (
  select ops_date,
    count(*)::integer as flights,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures
  from filtered
  group by ops_date
), daily as (
  select spine.ops_date,
    extract(isodow from spine.ops_date)::integer as day_index,
    coalesce(daily_counts.flights, 0)::integer as flights,
    coalesce(daily_counts.arrivals, 0)::integer as arrivals,
    coalesce(daily_counts.departures, 0)::integer as departures
  from generate_series(p_from_date, p_to_date, interval '1 day') spine(ops_date)
  left join daily_counts on daily_counts.ops_date = spine.ops_date::date
), dow_grouped as (
  select day_index,
    count(*)::integer as calendar_days,
    sum(flights)::integer as total_flights,
    round(avg(flights), 2) as average_flights,
    min(flights)::integer as min_flights,
    max(flights)::integer as max_flights,
    sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures
  from daily
  group by day_index
), dow_rows as (
  select day_index,
    coalesce(dow_grouped.calendar_days, 0)::integer as calendar_days,
    coalesce(dow_grouped.total_flights, 0)::integer as total_flights,
    coalesce(dow_grouped.average_flights, 0)::numeric as average_flights,
    coalesce(dow_grouped.min_flights, 0)::integer as min_flights,
    coalesce(dow_grouped.max_flights, 0)::integer as max_flights,
    coalesce(dow_grouped.arrivals, 0)::integer as arrivals,
    coalesce(dow_grouped.departures, 0)::integer as departures
  from generate_series(1, 7) day_index
  left join dow_grouped using (day_index)
), hour_counts as (
  select
    case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end as bucket_index,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures
  from filtered
  where (case when p_time_basis = 'utc' then utc_minutes else local_minutes end) is not null
  group by case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end
), flight_occurrences as (
  select
    case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end as bucket_index,
    case when p_time_basis = 'utc' then utc_minutes else local_minutes end as scheduled_minutes,
    type,
    airline,
    nullif(split_part(business_leg_key, chr(31), 4), '') as flight_number,
    route,
    ops_date,
    extract(isodow from ops_date)::integer as day_index
  from filtered
  where (case when p_time_basis = 'utc' then utc_minutes else local_minutes end) is not null
), flight_weekday_stats as (
  select bucket_index, type, airline, flight_number, route, day_index,
    count(distinct ops_date)::integer as occurrence_days,
    (((max(ops_date) - min(ops_date)) / 7) + 1)::integer as eligible_days
  from flight_occurrences
  where flight_number is not null
  group by bucket_index, type, airline, flight_number, route, day_index
), qualifying_flight_weekdays as (
  select *
  from flight_weekday_stats
  where occurrence_days >= 4
    and eligible_days >= 4
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
  where flight_number is not null
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
    coalesce(hour_counts.arrivals, 0)::integer as arrivals,
    coalesce(hour_counts.departures, 0)::integer as departures,
    coalesce(arrival_flights.rows, '[]'::jsonb) as arrival_regular_flights,
    coalesce(departure_flights.rows, '[]'::jsonb) as departure_regular_flights
  from generate_series(0, (1440 / p_bucket_minutes) - 1) series(bucket_index)
  left join hour_counts using (bucket_index)
  left join regular_flight_json arrival_flights
    on arrival_flights.bucket_index = series.bucket_index and arrival_flights.type = 'A'
  left join regular_flight_json departure_flights
    on departure_flights.bucket_index = series.bucket_index and departure_flights.type = 'D'
)
select jsonb_build_object(
  'airline', coalesce((select rows from dimension_json where dimension = 'airline'), '[]'::jsonb),
  'route', coalesce((select rows from dimension_json where dimension = 'route'), '[]'::jsonb),
  'country', coalesce((select rows from dimension_json where dimension = 'country'), '[]'::jsonb),
  'aircraft_group', coalesce((select rows from dimension_json where dimension = 'aircraft_group'), '[]'::jsonb),
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
  ) order by day_index) from dow_rows), '[]'::jsonb),
  'peak_hour', coalesce((select jsonb_agg(jsonb_build_object(
    'hour_bucket', lpad((bucket_index * p_bucket_minutes / 60)::text, 2, '0') || ':'
      || lpad((bucket_index * p_bucket_minutes % 60)::text, 2, '0'),
    'bucket_minutes', p_bucket_minutes,
    'time_basis', p_time_basis,
    'arrivals', arrivals,
    'departures', departures,
    'regular_flights', jsonb_build_object(
      'arrivals', arrival_regular_flights,
      'departures', departure_regular_flights
    ),
    'suppressed', false
  ) order by bucket_index) from hour_rows), '[]'::jsonb)
);
$$;

alter function reporting.get_traffic_report_breakdowns(
  date, date, jsonb, integer, text, integer, timestamptz
) owner to postgres;

revoke execute on function reporting.get_traffic_report_breakdowns(
  date, date, jsonb, integer, text, integer, timestamptz
) from public, anon, authenticated, service_role;
