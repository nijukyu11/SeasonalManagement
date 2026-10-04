-- Migration: 20260921003000_seasonal_selective_preservation_and_import_schedule_precedence.sql
--
-- Preserves user-allocated operational properties (counter, check-in windows, gate, stand,
-- carousel, pax, mct, fb, lb, bhs, ghs) on matching flights across seasonal imports,
-- while giving authoritative precedence to the incoming schedule file for flight presence:
--
-- 1. If an incoming flight matches a previously deleted flight, the flight is ADDED BACK
--    (status remains active; no 'overlay_deleted' status is re-applied).
-- 2. Stale delete overlays on matched records are cleared so they do not suppress the flight.
-- 3. On Replace strategy, all stale delete overlays on seasonal records are purged because
--    the entire seasonal baseline has been replaced.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.replace(
    pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;

  v_old := '  insert into public.season_modifications(
    season_id,leg_id,action,changed_fields,gate,stand,carousel,mct,fb,lb,bhs,ghs,
    check_in_start,check_in_end,check_in_allocation_mode
  )
  select mods.season_id,incoming.final_record_id,mods.action,
    case when mods.action=''deleted'' then mods.changed_fields else coalesce((
      select array_agg(field order by ordinal)
      from unnest(mods.changed_fields) with ordinality allowed(field,ordinal)
      where field=any(array[''gate'',''stand'',''carousel'',''counter'',''checkInStart'',
        ''checkInEnd'',''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs''])
    ),''{}''::text[]) end,
    mods.gate,mods.stand,mods.carousel,mods.mct,mods.fb,mods.lb,mods.bhs,mods.ghs,
    mods.check_in_start,mods.check_in_end,mods.check_in_allocation_mode
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modifications mods
    on mods.season_id=v_target_season_id and mods.leg_id=incoming.matched_record_id
  where incoming.matched_record_id is not null
    and incoming.final_record_id<>incoming.matched_record_id
    and mods.action in (''modified'',''deleted'')
    and (mods.action=''deleted'' or mods.changed_fields && array[
      ''gate'',''stand'',''carousel'',''counter'',''checkInStart'',''checkInEnd'',
      ''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs'']::text[])
  on conflict(leg_id) do nothing;

  insert into public.season_modification_counters(leg_id,counter_group,item_index,counter_value)
  select incoming.final_record_id,counters.counter_group,counters.item_index,counters.counter_value
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_counters counters on counters.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;

  insert into public.season_modification_checkin_windows(leg_id,counter_key,window_start,window_end)
  select incoming.final_record_id,windows.counter_key,windows.window_start,windows.window_end
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_checkin_windows windows on windows.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;


  update public.season_flight_records records
  set supersedes_record_id=incoming.matched_record_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.final_record_id and incoming.is_insert
    and incoming.matched_record_id is not null and incoming.final_record_id<>incoming.matched_record_id;

  update public.season_flight_records records
  set superseded_by_batch_id=p_batch_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.matched_record_id and incoming.is_insert
    and incoming.final_record_id<>incoming.matched_record_id;

  -- Rebased terminal deletion is canonical, not merely a hidden UI overlay.
  update public.season_flight_records records
  set status=''deleted'',action=''deleted'',deletion_reason=''overlay_deleted'',
      lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
  from public.season_modifications mods
  where records.season_id=v_target_season_id and records.source_import_batch_id=p_batch_id
    and mods.season_id=records.season_id and mods.leg_id=records.record_id and mods.action=''deleted'';';

  v_new := '  insert into public.season_modifications(
    season_id,leg_id,action,changed_fields,pax,gate,stand,carousel,mct,fb,lb,bhs,ghs,
    check_in_start,check_in_end,check_in_allocation_mode
  )
  select mods.season_id,incoming.final_record_id,''modified'',
    coalesce((
      select array_agg(field order by ordinal)
      from unnest(mods.changed_fields) with ordinality allowed(field,ordinal)
      where field=any(array[''gate'',''stand'',''carousel'',''counter'',''pax'',''checkInStart'',
        ''checkInEnd'',''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs''])
    ),''{}''::text[]),
    mods.pax,mods.gate,mods.stand,mods.carousel,mods.mct,mods.fb,mods.lb,mods.bhs,mods.ghs,
    mods.check_in_start,mods.check_in_end,mods.check_in_allocation_mode
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modifications mods
    on mods.season_id=v_target_season_id and mods.leg_id=incoming.matched_record_id
  where incoming.matched_record_id is not null
    and incoming.final_record_id<>incoming.matched_record_id
    and mods.action = ''modified''
    and (mods.changed_fields && array[
      ''gate'',''stand'',''carousel'',''counter'',''pax'',''checkInStart'',''checkInEnd'',
      ''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs'']::text[]
      or mods.pax is not null)
  on conflict(leg_id) do nothing;

  insert into public.season_modification_counters(leg_id,counter_group,item_index,counter_value)
  select incoming.final_record_id,counters.counter_group,counters.item_index,counters.counter_value
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_counters counters on counters.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;

  insert into public.season_modification_checkin_windows(leg_id,counter_key,window_start,window_end)
  select incoming.final_record_id,windows.counter_key,windows.window_start,windows.window_end
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_checkin_windows windows on windows.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;

  update public.season_flight_records records
  set supersedes_record_id=incoming.matched_record_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.final_record_id and incoming.is_insert
    and incoming.matched_record_id is not null and incoming.final_record_id<>incoming.matched_record_id;

  update public.season_flight_records records
  set superseded_by_batch_id=p_batch_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.matched_record_id and incoming.is_insert
    and incoming.final_record_id<>incoming.matched_record_id;

  -- When incoming schedule explicitly contains a flight, remove any stale delete overlay
  -- on the matched record so the flight is not suppressed.
  delete from public.season_modifications mods
  using pg_temp.seasonal_import_commit_records_v3 incoming
  where mods.season_id=v_target_season_id
    and (mods.leg_id=incoming.matched_record_id or mods.leg_id=incoming.final_record_id)
    and mods.action=''deleted'';

  if v_batch.apply_strategy = ''replace'' then
    -- On replace, all prior seasonal legs are superseded by the new schedule:
    -- clear all stale delete overlays on seasonal records.
    delete from public.season_modifications mods
    using public.season_flight_records records
    where mods.season_id=v_target_season_id
      and mods.leg_id=records.record_id
      and records.season_id=v_target_season_id
      and records.source_kind=''seasonal''
      and mods.action=''deleted'';
  end if;';

  if position(v_new in v_definition) > 0 then
    -- Already patched
    return;
  end if;

  if position(v_old in v_definition) = 0 then
    raise exception 'Target overlay preservation block not found in commit_seasonal_import_v3 definition';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

comment on function public.commit_seasonal_import_v3(uuid, integer, text) is
  'Commits a staged seasonal import batch; preserves user-allocated operational properties (counter, gate, stand, pax, etc.), purges stale delete overlays when incoming schedule contains flight, and bounds replace temp-table updates.';

notify pgrst, 'reload schema';

commit;
