-- Expose a privacy-safe, filter-aware aircraft-type breakdown without replacing
-- the public materialized view. Metrics always come from the published snapshot.
-- The canonical application migration captures aircraft_type in that snapshot;
-- this report migration never joins live source rows ahead of the published data.

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute attributes
    where attributes.attrelid = to_regclass('reporting.public_traffic_effective')
      and attributes.attname = 'aircraft_type'
      and attributes.attnum > 0
      and not attributes.attisdropped
  ) then
    raise exception 'apply main migration 20260830193000_public_traffic_aircraft_type_snapshot.sql before the report aircraft-type contract';
  end if;
end;
$$;

-- Keep every overview breakdown on the same Pax contract as the timeline and
-- detailed dimension RPC: only due T+1, non-NULL Pax is reported. A truthful
-- zero is publishable once at least three due legs have reported Pax; no
-- reported legs remains NULL instead of being presented as zero passengers.
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
with scope as (
  select not (p_filters ? 'types')
    or ((p_filters->'types') ? 'A' and (p_filters->'types') ? 'D') as all_types
), filtered as materialized (
  select operations.*
  from reporting.public_traffic_effective operations
  where operations.ops_date between p_from_date and p_to_date
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
), expanded as (
  select dimension, label, type, pax, scheduled_local_at
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
    coalesce(sum(pax) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where pax is not null
        and scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs,
    count(*) filter (
      where type = 'A' and pax is not null
        and scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as arrival_reported_legs,
    count(*) filter (
      where type = 'D' and pax is not null
        and scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as departure_reported_legs
  from expanded
  group by dimension, coalesce(nullif(label, ''), 'Unknown')
), privacy_bucketed as (
  select dimension, case when flights < 3 then 'Khác' else label end as label,
    sum(flights)::integer as flights, sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures, sum(reported_pax)::bigint as reported_pax,
    sum(reported_legs)::integer as reported_legs,
    sum(arrival_reported_legs)::integer as arrival_reported_legs,
    sum(departure_reported_legs)::integer as departure_reported_legs
  from grouped
  group by dimension, case when flights < 3 then 'Khác' else label end
), ranked as (
  select privacy_bucketed.*,
    row_number() over (partition by dimension order by flights desc, label) as rank
  from privacy_bucketed
), top_bucketed as (
  select dimension,
    case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end as label,
    sum(flights)::integer as flights, sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures, sum(reported_pax)::bigint as reported_pax,
    sum(reported_legs)::integer as reported_legs,
    sum(arrival_reported_legs)::integer as arrival_reported_legs,
    sum(departure_reported_legs)::integer as departure_reported_legs
  from ranked
  group by dimension,
    case when rank <= least(greatest(p_top_n, 1), 20) then label else 'Khác' end
), dimension_totals as (
  select dimension, sum(flights)::integer as total
  from top_bucketed
  group by dimension
), dimension_flight_marked as (
  select top_bucketed.*, dimension_totals.total,
    top_bucketed.flights between 1 and 2
      or (
        scope.all_types
        and (
          top_bucketed.arrivals between 1 and 2
          or top_bucketed.departures between 1 and 2
        )
      ) as small
  from top_bucketed
  join dimension_totals using (dimension)
  cross join scope
), dimension_marked as (
  select dimension_flight_marked.*,
    count(*) filter (where small) over (partition by dimension) as small_count,
    row_number() over (
      partition by dimension
      order by case when not small and flights >= 3 then 0 else 1 end,
        flights, label
    ) as visible_rank
  from dimension_flight_marked
), dimension_rows as (
  select dimension_marked.*,
    small
      or (
        small_count = 1
        and not small
        and flights >= 3
        and visible_rank = 1
      ) as suppressed
  from dimension_marked
), dimension_pax_marked as (
  select dimension_rows.*,
    reported_legs between 1 and 2
      or (
        scope.all_types
        and (
          arrival_reported_legs between 1 and 2
          or departure_reported_legs between 1 and 2
        )
      ) as pax_primary
  from dimension_rows cross join scope
), dimension_pax_ranked as (
  select dimension_pax_marked.*,
    count(*) filter (where pax_primary)
      over (partition by dimension) as pax_small_count,
    row_number() over (
      partition by dimension
      order by case when not suppressed and not pax_primary and reported_legs >= 3 then 0 else 1 end,
        flights, label
    ) as pax_visible_rank
  from dimension_pax_marked
), dimension_publishable as (
  select dimension_pax_ranked.*,
    pax_primary
      or (
        pax_small_count = 1
        and not suppressed
        and not pax_primary
        and reported_legs >= 3
        and pax_visible_rank = 1
      ) as pax_suppressed
  from dimension_pax_ranked
), dimension_json as (
  select dimension, jsonb_agg(jsonb_build_object(
    'key', lower(replace(label, ' ', '-')),
    'label', label,
    'flights', case when not suppressed then flights end,
    'arrivals', case when not suppressed then arrivals end,
    'departures', case when not suppressed then departures end,
    'reported_pax', case
      when not suppressed and not pax_suppressed and reported_legs >= 3 then reported_pax
    end,
    'share', case when not suppressed then flights::numeric / nullif(total, 0) end,
    'suppressed', suppressed
  ) order by flights desc, label) as rows
  from dimension_publishable
  group by dimension
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
    'hour_bucket', lpad((bucket_index * p_bucket_minutes / 60)::text, 2, '0') || ':'
      || lpad((bucket_index * p_bucket_minutes % 60)::text, 2, '0'),
    'bucket_minutes', p_bucket_minutes,
    'time_basis', p_time_basis,
    'arrivals', case when not suppressed then arrivals end,
    'departures', case when not suppressed then departures end,
    'suppressed', suppressed
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
), raw_parents as (
  select aircraft_group, count(*)::integer as flights
  from filtered
  group by aircraft_group
), privacy_parents as (
  select case when flights < 3 then 'Khác' else aircraft_group end as group_label,
    sum(flights)::integer as flights
  from raw_parents
  group by case when flights < 3 then 'Khác' else aircraft_group end
), ranked_parents as (
  select privacy_parents.*,
    row_number() over (order by flights desc, group_label) as group_rank
  from privacy_parents
), parent_map as (
  select raw_parents.aircraft_group,
    case
      when ranked_parents.group_label = 'Khác' then 'Khác'
      when ranked_parents.group_rank <= least(greatest(p_top_n, 1), 20) then ranked_parents.group_label
      else 'Khác'
    end as group_label
  from raw_parents
  join ranked_parents
    on ranked_parents.group_label = case when raw_parents.flights < 3 then 'Khác' else raw_parents.aircraft_group end
), final_parents as (
  select parent_map.group_label, sum(raw_parents.flights)::integer as flights
  from raw_parents
  join parent_map using (aircraft_group)
  group by parent_map.group_label
), marked_parents as (
  select final_parents.*,
    final_parents.flights between 1 and 2 as small,
    count(*) filter (where final_parents.flights between 1 and 2) over () as small_count,
    row_number() over (
      partition by final_parents.flights >= 3
      order by final_parents.flights, final_parents.group_label
    ) as visible_rank
  from final_parents
), publishable_parents as (
  select marked_parents.*,
    marked_parents.small
      or (marked_parents.small_count = 1 and marked_parents.flights >= 3 and marked_parents.visible_rank = 1) as suppressed
  from marked_parents
), raw_children as (
  select parent_map.group_label,
    coalesce(nullif(upper(btrim(filtered.aircraft_type)), ''), 'Unknown') as aircraft_type,
    count(*)::integer as flights,
    count(*) filter (where filtered.type = 'A')::integer as arrivals,
    count(*) filter (where filtered.type = 'D')::integer as departures,
    coalesce(sum(filtered.pax) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs,
    count(*) filter (
      where filtered.type = 'A' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as arrival_reported_legs,
    count(*) filter (
      where filtered.type = 'D' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as departure_reported_legs
  from filtered
  join parent_map using (aircraft_group)
  where parent_map.group_label <> 'Khác'
  group by parent_map.group_label,
    coalesce(nullif(upper(btrim(filtered.aircraft_type)), ''), 'Unknown')
), privacy_children as (
  select group_label,
    case when flights < 3 then 'Khác' else aircraft_type end as aircraft_type,
    sum(flights)::integer as flights,
    sum(arrivals)::integer as arrivals,
    sum(departures)::integer as departures,
    sum(reported_pax)::bigint as reported_pax,
    sum(reported_legs)::integer as reported_legs,
    sum(arrival_reported_legs)::integer as arrival_reported_legs,
    sum(departure_reported_legs)::integer as departure_reported_legs
  from raw_children
  group by group_label, case when flights < 3 then 'Khác' else aircraft_type end
), flight_marked_children as (
  select privacy_children.*,
    privacy_children.flights between 1 and 2
      or (
        'A' = any(p_types)
        and 'D' = any(p_types)
        and (
          privacy_children.arrivals between 1 and 2
          or privacy_children.departures between 1 and 2
        )
      ) as small
  from privacy_children
), marked_children as (
  select flight_marked_children.*,
    count(*) filter (where small) over (partition by group_label) as small_count,
    row_number() over (
      partition by group_label
      order by case when not small and flights >= 3 then 0 else 1 end,
        flights, aircraft_type
    ) as visible_rank
  from flight_marked_children
), publishable_children as (
  select marked_children.*,
    publishable_parents.flights as parent_flights,
    marked_children.small
      or (
        marked_children.small_count = 1
        and not marked_children.small
        and marked_children.flights >= 3
        and marked_children.visible_rank = 1
      ) as suppressed
  from marked_children
  join publishable_parents using (group_label)
  where not publishable_parents.suppressed
), pax_marked_children as (
  select publishable_children.*,
    reported_legs between 1 and 2
      or (
        'A' = any(p_types)
        and 'D' = any(p_types)
        and (
          arrival_reported_legs between 1 and 2
          or departure_reported_legs between 1 and 2
        )
      ) as pax_primary
  from publishable_children
), pax_ranked_children as (
  select pax_marked_children.*,
    count(*) filter (where pax_primary)
      over (partition by group_label) as pax_small_count,
    row_number() over (
      partition by group_label
      order by case when not suppressed and not pax_primary and reported_legs >= 3 then 0 else 1 end,
        flights, aircraft_type
    ) as pax_visible_rank
  from pax_marked_children
), final_children as (
  select pax_ranked_children.*,
    pax_primary
      or (
        pax_small_count = 1
        and not suppressed
        and not pax_primary
        and reported_legs >= 3
        and pax_visible_rank = 1
      ) as pax_suppressed
  from pax_ranked_children
)
select coalesce(jsonb_agg(jsonb_build_object(
  'key', lower(replace(group_label || '-' || aircraft_type, ' ', '-')),
  'aircraft_group_key', lower(replace(group_label, ' ', '-')),
  'aircraft_group', group_label,
  'label', aircraft_type,
  'flights', case when not suppressed then flights end,
  'arrivals', case when not suppressed and arrivals not between 1 and 2 and departures not between 1 and 2 then arrivals end,
  'departures', case when not suppressed and arrivals not between 1 and 2 and departures not between 1 and 2 then departures end,
  'reported_pax', case
    when not suppressed and not pax_suppressed and reported_legs >= 3 then reported_pax
  end,
  'share', case when not suppressed then flights::numeric / nullif(parent_flights, 0) end,
  'suppressed', suppressed
) order by parent_flights desc, group_label, flights desc, aircraft_type), '[]'::jsonb)
from final_children;
$$;

-- Retain the operational timeline implementation as an internal base and add
-- cross-page Pax complementary suppression in an additive wrapper. Suppression
-- is calculated across the complete requested range, never only the current
-- page, so pagination cannot reveal a 1-2-leg cell by subtraction.
do $timeline_upgrade$
begin
  if to_regprocedure(
    'reporting.get_traffic_report_timeline_operational_base_v2(date,date,date,date,text,date,integer,jsonb,timestamptz)'
  ) is null then
    if to_regprocedure(
      'reporting.get_traffic_report_timeline_v2(date,date,date,date,text,date,integer,jsonb,timestamptz)'
    ) is null then
      raise exception 'reporting.get_traffic_report_timeline_v2 must exist before the Pax privacy upgrade';
    end if;
    alter function reporting.get_traffic_report_timeline_v2(
      date, date, date, date, text, date, integer, jsonb, timestamptz
    ) rename to get_traffic_report_timeline_operational_base_v2;
  end if;
end;
$timeline_upgrade$;

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
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_result jsonb;
  v_suppressed_flight_dates date[];
  v_suppressed_pax_dates date[];
begin
  v_result := reporting.get_traffic_report_timeline_operational_base_v2(
    p_from_date, p_to_date, p_window_from, p_window_to, p_granularity,
    p_after_date, p_page_size, p_filters, p_data_as_of
  );

  with scope as (
    select not (p_filters ? 'types')
      or ((p_filters->'types') ? 'A' and (p_filters->'types') ? 'D') as all_types
  ), grouped as (
    select operations.ops_date,
      count(*)::integer as flights,
      count(*) filter (where operations.type = 'A')::integer as arrival_flights,
      count(*) filter (where operations.type = 'D')::integer as departure_flights,
      count(*) filter (
        where operations.pax is not null
          and operations.scheduled_local_at + interval '1 day'
            <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as reported_legs,
      count(*) filter (
        where operations.type = 'A' and operations.pax is not null
          and operations.scheduled_local_at + interval '1 day'
            <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as arrival_reported_legs,
      count(*) filter (
        where operations.type = 'D' and operations.pax is not null
          and operations.scheduled_local_at + interval '1 day'
            <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as departure_reported_legs
    from reporting.public_traffic_effective operations
    where operations.ops_date between p_from_date and p_to_date
      and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
      and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
      and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
      and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
      and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
    group by operations.ops_date
  ), marked as (
    select grouped.*,
      flights between 1 and 2
        or (
          scope.all_types
          and (
            arrival_flights between 1 and 2
            or departure_flights between 1 and 2
          )
        ) as flight_primary,
      reported_legs between 1 and 2
        or (
          scope.all_types
          and (
            arrival_reported_legs between 1 and 2
            or departure_reported_legs between 1 and 2
          )
        ) as pax_primary
    from grouped cross join scope
  ), stats as (
    select count(*) filter (where flight_primary)::integer as flight_primary_count,
      count(*) filter (where pax_primary)::integer as pax_primary_count
    from marked
  ), flight_secondary as (
    select marked.ops_date
    from marked cross join stats
    where stats.flight_primary_count = 1
      and not marked.flight_primary
      and marked.flights >= 3
    order by marked.flights, marked.ops_date
    limit 1
  ), pax_secondary as (
    select marked.ops_date
    from marked cross join stats
    where stats.pax_primary_count = 1
      and not marked.pax_primary
      and marked.flights >= 3
      and marked.reported_legs >= 3
    order by marked.flights, marked.ops_date
    limit 1
  ), hidden_flights as (
    select ops_date from marked where flight_primary
    union all
    select ops_date from flight_secondary
  ), hidden_pax as (
    select ops_date from marked where pax_primary
    union all
    select ops_date from pax_secondary
  )
  select
    (select array_agg(ops_date order by ops_date) from hidden_flights),
    (select array_agg(ops_date order by ops_date) from hidden_pax)
  into v_suppressed_flight_dates, v_suppressed_pax_dates;

  if cardinality(coalesce(v_suppressed_flight_dates, array[]::date[])) > 0
      or cardinality(coalesce(v_suppressed_pax_dates, array[]::date[])) > 0 then
    select jsonb_set(
      v_result,
      '{series}',
      coalesce(jsonb_agg(
        case when (point->>'ops_date')::date = any(coalesce(v_suppressed_flight_dates, array[]::date[]))
          then point || jsonb_build_object(
            'flights', null,
            'arrivals', null,
            'departures', null,
            'reported_pax', null,
            'reported_legs', null,
            'pax_coverage_pct', null,
            'pax_status', 'suppressed',
            'suppressed', true,
            'status', 'suppressed'
          )
          when (point->>'ops_date')::date = any(coalesce(v_suppressed_pax_dates, array[]::date[]))
          then point || jsonb_build_object(
            'reported_pax', null,
            'reported_legs', null,
            'pax_coverage_pct', null,
            'pax_status', 'suppressed'
          )
          else point
        end order by ordinal
      ), '[]'::jsonb),
      true
    ) into v_result
    from jsonb_array_elements(coalesce(v_result->'series', '[]'::jsonb))
      with ordinality series(point, ordinal);
  end if;

  return v_result;
end;
$$;

-- Wrap the paginated dimension RPC so every page uses the snapshot cutoff and
-- the same partition-wide complementary suppression decisions.
do $dimension_upgrade$
begin
  if to_regprocedure(
    'public.get_public_traffic_report_dimension_operational_base_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz)'
  ) is null then
    if to_regprocedure(
      'public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz)'
    ) is null then
      raise exception 'public.get_public_traffic_report_dimension_v2 must exist before the privacy upgrade';
    end if;
    alter function public.get_public_traffic_report_dimension_v2(
      date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
    ) rename to get_public_traffic_report_dimension_operational_base_v2;
  end if;
end;
$dimension_upgrade$;

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
  v_suppressed_flight_labels text[];
  v_suppressed_pax_labels text[];
begin
  select max(snapshot_refreshed_at) into v_snapshot_as_of
  from reporting.public_traffic_effective;
  v_effective_as_of := case
    when v_snapshot_as_of is null then coalesce(p_data_as_of, now())
    else least(coalesce(p_data_as_of, v_snapshot_as_of), v_snapshot_as_of)
  end;

  v_result := public.get_public_traffic_report_dimension_operational_base_v2(
    p_from_date, p_to_date, p_dimension, p_types, p_airlines, p_routes,
    p_countries, p_sort, p_page, p_page_size, v_effective_as_of
  );

  with scope as (
    select 'A' = any(p_types) and 'D' = any(p_types) as all_types
  ), filtered as materialized (
    select operations.*
    from reporting.public_traffic_effective operations
    where operations.ops_date between p_from_date and p_to_date
      and operations.type = any(p_types)
      and (cardinality(p_airlines) = 0 or operations.airline = any(p_airlines))
      and (cardinality(p_routes) = 0 or operations.route = any(p_routes))
      and (cardinality(p_countries) = 0 or operations.country = any(p_countries))
  ), grouped as (
    select case p_dimension
        when 'route' then route when 'country' then country else airline
      end as label,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      count(*) filter (
        where pax is not null
          and scheduled_local_at + interval '1 day'
            <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as reported_legs,
      count(*) filter (
        where type = 'A' and pax is not null
          and scheduled_local_at + interval '1 day'
            <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as arrival_reported_legs,
      count(*) filter (
        where type = 'D' and pax is not null
          and scheduled_local_at + interval '1 day'
            <= v_effective_as_of at time zone 'Asia/Ho_Chi_Minh'
      )::integer as departure_reported_legs
    from filtered
    group by case p_dimension
      when 'route' then route when 'country' then country else airline end
  ), privacy_bucketed as (
    select case when flights < 3 then 'Khác'
        else coalesce(nullif(label, ''), 'Unknown') end as label,
      sum(flights)::integer as flights,
      sum(arrivals)::integer as arrivals,
      sum(departures)::integer as departures,
      sum(reported_legs)::integer as reported_legs,
      sum(arrival_reported_legs)::integer as arrival_reported_legs,
      sum(departure_reported_legs)::integer as departure_reported_legs
    from grouped
    group by case when flights < 3 then 'Khác'
      else coalesce(nullif(label, ''), 'Unknown') end
  ), marked as (
    select privacy_bucketed.*,
      flights between 1 and 2
        or (
          scope.all_types
          and (arrivals between 1 and 2 or departures between 1 and 2)
        ) as flight_primary,
      reported_legs between 1 and 2
        or (
          scope.all_types
          and (
            arrival_reported_legs between 1 and 2
            or departure_reported_legs between 1 and 2
          )
        ) as pax_primary
    from privacy_bucketed cross join scope
  ), stats as (
    select count(*) filter (where flight_primary)::integer as flight_primary_count,
      count(*) filter (where pax_primary)::integer as pax_primary_count
    from marked
  ), flight_secondary as (
    select marked.label
    from marked cross join stats
    where stats.flight_primary_count = 1
      and not marked.flight_primary
      and marked.flights >= 3
    order by marked.flights, marked.label
    limit 1
  ), pax_secondary as (
    select marked.label
    from marked cross join stats
    where stats.pax_primary_count = 1
      and not marked.pax_primary
      and marked.flights >= 3
      and marked.reported_legs >= 3
    order by marked.flights, marked.label
    limit 1
  ), hidden_flights as (
    select label from marked where flight_primary
    union all
    select label from flight_secondary
  ), hidden_pax as (
    select label from marked where pax_primary
    union all
    select label from pax_secondary
  )
  select
    (select array_agg(label order by label) from hidden_flights),
    (select array_agg(label order by label) from hidden_pax)
  into v_suppressed_flight_labels, v_suppressed_pax_labels;

  select jsonb_set(
    v_result,
    '{rows}',
    coalesce(jsonb_agg(
      case
        when point->>'label' = any(coalesce(v_suppressed_flight_labels, array[]::text[]))
          then point || jsonb_build_object(
            'flights', null,
            'arrivals', null,
            'departures', null,
            'reported_pax', null,
            'reported_legs', null,
            'due_legs', null,
            'pax_coverage_pct', null,
            'flight_share', null,
            'pax_share', null,
            'suppressed', true,
            'pax_status', 'suppressed'
          )
        when point->>'label' = any(coalesce(v_suppressed_pax_labels, array[]::text[]))
          then point || jsonb_build_object(
            'reported_pax', null,
            'reported_legs', null,
            'pax_coverage_pct', null,
            'pax_share', null,
            'pax_status', 'suppressed'
          )
        else point
      end order by ordinal
    ), '[]'::jsonb),
    true
  ) into v_result
  from jsonb_array_elements(coalesce(v_result->'rows', '[]'::jsonb))
    with ordinality rows(point, ordinal);

  return jsonb_set(v_result, '{data_as_of}', to_jsonb(v_effective_as_of), true);
end;
$$;

create or replace function reporting.get_traffic_report_pax_presence_v1(
  p_from_date date,
  p_to_date date,
  p_types text[] default array['A', 'D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_aircraft_groups text[] default array[]::text[],
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
), presence as (
  select
    count(*)::integer as flights,
    count(*) filter (where filtered.type = 'A')::integer as arrival_flights,
    count(*) filter (where filtered.type = 'D')::integer as departure_flights,
    count(*) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as reported_legs,
    coalesce(sum(filtered.pax) filter (
      where filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as reported_pax,
    count(*) filter (
      where filtered.type = 'A' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as arrival_reported_legs,
    coalesce(sum(filtered.pax) filter (
      where filtered.type = 'A' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as arrival_reported_pax,
    count(*) filter (
      where filtered.type = 'D' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as departure_reported_legs,
    coalesce(sum(filtered.pax) filter (
      where filtered.type = 'D' and filtered.pax is not null
        and filtered.scheduled_local_at + interval '1 day'
          <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    ), 0)::bigint as departure_reported_pax
  from filtered
)
select jsonb_build_object(
  'flights', flights,
  'arrival_flights', arrival_flights,
  'departure_flights', departure_flights,
  'reported_legs', reported_legs,
  'reported_pax', case when reported_legs > 0 then reported_pax end,
  'arrival_reported_legs', arrival_reported_legs,
  'arrival_reported_pax', case when arrival_reported_legs > 0 then arrival_reported_pax end,
  'departure_reported_legs', departure_reported_legs,
  'departure_reported_pax', case when departure_reported_legs > 0 then departure_reported_pax end
)
from presence;
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
  v_suppress_directional_flights boolean;
  v_suppress_directional_pax boolean;
begin
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_types
  from unnest(coalesce(p_types, array[]::text[])) value
  where btrim(value) <> '';
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_airlines
  from unnest(coalesce(p_airlines, array[]::text[])) value
  where btrim(value) <> '';
  select coalesce(array_agg(distinct upper(btrim(value)) order by upper(btrim(value))), array[]::text[])
    into v_routes
  from unnest(coalesce(p_routes, array[]::text[])) value
  where btrim(value) <> '';
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), array[]::text[])
    into v_countries
  from unnest(coalesce(p_countries, array[]::text[])) value
  where btrim(value) <> '';
  select coalesce(array_agg(distinct btrim(value) order by btrim(value)), array[]::text[])
    into v_aircraft_groups
  from unnest(coalesce(p_aircraft_groups, array[]::text[])) value
  where btrim(value) <> '';

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
  v_suppress_directional_flights := 'A' = any(v_types)
    and 'D' = any(v_types)
    and (
      coalesce((v_presence->>'arrival_flights')::integer, 0) between 1 and 2
      or coalesce((v_presence->>'departure_flights')::integer, 0) between 1 and 2
    );
  v_suppress_directional_pax := 'A' = any(v_types)
    and 'D' = any(v_types)
    and (
      coalesce((v_presence->>'arrival_reported_legs')::integer, 0) between 1 and 2
      or coalesce((v_presence->>'departure_reported_legs')::integer, 0) between 1 and 2
    );
  if v_suppress_directional_flights then
    v_result := jsonb_set(v_result, '{kpis,current,flights}', 'null'::jsonb, true);
    v_result := jsonb_set(v_result, '{kpis,current,arrivals}', 'null'::jsonb, true);
    v_result := jsonb_set(v_result, '{kpis,current,departures}', 'null'::jsonb, true);
    v_result := jsonb_set(v_result, '{kpis,current,status}', '"suppressed"'::jsonb, true);
  end if;
  v_result := jsonb_set(
    v_result,
    '{kpis,current,reported_pax}',
    case when not v_suppress_directional_pax
        and coalesce((v_presence->>'reported_legs')::integer, 0) >= 3
      then to_jsonb((v_presence->>'reported_pax')::bigint)
      else 'null'::jsonb
    end,
    true
  );
  v_result := jsonb_set(
    v_result,
    '{kpis,current,arrival_reported_pax}',
    case when not v_suppress_directional_pax
        and coalesce((v_presence->>'arrival_reported_legs')::integer, 0) >= 3
      then to_jsonb((v_presence->>'arrival_reported_pax')::bigint)
      else 'null'::jsonb
    end,
    true
  );
  v_result := jsonb_set(
    v_result,
    '{kpis,current,departure_reported_pax}',
    case when not v_suppress_directional_pax
        and coalesce((v_presence->>'departure_reported_legs')::integer, 0) >= 3
      then to_jsonb((v_presence->>'departure_reported_pax')::bigint)
      else 'null'::jsonb
    end,
    true
  );

  v_comparison_from := nullif(v_result#>>'{kpis,comparison,from}', '')::date;
  v_comparison_to := nullif(v_result#>>'{kpis,comparison,to}', '')::date;
  if v_comparison_from is not null and v_comparison_to is not null then
    v_presence := reporting.get_traffic_report_pax_presence_v1(
      v_comparison_from, v_comparison_to, v_types, v_airlines, v_routes,
      v_countries, v_aircraft_groups, v_data_as_of
    );
    v_suppress_directional_flights := 'A' = any(v_types)
      and 'D' = any(v_types)
      and (
        coalesce((v_presence->>'arrival_flights')::integer, 0) between 1 and 2
        or coalesce((v_presence->>'departure_flights')::integer, 0) between 1 and 2
      );
    v_suppress_directional_pax := 'A' = any(v_types)
      and 'D' = any(v_types)
      and (
        coalesce((v_presence->>'arrival_reported_legs')::integer, 0) between 1 and 2
        or coalesce((v_presence->>'departure_reported_legs')::integer, 0) between 1 and 2
      );
    if v_suppress_directional_flights then
      v_result := jsonb_set(v_result, '{kpis,comparison,flights}', 'null'::jsonb, true);
      v_result := jsonb_set(v_result, '{kpis,comparison,arrivals}', 'null'::jsonb, true);
      v_result := jsonb_set(v_result, '{kpis,comparison,departures}', 'null'::jsonb, true);
      v_result := jsonb_set(v_result, '{kpis,comparison,status}', '"suppressed"'::jsonb, true);
    end if;
    v_result := jsonb_set(
      v_result,
      '{kpis,comparison,reported_pax}',
      case when not v_suppress_directional_pax
          and coalesce((v_presence->>'reported_legs')::integer, 0) >= 3
        then to_jsonb((v_presence->>'reported_pax')::bigint)
        else 'null'::jsonb
      end,
      true
    );
    v_result := jsonb_set(
      v_result,
      '{kpis,comparison,arrival_reported_pax}',
      case when not v_suppress_directional_pax
          and coalesce((v_presence->>'arrival_reported_legs')::integer, 0) >= 3
        then to_jsonb((v_presence->>'arrival_reported_pax')::bigint)
        else 'null'::jsonb
      end,
      true
    );
    v_result := jsonb_set(
      v_result,
      '{kpis,comparison,departure_reported_pax}',
      case when not v_suppress_directional_pax
          and coalesce((v_presence->>'departure_reported_legs')::integer, 0) >= 3
        then to_jsonb((v_presence->>'departure_reported_pax')::bigint)
        else 'null'::jsonb
      end,
      true
    );
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attributes
    where attributes.attrelid = to_regclass('reporting.public_traffic_effective')
      and attributes.attname = 'aircraft_type'
      and attributes.attnum > 0
      and not attributes.attisdropped
  ) then
    v_result := jsonb_set(
      v_result,
      '{breakdowns,aircraft_type}',
      reporting.get_traffic_report_aircraft_types_v1(
        v_current_from, v_current_to, v_types, v_airlines, v_routes,
        v_countries, v_aircraft_groups, 10, v_data_as_of
      ),
      true
    );
  else
    -- The populated 16-column MV is the explicit emergency rollback target.
    -- Keep the aggregate contract callable while aircraft detail is absent.
    v_result := jsonb_set(v_result, '{breakdowns,aircraft_type}', '[]'::jsonb, true);
  end if;

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

alter function reporting.get_traffic_report_aircraft_types_v1(
  date, date, text[], text[], text[], text[], text[], integer, timestamptz
) owner to postgres;
alter function reporting.get_traffic_report_breakdowns(
  date, date, jsonb, integer, text, integer, timestamptz
) owner to postgres;
alter function reporting.get_traffic_report_pax_presence_v1(
  date, date, text[], text[], text[], text[], text[], timestamptz
) owner to postgres;
alter function reporting.get_traffic_report_timeline_operational_base_v2(
  date, date, date, date, text, date, integer, jsonb, timestamptz
) owner to postgres;
alter function reporting.get_traffic_report_timeline_v2(
  date, date, date, date, text, date, integer, jsonb, timestamptz
) owner to postgres;
alter function public.get_public_traffic_report_dimension_operational_base_v2(
  date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
) owner to postgres;
alter function public.get_public_traffic_report_dimension_v2(
  date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
) owner to postgres;
alter function public.get_public_traffic_report_overview_v1(
  date, date, text[], text[], text[], text[], text[], text, text, date, integer, text
) owner to postgres;
alter function public.get_public_traffic_report_overview_canonical_base_v1(
  date, date, text[], text[], text[], text[], text[], text, text, date, integer, text
) owner to postgres;

revoke execute on function reporting.get_traffic_report_aircraft_types_v1(
  date, date, text[], text[], text[], text[], text[], integer, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_breakdowns(
  date, date, jsonb, integer, text, integer, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_pax_presence_v1(
  date, date, text[], text[], text[], text[], text[], timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_timeline_operational_base_v2(
  date, date, date, date, text, date, integer, jsonb, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_timeline_v2(
  date, date, date, date, text, date, integer, jsonb, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function public.get_public_traffic_report_dimension_operational_base_v2(
  date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function public.get_public_traffic_report_dimension_v2(
  date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
) from public, anon, authenticated;
revoke execute on function public.get_public_traffic_report_overview_v1(
  date, date, text[], text[], text[], text[], text[], text, text, date, integer, text
) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_overview_v1(
  date, date, text[], text[], text[], text[], text[], text, text, date, integer, text
) to service_role;
grant execute on function public.get_public_traffic_report_dimension_v2(
  date, date, text, text[], text[], text[], text[], text, integer, integer, timestamptz
) to service_role;

-- The renamed implementation is an internal building block. The Edge role must
-- use the freshness-checked public wrapper above rather than bypassing it.
revoke execute on function public.get_public_traffic_report_overview_canonical_base_v1(
  date, date, text[], text[], text[], text[], text[], text, text, date, integer, text
) from public, anon, authenticated, service_role;

comment on function reporting.get_traffic_report_aircraft_types_v1(
  date, date, text[], text[], text[], text[], text[], integer, timestamptz
) is 'Actual canonical aircraft-type aggregates grouped under publishable aircraft groups.';
comment on function reporting.get_traffic_report_pax_presence_v1(
  date, date, text[], text[], text[], text[], text[], timestamptz
) is 'Distinguishes a reported Pax value of zero from missing Pax using reported-leg presence.';
