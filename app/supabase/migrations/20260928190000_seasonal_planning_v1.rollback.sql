begin;
do $$ begin
 if to_regprocedure('public.commit_seasonal_publish_v1(text,uuid,text,text)') is not null then
   raise exception 'Roll back native Publish first' using errcode='55000';
 end if;
 if to_regclass('public.seasonal_draft_import_stages') is not null then
   raise exception 'Roll back native draft import first' using errcode='55000';
 end if;
 if exists(select 1 from public.seasonal_draft_mutation_receipts) or exists(select 1 from public.seasonal_publish_previews)
   or exists(select 1 from public.seasonal_publish_versions where backfill_run_id is null)
   or exists(select 1 from public.seasonal_flight_drafts where counters<>'[]' or checkin_windows<>'[]'
     or check_in_start is not null or check_in_end is not null or check_in_allocation_mode is not null) then
   raise exception 'Refusing M6 rollback with native receipts, previews, versions or draft allocations' using errcode='55000';
 end if;
end $$;
create or replace function public.run_seasonal_operational_backfill_v1(
  p_published_on date,p_published_by uuid,p_replayed_from_high_water bigint default null
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,extensions,pg_temp set statement_timeout='1800s' as $function$
declare
  v_run_id uuid; v_cutoff timestamptz:=statement_timestamp(); v_high_water bigint;
  v_drafts jsonb; v_versions integer; v_legs jsonb; v_authority integer;
begin
  if (public.app_operator_has_permission('seasonal.write')
      or public.app_operator_has_permission('daily.write')
      or public.app_operator_has_permission('season.repair')) is not true then
    raise exception 'backfill requires seasonal.write, daily.write or season.repair' using errcode='42501';
  end if;
  perform 1 from public.operational_workspace_revision where singleton for update;
  if exists(select 1 from public.daily_schedule_import_batches where contract_version=2 and status='committed') then
    raise exception 'Legacy backfill cannot run after Daily V2 ownership has committed' using errcode='55000';
  end if;
  select coalesce(max(server_seq),0) into v_high_water from public.season_change_events;
  insert into public.seasonal_operational_backfill_runs(cutoff_at,source_high_water,replayed_from_high_water,published_on,published_by,status)
    values(v_cutoff,v_high_water,p_replayed_from_high_water,p_published_on,p_published_by,'running') returning run_id into v_run_id;
  begin
    v_drafts:=public.backfill_seasonal_flight_drafts_v1(v_run_id);
    v_versions:=public.seed_seasonal_baseline_versions_v1(v_run_id,p_published_on,p_published_by);
    v_legs:=public.backfill_operational_flight_legs_v1(v_run_id);
    v_authority:=public.backfill_operational_day_authority_v1(v_run_id);
    perform public.backfill_operational_resources_v1();
    perform public.backfill_operational_resource_overrides_v1();
    update public.seasonal_operational_backfill_runs set status='completed',completed_at=now(),
      drafts_written=(v_drafts->>'written')::integer,versions_seeded=v_versions,
      legs_written=(v_legs->>'written')::integer,authority_rows_written=v_authority where run_id=v_run_id;
  exception when others then
    update public.seasonal_operational_backfill_runs set status='failed',completed_at=now(),
      notes=notes||jsonb_build_object('error',sqlerrm,'sqlstate',sqlstate) where run_id=v_run_id;
    raise;
  end;
  perform pg_notify('operational_projection_wake',jsonb_build_object(
    'source','seasonal-operational-backfill-v1','runId',v_run_id,'highWater',v_high_water)::text);
  return jsonb_build_object('runId',v_run_id,'cutoffAt',v_cutoff,'sourceHighWater',v_high_water,
    'drafts',v_drafts,'versions',v_versions,'legs',v_legs,'authorityDays',v_authority);
end;
$function$;
create or replace function public.seed_seasonal_baseline_versions_v1(
  p_run_id uuid,
  p_published_on date,
  p_published_by uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '900s'
as $function$
declare
  v_written integer := 0;
  v_season record;
  v_payload jsonb;
  v_checksum text;
  v_version_id uuid;
  v_sequence integer;
begin
  if p_published_by is null then
    raise exception 'a baseline version must record the operator who ran the backfill (p_published_by)';
  end if;

  for v_season in
    select
      seasons.id,
      seasons.season_code,
      seasons.effective_start,
      seasons.effective_end,
      count(drafts.draft_id)::integer as draft_count,
      count(drafts.draft_id) filter (where drafts.status = 'active')::integer as active_count
    from public.seasons seasons
    join public.seasonal_flight_drafts drafts on drafts.season_id = seasons.id
    where not exists (
      select 1 from public.seasonal_publish_versions versions
      where versions.season_id = seasons.id and versions.backfill_run_id is not null
    )
    group by seasons.id, seasons.season_code, seasons.effective_start, seasons.effective_end
    order by seasons.id
  loop
    select jsonb_build_object(
      'seasonId', v_season.id,
      'seasonCode', v_season.season_code,
      'scope', 'planning',
      'counts', jsonb_build_object(
        'total', v_season.draft_count,
        'active', v_season.active_count,
        'deleted', v_season.draft_count - v_season.active_count
      ),
      'flights', coalesce(jsonb_agg(jsonb_build_object(
        'draftId', drafts.draft_id,
        'type', drafts.type,
        'airline', drafts.airline,
        'flightNumber', drafts.flight_number,
        'rawFlightNumber', drafts.raw_flight_number,
        'route', drafts.route,
        'schedule', drafts.schedule,
        'aircraft', drafts.aircraft,
        'category', drafts.category,
        'pax', drafts.pax,
        'gate', drafts.gate,
        'stand', drafts.stand,
        'carousel', drafts.carousel,
        'date', drafts.date,
        'scheduledDate', drafts.scheduled_date,
        'scheduledTime', drafts.scheduled_time,
        'sourceSide', drafts.source_side,
        'sourceRowIndex', drafts.source_row_index,
        'status', drafts.status,
        'action', drafts.action
      ) order by drafts.date, drafts.type, drafts.scheduled_time, drafts.airline, drafts.flight_number), '[]'::jsonb)
    )
      into v_payload
    from public.seasonal_flight_drafts drafts
    where drafts.season_id = v_season.id;

    v_checksum := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex'
    );

    select coalesce(count(*), 0) + 1 into v_sequence
    from public.seasonal_publish_versions versions
    where versions.season_id = v_season.id;

    insert into public.seasonal_publish_versions (
      season_id, season_code, version_tag, sequence_in_day, published_at, published_by, publish_notes,
      range_start, range_end, total_flight_count, added_count, modified_count, removed_count, unchanged_count,
      skipped_day_count, diff_summary, snapshot_checksum, backfill_run_id
    ) values (
      v_season.id,
      v_season.season_code,
      public.seasonal_publish_version_tag(v_season.season_code, p_published_on, v_sequence),
      v_sequence,
      now(),
      p_published_by,
      'M2 baseline backfill: planning snapshot without daily operational data',
      coalesce(
        public.seasonal_backfill_identity_date_v1(v_season.effective_start, null, null),
        p_published_on
      ),
      coalesce(
        public.seasonal_backfill_identity_date_v1(v_season.effective_end, null, null),
        p_published_on
      ),
      v_season.active_count,
      v_season.active_count,
      0,
      0,
      0,
      0,
      jsonb_build_object('scope', 'planning', 'baseline', true),
      v_checksum,
      p_run_id
    )
    returning version_id into v_version_id;

    insert into public.seasonal_publish_snapshots (version_id, season_id, snapshot_payload, flight_count, checksum)
    values (v_version_id, v_season.id, v_payload, v_season.active_count, v_checksum);

    v_written := v_written + 1;
  end loop;

  update public.seasonal_operational_backfill_runs
     set versions_seeded = v_written
   where run_id = p_run_id;

  return v_written;
end;
$function$;
drop function public.get_seasonal_draft_window_v1(text,integer,text,uuid,bigint);
drop function public.get_seasonal_draft_export_snapshot_v1(text,uuid,bigint);
drop function public.preview_seasonal_publish_v1(text,uuid,date);
drop function public.get_seasonal_publish_preview_page_v1(uuid,text,bigint,integer);
drop function public.seasonal_planning_diff_v1(jsonb,jsonb);
drop function public.seasonal_publish_scope_fingerprint_v1(text);
drop function public.seasonal_publish_bounds_v1(text);
drop function public.apply_seasonal_draft_changes_v1(text,uuid,bigint,jsonb);
drop function public.backfill_seasonal_draft_allocations_v1();
drop function public.seasonal_planning_snapshot_v1(text);
drop function public.seasonal_draft_planning_state_v1(public.seasonal_flight_drafts);
drop trigger seasonal_draft_workspace_insert on public.seasonal_flight_drafts;
drop trigger seasonal_draft_workspace_update on public.seasonal_flight_drafts;
drop trigger seasonal_draft_workspace_delete on public.seasonal_flight_drafts;
drop trigger seasonal_draft_workspace_season_insert on public.seasons;
drop trigger seasonal_draft_workspace_season_update on public.seasons;
drop function public.bump_seasonal_draft_workspace_v1();
drop table public.seasonal_publish_preview_entries;
drop table public.seasonal_publish_previews;
drop table public.seasonal_draft_mutation_receipts;
drop table public.seasonal_draft_workspace;
drop sequence public.seasonal_draft_event_seq;
alter table public.seasonal_publish_versions drop column publish_sequence;
alter table public.seasonal_flight_drafts drop column counters;
alter table public.seasonal_flight_drafts drop column checkin_windows;
alter table public.seasonal_flight_drafts drop column check_in_start;
alter table public.seasonal_flight_drafts drop column check_in_end;
alter table public.seasonal_flight_drafts drop column check_in_allocation_mode;
alter policy "seasonal flight drafts read" on public.seasonal_flight_drafts
  using ((select public.app_operator_has_permission('seasonal.read')));
alter policy "seasonal draft events read" on public.seasonal_draft_events
  using ((select public.app_operator_has_permission('seasonal.read')));
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
    and exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='seasonal_draft_events') then
    alter publication supabase_realtime drop table public.seasonal_draft_events;
  end if;
end $$;
commit;
