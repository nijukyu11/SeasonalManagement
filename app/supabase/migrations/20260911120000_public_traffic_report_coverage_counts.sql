-- Additive network-scope counts for the public traffic report overview:
-- distinct routes, airlines and mapped countries inside the filtered period.
-- The counts are computed in SQL over the same filtered rows that produce the
-- KPI totals, never from the capped filter_options list or paginated
-- breakdowns. Both functions are patched in place from their live definitions
-- so earlier in-place corrections (canonical source, Pax presence, Daily Pax
-- maturity) are preserved. Definitions are normalized to LF before matching so
-- the migration behaves the same on CRLF and LF checkouts.

do $migration$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)');
  v_definition text;
  v_old_cte text := $old$  )
  select jsonb_build_object(
    'contract_version', 'traffic-report-v2',$old$;
  v_new_cte text := $new$  ), coverage_counts as (
    select
      count(distinct route) filter (where route is not null and route <> '')::integer as routes,
      count(distinct airline) filter (where airline is not null and airline <> '')::integer as airlines,
      count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as countries
    from current_rows
    where p_payload_scope = 'full'
  )
  select jsonb_build_object(
    'contract_version', 'traffic-report-v2',$new$;
  v_old_field text := $old$      'quality', (select jsonb_build_object(
        'unknown_country_legs', quality.unknown_country_legs,$old$;
  v_new_field text := $new$      'coverage_counts', (select jsonb_build_object(
        'routes', coverage.routes,
        'airlines', coverage.airlines,
        'countries', coverage.countries
      ) from coverage_counts coverage),
      'quality', (select jsonb_build_object(
        'unknown_country_legs', quality.unknown_country_legs,$new$;
begin
  if v_signature is null then
    raise notice 'get_public_traffic_report_v2 is absent; coverage_counts skipped';
    return;
  end if;
  select replace(pg_get_functiondef(v_signature), E'\r\n', E'\n') into v_definition;
  if strpos(v_definition, '''coverage_counts''') = 0 then
    if strpos(v_definition, v_old_cte) = 0 or strpos(v_definition, v_old_field) = 0 then
      raise exception 'unexpected live traffic-report-v2 definition; coverage_counts migration refused';
    end if;
    v_definition := replace(v_definition, v_old_cte, v_new_cte);
    v_definition := replace(v_definition, v_old_field, v_new_field);
    execute v_definition;
  end if;
end;
$migration$;

do $migration$
declare
  v_signature regprocedure :=
    'reporting.get_traffic_report_kpis(date,date,jsonb,text,timestamptz)'::regprocedure;
  v_definition text;
  v_old_quality text := $old$    count(*) filter (where country = 'Unknown')::integer as unknown_country,$old$;
  v_new_quality text := $new$    count(*) filter (where country = 'Unknown')::integer as unknown_country,
    count(distinct route) filter (where route is not null and route <> '')::integer as distinct_routes,
    count(distinct airline) filter (where airline is not null and airline <> '')::integer as distinct_airlines,
    count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as distinct_countries,$new$;
  v_old_out text := $old$  'quality', jsonb_build_object(
    'unknown_country_legs', quality.unknown_country,$old$;
  v_new_out text := $new$  'coverage_counts', jsonb_build_object(
    'routes', quality.distinct_routes,
    'airlines', quality.distinct_airlines,
    'countries', quality.distinct_countries
  ),
  'quality', jsonb_build_object(
    'unknown_country_legs', quality.unknown_country,$new$;
begin
  if v_signature is null then
    raise notice 'reporting.get_traffic_report_kpis is absent; coverage_counts skipped';
    return;
  end if;
  select replace(pg_get_functiondef(v_signature), E'\r\n', E'\n') into v_definition;
  if strpos(v_definition, '''coverage_counts''') = 0 then
    if strpos(v_definition, v_old_quality) = 0 or strpos(v_definition, v_old_out) = 0 then
      raise exception 'unexpected live traffic KPI definition; coverage_counts migration refused';
    end if;
    v_definition := replace(v_definition, v_old_quality, v_new_quality);
    v_definition := replace(v_definition, v_old_out, v_new_out);
    execute v_definition;
  end if;
end;
$migration$;
