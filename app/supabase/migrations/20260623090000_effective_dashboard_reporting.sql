create schema if not exists reporting;

create index if not exists season_modifications_reporting_idx
  on public.season_modifications (season_id, leg_id, action);

create index if not exists season_modification_added_legs_reporting_idx
  on public.season_modification_added_legs (season_id, leg_id, status, type);

create index if not exists operational_aircraft_group_types_aircraft_type_idx
  on public.operational_aircraft_group_types (aircraft_type);

alter table public.operational_settings
  add column if not exists dashboard_arrival_bucket_flights integer,
  add column if not exists dashboard_departure_bucket_flights integer,
  add column if not exists dashboard_ad_gap_flights integer,
  add column if not exists dashboard_ctg_abs_pct numeric,
  add column if not exists dashboard_pax_coverage_min_pct numeric;

drop view if exists reporting.summary_arr_dep_mix cascade;
drop view if exists reporting.summary_aircraft cascade;
drop view if exists reporting.summary_peak_hour cascade;
drop view if exists reporting.summary_week cascade;
drop view if exists reporting.summary_month cascade;
drop view if exists reporting.summary_route cascade;
drop view if exists reporting.summary_country cascade;
drop view if exists reporting.summary_airline cascade;
drop view if exists reporting.flight_operations cascade;
drop view if exists reporting.effective_flight_operations cascade;

create or replace view reporting.effective_flight_operations as
with source_rows as (
  select
    'imported'::text as row_scope,
    r.season_id,
    r.record_id,
    r.flight_series_id,
    r.turnaround_id,
    r.type,
    r.flight_number,
    r.airline,
    r.route,
    r.aircraft,
    r.pax,
    r.date,
    r.scheduled_date,
    r.operational_date,
    r.schedule,
    r.status,
    r.gate,
    r.stand,
    r.carousel,
    r.source_kind,
    r.source_side,
    r.iata_season_code,
    coalesce(m.changed_fields, array[]::text[]) as changed_fields,
    m.schedule as mod_schedule,
    m.aircraft as mod_aircraft,
    m.route as mod_route,
    m.pax as mod_pax,
    m.gate as mod_gate,
    m.stand as mod_stand,
    m.carousel as mod_carousel
  from public.season_flight_records r
  left join public.season_modifications m
    on m.season_id = r.season_id
   and m.leg_id = r.record_id
   and m.action in ('modified', 'deleted')
  where r.status is distinct from 'deleted'
    and coalesce(m.action, 'modified') <> 'deleted'

  union all

  select
    'added'::text as row_scope,
    al.season_id,
    al.record_id,
    al.flight_series_id,
    al.turnaround_id,
    al.type,
    al.flight_number,
    al.airline,
    al.route,
    al.aircraft,
    al.pax,
    al.date,
    al.scheduled_date,
    al.operational_date,
    al.schedule,
    al.status,
    al.gate,
    al.stand,
    al.carousel,
    al.source_kind,
    al.source_side,
    al.iata_season_code,
    array[]::text[] as changed_fields,
    null::text as mod_schedule,
    null::text as mod_aircraft,
    null::text as mod_route,
    null::integer as mod_pax,
    null::integer as mod_gate,
    null::integer as mod_stand,
    null::integer as mod_carousel
  from public.season_modification_added_legs al
  join public.season_modifications m
    on m.season_id = al.season_id
   and m.leg_id = al.leg_id
  where m.action = 'added'
    and al.status is distinct from 'deleted'
),
effective_rows as (
  select
    sr.season_id,
    sr.record_id,
    sr.flight_series_id,
    sr.turnaround_id,
    sr.type,
    sr.flight_number as flight,
    upper(sr.airline) as airline,
    case when sr.row_scope = 'imported' and 'route' = any(sr.changed_fields) then upper(coalesce(sr.mod_route, '')) else upper(coalesce(sr.route, '')) end as route,
    case when sr.row_scope = 'imported' and 'aircraft' = any(sr.changed_fields) then upper(coalesce(sr.mod_aircraft, '')) else upper(coalesce(sr.aircraft, '')) end as aircraft,
    case when sr.row_scope = 'imported' and 'pax' = any(sr.changed_fields) then sr.mod_pax else sr.pax end as pax,
    coalesce(nullif(sr.scheduled_date, ''), nullif(sr.date, ''), '') as scheduled_date,
    case when sr.row_scope = 'imported' and 'schedule' = any(sr.changed_fields) then coalesce(sr.mod_schedule, '') else coalesce(sr.schedule, '') end as scheduled_time,
    sr.operational_date,
    coalesce(sr.status, 'active') as status,
    case when sr.row_scope = 'imported' and 'gate' = any(sr.changed_fields) then sr.mod_gate else sr.gate end as gate,
    case when sr.row_scope = 'imported' and 'stand' = any(sr.changed_fields) then sr.mod_stand else sr.stand end as stand,
    case when sr.row_scope = 'imported' and 'carousel' = any(sr.changed_fields) then sr.mod_carousel else sr.carousel end as carousel,
    sr.source_kind,
    sr.source_side,
    sr.iata_season_code
  from source_rows sr
),
parsed_rows as (
  select
    er.*,
    case
      when er.scheduled_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
        then (split_part(er.scheduled_time, ':', 1)::integer * 60) + substring(er.scheduled_time from '^[0-9]{1,2}:([0-9]{2})')::integer
      else null::integer
    end as local_minutes,
    case
      when er.scheduled_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        then to_date(er.scheduled_date, 'YYYY-MM-DD')
      else null::date
    end as scheduled_date_value
  from effective_rows er
),
dated_rows as (
  select
    pr.*,
    case when pr.local_minutes is null then null::integer else (pr.local_minutes + 1020) % 1440 end as utc_minutes,
    coalesce(
      case when pr.operational_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then pr.operational_date::date else null::date end,
      case
        when pr.scheduled_date_value is null then null::date
        when pr.local_minutes is not null and pr.local_minutes < 300 then pr.scheduled_date_value - 1
        else pr.scheduled_date_value
      end
    ) as ops_date_value,
    case
      when pr.scheduled_date_value is null or pr.local_minutes is null then null::timestamp
      else pr.scheduled_date_value::timestamp + make_interval(mins => pr.local_minutes)
    end as scheduled_local_at
  from parsed_rows pr
),
bucketed_rows as (
  select
    dr.*,
    case when dr.local_minutes is null then null::integer else (dr.local_minutes / 30)::integer end as local_bucket_30_index,
    case when dr.local_minutes is null then null::integer else (dr.local_minutes / 60)::integer end as local_bucket_60_index,
    case when dr.utc_minutes is null then null::integer else (dr.utc_minutes / 30)::integer end as utc_bucket_30_index,
    case when dr.utc_minutes is null then null::integer else (dr.utc_minutes / 60)::integer end as utc_bucket_60_index
  from dated_rows dr
)
select
  b.season_id,
  coalesce(nullif(b.iata_season_code, ''), s.season_code, '') as season,
  b.record_id,
  b.flight_series_id,
  b.turnaround_id,
  b.type,
  b.flight,
  b.airline,
  b.route,
  coalesce(rc.country, '') as country,
  b.aircraft,
  b.pax,
  b.scheduled_date,
  b.scheduled_time,
  coalesce(to_char(b.ops_date_value, 'YYYY-MM-DD'), b.scheduled_date) as ops_date,
  to_char(b.ops_date_value, 'YYYY-MM') as month,
  extract(week from b.ops_date_value)::integer as iso_week,
  case when b.local_minutes is null then null::integer else (b.local_minutes / 60)::integer end as local_hour,
  case when b.utc_minutes is null then null::integer else (b.utc_minutes / 60)::integer end as utc_hour,
  extract(dow from b.ops_date_value)::integer as weekday,
  b.status,
  b.gate,
  b.stand,
  b.carousel,
  b.source_kind,
  b.source_side,
  s.season_code,
  b.iata_season_code,
  to_char(b.ops_date_value, 'IYYY-"W"IW') as isoweek,
  extract(week from b.ops_date_value)::integer as weeknum,
  b.local_minutes,
  b.utc_minutes,
  b.local_bucket_30_index,
  case
    when b.local_bucket_30_index is null then null::text
    else lpad(((b.local_bucket_30_index * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.local_bucket_30_index * 30) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.local_bucket_30_index + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.local_bucket_30_index + 1) * 30) % 1440) % 60)::text, 2, '0')
  end as local_bucket_30,
  b.local_bucket_60_index,
  case
    when b.local_bucket_60_index is null then null::text
    else lpad(((b.local_bucket_60_index * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.local_bucket_60_index * 60) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.local_bucket_60_index + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.local_bucket_60_index + 1) * 60) % 1440) % 60)::text, 2, '0')
  end as local_bucket_60,
  b.utc_bucket_30_index,
  case
    when b.utc_bucket_30_index is null then null::text
    else lpad(((b.utc_bucket_30_index * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.utc_bucket_30_index * 30) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.utc_bucket_30_index + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.utc_bucket_30_index + 1) * 30) % 1440) % 60)::text, 2, '0')
  end as utc_bucket_30,
  b.utc_bucket_60_index,
  case
    when b.utc_bucket_60_index is null then null::text
    else lpad(((b.utc_bucket_60_index * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.utc_bucket_60_index * 60) % 60)::text, 2, '0')
      || '-'
      || lpad(((((b.utc_bucket_60_index + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.utc_bucket_60_index + 1) * 60) % 1440) % 60)::text, 2, '0')
  end as utc_bucket_60,
  (
    coalesce(b.pax, 0) = 0
    and b.scheduled_local_at is not null
    and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_at + interval '1 day'
  ) as pax_missing_after_1_day,
  case
    when coalesce(b.pax, 0) > 0 then 'reported'
    when coalesce(b.pax, 0) = 0
      and b.scheduled_local_at is not null
      and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_at + interval '1 day'
      then 'missing_after_1_day'
    else 'planned_zero'
  end as pax_status,
  coalesce(ag.ac_group, '') as ac_group
from bucketed_rows b
left join public.seasons s on s.id = b.season_id
left join public.operational_route_countries rc on upper(rc.route) = upper(b.route)
left join lateral (
  select g.name as ac_group
  from public.operational_aircraft_group_types gt
  join public.operational_aircraft_groups g on g.id = gt.group_id
  where upper(gt.aircraft_type) = upper(b.aircraft)
  order by g.name
  limit 1
) ag on true;

create or replace view reporting.flight_operations as
select * from reporting.effective_flight_operations;

create or replace view reporting.summary_airline as
select season_id, season, airline, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, airline, type;

create or replace view reporting.summary_country as
select season_id, season, country, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, country, type;

create or replace view reporting.summary_route as
select season_id, season, route, country, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, route, country, type;

create or replace view reporting.summary_month as
select season_id, season, month, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, month, type;

create or replace view reporting.summary_week as
select season_id, season, iso_week, isoweek, weeknum, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, iso_week, isoweek, weeknum, type;

create or replace view reporting.summary_peak_hour as
select
  season_id,
  season,
  local_hour,
  utc_hour,
  local_bucket_60_index,
  local_bucket_60,
  utc_bucket_60_index,
  utc_bucket_60,
  type,
  count(*)::integer as flights,
  coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, local_hour, utc_hour, local_bucket_60_index, local_bucket_60, utc_bucket_60_index, utc_bucket_60, type;

create or replace view reporting.summary_aircraft as
select season_id, season, aircraft, ac_group, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, aircraft, ac_group, type;

create or replace view reporting.summary_arr_dep_mix as
select season_id, season, type, count(*)::integer as flights, coalesce(sum(pax), 0)::integer as pax
from reporting.flight_operations
group by season_id, season, type;

create or replace function reporting.query_aggregated(
  p_filters jsonb default '{}'::jsonb,
  p_group_by text[] default array[]::text[],
  p_metrics text[] default array['flights']::text[],
  p_order_by text default 'flights',
  p_order_dir text default 'desc',
  p_limit integer default 24
) returns jsonb
language plpgsql
security invoker
set search_path = reporting, public
as $$
declare
  allowed_group_by constant text[] := array[
    'airline',
    'route',
    'country',
    'aircraft',
    'ac_group',
    'month',
    'iso_week',
    'isoweek',
    'weeknum',
    'local_hour',
    'utc_hour',
    'local_bucket_30',
    'local_bucket_30_index',
    'local_bucket_60',
    'local_bucket_60_index',
    'utc_bucket_30',
    'utc_bucket_30_index',
    'utc_bucket_60',
    'utc_bucket_60_index',
    'ops_date',
    'season',
    'gate',
    'type',
    'weekday',
    'pax_status'
  ];
  allowed_metrics constant text[] := array['flights', 'pax', 'arrivals', 'departures'];
  group_columns text[] := array[]::text[];
  metric_columns text[] := array[]::text[];
  where_clauses text[] := array['true'];
  select_parts text[] := array[]::text[];
  group_clause text := '';
  order_column text := 'flights';
  order_direction text := 'desc';
  safe_limit integer := least(greatest(coalesce(p_limit, 24), 1), 500);
  row_count integer := 0;
  result_rows jsonb := '[]'::jsonb;
  sql text;
  value_list text;
  metric text;
  column_name text;
  target_column text;
begin
  select coalesce(array_agg(distinct entry), array[]::text[])
    into group_columns
  from unnest(coalesce(p_group_by, array[]::text[])) as entry
  where entry = any(allowed_group_by);

  select coalesce(array_agg(distinct entry), array[]::text[])
    into metric_columns
  from unnest(coalesce(p_metrics, array['flights']::text[])) as entry
  where entry = any(allowed_metrics);

  if array_length(metric_columns, 1) is null then
    metric_columns := array['flights'];
  end if;

  if p_order_by = any(metric_columns) or p_order_by = any(group_columns) then
    order_column := p_order_by;
  elsif metric_columns[1] is not null then
    order_column := metric_columns[1];
  end if;

  if lower(coalesce(p_order_dir, 'desc')) = 'asc' then
    order_direction := 'asc';
  end if;

  if jsonb_typeof(p_filters->'seasonIds') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'seasonIds') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('season_id in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'iataSeasonCodes') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'iataSeasonCodes') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('(upper(season) in (%1$s) or upper(season_code) in (%1$s) or upper(iata_season_code) in (%1$s))', value_list);
    end if;
  end if;

  if p_filters ? 'dateFrom' and p_filters->>'dateFrom' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date >= %L', p_filters->>'dateFrom');
  end if;

  if p_filters ? 'dateTo' and p_filters->>'dateTo' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date <= %L', p_filters->>'dateTo');
  end if;

  if jsonb_typeof(p_filters->'months') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'months') as value
    where value ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$';
    if value_list is not null then
      where_clauses := where_clauses || format('month in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'isoweeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'isoweeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'weeknums') = 'array' then
    select string_agg(value::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeknums') as value
    where value ~ '^[0-9]{1,2}$'
      and value::integer between 1 and 53;
    if value_list is not null then
      where_clauses := where_clauses || format('weeknum in (%s)', value_list);
    end if;
  end if;

  if p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach column_name in array array[
    'airlines',
    'routes',
    'countries',
    'aircraft',
    'acGroups',
    'paxStatuses',
    'localBuckets30',
    'localBuckets60',
    'utcBuckets30',
    'utcBuckets60'
  ] loop
    if jsonb_typeof(p_filters->column_name) = 'array' then
      target_column := case column_name
        when 'airlines' then 'airline'
        when 'routes' then 'route'
        when 'countries' then 'country'
        when 'aircraft' then 'aircraft'
        when 'acGroups' then 'ac_group'
        when 'paxStatuses' then 'pax_status'
        when 'localBuckets30' then 'local_bucket_30'
        when 'localBuckets60' then 'local_bucket_60'
        when 'utcBuckets30' then 'utc_bucket_30'
        else 'utc_bucket_60'
      end;
      select string_agg(quote_literal(case when column_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
        into value_list
      from jsonb_array_elements_text(p_filters->column_name) as value
      where value <> '';
      if value_list is not null then
        where_clauses := where_clauses || format('%I in (%s)', target_column, value_list);
      end if;
    end if;
  end loop;

  if jsonb_typeof(p_filters->'localHourFrom') = 'number' then
    where_clauses := where_clauses || format('local_hour >= %s', least(greatest((p_filters->>'localHourFrom')::integer, 0), 23));
  end if;

  if jsonb_typeof(p_filters->'localHourTo') = 'number' then
    where_clauses := where_clauses || format('local_hour < %s', least(greatest((p_filters->>'localHourTo')::integer, 1), 24));
  end if;

  foreach column_name in array group_columns loop
    select_parts := select_parts || format('%I', column_name);
  end loop;

  foreach metric in array metric_columns loop
    select_parts := select_parts || case metric
      when 'flights' then 'count(*)::integer as flights'
      when 'pax' then 'coalesce(sum(pax), 0)::integer as pax'
      when 'arrivals' then 'count(*) filter (where type = ''A'')::integer as arrivals'
      when 'departures' then 'count(*) filter (where type = ''D'')::integer as departures'
    end;
  end loop;

  if array_length(group_columns, 1) is not null then
    group_clause := ' group by ' || array_to_string(array(select format('%I', entry) from unnest(group_columns) as entry), ', ');
  end if;

  if array_length(group_columns, 1) is null then
    row_count := 1;
  else
    execute format(
      'select count(*) from (select 1 from reporting.flight_operations where %s%s) grouped',
      array_to_string(where_clauses, ' and '),
      group_clause
    ) into row_count;
  end if;

  sql := format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select %s from reporting.flight_operations where %s%s order by %I %s limit %s) q',
    array_to_string(select_parts, ', '),
    array_to_string(where_clauses, ' and '),
    group_clause,
    order_column,
    order_direction,
    safe_limit
  );
  execute sql into result_rows;

  return jsonb_build_object(
    'columns', to_jsonb(group_columns || metric_columns),
    'rows', result_rows,
    'rowCount', row_count,
    'truncated', array_length(group_columns, 1) is not null and row_count > safe_limit
  );
end;
$$;

create or replace function public.dashboard_ai_query_aggregated(
  p_filters jsonb default '{}'::jsonb,
  p_group_by text[] default array[]::text[],
  p_metrics text[] default array['flights']::text[],
  p_order_by text default 'flights',
  p_order_dir text default 'desc',
  p_limit integer default 24
) returns jsonb
language sql
security invoker
set search_path = public, reporting
as $$
  select reporting.query_aggregated(
    p_filters,
    p_group_by,
    p_metrics,
    p_order_by,
    p_order_dir,
    p_limit
  );
$$;

create or replace function public.dashboard_ai_query_rows(
  p_view text default 'flight_operations',
  p_filters jsonb default '{}'::jsonb,
  p_columns text[] default array[]::text[],
  p_order_by text default 'ops_date',
  p_order_dir text default 'asc',
  p_limit integer default 100
) returns jsonb
language plpgsql
security invoker
set search_path = public, reporting
as $$
declare
  allowed_views constant text[] := array[
    'flight_operations',
    'summary_airline',
    'summary_country',
    'summary_route',
    'summary_month',
    'summary_week',
    'summary_peak_hour',
    'summary_aircraft',
    'summary_arr_dep_mix'
  ];
  allowed_columns constant text[] := array[
    'season_id',
    'season',
    'season_code',
    'iata_season_code',
    'record_id',
    'flight_series_id',
    'turnaround_id',
    'type',
    'flight',
    'airline',
    'route',
    'country',
    'aircraft',
    'ac_group',
    'pax',
    'pax_status',
    'pax_missing_after_1_day',
    'scheduled_date',
    'scheduled_time',
    'ops_date',
    'month',
    'iso_week',
    'isoweek',
    'weeknum',
    'local_hour',
    'utc_hour',
    'local_minutes',
    'utc_minutes',
    'local_bucket_30',
    'local_bucket_30_index',
    'local_bucket_60',
    'local_bucket_60_index',
    'utc_bucket_30',
    'utc_bucket_30_index',
    'utc_bucket_60',
    'utc_bucket_60_index',
    'weekday',
    'status',
    'gate',
    'stand',
    'carousel',
    'source_kind',
    'source_side',
    'flights',
    'arrivals',
    'departures'
  ];
  view_name text := case when p_view = any(allowed_views) then p_view else 'flight_operations' end;
  view_columns text[];
  selected_columns text[];
  where_clauses text[] := array['true'];
  order_column text;
  order_direction text := case when lower(coalesce(p_order_dir, 'asc')) = 'desc' then 'desc' else 'asc' end;
  safe_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  value_list text;
  filter_name text;
  target_column text;
  row_count integer := 0;
  result_rows jsonb := '[]'::jsonb;
  sql text;
begin
  select array_agg(c.column_name::text order by c.ordinal_position)
    into view_columns
  from information_schema.columns c
  where c.table_schema = 'reporting'
    and c.table_name = view_name
    and c.column_name = any(allowed_columns);

  if array_length(view_columns, 1) is null then
    return jsonb_build_object(
      'columns', '[]'::jsonb,
      'rows', '[]'::jsonb,
      'rowCount', 0,
      'truncated', false,
      'dataQualityMessages', jsonb_build_array(format('View reporting.%s has no allowed columns.', view_name))
    );
  end if;

  select coalesce(array_agg(distinct entry), array[]::text[])
    into selected_columns
  from unnest(coalesce(p_columns, array[]::text[])) as entry
  where entry = any(allowed_columns)
    and entry = any(view_columns);

  if array_length(selected_columns, 1) is null then
    selected_columns := view_columns;
  end if;

  order_column := case
    when p_order_by = any(view_columns) and p_order_by = any(allowed_columns) then p_order_by
    when 'ops_date' = any(view_columns) then 'ops_date'
    when 'flights' = any(view_columns) then 'flights'
    else selected_columns[1]
  end;

  if 'season_id' = any(view_columns) and jsonb_typeof(p_filters->'seasonIds') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'seasonIds') as value
    where value <> '';
    if value_list is not null then
      where_clauses := where_clauses || format('season_id in (%s)', value_list);
    end if;
  end if;

  if jsonb_typeof(p_filters->'iataSeasonCodes') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'iataSeasonCodes') as value
    where value <> '';
    if value_list is not null then
      if 'season' = any(view_columns) and 'season_code' = any(view_columns) and 'iata_season_code' = any(view_columns) then
        where_clauses := where_clauses || format('(upper(season) in (%1$s) or upper(season_code) in (%1$s) or upper(iata_season_code) in (%1$s))', value_list);
      elsif 'season' = any(view_columns) then
        where_clauses := where_clauses || format('upper(season) in (%s)', value_list);
      end if;
    end if;
  end if;

  if 'ops_date' = any(view_columns) and p_filters ? 'dateFrom' and p_filters->>'dateFrom' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date >= %L', p_filters->>'dateFrom');
  end if;

  if 'ops_date' = any(view_columns) and p_filters ? 'dateTo' and p_filters->>'dateTo' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
    where_clauses := where_clauses || format('ops_date <= %L', p_filters->>'dateTo');
  end if;

  if 'month' = any(view_columns) and jsonb_typeof(p_filters->'months') = 'array' then
    select string_agg(quote_literal(value), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'months') as value
    where value ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$';
    if value_list is not null then
      where_clauses := where_clauses || format('month in (%s)', value_list);
    end if;
  end if;

  if 'isoweek' = any(view_columns) and jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  elsif 'iso_week' = any(view_columns) and jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg((substring(value from 'W([0-9]{2})$'))::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('iso_week in (%s)', value_list);
    end if;
  end if;

  if 'isoweek' = any(view_columns) and jsonb_typeof(p_filters->'isoweeks') = 'array' then
    select string_agg(quote_literal(upper(value)), ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'isoweeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('isoweek in (%s)', value_list);
    end if;
  end if;

  if 'weeknum' = any(view_columns) and jsonb_typeof(p_filters->'weeknums') = 'array' then
    select string_agg(value::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeknums') as value
    where value ~ '^[0-9]{1,2}$'
      and value::integer between 1 and 53;
    if value_list is not null then
      where_clauses := where_clauses || format('weeknum in (%s)', value_list);
    end if;
  end if;

  if 'type' = any(view_columns) and p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach filter_name in array array[
    'airlines',
    'routes',
    'countries',
    'aircraft',
    'acGroups',
    'paxStatuses',
    'localBuckets30',
    'localBuckets60',
    'utcBuckets30',
    'utcBuckets60'
  ] loop
    if jsonb_typeof(p_filters->filter_name) = 'array' then
      target_column := case filter_name
        when 'airlines' then 'airline'
        when 'routes' then 'route'
        when 'countries' then 'country'
        when 'aircraft' then 'aircraft'
        when 'acGroups' then 'ac_group'
        when 'paxStatuses' then 'pax_status'
        when 'localBuckets30' then 'local_bucket_30'
        when 'localBuckets60' then 'local_bucket_60'
        when 'utcBuckets30' then 'utc_bucket_30'
        else 'utc_bucket_60'
      end;
      if target_column = any(view_columns) then
        select string_agg(quote_literal(case when filter_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
          into value_list
        from jsonb_array_elements_text(p_filters->filter_name) as value
        where value <> '';
        if value_list is not null then
          where_clauses := where_clauses || format('%I in (%s)', target_column, value_list);
        end if;
      end if;
    end if;
  end loop;

  if 'local_hour' = any(view_columns) and jsonb_typeof(p_filters->'localHourFrom') = 'number' then
    where_clauses := where_clauses || format('local_hour >= %s', least(greatest((p_filters->>'localHourFrom')::integer, 0), 23));
  end if;

  if 'local_hour' = any(view_columns) and jsonb_typeof(p_filters->'localHourTo') = 'number' then
    where_clauses := where_clauses || format('local_hour < %s', least(greatest((p_filters->>'localHourTo')::integer, 1), 24));
  end if;

  execute format(
    'select count(*) from reporting.%I where %s',
    view_name,
    array_to_string(where_clauses, ' and ')
  ) into row_count;

  sql := format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select %s from reporting.%I where %s order by %I %s limit %s) q',
    array_to_string(array(select format('%I', entry) from unnest(selected_columns) as entry), ', '),
    view_name,
    array_to_string(where_clauses, ' and '),
    order_column,
    order_direction,
    safe_limit
  );
  execute sql into result_rows;

  return jsonb_build_object(
    'columns', to_jsonb(selected_columns),
    'rows', result_rows,
    'rowCount', row_count,
    'truncated', row_count > safe_limit
  );
end;
$$;

alter view reporting.effective_flight_operations set (security_invoker = true);
alter view reporting.flight_operations set (security_invoker = true);
alter view reporting.summary_airline set (security_invoker = true);
alter view reporting.summary_country set (security_invoker = true);
alter view reporting.summary_route set (security_invoker = true);
alter view reporting.summary_month set (security_invoker = true);
alter view reporting.summary_week set (security_invoker = true);
alter view reporting.summary_peak_hour set (security_invoker = true);
alter view reporting.summary_aircraft set (security_invoker = true);
alter view reporting.summary_arr_dep_mix set (security_invoker = true);

grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;
revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from anon;
grant execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seasonal_bi_reader') then
    grant usage on schema reporting to seasonal_bi_reader;
    grant select on all tables in schema reporting to seasonal_bi_reader;
  end if;
end $$;
