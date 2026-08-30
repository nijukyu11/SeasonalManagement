-- Audited reversal for a committed Daily replacement scope. This is the only
-- supported path that clears Daily authority; normal Seasonal rebuilds must
-- continue to respect active replacement scopes.

create or replace function public.preview_daily_authority_reset_v1(
  p_season_id text,
  p_ops_dates date[],
  p_expected_data_version integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_dates date[];
  v_season public.seasons%rowtype;
  v_scope_count integer;
  v_current_daily_count integer;
  v_preimage_count integer;
  v_current_overlay_count integer;
  v_preimage_pax bigint;
  v_confirmation text;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Daily authority reset' using errcode='42501';
  end if;
  if not public.app_operator_has_permission('season.repair') then
    raise exception 'Missing required permission: season.repair' using errcode='42501';
  end if;
  select coalesce(array_agg(distinct day order by day),'{}'::date[])
    into v_dates from unnest(coalesce(p_ops_dates,'{}'::date[])) requested(day);
  if cardinality(v_dates)=0 then
    raise exception 'At least one Ops Date is required' using errcode='22023';
  end if;
  select * into v_season from public.seasons where id=p_season_id;
  if not found then raise exception 'Season % was not found',p_season_id using errcode='22023'; end if;
  if v_season.data_version is distinct from p_expected_data_version then
    raise exception 'Stale Daily authority reset preview for season %',p_season_id using errcode='40001';
  end if;

  select count(*) into v_scope_count
  from public.schedule_replacement_scopes scopes
  where scopes.season_id=p_season_id and scopes.ops_date=any(v_dates)
    and scopes.authority_source='daily' and scopes.reset_at is null;
  if v_scope_count is distinct from cardinality(v_dates) then
    raise exception 'Every requested Ops Date must have active Daily authority' using errcode='22023';
  end if;

  select count(*) into v_current_daily_count
  from public.canonical_active_flight_records_v1 records
  join public.schedule_replacement_scopes scopes
    on scopes.season_id=records.season_id
   and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
     records.operational_date,records.scheduled_date,records.date,
     records.scheduled_time,records.schedule)
   and scopes.source_batch_id=records.source_import_batch_id
  where records.season_id=p_season_id and scopes.ops_date=any(v_dates)
    and scopes.reset_at is null and records.source_kind='daily';

  select count(*),coalesce(sum(records.pax),0) into v_preimage_count,v_preimage_pax
  from public.season_flight_records records
  join public.schedule_replacement_scopes scopes
    on scopes.season_id=records.season_id
   and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
     records.operational_date,records.scheduled_date,records.date,
     records.scheduled_time,records.schedule)
   and scopes.source_batch_id=records.superseded_by_batch_id
  where records.season_id=p_season_id and scopes.ops_date=any(v_dates)
    and scopes.reset_at is null and records.status='deleted'
    and records.action='deleted' and records.deletion_reason='daily_replacement';

  select count(*) into v_current_overlay_count
  from public.season_modifications mods
  join public.season_flight_records records on records.record_id=mods.leg_id
  join public.schedule_replacement_scopes scopes
    on scopes.season_id=records.season_id
   and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
     records.operational_date,records.scheduled_date,records.date,
     records.scheduled_time,records.schedule)
   and scopes.source_batch_id=records.source_import_batch_id
  where records.season_id=p_season_id and scopes.ops_date=any(v_dates)
    and scopes.reset_at is null and records.source_kind='daily';

  v_confirmation := 'RESET DAILY '||upper(v_season.season_code)||' '
    ||v_dates[1]::text||'..'||v_dates[cardinality(v_dates)]::text
    ||' DATES['||array_to_string(v_dates,',')||'] VERSION['||p_expected_data_version::text||']';
  return jsonb_build_object(
    'valid',true,'seasonId',p_season_id,'seasonCode',upper(v_season.season_code),
    'expectedDataVersion',p_expected_data_version,'affectedDates',v_dates,
    'rangeStart',v_dates[1],'rangeEnd',v_dates[cardinality(v_dates)],
    'activeScopeCount',v_scope_count,'currentDailyCount',v_current_daily_count,
    'preimageCount',v_preimage_count,'preimagePax',v_preimage_pax,
    'currentOverlayCount',v_current_overlay_count,'confirmationText',v_confirmation
  );
end;
$$;

create or replace function public.reset_daily_authority_v1(
  p_request_id uuid,
  p_season_id text,
  p_ops_dates date[],
  p_expected_data_version integer,
  p_confirmation text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_preview jsonb;
  v_existing jsonb;
  v_season public.seasons%rowtype;
  v_deleted_daily integer;
  v_restored_preimage integer;
  v_reset_scopes integer;
  v_next_version integer;
  v_seq bigint;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Daily authority reset' using errcode='42501';
  end if;
  if not public.app_operator_has_permission('season.repair') then
    raise exception 'Missing required permission: season.repair' using errcode='42501';
  end if;
  if p_request_id is null then raise exception 'requestId is required' using errcode='22023'; end if;
  if length(btrim(coalesce(p_reason,'')))<10 then
    raise exception 'A reset reason of at least 10 characters is required' using errcode='22023';
  end if;

  select events.op_payload || jsonb_build_object('serverHighWater',events.server_seq)
    into v_existing
  from public.season_change_events events
  where events.client_id='daily-authority-reset-v1' and events.op_id=p_request_id::text;
  if found then return v_existing; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_season_id,0));
  select * into v_season from public.seasons where id=p_season_id for update;
  if not found or v_season.data_version is distinct from p_expected_data_version then
    raise exception 'Stale Daily authority reset for season %',p_season_id using errcode='40001';
  end if;
  perform 1 from public.schedule_replacement_scopes scopes
  where scopes.season_id=p_season_id and scopes.ops_date=any(p_ops_dates)
  for update;
  v_preview := public.preview_daily_authority_reset_v1(p_season_id,p_ops_dates,p_expected_data_version);
  if p_confirmation is distinct from v_preview->>'confirmationText' then
    raise exception 'Daily authority reset confirmation does not match preview' using errcode='22023';
  end if;

  update public.season_flight_records records
  set status='deleted',action='deleted',deletion_reason='daily_authority_reset',
      lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
  from public.schedule_replacement_scopes scopes
  where scopes.season_id=p_season_id and scopes.ops_date=any(p_ops_dates)
    and scopes.reset_at is null and records.season_id=scopes.season_id
    and records.source_kind='daily' and records.source_import_batch_id=scopes.source_batch_id
    and public.is_canonical_flight_leg_active_v1(records.status,records.action)
    and public.canonical_flight_leg_ops_date_v1(
      records.operational_date,records.scheduled_date,records.date,
      records.scheduled_time,records.schedule)=scopes.ops_date;
  get diagnostics v_deleted_daily=row_count;
  if v_deleted_daily is distinct from (v_preview->>'currentDailyCount')::integer then
    raise exception 'Daily authority reset current-leg preimage drifted' using errcode='40001';
  end if;

  update public.season_flight_records records
  set status='active',action=case when records.source_kind='manual' then 'added' else null end,
      deletion_reason=null,superseded_by_batch_id=null,
      lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
  from public.schedule_replacement_scopes scopes
  where scopes.season_id=p_season_id and scopes.ops_date=any(p_ops_dates)
    and scopes.reset_at is null and records.season_id=scopes.season_id
    and records.superseded_by_batch_id=scopes.source_batch_id
    and records.status='deleted' and records.action='deleted'
    and records.deletion_reason='daily_replacement'
    and public.canonical_flight_leg_ops_date_v1(
      records.operational_date,records.scheduled_date,records.date,
      records.scheduled_time,records.schedule)=scopes.ops_date;
  get diagnostics v_restored_preimage=row_count;
  if v_restored_preimage is distinct from (v_preview->>'preimageCount')::integer then
    raise exception 'Daily authority reset restoration count drifted' using errcode='40001';
  end if;

  update public.schedule_replacement_scopes scopes
  set reset_at=now(),reset_by=auth.uid(),reset_reason=btrim(p_reason)
  where scopes.season_id=p_season_id and scopes.ops_date=any(p_ops_dates)
    and scopes.reset_at is null;
  get diagnostics v_reset_scopes=row_count;
  if v_reset_scopes is distinct from (v_preview->>'activeScopeCount')::integer then
    raise exception 'Daily authority reset scope count drifted' using errcode='40001';
  end if;

  v_next_version:=p_expected_data_version+1;
  update public.seasons set data_version=v_next_version,
    last_synced_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
  where id=p_season_id and data_version=p_expected_data_version;
  if not found then raise exception 'Season changed during Daily authority reset' using errcode='40001'; end if;

  v_result:=jsonb_build_object(
    'requestId',p_request_id,'status','committed','kind','daily_authority_reset_v1',
    'seasonId',p_season_id,'seasonCode',v_preview->>'seasonCode',
    'affectedDates',v_preview->'affectedDates','deletedDailyCount',v_deleted_daily,
    'restoredPreimageCount',v_restored_preimage,'resetScopeCount',v_reset_scopes,
    'dataVersion',v_next_version,'reason',btrim(p_reason)
  );
  insert into public.season_change_events(
    event_id,season_id,client_id,op_id,actor_user_id,target_type,target_id,
    changed_fields,op_payload
  ) values (
    'daily-authority-reset-v1:'||p_request_id::text,p_season_id,
    'daily-authority-reset-v1',p_request_id::text,auth.uid(),'dailyAuthority',
    p_season_id,array['canonicalFlightLegs','replacementScopes','seasonMetadata'],v_result
  ) returning server_seq into v_seq;
  return v_result||jsonb_build_object('serverHighWater',v_seq);
end;
$$;

revoke execute on function public.preview_daily_authority_reset_v1(text,date[],integer),
  public.reset_daily_authority_v1(uuid,text,date[],integer,text,text) from public,anon;
grant execute on function public.preview_daily_authority_reset_v1(text,date[],integer),
  public.reset_daily_authority_v1(uuid,text,date[],integer,text,text) to authenticated;
