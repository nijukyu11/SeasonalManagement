-- Additive live aggregate contract for Report and Dashboard Report Mode.
-- The function consumes the canonical ranked candidate boundary, never raw
-- history, and returns only aggregates captured in one PostgreSQL snapshot.

create or replace function public.get_public_traffic_report_v2(
  p_from_date date default null,
  p_to_date date default null,
  p_type text default 'all',
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_comparison text default 'previous',
  p_time_basis text default 'local',
  p_expected_watermark bigint default null,
  p_contract_version text default 'traffic-report-v2'
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, extensions, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_data_as_of timestamptz := statement_timestamp();
  v_source_watermark bigint;
  v_data_version integer;
  v_min_date date;
  v_max_date date;
  v_latest_completed date;
  v_from_date date;
  v_to_date date;
  v_comparison_from date;
  v_comparison_to date;
  v_scan_from date;
  v_scan_to date;
  v_day_count integer;
  v_type text := upper(btrim(coalesce(p_type, 'all')));
  v_airlines text[];
  v_routes text[];
  v_countries text[];
  v_normalized_filter jsonb;
  v_filter_hash text;
  v_result jsonb;
begin
  if p_contract_version <> 'traffic-report-v2' then
    raise exception 'unsupported contract_version' using errcode = '22023';
  end if;
  if v_type not in ('ALL', 'A', 'D') then
    raise exception 'invalid type' using errcode = '22023';
  end if;
  if p_comparison not in ('previous', 'year_ago', 'none') then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  if p_time_basis not in ('local', 'utc') then
    raise exception 'invalid time basis' using errcode = '22023';
  end if;
  if (p_from_date is null) <> (p_to_date is null) then
    raise exception 'from_date and to_date must be provided together' using errcode = '22023';
  end if;
  if cardinality(p_airlines) > 24 or cardinality(p_routes) > 24 or cardinality(p_countries) > 24 then
    raise exception 'filter cardinality exceeds 24' using errcode = '54000';
  end if;

  select coalesce(array_agg(value order by value), array[]::text[])
    into v_airlines
  from (select distinct upper(btrim(value)) as value from unnest(p_airlines) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_routes
  from (select distinct upper(btrim(value)) as value from unnest(p_routes) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_countries
  from (select distinct btrim(value) as value from unnest(p_countries) value where btrim(value) <> '') normalized;

  select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
  from public.season_change_events events;
  select coalesce(max(seasons.data_version), 0)::integer into v_data_version
  from public.seasons seasons;
  if p_expected_watermark is not null and p_expected_watermark is distinct from v_source_watermark then
    raise exception 'DATA_VERSION_CHANGED expected=% actual=%', p_expected_watermark, v_source_watermark
      using errcode = '40001';
  end if;

  v_latest_completed := (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - 1;
  if p_from_date is null then
    select min(candidates.ops_date), max(candidates.ops_date)
      into v_min_date, v_max_date
    from reporting.public_traffic_candidates candidates
    where candidates.ops_date is not null;
    if v_min_date is null or v_max_date is null then
      raise exception 'traffic report has no canonical effective operations' using errcode = 'P0002';
    end if;
    v_from_date := greatest(v_min_date, make_date(extract(year from v_latest_completed)::integer, 1, 1));
    v_to_date := least(v_max_date, v_latest_completed);
  else
    v_from_date := p_from_date;
    v_to_date := p_to_date;
  end if;
  if v_from_date > v_to_date then
    raise exception 'from_date must not exceed to_date' using errcode = '22023';
  end if;
  v_day_count := v_to_date - v_from_date + 1;
  if v_day_count > 3660 then
    raise exception 'date range exceeds 3660 days' using errcode = '54000';
  end if;

  if p_comparison = 'previous' then
    v_comparison_to := v_from_date - 1;
    v_comparison_from := v_comparison_to - (v_day_count - 1);
  elsif p_comparison = 'year_ago' then
    v_comparison_from := v_from_date - interval '1 year';
    v_comparison_to := v_to_date - interval '1 year';
  end if;
  v_scan_from := least(v_from_date, coalesce(v_comparison_from, v_from_date));
  v_scan_to := greatest(v_to_date, coalesce(v_comparison_to, v_to_date));

  v_normalized_filter := jsonb_build_object(
    'from', v_from_date,
    'to', v_to_date,
    'type', case v_type when 'ALL' then 'all' else v_type end,
    'airline', to_jsonb(v_airlines),
    'route', to_jsonb(v_routes),
    'country', to_jsonb(v_countries),
    'comp', p_comparison,
    'tz', p_time_basis
  );
  v_filter_hash := encode(extensions.digest(convert_to(v_normalized_filter::text, 'UTF8'), 'sha256'), 'hex');

  with candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from reporting.get_public_traffic_candidate_slice_v1(
      v_scan_from - 1,
      v_scan_to + 1
    ) candidates
  ), ranked_slice as (
    select candidates.*,
      count(*) over (partition by candidates.business_leg_key) as candidate_count,
      count(*) filter (where candidates.authoritative_server_seq is null)
        over (partition by candidates.business_leg_key) as missing_recency_count,
      count(*) filter (where candidates.authoritative_server_seq = candidates.max_authoritative_server_seq)
        over (partition by candidates.business_leg_key) as max_recency_count,
      row_number() over (
        partition by candidates.business_leg_key
        order by candidates.authoritative_server_seq desc nulls last, candidates.season_id, candidates.record_id
      ) as candidate_rank
    from candidate_slice candidates
  ), live_rows as materialized (
    select
      ranked.business_leg_key,
      ranked.ops_date,
      upper(btrim(ranked.type)) as type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.effective_route)) as route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      ranked.effective_pax as pax,
      ranked.scheduled_local_at,
      ranked.scheduled_local_at + interval '1 day' <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh') as is_due
    from ranked_slice ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    where ranked.candidate_rank = 1
      and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1))
      and ranked.effective_action is distinct from 'deleted'
      and ranked.ops_date between v_scan_from and v_scan_to
      and (v_type = 'ALL' or upper(btrim(ranked.type)) = v_type)
      and (cardinality(v_airlines) = 0 or upper(btrim(ranked.airline)) = any(v_airlines))
      and (cardinality(v_routes) = 0 or upper(btrim(ranked.effective_route)) = any(v_routes))
      and (cardinality(v_countries) = 0 or coalesce(nullif(btrim(countries.country), ''), 'Unknown') = any(v_countries))
  ), current_rows as materialized (
    select * from live_rows where ops_date between v_from_date and v_to_date
  ), comparison_rows as materialized (
    select * from live_rows
    where v_comparison_from is not null and ops_date between v_comparison_from and v_comparison_to
  ), current_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows
  ), comparison_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from comparison_rows
  ), timeline_grouped as (
    select ops_date,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows group by ops_date
  ), timeline as (
    select spine.ops_date::date as ops_date,
      grouped.flights, grouped.arrivals, grouped.departures, grouped.reported_pax,
      grouped.reported_legs, grouped.due_legs, grouped.missing_due_legs,
      grouped.true_zero_reported_legs,
      coalesce((select ledger.status from reporting.public_traffic_coverage ledger
        where spine.ops_date::date between ledger.from_date and ledger.to_date and ledger.status <> 'excluded'
        order by ledger.certified_at desc nulls last, ledger.id desc limit 1),
        case when grouped.flights > 0 then 'partial' else 'missing' end) as coverage_status
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
  ), current_coverage as (
    select bool_or(coverage_status in ('missing', 'partial')) as incomplete from timeline
  ), dimension_grouped as (
    select dimensions.dimension, dimensions.label,
      count(*)::integer as flights,
      count(*) filter (where rows.type = 'A')::integer as arrivals,
      count(*) filter (where rows.type = 'D')::integer as departures,
      case when count(*) filter (where rows.is_due and rows.pax is not null) > 0
        then sum(rows.pax) filter (where rows.is_due and rows.pax is not null)::bigint end as reported_pax,
      count(*) filter (where rows.is_due and rows.pax is not null)::integer as reported_legs,
      count(*) filter (where rows.is_due)::integer as due_legs,
      count(*) filter (where rows.is_due and rows.pax is null)::integer as missing_due_legs,
      count(*) filter (where rows.is_due and rows.pax = 0)::integer as true_zero_reported_legs
    from current_rows rows
    cross join lateral (values
      ('airline'::text, rows.airline),
      ('route'::text, rows.route),
      ('country'::text, rows.country)
    ) dimensions(dimension, label)
    group by dimensions.dimension, dimensions.label
  ), dimension_totals as (
    select dimension, sum(flights)::numeric as flights,
      sum(reported_pax) filter (where reported_pax is not null)::numeric as reported_pax
    from dimension_grouped group by dimension
  ), dimension_rows as (
    select grouped.*,
      grouped.flights::numeric / nullif(totals.flights, 0) as flight_share,
      grouped.reported_pax::numeric / nullif(totals.reported_pax, 0) as pax_share,
      row_number() over (partition by grouped.dimension order by grouped.flights desc, grouped.label) as row_rank
    from dimension_grouped grouped join dimension_totals totals using (dimension)
  )
  select jsonb_build_object(
    'contract_version', 'traffic-report-v2',
    'data_as_of', v_data_as_of,
    'source_watermark', v_source_watermark,
    'data_version', v_data_version,
    'filter_hash', v_filter_hash,
    'source_mode', 'live',
    'normalized_filter', v_normalized_filter,
    'current', (select jsonb_build_object(
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero'
        when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 or coverage.incomplete then 'partial'
        else 'complete' end
    ) from current_metric metric cross join current_coverage coverage),
    'comparison', (select jsonb_build_object(
      'from', v_comparison_from, 'to', v_comparison_to,
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero' when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 then 'partial' else 'complete' end
    ) from comparison_metric metric),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'ops_date', ops_date,
      'flights', case when coverage_status = 'missing' and flights is null then null else coalesce(flights, 0) end,
      'arrivals', case when coverage_status = 'missing' and flights is null then null else coalesce(arrivals, 0) end,
      'departures', case when coverage_status = 'missing' and flights is null then null else coalesce(departures, 0) end,
      'reported_pax', reported_pax,
      'reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(reported_legs, 0) end,
      'due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(due_legs, 0) end,
      'missing_due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(missing_due_legs, 0) end,
      'true_zero_reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(true_zero_reported_legs, 0) end,
      'status', case when ops_date > v_latest_completed then 'future'
        when coverage_status = 'missing' then 'missing'
        when coverage_status = 'partial' or missing_due_legs > 0 then 'partial'
        when coalesce(flights, 0) = 0 then 'zero' else 'complete' end
    ) order by ops_date) from timeline), '[]'::jsonb),
    'dimensions', jsonb_build_object(
      'airline', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'airline' and row_rank <= 50), '[]'::jsonb),
      'route', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'route' and row_rank <= 50), '[]'::jsonb),
      'country', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'country' and row_rank <= 50), '[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

alter function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) owner to postgres;
revoke execute on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) from public, anon, authenticated, service_role;
grant execute on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) to service_role;

revoke all on reporting.public_traffic_ranked_candidates from public, anon, authenticated, service_role;
revoke all on reporting.public_traffic_duplicate_quarantine from public, anon, authenticated, service_role;
revoke all on reporting.public_traffic_candidates from public, anon, authenticated, service_role;

comment on function public.get_public_traffic_report_v2(
  date,date,text,text[],text[],text[],text,text,bigint,text
) is 'Live canonical aggregate bundle for Report and Dashboard; NULL Pax remains missing and true zero remains reported.';
