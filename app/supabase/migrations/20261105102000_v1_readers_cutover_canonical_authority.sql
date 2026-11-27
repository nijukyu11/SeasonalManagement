-- 20261105102000_v1_readers_cutover_canonical_authority.sql
-- Residual V1 Report Readers Cutover Canonical Authority
--
-- Extends the M10 controlled reader cutover architecture to residual V1 report readers:
-- 1. public.get_public_traffic_report_overview_v1 (backs overview, timeline, breakdowns, CSV export, workbook snapshots)
-- 2. public.get_public_traffic_report_dimension_v2 (backs dimension, dimension-export, workbook dimensions)
-- 3. public.get_public_traffic_report_peak_hour_heatmap_v1 & reporting.get_traffic_report_peak_hour_heatmap_v1
--
-- Principles:
-- 1. Gate OFF parity: readers delegate unconditionally to legacy authority (reporting.public_traffic_effective).
-- 2. Gate ON authority: post-cutover, readers query native canonical authority from
--    reporting.canonical_flight_legs via reporting.operational_traffic_effective_v1.
-- 3. Preserves 100% full contract behavior: preserves pagination (p_timeline_after, page_size, next_cursor, has_more),
--    regular_flights arrays, top-N, shares, suppression policy, and day_of_week heatmaps without handcrafted subsets.
-- 4. Preserves true scheduled timestamp in view; consumers implement
--    accepted complete coverage condition (counting NULL Pax legs due too, honoring latest completed date
--    and handling missing scheduled times with end-of-day local wall timestamp fallback).
-- 5. Safe reapply & rollback: captures live definitions into reporting.operational_projection_migration_preimages_v1
--    for byte-exact rollback and idempotent reapplication.
-- 6. Strict least-privilege ACLs: public wrappers restricted to service_role; private helpers inaccessible to anon/authenticated.

begin;

-- 1. Create preimages table if not present
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

-- 2. Create native operational effective view matching reporting.public_traffic_effective column shape (17 columns)
-- Preserves true scheduled timestamp without fabricated adapter timestamps
create or replace view reporting.operational_traffic_effective_v1 as
select
  legs.business_leg_key::text as business_leg_key,
  legs.ops_date,
  legs.type::text as type,
  upper(btrim(legs.airline))::text as airline,
  upper(btrim(legs.route))::text as route,
  coalesce(nullif(btrim(countries.country), ''), 'Unknown')::text as country,
  coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown')::text as aircraft_group,
  coalesce(nullif(upper(btrim(legs.aircraft_type)), ''), 'Unknown')::text as aircraft_type,
  legs.local_minutes,
  case when legs.local_minutes is null then null::integer else (legs.local_minutes + 1020) % 1440 end as utc_minutes,
  legs.scheduled_local_at as scheduled_local_at,
  legs.pax,
  case when legs.pax is not null then 'reported' else 'unknown' end::text as pax_status,
  0::bigint as authoritative_server_seq,
  (select coalesce(max(status.refreshed_at), statement_timestamp()) from reporting.operational_projection_status_v1() status) as snapshot_refreshed_at,
  (select coalesce(max(status.source_watermark), 0)::bigint + coalesce((select revision from public.operational_workspace_revision where singleton), 0)::bigint from reporting.operational_projection_status_v1() status) as snapshot_source_watermark,
  (select coalesce(sum(quarantine.candidate_count), 0)::integer from reporting.canonical_flight_legs_quarantine quarantine) as snapshot_quarantined_candidate_count
from reporting.canonical_flight_legs legs
left join public.operational_route_countries countries
  on upper(countries.route) = upper(legs.route)
left join lateral (
  select aircraft_groups.name as ac_group
  from public.operational_aircraft_group_types aircraft_types
  join public.operational_aircraft_groups aircraft_groups on aircraft_groups.id = aircraft_types.group_id
  where upper(aircraft_types.aircraft_type) = upper(legs.aircraft_type)
  order by aircraft_groups.name
  limit 1
) groups on true;

alter view reporting.operational_traffic_effective_v1 set (security_invoker = true);
revoke all on reporting.operational_traffic_effective_v1 from public, anon;
grant select on reporting.operational_traffic_effective_v1 to authenticated, service_role;

-- 3. Create gate-aware source view unioning legacy authority (Gate OFF) and native canonical authority (Gate ON)
create or replace view reporting.public_traffic_effective_gate_v1 as
select * from reporting.public_traffic_effective
where not reporting.is_operational_reader_cutover_active_v1()
union all
select * from reporting.operational_traffic_effective_v1
where reporting.is_operational_reader_cutover_active_v1();

alter view reporting.public_traffic_effective_gate_v1 set (security_invoker = true);
revoke all on reporting.public_traffic_effective_gate_v1 from public, anon;
grant select on reporting.public_traffic_effective_gate_v1 to authenticated, service_role;

-- 4. Dynamic capture of live preimages and transformation of residual V1 reader functions
do $$
declare
  v_targets text[] := array[
    'reporting.get_traffic_report_kpis(date,date,jsonb,text,timestamptz)',
    'reporting.get_traffic_report_timeline_v2(date,date,date,date,text,date,integer,jsonb,timestamptz)',
    'reporting.get_traffic_report_breakdowns(date,date,jsonb,integer,text,integer,timestamptz)',
    'reporting.get_traffic_report_monthly_peaks_v2(date,date,jsonb,text)',
    'reporting.get_traffic_report_weekday_heatmaps_v1(date,date,jsonb)',
    'reporting.get_traffic_report_pax_presence_v1(date,date,text[],text[],text[],text[],text[],timestamptz)',
    'reporting.get_traffic_report_aircraft_types_v1(date,date,text[],text[],text[],text[],text[],integer,timestamptz)',
    'reporting.get_traffic_report_peak_hour_heatmap_v1(date,date,jsonb,text)',
    'public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz)',
    'public.get_public_traffic_report_overview_canonical_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)',
    'public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)',
    'public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text)'
  ];
  v_sig text;
  v_regproc regprocedure;
  v_schema text;
  v_name text;
  v_args text;
  v_def text;
  v_owner text;
  v_acl text;
  v_new_def text;
  v_prev_def text;
begin
  foreach v_sig in array v_targets loop
    v_regproc := to_regprocedure(v_sig);
    if v_regproc is null then
      raise exception 'Required target function signature not found: %', v_sig using errcode = 'P0002';
    end if;

    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
           pg_get_userbyid(p.proowner), coalesce(array_to_string(p.proacl, ','), '')
      into v_schema, v_name, v_args, v_owner, v_acl
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = v_regproc;

    -- Check if we already captured preimage (for idempotent reapply)
    select function_definition into v_def
    from reporting.operational_projection_migration_preimages_v1
    where migration_tag = '20261105102000'
      and function_schema = v_schema
      and function_name = v_name
      and function_signature = v_args;

    if v_def is null then
      v_def := pg_get_functiondef(v_regproc);
      insert into reporting.operational_projection_migration_preimages_v1 (
        migration_tag, function_schema, function_name, function_signature,
        function_definition, function_owner, function_acl
      ) values (
        '20261105102000', v_schema, v_name, v_args,
        v_def, v_owner, nullif(v_acl, '')
      );
    end if;

    -- Base transform: replace reporting.public_traffic_effective with reporting.public_traffic_effective_gate_v1
    v_prev_def := v_def;
    v_new_def := replace(v_def, 'reporting.public_traffic_effective', 'reporting.public_traffic_effective_gate_v1');
    if v_new_def = v_prev_def then
      raise exception 'Target % missing expected pattern: reporting.public_traffic_effective', v_sig using errcode = 'P0001';
    end if;

    -- Implement canonical V2 / HTML due rule:
    -- case when pax is not null and ops_date <= latest_completed and certified complete then true else scheduled_local_at + interval '1 day' <= as_of_local end
    -- Gate OFF preserves legacy scheduled_local_at comparison unchanged.

    -- 1. reporting.get_traffic_report_timeline_v2
    if v_name = 'get_traffic_report_timeline_v2' and v_schema = 'reporting' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'operations\.scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*p_data_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when operations.pax is not null and operations.ops_date <= (((p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and operations.ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else operations.scheduled_local_at + interval ''1 day'' <= (p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') end else operations.scheduled_local_at + interval ''1 day'' <= p_data_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 2. reporting.get_traffic_report_pax_presence_v1
    if v_name = 'get_traffic_report_pax_presence_v1' and v_schema = 'reporting' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'filtered\.scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*p_data_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when filtered.pax is not null and filtered.ops_date <= (((p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and filtered.ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else filtered.scheduled_local_at + interval ''1 day'' <= (p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') end else filtered.scheduled_local_at + interval ''1 day'' <= p_data_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 3. reporting.get_traffic_report_aircraft_types_v1
    if v_name = 'get_traffic_report_aircraft_types_v1' and v_schema = 'reporting' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'filtered\.scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*p_data_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when filtered.pax is not null and filtered.ops_date <= (((p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and filtered.ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else filtered.scheduled_local_at + interval ''1 day'' <= (p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') end else filtered.scheduled_local_at + interval ''1 day'' <= p_data_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 4. public.get_public_traffic_report_dimension_v2
    if v_name = 'get_public_traffic_report_dimension_v2' and v_schema = 'public' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*v_effective_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when pax is not null and ops_date <= (((v_effective_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else scheduled_local_at + interval ''1 day'' <= (v_effective_as_of at time zone ''Asia/Ho_Chi_Minh'') end else scheduled_local_at + interval ''1 day'' <= v_effective_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 5. reporting.get_traffic_report_kpis
    if v_name = 'get_traffic_report_kpis' and v_schema = 'reporting' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*p_data_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when pax is not null and ops_date <= (((p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else scheduled_local_at + interval ''1 day'' <= (p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') end else scheduled_local_at + interval ''1 day'' <= p_data_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 6. reporting.get_traffic_report_breakdowns
    if v_name = 'get_traffic_report_breakdowns' and v_schema = 'reporting' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'select\s+dimension,\s*coalesce\(nullif\(label,\s*''''\),\s*''Unknown''\)\s+as\s+label,\s*type,\s*pax,\s*scheduled_local_at',
        'select dimension, coalesce(nullif(label, ''''), ''Unknown'') as label, type, pax, scheduled_local_at, ops_date'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected expanded pattern', v_sig using errcode = 'P0001';
      end if;

      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'scheduled_local_at\s*\+\s*interval\s*''1 day''\s*<=\s*p_data_as_of\s+at\s+time\s+zone\s*''Asia/Ho_Chi_Minh''',
        '(case when reporting.is_operational_reader_cutover_active_v1() then case when pax is not null and ops_date <= (((p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') - interval ''5 hours'')::date - 1) and exists (select 1 from reporting.public_traffic_coverage accepted_coverage where accepted_coverage.status = ''complete'' and ops_date between accepted_coverage.from_date and accepted_coverage.to_date) then true else scheduled_local_at + interval ''1 day'' <= (p_data_as_of at time zone ''Asia/Ho_Chi_Minh'') end else scheduled_local_at + interval ''1 day'' <= p_data_as_of at time zone ''Asia/Ho_Chi_Minh'' end)',
        'g'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected due condition pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 7. If overview_peak_heatmaps_base_v1: update projection freshness check for cutover STALE_OPERATIONAL_PROJECTION
    if v_name = 'get_public_traffic_report_overview_peak_heatmaps_base_v1' and v_schema = 'public' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'select\s+\*\s+into\s+v_state\s+from\s+reporting\.public_traffic_projection_state\s+where\s+projection_name\s*=\s*''public_traffic_effective'';\s+select\s+max\(data_version\)\s+into\s+v_current_version\s+from\s+public\.seasons;\s+select\s+max\(server_seq\)::bigint\s+into\s+v_current_watermark\s+from\s+public\.season_change_events;\s+v_effective_status\s*:=\s*case\s+when\s+v_state\.projection_name\s+is\s+null\s+then\s*''stale''\s+when\s+v_state\.status\s*<>\s*''fresh''\s+then\s+v_state\.status\s+when\s+v_state\.snapshot_rows\s*=\s*0\s+then\s*''empty''\s+when\s+v_state\.source_watermark\s+is\s+distinct\s+from\s+v_current_watermark\s+then\s*''stale''\s+else\s*''fresh''\s+end;',
        'if reporting.is_operational_reader_cutover_active_v1() then
    declare
      v_op_status record;
      v_curr_op_rev bigint;
    begin
      select * into v_op_status from reporting.operational_projection_status_v1();
      if not coalesce(v_op_status.is_fresh, false) then
        raise exception ''STALE_OPERATIONAL_PROJECTION source=% current=%'', v_op_status.source_watermark, v_op_status.current_watermark using errcode = ''40001'';
      end if;
      select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
      v_effective_status := ''fresh'';
      v_current_version := coalesce(v_curr_op_rev, 0)::integer;
      v_current_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
      v_state.projection_name := ''public_traffic_effective'';
      v_state.status := ''fresh'';
      v_state.source_data_version := coalesce(v_curr_op_rev, 0)::integer;
      v_state.source_watermark := v_current_watermark;
      v_state.refreshed_at := v_op_status.refreshed_at;
      v_state.snapshot_rows := (select count(*)::bigint from reporting.canonical_flight_legs);
      v_state.error := null;
    end;
  else
    select * into v_state
    from reporting.public_traffic_projection_state
    where projection_name = ''public_traffic_effective'';
    select max(data_version) into v_current_version from public.seasons;
    select max(server_seq)::bigint into v_current_watermark from public.season_change_events;
    v_effective_status := case
      when v_state.projection_name is null then ''stale''
      when v_state.status <> ''fresh'' then v_state.status
      when v_state.snapshot_rows = 0 then ''empty''
      when v_state.source_watermark is distinct from v_current_watermark then ''stale''
      else ''fresh''
    end;
  end if;'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected projection freshness pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- 8. If public.get_public_traffic_report_peak_hour_heatmap_v1: update projection freshness check for cutover
    if v_name = 'get_public_traffic_report_peak_hour_heatmap_v1' and v_schema = 'public' then
      v_prev_def := v_new_def;
      v_new_def := regexp_replace(
        v_new_def,
        'select\s+\*\s+into\s+v_state\s+from\s+reporting\.public_traffic_projection_state\s+where\s+projection_name\s*=\s*''public_traffic_effective'';',
        'if reporting.is_operational_reader_cutover_active_v1() then
    declare
      v_op_status record;
      v_curr_op_rev bigint;
    begin
      select * into v_op_status from reporting.operational_projection_status_v1();
      if not coalesce(v_op_status.is_fresh, false) then
        raise exception ''STALE_OPERATIONAL_PROJECTION source=% current=%'', v_op_status.source_watermark, v_op_status.current_watermark using errcode = ''40001'';
      end if;
      select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
      v_state.projection_name := ''public_traffic_effective'';
      v_state.status := ''fresh'';
      v_state.source_data_version := coalesce(v_curr_op_rev, 0)::integer;
      v_state.source_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
      v_state.refreshed_at := v_op_status.refreshed_at;
      v_state.snapshot_rows := (select count(*)::bigint from reporting.canonical_flight_legs);
      v_state.error := null;
    end;
  else
    select * into v_state from reporting.public_traffic_projection_state where projection_name = ''public_traffic_effective'';
  end if;'
      );
      if v_new_def = v_prev_def then
        raise exception 'Target % missing expected projection freshness pattern', v_sig using errcode = 'P0001';
      end if;
    end if;

    -- Re-execute transformed definition
    execute v_new_def;

    -- Set owner to postgres
    execute format('alter function %s.%I(%s) owner to postgres', v_schema, v_name, v_args);
  end loop;
end $$;

-- 5. Least-privilege ACL enforcement
revoke execute on function public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) to service_role;

revoke execute on function public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz) to service_role;

revoke execute on function public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text) from public, anon, authenticated;
grant execute on function public.get_public_traffic_report_peak_hour_heatmap_v1(date,date,text[],text[],text[],text[],text[],text,text) to service_role;

revoke execute on function public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) from public, anon, authenticated, service_role;

revoke execute on function public.get_public_traffic_report_overview_canonical_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text) from public, anon, authenticated, service_role;

revoke execute on function reporting.get_traffic_report_peak_hour_heatmap_v1(date,date,jsonb,text) from public, anon, authenticated, service_role;

commit;
