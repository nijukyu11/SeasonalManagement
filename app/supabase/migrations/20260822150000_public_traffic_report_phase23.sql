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
  select dimension, label, type, pax, pax_status
  from filtered
  cross join lateral (values
    ('airline'::text, airline),
    ('route'::text, route),
    ('country'::text, country),
    ('aircraft_group'::text, aircraft_group)
  ) dimensions(dimension, label)
), grouped as (
  select dimension, coalesce(nullif(label, ''), 'Unknown') as label,
    count(*)::integer as flights,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    coalesce(sum(pax) filter (where pax_status = 'reported'), 0)::bigint as reported_pax
  from expanded
  group by dimension, coalesce(nullif(label, ''), 'Unknown')
), privacy_bucketed as (
  select dimension, case when flights < 3 then 'Khác' else label end as label,
    sum(flights)::integer as flights, sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures, sum(reported_pax)::bigint as reported_pax
  from grouped group by dimension, case when flights < 3 then 'Khác' else label end
), ranked as (
  select privacy_bucketed.*, row_number() over (partition by dimension order by flights desc, label) as rank
  from privacy_bucketed
), top_bucketed as (
  select dimension, case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end as label,
    sum(flights)::integer as flights, sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures, sum(reported_pax)::bigint as reported_pax
  from ranked group by dimension, case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end
), dimension_totals as (
  select dimension, sum(flights)::integer as total from top_bucketed group by dimension
), dimension_rows as (
  select top_bucketed.*, dimension_totals.total,
    top_bucketed.flights between 1 and 2 as small,
    count(*) filter (where top_bucketed.flights between 1 and 2) over (partition by top_bucketed.dimension) as small_count,
    row_number() over (partition by top_bucketed.dimension, top_bucketed.flights >= 3 order by top_bucketed.flights, top_bucketed.label) as visible_rank
  from top_bucketed join dimension_totals using (dimension)
), dimension_json as (
  select dimension, jsonb_agg(jsonb_build_object(
    'key', lower(replace(label, ' ', '-')),
    'label', label,
    'flights', case when not (small or (small_count = 1 and flights >= 3 and visible_rank = 1)) then flights end,
    'arrivals', case when not (small or (small_count = 1 and flights >= 3 and visible_rank = 1)) then arrivals end,
    'departures', case when not (small or (small_count = 1 and flights >= 3 and visible_rank = 1)) then departures end,
    'reported_pax', case when not (small or (small_count = 1 and flights >= 3 and visible_rank = 1)) then reported_pax end,
    'share', case when not (small or (small_count = 1 and flights >= 3 and visible_rank = 1)) then flights::numeric / nullif(total, 0) end,
    'suppressed', (small or (small_count = 1 and flights >= 3 and visible_rank = 1))
  ) order by flights desc, label) as rows
  from dimension_rows group by dimension
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
    sum(departures)::integer as departures,
    bool_or(flights between 1 and 2 or arrivals between 1 and 2 or departures between 1 and 2) as has_small_daily_cell
  from daily
  group by day_index
), dow_spine as (
  select day_index,
    coalesce(calendar_days, 0)::integer as calendar_days,
    coalesce(total_flights, 0)::integer as total_flights,
    coalesce(average_flights, 0)::numeric as average_flights,
    coalesce(min_flights, 0)::integer as min_flights,
    coalesce(max_flights, 0)::integer as max_flights,
    coalesce(arrivals, 0)::integer as arrivals,
    coalesce(departures, 0)::integer as departures,
    coalesce(has_small_daily_cell, false)
      or total_flights between 1 and 2
      or arrivals between 1 and 2
      or departures between 1 and 2 as small
  from generate_series(1, 7) day_index
  left join dow_grouped using (day_index)
), dow_stats as (
  select count(*) filter (where small)::integer as small_count from dow_spine
), dow_ranked as (
  select dow_spine.*,
    row_number() over (partition by total_flights >= 3 order by total_flights, day_index) as visible_rank
  from dow_spine
), dow_rows as (
  select dow_ranked.*,
    small or (dow_stats.small_count = 1 and total_flights >= 3 and visible_rank = 1) as suppressed
  from dow_ranked cross join dow_stats
), hour_counts as (
  select
    case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end as bucket_index,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    count(*)::integer as flights
  from filtered
  where (case when p_time_basis = 'utc' then utc_minutes else local_minutes end) is not null
  group by case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end
), hours as (
  select bucket_index,
    coalesce(hour_counts.arrivals, 0)::integer as arrivals,
    coalesce(hour_counts.departures, 0)::integer as departures,
    coalesce(hour_counts.flights, 0)::integer as flights,
    coalesce(hour_counts.flights, 0) between 1 and 2
      or coalesce(hour_counts.arrivals, 0) between 1 and 2
      or coalesce(hour_counts.departures, 0) between 1 and 2 as small
  from generate_series(0, (1440 / p_bucket_minutes) - 1) bucket_index
  left join hour_counts using (bucket_index)
), hour_stats as (
  select count(*) filter (where small)::integer as small_count from hours
), hour_ranked as (
  select hours.*,
    row_number() over (partition by flights >= 3 order by flights, bucket_index) as visible_rank
  from hours
), hour_rows as (
  select hour_ranked.*,
    small or (hour_stats.small_count = 1 and flights >= 3 and visible_rank = 1) as suppressed
  from hour_ranked cross join hour_stats
)
select jsonb_build_object(
  'airline', coalesce((select rows from dimension_json where dimension = 'airline'), '[]'::jsonb),
  'route', coalesce((select rows from dimension_json where dimension = 'route'), '[]'::jsonb),
  'country', coalesce((select rows from dimension_json where dimension = 'country'), '[]'::jsonb),
  'aircraft_group', coalesce((select rows from dimension_json where dimension = 'aircraft_group'), '[]'::jsonb),
  'day_of_week', coalesce((select jsonb_agg(jsonb_build_object(
    'day_index', day_index,
    'calendar_days', case when not suppressed then calendar_days end,
    'total_flights', case when not suppressed then total_flights end,
    'average_flights', case when not suppressed then average_flights end,
    'min_flights', case when not suppressed then min_flights end,
    'max_flights', case when not suppressed then max_flights end,
    'arrivals', case when not suppressed then arrivals end,
    'departures', case when not suppressed then departures end,
    'suppressed', suppressed
  ) order by day_index) from dow_rows), '[]'::jsonb),
  'peak_hour', coalesce((select jsonb_agg(jsonb_build_object(
    'hour_bucket', lpad((bucket_index * p_bucket_minutes / 60)::text, 2, '0') || ':' || lpad((bucket_index * p_bucket_minutes % 60)::text, 2, '0'),
    'bucket_minutes', p_bucket_minutes,
    'time_basis', p_time_basis,
    'arrivals', case when not suppressed then arrivals end,
    'departures', case when not suppressed then departures end,
    'suppressed', suppressed
  ) order by bucket_index) from hour_rows), '[]'::jsonb)
);
$$;

create or replace function public.get_public_traffic_report_overview_v1(
  p_from_date date default null,
  p_to_date date default null,
  p_types text[] default array['A', 'D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_aircraft_groups text[] default array[]::text[],
  p_comparison text default 'previous_period',
  p_time_basis text default 'local',
  p_timeline_after date default null,
  p_timeline_page_size integer default 366,
  p_contract_version text default 'traffic-report-v1'
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_min_date date;
  v_max_date date;
  v_completed_date date;
  v_from_date date;
  v_to_date date;
  v_data_as_of timestamptz;
  v_filters jsonb;
  v_filter_options jsonb;
  v_request jsonb;
  v_request_hash text;
  v_kpis jsonb;
  v_timeline jsonb;
  v_breakdowns jsonb;
  v_watermark bigint;
begin
  if p_contract_version <> 'traffic-report-v1' then raise exception 'unsupported contract_version' using errcode = '22023'; end if;
  if (p_from_date is null) <> (p_to_date is null) then raise exception 'from_date and to_date must be provided together' using errcode = '22023'; end if;
  if p_comparison not in ('previous_period', 'previous_year', 'none') then raise exception 'invalid comparison' using errcode = '22023'; end if;
  if p_time_basis not in ('local', 'utc') then raise exception 'invalid time_basis' using errcode = '22023'; end if;
  if p_types <@ array['A', 'D']::text[] is not true or cardinality(p_types) = 0 then raise exception 'invalid types' using errcode = '22023'; end if;
  if cardinality(p_airlines) > 24 or cardinality(p_routes) > 24 or cardinality(p_countries) > 24 or cardinality(p_aircraft_groups) > 24 then raise exception 'filter cardinality exceeds 24' using errcode = '54000'; end if;

  select min(ops_date), max(ops_date), max(snapshot_refreshed_at), max(snapshot_source_watermark)
    into v_min_date, v_max_date, v_data_as_of, v_watermark
  from reporting.public_traffic_effective;
  if v_min_date is null or v_max_date is null then raise exception 'traffic report has no effective operations' using errcode = 'P0002'; end if;
  v_completed_date := (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date
    - case when (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::time < time '05:00' then 2 else 1 end;
  v_from_date := coalesce(p_from_date, greatest(v_min_date, make_date(extract(year from v_completed_date)::integer, 1, 1)));
  v_to_date := coalesce(p_to_date, least(v_max_date, v_completed_date));
  if v_to_date < v_from_date and p_from_date is null then v_from_date := v_min_date; v_to_date := v_min_date; end if;
  if v_from_date > v_to_date then raise exception 'from_date must not exceed to_date' using errcode = '22023'; end if;
  if v_from_date < v_min_date or v_to_date > v_max_date then raise exception 'date range is outside available Ops Date domain' using errcode = '22023'; end if;

  v_filters := jsonb_strip_nulls(jsonb_build_object(
    'types', to_jsonb((select array_agg(distinct upper(value) order by upper(value)) from unnest(p_types) value)),
    'airlines', case when cardinality(p_airlines) > 0 then to_jsonb((select array_agg(distinct upper(value) order by upper(value)) from unnest(p_airlines) value)) end,
    'routes', case when cardinality(p_routes) > 0 then to_jsonb((select array_agg(distinct upper(value) order by upper(value)) from unnest(p_routes) value)) end,
    'countries', case when cardinality(p_countries) > 0 then to_jsonb((select array_agg(distinct value order by value) from unnest(p_countries) value)) end,
    'aircraft_groups', case when cardinality(p_aircraft_groups) > 0 then to_jsonb((select array_agg(distinct value order by value) from unnest(p_aircraft_groups) value)) end
  ));
  v_request := jsonb_build_object('from', v_from_date, 'to', v_to_date, 'filters', v_filters, 'comparison', p_comparison, 'time_basis', p_time_basis, 'contract_version', p_contract_version);
  v_request_hash := encode(extensions.digest(convert_to(v_request::text, 'UTF8'), 'sha256'), 'hex');
  v_kpis := reporting.get_traffic_report_kpis(v_from_date, v_to_date, v_filters, p_comparison, v_data_as_of);
  v_timeline := reporting.get_traffic_report_timeline(v_from_date, v_to_date, null, null, 'day', p_timeline_after, p_timeline_page_size, v_filters, v_data_as_of);
  v_breakdowns := reporting.get_traffic_report_breakdowns(v_from_date, v_to_date, v_filters, 10, p_time_basis, 60, v_data_as_of);
  select jsonb_build_object(
    'airline', coalesce((select jsonb_agg(label order by label) from (
      select airline as label from reporting.public_traffic_effective
      where airline <> '' group by airline having count(*) >= 3 order by airline limit 250
    ) options), '[]'::jsonb),
    'route', coalesce((select jsonb_agg(label order by label) from (
      select route as label from reporting.public_traffic_effective
      where route <> '' group by route having count(*) >= 3 order by route limit 250
    ) options), '[]'::jsonb)
  ) into v_filter_options;

  return jsonb_build_object(
    'contract_version', p_contract_version,
    'request_hash', v_request_hash,
    'data_as_of', v_data_as_of,
    'source_watermark', coalesce(to_jsonb(v_watermark), to_jsonb('unknown'::text)),
    'metadata', jsonb_build_object(
      'min_ops_date', v_min_date,
      'max_ops_date', v_max_date,
      'normalized_filter', jsonb_build_object(
        'from', v_from_date, 'to', v_to_date,
        'type', case when p_types = array['A']::text[] then 'A' when p_types = array['D']::text[] then 'D' else 'all' end,
        'airline', coalesce(v_filters->'airlines', '[]'::jsonb),
        'route', coalesce(v_filters->'routes', '[]'::jsonb),
        'country', coalesce(v_filters->'countries', '[]'::jsonb),
        'comp', case p_comparison when 'previous_year' then 'year_ago' when 'none' then 'none' else 'previous' end,
        'tz', p_time_basis
      ),
      'filter_options', v_filter_options,
      'filter_options_limit', 250,
      'day_count', v_to_date - v_from_date + 1,
      'timeline_granularity', 'day',
      'timeline_has_more', coalesce((v_timeline->>'has_more')::boolean, false),
      'timeline_next_cursor', v_timeline->>'next_cursor',
      'suppression_policy', jsonb_build_object('threshold', 3, 'applied', true)
    ),
    'kpis', v_kpis - 'quality',
    'timeline', coalesce(v_timeline->'series', '[]'::jsonb),
    'breakdowns', v_breakdowns,
    'quality', coalesce(v_kpis->'quality', '{}'::jsonb) || jsonb_build_object(
      'notes', jsonb_build_array(
        'Pax = 0 hoặc null không được suy diễn là đã báo cáo.',
        'Coverage dùng mọi leg đến hạn T+1; chưa có cờ miễn trừ cargo/ferry.',
        'Country lấy từ database; tuyến chưa mapping thuộc nhóm Unknown.'
      )
    )
  );
end;
$$;

alter function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) owner to postgres;
alter function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) owner to postgres;
revoke execute on function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) to service_role;
