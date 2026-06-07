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
    'pax',
    'scheduled_date',
    'scheduled_time',
    'ops_date',
    'month',
    'iso_week',
    'local_hour',
    'utc_hour',
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
      'dataQualityNotes', jsonb_build_array(format('View reporting.%s không có cột allowlist khả dụng.', view_name))
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

  if 'iso_week' = any(view_columns) and jsonb_typeof(p_filters->'weeks') = 'array' then
    select string_agg((substring(value from 'W([0-9]{2})$'))::integer::text, ',')
      into value_list
    from jsonb_array_elements_text(p_filters->'weeks') as value
    where value ~ '^20[0-9]{2}-W[0-9]{2}$';
    if value_list is not null then
      where_clauses := where_clauses || format('iso_week in (%s)', value_list);
    end if;
  end if;

  if 'type' = any(view_columns) and p_filters->>'typeFilter' in ('A', 'D') then
    where_clauses := where_clauses || format('type = %L', p_filters->>'typeFilter');
  end if;

  foreach filter_name in array array['airlines', 'routes', 'countries', 'aircraft'] loop
    if jsonb_typeof(p_filters->filter_name) = 'array' then
      select string_agg(quote_literal(case when filter_name in ('airlines', 'routes', 'aircraft') then upper(value) else value end), ',')
        into value_list
      from jsonb_array_elements_text(p_filters->filter_name) as value
      where value <> '';
      if value_list is not null then
        filter_name := case filter_name when 'airlines' then 'airline' when 'routes' then 'route' when 'countries' then 'country' else 'aircraft' end;
        if filter_name = any(view_columns) then
          where_clauses := where_clauses || format('%I in (%s)', filter_name, value_list);
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

grant execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) to authenticated;
