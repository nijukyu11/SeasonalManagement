create schema if not exists reporting;

create index if not exists season_change_events_reporting_target_idx
  on public.season_change_events (season_id, target_id, server_seq desc);

create index if not exists season_change_events_reporting_import_idx
  on public.season_change_events (season_id, target_type, server_seq desc);

do $drop_effective$
declare
  v_relkind "char";
begin
  select relkind into v_relkind
  from pg_catalog.pg_class
  where oid = to_regclass('reporting.public_traffic_effective');
  if v_relkind = 'm' then
    execute 'drop materialized view reporting.public_traffic_effective cascade';
  elsif v_relkind = 'v' then
    execute 'drop view reporting.public_traffic_effective cascade';
  end if;
end;
$drop_effective$;
drop view if exists reporting.public_traffic_duplicate_quarantine cascade;
drop view if exists reporting.public_traffic_ranked_candidates cascade;
drop view if exists reporting.public_traffic_candidates cascade;

create view reporting.public_traffic_candidates
with (security_invoker = true)
as
with source_rows as (
  select
    r.season_id,
    r.record_id,
    r.type,
    r.airline,
    r.flight_number,
    r.route,
    r.aircraft,
    r.pax,
    coalesce(nullif(r.scheduled_date, ''), nullif(r.date, ''), '') as scheduled_date,
    case when 'schedule' = any(coalesce(m.changed_fields, array[]::text[])) then coalesce(m.schedule, '') else coalesce(r.schedule, '') end as scheduled_time,
    case when 'route' = any(coalesce(m.changed_fields, array[]::text[])) then coalesce(m.route, '') else coalesce(r.route, '') end as effective_route,
    case when 'aircraft' = any(coalesce(m.changed_fields, array[]::text[])) then coalesce(m.aircraft, '') else coalesce(r.aircraft, '') end as effective_aircraft,
    case when 'pax' = any(coalesce(m.changed_fields, array[]::text[])) then m.pax else r.pax end as effective_pax,
    coalesce(m.action, case when r.status = 'deleted' then 'deleted' else 'active' end) as effective_action
  from public.season_flight_records r
  left join public.season_modifications m
    on m.season_id = r.season_id and m.leg_id = r.record_id

  union all

  select
    a.season_id,
    a.record_id,
    a.type,
    a.airline,
    a.flight_number,
    a.route,
    a.aircraft,
    a.pax,
    coalesce(nullif(a.scheduled_date, ''), nullif(a.date, ''), '') as scheduled_date,
    coalesce(a.schedule, '') as scheduled_time,
    coalesce(a.route, '') as effective_route,
    coalesce(a.aircraft, '') as effective_aircraft,
    a.pax as effective_pax,
    case when a.status = 'deleted' then 'deleted' else m.action end as effective_action
  from public.season_modification_added_legs a
  join public.season_modifications m
    on m.season_id = a.season_id and m.leg_id = a.leg_id and m.action in ('added', 'deleted')
), parsed as (
  select
    source_rows.*,
    case when scheduled_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then scheduled_date::date end as scheduled_date_value,
    case
      when scheduled_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
        then split_part(scheduled_time, ':', 1)::integer * 60
          + substring(scheduled_time from '^[0-9]{1,2}:([0-9]{2})')::integer
    end as local_minutes
  from source_rows
), entity_recency as materialized (
  select season_id, target_id, max(server_seq)::bigint as server_seq
  from public.season_change_events
  where target_id is not null
  group by season_id, target_id
), import_recency as materialized (
  select season_id, max(server_seq)::bigint as server_seq
  from public.season_change_events
  where target_type = 'seasonImport'
  group by season_id
), recency as (
  select
    parsed.*,
    coalesce(entity_recency.server_seq, import_recency.server_seq) as authoritative_server_seq
  from parsed
  left join entity_recency
    on entity_recency.season_id = parsed.season_id and entity_recency.target_id = parsed.record_id
  left join import_recency
    on import_recency.season_id = parsed.season_id
)
select
  recency.*,
  case
    when scheduled_date_value is null then null::date
    when local_minutes is not null and local_minutes < 300 then scheduled_date_value - 1
    else scheduled_date_value
  end as ops_date,
  case
    when scheduled_date_value is null or local_minutes is null then null::timestamp
    else scheduled_date_value::timestamp + make_interval(mins => local_minutes)
  end as scheduled_local_at,
  upper(btrim(type)) || chr(31) || scheduled_date || chr(31)
    || upper(btrim(airline)) || chr(31) || upper(btrim(flight_number)) as business_leg_key
from recency;

create view reporting.public_traffic_ranked_candidates
with (security_invoker = true)
as
select
  candidates.*,
  count(*) over (partition by business_leg_key) as candidate_count,
  count(*) filter (where authoritative_server_seq is null) over (partition by business_leg_key) as missing_recency_count,
  count(*) filter (
    where authoritative_server_seq = max_authoritative_server_seq
  ) over (partition by business_leg_key) as max_recency_count,
  row_number() over (
    partition by business_leg_key
    order by authoritative_server_seq desc nulls last, season_id, record_id
  ) as candidate_rank
from (
  select
    candidates.*,
    max(authoritative_server_seq) over (partition by business_leg_key) as max_authoritative_server_seq
  from reporting.public_traffic_candidates candidates
  where ops_date is not null
) candidates;

create view reporting.public_traffic_duplicate_quarantine
with (security_invoker = true)
as
select
  business_leg_key,
  count(*)::integer as candidate_count,
  case
    when max(missing_recency_count) > 0 then 'missing_authoritative_recency'
    else 'tied_authoritative_recency'
  end as reason
from reporting.public_traffic_ranked_candidates
where candidate_count > 1
  and (missing_recency_count > 0 or max_recency_count > 1)
group by business_leg_key;

create materialized view reporting.public_traffic_effective as
select
  ranked.business_leg_key,
  ranked.ops_date,
  ranked.type,
  upper(btrim(ranked.airline)) as airline,
  upper(btrim(ranked.effective_route)) as route,
  coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
  coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown') as aircraft_group,
  ranked.local_minutes,
  (ranked.local_minutes + 1020) % 1440 as utc_minutes,
  ranked.scheduled_local_at,
  ranked.effective_pax as pax,
  case when ranked.effective_pax > 0 then 'reported' else 'unknown' end as pax_status,
  ranked.authoritative_server_seq,
  statement_timestamp() as snapshot_refreshed_at,
  (select max(events.server_seq)::bigint from public.season_change_events events) as snapshot_source_watermark,
  (select coalesce(sum(quarantine.candidate_count), 0)::integer
    from reporting.public_traffic_duplicate_quarantine quarantine) as snapshot_quarantined_candidate_count
from reporting.public_traffic_ranked_candidates ranked
left join public.operational_route_countries countries
  on upper(countries.route) = upper(ranked.effective_route)
left join lateral (
  select aircraft_groups.name as ac_group
  from public.operational_aircraft_group_types aircraft_types
  join public.operational_aircraft_groups aircraft_groups on aircraft_groups.id = aircraft_types.group_id
  where upper(aircraft_types.aircraft_type) = upper(ranked.effective_aircraft)
  order by aircraft_groups.name
  limit 1
) groups on true
where ranked.candidate_rank = 1
  and not (
    ranked.candidate_count > 1
    and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1)
  )
  and ranked.effective_action is distinct from 'deleted';

create unique index public_traffic_effective_business_leg_idx
  on reporting.public_traffic_effective (business_leg_key);
create index public_traffic_effective_ops_date_idx
  on reporting.public_traffic_effective (ops_date);
create index public_traffic_effective_airline_ops_idx
  on reporting.public_traffic_effective (airline, ops_date);
create index public_traffic_effective_route_ops_idx
  on reporting.public_traffic_effective (route, ops_date);
create index public_traffic_effective_country_ops_idx
  on reporting.public_traffic_effective (country, ops_date);
create index public_traffic_effective_aircraft_group_ops_idx
  on reporting.public_traffic_effective (aircraft_group, ops_date);

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
  select
    period,
    count(*)::integer as flights,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    coalesce(sum(pax) filter (where pax_status = 'reported'), 0)::bigint as reported_pax,
    count(*) filter (where scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::integer as due_legs,
    count(*) filter (where pax_status = 'reported' and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::integer as reported_legs
  from scoped
  group by period
), daily as (
  select ops_date, count(*)::integer as flights
  from scoped where period = 'current'
  group by ops_date
  having count(*) >= 3
  order by flights desc, ops_date
  limit 1
), quality as (
  select
    count(*) filter (where country = 'Unknown')::integer as unknown_country,
    count(*) filter (
      where pax_status <> 'reported'
        and scheduled_local_at + interval '1 day' <= p_data_as_of at time zone 'Asia/Ho_Chi_Minh'
    )::integer as pax_due_missing
  from scoped where period = 'current'
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
    'flights', case when current_totals.flights >= 3 then current_totals.flights end,
    'arrivals', case when current_totals.flights >= 3 and current_totals.arrivals not between 1 and 2 and current_totals.departures not between 1 and 2 then current_totals.arrivals end,
    'departures', case when current_totals.flights >= 3 and current_totals.arrivals not between 1 and 2 and current_totals.departures not between 1 and 2 then current_totals.departures end,
    'reported_pax', case when current_totals.flights >= 3 and current_totals.reported_legs not between 1 and 2 then current_totals.reported_pax end,
    'status', case when current_totals.flights >= 3 then 'complete' else 'suppressed' end
  ),
  'comparison', jsonb_build_object(
    'from', comparison_range.from_date,
    'to', comparison_range.to_date,
    'mode', case p_comparison when 'previous_year' then 'year_ago' when 'none' then 'none' else 'previous' end,
    'flights', case when comparison_totals.flights >= 3 then comparison_totals.flights end,
    'arrivals', case when comparison_totals.flights >= 3 and comparison_totals.arrivals not between 1 and 2 and comparison_totals.departures not between 1 and 2 then comparison_totals.arrivals end,
    'departures', case when comparison_totals.flights >= 3 and comparison_totals.arrivals not between 1 and 2 and comparison_totals.departures not between 1 and 2 then comparison_totals.departures end,
    'reported_pax', case when comparison_totals.flights >= 3 and comparison_totals.reported_legs not between 1 and 2 then comparison_totals.reported_pax end,
    'status', case
      when p_comparison = 'none' then 'unavailable'
      when comparison_range.to_date < bounds.min_date or comparison_range.from_date > bounds.max_date then 'unavailable'
      when comparison_range.from_date < bounds.min_date or comparison_range.to_date > bounds.max_date then 'partial'
      when comparison_totals.flights < 3 then 'suppressed'
      else 'complete'
    end
  ),
  'peak_day', jsonb_build_object(
    'ops_date', (select ops_date from daily),
    'flights', (select flights from daily),
    'status', case when exists(select 1 from daily) then 'available' else 'suppressed' end
  ),
  'pax_coverage', jsonb_build_object(
    'reported_legs', case when current_totals.due_legs >= 3 then current_totals.reported_legs end,
    'due_legs', case when current_totals.due_legs >= 3 then current_totals.due_legs end,
    'percent', case when current_totals.due_legs >= 3 then round(current_totals.reported_legs * 100.0 / nullif(current_totals.due_legs, 0), 1) end,
    'status', case when current_totals.due_legs >= 3 then 'available' else 'suppressed' end
  ),
  'quality', jsonb_build_object(
    'unknown_country_legs', case when quality.unknown_country = 0 or quality.unknown_country >= 3 then quality.unknown_country end,
    'pax_due_missing_legs', case when quality.pax_due_missing = 0 or quality.pax_due_missing >= 3 then quality.pax_due_missing end,
    'quarantined_duplicate_candidates', case when quarantine.candidates = 0 or quarantine.candidates >= 3 then quarantine.candidates end
  )
)
from bounds, comparison_range, current_totals, comparison_totals, quality, quarantine;
$$;

create or replace function reporting.get_traffic_report_timeline(
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
set statement_timeout = '5s'
as $$
with requested as (
  select greatest(p_from_date, coalesce(p_window_from, p_from_date), coalesce(p_after_date + 1, p_from_date)) as page_from,
    least(p_to_date, coalesce(p_window_to, p_to_date)) as requested_to
), page as (
  select page_from, least(requested_to, page_from + least(greatest(p_page_size, 1), 732) - 1) as page_to, requested_to
  from requested
), spine as (
  select generate_series(page.page_from, page.page_to, interval '1 day')::date as ops_date
  from page
), grouped as (
  select operations.ops_date,
    count(*)::integer as flights,
    count(*) filter (where operations.type = 'A')::integer as arrivals,
    count(*) filter (where operations.type = 'D')::integer as departures,
    coalesce(sum(operations.pax) filter (where operations.pax_status = 'reported'), 0)::bigint as reported_pax,
    count(*) filter (where operations.pax_status = 'reported')::integer as reported_legs
  from reporting.public_traffic_effective operations, page
  where operations.ops_date between page.page_from and page.page_to
    and (not p_filters ? 'types' or operations.type in (select jsonb_array_elements_text(p_filters->'types')))
    and (not p_filters ? 'airlines' or operations.airline in (select jsonb_array_elements_text(p_filters->'airlines')))
    and (not p_filters ? 'routes' or operations.route in (select jsonb_array_elements_text(p_filters->'routes')))
    and (not p_filters ? 'countries' or operations.country in (select jsonb_array_elements_text(p_filters->'countries')))
    and (not p_filters ? 'aircraft_groups' or operations.aircraft_group in (select jsonb_array_elements_text(p_filters->'aircraft_groups')))
  group by operations.ops_date
), joined as (
  select spine.ops_date,
    coalesce(grouped.flights, 0) as flights,
    coalesce(grouped.arrivals, 0) as arrivals,
    coalesce(grouped.departures, 0) as departures,
    coalesce(grouped.reported_pax, 0) as reported_pax,
    coalesce(grouped.reported_legs, 0) as reported_legs
  from spine left join grouped using (ops_date)
), stats as (
  select count(*) filter (where flights between 1 and 2)::integer as small_cells from joined
), marked as (
  select joined.*,
    case
      when flights between 1 and 2 then true
      when stats.small_cells = 1 and flights >= 3 and row_number() over (partition by (flights >= 3) order by flights, ops_date) = 1 then true
      else false
    end as suppressed
  from joined cross join stats
)
select jsonb_build_object(
  'page_from', page.page_from,
  'page_to', page.page_to,
  'has_more', page.page_to < page.requested_to,
  'next_cursor', case when page.page_to < page.requested_to then page.page_to::text end,
  'granularity', p_granularity,
  'series', coalesce(jsonb_agg(jsonb_build_object(
    'ops_date', marked.ops_date,
    'flights', case when not marked.suppressed then marked.flights end,
    'arrivals', case when not marked.suppressed and marked.arrivals not between 1 and 2 and marked.departures not between 1 and 2 then marked.arrivals end,
    'departures', case when not marked.suppressed and marked.arrivals not between 1 and 2 and marked.departures not between 1 and 2 then marked.departures end,
    'reported_pax', case when not marked.suppressed and marked.reported_legs not between 1 and 2 then marked.reported_pax end,
    'suppressed', marked.suppressed,
    'status', case
      when marked.suppressed then 'suppressed'
      when marked.ops_date > ((p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - case when (p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::time < time '05:00' then 1 else 0 end) then 'future'
      when marked.ops_date = ((p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - case when (p_data_as_of at time zone 'Asia/Ho_Chi_Minh')::time < time '05:00' then 1 else 0 end) then 'partial'
      when marked.flights = 0 then 'zero'
      else 'complete'
    end,
    'completeness', case when marked.suppressed then 'partial' when marked.flights = 0 then 'complete' else 'complete' end
  ) order by marked.ops_date), '[]'::jsonb)
)
from page left join marked on true
group by page.page_from, page.page_to, page.requested_to;
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
), hours as (
  select
    case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end as bucket_index,
    count(*) filter (where type = 'A')::integer as arrivals,
    count(*) filter (where type = 'D')::integer as departures,
    count(*)::integer as flights
  from filtered
  where (case when p_time_basis = 'utc' then utc_minutes else local_minutes end) is not null
  group by case when p_time_basis = 'utc' then utc_minutes / p_bucket_minutes else local_minutes / p_bucket_minutes end
), hour_stats as (
  select count(*) filter (where flights between 1 and 2 or arrivals between 1 and 2 or departures between 1 and 2)::integer as small_count from hours
), hour_rows as (
  select hours.*,
    flights between 1 and 2 or arrivals between 1 and 2 or departures between 1 and 2
      or (hour_stats.small_count = 1 and flights >= 3 and row_number() over (partition by flights >= 3 order by flights, bucket_index) = 1) as suppressed
  from hours cross join hour_stats
)
select jsonb_build_object(
  'airline', coalesce((select rows from dimension_json where dimension = 'airline'), '[]'::jsonb),
  'route', coalesce((select rows from dimension_json where dimension = 'route'), '[]'::jsonb),
  'country', coalesce((select rows from dimension_json where dimension = 'country'), '[]'::jsonb),
  'aircraft_group', coalesce((select rows from dimension_json where dimension = 'aircraft_group'), '[]'::jsonb),
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

revoke all on reporting.public_traffic_candidates from public, anon, authenticated;
revoke all on reporting.public_traffic_ranked_candidates from public, anon, authenticated;
revoke all on reporting.public_traffic_duplicate_quarantine from public, anon, authenticated;
revoke all on reporting.public_traffic_effective from public, anon, authenticated;
revoke execute on function reporting.get_traffic_report_kpis(date, date, jsonb, text, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_timeline(date, date, date, date, text, date, integer, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) from public, anon, authenticated;

alter function reporting.get_traffic_report_kpis(date, date, jsonb, text, timestamptz) owner to postgres;
alter function reporting.get_traffic_report_timeline(date, date, date, date, text, date, integer, jsonb, timestamptz) owner to postgres;
alter function reporting.get_traffic_report_breakdowns(date, date, jsonb, integer, text, integer, timestamptz) owner to postgres;
alter function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) owner to postgres;

grant usage on schema reporting to service_role;
grant execute on function public.get_public_traffic_report_overview_v1(date, date, text[], text[], text[], text[], text[], text, text, date, integer, text) to service_role;
