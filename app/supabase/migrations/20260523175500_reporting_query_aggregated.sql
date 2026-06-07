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
    'month',
    'iso_week',
    'local_hour',
    'ops_date',
    'season',
    'gate',
    'type',
    'weekday'
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

  if p_order_by = any(metric_columns) then
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
    select string_agg((substring(value from 'W([0-9]{2})$'))::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('iso_week in (%s)', value_list);
    end if;
  end if;

  if p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach column_name in array array['airlines', 'routes', 'countries', 'aircraft'] loop
    if jsonb_typeof(p_filters->column_name) = 'array' then
      select string_agg(quote_literal(case when column_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
        into value_list
      from jsonb_array_elements_text(p_filters->column_name) as value
      where value <> '';
      if value_list is not null then
        where_clauses := where_clauses || format('%I in (%s)', case column_name when 'airlines' then 'airline' when 'routes' then 'route' when 'countries' then 'country' else 'aircraft' end, value_list);
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

  execute format(
    'select count(*) from (select 1 from reporting.flight_operations where %s%s) grouped',
    array_to_string(where_clauses, ' and '),
    group_clause
  ) into row_count;

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
    'truncated', row_count > safe_limit
  );
end;
$$;

grant execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
