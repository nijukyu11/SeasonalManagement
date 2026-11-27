-- 20261105101000_operational_reporting_correction_selector_contract_v1.sql
-- Fix operational reporting correction candidate selector contract:
-- 1. Preserve live deployment preimage dynamically in reporting.operational_projection_migration_preimages_v1.
-- 2. Call public.get_public_traffic_report_v2 (timeline scope) instead of get_public_annual_passenger_kpi_v1
--    to obtain timeline completeness and current metrics objects.
-- 3. Supply full runner contract fields: business_date, head_publication_id, head_source_watermark,
--    and standard idempotency key format 'annual-kpi:year:date:watermark'.
-- 4. Maintain gate OFF parity delegation to legacy selector when reader cutover is inactive.

begin;

-- Capture deployment preimage for byte-exact rollback preservation
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
  '20261105101000',
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
do update set
  function_definition = excluded.function_definition,
  function_owner = excluded.function_owner,
  function_acl = excluded.function_acl,
  captured_at = excluded.captured_at;

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
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
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

  if p_now is null then
    raise exception 'candidate as-of must not be null' using errcode = '22004';
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
    v_metrics := public.get_public_traffic_report_v2(
      make_date(v_marker.year, 1, 1), v_business_date, 'all',
      array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', v_source_watermark, 'traffic-report-v2', 'timeline', p_now
    );
    v_timeline_days := jsonb_array_length(coalesce(v_metrics -> 'timeline', '[]'::jsonb));
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
    v_arrival_reported_pax := (v_metrics #>> '{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics #>> '{current,departure_reported_pax}')::bigint;
    v_pax_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) else 0 end;

    select target_reported_pax into v_target
    from reporting.annual_passenger_kpis
    where year = v_marker.year;

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
      then 'durable correction is verified and ready to republish'
      when v_timeline_days = 0 then 'the candidate year has no timeline entries'
      when coalesce(v_missing_days, 0) > 0 or coalesce(v_partial_days, 0) > 0
        then 'timeline has missing or partial days'
      when v_due_legs <> v_flights then 'flight count does not match due legs'
      when v_due_legs > 0 and coalesce(v_pax_coverage, 0) < 99.5
        then 'passenger coverage is below the 99.5% publishing threshold'
      else 'A+D Pax sum does not match total reported Pax' end;
  end if;

  return jsonb_build_object(
    'eligible', v_eligible,
    'status', v_status,
    'reason', v_reason,
    'trigger_kind', 'manual_correction',
    'marker_id', v_marker.id,
    'year', v_marker.year,
    'business_date', v_business_date,
    'candidate_date', case when v_eligible then v_business_date end,
    'affected_from_date', v_marker.affected_from_date,
    'affected_to_date', v_marker.affected_to_date,
    'latest_event_seq', v_marker.latest_event_seq,
    'publication_id', v_head_id,
    'head_publication_id', v_head_id,
    'head_business_date', v_business_date,
    'head_watermark', v_head_watermark,
    'head_source_watermark', v_head_watermark,
    'source_watermark', v_source_watermark,
    'data_version', v_data_version,
    'data_as_of', p_now,
    'projection_status', v_projection_status,
    'projection_watermark', v_projection_watermark,
    'projection_data_version', v_projection_data_version,
    'projection_refreshed_at', v_projection_refreshed_at,
    'timeline_days', v_timeline_days,
    'flights', v_flights,
    'due_legs', v_due_legs,
    'reported_legs', v_reported_legs,
    'missing_due_legs', v_missing_due_legs,
    'reported_pax', v_reported_pax,
    'arrival_reported_pax', v_arrival_reported_pax,
    'departure_reported_pax', v_departure_reported_pax,
    'pax_coverage_pct', v_pax_coverage,
    'idempotency_key', case when v_eligible then
      'annual-kpi:' || v_marker.year::text || ':' || v_business_date::text || ':' || v_source_watermark::text
    end
  );
end;
$$;

revoke all on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz)
from public, anon, authenticated, service_role;
grant execute on function reporting.select_public_dashboard_correction_candidate_v1(timestamptz)
to service_role;

commit;
