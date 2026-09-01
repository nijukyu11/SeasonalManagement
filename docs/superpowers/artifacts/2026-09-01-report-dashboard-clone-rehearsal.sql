\set ON_ERROR_STOP on
\timing on

begin isolation level repeatable read read only;

do $$
declare
  v_type text;
  v_v1 jsonb;
  v_v2 jsonb;
  v_as_of timestamptz := (
    select refreshed_at
    from reporting.public_traffic_projection_state
    where projection_name = 'public_traffic_effective'
  );
begin
  foreach v_type in array array['all','A','D'] loop
    v_v1 := public.get_public_traffic_report_overview_v1(
      date '2026-08-01', date '2026-08-31',
      case when v_type = 'all' then array['A','D'] else array[v_type] end,
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    );
    v_v2 := public.get_public_traffic_report_v2(
      date '2026-08-01', date '2026-08-31', v_type,
      array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 'traffic-report-v2', 'full', v_as_of
    );

    if (v_v1 #>> '{kpis,current,flights}')::integer
        is distinct from (v_v2 #>> '{current,flights}')::integer
      or (v_v1 #>> '{kpis,current,arrivals}')::integer
        is distinct from (v_v2 #>> '{current,arrivals}')::integer
      or (v_v1 #>> '{kpis,current,departures}')::integer
        is distinct from (v_v2 #>> '{current,departures}')::integer
      or (v_v1 #>> '{kpis,current,reported_pax}')::bigint
        is distinct from (v_v2 #>> '{current,reported_pax}')::bigint
      or (v_v1 #>> '{kpis,current,arrival_reported_pax}')::bigint
        is distinct from (v_v2 #>> '{current,arrival_reported_pax}')::bigint
      or (v_v1 #>> '{kpis,current,departure_reported_pax}')::bigint
        is distinct from (v_v2 #>> '{current,departure_reported_pax}')::bigint
      or (v_v1 #>> '{kpis,pax_coverage,due_legs}')::integer
        is distinct from (v_v2 #>> '{current,due_legs}')::integer
      or (v_v1 #>> '{kpis,pax_coverage,reported_legs}')::integer
        is distinct from (v_v2 #>> '{current,reported_legs}')::integer then
      raise exception 'v1/v2 aggregate differential for type %', v_type;
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(v_v1 -> 'timeline') as old_rows(
        ops_date date, flights integer, arrivals integer, departures integer, reported_pax bigint
      )
      full join jsonb_to_recordset(v_v2 -> 'timeline') as new_rows(
        ops_date date, flights integer, arrivals integer, departures integer, reported_pax bigint
      ) using (ops_date)
      where old_rows.ops_date is null or new_rows.ops_date is null
        or old_rows.flights is distinct from new_rows.flights
        or old_rows.arrivals is distinct from new_rows.arrivals
        or old_rows.departures is distinct from new_rows.departures
        or old_rows.reported_pax is distinct from new_rows.reported_pax
    ) then
      raise exception 'v1/v2 daily differential for type %', v_type;
    end if;
  end loop;
end;
$$;

select jsonb_build_object(
  'check', 'report-v1-v2-differential',
  'status', 'passed',
  'from', '2026-08-01',
  'to', '2026-08-31',
  'types', jsonb_build_array('all','A','D'),
  'source_watermark', (select max(server_seq) from public.season_change_events)
);
commit;

select max(server_seq)::bigint as rehearsal_watermark
from public.season_change_events
\gset

begin;
set local role service_role;
select public.publish_public_dashboard_daily_v1(
  2026,
  date '2026-08-31',
  :'rehearsal_watermark'::bigint,
  'clone-rehearsal-2026-08-31-' || :'rehearsal_watermark',
  'rehearsal',
  'Production clone rehearsal only'
) as publication_receipt;
select public.get_public_dashboard_publication_version_v1(2026) as dashboard_version;
commit;

select jsonb_build_object(
  'service_role_direct_ledger', has_table_privilege('service_role', 'reporting.public_dashboard_publications', 'select'),
  'service_role_publisher', has_function_privilege(
    'service_role',
    'public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text)',
    'execute'
  ),
  'anon_publisher', has_function_privilege(
    'anon',
    'public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text)',
    'execute'
  )
) as acl_receipt;

do $$
begin
  begin
    delete from reporting.public_dashboard_publications
    where id = (select min(id) from reporting.public_dashboard_publications);
    raise exception 'publication delete unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;
end;
$$;

select jsonb_build_object(
  'check', 'publication-immutability',
  'status', 'passed',
  'attempt_rows', count(*)
) from reporting.public_dashboard_publications;
