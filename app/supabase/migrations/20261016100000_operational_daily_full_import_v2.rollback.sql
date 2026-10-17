-- ============================================================================
-- Rollback Migration: 20261016100000_operational_daily_full_import_v2.rollback.sql
-- Description: Rollback of chunked upload API and bulk-optimized stage/commit.
--              Guards every dropped table against populated rows.
-- ============================================================================

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

-- 1. Safety guard
do $$
declare
  v_tbl text;
  v_count bigint;
  v_blocked text[] := '{}';
begin
  for v_tbl in select unnest(array['operational_daily_import_uploads', 'operational_daily_import_upload_chunks']) loop
    if to_regclass(format('public.%I', v_tbl)) is not null then
      execute format('select count(*) from public.%I', v_tbl) into v_count;
      if v_count > 0 then
        v_blocked := array_append(v_blocked, format('%s (%s rows)', v_tbl, v_count));
      end if;
    end if;
  end loop;

  if cardinality(v_blocked) > 0 then
    raise exception 'Refusing rollback of operational daily full import with populated tables: %', array_to_string(v_blocked, ', ') using errcode = '55000';
  end if;
end $$;

-- 2. Restore previous M5 versions of RPCs
create or replace function public.stage_daily_schedule_import_v2(p_import jsonb) returns jsonb
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

create or replace function public.commit_daily_schedule_import_v2(p_batch_id uuid,p_preview_hash text) returns jsonb
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

create or replace function public.get_daily_schedule_import_v2_status(p_request_id uuid) returns jsonb
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

create or replace function public.cancel_daily_schedule_import_v2(p_batch_id uuid) returns jsonb
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

-- 3. Drop new RPC functions
drop function if exists public.finalize_daily_schedule_import_upload_v2(uuid);
drop function if exists public.append_daily_schedule_import_upload_v2(uuid, integer, jsonb);
drop function if exists public.begin_daily_schedule_import_upload_v2(jsonb, integer, integer);

-- 4. Drop indexes
drop index if exists public.operational_flight_legs_leg_key_scheduled_date_idx;
drop index if exists public.operational_daily_import_legs_pairing_idx;
drop index if exists public.operational_daily_import_uploads_expiry_idx;

-- 5. Drop tables
drop table if exists public.operational_daily_import_upload_chunks;
drop table if exists public.operational_daily_import_uploads;

commit;
