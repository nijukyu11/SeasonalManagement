-- ============================================================================
-- Migration: 20261016090000_seasonal_full_import_v1.sql
-- Description: Seasonal full-file planning import simplify:
--   - Full-file snapshot semantics only; no caller-selectable merge strategy.
--   - Reject obsolete merge requests (22023).
--   - Internal apply_strategy='replace'.
--   - Only 'seasonal.write' permission required (no 'season.repair').
--   - Stage V2 parser reuse runs as 'standard' mode to avoid repair permission.
--   - Every active draft absent from the incoming file is tombstoned,
--     including independent manual drafts.
--   - Preserves resources for uniquely matched flights (pax 0/null, gate, stand, counters, windows).
--   - Invalidates existing uncommitted legacy merge batches.
--   - Rejects committing legacy merge batches (40001).
-- ============================================================================

begin;
set local lock_timeout='15s';
set local statement_timeout='60s';

-- 1. Safely invalidate any existing uncommitted contract_version=4 batches lacking fullFileImport.
update public.season_import_batches
set status = 'failed',
    diagnostics = diagnostics || jsonb_build_array(jsonb_build_object(
      'code', 'legacy-import-unsupported',
      'message', 'Legacy partial or selective import batches cannot be committed after full-file import cutover'
    ))
where contract_version = 4
  and status = 'validated'
  and coalesce((preview->>'fullFileImport')::boolean, false) is not true;

-- 2. stage_seasonal_draft_import_v1
create or replace function public.stage_seasonal_draft_import_v1(p_import jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='45s' as $$
declare
 v_actor uuid:=auth.uid(); v_request uuid; v_b public.season_import_batches%rowtype;
 v_s public.seasonal_draft_import_stages%rowtype; v_w public.seasonal_draft_workspace%rowtype;
 v_target text; v_version integer; v_checksum text; v_diagnostics jsonb; v_warnings jsonb:='[]';
 v_preview jsonb; v_counts jsonb; v_manifest text; v_valid boolean; v_collision_count bigint:=0;
 v_ignored constant text[]:=array['draft_id','link_id','source_row_index','linked_source_row_index','source_import_batch_id',
   'source_import_staging_row_index','source_file_hash','superseded_by_batch_id','supersedes_draft_id','action',
   'created_at','updated_at','updated_by','lifecycle_changed_at','lifecycle_changed_by','deletion_reason'];
begin
 if v_actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.app_operator_has_permission('seasonal.write') then
   raise exception 'Missing seasonal import permission' using errcode='42501'; end if;
 if jsonb_typeof(p_import) is distinct from 'object' or nullif(p_import->>'requestId','') is null then
   raise exception 'Import object and requestId required' using errcode='22023'; end if;
 if octet_length(p_import::text)>67108864 then raise exception 'Import exceeds 64 MiB' using errcode='22023'; end if;
 if p_import ? 'strategy' then
   raise exception 'strategy parameter is obsolete; seasonal planning imports are full-file only' using errcode='22023';
 end if;
 if coalesce(p_import->>'expectedRevision','') !~ '^(0|[1-9][0-9]*)$' then
   raise exception 'expectedRevision required' using errcode='22023'; end if;
 v_request:=(p_import->>'requestId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('draft-import:'||v_request::text,0));
 select b.* into v_b from public.season_import_batches b where b.request_id=v_request;
 if found then
   if v_b.created_by<>v_actor then raise exception 'Import belongs to another operator' using errcode='42501'; end if;
   select * into v_s from public.seasonal_draft_import_stages where batch_id=v_b.batch_id;
   if not found or v_s.request_payload is distinct from p_import then
     raise exception 'requestId payload conflict' using errcode='22023'; end if;
   return public.seasonal_draft_import_response_v1(v_b.batch_id);
 end if;
 select data_version into v_version from public.seasons where id=p_import->>'seasonId';
 -- V2 owns canonicalization, validation, limits and deterministic duplicate resolution.
 -- Its SHARE table lock precedes the draft workspace lock; commit uses the same order.
 -- Mode is always standard so parser reuse requires only 'seasonal.write' permission.
 perform public.stage_seasonal_import_v2(jsonb_build_object(
   'requestId',v_request,'checksum',p_import->'checksum','mode','standard',
   'seasonId',p_import->'seasonId','seasonCode',p_import->'seasonCode','expectedDataVersion',coalesce(v_version,0),
   'fileName',p_import->'fileName','sourceRows',case when jsonb_typeof(p_import->'sourceRows')='array' then (
     select jsonb_agg(x.value||jsonb_build_object('sta',public.normalize_seasonal_import_time_v3(x.value->'sta'),
       'std',public.normalize_seasonal_import_time_v3(x.value->'std')) order by x.ordinality)
     from jsonb_array_elements(p_import->'sourceRows') with ordinality x(value,ordinality)) else p_import->'sourceRows' end));
 select * into strict v_b from public.season_import_batches where request_id=v_request;
 v_target:=v_b.result#>>'{_staging,targetSeasonId}';
 select * into v_w from public.seasonal_draft_workspace where season_id=v_target for share;
 if (found and (v_w.epoch is distinct from nullif(p_import->>'expectedEpoch','')::uuid
       or v_w.revision is distinct from (p_import->>'expectedRevision')::bigint))
   or (not found and (p_import->>'expectedRevision'<>'0' or nullif(p_import->>'expectedEpoch','') is not null)) then
   raise exception 'Draft snapshot changed' using errcode='40001'; end if;
 v_checksum:=encode(sha256(convert_to(coalesce(public.seasonal_planning_snapshot_v1(v_target),'null'::jsonb)::text,'UTF8')),'hex');
 insert into public.seasonal_draft_import_stages values(v_b.batch_id,p_import,v_target,v_w.epoch,coalesce(v_w.revision,0),v_checksum);
 v_diagnostics:=v_b.diagnostics;
 if v_b.status='validated' then
   select coalesce(jsonb_agg(issue order by staging_row_index,issue_order),'[]') into v_warnings
     from (select * from public.seasonal_import_atomic_preview_v2(v_b.batch_id)
       where item_kind='diagnostic' and issue->>'severity'='warning' order by staging_row_index,issue_order limit 1999) warnings;
   drop table if exists pg_temp.draft_import_incoming;
   create temporary table draft_import_incoming on commit drop as
   with generated as materialized (
     select g.*,public.seasonal_draft_id_v1(v_target,g.type,g.scheduled_date::date,g.airline,g.flight_number) stable_id
     from public.generate_seasonal_import_records_v2(v_b.batch_id) g
   )
   select g.*,coalesce(matched.ids[1],g.stable_id) draft_id,matched.ids matched_ids,manual.ids manual_ids,
     to_jsonb(existing) before_state,
     coalesce(to_jsonb(manual_row),to_jsonb(existing),jsonb_build_object('counters','[]'::jsonb,'checkin_windows','[]'::jsonb,'created_at',now()))
       ||jsonb_build_object('draft_id',coalesce(matched.ids[1],g.stable_id),'season_id',v_target,'link_id',coalesce(g.link_id,''),
         'type',g.type,'airline',g.airline,'flight_number',g.flight_number,'raw_flight_number',coalesce(g.raw_flight_number,''),
         'route',g.route,'schedule',g.schedule,'aircraft',coalesce(g.aircraft,''),'category',coalesce(g.category,''),
         'code_shares',g.code_shares,'int_dom_ind',g.int_dom_ind,'date',g.scheduled_date,'scheduled_date',g.scheduled_date,
         'scheduled_time',g.schedule,'operational_date',g.operational_date,'iata_season_code',v_b.season_code,
         'flight_series_id','SER_'||g.type||'_'||regexp_replace(g.airline,'[^A-Z0-9]+','_','g')||'_'
           ||regexp_replace(g.flight_number,'[^A-Z0-9]+','_','g')||'_'||regexp_replace(g.route,'[^A-Z0-9]+','_','g'),'day_of_week',g.day_of_week,
         'source_row_index',g.source_row_index,'linked_source_row_index',g.linked_source_row_index,
         'source_kind','imported','source_side',case g.type when 'A' then 'ARR' else 'DEP' end,
         'status','active','action',null,'source_import_batch_id',v_b.batch_id,'source_import_staging_row_index',r.row_index,
         'source_file_hash',v_b.checksum,'supersedes_draft_id',coalesce(manual.ids[1],existing.supersedes_draft_id),
         'lifecycle_changed_at',case when existing.status='deleted' then now() else existing.lifecycle_changed_at end,
         'lifecycle_changed_by',case when existing.status='deleted' then v_actor else existing.lifecycle_changed_by end,
         'superseded_by_batch_id',null,'deletion_reason',null,'updated_at',now(),'updated_by',v_actor) after_state
   from generated g
   join public.season_import_batch_rows r on r.batch_id=v_b.batch_id and (r.row_data->>'rowIndex')::integer=g.source_row_index
   left join lateral (select array_agg(d.draft_id order by (d.draft_id=g.stable_id) desc,d.draft_id) ids
     from public.seasonal_flight_drafts d where d.season_id=v_target and d.source_kind='imported'
       and (d.draft_id=g.stable_id or (coalesce(d.scheduled_date,d.date)=g.scheduled_date and d.type=g.type
         and upper(btrim(d.airline))=g.airline and upper(btrim(d.flight_number))=g.flight_number))) matched on true
   left join public.seasonal_flight_drafts existing on existing.draft_id=matched.ids[1]
   left join lateral (select array_agg(d.draft_id order by d.draft_id) ids from public.seasonal_flight_drafts d
     where d.season_id=v_target and d.source_kind='manual' and d.status='active' and coalesce(d.scheduled_date,d.date)=g.scheduled_date
       and d.type=g.type and upper(btrim(d.airline))=g.airline and upper(btrim(d.flight_number))=g.flight_number) manual on true
   left join public.seasonal_flight_drafts manual_row on manual_row.draft_id=manual.ids[1];
   with conflicts as materialized (
     select jsonb_build_object('code','draft-identity-collision','draftId',draft_id,'sourceRowIndex',source_row_index,
       'importedDraftIds',matched_ids,'manualDraftIds',manual_ids) issue
       from pg_temp.draft_import_incoming where cardinality(matched_ids)>1 or cardinality(manual_ids)>1
     union all select jsonb_build_object('code','duplicate-draft-target','draftId',draft_id)
       from pg_temp.draft_import_incoming group by draft_id having count(*)>1
     union all select jsonb_build_object('code','draft-id-ownership-conflict','draftId',i.draft_id)
       from pg_temp.draft_import_incoming i join public.seasonal_flight_drafts d on d.draft_id=i.draft_id
       where d.season_id<>v_target or d.source_kind<>'imported'
   )
   select v_diagnostics||coalesce((select jsonb_agg(issue) from (select issue from conflicts order by issue->>'draftId' limit 1999) page),'[]'),
     (select count(*) from conflicts) into v_diagnostics,v_collision_count;
   if jsonb_array_length(v_diagnostics)=0 then
     insert into public.seasonal_draft_import_entries
     select v_b.batch_id,i.draft_id,'upsert',i.before_state,i.after_state||jsonb_build_object(
       'linked_draft_id',partner.draft_id,'turnaround_id',case when partner.draft_id is not null then i.turnaround_id end,
       'link_type',case when partner.draft_id is not null then i.link_type end,
       'pair_anchor_date',case when partner.draft_id is not null then i.pair_anchor_date end)
     from pg_temp.draft_import_incoming i left join pg_temp.draft_import_incoming partner on partner.record_id=i.linked_record_id;

     -- Full-file import: every active draft absent from the incoming file (including independent manual drafts) is tombstoned.
     insert into public.seasonal_draft_import_entries
     select v_b.batch_id,d.draft_id,'delete',to_jsonb(d),to_jsonb(d)||jsonb_build_object(
       'status','deleted','action','deleted','deletion_reason','draft_import_replaced','superseded_by_batch_id',v_b.batch_id,
       'linked_draft_id',null,'turnaround_id',null,'link_type',null,'pair_anchor_date',null,
       'link_id',d.draft_id,'linked_source_row_index',null,
       'lifecycle_changed_at',now(),'lifecycle_changed_by',v_actor,'updated_at',now(),'updated_by',v_actor)
     from public.seasonal_flight_drafts d where d.season_id=v_target and d.status='active'
       and not exists(select 1 from public.seasonal_draft_import_entries e where e.batch_id=v_b.batch_id and e.draft_id=d.draft_id);

 end if;
 end if;
 with compared as materialized (
   select operation,before_state is null is_new,before_state->>'source_kind' prior_kind,
     (before_state-v_ignored) is distinct from (after_state-v_ignored) changed
   from public.seasonal_draft_import_entries where batch_id=v_b.batch_id
 )
 select jsonb_build_object('sourceRowCount',v_b.source_row_count,'generatedOccurrenceCount',v_b.generated_record_count,
   'insertCount',count(*) filter(where operation='upsert' and is_new),
   'baselineUpdateCount',count(*) filter(where operation='upsert' and not is_new and changed),
   'unchangedCount',count(*) filter(where operation='upsert' and not is_new and not changed),
   'removeImportedCount',count(*) filter(where operation='delete' and prior_kind='imported'),
   'supersedeManualCount',count(*) filter(where operation='delete' and prior_kind='manual'),
   'unlinkCount',count(*) filter(where operation='unlink'),
   'preservedOutsideScopeCount',0) into v_counts
 from compared;
 select encode(sha256(convert_to(coalesce(string_agg(draft_id||':'||encode(sha256(convert_to(after_state::text,'UTF8')),'hex'),'|' order by draft_id),''),'UTF8')),'hex')
 into v_manifest from public.seasonal_draft_import_entries where batch_id=v_b.batch_id;
 v_valid:=v_b.status='validated' and jsonb_array_length(v_diagnostics)=0;
 v_preview:=jsonb_build_object('importGuardVersion',2,'valid',v_valid,'strategy','replace','fullFileImport',true,
   'seasonId',v_target,
   'draftEpoch',v_w.epoch,'draftRevision',coalesce(v_w.revision,0)::text,'draftChecksum',v_checksum,
   'manifestChecksum',v_manifest,'counts',v_counts,'diagnostics',v_diagnostics,'warnings',v_warnings,
   'diagnosticCount',jsonb_array_length(v_b.diagnostics)+v_collision_count,'diagnosticsTruncated',v_collision_count>1999,
   'inputChecksum',encode(sha256(convert_to(p_import::text,'UTF8')),'hex'));
 update public.season_import_batches set contract_version=4,apply_strategy='replace',
   status=case when v_valid then 'validated' else 'failed' end,preview=v_preview,
   preview_hash=encode(sha256(convert_to(v_preview::text,'UTF8')),'hex'),diagnostics=v_diagnostics,expires_at=now()+interval '2 hours'
 where batch_id=v_b.batch_id;
 return public.seasonal_draft_import_response_v1(v_b.batch_id);
end;
$$;
revoke all on function public.stage_seasonal_draft_import_v1(jsonb) from public,anon;
grant execute on function public.stage_seasonal_draft_import_v1(jsonb) to authenticated;

-- 3. commit_seasonal_draft_import_v1
create or replace function public.commit_seasonal_draft_import_v1(p_batch_id uuid,p_preview_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='45s' as $$
declare
 v_b public.season_import_batches%rowtype; v_s public.seasonal_draft_import_stages%rowtype;
 v_w public.seasonal_draft_workspace%rowtype; v_actor uuid:=auth.uid(); v_result jsonb; v_checksum text;
begin
 select * into v_b from public.season_import_batches where batch_id=p_batch_id and contract_version=4;
 if not found or v_actor is null or v_b.created_by<>v_actor then raise exception 'Import unavailable' using errcode='42501'; end if;
 if not public.app_operator_has_permission('seasonal.write') then
   raise exception 'Missing seasonal import permission' using errcode='42501'; end if;
 if v_b.status='committed' then return public.seasonal_draft_import_response_v1(p_batch_id); end if;
 if v_b.apply_strategy is distinct from 'replace' or coalesce((v_b.preview->>'fullFileImport')::boolean, false) is not true then
   raise exception 'Legacy staged import preview cannot be committed; re-stage with full-file import' using errcode='40001'; end if;
 select * into strict v_s from public.seasonal_draft_import_stages where batch_id=p_batch_id;
 -- Before workspace locks, serialize season-code creation and the V2 parser's SHARE lock.
 lock table public.seasons in share row exclusive mode;
 perform 1 from public.seasons where id=v_s.target_season_id for update;
 select * into v_w from public.seasonal_draft_workspace where season_id=v_s.target_season_id for update;
 select * into v_b from public.season_import_batches where batch_id=p_batch_id for update;
 if v_b.preview_hash is distinct from p_preview_hash then raise exception 'Preview hash changed' using errcode='40001'; end if;
 if v_b.status='committed' then return public.seasonal_draft_import_response_v1(p_batch_id); end if;
 if v_b.status<>'validated' or v_b.expires_at<=now() then raise exception 'Import is not committable' using errcode='40001'; end if;
 v_checksum:=encode(sha256(convert_to(coalesce(public.seasonal_planning_snapshot_v1(v_s.target_season_id),'null'::jsonb)::text,'UTF8')),'hex');
 if v_w.epoch is distinct from v_s.draft_epoch or coalesce(v_w.revision,0)<>v_s.draft_revision or v_checksum<>v_s.draft_checksum then
   raise exception 'Draft snapshot changed' using errcode='40001'; end if;
 if v_s.draft_epoch is null then
   if exists(select 1 from public.seasons where upper(btrim(season_code))=upper(btrim(v_b.season_code))) then
     raise exception 'Season identity changed' using errcode='40001'; end if;
   insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
   values(v_s.target_season_id,v_b.season_code,v_b.season_code,v_b.file_name,0,'','',0,0,0);
 end if;
 insert into public.seasonal_flight_drafts
 select (jsonb_populate_record(null::public.seasonal_flight_drafts,e.after_state||jsonb_build_object('updated_at',now(),
   'created_at',coalesce(e.before_state->'created_at',to_jsonb(now()))))).*
 from public.seasonal_draft_import_entries e where e.batch_id=p_batch_id
 on conflict(draft_id) do update set
   link_id=excluded.link_id,type=excluded.type,airline=excluded.airline,flight_number=excluded.flight_number,
   raw_flight_number=excluded.raw_flight_number,request_status_code=excluded.request_status_code,route=excluded.route,schedule=excluded.schedule,
   aircraft=excluded.aircraft,category=excluded.category,code_shares=excluded.code_shares,int_dom_ind=excluded.int_dom_ind,
   pax=excluded.pax,gate=excluded.gate,stand=excluded.stand,carousel=excluded.carousel,mct=excluded.mct,fb=excluded.fb,lb=excluded.lb,bhs=excluded.bhs,ghs=excluded.ghs,
   date=excluded.date,scheduled_date=excluded.scheduled_date,scheduled_time=excluded.scheduled_time,operational_date=excluded.operational_date,
   iata_season_code=excluded.iata_season_code,flight_series_id=excluded.flight_series_id,day_of_week=excluded.day_of_week,action=excluded.action,
   source_row_index=excluded.source_row_index,linked_source_row_index=excluded.linked_source_row_index,link_type=excluded.link_type,
   pair_anchor_date=excluded.pair_anchor_date,linked_draft_id=excluded.linked_draft_id,turnaround_id=excluded.turnaround_id,
   source_kind=excluded.source_kind,source_side=excluded.source_side,status=excluded.status,source_import_batch_id=excluded.source_import_batch_id,
   source_import_staging_row_index=excluded.source_import_staging_row_index,source_file_hash=excluded.source_file_hash,
   superseded_by_batch_id=excluded.superseded_by_batch_id,supersedes_draft_id=excluded.supersedes_draft_id,deletion_reason=excluded.deletion_reason,
   lifecycle_changed_at=excluded.lifecycle_changed_at,lifecycle_changed_by=excluded.lifecycle_changed_by,updated_at=excluded.updated_at,updated_by=excluded.updated_by,
   counters=excluded.counters,checkin_windows=excluded.checkin_windows,check_in_start=excluded.check_in_start,
   check_in_end=excluded.check_in_end,check_in_allocation_mode=excluded.check_in_allocation_mode
 where public.seasonal_flight_drafts.season_id=excluded.season_id;
 -- The ON CONFLICT predicate also fences an ID claimed by another season after
 -- preview. Reject the whole transaction rather than silently skipping that row.
 if exists(select 1 from public.seasonal_draft_import_entries e join public.seasonal_flight_drafts d using(draft_id)
   where e.batch_id=p_batch_id and d.season_id<>v_s.target_season_id) then
   raise exception 'Draft identity ownership changed' using errcode='40001'; end if;
 if exists(select 1 from public.seasonal_draft_import_entries e join public.seasonal_flight_drafts d using(draft_id)
   left join public.seasonal_flight_drafts p on p.draft_id=d.linked_draft_id where e.batch_id=p_batch_id and d.linked_draft_id is not null
     and (p.status is distinct from 'active' or d.status<>'active' or p.season_id<>d.season_id or p.type=d.type
       or p.linked_draft_id is distinct from d.draft_id or d.turnaround_id is null or p.turnaround_id is distinct from d.turnaround_id
       or d.link_type is null or p.link_type is distinct from d.link_type or d.pair_anchor_date is null or p.pair_anchor_date is distinct from d.pair_anchor_date)) then
   raise exception 'Import pairing is not reciprocal' using errcode='22023'; end if;
 insert into public.seasonal_draft_events(season_id,client_id,op_id,actor_user_id,server_seq,target_id,changed_fields,before_state,after_state)
 select v_s.target_season_id,'draft-import-v1:'||v_actor::text,v_b.request_id::text||':'||e.draft_id,v_actor,
   nextval('public.seasonal_draft_event_seq'),e.draft_id,
   array(select key from jsonb_each(to_jsonb(d)) where e.before_state->key is distinct from value),e.before_state,to_jsonb(d)
 from public.seasonal_draft_import_entries e join public.seasonal_flight_drafts d using(draft_id) where e.batch_id=p_batch_id order by e.draft_id;
 update public.seasons set file_name=v_b.file_name,
   effective_start=least(
     (select min(date::date) from public.seasonal_flight_drafts where season_id=v_s.target_season_id and status='active'),
     (select min((row_data->>'effective')::date) from public.season_import_batch_rows where batch_id=p_batch_id))::text,
   effective_end=greatest(
     (select max(date::date) from public.seasonal_flight_drafts where season_id=v_s.target_season_id and status='active'),
     (select max((row_data->>'discontinue')::date) from public.season_import_batch_rows where batch_id=p_batch_id))::text,
   total_legs=(select count(*) from public.seasonal_flight_drafts where season_id=v_s.target_season_id and status='active'),
   total_source_rows=v_b.source_row_count where id=v_s.target_season_id;
 select * into strict v_w from public.seasonal_draft_workspace where season_id=v_s.target_season_id;
 v_result:=jsonb_build_object('status','committed','batchId',p_batch_id,'seasonId',v_s.target_season_id,
   'draftEpoch',v_w.epoch,'draftRevision',v_w.revision::text,'counts',v_b.preview->'counts',
   'serverHighWater',(select coalesce(max(server_seq),0)::text from public.seasonal_draft_events where season_id=v_s.target_season_id));
 insert into public.seasonal_draft_mutation_receipts(actor_id,request_id,season_id,request_payload,result)
 values(v_actor,v_b.request_id,v_s.target_season_id,jsonb_build_object('kind','draft-import-v1','batchId',p_batch_id,'previewHash',p_preview_hash),v_result);
 update public.season_import_batches set status='committed',season_id=v_s.target_season_id,result=v_result,committed_at=now() where batch_id=p_batch_id;
 return public.seasonal_draft_import_response_v1(p_batch_id);
end;
$$;
revoke all on function public.commit_seasonal_draft_import_v1(uuid,text) from public,anon;
grant execute on function public.commit_seasonal_draft_import_v1(uuid,text) to authenticated;

-- 4. get_seasonal_draft_import_status_v1
create or replace function public.get_seasonal_draft_import_status_v1(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.season_import_batches%rowtype;
begin
 select * into b from public.season_import_batches where request_id=p_request_id and contract_version=4 and created_by=auth.uid();
 if not found or not public.app_operator_has_permission('seasonal.write') then
   raise exception 'Import unavailable' using errcode='42501'; end if;
 return public.seasonal_draft_import_response_v1(b.batch_id);
end;
$$;
revoke all on function public.get_seasonal_draft_import_status_v1(uuid) from public,anon;
grant execute on function public.get_seasonal_draft_import_status_v1(uuid) to authenticated;

-- 5. cancel_seasonal_draft_import_v1
create or replace function public.cancel_seasonal_draft_import_v1(p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.season_import_batches%rowtype;
begin
 select * into b from public.season_import_batches where batch_id=p_batch_id and contract_version=4 and created_by=auth.uid() for update;
 if not found or not public.app_operator_has_permission('seasonal.write') then
   raise exception 'Import unavailable' using errcode='42501'; end if;
 if b.status='committed' then raise exception 'Committed import cannot be cancelled' using errcode='40001'; end if;
 update public.season_import_batches set status='cancelled',cancelled_at=coalesce(cancelled_at,now()) where batch_id=p_batch_id;
 return public.seasonal_draft_import_response_v1(p_batch_id);
end;
$$;
revoke all on function public.cancel_seasonal_draft_import_v1(uuid) from public,anon;
grant execute on function public.cancel_seasonal_draft_import_v1(uuid) to authenticated;

-- 6. get_seasonal_draft_import_preview_v1
create or replace function public.get_seasonal_draft_import_preview_v1(p_batch_id uuid,p_after_draft_id text default null,p_page_size integer default 100) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.season_import_batches%rowtype; s public.seasonal_draft_import_stages%rowtype; w public.seasonal_draft_workspace%rowtype; result jsonb;
begin
 select * into b from public.season_import_batches where batch_id=p_batch_id and contract_version=4 and created_by=auth.uid();
 if not found or not public.app_operator_has_permission('seasonal.write') then
   raise exception 'Import unavailable' using errcode='42501'; end if;
 if p_page_size is null or p_page_size not between 1 and 500 then raise exception 'Invalid page size' using errcode='22023'; end if;
 select * into strict s from public.seasonal_draft_import_stages where batch_id=p_batch_id;
 select * into w from public.seasonal_draft_workspace where season_id=s.target_season_id;
 with page as materialized(select * from public.seasonal_draft_import_entries
   where batch_id=p_batch_id and (p_after_draft_id is null or draft_id>p_after_draft_id) order by draft_id limit p_page_size+1),
 visible as(select * from page order by draft_id limit p_page_size)
 select jsonb_build_object('entries',coalesce(jsonb_agg(to_jsonb(visible) order by draft_id),'[]'),
   'hasMore',(select count(*)>p_page_size from page),'nextDraftId',max(draft_id),
   'stale',w.epoch is distinct from s.draft_epoch or coalesce(w.revision,0)<>s.draft_revision or b.expires_at<=now()) into result from visible;
 return result;
end;
$$;
revoke all on function public.get_seasonal_draft_import_preview_v1(uuid,text,integer) from public,anon;
grant execute on function public.get_seasonal_draft_import_preview_v1(uuid,text,integer) to authenticated;

commit;
