-- The canonical cutover is owned by the main SeasonalManagement migration set.
-- This report migration only verifies that boundary and adds projection
-- freshness metadata; it must not redefine the canonical candidate view.

do $$
begin
  if to_regclass('reporting.canonical_effective_flight_legs') is null
    or to_regclass('reporting.public_traffic_effective') is null then
    raise exception 'reporting.canonical_effective_flight_legs must exist before public traffic cutover';
  end if;
end;
$$;

create table if not exists reporting.public_traffic_projection_state(
  projection_name text primary key,
  status text not null check(status in ('stale','fresh','failed','empty')),
  source_data_version integer,
  source_watermark bigint,
  refreshed_at timestamptz,
  snapshot_rows bigint,
  error text
);

insert into reporting.public_traffic_projection_state(
  projection_name,status,source_data_version,source_watermark,refreshed_at,error
) values ('public_traffic_effective','stale',null,null,null,
  'Canonical source changed; refresh is required')
on conflict(projection_name) do update set status='stale',error=excluded.error;

revoke all on reporting.public_traffic_projection_state from public,anon,authenticated;
grant select on reporting.public_traffic_projection_state to service_role;

-- The deploy refresh job must run REFRESH MATERIALIZED VIEW CONCURRENTLY and
-- then execute this function. Keeping the state update separate allows the job
-- to mark failure truthfully when refresh itself does not commit.
create or replace function reporting.mark_public_traffic_projection_fresh_v1()
returns void
language sql
security definer
set search_path=pg_catalog,pg_temp
as $$
  insert into reporting.public_traffic_projection_state(
    projection_name,status,source_data_version,source_watermark,refreshed_at,snapshot_rows,error
  )
  select 'public_traffic_effective',
    case when snapshot.row_count = 0 then 'empty' else 'fresh' end,
    (select max(seasons.data_version) from public.seasons seasons),
    snapshot.snapshot_watermark,
    snapshot.refreshed_at,
    snapshot.row_count,
    null
  from (
    select count(*)::bigint as row_count,
      max(effective.snapshot_source_watermark) as snapshot_watermark,
      max(effective.snapshot_refreshed_at) as refreshed_at
    from reporting.public_traffic_effective effective
  ) snapshot
  on conflict(projection_name) do update set
    status=excluded.status,source_data_version=excluded.source_data_version,
    source_watermark=excluded.source_watermark,refreshed_at=excluded.refreshed_at,
    snapshot_rows=excluded.snapshot_rows,error=null
$$;

revoke execute on function reporting.mark_public_traffic_projection_fresh_v1()
  from public,anon,authenticated;
grant execute on function reporting.mark_public_traffic_projection_fresh_v1()
  to service_role;

create or replace function reporting.mark_public_traffic_projection_failed_v1(
  p_error text default 'refresh failed'
) returns void
language sql
security definer
set search_path=pg_catalog,pg_temp
as $$
  update reporting.public_traffic_projection_state
  set status='failed',error=left(coalesce(p_error,'refresh failed'),500)
  where projection_name='public_traffic_effective'
$$;

revoke execute on function reporting.mark_public_traffic_projection_failed_v1(text)
  from public,anon,authenticated;
grant execute on function reporting.mark_public_traffic_projection_failed_v1(text)
  to service_role;

do $$
begin
  if to_regprocedure('public.get_public_traffic_report_overview_canonical_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)') is null then
    alter function public.get_public_traffic_report_overview_v1(
      date,date,text[],text[],text[],text[],text[],text,text,date,integer,text
    ) rename to get_public_traffic_report_overview_canonical_base_v1;
  end if;
end;
$$;

create or replace function public.get_public_traffic_report_overview_v1(
  p_from_date date default null,
  p_to_date date default null,
  p_types text[] default array['A','D']::text[],
  p_airlines text[] default array[]::text[],
  p_routes text[] default array[]::text[],
  p_countries text[] default array[]::text[],
  p_aircraft_groups text[] default array[]::text[],
  p_comparison text default 'previous_period',
  p_time_basis text default 'local',
  p_timeline_after date default null,
  p_timeline_page_size integer default 366,
  p_contract_version text default 'traffic-report-v1'
) returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,reporting,public,pg_temp
set statement_timeout='9s'
as $$
declare
  v_result jsonb;
  v_state reporting.public_traffic_projection_state%rowtype;
  v_current_version integer;
  v_current_watermark bigint;
  v_effective_status text;
begin
  v_result := public.get_public_traffic_report_overview_canonical_base_v1(
    p_from_date,p_to_date,p_types,p_airlines,p_routes,p_countries,
    p_aircraft_groups,p_comparison,p_time_basis,p_timeline_after,
    p_timeline_page_size,p_contract_version
  );
  select * into v_state from reporting.public_traffic_projection_state
  where projection_name='public_traffic_effective';
  select max(data_version) into v_current_version
  from public.seasons;
  select max(server_seq)::bigint into v_current_watermark
  from public.season_change_events;
  v_effective_status := case
    when v_state.projection_name is null then 'stale'
    when v_state.status<>'fresh' then v_state.status
    when v_state.snapshot_rows=0 then 'empty'
    when v_state.source_watermark is distinct from v_current_watermark then 'stale'
    else 'fresh' end;
  return jsonb_set(v_result,'{metadata,projection}',jsonb_build_object(
    'status',v_effective_status,
    'source_data_version',v_state.source_data_version,
    'current_data_version',v_current_version,
    'source_watermark',v_state.source_watermark,
    'current_watermark',v_current_watermark,
    'refreshed_at',v_state.refreshed_at,
    'snapshot_rows',v_state.snapshot_rows
  ),true);
end;
$$;

alter function public.get_public_traffic_report_overview_v1(
  date,date,text[],text[],text[],text[],text[],text,text,date,integer,text
) owner to postgres;
revoke execute on function public.get_public_traffic_report_overview_v1(
  date,date,text[],text[],text[],text[],text[],text,text,date,integer,text
) from public,anon,authenticated;
grant execute on function public.get_public_traffic_report_overview_v1(
  date,date,text[],text[],text[],text[],text[],text,text,date,integer,text
) to service_role;
