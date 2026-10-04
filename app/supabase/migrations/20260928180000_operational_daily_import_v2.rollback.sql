begin;
do $$ begin
  if to_regclass('public.seasonal_draft_workspace') is not null then
    raise exception 'Rollback M6 planning before M5 Daily import' using errcode='55000';
  end if;
  if exists(select 1 from public.daily_schedule_import_batches where contract_version=2)
     or exists(select 1 from public.operational_resource_overrides)
     or exists(select 1 from public.operational_flight_legs where lineage_generation>0) then
    raise exception 'Refusing Daily V2 rollback with persisted batches, overrides or lineage history' using errcode='55000';
  end if;
end $$;
create or replace function public.run_seasonal_operational_backfill_v1(
  p_published_on date,
  p_published_by uuid,
  p_replayed_from_high_water bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '1800s'
as $function$
declare
  v_run_id uuid;
  v_cutoff timestamp with time zone := statement_timestamp();
  v_high_water bigint;
  v_drafts jsonb;
  v_versions integer;
  v_legs jsonb;
  v_authority integer;
begin
  if not (
    public.app_operator_has_permission('seasonal.write')
    or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('season.repair')
  ) then
    raise exception 'backfill requires seasonal.write, daily.write or season.repair' using errcode = '42501';
  end if;

  perform 1 from public.operational_workspace_revision where singleton for update;
  select coalesce(max(events.server_seq), 0) into v_high_water from public.season_change_events events;

  insert into public.seasonal_operational_backfill_runs (
    cutoff_at, source_high_water, replayed_from_high_water, published_on, published_by, status
  ) values (
    v_cutoff, v_high_water, p_replayed_from_high_water, p_published_on, p_published_by, 'running'
  ) returning run_id into v_run_id;

  begin
    v_drafts := public.backfill_seasonal_flight_drafts_v1(v_run_id);
    v_versions := public.seed_seasonal_baseline_versions_v1(v_run_id, p_published_on, p_published_by);
    v_legs := public.backfill_operational_flight_legs_v1(v_run_id);
    v_authority := public.backfill_operational_day_authority_v1(v_run_id);
    perform public.backfill_operational_resources_v1();

    update public.seasonal_operational_backfill_runs
       set status = 'completed',
           completed_at = now(),
           drafts_written = (v_drafts->>'written')::integer,
           versions_seeded = v_versions,
           legs_written = (v_legs->>'written')::integer,
           authority_rows_written = v_authority
     where run_id = v_run_id;
  exception when others then
    update public.seasonal_operational_backfill_runs
       set status = 'failed',
           completed_at = now(),
           notes = notes || jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate)
     where run_id = v_run_id;
    raise;
  end;

  -- Shadow readers are woken in the same transaction as the write, exactly like
  -- the Daily dashboard wake: the M3.4 projection runner listens on this channel
  -- and the timer is only the fallback for a notification that never arrives.
  perform pg_notify(
    'operational_projection_wake',
    jsonb_build_object('source', 'seasonal-operational-backfill-v1', 'runId', v_run_id, 'highWater', v_high_water)::text
  );

  return jsonb_build_object(
    'runId', v_run_id,
    'cutoffAt', v_cutoff,
    'sourceHighWater', v_high_water,
    'drafts', v_drafts,
    'versions', v_versions,
    'legs', v_legs,
    'authorityDays', v_authority
  );
end;
$function$;
drop function public.stage_daily_schedule_import_v2(jsonb);
drop function public.commit_daily_schedule_import_v2(uuid,text);
drop function public.get_daily_schedule_import_v2_status(uuid);
drop function public.cancel_daily_schedule_import_v2(uuid);
drop function public.operational_daily_scope_fingerprint_v2(date[]);
drop trigger operational_capture_resource_overrides on public.operational_change_events;
drop function public.capture_operational_resource_overrides_v1();
drop function public.backfill_operational_resource_overrides_v1();
drop table public.operational_daily_import_legs;
drop table public.operational_daily_import_stages;
drop table public.operational_resource_overrides;
drop index public.operational_flight_legs_loose_history_idx;
drop index public.operational_flight_legs_lineage_generation_idx;
alter table public.operational_flight_legs drop column lineage_generation;
alter table public.operational_flight_legs drop column lineage_id;
alter table public.daily_schedule_import_batches drop constraint daily_schedule_import_batches_contract_version_check;
alter table public.daily_schedule_import_batches add constraint daily_schedule_import_batches_contract_version_check check(contract_version=1);
commit;
