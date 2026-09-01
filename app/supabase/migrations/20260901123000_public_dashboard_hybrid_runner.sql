-- Hybrid Daily Publication orchestration support.
--
-- PostgreSQL NOTIFY is transactional: the listener sees the wake signal only
-- after the canonical Daily import transaction commits. The runner remains
-- outside the import transaction and the 15-minute timer is the recovery path.

do $migration$
declare
  v_metrics_signature regprocedure :=
    'public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure;
  v_publisher_signature regprocedure :=
    'public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text)'::regprocedure;
  v_definition text;
  v_metrics_old text := $old$  v_latest_completed := (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date - 1;$old$;
  v_metrics_new text := $new$  v_latest_completed := ((v_data_as_of at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1;$new$;
  v_publisher_old text := $old$  if p_business_date >= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'business_date must be a completed Ops Date' using errcode = '22023';
  end if;$old$;
  v_publisher_new text := $new$  if p_business_date > ((v_data_as_of at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1 then
    raise exception 'business_date must be a completed Ops Date' using errcode = '22023';
  end if;$new$;
begin
  select pg_get_functiondef(v_metrics_signature) into v_definition;
  if strpos(v_definition, v_metrics_new) = 0 then
    if strpos(v_definition, v_metrics_old) = 0 then
      raise exception 'unexpected live traffic latest-completed definition; cutoff patch refused';
    end if;
    execute replace(v_definition, v_metrics_old, v_metrics_new);
  end if;

  select pg_get_functiondef(v_publisher_signature) into v_definition;
  if strpos(v_definition, v_publisher_new) = 0 then
    if strpos(v_definition, v_publisher_old) = 0 then
      raise exception 'unexpected Dashboard publisher completed-date definition; cutoff patch refused';
    end if;
    execute replace(v_definition, v_publisher_old, v_publisher_new);
  end if;
end;
$migration$;

create or replace function reporting.select_public_dashboard_candidate_v1(
  p_now timestamptz default statement_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_latest_completed date := ((p_now at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1;
  v_year integer := extract(year from v_latest_completed)::integer;
  v_year_start date := make_date(v_year,1,1);
  v_first_gap date;
  v_candidate date;
  v_source_watermark bigint;
  v_data_version integer;
  v_projection_status text;
  v_projection_watermark bigint;
  v_projection_data_version integer;
  v_projection_refreshed_at timestamptz;
  v_head_id bigint;
  v_head_business_date date;
  v_head_watermark bigint;
  v_metrics jsonb;
  v_timeline_days integer;
  v_missing_days integer;
  v_partial_days integer;
  v_flights integer;
  v_due_legs integer;
  v_reported_legs integer;
  v_missing_due_legs integer;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_target bigint;
  v_pax_coverage numeric;
  v_elapsed_days integer;
  v_status text;
  v_eligible boolean := false;
  v_reason text;
begin
  if p_now is null then
    raise exception 'candidate as-of must not be null' using errcode='22004';
  end if;

  select coalesce(max(events.server_seq),0)::bigint into v_source_watermark
  from public.season_change_events events;
  select coalesce(max(seasons.data_version),0)::integer into v_data_version
  from public.seasons seasons;
  select state.status,state.source_watermark,state.source_data_version,state.refreshed_at
    into v_projection_status,v_projection_watermark,v_projection_data_version,v_projection_refreshed_at
  from reporting.public_traffic_projection_state state
  where state.projection_name='public_traffic_effective';

  select heads.publication_id,publications.business_date,publications.source_watermark
    into v_head_id,v_head_business_date,v_head_watermark
  from reporting.public_dashboard_publication_heads heads
  join reporting.public_dashboard_publications publications on publications.id=heads.publication_id
  where heads.dashboard_key='annual-passenger-kpi' and heads.year=v_year;

  select min(days.day::date) into v_first_gap
  from generate_series(v_year_start,v_latest_completed,interval '1 day') days(day)
  where not exists (
    select 1 from reporting.public_traffic_coverage coverage
    where coverage.status='complete' and days.day::date between coverage.from_date and coverage.to_date
  );
  v_candidate := case when v_first_gap is null then v_latest_completed else v_first_gap - 1 end;
  if v_candidate < v_year_start then v_candidate := null; end if;

  if v_projection_status is distinct from 'fresh'
    or v_projection_watermark is distinct from v_source_watermark
    or v_projection_data_version is distinct from v_data_version then
    v_status := 'projection_stale';
    v_reason := 'projection status, watermark, or data version is not current';
  elsif v_candidate is null then
    v_status := 'coverage_gap';
    v_reason := 'canonical complete coverage does not reach the first Ops Date of the year';
  elsif v_head_business_date > v_candidate then
    v_status := 'head_ahead';
    v_reason := 'current publication head is newer than the eligible coverage date';
  elsif v_head_business_date = v_candidate and v_head_watermark = v_source_watermark then
    v_status := 'already_current';
    v_reason := 'current publication already matches Business Date and source watermark';
  else
    v_metrics := public.get_public_traffic_report_v2(
      v_year_start,v_candidate,'all',array[]::text[],array[]::text[],array[]::text[],
      'none','local',v_source_watermark,'traffic-report-v2','timeline',p_now
    );
    v_timeline_days := jsonb_array_length(coalesce(v_metrics->'timeline','[]'::jsonb));
    select
      count(*) filter(where timeline.completeness='missing')::integer,
      count(*) filter(where timeline.completeness='partial')::integer
      into v_missing_days,v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics->'timeline','[]'::jsonb)) timeline(completeness text);
    v_flights := coalesce((v_metrics#>>'{current,flights}')::integer,0);
    v_due_legs := coalesce((v_metrics#>>'{current,due_legs}')::integer,0);
    v_reported_legs := coalesce((v_metrics#>>'{current,reported_legs}')::integer,0);
    v_missing_due_legs := coalesce((v_metrics#>>'{current,missing_due_legs}')::integer,0);
    v_reported_pax := (v_metrics#>>'{current,reported_pax}')::bigint;
    v_arrival_reported_pax := (v_metrics#>>'{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics#>>'{current,departure_reported_pax}')::bigint;
    select kpis.target_reported_pax into v_target
    from reporting.annual_passenger_kpis kpis where kpis.year=v_year;
    v_pax_coverage := case when v_due_legs>0 then round(v_reported_legs*100.0/v_due_legs,2) end;
    v_elapsed_days := v_candidate-v_year_start+1;
    v_eligible := v_timeline_days>0 and coalesce(v_missing_days,0)=0 and coalesce(v_partial_days,0)=0
      and v_due_legs=v_flights
      and (v_due_legs=0 or (v_reported_legs>0 and coalesce(v_pax_coverage,0)>=99.5))
      and ((v_reported_legs=0 and v_reported_pax is null
          and v_arrival_reported_pax is null and v_departure_reported_pax is null)
        or v_reported_pax=coalesce(v_arrival_reported_pax,0)+coalesce(v_departure_reported_pax,0));
    v_status := case when v_timeline_days=0 then 'empty'
      when v_eligible then 'ready_candidate' else 'maturity_incomplete' end;
    v_reason := case when v_eligible then 'candidate passed canonical coverage and maturity checks'
      when v_timeline_days=0 then 'candidate produced an empty canonical timeline'
      else 'candidate failed timeline, Pax coverage, KPI, or A+D maturity checks' end;
  end if;

  return jsonb_build_object(
    'eligible',v_eligible,'status',v_status,'reason',v_reason,
    'business_date',v_candidate,'latest_completed_ops_date',v_latest_completed,'year',v_year,
    'source_watermark',v_source_watermark,'data_version',v_data_version,'data_as_of',p_now,
    'projection_status',v_projection_status,'projection_watermark',v_projection_watermark,
    'projection_data_version',v_projection_data_version,'projection_refreshed_at',v_projection_refreshed_at,
    'head_publication_id',v_head_id,'head_business_date',v_head_business_date,'head_source_watermark',v_head_watermark,
    'timeline_days',v_timeline_days,'flights',v_flights,'due_legs',v_due_legs,
    'reported_legs',v_reported_legs,'missing_due_legs',v_missing_due_legs,
    'reported_pax',v_reported_pax,'arrival_reported_pax',v_arrival_reported_pax,
    'departure_reported_pax',v_departure_reported_pax,'pax_coverage_pct',v_pax_coverage,
    'idempotency_key',case when v_candidate is null then null else
      'annual-kpi:'||v_year::text||':'||v_candidate::text||':'||v_source_watermark::text end
  );
end;
$$;

create or replace function reporting.verify_public_dashboard_publication_v1(
  p_publication_id bigint,p_business_date date,p_source_watermark bigint,p_data_version integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, extensions, pg_temp
set statement_timeout='5s'
as $$
declare
  v_publication reporting.public_dashboard_publications%rowtype;
  v_head_id bigint;
  v_latest_id bigint;
  v_checksum_valid boolean;
  v_direction_valid boolean;
  v_missing_valid boolean;
  v_valid boolean;
begin
  select * into v_publication from reporting.public_dashboard_publications where id=p_publication_id;
  select heads.publication_id into v_head_id from reporting.public_dashboard_publication_heads heads
  where heads.dashboard_key='annual-passenger-kpi' and heads.year=extract(year from p_business_date)::integer;
  select attempts.id into v_latest_id from reporting.public_dashboard_publications attempts
  where attempts.dashboard_key='annual-passenger-kpi' and attempts.year=extract(year from p_business_date)::integer
  order by attempts.id desc limit 1;
  v_checksum_valid := v_publication.payload_checksum=
    encode(extensions.digest(convert_to(v_publication.payload::text,'UTF8'),'sha256'),'hex');
  v_direction_valid := case when coalesce((v_publication.payload->>'reported_legs')::integer,0)=0
    then v_publication.payload->>'reported_pax' is null
      and v_publication.payload->>'arrival_reported_pax' is null
      and v_publication.payload->>'departure_reported_pax' is null
    else (v_publication.payload->>'reported_pax')::bigint=
      coalesce((v_publication.payload->>'arrival_reported_pax')::bigint,0)+
      coalesce((v_publication.payload->>'departure_reported_pax')::bigint,0) end;
  v_missing_valid := (v_publication.payload->>'missing_due_legs')::integer=
    (v_publication.payload->>'due_legs')::integer-(v_publication.payload->>'reported_legs')::integer;
  v_valid := v_publication.status='ready' and v_head_id=p_publication_id and v_latest_id=p_publication_id
    and v_publication.business_date=p_business_date and v_publication.source_watermark=p_source_watermark
    and v_publication.source_data_version=p_data_version and coalesce(v_checksum_valid,false)
    and coalesce(v_direction_valid,false) and coalesce(v_missing_valid,false);
  return jsonb_build_object(
    'valid',v_valid,'publication_id',p_publication_id,'status',v_publication.status,
    'head_publication_id',v_head_id,'latest_publication_id',v_latest_id,
    'business_date',v_publication.business_date,'source_watermark',v_publication.source_watermark,
    'source_data_version',v_publication.source_data_version,'payload_checksum',v_publication.payload_checksum,
    'checksum_valid',v_checksum_valid,'direction_sum_valid',v_direction_valid,
    'missing_pax_tracked',v_missing_valid,'freshness',case when v_head_id=v_latest_id then 'fresh' else 'stale' end
  );
end;
$$;

create or replace function reporting.capture_public_traffic_daily_acceptance_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
begin
  perform reporting.accept_public_traffic_coverage_event_v1(
    new.server_seq,'canonical-daily-import-commit',coalesce(new.actor_user_id::text,'daily-import-commit')
  );
  perform pg_notify('public_dashboard_daily_wake','daily-import-committed');
  return new;
end;
$$;

alter function reporting.select_public_dashboard_candidate_v1(timestamptz) owner to postgres;
alter function reporting.verify_public_dashboard_publication_v1(bigint,date,bigint,integer) owner to postgres;
alter function reporting.capture_public_traffic_daily_acceptance_v1() owner to postgres;

revoke execute on function reporting.select_public_dashboard_candidate_v1(timestamptz)
  from public,anon,authenticated,service_role;
revoke execute on function reporting.verify_public_dashboard_publication_v1(bigint,date,bigint,integer)
  from public,anon,authenticated,service_role;
revoke execute on function reporting.capture_public_traffic_daily_acceptance_v1()
  from public,anon,authenticated,service_role;

comment on function reporting.select_public_dashboard_candidate_v1(timestamptz) is
  'Internal Candidate Selector for the hybrid Dashboard runner; applies Ops cutoff, coverage, projection and maturity gates without creating a publication attempt.';
comment on function reporting.verify_public_dashboard_publication_v1(bigint,date,bigint,integer) is
  'Internal Verifier for immutable Dashboard publication head, checksum, version, A+D and missing-Pax invariants.';
