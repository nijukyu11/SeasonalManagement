-- 20261008110000_operational_reporting_correction_v1.sql
-- Native Pax correction dirty marker, public_dashboard_daily_wake handling,
-- and cutover-aware correction candidate selector.

begin;

-- 1. Dynamic preimage capture for select_public_dashboard_correction_candidate_v1
create table if not exists reporting.operational_projection_migration_preimages_v1 (
  migration_tag text not null,
  function_schema text not null,
  function_name text not null,
  function_signature text not null,
  function_definition text not null,
  function_owner text not null,
  function_acl text,
  captured_at timestamp with time zone not null default clock_timestamp(),
  primary key (migration_tag, function_schema, function_name, function_signature)
);

revoke all on reporting.operational_projection_migration_preimages_v1 from public, anon, authenticated;
grant select, insert, update, delete on reporting.operational_projection_migration_preimages_v1 to service_role;

insert into reporting.operational_projection_migration_preimages_v1 (
  migration_tag,
  function_schema,
  function_name,
  function_signature,
  function_definition,
  function_owner,
  function_acl
)
select
  '20261008110000',
  n.nspname,
  p.proname,
  pg_catalog.oidvectortypes(p.proargtypes),
  pg_catalog.pg_get_functiondef(p.oid),
  r.rolname,
  p.proacl::text
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_roles r on r.oid = p.proowner
where n.nspname = 'reporting'
  and p.proname = 'select_public_dashboard_correction_candidate_v1'
on conflict (migration_tag, function_schema, function_name, function_signature)
do nothing;

-- Legacy helper capture for gate-OFF runtime delegation
do $$
declare
  v_fn text;
begin
  if not exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_correction_candidate_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'select_public_dashboard_correction_candidate_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(
        v_fn,
        'FUNCTION\s+([a-zA-Z_0-9]+\.)?select_public_dashboard_correction_candidate_v1\(',
        'FUNCTION reporting.legacy_select_public_dashboard_correction_candidate_v1(',
        'i'
      );
      execute v_fn;
    end if;
  end if;
end;
$$;

-- 2. Trigger function to capture native Pax corrections from public.operational_change_events
create or replace function reporting.capture_operational_pax_correction_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_ops_date date;
  v_year integer;
  v_old_ops_date date;
  v_old_year integer;
  v_base_watermark bigint;
  v_curr_rev bigint;
  v_generation bigint;
  v_from_date date;
  v_to_date date;
begin
  -- Default-OFF gate: when cutover is inactive, native mutations must not pollute legacy markers.
  if not reporting.is_operational_reader_cutover_active_v1() then
    return new;
  end if;

  -- Scope canonical relevant mutations correctly:
  -- Only operational legs with pax in changed_fields
  if new.target_type <> 'operationalLeg' then
    return new;
  end if;

  if not ('pax' = any(coalesce(new.changed_fields, array[]::text[]))) then
    return new;
  end if;

  -- unknown / NULL / 0 corrections count
  v_ops_date := new.operational_date;
  if v_ops_date is null then
    return new;
  end if;

  v_year := extract(year from v_ops_date)::integer;
  if v_year not between 2000 and 2200 then
    return new;
  end if;

  -- Inspect old operational_date if moved with pax
  v_old_ops_date := null;
  v_old_year := null;
  if new.before_state is not null and jsonb_typeof(new.before_state) = 'object' then
    begin
      v_old_ops_date := (new.before_state ->> 'operational_date')::date;
      if v_old_ops_date is not null then
        v_old_year := extract(year from v_old_ops_date)::integer;
        if v_old_year not between 2000 and 2200 then
          v_old_year := null;
          v_old_ops_date := null;
        end if;
      end if;
    exception when others then
      v_old_ops_date := null;
      v_old_year := null;
    end;
  end if;

  -- Calculate committed native generation compatible with publication watermark:
  -- Monotonic generation invariant: actual legacy max(server_seq) + current operational revision
  -- (same Report / publication domain; not projection state's older source_watermark if legacy events advanced).
  select coalesce(max(events.server_seq), 0)::bigint into v_base_watermark
  from public.season_change_events events;

  select revision into v_curr_rev
  from public.operational_workspace_revision
  where singleton;

  v_generation := coalesce(v_base_watermark, 0)::bigint + coalesce(v_curr_rev, 0)::bigint;
  v_generation := greatest(v_generation, coalesce(new.server_seq, 0)::bigint);

  -- Determine date bounds for current year
  if v_old_year is not null and v_old_year = v_year and v_old_ops_date is not null then
    v_from_date := least(v_old_ops_date, v_ops_date);
    v_to_date := greatest(v_old_ops_date, v_ops_date);
  else
    v_from_date := v_ops_date;
    v_to_date := v_ops_date;
  end if;

  -- Insert or update dirty marker for v_year
  insert into reporting.public_dashboard_dirty_markers as markers (
    dashboard_key, year, affected_from_date, affected_to_date,
    latest_event_seq, last_changed_at, next_attempt_at, status, updated_at
  ) values (
    'annual-passenger-kpi', v_year, v_from_date, v_to_date,
    v_generation, statement_timestamp(), statement_timestamp() + interval '2 minutes',
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

  -- If moved across different business years, dirty marker and wake notification for v_old_year as well
  if v_old_year is not null and v_old_year <> v_year and v_old_ops_date is not null then
    insert into reporting.public_dashboard_dirty_markers as markers (
      dashboard_key, year, affected_from_date, affected_to_date,
      latest_event_seq, last_changed_at, next_attempt_at, status, updated_at
    ) values (
      'annual-passenger-kpi', v_old_year, v_old_ops_date, v_old_ops_date,
      v_generation, statement_timestamp(), statement_timestamp() + interval '2 minutes',
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

    perform pg_notify('public_dashboard_daily_wake', 'pax-correction:' || v_old_year::text);
  end if;

  return new;
end;
$$;

revoke all on function reporting.capture_operational_pax_correction_v1() from public, anon, authenticated, service_role;

-- 3. Trigger on public.operational_change_events
-- Named with 'zzz_' to guarantee execution AFTER operational_capture_resource_overrides
drop trigger if exists capture_operational_pax_correction on public.operational_change_events;
drop trigger if exists operational_capture_zzz_pax_correction on public.operational_change_events;
create trigger operational_capture_zzz_pax_correction
after insert on public.operational_change_events
for each row
when (new.target_type = 'operationalLeg' and 'pax' = any(new.changed_fields))
execute function reporting.capture_operational_pax_correction_v1();

-- 4. Cutover-aware select_public_dashboard_correction_candidate_v1
create or replace function reporting.select_public_dashboard_correction_candidate_v1(
  p_now timestamptz default statement_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_marker reporting.public_dashboard_dirty_markers%rowtype;
  v_head_id bigint;
  v_business_date date;
  v_head_watermark bigint;
  v_op_status record;
  v_curr_op_rev bigint;
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
  v_pax_coverage numeric;
  v_target bigint;
  v_status text := 'unknown';
  v_eligible boolean := false;
  v_reason text;
begin
  -- When cutover is inactive, preserve exact legacy candidate selection
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_select_public_dashboard_correction_candidate_v1(p_now);
  end if;

  select *
  into v_marker
  from reporting.public_dashboard_dirty_markers markers
  where markers.dashboard_key = 'annual-passenger-kpi'
    and markers.status in ('dirty', 'retry', 'processing')
  order by
    case when markers.status = 'retry' then 1
         when markers.status = 'dirty' then 2
         else 3 end,
    markers.last_changed_at asc
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

  select * into v_op_status from reporting.operational_projection_status_v1();
  select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
  v_source_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
  v_data_version := coalesce(v_curr_op_rev, 0)::integer;
  v_projection_status := case when coalesce(v_op_status.is_fresh, false) then 'fresh' else 'stale' end;
  v_projection_watermark := v_source_watermark;
  v_projection_data_version := v_data_version;
  v_projection_refreshed_at := v_op_status.refreshed_at;

  if v_head_watermark >= v_marker.latest_event_seq then
    v_status := 'already_current';
    v_reason := 'the current publication already covers the durable correction marker';
  elsif v_projection_status is distinct from 'fresh'
    or v_projection_watermark is distinct from v_source_watermark then
    v_status := 'projection_stale';
    v_reason := 'projection status, watermark, or data version is not current';
  else
    v_metrics := public.get_public_annual_passenger_kpi_v1(v_marker.year, v_business_date);
    v_timeline_days := coalesce(jsonb_array_length(v_metrics -> 'timeline'), 0);
    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) as timeline(completeness text);

    v_flights := coalesce((v_metrics #>> '{current,flights}')::integer, 0);
    v_due_legs := coalesce((v_metrics #>> '{current,due_legs}')::integer, 0);
    v_reported_legs := coalesce((v_metrics #>> '{current,reported_legs}')::integer, 0);
    v_missing_due_legs := coalesce((v_metrics #>> '{current,missing_due_legs}')::integer, 0);
    v_reported_pax := (v_metrics #>> '{current,reported_pax}')::bigint;
    v_pax_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) else 0 end;

    select target_reported_pax into v_target
    from reporting.annual_passenger_kpis
    where year = v_marker.year;

    if v_timeline_days = 0 then
      v_status := 'missing_timeline';
      v_reason := 'the candidate year has no timeline entries';
    elsif v_missing_days > 0 then
      v_status := 'missing_days';
      v_reason := 'one or more past dates in the candidate year are completely missing';
    elsif v_due_legs = 0 or v_reported_legs = 0 then
      v_status := 'maturity_incomplete';
      v_reason := 'the candidate business date has zero legs';
    elsif v_pax_coverage < 99.5 then
      v_status := 'maturity_incomplete';
      v_reason := 'passenger coverage is below the 99.5% publishing threshold';
    elsif v_missing_due_legs > 0 then
      v_status := 'maturity_incomplete';
      v_reason := 'one or more due flights have missing pax data';
    elsif v_target is null or v_reported_pax is null then
      v_status := 'maturity_incomplete';
      v_reason := 'annual target or reported pax is missing';
    else
      v_status := 'correction_ready';
      v_eligible := true;
      v_reason := 'durable correction is verified and ready to republish';
    end if;
  end if;

  return jsonb_build_object(
    'eligible', v_eligible,
    'status', v_status,
    'reason', v_reason,
    'trigger_kind', 'manual_correction',
    'marker_id', v_marker.id,
    'year', v_marker.year,
    'affected_from_date', v_marker.affected_from_date,
    'affected_to_date', v_marker.affected_to_date,
    'latest_event_seq', v_marker.latest_event_seq,
    'candidate_date', case when v_eligible then v_business_date end,
    'publication_id', v_head_id,
    'head_business_date', v_business_date,
    'head_watermark', v_head_watermark,
    'source_watermark', v_source_watermark,
    'data_version', v_data_version,
    'projection_status', v_projection_status,
    'projection_watermark', v_projection_watermark,
    'projection_data_version', v_projection_data_version,
    'projection_refreshed_at', v_projection_refreshed_at,
    'flights', v_flights,
    'due_legs', v_due_legs,
    'reported_legs', v_reported_legs,
    'missing_due_legs', v_missing_due_legs,
    'reported_pax', v_reported_pax,
    'pax_coverage_pct', v_pax_coverage,
    'idempotency_key', case when v_eligible then
      'annual-kpi-correction:' || v_marker.year::text || ':' || v_business_date::text || ':' || v_source_watermark::text
    end
  );
end;
$$;

revoke all on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz)
from public, anon, authenticated, service_role;
grant execute on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz)
to service_role;

commit;
