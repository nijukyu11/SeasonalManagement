-- Cutover-aware HTML export data sourcing & generation watermark
-- Preserves EXACT legacy live-slice preimage behavior when cutover is OFF via captured wrappers.
-- Routes to reporting.canonical_flight_legs ONLY when cutover is ON (preserving identical authority as Report V2,
-- Daily priority, quarantine, pax NULL vs 0, and time basis).
-- Evaluates cutover status, projection freshness, and combined monotonic watermark in public.get_public_traffic_html_export_v2.

begin;

-- 1. Programmatically capture legacy preimages before replacing functions
do $$
declare
  v_fn text;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_traffic_html_period_data_v2'
  ) then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'traffic_html_period_data_v2';
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?traffic_html_period_data_v2\(', 'FUNCTION reporting.legacy_traffic_html_period_data_v2(', 'i');
      execute v_fn;
      execute 'alter function reporting.legacy_traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres';
    end if;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_get_public_traffic_html_export_v2'
  ) then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_public_traffic_html_export_v2';
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?get_public_traffic_html_export_v2\(', 'FUNCTION reporting.legacy_get_public_traffic_html_export_v2(', 'i');
      execute v_fn;
      execute 'alter function reporting.legacy_get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres';
    end if;
  end if;
end;
$$;

alter function reporting.legacy_traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres;
alter function reporting.legacy_get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres;
revoke all on function reporting.legacy_traffic_html_period_data_v2(jsonb,jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function reporting.legacy_get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) from public,anon,authenticated,service_role;

-- 2. Define cutover-aware reporting.traffic_html_period_data_v2
create or replace function reporting.traffic_html_period_data_v2(r jsonb, p jsonb, p_as_of timestamptz)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,reporting,public as $$
declare
  v_res jsonb;
begin
  -- When cutover is OFF, preserve exact legacy live candidate slice behavior
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_traffic_html_period_data_v2(r, p, p_as_of);
  end if;

  -- When cutover is ON, read directly from operational canonical projection
  -- Preserves exact Sep 6 period body and replaces only the canonical source CTE
  with params as (
    select (p->>'from')::date a,(p->>'to')::date b,
      ((p_as_of at time zone 'Asia/Ho_Chi_Minh')-interval '5 hours')::date-1 latest
  ), canonical as materialized (
    select c.ops_date,upper(btrim(c.type)) direction,upper(btrim(c.airline)) airline,
      upper(btrim(c.flight_number)) flight_number,upper(btrim(c.route)) route,
      nullif(btrim(countries.country),'') country,g.id aircraft_group_id,g.name aircraft_group,
      nullif(upper(btrim(c.aircraft_type)),'') aircraft_type,
      case when r->>'time_basis'='utc' then (c.local_minutes+1020)%1440 else c.local_minutes end minutes,
      c.pax pax,
      case when c.pax is not null and c.ops_date<=params.latest
        and exists(select 1 from reporting.public_traffic_coverage accepted where accepted.status='complete' and c.ops_date between accepted.from_date and accepted.to_date)
        then true else c.scheduled_local_at+interval '1 day' <= (p_as_of at time zone 'Asia/Ho_Chi_Minh') end is_due
    from reporting.canonical_flight_legs c cross join params
    left join public.operational_route_countries countries on upper(countries.route)=upper(c.route)
    left join lateral (
      select groups.id,groups.name from public.operational_aircraft_group_types types
      join public.operational_aircraft_groups groups on groups.id=types.group_id
      where upper(types.aircraft_type)=upper(btrim(c.aircraft_type)) order by groups.name,groups.id limit 1
    ) g on true
    where c.ops_date between params.a and params.b
      and upper(btrim(c.type)) in ('A','D')
  ), operations as materialized (
    select * from canonical c where
      (jsonb_array_length(r->'airlines')=0 or c.airline in(select jsonb_array_elements_text(r->'airlines')))
      and (jsonb_array_length(r->'routes')=0 or c.route in(select jsonb_array_elements_text(r->'routes')))
      and (jsonb_array_length(r->'countries')=0 or coalesce(c.country,'Unknown') in(select jsonb_array_elements_text(r->'countries')))
  ), calendar as materialized (
    select d::date ops_date,coalesce((select status from reporting.public_traffic_coverage ledger
      where d::date between ledger.from_date and ledger.to_date and status<>'excluded'
      order by certified_at desc nulls last,id desc limit 1),
      case when exists(select 1 from canonical c where c.ops_date=d::date) then 'partial' else 'missing' end) coverage
    from params,generate_series(a,b,interval '1 day') d
  ), coverage as (
    select case when bool_and(coverage='complete') then 'complete' when bool_or(coverage='missing') then 'missing' else 'partial' end status from calendar
  ), cells as (
    select c.*,d.dataset,d.grain,c.direction cell_direction from operations c cross join lateral(values
      ('kpi','{}'::jsonb),('timeline',jsonb_build_object('date',c.ops_date)),
      ('market',jsonb_build_object('country',c.country,'route',c.route,'airline',c.airline)),
      ('market_daily',jsonb_build_object('date',c.ops_date,'country',c.country,'route',c.route,'airline',c.airline)),
      ('aircraft',jsonb_build_object('group_id',c.aircraft_group_id,'group',c.aircraft_group,'type',c.aircraft_type)),
      ('hours',jsonb_build_object('hour',c.minutes/60))
    ) d(dataset,grain)
    union all select c.*,'kpi','{}'::jsonb,'all' from operations c
  ), grouped as (
    select dataset,grain,cell_direction direction,count(*)::bigint flights,
      sum(pax) filter(where is_due and pax is not null)::bigint reported_pax,
      count(*) filter(where is_due and pax is not null)::bigint reported_legs,
      count(*) filter(where is_due)::bigint due_legs,
      count(*) filter(where is_due and pax is null)::bigint missing_due_legs,
      count(*) filter(where is_due and pax=0)::bigint true_zero_reported_legs
    from cells group by dataset,grain,cell_direction
  ), positions as (
    select dataset,grain,direction from grouped
    union select 'kpi','{}'::jsonb,d from unnest(array['A','D','all']) d
    union select 'timeline',jsonb_build_object('date',ops_date),d from calendar cross join unnest(array['A','D']) d
    union select 'hours',jsonb_build_object('hour',h),d from generate_series(0,23) h cross join unnest(array['A','D']) d
  ), enriched as (
    select pos.*,g.flights actual_flights,g.reported_pax,coalesce(g.reported_legs,0) reported_legs,
      coalesce(g.due_legs,0) due_legs,coalesce(g.missing_due_legs,0) missing_due_legs,coalesce(g.true_zero_reported_legs,0) true_zero_reported_legs,
      case when pos.dataset in ('timeline','market_daily') then (select coverage from calendar where ops_date=(pos.grain->>'date')::date) else coverage.status end flight_coverage
    from positions pos cross join coverage left join grouped g using(dataset,grain,direction)
  ), measures as (
    select *,case when actual_flights is not null then actual_flights when flight_coverage='complete' then 0::bigint else null::bigint end flights from enriched
  ), metric_rows as (
    select dataset,jsonb_build_object('grain',grain,'direction',direction,'flights',flights,'reported_pax',reported_pax,
      'reported_legs',reported_legs,'due_legs',due_legs,'missing_due_legs',missing_due_legs,'true_zero_reported_legs',true_zero_reported_legs,
      'unreported_legs',flights-reported_legs,'flight_coverage',flight_coverage,
      'pax_status',case when reported_legs=0 then 'missing' when flights=reported_legs then 'complete' else 'partial' end) row from measures
  ), weekday_stats as (
    select minutes/60 as hour_index,direction,airline,route,flight_number,extract(isodow from ops_date)::integer weekday,
      count(distinct ops_date)::integer occurrence_days,((max(ops_date)-min(ops_date))/7+1)::integer eligible_days
    from operations where minutes is not null and flight_number<>'' group by 1,2,3,4,5,6
  ), qualifying as (
    select * from weekday_stats where occurrence_days>=4 and eligible_days>=4 and occurrence_days::numeric/eligible_days>=0.70
  ), time_counts as (
    select minutes/60 as hour_index,direction,airline,route,flight_number,minutes,count(distinct ops_date) days from operations
    where minutes is not null and flight_number<>'' group by 1,2,3,4,5,6
  ), typical as (
    select distinct on(hour_index,direction,airline,route,flight_number) * from time_counts order by hour_index,direction,airline,route,flight_number,days desc,minutes
  ), frequency as (
    select jsonb_build_object('direction',q.direction,'grain',jsonb_build_object('hour',q.hour_index,'airline',q.airline,'route',q.route,'flight_number',q.flight_number),
      'operating_days',jsonb_agg(q.weekday order by q.weekday),'occurrence_days',sum(q.occurrence_days),
      'eligible_days',sum(q.eligible_days),'consistency_percent',round(sum(q.occurrence_days)*100.0/nullif(sum(q.eligible_days),0),0),
      'typical_time',lpad((t.minutes/60)::text,2,'0')||':'||lpad((t.minutes%60)::text,2,'0')) row
    from qualifying q join typical t using(hour_index,direction,airline,route,flight_number) group by q.hour_index,q.direction,q.airline,q.route,q.flight_number,t.minutes
  ), datasets as (
    select d.dataset,coalesce((select jsonb_agg(row order by row::text) from metric_rows m where m.dataset=d.dataset),'[]'::jsonb) rows
    from unnest(array['kpi','timeline','market','market_daily','aircraft','hours']) d(dataset)
    union all select 'frequency',coalesce(jsonb_agg(row),'[]'::jsonb) from frequency
  ), resources as (
    select *,jsonb_build_object('dataset',dataset,'period_id',p->>'id','from',p->>'from','to',p->>'to',
      'airlines',r->'airlines','routes',r->'routes','countries',r->'countries','time_basis',r->>'time_basis','directions',jsonb_build_array('A','D')) normalized_filter
    from datasets
  )
  select jsonb_build_object('resources',(select jsonb_agg(jsonb_build_object('dataset',dataset,'period_id',p->>'id',
    'normalized_filter',normalized_filter,'filter_hash',encode(sha256(convert_to(normalized_filter::text,'UTF8')),'hex'),
    'complete',true,'row_count',jsonb_array_length(rows),'rows',rows,
    'totals',case when dataset='frequency' then '[]'::jsonb else (select rows from datasets where dataset='kpi') end)) from resources),
    'calendar',(select jsonb_agg(jsonb_build_object('period_id',p->>'id','date',ops_date,'month',to_char(ops_date,'YYYY-MM'),
      'iso_week',(ops_date-(extract(isodow from ops_date)::integer-1))::text,
      'business_week',(ops_date-((extract(isodow from ops_date)::integer+2)%7))::text) order by ops_date) from calendar))
  into v_res;

  return v_res;
end;
$$;

-- 3. Define cutover-aware public.get_public_traffic_html_export_v2
create or replace function public.get_public_traffic_html_export_v2(
  p_request jsonb,
  p_expected_watermark bigint default null,
  p_data_as_of timestamptz default null
) returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,reporting,public set statement_timeout='30s' as $$
declare
  is_cutover boolean := reporting.is_operational_reader_cutover_active_v1();
  as_of timestamptz:=coalesce(p_data_as_of,statement_timestamp());
  watermark bigint;
  version integer;
  lo date; hi date; p jsonb; part jsonb; count_rows bigint:=0;
  periods jsonb:=reporting.traffic_html_periods_v2(p_request,as_of,(p_request->>'to')::date);
  pairs jsonb:='[]'::jsonb;
  resources jsonb:='[]'::jsonb;
  calendar jsonb:='[]'::jsonb;
  previous_id text;
  result jsonb;
  v_proj_fresh boolean;
  v_proj_source bigint;
  v_proj_curr bigint;
  v_curr_op_rev bigint;
begin
  -- When cutover is OFF, delegate directly to legacy get_public_traffic_html_export_v2
  if not is_cutover then
    return reporting.legacy_get_public_traffic_html_export_v2(p_request, p_expected_watermark, as_of);
  end if;

  -- Cutover is active: evaluate projection freshness and monotonic generation watermark
  select is_fresh, source_watermark, current_watermark
  into v_proj_fresh, v_proj_source, v_proj_curr
  from reporting.operational_projection_status_v1();

  if v_proj_fresh is distinct from true then
    raise exception 'STALE_OPERATIONAL_PROJECTION source=% current=%', v_proj_source, v_proj_curr
      using errcode = '40001';
  end if;

  select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
  watermark := coalesce(v_proj_source, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
  version := coalesce(v_curr_op_rev, 0)::integer;

  if p_expected_watermark is not null and p_expected_watermark <> watermark then
    raise exception 'DATA_VERSION_CHANGED' using errcode = '40001';
  end if;

  select min_ops_date,max_ops_date into lo,hi from reporting.get_public_traffic_canonical_bounds_v1();
  if lo is null or hi is null then raise exception 'HTML_PERIOD_UNAVAILABLE' using errcode='P0002'; end if;
  for p in select value from jsonb_array_elements(periods) loop
    -- Automatic context may extend beyond coverage and must remain missing, not zero.
    if p->>'role' = 'current' and ((p->>'to')::date<lo or (p->>'from')::date>hi) then raise exception 'HTML_PERIOD_UNAVAILABLE' using errcode='P0002'; end if;
    if (p->>'calendar_days')::bigint>125000 then raise exception 'HTML_RESOURCE_BUDGET' using errcode='54000'; end if;
    part:=reporting.traffic_html_period_data_v2(p_request,p,as_of);
    resources:=resources||(part->'resources'); calendar:=calendar||(part->'calendar');
    select sum((value->>'row_count')::bigint) into count_rows from jsonb_array_elements(resources);
    if count_rows>250000 then raise exception 'HTML_RESOURCE_BUDGET' using errcode='54000'; end if;
    if p->>'role' in ('previous','comparison') and p->>'id'<>'previous_year_ago' then pairs:=pairs||jsonb_build_array(jsonb_build_object('id','current-vs-'||(p->>'id'),'minuend_period','current','baseline_period',p->>'id')); end if;
    if p->>'role'='next' then pairs:=pairs||jsonb_build_array(jsonb_build_object('id','next-vs-current','minuend_period','next','baseline_period','current')); end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(periods) where value->>'id'='previous_year_ago') then
    pairs:=pairs||jsonb_build_array(jsonb_build_object('id','year_ago-vs-previous_year_ago','minuend_period','year_ago','baseline_period','previous_year_ago'));
  end if;
  for p in select value from jsonb_array_elements(periods) where value->>'role'='analysis-week' order by value->>'from' loop
    if previous_id is not null then pairs:=pairs||jsonb_build_array(jsonb_build_object('id',(p->>'id')||'-vs-'||previous_id,'minuend_period',p->>'id','baseline_period',previous_id)); end if;
    previous_id:=p->>'id';
  end loop;
  result:=jsonb_build_object('contract_version','traffic-html-data-v2','source_mode','live','source_watermark',watermark::text,
    'data_version',version,'data_as_of',as_of,'snapshot_scope','single-statement','normalized_request',p_request,
    'request_hash',encode(sha256(convert_to(p_request::text,'UTF8')),'hex'),'periods',periods,'comparison_pairs',pairs,
    'calendar',calendar,'resources',resources);
  if octet_length(result::text)>25*1024*1024 then raise exception 'HTML_RESOURCE_BUDGET' using errcode='54000'; end if;
  return result;
end $$;

alter function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres;
alter function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres;
revoke all on function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) to service_role;

commit;
