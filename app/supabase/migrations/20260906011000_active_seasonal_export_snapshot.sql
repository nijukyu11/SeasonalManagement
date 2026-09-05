-- Export is a version-pinned active snapshot, never an action/history dump.
-- All child relations are selected from the same export record set.
begin;
create or replace function public.get_seasonal_export_snapshot_v2(p_season_id text,p_expected_data_version integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare snapshot jsonb; actual_version integer;
begin
  if auth.uid() is null or not public.app_operator_has_permission('seasonal.read') then
    raise exception 'seasonal.read permission is required' using errcode='42501';
  end if;
  if nullif(btrim(p_season_id),'') is null or p_expected_data_version is null or p_expected_data_version<0 then
    raise exception 'seasonId and a non-negative expected data version are required' using errcode='22023';
  end if;
  select data_version into actual_version from public.seasons where id=p_season_id;
  if not found then raise exception 'Season % does not exist',p_season_id using errcode='P0002'; end if;
  if actual_version<>p_expected_data_version then
    raise exception 'Stale Seasonal export snapshot: expected %, current %',p_expected_data_version,actual_version using errcode='PT409';
  end if;

  with export_records as materialized (
    select records.* from public.season_flight_records records
    left join public.season_modifications mods on mods.season_id=records.season_id and mods.leg_id=records.record_id
    where records.season_id=p_season_id
      and public.is_canonical_flight_leg_active_v1(records.status,records.action)
      and mods.action is distinct from 'deleted'
  ), export_modifications as materialized (
    select mods.* from public.season_modifications mods
    join export_records records on records.season_id=mods.season_id and records.record_id=mods.leg_id
    where mods.action in ('modified','added')
  )
  select jsonb_build_object(
    'seasonId',seasons.id,'seasonCode',seasons.season_code,'dataVersion',seasons.data_version,
    'totalCount',(select count(*) from export_records),
    'sourceRowCount',(select count(*) from public.season_source_rows where season_id=p_season_id),
    'serverHighWater',coalesce((select max(server_seq) from public.season_change_events where season_id=p_season_id),0::bigint),
    'truncated',false,
    'flightRecords',coalesce((select jsonb_agg(to_jsonb(records) order by record_id) from export_records records),'[]'::jsonb),
    'flightRecordCounters',coalesce((select jsonb_agg(to_jsonb(counters) order by counters.record_id,counters.counter_group,counters.item_index)
      from public.season_flight_record_counters counters join export_records records on records.record_id=counters.record_id),'[]'::jsonb),
    'flightRecordWindows',coalesce((select jsonb_agg(to_jsonb(windows) order by windows.record_id,windows.counter_key)
      from public.season_flight_record_checkin_windows windows join export_records records on records.record_id=windows.record_id),'[]'::jsonb),
    'modifications',coalesce((select jsonb_agg(to_jsonb(mods) order by leg_id) from export_modifications mods),'[]'::jsonb),
    'modificationCounters',coalesce((select jsonb_agg(to_jsonb(counters) order by counters.leg_id,counters.counter_group,counters.item_index)
      from public.season_modification_counters counters join export_modifications mods on mods.leg_id=counters.leg_id),'[]'::jsonb),
    'modificationWindows',coalesce((select jsonb_agg(to_jsonb(windows) order by windows.leg_id,windows.counter_key)
      from public.season_modification_checkin_windows windows join export_modifications mods on mods.leg_id=windows.leg_id),'[]'::jsonb),
    'modificationAddedLegs','[]'::jsonb
  ) into snapshot from public.seasons seasons where seasons.id=p_season_id;
  return snapshot;
end;
$$;
revoke all on function public.get_seasonal_export_snapshot_v2(text,integer) from public,anon;
grant execute on function public.get_seasonal_export_snapshot_v2(text,integer) to authenticated;
commit;
