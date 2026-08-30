-- Manual legs are now canonical base rows. Operational edits/deletes remain
-- overlays keyed by the canonical record_id.

create or replace function public.save_canonical_season_modification_v1(
  p_season_id text,
  p_mod_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_leg_id text := nullif(btrim(p_mod_payload->>'legId'),'');
  v_action text := coalesce(nullif(btrim(p_mod_payload->>'action'),''),'modified');
  v_added jsonb := p_mod_payload->'addedLeg';
  v_existing public.season_flight_records%rowtype;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required' using errcode='42501';
  end if;
  if not (
    public.app_operator_has_permission('seasonal.write')
    or public.app_operator_has_permission('detailed.write')
    or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('checkin.write')
    or public.app_operator_has_permission('gate.write')
  ) then
    raise exception 'A schedule allocation write permission is required' using errcode='42501';
  end if;
  if p_season_id is null or btrim(p_season_id)='' or v_leg_id is null
    or v_action not in ('modified','deleted','added')
  then
    raise exception 'seasonId, legId, and a valid action are required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_season_id,0));
  if not exists(select 1 from public.seasons where id=p_season_id for share) then
    raise exception 'Season % does not exist',p_season_id using errcode='P0002';
  end if;

  select records.* into v_existing
  from public.season_flight_records records
  where records.season_id=p_season_id and records.record_id=v_leg_id
  for update;

  if v_action='added' then
    if v_added is null or jsonb_typeof(v_added)<>'object' then
      raise exception 'added action requires addedLeg' using errcode='22023';
    end if;
    if coalesce(nullif(v_added->>'id',''),v_leg_id)<>v_leg_id then
      raise exception 'addedLeg.id must equal legId' using errcode='22023';
    end if;
    if found and (v_existing.source_kind<>'manual'
      or not public.is_canonical_flight_leg_active_v1(v_existing.status,v_existing.action))
    then
      raise exception 'Canonical manual leg id % is stale or belongs to another source',v_leg_id
        using errcode='40001';
    end if;

    insert into public.season_flight_records(
      season_id,record_id,link_id,type,airline,flight_number,raw_flight_number,
      request_status_code,route,schedule,aircraft,category,code_shares,int_dom_ind,
      pax,gate,stand,carousel,mct,fb,lb,bhs,ghs,date,scheduled_date,scheduled_time,
      operational_date,iata_season_code,flight_series_id,day_of_week,action,
      source_row_index,linked_source_row_index,link_type,pair_anchor_date,
      linked_record_id,source_kind,source_side,status,turnaround_id,
      lifecycle_changed_at,lifecycle_changed_by
    ) values (
      p_season_id,v_leg_id,coalesce(v_added->>'linkId',''),
      coalesce(v_added->>'type','A'),coalesce(v_added->>'airline',''),
      coalesce(v_added->>'flightNumber',''),
      coalesce(v_added->>'rawFlightNumber',v_added->>'flightNumber',''),
      v_added->>'requestStatusCode',coalesce(v_added->>'route',''),
      coalesce(v_added->>'schedule',''),coalesce(v_added->>'aircraft',''),
      coalesce(v_added->>'category',''),v_added->>'codeShares',v_added->>'intDomInd',
      nullif(v_added->>'pax','')::integer,nullif(v_added->>'gate','')::integer,
      nullif(upper(btrim(v_added->>'stand')),''),nullif(v_added->>'carousel','')::integer,
      v_added->>'mct',v_added->>'fb',v_added->>'lb',v_added->>'bhs',v_added->>'ghs',
      coalesce(v_added->>'date',''),coalesce(v_added->>'scheduledDate',v_added->>'date'),
      coalesce(v_added->>'scheduledTime',v_added->>'schedule'),
      coalesce(v_added->>'operationalDate',v_added->>'date'),v_added->>'iataSeasonCode',
      v_added->>'flightSeriesId',coalesce(nullif(v_added->>'dayOfWeek','')::integer,0),
      'added',coalesce(nullif(v_added->>'sourceRowIndex','')::integer,0),
      nullif(v_added->>'linkedSourceRowIndex','')::integer,v_added->>'linkType',
      v_added->>'pairAnchorDate',v_added->>'linkedRecordId','manual',
      case when coalesce(v_added->>'type','A')='D' then 'DEP' else 'ARR' end,
      'active',v_added->>'turnaroundId',now(),auth.uid()
    ) on conflict(record_id) do update set
      link_id=excluded.link_id,type=excluded.type,airline=excluded.airline,
      flight_number=excluded.flight_number,raw_flight_number=excluded.raw_flight_number,
      request_status_code=excluded.request_status_code,route=excluded.route,
      schedule=excluded.schedule,aircraft=excluded.aircraft,category=excluded.category,
      code_shares=excluded.code_shares,int_dom_ind=excluded.int_dom_ind,pax=excluded.pax,
      gate=excluded.gate,stand=excluded.stand,carousel=excluded.carousel,mct=excluded.mct,
      fb=excluded.fb,lb=excluded.lb,bhs=excluded.bhs,ghs=excluded.ghs,date=excluded.date,
      scheduled_date=excluded.scheduled_date,scheduled_time=excluded.scheduled_time,
      operational_date=excluded.operational_date,iata_season_code=excluded.iata_season_code,
      flight_series_id=excluded.flight_series_id,day_of_week=excluded.day_of_week,
      action='added',source_row_index=excluded.source_row_index,
      linked_source_row_index=excluded.linked_source_row_index,link_type=excluded.link_type,
      pair_anchor_date=excluded.pair_anchor_date,linked_record_id=excluded.linked_record_id,
      source_kind='manual',source_side=excluded.source_side,status='active',
      turnaround_id=excluded.turnaround_id,lifecycle_changed_at=now(),
      lifecycle_changed_by=auth.uid()
    where season_flight_records.season_id=p_season_id
      and season_flight_records.source_kind='manual'
      and public.is_canonical_flight_leg_active_v1(
        season_flight_records.status,season_flight_records.action);
  else
    if not found or not public.is_canonical_flight_leg_active_v1(v_existing.status,v_existing.action)
      or v_existing.superseded_by_batch_id is not null
    then
      raise exception 'Canonical leg % is deleted, superseded, or unavailable',v_leg_id
        using errcode='40001';
    end if;
  end if;

  -- Reuse the fully characterized overlay serializer, then remove any legacy
  -- added child it may have created. The surrounding function transaction means
  -- the legacy row is never visible as committed state.
  perform public.upsert_season_modification_from_json(p_season_id,p_mod_payload);
  delete from public.season_modification_added_legs
  where season_id=p_season_id and leg_id=v_leg_id;

  if v_action='deleted' then
    update public.season_flight_records
    set status='deleted',action='deleted',deletion_reason='overlay_deleted',
        lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
    where season_id=p_season_id and record_id=v_leg_id
      and public.is_canonical_flight_leg_active_v1(status,action);
    if not found then
      raise exception 'Canonical leg % changed before delete was finalized',v_leg_id
        using errcode='40001';
    end if;
  end if;

  return jsonb_build_object(
    'seasonId',p_season_id,'recordId',v_leg_id,'action',v_action,
    'sourceKind',(select source_kind from public.season_flight_records where record_id=v_leg_id)
  );
end;
$$;

create or replace function public.remove_canonical_season_modification_v1(
  p_season_id text,
  p_leg_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mod public.season_modifications%rowtype;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required' using errcode='42501';
  end if;
  if not (
    public.app_operator_has_permission('seasonal.write')
    or public.app_operator_has_permission('detailed.write')
    or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('checkin.write')
    or public.app_operator_has_permission('gate.write')
  ) then
    raise exception 'A schedule allocation write permission is required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_season_id,0));
  select mods.* into v_mod from public.season_modifications mods
  where mods.season_id=p_season_id and mods.leg_id=p_leg_id for update;
  if not found then
    return jsonb_build_object('seasonId',p_season_id,'recordId',p_leg_id,'removed',false);
  end if;
  if v_mod.action='added' then
    update public.season_flight_records
    set status='deleted',action='deleted',deletion_reason='manual_undo',
        lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
    where season_id=p_season_id and record_id=p_leg_id and source_kind='manual'
      and public.is_canonical_flight_leg_active_v1(status,action);
  elsif v_mod.action='deleted' then
    update public.season_flight_records
    set status='active',
        action=case when source_kind='manual' then 'added' else null end,
        deletion_reason=null,lifecycle_changed_at=now(),
        lifecycle_changed_by=auth.uid()
    where season_id=p_season_id and record_id=p_leg_id
      and status='deleted' and action='deleted'
      and deletion_reason='overlay_deleted'
      and superseded_by_batch_id is null;
    if not found then
      raise exception 'Deleted canonical leg % cannot be restored from this overlay',p_leg_id
        using errcode='40001';
    end if;
  end if;
  delete from public.season_modifications
  where season_id=p_season_id and leg_id=p_leg_id;
  return jsonb_build_object('seasonId',p_season_id,'recordId',p_leg_id,'removed',true);
end;
$$;

revoke execute on function public.save_canonical_season_modification_v1(text,jsonb),
  public.remove_canonical_season_modification_v1(text,text) from public,anon;
grant execute on function public.save_canonical_season_modification_v1(text,jsonb),
  public.remove_canonical_season_modification_v1(text,text) to authenticated;
