-- Durable Dashboard correction orchestration for per-cell Daily Pax auto-save.
--
-- Pax values from a completed, canonically accepted Ops Date are reportable as
-- soon as they are known. The existing T+24 rule remains the deadline that
-- turns a NULL Pax into an overdue missing value.

do $migration$
declare
  v_metrics_signature regprocedure :=
    'public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure;
  v_definition text;
  v_old text := $old$      ranked.scheduled_local_at,
      ranked.scheduled_local_at + interval '1 day' <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh') as is_due$old$;
  v_new text := $new$      ranked.scheduled_local_at,
      case
        when ranked.effective_pax is not null
          and ranked.ops_date <= v_latest_completed
          and exists (
            select 1
            from reporting.public_traffic_coverage accepted_coverage
            where accepted_coverage.status = 'complete'
              and ranked.ops_date between accepted_coverage.from_date and accepted_coverage.to_date
          )
          then true
        else ranked.scheduled_local_at + interval '1 day'
          <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')
      end as is_due$new$;
begin
  select pg_get_functiondef(v_metrics_signature) into v_definition;
  if strpos(v_definition, v_new) = 0 then
    if strpos(v_definition, v_old) = 0 then
      raise exception 'unexpected live traffic Pax maturity definition; correction migration refused';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$migration$;

do $migration$
declare
  v_mutation_signature regprocedure := to_regprocedure('public.apply_season_server_mutation_v1(jsonb)');
  v_definition text;
  v_old text := $old$    v_changed_fields := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_operation->'changedFields', v_operation->'changed_fields', '[]'::jsonb))),
      '{}'
    );$old$;
  v_new text := $new$    v_changed_fields := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_operation->'changedFields', v_operation->'changed_fields', '[]'::jsonb))),
      '{}'
    );
    if cardinality(v_changed_fields) = 0 and v_operation_type = 'modification' then
      select coalesce(array_agg(fields.field_name order by fields.field_name), array[]::text[])
      into v_changed_fields
      from jsonb_object_keys(coalesce(v_op_payload->'mod', '{}'::jsonb)) fields(field_name)
      where fields.field_name not in ('legId', 'action');
    end if;$new$;
begin
  if v_mutation_signature is null then
    return;
  end if;
  select pg_get_functiondef(v_mutation_signature) into v_definition;
  if strpos(v_definition, v_new) = 0 then
    if strpos(v_definition, v_old) = 0 then
      raise exception 'unexpected server mutation changed-fields definition; correction migration refused';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$migration$;

create table if not exists reporting.public_dashboard_dirty_markers (
  id bigint generated always as identity primary key,
  dashboard_key text not null,
  year integer not null check (year between 2000 and 2200),
  affected_from_date date not null,
  affected_to_date date not null,
  latest_event_seq bigint not null check (latest_event_seq > 0),
  last_changed_at timestamptz not null,
  next_attempt_at timestamptz not null,
  status text not null default 'dirty'
    check (status in ('dirty', 'processing', 'retry', 'applied')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_error_at timestamptz,
  applied_publication_id bigint references reporting.public_dashboard_publications(id),
  applied_watermark bigint,
  updated_at timestamptz not null default statement_timestamp(),
  unique (dashboard_key, year),
  check (affected_from_date <= affected_to_date),
  check (extract(year from affected_from_date)::integer = year),
  check (extract(year from affected_to_date)::integer = year)
);

create index if not exists public_dashboard_dirty_markers_pending_idx
  on reporting.public_dashboard_dirty_markers(next_attempt_at, last_changed_at)
  where status in ('dirty', 'retry');

create or replace function reporting.capture_public_dashboard_pax_correction_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_operation jsonb := coalesce(new.op_payload->'operation', '{}'::jsonb);
  v_source text := coalesce(new.op_payload->>'source', '');
  v_is_pax_change boolean;
  v_ops_date date;
  v_year integer;
begin
  if new.target_type <> 'modification' or v_source <> 'daily' then
    return new;
  end if;

  v_is_pax_change := 'pax' = any(coalesce(new.changed_fields, array[]::text[]))
    or (
      new.op_payload->>'kind' = 'apply_season_server_mutation_v1'
      and v_operation->>'type' = 'modification'
      and jsonb_typeof(v_operation->'mod') = 'object'
      and v_operation->'mod' ? 'pax'
    );
  if not v_is_pax_change then
    return new;
  end if;

  select public.canonical_flight_leg_ops_date_v1(
    records.operational_date,
    records.scheduled_date,
    records.date,
    case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
      then modifications.schedule else records.scheduled_time end,
    case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
      then modifications.schedule else records.schedule end
  )
  into v_ops_date
  from public.season_flight_records records
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where records.season_id = new.season_id
    and records.record_id = new.target_id
    and public.is_canonical_flight_leg_active_v1(records.status, records.action)
    and coalesce(modifications.action, 'modified') <> 'deleted';

  if v_ops_date is null then
    return new;
  end if;
  v_year := extract(year from v_ops_date)::integer;

  insert into reporting.public_dashboard_dirty_markers as markers (
    dashboard_key, year, affected_from_date, affected_to_date,
    latest_event_seq, last_changed_at, next_attempt_at, status, updated_at
  ) values (
    'annual-passenger-kpi', v_year, v_ops_date, v_ops_date,
    new.server_seq, statement_timestamp(), statement_timestamp() + interval '2 minutes',
    'dirty', statement_timestamp()
  )
  on conflict (dashboard_key, year) do update set
    affected_from_date = case when markers.status = 'applied'
      then excluded.affected_from_date else least(markers.affected_from_date, excluded.affected_from_date) end,
    affected_to_date = case when markers.status = 'applied'
      then excluded.affected_to_date else greatest(markers.affected_to_date, excluded.affected_to_date) end,
    latest_event_seq = greatest(markers.latest_event_seq, excluded.latest_event_seq),
    last_changed_at = excluded.last_changed_at,
    next_attempt_at = excluded.next_attempt_at,
    status = 'dirty',
    attempt_count = case when markers.status = 'applied' then 0 else markers.attempt_count end,
    last_error_code = null,
    last_error_at = null,
    applied_publication_id = case when markers.status = 'applied'
      then markers.applied_publication_id else null end,
    applied_watermark = case when markers.status = 'applied'
      then markers.applied_watermark else null end,
    updated_at = excluded.updated_at;

  perform pg_notify('public_dashboard_daily_wake', 'pax-correction:' || v_year::text);
  return new;
end;
$$;

drop trigger if exists capture_public_dashboard_pax_correction on public.season_change_events;
create trigger capture_public_dashboard_pax_correction
after insert on public.season_change_events
for each row
execute function reporting.capture_public_dashboard_pax_correction_v1();

create or replace function reporting.select_public_dashboard_correction_candidate_v1(
  p_now timestamptz default statement_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_marker reporting.public_dashboard_dirty_markers%rowtype;
  v_head_id bigint;
  v_business_date date;
  v_head_watermark bigint;
  v_source_watermark bigint;
  v_data_version integer;
  v_projection_status text;
  v_projection_watermark bigint;
  v_projection_data_version integer;
  v_projection_refreshed_at timestamptz;
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
  v_pax_coverage numeric;
  v_eligible boolean := false;
  v_status text;
  v_reason text;
begin
  if p_now is null then
    raise exception 'candidate as-of must not be null' using errcode = '22004';
  end if;

  select markers.* into v_marker
  from reporting.public_dashboard_dirty_markers markers
  where markers.dashboard_key = 'annual-passenger-kpi'
    and markers.status in ('dirty', 'retry')
  order by markers.last_changed_at, markers.id
  limit 1;

  if not found then
    return jsonb_build_object(
      'eligible', false, 'status', 'no_correction',
      'reason', 'no durable Dashboard correction marker is pending',
      'trigger_kind', 'daily_acceptance'
    );
  end if;

  if p_now < greatest(v_marker.next_attempt_at, v_marker.last_changed_at + interval '2 minutes') then
    return jsonb_build_object(
      'eligible', false, 'status', 'debouncing',
      'reason', 'waiting for the two-minute correction quiet window',
      'trigger_kind', 'manual_correction', 'marker_id', v_marker.id,
      'year', v_marker.year, 'latest_event_seq', v_marker.latest_event_seq,
      'retry_at', greatest(v_marker.next_attempt_at, v_marker.last_changed_at + interval '2 minutes')
    );
  end if;

  select heads.publication_id, publications.business_date, publications.source_watermark
  into v_head_id, v_business_date, v_head_watermark
  from reporting.public_dashboard_publication_heads heads
  join reporting.public_dashboard_publications publications on publications.id = heads.publication_id
  where heads.dashboard_key = v_marker.dashboard_key and heads.year = v_marker.year;

  if v_head_id is null or v_marker.affected_to_date > v_business_date then
    return jsonb_build_object(
      'eligible', false, 'status', 'defer_to_daily',
      'reason', case when v_head_id is null
        then 'no current publication head exists for the correction year'
        else 'the correction is later than the current publication head' end,
      'trigger_kind', 'daily_acceptance', 'marker_id', v_marker.id,
      'year', v_marker.year, 'affected_to_date', v_marker.affected_to_date,
      'head_publication_id', v_head_id, 'head_business_date', v_business_date
    );
  end if;

  select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
  from public.season_change_events events;
  select coalesce(max(seasons.data_version), 0)::integer into v_data_version
  from public.seasons seasons;
  select state.status, state.source_watermark, state.source_data_version, state.refreshed_at
  into v_projection_status, v_projection_watermark, v_projection_data_version, v_projection_refreshed_at
  from reporting.public_traffic_projection_state state
  where state.projection_name = 'public_traffic_effective';

  if v_head_watermark >= v_marker.latest_event_seq then
    v_status := 'already_current';
    v_reason := 'the current publication already covers the durable correction marker';
  elsif v_projection_status is distinct from 'fresh'
    or v_projection_watermark is distinct from v_source_watermark
    or v_projection_data_version is distinct from v_data_version then
    v_status := 'projection_stale';
    v_reason := 'projection status, watermark, or data version is not current';
  else
    v_metrics := public.get_public_traffic_report_v2(
      make_date(v_marker.year, 1, 1), v_business_date, 'all',
      array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', v_source_watermark, 'traffic-report-v2', 'timeline', p_now
    );
    v_timeline_days := jsonb_array_length(coalesce(v_metrics->'timeline', '[]'::jsonb));
    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics->'timeline', '[]'::jsonb))
      timeline(completeness text);
    v_flights := coalesce((v_metrics#>>'{current,flights}')::integer, 0);
    v_due_legs := coalesce((v_metrics#>>'{current,due_legs}')::integer, 0);
    v_reported_legs := coalesce((v_metrics#>>'{current,reported_legs}')::integer, 0);
    v_missing_due_legs := coalesce((v_metrics#>>'{current,missing_due_legs}')::integer, 0);
    v_reported_pax := (v_metrics#>>'{current,reported_pax}')::bigint;
    v_arrival_reported_pax := (v_metrics#>>'{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics#>>'{current,departure_reported_pax}')::bigint;
    v_pax_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) end;
    v_eligible := v_timeline_days > 0
      and coalesce(v_missing_days, 0) = 0
      and coalesce(v_partial_days, 0) = 0
      and v_due_legs = v_flights
      and (v_due_legs = 0 or (v_reported_legs > 0 and coalesce(v_pax_coverage, 0) >= 99.5))
      and (
        (v_reported_legs = 0 and v_reported_pax is null
          and v_arrival_reported_pax is null and v_departure_reported_pax is null)
        or v_reported_pax = coalesce(v_arrival_reported_pax, 0)
          + coalesce(v_departure_reported_pax, 0)
      );
    v_status := case when v_timeline_days = 0 then 'empty'
      when v_eligible then 'correction_ready' else 'maturity_incomplete' end;
    v_reason := case when v_eligible
      then 'historical correction passed canonical coverage, maturity, Pax, and A+D checks'
      when v_timeline_days = 0 then 'correction produced an empty canonical timeline'
      else 'correction failed timeline, Pax coverage, or A+D maturity checks' end;
  end if;

  return jsonb_build_object(
    'eligible', v_eligible, 'status', v_status, 'reason', v_reason,
    'trigger_kind', 'manual_correction', 'marker_id', v_marker.id,
    'year', v_marker.year, 'business_date', v_business_date,
    'affected_from_date', v_marker.affected_from_date,
    'affected_to_date', v_marker.affected_to_date,
    'latest_event_seq', v_marker.latest_event_seq,
    'source_watermark', v_source_watermark, 'data_version', v_data_version,
    'data_as_of', p_now, 'projection_status', v_projection_status,
    'projection_watermark', v_projection_watermark,
    'projection_data_version', v_projection_data_version,
    'projection_refreshed_at', v_projection_refreshed_at,
    'head_publication_id', v_head_id, 'head_business_date', v_business_date,
    'head_source_watermark', v_head_watermark,
    'timeline_days', v_timeline_days, 'flights', v_flights,
    'due_legs', v_due_legs, 'reported_legs', v_reported_legs,
    'missing_due_legs', v_missing_due_legs,
    'reported_pax', v_reported_pax,
    'arrival_reported_pax', v_arrival_reported_pax,
    'departure_reported_pax', v_departure_reported_pax,
    'pax_coverage_pct', v_pax_coverage,
    'idempotency_key', 'annual-kpi:' || v_marker.year::text || ':'
      || v_business_date::text || ':' || v_source_watermark::text
  );
end;
$$;

create or replace function reporting.acknowledge_public_dashboard_corrections_v1(
  p_year integer,
  p_publication_id bigint,
  p_source_watermark bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_acknowledged integer := 0;
  v_remaining integer := 0;
begin
  if not exists (
    select 1
    from reporting.public_dashboard_publication_heads heads
    join reporting.public_dashboard_publications publications on publications.id = heads.publication_id
    where heads.dashboard_key = 'annual-passenger-kpi'
      and heads.year = p_year
      and heads.publication_id = p_publication_id
      and publications.status = 'ready'
      and publications.source_watermark = p_source_watermark
  ) then
    raise exception 'ready Dashboard publication head does not match correction acknowledgement'
      using errcode = '40001';
  end if;

  update reporting.public_dashboard_dirty_markers markers
  set status = 'applied',
      applied_publication_id = p_publication_id,
      applied_watermark = p_source_watermark,
      next_attempt_at = statement_timestamp(),
      last_error_code = null,
      last_error_at = null,
      updated_at = statement_timestamp()
  where markers.dashboard_key = 'annual-passenger-kpi'
    and markers.year = p_year
    and markers.status in ('dirty', 'retry', 'processing')
    and markers.latest_event_seq <= p_source_watermark;
  get diagnostics v_acknowledged = row_count;

  select count(*)::integer into v_remaining
  from reporting.public_dashboard_dirty_markers markers
  where markers.dashboard_key = 'annual-passenger-kpi'
    and markers.year = p_year
    and markers.status in ('dirty', 'retry', 'processing');

  return jsonb_build_object(
    'acknowledged', v_acknowledged,
    'remaining', v_remaining,
    'year', p_year,
    'publication_id', p_publication_id,
    'source_watermark', p_source_watermark
  );
end;
$$;

create or replace function reporting.defer_public_dashboard_correction_v1(
  p_marker_id bigint,
  p_error_code text,
  p_retry_after interval default interval '15 minutes'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_marker reporting.public_dashboard_dirty_markers%rowtype;
begin
  if p_error_code is null or length(btrim(p_error_code)) < 2 or length(p_error_code) > 120 then
    raise exception 'correction error code must contain 2..120 characters' using errcode = '22023';
  end if;
  if p_retry_after is null or p_retry_after < interval '1 minute' or p_retry_after > interval '1 day' then
    raise exception 'correction retry interval must be between 1 minute and 1 day' using errcode = '22023';
  end if;

  update reporting.public_dashboard_dirty_markers markers
  set status = 'retry',
      attempt_count = markers.attempt_count + 1,
      last_error_code = btrim(p_error_code),
      last_error_at = statement_timestamp(),
      next_attempt_at = statement_timestamp() + p_retry_after,
      updated_at = statement_timestamp()
  where markers.id = p_marker_id
    and markers.status in ('dirty', 'retry', 'processing')
  returning markers.* into v_marker;

  return case when v_marker.id is null then jsonb_build_object(
    'updated', false, 'marker_id', p_marker_id
  ) else jsonb_build_object(
    'updated', true, 'marker_id', v_marker.id,
    'status', v_marker.status, 'attempt_count', v_marker.attempt_count,
    'next_attempt_at', v_marker.next_attempt_at,
    'last_error_code', v_marker.last_error_code
  ) end;
end;
$$;

alter table reporting.public_dashboard_dirty_markers owner to postgres;
alter function reporting.capture_public_dashboard_pax_correction_v1() owner to postgres;
alter function reporting.select_public_dashboard_correction_candidate_v1(timestamptz) owner to postgres;
alter function reporting.acknowledge_public_dashboard_corrections_v1(integer,bigint,bigint) owner to postgres;
alter function reporting.defer_public_dashboard_correction_v1(bigint,text,interval) owner to postgres;

revoke all on reporting.public_dashboard_dirty_markers from public, anon, authenticated, service_role;
revoke execute on function reporting.capture_public_dashboard_pax_correction_v1()
  from public, anon, authenticated, service_role;
revoke execute on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function reporting.acknowledge_public_dashboard_corrections_v1(integer,bigint,bigint)
  from public, anon, authenticated, service_role;
revoke execute on function reporting.defer_public_dashboard_correction_v1(bigint,text,interval)
  from public, anon, authenticated, service_role;

comment on table reporting.public_dashboard_dirty_markers is
  'Durable coalescing state for Dashboard corrections; immutable publication attempts remain in the Publication Ledger.';
comment on function reporting.capture_public_dashboard_pax_correction_v1() is
  'Captures committed per-cell Daily Pax corrections into a durable marker and emits a transactional wake.';
comment on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz) is
  'Internal correction Candidate Selector; republish historical corrections at the current ready Business Date after a two-minute quiet window.';
comment on function reporting.acknowledge_public_dashboard_corrections_v1(integer,bigint,bigint) is
  'Conditionally acknowledges only correction markers covered by the verified ready publication watermark.';
