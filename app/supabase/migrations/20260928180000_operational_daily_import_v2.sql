-- M5: Daily ground truth, scoped by explicit operational dates, never season ID.
begin;
alter table public.daily_schedule_import_batches drop constraint daily_schedule_import_batches_contract_version_check;
alter table public.daily_schedule_import_batches add constraint daily_schedule_import_batches_contract_version_check check(contract_version in (1,2));
alter table public.operational_flight_legs add column lineage_id uuid;
update public.operational_flight_legs set lineage_id=leg_id;
alter table public.operational_flight_legs alter column lineage_id set default gen_random_uuid();
alter table public.operational_flight_legs alter column lineage_id set not null;
alter table public.operational_flight_legs add column lineage_generation bigint not null default 0 check(lineage_generation>=0);
create unique index operational_flight_legs_lineage_generation_idx on public.operational_flight_legs(lineage_id,lineage_generation);
create index operational_flight_legs_loose_history_idx on public.operational_flight_legs(leg_key,status,created_at desc);

create table public.operational_resource_overrides (
  leg_id uuid primary key references public.operational_flight_legs on delete cascade,
  fields jsonb not null check(jsonb_typeof(fields)='object')
);
create table public.operational_daily_import_stages (
  batch_id uuid primary key references public.daily_schedule_import_batches on delete cascade,
  input_payload jsonb not null,
  affected_dates date[] not null,
  confirmed_zero_dates date[] not null,
  source_fingerprint text not null
);
create table public.operational_daily_import_legs (
  batch_id uuid not null references public.operational_daily_import_stages on delete cascade,
  leg_id uuid not null default gen_random_uuid(),
  leg_key text not null,
  operational_date date not null,
  scheduled_date date not null,
  scheduled_time time not null,
  side text not null check(side in ('ARR','DEP')),
  airline text not null check(btrim(airline)<>''),
  flight_number text not null check(btrim(flight_number)<>''),
  route text not null check(btrim(route)<>''),
  sheet_name text not null,
  source_row_number integer not null check(source_row_number>0),
  occurrence_key text not null,
  matched_leg_id uuid references public.operational_flight_legs on delete restrict,
  lineage_id uuid not null,
  override_fields jsonb not null,
  lineage_generation bigint not null,
  leg_data jsonb not null,
  primary key(batch_id,leg_key,scheduled_date),
  unique(batch_id,leg_id)
);
revoke all on public.operational_resource_overrides,public.operational_daily_import_stages,public.operational_daily_import_legs from public,anon,authenticated;
create trigger operational_workspace_revision_overrides after insert or update or delete or truncate on public.operational_resource_overrides
for each statement execute function public.bump_operational_workspace_revision_v1();

create function public.capture_operational_resource_overrides_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_fields jsonb;
begin
  if new.target_type<>'operationalLeg' then return null; end if;
  select jsonb_object_agg(k,new.after_state->k) into v_fields from unnest(new.changed_fields) k
  where k=any(array['gate','stand','carousel','counter_token','counters','checkin_windows',
    'check_in_start','check_in_end','check_in_allocation_mode','mct','fb','lb','bhs','ghs']);
  if v_fields is not null then
    insert into public.operational_resource_overrides values(new.target_id::uuid,v_fields)
    on conflict(leg_id) do update set fields=public.operational_resource_overrides.fields||excluded.fields;
  end if;
  return null;
end;
$$;
revoke all on function public.capture_operational_resource_overrides_v1() from public,anon,authenticated;
create trigger operational_capture_resource_overrides after insert on public.operational_change_events
for each row execute function public.capture_operational_resource_overrides_v1();

create function public.backfill_operational_resource_overrides_v1() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  delete from public.operational_resource_overrides o using public.operational_leg_backfill_links l where o.leg_id=l.leg_id;
  insert into public.operational_resource_overrides(leg_id,fields)
  select l.leg_id,jsonb_object_agg(map.field,case map.field
    when 'counters' then coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_group,item_index) from public.operational_leg_counters c where c.leg_id=l.leg_id),'[]'::jsonb)
    when 'checkin_windows' then coalesce((select jsonb_agg(to_jsonb(w)-'leg_id' order by counter_key) from public.operational_leg_checkin_windows w where w.leg_id=l.leg_id),'[]'::jsonb)
    else to_jsonb(leg)->map.field end)
  from public.operational_leg_backfill_links l
  join public.operational_flight_legs leg on leg.leg_id=l.leg_id
  join public.season_modifications m on m.leg_id=l.legacy_record_id and m.season_id=l.legacy_season_id
  cross join (values('gate','gate'),('stand','stand'),('carousel','carousel'),('counter','counters'),
    ('checkInCounterWindows','checkin_windows'),('checkInStart','check_in_start'),('checkInEnd','check_in_end'),
    ('checkInAllocationMode','check_in_allocation_mode'),('mct','mct'),('fb','fb'),('lb','lb'),('bhs','bhs'),('ghs','ghs')) map(legacy_field,field)
  where map.legacy_field=any(m.changed_fields)
  group by l.leg_id;
  -- Later operational edits supersede the legacy overlay, field by field.
  insert into public.operational_resource_overrides(leg_id,fields)
  select target_id::uuid,jsonb_object_agg(field,value) from (
    select distinct on(e.target_id,k.field) e.target_id,k.field,e.after_state->k.field as value
    from public.operational_change_events e cross join lateral unnest(e.changed_fields) k(field)
    where e.target_type='operationalLeg' and k.field=any(array['gate','stand','carousel','counter_token','counters','checkin_windows',
      'check_in_start','check_in_end','check_in_allocation_mode','mct','fb','lb','bhs','ghs'])
    order by e.target_id,k.field,e.server_seq desc
  ) latest group by target_id
  on conflict(leg_id) do update set fields=public.operational_resource_overrides.fields||excluded.fields;
end;
$$;
revoke all on function public.backfill_operational_resource_overrides_v1() from public,anon,authenticated;
select public.backfill_operational_resource_overrides_v1();

create function public.operational_daily_scope_fingerprint_v2(p_dates date[]) returns text
language sql stable security definer set search_path=pg_catalog,public as $$
  with scope as materialized (
    select l.* from public.operational_flight_legs l
    where l.operational_date=any(p_dates) or l.leg_id in (
      select linked_leg_id from public.operational_flight_legs where operational_date=any(p_dates)
    ) or l.linked_leg_id in (select leg_id from public.operational_flight_legs where operational_date=any(p_dates))
  )
  select encode(sha256(convert_to(jsonb_build_array(
    (select jsonb_agg(to_jsonb(l) order by leg_id) from scope l),
    (select jsonb_agg(to_jsonb(a) order by operational_date) from public.operational_day_authority a where operational_date=any(p_dates)),
    (select jsonb_agg(to_jsonb(o) order by leg_id) from public.operational_resource_overrides o where leg_id in(select leg_id from scope)),
    (select jsonb_agg(to_jsonb(c) order by leg_id,counter_group,item_index) from public.operational_leg_counters c where leg_id in(select leg_id from scope)),
    (select jsonb_agg(to_jsonb(w) order by leg_id,counter_key) from public.operational_leg_checkin_windows w where leg_id in(select leg_id from scope))
  )::text,'UTF8')),'hex')
$$;
revoke all on function public.operational_daily_scope_fingerprint_v2(date[]) from public,anon,authenticated;

create function public.stage_daily_schedule_import_v2(p_import jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='30s' as $$
declare
  v_actor uuid:=auth.uid(); v_request uuid; v_batch uuid:=gen_random_uuid();
  v_existing public.daily_schedule_import_batches%rowtype;
  v_dates date[]; v_zero date[]; v_leg jsonb; v_day date; v_scheduled date; v_time time;
  v_key text; v_side text; v_airline text; v_flight text; v_match uuid; v_lineage uuid;
  v_generation bigint;
  v_count integer; v_diag jsonb:=coalesce(p_import->'diagnostics','[]'::jsonb);
  v_preview jsonb; v_fingerprint text; v_hash text; v_status text; v_stand text;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode='42501';
  end if;
  if p_import->>'contractVersion' is distinct from '2'
     or jsonb_typeof(p_import->'legs') is distinct from 'array'
     or jsonb_typeof(p_import->'affectedDates') is distinct from 'array'
     or jsonb_typeof(coalesce(p_import->'confirmedZeroFlightDates','[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(v_diag) is distinct from 'array' then
    raise exception 'Invalid Daily V2 payload' using errcode='22023';
  end if;
  if coalesce(btrim(p_import->>'canonicalChecksum'),'')='' then
    raise exception 'Canonical checksum is required' using errcode='22023';
  end if;
  v_request:=(p_import->>'requestId')::uuid;
  if v_request is null then raise exception 'requestId is required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('daily-v2:'||v_actor::text||':'||v_request::text,0));
  select * into v_existing from public.daily_schedule_import_batches where created_by=v_actor and request_id=v_request;
  if found then
    if v_existing.contract_version<>2 or not exists (
      select 1 from public.operational_daily_import_stages where batch_id=v_existing.batch_id and input_payload=p_import
    ) then raise exception 'Request ID reused with different payload' using errcode='23505'; end if;
    return public.daily_schedule_import_v1_response(v_existing.batch_id);
  end if;
  select array_agg(distinct d::date order by d::date) into v_dates from jsonb_array_elements_text(p_import->'affectedDates') d;
  select coalesce(array_agg(distinct d::date order by d::date),'{}'::date[]) into v_zero
    from jsonb_array_elements_text(coalesce(p_import->'confirmedZeroFlightDates','[]')) d;
  if coalesce(cardinality(v_dates),0)=0 or exists(select 1 from unnest(v_dates||v_zero) d where d is null or not isfinite(d)) then
    raise exception 'Explicit finite affected dates are required, including for a zero-flight workbook' using errcode='22023';
  end if;
  if not(v_zero <@ v_dates) then raise exception 'Zero-flight dates must belong to affectedDates' using errcode='22023'; end if;
  -- Hold a consistent operational source while building the persisted preview.
  perform 1 from public.operational_workspace_revision where singleton for share;
  v_fingerprint:=public.operational_daily_scope_fingerprint_v2(v_dates);
  insert into public.daily_schedule_import_batches(
    batch_id,request_id,contract_version,status,file_name,workbook_profile,raw_checksum,canonical_checksum,
    resource_policy_hash,diagnostics,preview,preview_hash,created_by
  ) values(v_batch,v_request,2,'failed',coalesce(p_import->>'fileName',''),coalesce(p_import->>'workbookProfile','unknown'),
    coalesce(p_import->>'rawChecksum',''),coalesce(p_import->>'canonicalChecksum',''),coalesce(p_import->>'resourcePolicyHash',''),
    v_diag,'{}','pending',v_actor);
  insert into public.operational_daily_import_stages values(v_batch,p_import,v_dates,v_zero,v_fingerprint);
  for v_leg in select value from jsonb_array_elements(p_import->'legs') loop
    begin
      v_day:=(v_leg->>'operationalDate')::date; v_scheduled:=(v_leg->>'scheduledDate')::date;
      v_time:=(v_leg->>'scheduledTime')::time;
      v_side:=v_leg->>'side'; v_airline:=upper(btrim(v_leg->>'airline')); v_flight:=upper(btrim(v_leg->>'flightNumber'));
      if v_day is null or v_scheduled is null or v_time is null or not isfinite(v_scheduled)
         or not(v_day=any(v_dates)) or v_day is distinct from public.seasonal_operational_date_v2(v_scheduled,v_time)
         or v_side not in ('ARR','DEP') or v_side is null then
        raise exception 'Leg date/side is invalid or outside affectedDates' using errcode='22023';
      end if;
      if v_leg#>>'{resources,checkInAllocationMode}' is not null
        and v_leg#>>'{resources,checkInAllocationMode}' not in('grouped','broken') then
        raise exception 'Invalid check-in allocation mode' using errcode='22023';
      end if;
      if v_leg#>'{resources,checkInCounterWindows}' is not null then
        if jsonb_typeof(v_leg#>'{resources,checkInCounterWindows}')<>'object' then
          raise exception 'Check-in windows must be an object' using errcode='22023';
        end if;
        if exists(select 1 from jsonb_each(v_leg#>'{resources,checkInCounterWindows}') w
          where w.value->>'start' is null or w.value->>'end' is null) then
          raise exception 'Check-in windows require start and end' using errcode='22023';
        end if;
      end if;
      v_stand:=nullif(upper(btrim(v_leg#>>'{resources,stand}')),'');
      if v_stand is not null and v_stand !~ '^[1-9][0-9]*[A-Z]?$' then
        raise exception 'Invalid stand' using errcode='22023';
      end if;
      if nullif(v_leg#>>'{resources,gate}','')::integer<=0 or nullif(v_leg#>>'{resources,carousel}','')::integer<=0 then
        raise exception 'Gate/carousel must be positive' using errcode='22023';
      end if;
      perform nullif(v_leg#>>'{resources,pax}','')::integer;
      v_key:=(case v_side when 'ARR' then 'A' else 'D' end)||chr(31)||v_day::text||chr(31)||v_airline||chr(31)||v_flight;
      v_match:=null; v_lineage:=null; v_generation:=null;
      select count(*) into v_count from public.operational_flight_legs where leg_key=v_key and scheduled_date=v_scheduled and status='active';
      if v_count>1 then
        raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: several active sources' using errcode='P0001';
      elsif v_count=1 then
        select leg_id,lineage_id,lineage_generation into v_match,v_lineage,v_generation from public.operational_flight_legs where leg_key=v_key and scheduled_date=v_scheduled and status='active';
      else
        select count(distinct lineage_id) into v_count from public.operational_flight_legs where leg_key=v_key and scheduled_date=v_scheduled and status<>'active';
        if v_count>1 then raise exception 'DAILY_LOOSE_IDENTITY_COLLISION: several terminal lineages' using errcode='P0001'; end if;
        select leg_id,lineage_id,lineage_generation into v_match,v_lineage,v_generation from public.operational_flight_legs
          where leg_key=v_key and scheduled_date=v_scheduled and status<>'active' order by lineage_generation desc limit 1;
      end if;
      insert into public.operational_daily_import_legs(
        batch_id,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,route,
        sheet_name,source_row_number,occurrence_key,matched_leg_id,lineage_id,lineage_generation,override_fields,leg_data
      ) values(v_batch,v_key,v_day,v_scheduled,v_time,v_side,v_airline,v_flight,upper(btrim(v_leg->>'route')),
        coalesce(v_leg->>'sheetName',''),(v_leg->>'sourceRowNumber')::integer,
        concat_ws('|',v_day,v_side,v_airline,v_flight,upper(btrim(v_leg->>'route')),v_time),
        v_match,coalesce(v_lineage,gen_random_uuid()),coalesce(v_generation+1,0),
        coalesce((select fields from public.operational_resource_overrides where leg_id=v_match),'{}'),v_leg);
    exception when data_exception or integrity_constraint_violation or raise_exception then
      v_diag:=v_diag||jsonb_build_array(jsonb_build_object(
        'severity','blocking','code',case when sqlstate='23505' or sqlerrm like 'DAILY_LOOSE_IDENTITY_COLLISION:%'
          then 'DAILY_LOOSE_IDENTITY_COLLISION' else 'DAILY_INVALID_LEG' end,
        'message',sqlerrm,'rowNumber',v_leg->'sourceRowNumber','operationalDate',v_leg->>'operationalDate'));
    end;
  end loop;
  foreach v_day in array v_dates loop
    select count(*) into v_count from public.operational_daily_import_legs where batch_id=v_batch and operational_date=v_day;
    if (v_count=0) is distinct from (v_day=any(v_zero)) then
      v_diag:=v_diag||jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_ZERO_FLIGHT_CONFIRMATION',
        'message','A zero-flight date must be explicitly confirmed and must contain no legs','operationalDate',v_day));
    end if;
  end loop;
  v_status:=case when exists(select 1 from jsonb_array_elements(v_diag) d where d->>'severity'='blocking') then 'failed' else 'validated' end;
  select jsonb_build_object('importGuardVersion','2','valid',v_status='validated','affectedDates',v_dates,
    'confirmedZeroFlightDates',v_zero,'sourceFingerprint',v_fingerprint,
    'legCount',(select count(*) from public.operational_daily_import_legs where batch_id=v_batch),
    'rebaseCount',(select count(*) from public.operational_daily_import_legs where batch_id=v_batch and override_fields<>'{}'),
    'replacedLegs',coalesce((select jsonb_agg(jsonb_build_object(
      'legId',leg_id,'sourceType',source_type,'operationalDate',operational_date,'side',side,
      'airline',airline,'flightNumber',flight_number,'scheduledTime',scheduled_time,'route',route
    ) order by operational_date,scheduled_time,leg_id)
      from public.operational_flight_legs where status='active' and operational_date=any(v_dates)),'[]'::jsonb),
    'rebasedOverrides',coalesce((select jsonb_agg(jsonb_build_object(
      'occurrenceKey',occurrence_key,'matchedLegId',matched_leg_id,'fields',override_fields
    ) order by occurrence_key) from public.operational_daily_import_legs
      where batch_id=v_batch and override_fields<>'{}'),'[]'::jsonb),
    'replacedBySource',coalesce((select jsonb_object_agg(source_type,n) from (
      select source_type,count(*) n from public.operational_flight_legs where status='active' and operational_date=any(v_dates) group by source_type
    ) counts),'{}'::jsonb),
    'inputHash',encode(sha256(convert_to(p_import::text,'UTF8')),'hex')
  ) into v_preview;
  v_hash:=encode(sha256(convert_to(v_preview::text,'UTF8')),'hex');
  update public.daily_schedule_import_batches set status=v_status,diagnostics=v_diag,preview=v_preview,preview_hash=v_hash where batch_id=v_batch;
  return public.daily_schedule_import_v1_response(v_batch);
end;
$$;

create function public.commit_daily_schedule_import_v2(p_batch_id uuid,p_preview_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='30s' as $$
declare
  v_actor uuid:=auth.uid(); v_batch public.daily_schedule_import_batches%rowtype;
  v_stage public.operational_daily_import_stages%rowtype; v_leg public.operational_daily_import_legs%rowtype;
  v_row public.operational_flight_legs%rowtype; v_survivor public.operational_flight_legs%rowtype;
  v_authority public.operational_day_authority%rowtype;
  v_day date; v_effective jsonb; v_before jsonb; v_result jsonb; v_count integer; v_replaced integer; v_revision bigint;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode='42501';
  end if;
  -- Shared writer order: workspace, ascending operational dates, ascending legs.
  perform 1 from public.operational_workspace_revision where singleton for update;
  select * into v_batch from public.daily_schedule_import_batches where batch_id=p_batch_id and created_by=v_actor for update;
  if not found or v_batch.contract_version<>2 then raise exception 'Daily V2 batch not found' using errcode='P0002'; end if;
  if p_preview_hash is distinct from v_batch.preview_hash then raise exception 'Preview hash changed' using errcode='PT409'; end if;
  if v_batch.status='committed' then return public.daily_schedule_import_v1_response(p_batch_id); end if;
  if v_batch.status<>'validated' or v_batch.expires_at<=now() then raise exception 'Batch is not committable' using errcode='PT409'; end if;
  select * into strict v_stage from public.operational_daily_import_stages where batch_id=p_batch_id;
  for v_day in
    select d from unnest(v_stage.affected_dates) d
    union select operational_date from public.operational_flight_legs where status='active' and (
      linked_leg_id in(select leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
      or leg_id in(select linked_leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
    ) order by 1
  loop perform pg_advisory_xact_lock(hashtextextended('operational-day:'||v_day::text,0)); end loop;
  if public.operational_daily_scope_fingerprint_v2(v_stage.affected_dates) is distinct from v_stage.source_fingerprint then
    raise exception 'Operational scope changed; stage again' using errcode='PT409';
  end if;
  perform 1 from public.operational_flight_legs where operational_date=any(v_stage.affected_dates)
    or linked_leg_id in(select leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
    or leg_id in(select linked_leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
    order by leg_id for update;
  -- A replaced half of an overnight pair cannot leave a dangling active survivor.
  for v_survivor in select * from public.operational_flight_legs
    where status='active' and not(operational_date=any(v_stage.affected_dates)) and (
      linked_leg_id in(select leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
      or leg_id in(select linked_leg_id from public.operational_flight_legs where operational_date=any(v_stage.affected_dates))
    ) order by leg_id
  loop
    update public.operational_flight_legs set linked_leg_id=null,turnaround_id=null,link_type=null,pair_anchor_date=null,
      updated_at=now(),updated_by=v_actor where leg_id=v_survivor.leg_id returning * into v_row;
    insert into public.operational_change_events(actor_id,request_id,target_id,operational_date,changed_fields,before_state,after_state)
    values(v_actor,v_batch.request_id,v_row.leg_id::text,v_row.operational_date,
      array['linked_leg_id','turnaround_id','link_type','pair_anchor_date'],to_jsonb(v_survivor),to_jsonb(v_row));
  end loop;
  update public.operational_flight_legs set status='deleted',deletion_reason='daily_replacement',
    linked_leg_id=null,turnaround_id=null,link_type=null,pair_anchor_date=null,updated_at=now(),updated_by=v_actor
    where status='active' and operational_date=any(v_stage.affected_dates);
  get diagnostics v_replaced=row_count;
  for v_leg in select * from public.operational_daily_import_legs where batch_id=p_batch_id order by leg_id loop
    v_effective:=jsonb_build_object(
      'gate',nullif(v_leg.leg_data#>>'{resources,gate}','')::integer,
      'stand',nullif(upper(btrim(v_leg.leg_data#>>'{resources,stand}')),''),
      'carousel',nullif(v_leg.leg_data#>>'{resources,carousel}','')::integer,
      'counter_token',nullif(v_leg.leg_data#>>'{resources,counter}',''),
      'mct',v_leg.leg_data#>>'{resources,mct}','fb',v_leg.leg_data#>>'{resources,fb}',
      'lb',v_leg.leg_data#>>'{resources,lb}','bhs',v_leg.leg_data#>>'{resources,bhs}','ghs',v_leg.leg_data#>>'{resources,ghs}',
      'check_in_start',v_leg.leg_data#>>'{resources,checkInStart}','check_in_end',v_leg.leg_data#>>'{resources,checkInEnd}',
      'check_in_allocation_mode',v_leg.leg_data#>>'{resources,checkInAllocationMode}'
    )||(v_leg.override_fields-'counters'-'checkin_windows');
    v_row:=jsonb_populate_record(null::public.operational_flight_legs,v_effective);
    insert into public.operational_flight_legs(
      leg_id,lineage_id,lineage_generation,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,raw_flight_number,
      route,aircraft_type,flight_category,pax,code_shares,int_dom_ind,
      gate,stand,carousel,counter_token,mct,fb,lb,bhs,ghs,check_in_start,check_in_end,check_in_allocation_mode,
      source_type,source_batch_id,source_occurrence_key,source_row_number,created_by,updated_by
    ) values(v_leg.leg_id,v_leg.lineage_id,v_leg.lineage_generation,v_leg.leg_key,v_leg.operational_date,v_leg.scheduled_date,v_leg.scheduled_time,
      v_leg.side,v_leg.airline,v_leg.flight_number,v_leg.leg_data->>'rawFlightNumber',v_leg.route,
      coalesce(v_leg.leg_data->>'aircraft','Unknown'),coalesce(v_leg.leg_data->>'category','C'),
      nullif(v_leg.leg_data#>>'{resources,pax}','')::integer,v_leg.leg_data#>>'{resources,codeShares}',v_leg.leg_data->>'intDomInd',
      v_row.gate,v_row.stand,v_row.carousel,v_row.counter_token,v_row.mct,v_row.fb,v_row.lb,v_row.bhs,v_row.ghs,
      v_row.check_in_start,v_row.check_in_end,v_row.check_in_allocation_mode,
      'daily_import',p_batch_id,v_leg.occurrence_key,v_leg.source_row_number,v_actor,v_actor);
    if v_leg.override_fields ? 'counters' then
      insert into public.operational_leg_counters
      select v_leg.leg_id,c.counter_group,c.item_index,c.counter_value from jsonb_to_recordset(v_leg.override_fields->'counters')
        c(counter_group text,item_index integer,counter_value text);
    else
      insert into public.operational_leg_counters
      select v_leg.leg_id,'__single__',ordinality::integer-1,btrim(value)
        from unnest(string_to_array(v_row.counter_token,',')) with ordinality t(value,ordinality) where btrim(value)<>'';
    end if;
    if v_leg.override_fields ? 'checkin_windows' then
      insert into public.operational_leg_checkin_windows
      select v_leg.leg_id,w.counter_key,w.window_start,w.window_end from jsonb_to_recordset(v_leg.override_fields->'checkin_windows')
        w(counter_key text,window_start text,window_end text);
    else
      insert into public.operational_leg_checkin_windows
      select v_leg.leg_id,w.key,w.value->>'start',w.value->>'end'
        from jsonb_each(coalesce(v_leg.leg_data#>'{resources,checkInCounterWindows}','{}'::jsonb)) w;
    end if;
    if v_leg.override_fields<>'{}' then insert into public.operational_resource_overrides values(v_leg.leg_id,v_leg.override_fields); end if;
  end loop;
  with pairs as (
    select sheet_name,source_row_number,
      (array_agg(leg_id) filter(where side='ARR'))[1] arrival,
      (array_agg(leg_id) filter(where side='DEP'))[1] departure,
      min(scheduled_date) filter(where side='ARR') arrival_date,
      min(scheduled_date) filter(where side='DEP') departure_date
    from public.operational_daily_import_legs where batch_id=p_batch_id
    group by sheet_name,source_row_number
    having count(*) filter(where side='ARR')=1 and count(*) filter(where side='DEP')=1
  )
  update public.operational_flight_legs l set
    linked_leg_id=case when l.leg_id=p.arrival then p.departure else p.arrival end,
    turnaround_id='TRN_DAILY_V2_'||md5(p_batch_id::text||':'||p.sheet_name||':'||p.source_row_number::text),
    link_type=case when p.departure_date>p.arrival_date then 'overnight' else 'sameday' end,
    pair_anchor_date=p.arrival_date
  from pairs p where l.leg_id in(p.arrival,p.departure);
  foreach v_day in array v_stage.affected_dates loop
    select to_jsonb(a) into v_before from public.operational_day_authority a where operational_date=v_day;
    select count(*) into v_count from public.operational_daily_import_legs where batch_id=p_batch_id and operational_date=v_day;
    insert into public.operational_day_authority(
      operational_date,authority_source,source_batch_id,leg_count,canonical_checksum,committed_by
    ) values(v_day,'daily_import',p_batch_id,v_count,v_batch.canonical_checksum,v_actor)
    on conflict(operational_date) do update set source_batch_id=excluded.source_batch_id,leg_count=excluded.leg_count,
      canonical_checksum=excluded.canonical_checksum,authority_revision=public.operational_day_authority.authority_revision+1,
      committed_at=now(),committed_by=v_actor,reset_at=null,reset_by=null,reset_reason=null
    returning * into v_authority;
    insert into public.operational_day_authority_events(
      operational_date,event_type,source_batch_id,leg_count,canonical_checksum,authority_revision,actor_user_id
    ) values(v_day,'commit',p_batch_id,v_count,v_batch.canonical_checksum,v_authority.authority_revision,v_actor);
    insert into public.operational_change_events(actor_id,request_id,target_type,target_id,operational_date,changed_fields,before_state,after_state)
    values(v_actor,v_batch.request_id,'dailyAuthority',v_day::text,v_day,array['daily_import'],coalesce(v_before,'null'::jsonb),to_jsonb(v_authority));
  end loop;
  select revision into v_revision from public.operational_workspace_revision where singleton;
  v_result:=jsonb_build_object('status','committed','batchId',p_batch_id,'affectedDates',v_stage.affected_dates,
    'insertedCount',(select count(*) from public.operational_daily_import_legs where batch_id=p_batch_id),
    'replacedCount',v_replaced,'revision',v_revision::text);
  update public.daily_schedule_import_batches set status='committed',committed_at=now(),result=v_result where batch_id=p_batch_id;
  perform pg_notify('operational_projection_wake',p_batch_id::text);
  return public.daily_schedule_import_v1_response(p_batch_id);
end;
$$;

create function public.get_daily_schedule_import_v2_status(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_batch uuid;
begin
  if auth.uid() is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode='42501';
  end if;
  select batch_id into v_batch from public.daily_schedule_import_batches
    where request_id=p_request_id and created_by=auth.uid() and contract_version=2 for update;
  if not found then return null; end if;
  update public.daily_schedule_import_batches set status='expired'
    where batch_id=v_batch and status='validated' and expires_at<=now();
  return public.daily_schedule_import_v1_response(v_batch);
end;
$$;
create function public.cancel_daily_schedule_import_v2(p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode='42501';
  end if;
  perform 1 from public.daily_schedule_import_batches where batch_id=p_batch_id and created_by=auth.uid() and contract_version=2 for update;
  if not found then raise exception 'Daily V2 batch not found' using errcode='P0002'; end if;
  update public.daily_schedule_import_batches set status='cancelled',cancelled_at=now()
    where batch_id=p_batch_id and status in('validated','failed');
  return public.daily_schedule_import_v1_response(p_batch_id);
end;
$$;
revoke all on function public.stage_daily_schedule_import_v2(jsonb),
  public.commit_daily_schedule_import_v2(uuid,text),public.get_daily_schedule_import_v2_status(uuid),public.cancel_daily_schedule_import_v2(uuid)
  from public,anon;
grant execute on function public.stage_daily_schedule_import_v2(jsonb),
  public.commit_daily_schedule_import_v2(uuid,text),public.get_daily_schedule_import_v2_status(uuid),public.cancel_daily_schedule_import_v2(uuid)
  to authenticated;

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
commit;
