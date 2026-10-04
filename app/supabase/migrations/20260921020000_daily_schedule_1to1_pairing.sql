-- 20260921020000_daily_schedule_1to1_pairing.sql
-- Pair daily import legs 1:1 by (source_import_batch_id, source_row_index),
-- clear pairing fields on surviving active counterparts outside affected_dates on replace/overlay_deleted,
-- and backfill pairing on existing active daily records.

\echo 'Apply commit_daily_schedule_import_v1 1:1 pairing and counterpart clearing'

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- 1. Apply updated commit_daily_schedule_import_v1
CREATE OR REPLACE FUNCTION public.commit_daily_schedule_import_v1(p_batch_id uuid, p_expected_versions jsonb, p_preview_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_batch public.daily_schedule_import_batches%rowtype;
  v_target public.daily_schedule_import_seasons%rowtype;
  v_season public.seasons%rowtype;
  v_next_version integer;
  v_before_count integer;
  v_deleted_count integer;
  v_inserted_count integer;
  v_active_count integer;
  v_rebased_count integer;
  v_before_pax bigint;
  v_after_pax bigint;
  v_staged_pax bigint;
  v_before_pax_known integer;
  v_after_pax_known integer;
  v_staged_pax_known integer;
  v_staged_active_count integer;
  v_day date;
  v_day_count integer;
  v_day_checksum text;
  v_server_high_water bigint := 0;
  v_seq bigint;
  v_receipts jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Daily import commit' using errcode='42501';
  end if;
  if not public.app_operator_has_permission('daily.write') then
    raise exception 'Missing required permission: daily.write' using errcode='42501';
  end if;
  select * into v_batch from public.daily_schedule_import_batches
  where batch_id=p_batch_id and created_by=auth.uid() for update;
  if not found then
    raise exception 'Daily import batch is not available to the current operator' using errcode='42501';
  end if;
  if v_batch.status='committed' then return v_batch.result; end if;
  if v_batch.preview->>'importGuardVersion' is distinct from '1' then
    raise exception 'Stale Daily import contract; restage the preview' using errcode='PT409';
  end if;
  if v_batch.status<>'validated' or v_batch.expires_at<=now() then
    raise exception 'Daily import batch is not valid for commit' using errcode='22023';
  end if;
  if v_batch.preview_hash is distinct from btrim(p_preview_hash) then
    raise exception 'Daily import previewHash changed' using errcode='PT409';
  end if;

  for v_target in select * from public.daily_schedule_import_seasons
    where batch_id=p_batch_id order by season_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_target.season_id,0));
    select * into v_season from public.seasons where id=v_target.season_id for update;
    if not found or v_season.data_version is distinct from v_target.expected_data_version
      or coalesce((p_expected_versions->>v_target.season_id)::integer,-1)
        is distinct from v_target.expected_data_version
    then
      raise exception 'Stale Daily import version for season %',v_target.season_id using errcode='PT409';
    end if;
    if (select count(*) from public.daily_schedule_import_batch_legs legs
        where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id)
      is distinct from v_target.leg_count
    then
      raise exception 'Daily staged leg count drifted for season %',v_target.season_id using errcode='PT409';
    end if;

    if exists(select 1 from public.daily_schedule_import_batch_legs legs
      where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id and legs.matched_record_id is not null
      and not exists (
        select 1 from public.season_flight_records records
        where records.season_id=v_target.season_id and records.record_id=legs.matched_record_id
          and public.is_canonical_flight_leg_active_v1(records.status,records.action)
          and public.canonical_flight_leg_ops_date_v1(records.operational_date,
            records.scheduled_date,records.date,records.scheduled_time,records.schedule)
            =any(v_target.affected_dates)
      ))
    then
      raise exception 'Daily matched record target changed for season %',v_target.season_id using errcode='PT409';
    end if;

    select count(*),coalesce(sum(records.pax),0),count(records.pax)
      into v_before_count,v_before_pax,v_before_pax_known
    from public.canonical_active_flight_records_v1 records
    where records.season_id=v_target.season_id
      and public.canonical_flight_leg_ops_date_v1(records.operational_date,
        records.scheduled_date,records.date,records.scheduled_time,records.schedule)
        =any(v_target.affected_dates);

    update public.season_flight_records records
    set status='deleted', action='deleted', deletion_reason='daily_replacement',
        superseded_by_batch_id=p_batch_id, lifecycle_changed_at=now(),
        lifecycle_changed_by=auth.uid()
    where records.season_id=v_target.season_id
      and public.is_canonical_flight_leg_active_v1(records.status,records.action)
      and public.canonical_flight_leg_ops_date_v1(records.operational_date,
        records.scheduled_date,records.date,records.scheduled_time,records.schedule)
        =any(v_target.affected_dates);
    get diagnostics v_deleted_count = row_count;
    if v_deleted_count is distinct from v_before_count then
      raise exception 'Daily replacement preimage changed for season %',v_target.season_id using errcode='PT409';
    end if;
    if current_setting('app.test_daily_canonical_failpoint',true)='after_delete' then
      raise exception 'injected Daily canonical failure after delete';
    end if;

    -- Clear pairing fields on any surviving active counterpart outside affected_dates
    update public.season_flight_records survivor
    set turnaround_id = null,
        linked_record_id = null,
        link_id = survivor.record_id,
        link_type = null,
        pair_anchor_date = null,
        lifecycle_changed_at = now(),
        lifecycle_changed_by = auth.uid()
    where survivor.season_id = v_target.season_id
      and public.is_canonical_flight_leg_active_v1(survivor.status, survivor.action)
      and survivor.linked_record_id in (
        select deleted.record_id
        from public.season_flight_records deleted
        where deleted.season_id = v_target.season_id
          and deleted.superseded_by_batch_id = p_batch_id
          and deleted.status = 'deleted'
      );

    insert into public.season_flight_records (
      season_id,record_id,link_id,type,airline,flight_number,raw_flight_number,
      request_status_code,route,schedule,aircraft,category,code_shares,int_dom_ind,
      pax,gate,stand,carousel,mct,fb,lb,bhs,ghs,date,scheduled_date,scheduled_time,
      operational_date,iata_season_code,day_of_week,action,source_row_index,
      source_kind,source_side,status,turnaround_id,source_import_batch_id,
      source_import_staging_row_index,source_file_hash,supersedes_record_id,
      lifecycle_changed_at,lifecycle_changed_by,linked_record_id,link_type,pair_anchor_date
    )
    with batch_row_pairs as (
      select
        batch_id,
        season_id,
        source_row_number,
        count(*) filter (where side = 'ARR') as arr_count,
        count(*) filter (where side = 'DEP') as dep_count,
        min(case when side = 'ARR' then canonical_record_id end) as arr_record_id,
        min(case when side = 'DEP' then canonical_record_id end) as dep_record_id,
        min(case when side = 'ARR' then scheduled_date end) as arr_date,
        min(case when side = 'DEP' then scheduled_date end) as dep_date,
        min(case when side = 'ARR' then airline end) as arr_airline,
        min(case when side = 'ARR' then coalesce(leg_data->>'rawFlightNumber', flight_number) end) as arr_flight_raw,
        min(case when side = 'DEP' then coalesce(leg_data->>'rawFlightNumber', flight_number) end) as dep_flight_raw
      from public.daily_schedule_import_batch_legs
      where batch_id=p_batch_id and season_id=v_target.season_id
      group by batch_id, season_id, source_row_number
    )
    select
      legs.season_id,legs.canonical_record_id,
      case
        when pairs.arr_count = 1 and pairs.dep_count = 1 then
          'TRN_DAILY_' || pairs.arr_airline || '_' || pairs.arr_flight_raw || '_' || pairs.dep_flight_raw || '_' || to_char(pairs.arr_date,'YYYY-MM-DD') || '_' || pairs.arr_record_id || '_' || pairs.dep_record_id
        else legs.canonical_record_id
      end as link_id,
      case when legs.side='DEP' then 'D' else 'A' end,
      legs.airline,legs.flight_number,coalesce(legs.leg_data->>'rawFlightNumber',legs.flight_number),
      legs.leg_data->>'requestStatusCode',legs.route,to_char(legs.scheduled_time,'HH24:MI'),
      coalesce(legs.leg_data->>'aircraft',''),coalesce(legs.leg_data->>'category','J'),
      legs.leg_data#>>'{resources,codeShares}',legs.leg_data->>'intDomInd',
      nullif(legs.leg_data#>>'{resources,pax}','')::integer,legs.gate,legs.stand,legs.carousel,
      legs.leg_data#>>'{resources,mct}',legs.leg_data#>>'{resources,fb}',
      legs.leg_data#>>'{resources,lb}',legs.leg_data#>>'{resources,bhs}',
      legs.leg_data#>>'{resources,ghs}',legs.scheduled_date::text,legs.scheduled_date::text,
      to_char(legs.scheduled_time,'HH24:MI'),legs.operational_date::text,legs.season_code,
      extract(dow from legs.scheduled_date)::integer,null,legs.source_row_number,
      'daily',legs.side,'active',
      case
        when pairs.arr_count = 1 and pairs.dep_count = 1 then
          'TRN_DAILY_' || pairs.arr_airline || '_' || pairs.arr_flight_raw || '_' || pairs.dep_flight_raw || '_' || to_char(pairs.arr_date,'YYYY-MM-DD') || '_' || pairs.arr_record_id || '_' || pairs.dep_record_id
        else null
      end as turnaround_id,
      legs.batch_id,
      legs.source_row_number,v_batch.raw_checksum,legs.matched_record_id,now(),auth.uid(),
      case
        when pairs.arr_count = 1 and pairs.dep_count = 1 then
          case when legs.side='ARR' then pairs.dep_record_id else pairs.arr_record_id end
        else null
      end as linked_record_id,
      case
        when pairs.arr_count = 1 and pairs.dep_count = 1 then
          case when pairs.dep_date > pairs.arr_date then 'overnight' else 'sameday' end
        else null
      end as link_type,
      case
        when pairs.arr_count = 1 and pairs.dep_count = 1 then
          to_char(pairs.arr_date,'YYYY-MM-DD')
        else null
      end as pair_anchor_date
    from public.daily_schedule_import_batch_legs legs
    left join batch_row_pairs pairs
      on pairs.batch_id = legs.batch_id
     and pairs.season_id = legs.season_id
     and pairs.source_row_number = legs.source_row_number
    where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id
    order by legs.occurrence_key;
    get diagnostics v_inserted_count = row_count;
    if v_inserted_count is distinct from v_target.leg_count then
      raise exception 'Daily inserted leg count mismatch for season %',v_target.season_id using errcode='23514';
    end if;

    insert into public.season_flight_record_counters(record_id,counter_group,item_index,counter_value)
    select legs.canonical_record_id,'__single__',tokens.ordinality::integer-1,btrim(tokens.token)
    from public.daily_schedule_import_batch_legs legs
    cross join lateral unnest(string_to_array(legs.counter_token,','))
      with ordinality tokens(token,ordinality)
    where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id
      and legs.counter_token is not null and btrim(tokens.token)<>'';

    insert into public.season_modifications (
      season_id,leg_id,action,changed_fields,gate,stand,carousel,mct,fb,lb,bhs,ghs,
      check_in_start,check_in_end,check_in_allocation_mode
    )
    select
      v_target.season_id,
      legs.canonical_record_id,
      coalesce(legs.overlay_rebase_plan->>'action','modified'),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(legs.overlay_rebase_plan->'changedFields')),
        array[]::text[]
      ),
      nullif(legs.overlay_rebase_plan#>>'{resources,gate}','')::integer,
      legs.overlay_rebase_plan#>>'{resources,stand}',
      nullif(legs.overlay_rebase_plan#>>'{resources,carousel}','')::integer,
      legs.overlay_rebase_plan#>>'{resources,mct}',
      legs.overlay_rebase_plan#>>'{resources,fb}',
      legs.overlay_rebase_plan#>>'{resources,lb}',
      legs.overlay_rebase_plan#>>'{resources,bhs}',
      legs.overlay_rebase_plan#>>'{resources,ghs}',
      legs.overlay_rebase_plan#>>'{resources,checkInStart}',
      legs.overlay_rebase_plan#>>'{resources,checkInEnd}',
      legs.overlay_rebase_plan#>>'{resources,checkInAllocationMode}'
    from public.daily_schedule_import_batch_legs legs
    where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id
      and legs.overlay_rebase_plan is not null;
    get diagnostics v_rebased_count = row_count;

    insert into public.season_modification_counters(
      season_id,leg_id,counter_group,item_index,counter_value
    )
    select
      v_target.season_id,
      legs.canonical_record_id,
      coalesce(token_entry.token_group,'__single__'),
      token_entry.item_index,
      token_entry.token_value
    from public.daily_schedule_import_batch_legs legs
    cross join lateral (
      select
        coalesce(c->>'counterGroup','__single__') as token_group,
        coalesce((c->>'itemIndex')::integer,0) as item_index,
        btrim(c->>'counterValue') as token_value
      from jsonb_array_elements(legs.overlay_rebase_plan->'counters') as c
    ) token_entry
    where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id
      and legs.overlay_rebase_plan is not null
      and token_entry.token_value<>'';

    update public.season_flight_records records
    set status='deleted',action='deleted',deletion_reason='overlay_deleted',
        lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
    from public.season_modifications mods
    where records.season_id=v_target.season_id
      and records.source_import_batch_id=p_batch_id
      and mods.season_id=records.season_id and mods.leg_id=records.record_id
      and mods.action='deleted'
      and public.is_canonical_flight_leg_active_v1(records.status,records.action);

    -- Clear pairing on any surviving active counterpart of an overlay-deleted leg
    update public.season_flight_records survivor
    set turnaround_id = null,
        linked_record_id = null,
        link_id = survivor.record_id,
        link_type = null,
        pair_anchor_date = null,
        lifecycle_changed_at = now(),
        lifecycle_changed_by = auth.uid()
    where survivor.season_id = v_target.season_id
      and survivor.source_import_batch_id = p_batch_id
      and public.is_canonical_flight_leg_active_v1(survivor.status, survivor.action)
      and survivor.linked_record_id in (
        select deleted.record_id
        from public.season_flight_records deleted
        where deleted.season_id = v_target.season_id
          and deleted.source_import_batch_id = p_batch_id
          and deleted.status = 'deleted'
      );

    if current_setting('app.test_daily_canonical_failpoint',true)='after_insert' then
      raise exception 'injected Daily canonical failure after insert';
    end if;

    select count(*),coalesce(sum(records.pax),0),count(records.pax)
      into v_active_count,v_after_pax,v_after_pax_known
    from public.canonical_active_flight_records_v1 records
    where records.season_id=v_target.season_id
      and public.canonical_flight_leg_ops_date_v1(records.operational_date,
        records.scheduled_date,records.date,records.scheduled_time,records.schedule)
        =any(v_target.affected_dates);
    select count(*),coalesce(sum(nullif(legs.leg_data#>>'{resources,pax}','')::integer),0),
      count(nullif(legs.leg_data#>>'{resources,pax}','')::integer)
      into v_staged_active_count,v_staged_pax,v_staged_pax_known
    from public.daily_schedule_import_batch_legs legs
    left join public.season_modifications mods
      on mods.season_id=legs.season_id and mods.leg_id=legs.canonical_record_id
     and mods.action='deleted'
    where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id
      and mods.leg_id is null;
    if v_active_count is distinct from v_staged_active_count
      or v_after_pax is distinct from v_staged_pax
      or v_after_pax_known is distinct from v_staged_pax_known
    then
      raise exception 'Daily canonical reconciliation failed for season %',v_target.season_id using errcode='23514';
    end if;

    v_next_version := v_target.expected_data_version+1;
    for v_day in select unnest(v_target.affected_dates) order by 1
    loop
      select count(*),encode(pg_catalog.sha256(convert_to(coalesce(string_agg(
        public.canonical_flight_leg_occurrence_key_v1(records.season_id,
          records.operational_date,records.scheduled_date,records.date,
          records.scheduled_time,records.schedule,records.type,records.airline,
          records.flight_number,records.raw_flight_number,records.route)
          ||'|'||coalesce(records.pax::text,'NULL')||'|'||coalesce(records.gate::text,'NULL')
          ||'|'||coalesce(records.stand,'NULL')||'|'||coalesce(records.carousel::text,'NULL'),
        E'\n' order by records.record_id),''),'UTF8')),'hex')
        into v_day_count,v_day_checksum
      from public.canonical_active_flight_records_v1 records
      where records.season_id=v_target.season_id
        and public.canonical_flight_leg_ops_date_v1(records.operational_date,
          records.scheduled_date,records.date,records.scheduled_time,records.schedule)=v_day;
      insert into public.schedule_replacement_scopes(
        season_id,ops_date,authority_source,source_batch_id,expected_leg_count,
        canonical_checksum,data_version,committed_at,committed_by,reset_at,reset_by,reset_reason
      ) values (
        v_target.season_id,v_day,'daily',p_batch_id,v_day_count,v_day_checksum,
        v_next_version,now(),auth.uid(),null,null,null
      ) on conflict(season_id,ops_date) do update set
        authority_source=excluded.authority_source,source_batch_id=excluded.source_batch_id,
        expected_leg_count=excluded.expected_leg_count,
        canonical_checksum=excluded.canonical_checksum,data_version=excluded.data_version,
        committed_at=excluded.committed_at,committed_by=excluded.committed_by,
        reset_at=null,reset_by=null,reset_reason=null;
    end loop;

    if current_setting('app.test_daily_canonical_failpoint',true)='before_audit' then
      raise exception 'injected Daily canonical failure before audit';
    end if;
    update public.seasons
    set data_version=v_next_version,
        last_synced_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
    where id=v_target.season_id and data_version=v_target.expected_data_version;
    if not found then
      raise exception 'Season % changed during Daily import commit',v_target.season_id using errcode='PT409';
    end if;
    insert into public.season_change_events(
      event_id,season_id,client_id,op_id,actor_user_id,target_type,target_id,
      changed_fields,op_payload
    ) values (
      'daily-canonical-v2:'||p_batch_id::text||':'||v_target.season_id,
      v_target.season_id,'daily-canonical-v2',p_batch_id::text||':'||v_target.season_id,auth.uid(),
      'dailyImport',v_target.season_id,array['canonicalFlightLegs','seasonMetadata'],
      jsonb_build_object(
        'kind','commit_daily_schedule_canonical_v2','batchId',p_batch_id,
        'previewHash',v_batch.preview_hash,'rangeStart',v_target.range_start,
        'rangeEnd',v_target.range_end,'affectedDates',v_target.affected_dates,
        'beforeCount',v_before_count,'deletedCount',v_deleted_count,
        'insertedCount',v_inserted_count,'activeAfterCount',v_active_count,
        'beforePax',v_before_pax,'afterPax',v_after_pax,
        'beforePaxKnownCount',v_before_pax_known,
        'afterPaxKnownCount',v_after_pax_known,'overlayRebasedCount',v_rebased_count,
        'dataVersion',v_next_version,'rawChecksum',v_batch.raw_checksum,
        'canonicalChecksum',v_batch.canonical_checksum,
        'resourcePolicyHash',v_batch.resource_policy_hash
      )
    ) returning server_seq into v_seq;
    v_server_high_water := greatest(v_server_high_water,v_seq);
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'seasonId',v_target.season_id,'seasonCode',v_target.season_code,
      'dataVersion',v_next_version,'serverHighWater',v_seq,
      'beforeCount',v_before_count,'deletedCount',v_deleted_count,
      'insertedCount',v_inserted_count,'activeAfterCount',v_active_count,
      'beforePax',v_before_pax,'afterPax',v_after_pax,
      'overlayRebasedCount',v_rebased_count
    ));
  end loop;

  v_result := jsonb_build_object(
    'batchId',p_batch_id,'requestId',v_batch.request_id,'status','committed',
    'previewHash',v_batch.preview_hash,'seasons',v_receipts,
    'serverHighWater',v_server_high_water,'rawChecksum',v_batch.raw_checksum,
    'canonicalChecksum',v_batch.canonical_checksum
  );
  update public.daily_schedule_import_batches
  set status='committed',result=v_result,committed_at=now()
  where batch_id=p_batch_id and status='validated';
  if not found then
    raise exception 'Daily import batch changed before receipt was persisted' using errcode='PT409';
  end if;
  return v_result;
end;
$function$;

-- 2. Backfill 1:1 turnaround pairs on existing active daily records
create temp table temp_daily_pairs on commit drop as
with row_agg as (
  select
    season_id,
    source_import_batch_id,
    source_row_index,
    count(*) filter (where type = 'A') as a_cnt,
    count(*) filter (where type = 'D') as d_cnt,
    min(case when type = 'A' then record_id end) as arr_id,
    min(case when type = 'D' then record_id end) as dep_id,
    min(case when type = 'A' then airline end) as arr_airline,
    min(case when type = 'A' then raw_flight_number end) as arr_raw_flight,
    min(case when type = 'D' then raw_flight_number end) as dep_raw_flight,
    min(case when type = 'A' then date end) as arr_date,
    min(case when type = 'D' then date end) as dep_date
  from public.season_flight_records
  where status = 'active' and source_kind = 'daily'
    and source_import_batch_id is not null and source_row_index is not null
  group by season_id, source_import_batch_id, source_row_index
  having count(*) filter (where type = 'A') = 1
     and count(*) filter (where type = 'D') = 1
)
select
  arr_id,
  dep_id,
  'TRN_DAILY_' || arr_airline || '_' || arr_raw_flight || '_' || dep_raw_flight || '_' || arr_date || '_' || arr_id || '_' || dep_id as trn_id,
  case when dep_date > arr_date then 'overnight' else 'sameday' end as l_type,
  arr_date
from row_agg;

create index on temp_daily_pairs (arr_id);
create index on temp_daily_pairs (dep_id);

with update_arr as (
  update public.season_flight_records r
  set turnaround_id = p.trn_id,
      link_id = p.trn_id,
      linked_record_id = p.dep_id,
      link_type = p.l_type,
      pair_anchor_date = p.arr_date
  from temp_daily_pairs p
  where r.record_id = p.arr_id
  returning r.record_id
),
update_dep as (
  update public.season_flight_records r
  set turnaround_id = p.trn_id,
      link_id = p.trn_id,
      linked_record_id = p.arr_id,
      link_type = p.l_type,
      pair_anchor_date = p.arr_date
  from temp_daily_pairs p
  where r.record_id = p.dep_id
  returning r.record_id
)
select 
  (select count(*) from temp_daily_pairs) as pairs_count,
  (select count(*) from update_arr) as arr_updated,
  (select count(*) from update_dep) as dep_updated;

-- 3. Bump data_version and last_synced_at on affected seasons
update public.seasons
set data_version = data_version + 1,
    last_synced_at = floor(extract(epoch from clock_timestamp())*1000)::bigint
where id in (
  select distinct season_id from public.season_flight_records where source_kind = 'daily' and status = 'active'
);

notify pgrst, 'reload schema';
commit;
