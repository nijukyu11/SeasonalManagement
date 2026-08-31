-- The report is an internal operational report exposed through an unauthenticated
-- aggregate-only Edge endpoint. Publish every aggregate cell while preserving
-- the existing v1 request/response shape, pagination, resource limits, and Pax
-- semantics: NULL is unknown, whereas a reported value of zero is a true zero.

create or replace function reporting.get_traffic_report_kpis(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_comparison text default 'previous_period',
  p_data_as_of timestamptz default now()
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '5s'
as $$
with bounds as (
  select min(ops_date) as min_date, max(ops_date) as max_date
  from reporting.public_traffic_effective
), comparison_range as (
  select
    case p_comparison
      when 'previous_period' then p_from_date - (p_to_date - p_from_date + 1)
      when 'previous_year' then (p_from_date - interval '1 year')::date
    end as from_date,
    case p_comparison
      when 'previous_period' then p_from_date - 1
      when 'previous_year' then (p_to_date - interval '1 year')::date
    end as to_date
), scoped as (
  select operations.*, 'current'::text as period
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
  union all
  select operations.*, 'comparison'::text
  from reporting.public_traffic_effective operations
  cross join comparison_range
  where p_comparison <> 'none'
    and operations.ops_date between comparison_range.from_date and comparison_range.to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
), totals as (
  select period,
    count(*)::integer as flights,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    coalesce(sum(pax) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as due_legs,
    count(*) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs
  from scoped
  group by period
), daily as (
  select ops_date, count(*)::integer as flights
  from scoped
  where period = 'current'
  group by ops_date
  order by flights desc, ops_date
  limit 1
), quality as (
  select
    count(*) filter (where country = 'Unknown')::integer as unknown_country,
    count(*) filter (
      where pax is null
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as pax_due_missing
  from scoped
  where period = 'current'
), quarantine as (
  select coalesce(max(snapshot_quarantined_candidate_count), 0)::integer as candidates
  from reporting.public_traffic_effective
), current_totals as (
  select coalesce((select flights from totals where period = 'current'), 0) as flights,
    coalesce((select arrivals from totals where period = 'current'), 0) as arrivals,
    coalesce((select departures from totals where period = 'current'), 0) as departures,
    coalesce((select reported_pax from totals where period = 'current'), 0) as reported_pax,
    coalesce((select due_legs from totals where period = 'current'), 0) as due_legs,
    coalesce((select reported_legs from totals where period = 'current'), 0) as reported_legs
), comparison_totals as (
  select coalesce((select flights from totals where period = 'comparison'), 0) as flights,
    coalesce((select arrivals from totals where period = 'comparison'), 0) as arrivals,
    coalesce((select departures from totals where period = 'comparison'), 0) as departures,
    coalesce((select reported_pax from totals where period = 'comparison'), 0) as reported_pax,
    coalesce((select reported_legs from totals where period = 'comparison'), 0) as reported_legs
)
select jsonb_build_object(
  'current', jsonb_build_object(
    'flights', current_totals.flights,
    'arrivals', current_totals.arrivals,
    'departures', current_totals.departures,
    'reported_pax', case when current_totals.reported_legs > 0 then current_totals.reported_pax end,
    'status', 'complete'
  ),
  'comparison', jsonb_build_object(
    'from', comparison_range.from_date,
    'to', comparison_range.to_date,
    'mode', case p_comparison when 'previous_year' then 'year_ago' when 'none' then 'none' else 'previous' end,
    'flights', case when p_comparison <> 'none' then comparison_totals.flights end,
    'arrivals', case when p_comparison <> 'none' then comparison_totals.arrivals end,
    'departures', case when p_comparison <> 'none' then comparison_totals.departures end,
    'reported_pax', case when p_comparison <> 'none' and comparison_totals.reported_legs > 0 then comparison_totals.reported_pax end,
    'status', case
      when p_comparison = 'none' then 'unavailable'
      when comparison_range.to_date < bounds.min_date or comparison_range.from_date > bounds.max_date then 'unavailable'
      when comparison_range.from_date < bounds.min_date or comparison_range.to_date > bounds.max_date then 'partial'
      else 'complete'
    end
  ),
  'peak_day', jsonb_build_object(
    'ops_date', (select ops_date from daily),
    'flights', (select flights from daily),
    'status', case when exists(select 1 from daily) then 'available' else 'unavailable' end
  ),
  'pax_coverage', jsonb_build_object(
    'reported_legs', current_totals.reported_legs,
    'due_legs', current_totals.due_legs,
    'percent', case when current_totals.due_legs > 0 then round(current_totals.reported_legs * 100.0 / current_totals.due_legs, 1) end,
    'status', case when current_totals.due_legs > 0 then 'available' else 'unavailable' end
  ),
  'quality', jsonb_build_object(
    'unknown_country_legs', quality.unknown_country,
    'pax_due_missing_legs', quality.pax_due_missing,
    'quarantined_duplicate_candidates', quarantine.candidates
  )
)
from bounds, comparison_range, current_totals, comparison_totals, quality, quarantine;
$$;

create or replace function reporting.get_traffic_report_timeline_v2(
  p_from_date date,
  p_to_date date,
  p_window_from date default null,
  p_window_to date default null,
  p_granularity text default 'day',
  p_after_date date default null,
  p_page_size integer default 366,
  p_filters jsonb default '{}'::jsonb,
  p_data_as_of timestamptz default now()
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
with requested as (
  select greatest(p_from_date, coalesce(p_window_from, p_from_date), coalesce(p_after_date + 1, p_from_date)) as page_from,
    least(p_to_date, coalesce(p_window_to, p_to_date)) as requested_to
), page as (
  select page_from,
    least(requested_to, page_from + least(greatest(p_page_size, 1), 732) - 1) as page_to,
    requested_to
  from requested
), spine as (
  select generate_series(page.page_from, page.page_to, interval '1 day')::date as ops_date
  from page
), grouped as (
  select operations.ops_date,
    count(*)::integer as flights,
    count(*) filter (where operations.type = 'A')::integer as arrivals,
    count(*) filter (where operations.type = 'D')::integer as departures,
    coalesce(sum(operations.pax) filter (
      where operations.pax is not null
        and operations.scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where operations.pax is not null
        and operations.scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs,
    count(*) filter (
      where operations.scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as due_legs
  from reporting.public_traffic_effective operations, page
  where operations.ops_date between page.page_from and page.page_to
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
  group by operations.ops_date
), coverage as (
  select spine.ops_date,
    coalesce((
      select ledger.status
      from reporting.public_traffic_coverage ledger
      where spine.ops_date between ledger.from_date and ledger.to_date
        and ledger.status <> 'excluded'
      order by ledger.certified_at desc nulls last, ledger.id desc
      limit 1
    ), case when coalesce(grouped.flights, 0) > 0 then 'partial' else 'missing' end) as coverage_status
  from spine
  left join grouped using (ops_date)
), joined as (
  select spine.ops_date,
    coverage.coverage_status,
    case when grouped.flights is not null then grouped.flights when coverage.coverage_status = 'complete' then 0 end as flights,
    case when grouped.arrivals is not null then grouped.arrivals when coverage.coverage_status = 'complete' then 0 end as arrivals,
    case when grouped.departures is not null then grouped.departures when coverage.coverage_status = 'complete' then 0 end as departures,
    case when grouped.reported_legs > 0 then grouped.reported_pax end as reported_pax,
    coalesce(grouped.reported_legs, 0)::integer as reported_legs,
    coalesce(grouped.due_legs, 0)::integer as due_legs
  from spine
  join coverage using (ops_date)
  left join grouped using (ops_date)
)
select jsonb_build_object(
  'page_from', page.page_from,
  'page_to', page.page_to,
  'has_more', page.page_to < page.requested_to,
  'next_cursor', case when page.page_to < page.requested_to then page.page_to::text end,
  'granularity', p_granularity,
  'series', coalesce(jsonb_agg(jsonb_build_object(
    'ops_date', joined.ops_date,
    'flights', joined.flights,
    'arrivals', joined.arrivals,
    'departures', joined.departures,
    'reported_pax', joined.reported_pax,
    'reported_legs', joined.reported_legs,
    'due_legs', joined.due_legs,
    'pax_coverage_pct', case when joined.due_legs > 0 then round(joined.reported_legs * 100.0 / joined.due_legs, 1) end,
    'pax_status', case when joined.due_legs = 0 then 'not_due' when joined.reported_legs = 0 then 'unavailable' else 'available' end,
    'suppressed', false,
    'status', case
      when joined.coverage_status = 'missing' then 'missing'
      when joined.coverage_status = 'partial' then 'partial'
      when joined.ops_date > ((p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - case when (p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::time < time '05:00' then 1 else 0 end) then 'future'
      when joined.flights = 0 then 'zero'
      else 'complete'
    end,
    'completeness', joined.coverage_status
  ) order by joined.ops_date), '[]'::jsonb)
)
from page left join joined on true
group by page.page_from, page.page_to, page.requested_to;
$$;

create or replace function reporting.get_traffic_report_monthly_peaks_v2(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_time_basis text default 'local'
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '5s'
as $$
with filtered as (
  select operations.*,
    date_trunc('month', operations.ops_date)::date as month_start,
    case when p_time_basis = 'utc' then operations.utc_minutes / 60 else operations.local_minutes / 60 end as hour_index
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
), counts as (
  select month_start, type, hour_index, count(*)::integer as flights
  from filtered
  where type in ('A', 'D') and hour_index is not null
  group by month_start, type, hour_index
), ranked as (
  select counts.*, row_number() over (partition by month_start, type order by flights desc, hour_index) as rank
  from counts
), months as (
  select generate_series(date_trunc('month', p_from_date::timestamp), date_trunc('month', p_to_date::timestamp), interval '1 month')::date as month_start
)
select coalesce(jsonb_agg(jsonb_build_object(
  'month', to_char(months.month_start, 'YYYY-MM'),
  'time_basis', p_time_basis,
  'arrival_hour', case when arrivals.flights is not null then lpad(arrivals.hour_index::text, 2, '0') || ':00' end,
  'arrival_flights', arrivals.flights,
  'departure_hour', case when departures.flights is not null then lpad(departures.hour_index::text, 2, '0') || ':00' end,
  'departure_flights', departures.flights,
  'arrival_suppressed', false,
  'departure_suppressed', false
) order by months.month_start), '[]'::jsonb)
from months
left join ranked arrivals on arrivals.month_start = months.month_start and arrivals.type = 'A' and arrivals.rank = 1
left join ranked departures on departures.month_start = months.month_start and departures.type = 'D' and departures.rank = 1;
$$;

create or replace function public.get_public_traffic_report_dimension_v2(
  p_from_date date,
  p_to_date date,
  p_dimension text,
  p_types text[] default array['A', 'D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_sort text default 'flights',
  p_page integer default 1,
  p_page_size integer default 50,
  p_data_as_of timestamptz default now()
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_result jsonb;
  v_snapshot_as_of timestamptz;
  v_effective_as_of timestamptz;
begin
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then raise exception 'invalid date range' using errcode = '22023'; end if;
  if p_dimension not in ('route', 'country', 'airline') then raise exception 'invalid dimension' using errcode = '22023'; end if;
  if p_types <@ array['A', 'D']::text[] is not true or cardinality(p_types) = 0 then raise exception 'invalid types' using errcode = '22023'; end if;
  if p_sort not in ('flights', 'reported_pax', 'flight_share', 'pax_share', 'label') then raise exception 'invalid sort' using errcode = '22023'; end if;
  if p_page < 1 or p_page_size < 1 or p_page_size > 732 then raise exception 'invalid page' using errcode = '22023'; end if;
  if cardinality(p_airlines) > 24 or cardinality(p_routes) > 24 or cardinality(p_countries) > 24 then raise exception 'filter cardinality exceeds 24' using errcode = '54000'; end if;

  select max(snapshot_refreshed_at) into v_snapshot_as_of
  from reporting.public_traffic_effective;
  v_effective_as_of := case
    when v_snapshot_as_of is null then coalesce(p_data_as_of, now())
    else least(coalesce(p_data_as_of, v_snapshot_as_of), v_snapshot_as_of)
  end;

  with filtered as materialized (
    select operations.*
    from reporting.public_traffic_effective operations
    where operations.ops_date between p_from_date and p_to_date
      and operations.type = any(p_types)
      and (cardinality(p_airlines) = 0 or operations.airline = any(p_airlines))
      and (cardinality(p_routes) = 0 or operations.route = any(p_routes))
      and (cardinality(p_countries) = 0 or operations.country = any(p_countries))
  ), grouped as (
    select coalesce(nullif(case p_dimension when 'route' then route when 'country' then country else airline end, ''), 'Unknown') as label,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      coalesce(sum(pax) filter (
        where pax is not null
          and scheduled_local_at + interval '1 day' <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      ), 0)::bigint as reported_pax,
      count(*) filter (
        where pax is not null
          and scheduled_local_at + interval '1 day' <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as reported_legs,
      count(*) filter (
        where scheduled_local_at + interval '1 day' <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as due_legs
    from filtered
    group by coalesce(nullif(case p_dimension when 'route' then route when 'country' then country else airline end, ''), 'Unknown')
  ), totals as (
    select coalesce(sum(flights), 0)::integer as total_flights,
      coalesce(sum(reported_pax), 0)::bigint as total_reported_pax
    from grouped
  ), ordered as (
    select grouped.*, totals.total_flights, totals.total_reported_pax,
      row_number() over (order by
        case when p_sort in ('flights', 'flight_share') then flights end desc,
        case when p_sort in ('reported_pax', 'pax_share') then reported_pax end desc,
        label asc
      ) as row_number,
      count(*) over ()::integer as total_rows
    from grouped cross join totals
  ), paged as (
    select * from ordered
    where row_number > (p_page - 1) * p_page_size
      and row_number <= p_page * p_page_size
  )
  select jsonb_build_object(
    'dimension', p_dimension,
    'type', case when p_types = array['A']::text[] then 'A' when p_types = array['D']::text[] then 'D' else 'all' end,
    'page', p_page,
    'page_size', p_page_size,
    'total_rows', coalesce((select max(total_rows) from ordered), 0),
    'has_more', coalesce((select max(total_rows) from ordered), 0) > p_page * p_page_size,
    'data_as_of', v_effective_as_of,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'key', lower(replace(label, ' ', '-')),
      'label', label,
      'flights', flights,
      'arrivals', arrivals,
      'departures', departures,
      'reported_pax', case when reported_legs > 0 then reported_pax end,
      'reported_legs', reported_legs,
      'due_legs', due_legs,
      'pax_coverage_pct', case when due_legs > 0 then round(reported_legs * 100.0 / due_legs, 1) end,
      'flight_share', flights::numeric / nullif(total_flights, 0),
      'pax_share', case when reported_legs > 0 then reported_pax::numeric / nullif(total_reported_pax, 0) end,
      'suppressed', false,
      'pax_status', case when due_legs = 0 then 'not_due' when reported_legs = 0 then 'unavailable' else 'available' end
    ) order by row_number) from paged), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

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
), hour_rows as (
  select bucket_index,
    coalesce(hour_counts.arrivals, 0)::integer as arrivals,
    coalesce(hour_counts.departures, 0)::integer as departures
  from generate_series(0, (1440 / p_bucket_minutes) - 1) bucket_index
  left join hour_counts using (bucket_index)
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
    'suppressed', false
  ) order by bucket_index) from hour_rows), '[]'::jsonb)
);
$$;

create or replace function reporting.get_traffic_report_aircraft_types_v1(
  p_from_date date,
  p_to_date date,
  p_types text[] default array['A', 'D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_aircraft_groups text[] default array[]::text[],
  p_top_n integer default 10,
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
    and operations.type = any(p_types)
    and (cardinality(p_airlines) = 0 or operations.airline = any(p_airlines))
    and (cardinality(p_routes) = 0 or operations.route = any(p_routes))
    and (cardinality(p_countries) = 0 or operations.country = any(p_countries))
    and (cardinality(p_aircraft_groups) = 0 or operations.aircraft_group = any(p_aircraft_groups))
), parent_counts as (
  select coalesce(nullif(aircraft_group, ''), 'Unknown') as aircraft_group,
    count(*)::integer as flights
  from filtered
  group by coalesce(nullif(aircraft_group, ''), 'Unknown')
), ranked_parents as (
  select parent_counts.*, row_number() over (order by flights desc, aircraft_group) as group_rank
  from parent_counts
), parent_map as (
  select aircraft_group,
    case when group_rank <= least(greatest(p_top_n, 1), 20) then aircraft_group else 'Khác' end as group_label
  from ranked_parents
), final_parents as (
  select parent_map.group_label, sum(parent_counts.flights)::integer as flights
  from parent_counts
  join parent_map using (aircraft_group)
  group by parent_map.group_label
), children as (
  select parent_map.group_label,
    coalesce(nullif(upper(btrim(filtered.aircraft_type)), ''), 'Unknown') as aircraft_type,
    count(*)::integer as flights,
    count(*) filter (where filtered.type = 'A')::integer as arrivals,
    count(*) filter (where filtered.type = 'D')::integer as departures,
    coalesce(sum(filtered.pax) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs
  from filtered
  join parent_map on parent_map.aircraft_group = coalesce(nullif(filtered.aircraft_group, ''), 'Unknown')
  where parent_map.group_label <> 'Khác'
  group by parent_map.group_label, coalesce(nullif(upper(btrim(filtered.aircraft_type)), ''), 'Unknown')
)
select coalesce(jsonb_agg(jsonb_build_object(
  'key', lower(replace(children.group_label || '-' || children.aircraft_type, ' ', '-')),
  'aircraft_group_key', lower(replace(children.group_label, ' ', '-')),
  'aircraft_group', children.group_label,
  'label', children.aircraft_type,
  'flights', children.flights,
  'arrivals', children.arrivals,
  'departures', children.departures,
  'reported_pax', case when children.reported_legs > 0 then children.reported_pax end,
  'share', children.flights::numeric / nullif(final_parents.flights, 0),
  'suppressed', false
) order by final_parents.flights desc, children.group_label, children.flights desc, children.aircraft_type), '[]'::jsonb)
from children
join final_parents on final_parents.group_label = children.group_label;
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
set statement_timeout = '9s'
as $$
declare
  v_result jsonb;
  v_state reporting.public_traffic_projection_state%rowtype;
  v_current_version integer;
  v_current_watermark bigint;
  v_effective_status text;
  v_data_as_of timestamptz;
  v_current_from date;
  v_current_to date;
  v_comparison_from date;
  v_comparison_to date;
  v_presence jsonb;
  v_types text[];
  v_airlines text[];
  v_routes text[];
  v_countries text[];
  v_aircraft_groups text[];
  v_filter_options jsonb;
begin
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_types from unnest(coalesce(p_types, array[]::text[])) value where btrim(value) <> '';
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_airlines from unnest(coalesce(p_airlines, array[]::text[])) value where btrim(value) <> '';
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_routes from unnest(coalesce(p_routes, array[]::text[])) value where btrim(value) <> '';
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), array[]::text[])
    into v_countries from unnest(coalesce(p_countries, array[]::text[])) value where btrim(value) <> '';
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), array[]::text[])
    into v_aircraft_groups from unnest(coalesce(p_aircraft_groups, array[]::text[])) value where btrim(value) <> '';

  v_result := public.get_public_traffic_report_overview_canonical_base_v1(
    p_from_date, p_to_date, v_types, v_airlines, v_routes, v_countries,
    v_aircraft_groups, p_comparison, p_time_basis, p_timeline_after,
    p_timeline_page_size, p_contract_version
  );

  v_data_as_of := (v_result->>'data_as_of')::timestamptz;
  v_current_from := (v_result#>>'{metadata,normalized_filter,from}')::date;
  v_current_to := (v_result#>>'{metadata,normalized_filter,to}')::date;
  v_presence := reporting.get_traffic_report_pax_presence_v1(
    v_current_from, v_current_to, v_types, v_airlines, v_routes,
    v_countries, v_aircraft_groups, v_data_as_of
  );
  v_result := jsonb_set(v_result, '{kpis,current,flights}', to_jsonb((v_presence->>'flights')::integer), true);
  v_result := jsonb_set(v_result, '{kpis,current,arrivals}', to_jsonb((v_presence->>'arrival_flights')::integer), true);
  v_result := jsonb_set(v_result, '{kpis,current,departures}', to_jsonb((v_presence->>'departure_flights')::integer), true);
  v_result := jsonb_set(v_result, '{kpis,current,reported_pax}', case when (v_presence->>'reported_legs')::integer > 0 then to_jsonb((v_presence->>'reported_pax')::bigint) else 'null'::jsonb end, true);
  v_result := jsonb_set(v_result, '{kpis,current,arrival_reported_pax}', case when (v_presence->>'arrival_reported_legs')::integer > 0 then to_jsonb((v_presence->>'arrival_reported_pax')::bigint) else 'null'::jsonb end, true);
  v_result := jsonb_set(v_result, '{kpis,current,departure_reported_pax}', case when (v_presence->>'departure_reported_legs')::integer > 0 then to_jsonb((v_presence->>'departure_reported_pax')::bigint) else 'null'::jsonb end, true);

  v_comparison_from := nullif(v_result#>>'{kpis,comparison,from}', '')::date;
  v_comparison_to := nullif(v_result#>>'{kpis,comparison,to}', '')::date;
  if v_comparison_from is not null and v_comparison_to is not null then
    v_presence := reporting.get_traffic_report_pax_presence_v1(
      v_comparison_from, v_comparison_to, v_types, v_airlines, v_routes,
      v_countries, v_aircraft_groups, v_data_as_of
    );
    v_result := jsonb_set(v_result, '{kpis,comparison,flights}', to_jsonb((v_presence->>'flights')::integer), true);
    v_result := jsonb_set(v_result, '{kpis,comparison,arrivals}', to_jsonb((v_presence->>'arrival_flights')::integer), true);
    v_result := jsonb_set(v_result, '{kpis,comparison,departures}', to_jsonb((v_presence->>'departure_flights')::integer), true);
    v_result := jsonb_set(v_result, '{kpis,comparison,reported_pax}', case when (v_presence->>'reported_legs')::integer > 0 then to_jsonb((v_presence->>'reported_pax')::bigint) else 'null'::jsonb end, true);
    v_result := jsonb_set(v_result, '{kpis,comparison,arrival_reported_pax}', case when (v_presence->>'arrival_reported_legs')::integer > 0 then to_jsonb((v_presence->>'arrival_reported_pax')::bigint) else 'null'::jsonb end, true);
    v_result := jsonb_set(v_result, '{kpis,comparison,departure_reported_pax}', case when (v_presence->>'departure_reported_legs')::integer > 0 then to_jsonb((v_presence->>'departure_reported_pax')::bigint) else 'null'::jsonb end, true);
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute attributes
    where attributes.attrelid = to_regclass('reporting.public_traffic_effective')
      and attributes.attname = 'aircraft_type'
      and attributes.attnum > 0
      and not attributes.attisdropped
  ) then
    v_result := jsonb_set(v_result, '{breakdowns,aircraft_type}',
      reporting.get_traffic_report_aircraft_types_v1(
        v_current_from, v_current_to, v_types, v_airlines, v_routes,
        v_countries, v_aircraft_groups, 10, v_data_as_of
      ), true);
  else
    v_result := jsonb_set(v_result, '{breakdowns,aircraft_type}', '[]'::jsonb, true);
  end if;

  select jsonb_build_object(
    'airline', coalesce((select jsonb_agg(label order by label) from (
      select distinct airline as label from reporting.public_traffic_effective where airline <> '' order by airline limit 250
    ) options), '[]'::jsonb),
    'route', coalesce((select jsonb_agg(label order by label) from (
      select distinct route as label from reporting.public_traffic_effective where route <> '' order by route limit 250
    ) options), '[]'::jsonb),
    'country', coalesce((select jsonb_agg(label order by label) from (
      select distinct country as label from reporting.public_traffic_effective where country <> '' order by country limit 250
    ) options), '[]'::jsonb)
  ) into v_filter_options;
  v_result := jsonb_set(v_result, '{metadata,filter_options}', v_filter_options, true);
  v_result := jsonb_set(v_result, '{metadata,suppression_policy}', jsonb_build_object('threshold', 0, 'applied', false), true);

  select * into v_state
  from reporting.public_traffic_projection_state
  where projection_name = 'public_traffic_effective';
  select max(data_version) into v_current_version from public.seasons;
  select max(server_seq)::bigint into v_current_watermark from public.season_change_events;
  v_effective_status := case
    when v_state.projection_name is null then 'stale'
    when v_state.status <> 'fresh' then v_state.status
    when v_state.snapshot_rows = 0 then 'empty'
    when v_state.source_watermark is distinct from v_current_watermark then 'stale'
    else 'fresh'
  end;

  return jsonb_set(v_result, '{metadata,projection}', jsonb_build_object(
    'status', v_effective_status,
    'source_data_version', v_state.source_data_version,
    'current_data_version', v_current_version,
    'source_watermark', v_state.source_watermark,
    'current_watermark', v_current_watermark,
    'refreshed_at', v_state.refreshed_at,
    'snapshot_rows', v_state.snapshot_rows
  ), true);
end;
$$;

alter function reporting.get_traffic_report_kpis(date, date, jsonb, text, timestamptz) owner to postgres;
alter function reporting.get_traffic_report_timeline_v2(date, date, date, date, text, date, integer, jsonb, timestamptz) owner to postgres;
alter function reporting.get_traffic_report_monthly_peaks_v2(date, date, jsonb, text) owner to postgres;
alter function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) owner to postgres;
alter function reporting.get_traffic_report_aircraft_types_v1(date, date, text[], text[], text[], text[], text[], integer, timestamptz) owner to postgres;
alter function public.get_public_traffic_report_dimension_v2(date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz) owner to postgres;
alter function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) owner to postgres;

revoke execute on function reporting.get_traffic_report_kpis(date, date, jsonb, text, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_timeline_v2(date, date, date, date, text, date, integer, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_monthly_peaks_v2(date, date, jsonb, text) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_aircraft_types_v1(date, date, text[], text[], text[], text[], text[], integer, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.get_public_traffic_report_dimension_v2(date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_dimension_v2(date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz) to service_role;
grant execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) to service_role;

comment on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text)
  is 'Public unauthenticated report aggregate contract. Suppression is disabled; raw flight rows remain inaccessible.';
