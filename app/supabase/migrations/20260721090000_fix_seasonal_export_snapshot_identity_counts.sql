-- Restore the strict Export V2 identity/count fields required by the desktop client.
-- Some production deployments retained an older function body that omitted
-- seasonCode and sourceRowCount even though the canonical schema includes them.

create or replace function public.get_seasonal_export_snapshot_v2(
  p_season_id text,
  p_expected_data_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_snapshot_state jsonb;
begin
  if auth.uid() is null
    or not public.app_operator_has_permission('seasonal.read')
  then
    raise exception 'seasonal.read permission is required'
      using errcode = '42501';
  end if;

  if p_season_id is null or pg_catalog.btrim(p_season_id) = '' then
    raise exception 'p_season_id is required'
      using errcode = '22023';
  end if;

  if p_expected_data_version is null or p_expected_data_version < 0 then
    raise exception 'p_expected_data_version must be a non-negative integer'
      using errcode = '22023';
  end if;

  -- STABLE keeps every relation below on the calling statement's MVCC snapshot.
  select pg_catalog.jsonb_build_object(
    'found', true,
    'versionMatches', seasons.data_version = p_expected_data_version,
    'actualVersion', seasons.data_version,
    'payload', case
      when seasons.data_version <> p_expected_data_version then null
      else pg_catalog.jsonb_build_object(
        'seasonId', seasons.id,
        'seasonCode', seasons.season_code,
        'dataVersion', seasons.data_version,
        'totalCount', (
          select pg_catalog.count(*)
          from public.season_flight_records records
          where records.season_id = seasons.id
        ),
        'sourceRowCount', (
          select pg_catalog.count(*)
          from public.season_source_rows source_rows
          where source_rows.season_id = seasons.id
        ),
        'serverHighWater', coalesce((
          select pg_catalog.max(events.server_seq)
          from public.season_change_events events
          where events.season_id = seasons.id
        ), 0::bigint),
        'truncated', false,
        'flightRecords', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(records) order by records.record_id)
          from public.season_flight_records records
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'flightRecordCounters', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(counters)
            order by counters.record_id, counters.counter_group, counters.item_index
          )
          from public.season_flight_record_counters counters
          join public.season_flight_records records
            on records.record_id = counters.record_id
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'flightRecordWindows', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(windows)
            order by windows.record_id, windows.counter_key
          )
          from public.season_flight_record_checkin_windows windows
          join public.season_flight_records records
            on records.record_id = windows.record_id
          where records.season_id = seasons.id
        ), '[]'::jsonb),
        'modifications', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(modifications) order by modifications.leg_id)
          from public.season_modifications modifications
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationCounters', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(counters)
            order by counters.leg_id, counters.counter_group, counters.item_index
          )
          from public.season_modification_counters counters
          join public.season_modifications modifications
            on modifications.leg_id = counters.leg_id
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationWindows', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(windows)
            order by windows.leg_id, windows.counter_key
          )
          from public.season_modification_checkin_windows windows
          join public.season_modifications modifications
            on modifications.leg_id = windows.leg_id
          where modifications.season_id = seasons.id
        ), '[]'::jsonb),
        'modificationAddedLegs', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(added_legs) order by added_legs.leg_id)
          from public.season_modification_added_legs added_legs
          where added_legs.season_id = seasons.id
        ), '[]'::jsonb)
      )
    end
  )
  into v_snapshot_state
  from public.seasons seasons
  where seasons.id = p_season_id;

  if v_snapshot_state is null then
    raise exception 'Season % does not exist', p_season_id
      using errcode = 'P0002';
  end if;

  if not (v_snapshot_state->>'versionMatches')::boolean then
    raise exception 'Season % data version changed: expected %, got %',
      p_season_id,
      p_expected_data_version,
      v_snapshot_state->>'actualVersion'
      using errcode = '40001';
  end if;

  return v_snapshot_state->'payload';
end;
$$;

revoke execute on function public.get_seasonal_export_snapshot_v2(text, integer) from public, anon;
grant execute on function public.get_seasonal_export_snapshot_v2(text, integer) to authenticated;
