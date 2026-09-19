-- Aggregate-only matrices for peak-hour and weekday analysis.
-- Monthly averages use certified complete Ops Dates only and are rounded to
-- whole flights. Missing dates remain NULL; certified zero dates remain zero.

create or replace function reporting.get_traffic_report_weekday_heatmaps_v1(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '6s'
as $$
with spine as (
  select day::date as ops_date,
    date_trunc('month', day)::date as month_start,
    extract(isodow from day)::integer as day_index
  from generate_series(p_from_date, p_to_date, interval '1 day') day
), source_days as (
  select operations.ops_date, count(*)::integer as flights
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
  group by operations.ops_date
), filtered_days as (
  select operations.ops_date,
    count(*)::integer as flights,
    count(*) filter (where operations.type = 'A')::integer as arrivals,
    count(*) filter (where operations.type = 'D')::integer as departures
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
  group by operations.ops_date
), coverage as (
  select spine.*,
    coalesce((
      select ledger.status
      from reporting.public_traffic_coverage ledger
      where spine.ops_date between ledger.from_date and ledger.to_date
        and ledger.status <> 'excluded'
      order by ledger.certified_at desc nulls last, ledger.id desc
      limit 1
    ), case when coalesce(source_days.flights, 0) > 0 then 'partial' else 'missing' end) as coverage_status
  from spine
  left join source_days using (ops_date)
), daily as (
  select coverage.ops_date, coverage.month_start, coverage.day_index, coverage.coverage_status,
    case when filtered_days.flights is not null then filtered_days.flights when coverage.coverage_status = 'complete' then 0 end as flights,
    case when filtered_days.arrivals is not null then filtered_days.arrivals when coverage.coverage_status = 'complete' then 0 end as arrivals,
    case when filtered_days.departures is not null then filtered_days.departures when coverage.coverage_status = 'complete' then 0 end as departures
  from coverage
  left join filtered_days using (ops_date)
), summary_grouped as (
  select day_index,
    count(*)::integer as calendar_days,
    count(*) filter (where coverage_status = 'complete')::integer as complete_day_count,
    sum(flights) filter (where coverage_status = 'complete')::integer as total_flights,
    round(avg(flights) filter (where coverage_status = 'complete'), 0)::integer as average_flights,
    min(flights) filter (where coverage_status = 'complete')::integer as min_flights,
    max(flights) filter (where coverage_status = 'complete')::integer as max_flights,
    sum(arrivals) filter (where coverage_status = 'complete')::integer as arrivals,
    round(avg(arrivals) filter (where coverage_status = 'complete'), 0)::integer as average_arrivals,
    min(arrivals) filter (where coverage_status = 'complete')::integer as min_arrivals,
    max(arrivals) filter (where coverage_status = 'complete')::integer as max_arrivals,
    sum(departures) filter (where coverage_status = 'complete')::integer as departures,
    round(avg(departures) filter (where coverage_status = 'complete'), 0)::integer as average_departures,
    min(departures) filter (where coverage_status = 'complete')::integer as min_departures,
    max(departures) filter (where coverage_status = 'complete')::integer as max_departures
  from daily
  group by day_index
), summary_rows as (
  select day_index,
    coalesce(grouped.calendar_days, 0)::integer as calendar_days,
    coalesce(grouped.complete_day_count, 0)::integer as complete_day_count,
    grouped.total_flights, grouped.average_flights, grouped.min_flights, grouped.max_flights,
    grouped.arrivals, grouped.average_arrivals, grouped.min_arrivals, grouped.max_arrivals,
    grouped.departures, grouped.average_departures, grouped.min_departures, grouped.max_departures,
    case
      when coalesce(grouped.complete_day_count, 0) = 0 then 'missing'
      when grouped.complete_day_count < grouped.calendar_days then 'partial'
      else 'complete'
    end as status
  from generate_series(1, 7) day_index
  left join summary_grouped grouped using (day_index)
), month_days as (
  select distinct month_start from spine
), month_weekdays as (
  select month_days.month_start, day_index
  from month_days cross join generate_series(1, 7) day_index
), monthly_grouped as (
  select month_start, day_index,
    count(*)::integer as selected_day_count,
    count(*) filter (where coverage_status = 'complete')::integer as complete_day_count,
    avg(flights) filter (where coverage_status = 'complete') as raw_average_flights,
    avg(arrivals) filter (where coverage_status = 'complete') as raw_average_arrivals,
    avg(departures) filter (where coverage_status = 'complete') as raw_average_departures
  from daily
  group by month_start, day_index
), monthly_values as (
  select matrix.month_start, matrix.day_index,
    coalesce(grouped.selected_day_count, 0)::integer as selected_day_count,
    coalesce(grouped.complete_day_count, 0)::integer as complete_day_count,
    round(grouped.raw_average_flights, 0)::integer as average_flights,
    round(grouped.raw_average_arrivals, 0)::integer as average_arrivals,
    round(grouped.raw_average_departures, 0)::integer as average_departures,
    grouped.raw_average_flights, grouped.raw_average_arrivals, grouped.raw_average_departures,
    case
      when coalesce(grouped.complete_day_count, 0) = 0 then 'missing'
      when grouped.complete_day_count < grouped.selected_day_count then 'partial'
      else 'complete'
    end as status
  from month_weekdays matrix
  left join monthly_grouped grouped using (month_start, day_index)
), monthly_marked as (
  select monthly_values.*,
    coalesce(raw_average_flights > 0 and raw_average_flights = max(raw_average_flights) over (partition by month_start), false) as is_peak_all,
    coalesce(raw_average_arrivals > 0 and raw_average_arrivals = max(raw_average_arrivals) over (partition by month_start), false) as is_peak_arrivals,
    coalesce(raw_average_departures > 0 and raw_average_departures = max(raw_average_departures) over (partition by month_start), false) as is_peak_departures
  from monthly_values
)
select jsonb_build_object(
  'summary', coalesce((select jsonb_agg(jsonb_build_object(
    'day_index', day_index,
    'calendar_days', calendar_days,
    'complete_day_count', complete_day_count,
    'total_flights', total_flights,
    'average_flights', average_flights,
    'min_flights', min_flights,
    'max_flights', max_flights,
    'arrivals', arrivals,
    'average_arrivals', average_arrivals,
    'min_arrivals', min_arrivals,
    'max_arrivals', max_arrivals,
    'departures', departures,
    'average_departures', average_departures,
    'min_departures', min_departures,
    'max_departures', max_departures,
    'status', status,
    'suppressed', false
  ) order by day_index) from summary_rows), '[]'::jsonb),
  'monthly', coalesce((select jsonb_agg(jsonb_build_object(
    'month', to_char(month_start, 'YYYY-MM'),
    'day_index', day_index,
    'selected_day_count', selected_day_count,
    'complete_day_count', complete_day_count,
    'average_flights', average_flights,
    'average_arrivals', average_arrivals,
    'average_departures', average_departures,
    'status', status,
    'is_peak_all', is_peak_all,
    'is_peak_arrivals', is_peak_arrivals,
    'is_peak_departures', is_peak_departures
  ) order by month_start, day_index) from monthly_marked), '[]'::jsonb)
);
$$;

create or replace function reporting.get_traffic_report_peak_hour_heatmap_v1(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_time_basis text default 'local'
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '6s'
as $$
with spine as (
  select day::date as ops_date from generate_series(p_from_date, p_to_date, interval '1 day') day
), source_days as (
  select operations.ops_date, count(*)::integer as flights
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
  group by operations.ops_date
), filtered_hours as (
  select operations.ops_date,
    case when p_time_basis = 'utc' then operations.utc_minutes / 60 else operations.local_minutes / 60 end as hour_index,
    count(*)::integer as flights
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (case when p_time_basis = 'utc' then operations.utc_minutes else operations.local_minutes end) is not null
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
  group by operations.ops_date,
    case when p_time_basis = 'utc' then operations.utc_minutes / 60 else operations.local_minutes / 60 end
), filtered_days as (
  select ops_date, sum(flights)::integer as flights from filtered_hours group by ops_date
), coverage as (
  select spine.ops_date,
    coalesce((
      select ledger.status
      from reporting.public_traffic_coverage ledger
      where spine.ops_date between ledger.from_date and ledger.to_date
        and ledger.status <> 'excluded'
      order by ledger.certified_at desc nulls last, ledger.id desc
      limit 1
    ), case when coalesce(source_days.flights, 0) > 0 then 'partial' else 'missing' end) as coverage_status
  from spine
  left join source_days using (ops_date)
), day_totals as (
  select coverage.ops_date, coverage.coverage_status,
    case when filtered_days.flights is not null then filtered_days.flights when coverage.coverage_status = 'complete' then 0 end as flights
  from coverage left join filtered_days using (ops_date)
), marked_days as (
  select day_totals.*,
    coalesce(flights > 0 and flights = max(flights) over (), false) as is_month_peak
  from day_totals
), matrix as (
  select coverage.ops_date, coverage.coverage_status, hours.hour_index,
    case when filtered_hours.flights is not null then filtered_hours.flights when coverage.coverage_status = 'complete' then 0 end as flights
  from coverage
  cross join generate_series(0, 23) hours(hour_index)
  left join filtered_hours using (ops_date, hour_index)
), monthly_average as (
  select hour_index,
    round(avg(flights) filter (where coverage_status = 'complete'), 0)::integer as flights
  from matrix
  group by hour_index
), monthly_row as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'hour_bucket', lpad(hour_index::text, 2, '0') || ':00',
    'flights', flights
  ) order by ((hour_index - case when p_time_basis = 'utc' then 22 else 5 end + 24) % 24)), '[]'::jsonb) as buckets
  from monthly_average
), daily_rows as (
  select marked.ops_date, marked.coverage_status, marked.flights as total_flights, marked.is_month_peak,
    coalesce(jsonb_agg(jsonb_build_object(
      'hour_bucket', lpad(matrix.hour_index::text, 2, '0') || ':00',
      'flights', matrix.flights
    ) order by ((matrix.hour_index - case when p_time_basis = 'utc' then 22 else 5 end + 24) % 24)), '[]'::jsonb) as buckets
  from marked_days marked
  join matrix using (ops_date, coverage_status)
  group by marked.ops_date, marked.coverage_status, marked.flights, marked.is_month_peak
)
select jsonb_build_object(
  'month', to_char(p_from_date, 'YYYY-MM'),
  'time_basis', p_time_basis,
  'selected_day_count', (select count(*) from spine),
  'complete_day_count', (select count(*) from coverage where coverage_status = 'complete'),
  'partial_day_count', (select count(*) from coverage where coverage_status = 'partial'),
  'missing_day_count', (select count(*) from coverage where coverage_status = 'missing'),
  'monthly_average', (select buckets from monthly_row),
  'days', coalesce((select jsonb_agg(jsonb_build_object(
    'ops_date', ops_date,
    'status', coverage_status,
    'total_flights', total_flights,
    'is_month_peak', is_month_peak,
    'buckets', buckets
  ) order by ops_date) from daily_rows), '[]'::jsonb)
);
$$;

do $$
begin
  if to_regprocedure('public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)') is null then
    alter function public.get_public_traffic_report_overview_v1(
      date,date,text[],text[],text[],text[],text[],text,text,date,integer,text
    ) rename to get_public_traffic_report_overview_peak_heatmaps_base_v1;
  end if;
end;
$$;

create or replace function public.get_public_traffic_report_overview_v1(
  p_from_date date default null,
  p_to_date date default null,
  p_types text[] default array['A','D']::text[],
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
set statement_timeout = '9s'
as $$
declare
  v_result jsonb;
  v_weekdays jsonb;
  v_filters jsonb;
  v_from date;
  v_to date;
begin
  v_result := public.get_public_traffic_report_overview_peak_heatmaps_base_v1(
    p_from_date,p_to_date,p_types,p_airlines,p_routes,p_countries,p_aircraft_groups,
    p_comparison,p_time_basis,p_timeline_after,p_timeline_page_size,p_contract_version
  );
  v_from := (v_result#>>'{metadata,normalized_filter,from}')::date;
  v_to := (v_result#>>'{metadata,normalized_filter,to}')::date;
  v_filters := jsonb_strip_nulls(jsonb_build_object(
    'types', to_jsonb(coalesce(p_types, array['A','D']::text[])),
    'airlines', case when cardinality(p_airlines) > 0 then to_jsonb(p_airlines) end,
    'routes', case when cardinality(p_routes) > 0 then to_jsonb(p_routes) end,
    'countries', case when cardinality(p_countries) > 0 then to_jsonb(p_countries) end,
    'aircraft_groups', case when cardinality(p_aircraft_groups) > 0 then to_jsonb(p_aircraft_groups) end
  ));
  v_weekdays := reporting.get_traffic_report_weekday_heatmaps_v1(v_from, v_to, v_filters);
  v_result := jsonb_set(v_result, '{breakdowns,day_of_week}', v_weekdays->'summary', true);
  return jsonb_set(v_result, '{breakdowns,day_of_week_monthly}', v_weekdays->'monthly', true);
end;
$$;

create or replace function public.get_public_traffic_report_peak_hour_heatmap_v1(
  p_from_date date,
  p_to_date date,
  p_types text[] default array['A','D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_aircraft_groups text[] default array[]::text[],
  p_time_basis text default 'local',
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
  v_state reporting.public_traffic_projection_state%rowtype;
  v_matrix jsonb;
  v_filters jsonb;
begin
  if p_contract_version <> 'traffic-report-v1' then raise exception 'unsupported contract version'; end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then raise exception 'invalid date range'; end if;
  if date_trunc('month', p_from_date) <> date_trunc('month', p_to_date) then raise exception 'peak-hour heatmap must stay within one month'; end if;
  if p_time_basis not in ('local','utc') then raise exception 'invalid time basis'; end if;
  select min(ops_date), max(ops_date) into v_min_date, v_max_date from reporting.public_traffic_effective;
  if v_min_date is null or p_from_date < v_min_date or p_to_date > v_max_date then raise exception 'date range outside available Ops Date domain'; end if;
  v_filters := jsonb_strip_nulls(jsonb_build_object(
    'types', to_jsonb(coalesce(p_types, array['A','D']::text[])),
    'airlines', case when cardinality(p_airlines) > 0 then to_jsonb(p_airlines) end,
    'routes', case when cardinality(p_routes) > 0 then to_jsonb(p_routes) end,
    'countries', case when cardinality(p_countries) > 0 then to_jsonb(p_countries) end,
    'aircraft_groups', case when cardinality(p_aircraft_groups) > 0 then to_jsonb(p_aircraft_groups) end
  ));
  v_matrix := reporting.get_traffic_report_peak_hour_heatmap_v1(p_from_date, p_to_date, v_filters, p_time_basis);
  select * into v_state from reporting.public_traffic_projection_state where projection_name = 'public_traffic_effective';
  return jsonb_build_object(
    'contract_version', p_contract_version,
    'data_as_of', now(),
    'source_watermark', coalesce(to_jsonb(v_state.source_watermark), '"unknown"'::jsonb),
    'type', case when coalesce(array_length(p_types, 1), 0) = 1 then upper(p_types[1]) else 'all' end,
    'time_basis', p_time_basis
  ) || v_matrix;
end;
$$;

alter function reporting.get_traffic_report_weekday_heatmaps_v1(date,date,jsonb) owner to postgres;
alter function reporting.get_traffic_report_peak_hour_heatmap_v1(date,date,jsonb,text) owner to postgres;
alter function public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) owner to postgres;
alter function public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) owner to postgres;
alter function public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text) owner to postgres;

revoke execute on function reporting.get_traffic_report_weekday_heatmaps_v1(date,date,jsonb) from public,anon,authenticated,service_role;
revoke execute on function reporting.get_traffic_report_peak_hour_heatmap_v1(date,date,jsonb,text) from public,anon,authenticated,service_role;
revoke execute on function public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) from public,anon,authenticated,service_role;
revoke execute on function public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) from public,anon,authenticated;
revoke execute on function public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text) from public,anon,authenticated;
grant execute on function public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) to service_role;
grant execute on function public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text) to service_role;
