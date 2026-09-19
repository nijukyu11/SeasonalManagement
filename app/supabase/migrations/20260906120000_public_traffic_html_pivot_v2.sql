-- Reference-layout HTML v2. V1 remains installed for rollback; no business schema or Excel changes.
-- All nested STABLE calls share the caller's statement snapshot.
create or replace function reporting.traffic_html_season_v2(p_code text)
returns daterange language plpgsql immutable set search_path=pg_catalog as $$
declare y integer; a date; b date;
begin
  if p_code is null or p_code !~ '^[SW][0-9]{2}$' then raise exception 'invalid season' using errcode='22023'; end if;
  y := 2000 + substring(p_code from 2)::integer;
  a := make_date(y, case when left(p_code,1)='S' then 3 else 10 end, 31);
  b := make_date(y + case when left(p_code,1)='W' then 1 else 0 end,
    case when left(p_code,1)='S' then 10 else 3 end,31);
  return daterange(a-extract(dow from a)::integer,b-extract(dow from b)::integer,'[)');
end $$;

create or replace function reporting.traffic_html_periods_v2(r jsonb, p_as_of timestamptz, p_analysis_to date default null)
returns jsonb language plpgsql stable set search_path=pg_catalog,reporting as $$
declare a date := (r->>'from')::date; b date := (r->>'to')::date;
  report text := r->>'report_type'; mode text := r->>'period_mode'; template text := r->>'html_template';
  periods jsonb := '[]'; item text; x date; z date; yr integer; season daterange;
  latest date := ((p_as_of at time zone 'Asia/Ho_Chi_Minh')-interval '5 hours')::date-1;
begin
  if jsonb_typeof(r) is distinct from 'object' or r->>'contract_version' is distinct from 'traffic-html-data-v2' or a is null or b is null or a>b
    or report is null or mode is null or r->>'time_basis' is null
    or r->>'time_basis' not in ('local','utc') then raise exception 'invalid HTML request' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(r) k where k not in
    ('contract_version','html_template','report_type','period_mode','from','to','season_code','month','month_from','month_to','year','comparison_years','comparisons','airlines','routes','countries','time_basis'))
    then raise exception 'unknown HTML request key' using errcode='22023'; end if;
  if report not in ('MASTER_OPERATIONS','MONTHLY_OVERVIEW_L2','WEEKLY_DETAIL','PERIOD_ANALYSIS','BAO_CAO_SAN_LUONG')
    or template is distinct from (case report when 'WEEKLY_DETAIL' then 'weekly-detail-v1' when 'BAO_CAO_SAN_LUONG' then 'bao-cao-san-luong-v1' else 'period-analysis-v1' end)
    or mode not in ('custom','month','month_range','season','year')
    or (report='MASTER_OPERATIONS' and mode not in ('season','custom'))
    or (report='MONTHLY_OVERVIEW_L2' and mode<>'month')
    or (report='WEEKLY_DETAIL' and mode<>'custom')
    or (report='BAO_CAO_SAN_LUONG' and mode<>'season') then raise exception 'invalid HTML preset' using errcode='22023'; end if;
  foreach item in array array['comparisons','comparison_years','airlines','routes','countries'] loop
    if jsonb_typeof(r->item) is distinct from 'array' then raise exception 'invalid list' using errcode='22023'; end if;
    if item in ('airlines','routes','countries') and jsonb_array_length(r->item)>24 then raise exception 'filter cardinality exceeds 24' using errcode='22023'; end if;
  end loop;
  if mode='season' then
    season := reporting.traffic_html_season_v2(r->>'season_code');
    if a<>lower(season) or b<>upper(season)-1 then raise exception 'season range mismatch' using errcode='22023'; end if;
  elsif mode='month' then
    x := ((r->>'month')||'-01')::date;
    if x is null or a<>x or b<>(x+interval '1 month')::date-1 then raise exception 'month range mismatch' using errcode='22023'; end if;
  elsif mode='month_range' then
    if r->>'month_from' is null or r->>'month_to' is null or a<>((r->>'month_from')||'-01')::date or b<>(((r->>'month_to')||'-01')::date+interval '1 month')::date-1 then raise exception 'month range mismatch' using errcode='22023'; end if;
  elsif mode='year' then
    if r->>'year' is null or a<>make_date((r->>'year')::integer,1,1) or b<>make_date((r->>'year')::integer,12,31) then raise exception 'year range mismatch' using errcode='22023'; end if;
  end if;
  periods := jsonb_build_array(jsonb_build_object('id','current','role','current','label','Kỳ đã chọn','from',a,'to',b));
  if report='WEEKLY_DETAIL' then
    if jsonb_array_length(r->'comparisons')>0 then raise exception 'weekly comparisons automatic' using errcode='22023'; end if;
    periods := periods || jsonb_build_array(
      jsonb_build_object('id','previous','role','previous','label','Tuần trước','from',a-7,'to',a-1),
      jsonb_build_object('id','next','role','next','label','Tuần sau','from',b+1,'to',b+7));
  end if;
  for item in select jsonb_array_elements_text(r->'comparisons') loop
    if report not in ('MASTER_OPERATIONS','MONTHLY_OVERVIEW_L2') or item not in ('previous','year_ago') then raise exception 'invalid comparison' using errcode='22023'; end if;
    if item='previous' then
      z:=a-1; x:=case when mode='month' then (a-interval '1 month')::date else a-(b-a+1) end;
    elsif mode='month' then
      x:=(a-interval '1 year')::date; z:=(x+interval '1 month')::date-1;
    elsif mode='season' then
      season:=reporting.traffic_html_season_v2(left(r->>'season_code',1)||to_char(extract(year from a)::integer-2001,'FM00'));
      x:=lower(season); z:=upper(season)-1;
    else x:=(a-interval '1 year')::date; z:=(b-interval '1 year')::date;
    end if;
    periods := periods || jsonb_build_array(jsonb_build_object('id',item,'role',case when item='previous' then 'previous' else 'comparison' end,
      'label',case when item='previous' then 'Kỳ trước' else 'Cùng kỳ năm trước' end,'from',x,'to',z));
  end loop;
  -- Monthly narrative compares Aug->Sep this year against Aug->Sep last year.
  -- Automatic context uses a full calendar month (including leap February).
  if report='MONTHLY_OVERVIEW_L2' and r->'comparisons' @> '["previous","year_ago"]'::jsonb then
    x:=(a-interval '1 month'-interval '1 year')::date;
    periods:=periods||jsonb_build_array(jsonb_build_object('id','previous_year_ago','role','previous',
      'label','Tháng trước của năm trước','from',x,'to',(x+interval '1 month')::date-1));
  end if;
  for yr in select distinct value::integer from jsonb_array_elements_text(r->'comparison_years') order by 1 desc loop
    if report<>'PERIOD_ANALYSIS' or yr<2000 or yr>=extract(year from a) then raise exception 'invalid comparison year' using errcode='22023'; end if;
    if mode='season' then
      season:=reporting.traffic_html_season_v2(left(r->>'season_code',1)||to_char(yr-2000,'FM00'));
      x:=lower(season); z:=upper(season)-1;
    else
      x:=(a+make_interval(years=>yr-extract(year from a)::integer))::date;
      z:=(b+make_interval(years=>yr-extract(year from a)::integer))::date;
    end if;
    periods:=periods||jsonb_build_array(jsonb_build_object('id','comparison-'||yr,'role','comparison','label',yr::text,'from',x,'to',z));
  end loop;
  if report='BAO_CAO_SAN_LUONG' then
    -- Anchor on completed Ops Date, never Pax presence. Full context weeks may cross the season.
    x:=greatest(a,least(b,latest));
    x:=x-((extract(isodow from x)::integer+2)%7);
    for yr in -2..1 loop
      z:=x+yr*7;
      periods:=periods||jsonb_build_array(jsonb_build_object('id','analysis-'||z,'role','analysis-week',
        'label',case yr when -2 then 'Tuần trước nữa' when -1 then 'Tuần trước' when 0 then 'Tuần hiện tại' else 'Tuần sau' end,
        'from',z,'to',z+6));
    end loop;
  end if;
  if (select count(*)<>count(distinct p->>'id') from jsonb_array_elements(periods) p) then raise exception 'duplicate periods' using errcode='22023'; end if;
  return (select jsonb_agg(p||jsonb_build_object('calendar_days',(p->>'to')::date-(p->>'from')::date+1,'contains_future',(p->>'to')::date>latest)) from jsonb_array_elements(periods) p);
end $$;

create or replace function reporting.traffic_html_period_data_v2(r jsonb, p jsonb, p_as_of timestamptz)
returns jsonb language sql stable security definer
set search_path=pg_catalog,reporting,public as $$
with params as (
  select (p->>'from')::date a,(p->>'to')::date b,
    ((p_as_of at time zone 'Asia/Ho_Chi_Minh')-interval '5 hours')::date-1 latest
), candidates as materialized (
  select c.*,max(authoritative_server_seq) over(partition by business_leg_key) max_seq
  from params,reporting.get_public_traffic_candidate_slice_v1(a-1,b+1) c
), ranked as (
  select c.*,count(*) over(partition by business_leg_key) candidate_count,
    count(*) filter(where authoritative_server_seq is null) over(partition by business_leg_key) missing_recency_count,
    count(*) filter(where authoritative_server_seq=max_seq) over(partition by business_leg_key) max_recency_count,
    row_number() over(partition by business_leg_key order by authoritative_server_seq desc nulls last,season_id,record_id) candidate_rank
  from candidates c
), canonical as materialized (
  select c.ops_date,upper(btrim(c.type)) direction,upper(btrim(c.airline)) airline,
    upper(btrim(c.flight_number)) flight_number,upper(btrim(c.effective_route)) route,
    nullif(btrim(countries.country),'') country,g.id aircraft_group_id,g.name aircraft_group,
    nullif(upper(btrim(c.effective_aircraft)),'') aircraft_type,
    case when r->>'time_basis'='utc' then (c.local_minutes+1020)%1440 else c.local_minutes end minutes,
    c.effective_pax pax,
    case when c.effective_pax is not null and c.ops_date<=params.latest
      and exists(select 1 from reporting.public_traffic_coverage accepted where accepted.status='complete' and c.ops_date between accepted.from_date and accepted.to_date)
      then true else c.scheduled_local_at+interval '1 day' <= (p_as_of at time zone 'Asia/Ho_Chi_Minh') end is_due
  from ranked c cross join params
  left join public.operational_route_countries countries on upper(countries.route)=upper(c.effective_route)
  left join lateral (
    select groups.id,groups.name from public.operational_aircraft_group_types types
    join public.operational_aircraft_groups groups on groups.id=types.group_id
    where upper(types.aircraft_type)=upper(btrim(c.effective_aircraft)) order by groups.name,groups.id limit 1
  ) g on true
  where c.candidate_rank=1 and not(c.candidate_count>1 and (c.missing_recency_count>0 or c.max_recency_count>1))
    and c.effective_action is distinct from 'deleted' and c.ops_date between params.a and params.b
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
    'business_week',(ops_date-((extract(isodow from ops_date)::integer+2)%7))::text) order by ops_date) from calendar));
$$;

create or replace function public.get_public_traffic_html_export_v2(p_request jsonb,p_expected_watermark bigint default null,p_data_as_of timestamptz default null)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,reporting,public set statement_timeout='30s' as $$
declare as_of timestamptz:=coalesce(p_data_as_of,statement_timestamp()); watermark bigint; version integer;
  periods jsonb; p jsonb; part jsonb; resources jsonb:='[]'; calendar jsonb:='[]'; pairs jsonb:='[]'; previous_id text;
  lo date; hi date; count_rows bigint:=0; result jsonb;
begin
  periods:=reporting.traffic_html_periods_v2(p_request,as_of);
  select coalesce(max(server_seq),0) into watermark from public.season_change_events;
  select coalesce(max(data_version),0) into version from public.seasons;
  if p_expected_watermark is not null and p_expected_watermark<>watermark then raise exception 'DATA_VERSION_CHANGED' using errcode='40001'; end if;
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

alter function reporting.traffic_html_season_v2(text) owner to postgres;
alter function reporting.traffic_html_periods_v2(jsonb,timestamptz,date) owner to postgres;
alter function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) owner to postgres;
alter function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) owner to postgres;
revoke all on function reporting.traffic_html_season_v2(text) from public,anon,authenticated,service_role;
revoke all on function reporting.traffic_html_periods_v2(jsonb,timestamptz,date) from public,anon,authenticated,service_role;
revoke all on function reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz) to service_role;
