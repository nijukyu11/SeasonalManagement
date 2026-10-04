-- M7: one operational action plan for preview and transactional Publish.
begin;
set local lock_timeout='15s';
set local statement_timeout='60s';
create index operational_seasonal_history_v1 on public.operational_flight_legs
  (source_season_id,source_draft_id,lineage_generation desc,created_at desc,leg_id) where source_type='published_seasonal';
create index operational_active_counterpart_v1 on public.operational_flight_legs(linked_leg_id)
  where status='active' and linked_leg_id is not null;
alter table public.seasonal_publish_diff_entries add column entry_index bigint generated always as identity;
create index seasonal_published_diff_page_v1 on public.seasonal_publish_diff_entries(version_id,entry_index);

create function public.seasonal_publish_operations_v1(p_season_id text)
returns table(operation text,draft_id text,leg_id uuid,seed_leg_id uuid,operational_date date,
  linked_draft_id text,preserved_link_id uuid,issue text)
language sql stable security definer set search_path=pg_catalog,public as $$
 with drafts as materialized (
   select d.draft_id,d.type,d.airline,d.flight_number,d.linked_draft_id,d.turnaround_id,d.link_type,d.pair_anchor_date,
     coalesce(nullif(d.operational_date,''),public.seasonal_operational_date_v2(
       coalesce(nullif(d.scheduled_date,''),d.date)::date,coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text)::date op_day
   from public.seasonal_flight_drafts d where d.season_id=p_season_id and d.status='active'
 ), eligible as materialized (
   select * from drafts d where d.op_day>(now() at time zone 'Asia/Ho_Chi_Minh')::date
     and not exists(select 1 from public.operational_day_authority a where a.operational_date=d.op_day and a.reset_at is null)
 ), owned as materialized (
   select * from public.operational_flight_legs where source_season_id=p_season_id and source_type='published_seasonal'
 ), seeds as (
   select distinct on(source_draft_id) * from owned
   order by source_draft_id,(status='active') desc,lineage_generation desc,created_at desc,leg_id
 ), families as (
   select source_draft_id,count(distinct lineage_id) lineage_count from owned group by source_draft_id
 ), duplicate_keys as materialized (
   select op_day,type,upper(btrim(airline)) airline,upper(btrim(flight_number)) flight_number from eligible
   group by op_day,type,upper(btrim(airline)),upper(btrim(flight_number)) having count(*)>1
 ), proposed(operation,draft_id,leg_id,seed_leg_id,op_day,intended_link,linked_draft_id,turnaround_id,link_type,pair_anchor_date,
     old_link,seed_day,seed_status,partner_link,partner_turnaround,partner_type,partner_anchor,lineage_count,side,partner_side,key_collision) as materialized (
   select 'upsert',d.draft_id,case when s.status='active' then s.leg_id end,s.leg_id,d.op_day,d.linked_draft_id,p.draft_id,
     d.turnaround_id,d.link_type,d.pair_anchor_date::date,s.linked_leg_id,s.operational_date,s.status,
     p.linked_draft_id,p.turnaround_id,p.link_type,p.pair_anchor_date::date,f.lineage_count,d.type,p.type,
     k.op_day is not null
   from eligible d left join seeds s on s.source_draft_id=d.draft_id left join families f on f.source_draft_id=d.draft_id
     left join eligible p on p.draft_id=d.linked_draft_id
     left join duplicate_keys k on k.op_day=d.op_day and k.type=d.type
       and k.airline=upper(btrim(d.airline)) and k.flight_number=upper(btrim(d.flight_number))
   union all
   select 'retire',o.source_draft_id,o.leg_id,o.leg_id,o.operational_date,null,null,null,null,null,
     o.linked_leg_id,o.operational_date,o.status,null,null,null,null,null,null,null,false
   from owned o where o.status='active' and o.operational_date>(now() at time zone 'Asia/Ho_Chi_Minh')::date
     and not exists(select 1 from public.operational_day_authority a where a.operational_date=o.operational_date and a.reset_at is null)
     and not exists(select 1 from eligible d where d.draft_id=o.source_draft_id)
 ), writable as materialized (
   select distinct leg_id from proposed where leg_id is not null
 ), incoming_protected as materialized (
   select peer.linked_leg_id,
     count(*) incoming_count,
     max(peer.leg_id::text)::uuid incoming_peer_id
   from writable w
   join public.operational_flight_legs peer on peer.linked_leg_id=w.leg_id and peer.status='active'
   left join writable w2 on w2.leg_id=peer.leg_id
   where w2.leg_id is null
   group by peer.linked_leg_id
 ), preserved as (
   select p.*,case when p.operation='upsert' and p.leg_id is not null and peer.status='active'
     and w_peer.leg_id is null
     and peer.source_season_id=p_season_id and peer.source_draft_id=p.intended_link and peer.linked_leg_id=p.leg_id
     and peer.turnaround_id=p.turnaround_id and old.turnaround_id=p.turnaround_id
     and peer.link_type=p.link_type and old.link_type=p.link_type
     and peer.pair_anchor_date=p.pair_anchor_date and old.pair_anchor_date=p.pair_anchor_date then peer.leg_id end preserved_link_id,
     peer.status peer_status,
     (w_peer.leg_id is not null) peer_in_writable
   from proposed p left join public.operational_flight_legs old on old.leg_id=p.leg_id
     left join public.operational_flight_legs peer on peer.leg_id=p.old_link
     left join writable w_peer on w_peer.leg_id=p.old_link
 )
 select p.operation,p.draft_id,p.leg_id,p.seed_leg_id,p.op_day,p.linked_draft_id,p.preserved_link_id,
   case
     when p.operation='upsert' and p.seed_status='active' and (p.seed_day<=(now() at time zone 'Asia/Ho_Chi_Minh')::date
       or exists(select 1 from public.operational_day_authority a where a.operational_date=p.seed_day and a.reset_at is null))
       then 'PROTECTED_OCCURRENCE_MOVE'
     when p.operation='upsert' and p.seed_status<>'active' and p.lineage_count>1 then 'AMBIGUOUS_OPERATIONAL_LINEAGE'
     when p.key_collision then 'OPERATIONAL_KEY_COLLISION'
     when p.linked_draft_id is not null and (p.partner_link is distinct from p.draft_id or p.side=p.partner_side
       or p.turnaround_id is null or p.partner_turnaround is distinct from p.turnaround_id
       or p.link_type is null or p.partner_type is distinct from p.link_type
       or p.pair_anchor_date is null or p.partner_anchor is distinct from p.pair_anchor_date) then 'INVALID_PLANNING_PAIR'
     when p.leg_id is not null and (
       (p.peer_status='active' and p.preserved_link_id is null and not p.peer_in_writable)
       or (inc.linked_leg_id is not null and (inc.incoming_count > 1 or inc.incoming_peer_id is distinct from p.preserved_link_id)))
       then 'PROTECTED_COUNTERPART'
   end
 from preserved p
   left join incoming_protected inc on inc.linked_leg_id=p.leg_id
$$;
revoke all on function public.seasonal_publish_operations_v1(text) from public,anon,authenticated;

-- Hash rows individually: don't allocate another whole-season JSON array.
-- Include retired lineage seeds, explicit masks and protected counterparts.
create or replace function public.seasonal_publish_scope_fingerprint_v1(p_season_id text) returns text
language sql stable security definer set search_path=pg_catalog,public as $$
 with owned as materialized (
   select * from public.operational_flight_legs where source_season_id=p_season_id and source_type='published_seasonal'
 ), generations as (
   select l.lineage_id,max(l.lineage_generation) generation from public.operational_flight_legs l
   join (select distinct lineage_id from owned) o using(lineage_id) group by l.lineage_id
 ), peers as (
   select l.leg_id from public.operational_flight_legs l join owned o on l.leg_id=o.linked_leg_id
   union select l.leg_id from public.operational_flight_legs l join owned o on l.linked_leg_id=o.leg_id where l.status='active'
 )
 select encode(sha256(convert_to(jsonb_build_array(
   (now() at time zone 'Asia/Ho_Chi_Minh')::date,
   (select jsonb_build_array(effective_start,effective_end,season_code) from public.seasons where id=p_season_id),
   (select string_agg(encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),'' order by a.operational_date)
     from public.operational_day_authority a join public.seasonal_publish_bounds_v1(p_season_id) b on a.operational_date between b.start_date and b.end_date),
   (select string_agg(encode(sha256(convert_to(jsonb_build_array(to_jsonb(o),r.fields,g.generation)::text,'UTF8')),'hex'),'' order by o.leg_id)
     from owned o left join public.operational_resource_overrides r on r.leg_id=o.leg_id left join generations g using(lineage_id)),
   (select string_agg(encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex'),'' order by l.leg_id)
     from public.operational_flight_legs l join peers p using(leg_id))
 )::text,'UTF8')),'hex')
$$;

create or replace function public.preview_seasonal_publish_v1(p_season_id text,p_request_id uuid,p_published_on date default (now() at time zone 'Asia/Ho_Chi_Minh')::date) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='30s' as $$
declare
 v_actor uuid:=auth.uid(); v_season public.seasons%rowtype; v_workspace public.seasonal_draft_workspace%rowtype;
 v_existing public.seasonal_publish_previews%rowtype; v_id uuid:=gen_random_uuid(); v_base uuid;
 v_before jsonb; v_snapshot jsonb; v_checksum text; v_scope text;
 v_today date:=(now() at time zone 'Asia/Ho_Chi_Minh')::date; v_tag text; v_sequence integer; v_start date; v_end date;
begin
 if v_actor is null or public.app_operator_has_permission('seasonal.write') is not true then
   raise exception 'seasonal.write permission is required' using errcode='42501'; end if;
 if p_request_id is null or p_published_on is null or not isfinite(p_published_on) then raise exception 'Request ID and finite publish date required' using errcode='22023'; end if;
 perform 1 from public.operational_workspace_revision where singleton for share;
 select * into v_season from public.seasons where id=p_season_id for share;
 if not found then raise exception 'Season not found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended('publish-preview:'||v_actor::text||':'||p_request_id::text,0));
 select * into v_existing from public.seasonal_publish_previews where actor_id=v_actor and request_id=p_request_id;
 if found then
   if v_existing.season_id<>p_season_id or v_existing.published_on<>p_published_on then raise exception 'Request ID reused' using errcode='22023'; end if;
   return jsonb_build_object('previewId',v_existing.preview_id,'previewHash',v_existing.preview_hash,'status',v_existing.status,
     'preview',v_existing.preview,'expiresAt',v_existing.expires_at);
 end if;
 select * into strict v_workspace from public.seasonal_draft_workspace where season_id=p_season_id for share;
 select version_id into v_base from public.seasonal_publish_versions where season_id=p_season_id order by publish_sequence desc limit 1;
 select snapshot_payload into v_before from public.seasonal_publish_snapshots where version_id=v_base;
 v_snapshot:=public.seasonal_planning_snapshot_v1(p_season_id);
 v_checksum:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
 v_scope:=public.seasonal_publish_scope_fingerprint_v1(p_season_id);
 select start_date,end_date into v_start,v_end from public.seasonal_publish_bounds_v1(p_season_id);
 if v_start is null or v_end is null or not isfinite(v_start) or not isfinite(v_end) or v_start>v_end then
   raise exception 'Finite planning range is required' using errcode='22023'; end if;
 select coalesce(max(sequence_in_day),0)+1 into v_sequence from public.seasonal_publish_versions
   where season_id=p_season_id and split_part(version_tag,'.',1)=public.seasonal_publish_version_tag(v_season.season_code,p_published_on,1);
 v_tag:=public.seasonal_publish_version_tag(v_season.season_code,p_published_on,v_sequence);
 with diff as materialized (
   select * from public.seasonal_planning_diff_v1(v_before,v_snapshot)
 ), operations as materialized (
   select * from public.seasonal_publish_operations_v1(p_season_id)
 ), built as (
 select jsonb_build_object('publishContractVersion',2,'baseVersionId',v_base,'draftRevision',v_workspace.revision::text,'draftEpoch',v_workspace.epoch,
   'draftChecksum',v_checksum,'scopeFingerprint',v_scope,'businessToday',v_today,'proposedTag',v_tag,
   'publishedOn',p_published_on,'sequenceInDay',v_sequence,'rangeStart',v_start,'rangeEnd',v_end,'planningCounts',
     (select jsonb_build_object('added',count(*) filter(where d.change_type='added'),'modified',count(*) filter(where d.change_type='modified'),
       'removed',count(*) filter(where d.change_type='removed'),'unchanged',count(*) filter(where d.change_type='unchanged'),
       'ambiguous',count(*) filter(where d.change_type='ambiguous')) from diff d),
   'diagnostics',coalesce((select jsonb_agg(jsonb_build_object('code','AMBIGUOUS_PLANNING_IDENTITY','flightKey',key)) from
     (select distinct d.flight_key key from diff d where d.change_type='ambiguous') x),'[]'::jsonb)
     ||coalesce((select jsonb_agg(jsonb_build_object('code',o.issue,'draftId',o.draft_id,'legId',o.leg_id,'operationalDate',o.operational_date))
       from (select * from operations where issue is not null order by operational_date,draft_id limit 1999) o),'[]'::jsonb),
   'operationalDiagnosticCount',(select count(*) from operations where issue is not null),
   'skippedDays',coalesce((select jsonb_agg(a.operational_date order by a.operational_date) from public.operational_day_authority a
     where a.operational_date between v_start and v_end and a.reset_at is null),'[]'::jsonb),
   'publishableDays',coalesce((select jsonb_agg(day::date order by day) from generate_series(
     greatest(v_start,v_today+1)::timestamp,v_end::timestamp,interval '1 day') day
     where not exists(select 1 from public.operational_day_authority a where a.operational_date=day::date and a.reset_at is null)),'[]'::jsonb),
   'operationalCounts',jsonb_build_object('write',(select count(*) from operations where operation='upsert'),
     'retire',(select count(*) from operations where operation='retire'))
 ) body
 ), saved as (
   insert into public.seasonal_publish_previews(preview_id,actor_id,request_id,season_id,published_on,base_version_id,
     draft_epoch,draft_revision,draft_checksum,scope_fingerprint,planning_snapshot,preview,preview_hash,status)
   select v_id,v_actor,p_request_id,p_season_id,p_published_on,v_base,v_workspace.epoch,v_workspace.revision,v_checksum,v_scope,
     v_snapshot,b.body,encode(sha256(convert_to(b.body::text,'UTF8')),'hex'),
     case when exists(select 1 from diff where change_type='ambiguous') or exists(select 1 from operations where issue is not null)
       then 'blocked' else 'ready' end from built b returning *
 ), details as (
   insert into public.seasonal_publish_preview_entries
   select s.preview_id,row_number() over(order by d.operational_date,d.flight_key,d.source_draft_id),d.change_type,d.flight_key,
     d.source_draft_id,d.operational_date,d.side,d.airline,d.flight_number,d.before_state,d.after_state,d.changed_fields
     from diff d cross join saved s where d.change_type in('added','modified','removed') returning entry_index
 )
 select * into v_existing from saved;
 return jsonb_build_object('previewId',v_existing.preview_id,'previewHash',v_existing.preview_hash,
   'status',v_existing.status,'preview',v_existing.preview,'expiresAt',v_existing.expires_at);
end;
$$;

create function public.commit_seasonal_publish_v1(p_season_id text,p_preview_id uuid,p_preview_hash text,p_notes text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='45s' as $$
declare
 p public.seasonal_publish_previews%rowtype; w public.seasonal_draft_workspace%rowtype;
 v_actor uuid:=auth.uid(); v_base uuid; v_version uuid; v_day date; v_result jsonb; v_revision bigint;
begin
 if v_actor is null or public.app_operator_has_permission('seasonal.write') is not true then
   raise exception 'seasonal.write permission required' using errcode='42501'; end if;
 select * into p from public.seasonal_publish_previews where preview_id=p_preview_id and actor_id=v_actor and season_id=p_season_id;
 if not found then raise exception 'Publish preview unavailable' using errcode='42501'; end if;
 perform 1 from public.operational_workspace_revision where singleton for update;
 perform 1 from public.seasons where id=p_season_id for update;
 select * into strict w from public.seasonal_draft_workspace where season_id=p_season_id for share;
 select * into strict p from public.seasonal_publish_previews where preview_id=p_preview_id for update;
 if p.preview_hash is distinct from p_preview_hash then raise exception 'Publish hash changed' using errcode='40001'; end if;
 if p.status='committed' then
   if (select publish_notes from public.seasonal_publish_versions where version_id=(p.result->>'versionId')::uuid)
       is distinct from coalesce(p_notes,'') then raise exception 'Publish notes differ from receipt' using errcode='22023'; end if;
   return p.result;
 end if;
 select version_id into v_base from public.seasonal_publish_versions where season_id=p_season_id order by publish_sequence desc limit 1;
 if p.status<>'ready' or p.expires_at<=now() or p.preview->>'publishContractVersion' is distinct from '2'
   or v_base is distinct from p.base_version_id or w.epoch<>p.draft_epoch or w.revision<>p.draft_revision
   or encode(sha256(convert_to(public.seasonal_planning_snapshot_v1(p_season_id)::text,'UTF8')),'hex')<>p.draft_checksum
   or public.seasonal_publish_scope_fingerprint_v1(p_season_id)<>p.scope_fingerprint then
   raise exception 'Publish preview is stale or blocked; review again' using errcode='40001'; end if;
 drop table if exists pg_temp.publish_plan;
 create temporary table publish_plan on commit drop as select * from public.seasonal_publish_operations_v1(p_season_id);
 if exists(select 1 from pg_temp.publish_plan where issue is not null) then raise exception 'Publish operations changed' using errcode='40001'; end if;
 for v_day in
   select op_day from (
     select operational_date as op_day from pg_temp.publish_plan
     union select l.operational_date from public.operational_flight_legs l join pg_temp.publish_plan x on x.leg_id=l.leg_id
   ) dates order by op_day
 loop perform pg_advisory_xact_lock(hashtextextended('operational-day:'||v_day::text,0)); end loop;
 perform 1 from public.operational_flight_legs l join pg_temp.publish_plan x on x.leg_id=l.leg_id order by l.leg_id for update of l;
 insert into public.seasonal_publish_versions(season_id,season_code,version_tag,sequence_in_day,published_by,publish_notes,
   range_start,range_end,total_flight_count,added_count,modified_count,removed_count,unchanged_count,skipped_day_count,diff_summary,snapshot_checksum)
 values(p_season_id,p.planning_snapshot->>'seasonCode',p.preview->>'proposedTag',(p.preview->>'sequenceInDay')::integer,v_actor,coalesce(p_notes,''),
   (p.preview->>'rangeStart')::date,(p.preview->>'rangeEnd')::date,(p.planning_snapshot#>>'{counts,active}')::integer,
   (p.preview#>>'{planningCounts,added}')::integer,(p.preview#>>'{planningCounts,modified}')::integer,
   (p.preview#>>'{planningCounts,removed}')::integer,(p.preview#>>'{planningCounts,unchanged}')::integer,
   jsonb_array_length(p.preview->'skippedDays'),p.preview,p.draft_checksum) returning version_id into v_version;
 insert into public.seasonal_publish_snapshots(version_id,season_id,snapshot_payload,flight_count,checksum)
 values(v_version,p_season_id,p.planning_snapshot,(p.planning_snapshot#>>'{counts,active}')::integer,p.draft_checksum);
 insert into public.seasonal_publish_diff_entries(version_id,base_version_id,season_id,change_type,flight_key,source_draft_id,
   operational_date,side,airline,flight_number,before_state,after_state,changed_fields)
 select v_version,p.base_version_id,p_season_id,change_type,flight_key,source_draft_id,operational_date,side,airline,flight_number,before_state,after_state,changed_fields
 from public.seasonal_publish_preview_entries where preview_id=p_preview_id order by entry_index;

 drop table if exists pg_temp.publish_before;
 create temporary table publish_before on commit drop as
 select l.leg_id,to_jsonb(l)||jsonb_build_object(
   'counters',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_group,item_index) from public.operational_leg_counters c where c.leg_id=l.leg_id),'[]'),
   'checkin_windows',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_key) from public.operational_leg_checkin_windows c where c.leg_id=l.leg_id),'[]')) before_state
 from public.operational_flight_legs l join pg_temp.publish_plan x on x.leg_id=l.leg_id;
 drop table if exists pg_temp.publish_targets;
 create temporary table publish_targets on commit drop as
 with allocated as (
   select x.*,coalesce(x.leg_id,gen_random_uuid()) target_id from pg_temp.publish_plan x where operation='upsert'
 ), effective as (
   select a.*,jsonb_populate_record(d,coalesce(o.fields,'{}')) d,coalesce(o.fields,'{}') overrides,
     coalesce(seed.lineage_id,a.target_id) lineage_id,
     case when a.leg_id is not null then seed.lineage_generation else
       coalesce((select max(lineage_generation) from public.operational_flight_legs where lineage_id=seed.lineage_id),-1)+1 end generation
   from allocated a join public.seasonal_flight_drafts d on d.draft_id=a.draft_id
   left join public.operational_flight_legs seed on seed.leg_id=a.seed_leg_id
   left join public.operational_resource_overrides o on o.leg_id=a.seed_leg_id
 ), resources as (
   select e.*,case when overrides ? 'counter_token' and not overrides ? 'counters' then
     coalesce((select jsonb_agg(jsonb_build_object('counter_group','__single__','item_index',ordinality-1,'counter_value',btrim(value)) order by ordinality)
       from unnest(string_to_array(overrides->>'counter_token',',')) with ordinality t(value,ordinality) where btrim(value)<>''),'[]')
     else (d).counters end counters
   from effective e
 )
 select r.*,to_jsonb(d)||jsonb_build_object('leg_id',target_id,'lineage_id',lineage_id,'lineage_generation',generation,
   'leg_key',(d).type||chr(31)||r.operational_date::text||chr(31)||upper(btrim((d).airline))||chr(31)||upper(btrim((d).flight_number)),
   'operational_date',r.operational_date,'scheduled_date',coalesce(nullif((d).scheduled_date,''),(d).date),
   'scheduled_time',(d).schedule,'side',case (d).type when 'A' then 'ARR' else 'DEP' end,
   'aircraft_type',coalesce(nullif((d).aircraft,''),'Unknown'),'flight_category',coalesce(nullif((d).category,''),'C'),
   'counter_token',(select string_agg(c->>'counter_value',',' order by c->>'counter_group',(c->>'item_index')::integer) from jsonb_array_elements(r.counters) c),
   'source_type','published_seasonal','source_season_id',p_season_id,'source_draft_id',r.draft_id,'source_batch_id',null,
   'source_occurrence_key',r.draft_id,'source_row_number',(d).source_row_index,'published_version_id',v_version,
   'linked_leg_id',null,'turnaround_id',null,'link_type',null,'pair_anchor_date',null,'status','active','deletion_reason',null,
   'created_at',now(),'created_by',v_actor,'updated_at',now(),'updated_by',v_actor) data
 from resources r;
 insert into public.operational_flight_legs(leg_id,lineage_id,lineage_generation,leg_key,operational_date,scheduled_date,scheduled_time,
   side,airline,flight_number,raw_flight_number,route,aircraft_type,flight_category,pax,code_shares,int_dom_ind,stand,gate,carousel,
   counter_token,mct,fb,lb,bhs,ghs,check_in_start,check_in_end,check_in_allocation_mode,source_type,source_season_id,source_draft_id,
   source_occurrence_key,source_row_number,published_version_id,created_by,updated_by)
 select r.leg_id,r.lineage_id,r.lineage_generation,r.leg_key,r.operational_date,r.scheduled_date,r.scheduled_time,
   r.side,r.airline,r.flight_number,r.raw_flight_number,r.route,r.aircraft_type,r.flight_category,r.pax,r.code_shares,r.int_dom_ind,
   r.stand,r.gate,r.carousel,r.counter_token,r.mct,r.fb,r.lb,r.bhs,r.ghs,r.check_in_start,r.check_in_end,r.check_in_allocation_mode,
   r.source_type,r.source_season_id,r.source_draft_id,r.source_occurrence_key,r.source_row_number,r.published_version_id,v_actor,v_actor
 from pg_temp.publish_targets t cross join lateral jsonb_populate_record(null::public.operational_flight_legs,t.data) r where t.leg_id is null;
 update public.operational_flight_legs l set
   (leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,raw_flight_number,route,aircraft_type,flight_category,
    pax,code_shares,int_dom_ind,stand,gate,carousel,counter_token,mct,fb,lb,bhs,ghs,check_in_start,check_in_end,check_in_allocation_mode,
    published_version_id,source_occurrence_key,source_row_number,updated_at,updated_by)=
   (r.leg_key,r.operational_date,r.scheduled_date,r.scheduled_time,r.side,r.airline,r.flight_number,r.raw_flight_number,r.route,r.aircraft_type,r.flight_category,
    r.pax,r.code_shares,r.int_dom_ind,r.stand,r.gate,r.carousel,r.counter_token,r.mct,r.fb,r.lb,r.bhs,r.ghs,r.check_in_start,r.check_in_end,r.check_in_allocation_mode,
    v_version,r.source_occurrence_key,r.source_row_number,now(),v_actor)
 from pg_temp.publish_targets t cross join lateral jsonb_populate_record(null::public.operational_flight_legs,t.data) r
 where l.leg_id=t.leg_id and l.source_season_id=p_season_id and l.source_type='published_seasonal' and l.status='active';
 update public.operational_flight_legs l set status='deleted',deletion_reason='seasonal_publish_removed',
   linked_leg_id=null,turnaround_id=null,link_type=null,pair_anchor_date=null,updated_at=now(),updated_by=v_actor
 from pg_temp.publish_plan x where x.operation='retire' and l.leg_id=x.leg_id and l.source_season_id=p_season_id and l.source_type='published_seasonal';
 update public.operational_flight_legs l set linked_leg_id=coalesce(partner.target_id,t.preserved_link_id),
   turnaround_id=case when coalesce(partner.target_id,t.preserved_link_id) is not null then (t.d).turnaround_id end,
   link_type=case when coalesce(partner.target_id,t.preserved_link_id) is not null then (t.d).link_type end,
   pair_anchor_date=case when coalesce(partner.target_id,t.preserved_link_id) is not null then (t.d).pair_anchor_date::date end
 from pg_temp.publish_targets t left join pg_temp.publish_targets partner on partner.draft_id=t.linked_draft_id where l.leg_id=t.target_id;
 delete from public.operational_leg_counters c using pg_temp.publish_targets t where c.leg_id=t.target_id;
 insert into public.operational_leg_counters select t.target_id,c.counter_group,c.item_index,c.counter_value
 from pg_temp.publish_targets t cross join lateral jsonb_to_recordset(t.counters) c(counter_group text,item_index integer,counter_value text);
 delete from public.operational_leg_checkin_windows c using pg_temp.publish_targets t where c.leg_id=t.target_id;
 insert into public.operational_leg_checkin_windows select t.target_id,c.counter_key,c.window_start,c.window_end
 from pg_temp.publish_targets t cross join lateral jsonb_to_recordset((t.d).checkin_windows) c(counter_key text,window_start text,window_end text);
 insert into public.operational_resource_overrides select target_id,overrides from pg_temp.publish_targets where leg_id is null and overrides<>'{}';
 insert into public.operational_change_events(actor_id,request_id,target_type,target_id,operational_date,changed_fields,before_state,after_state)
 select v_actor,p.request_id,'operationalPublishLeg',l.leg_id::text,l.operational_date,array['publish'],
   coalesce(b.before_state,'null'::jsonb),to_jsonb(l)||jsonb_build_object(
     'counters',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_group,item_index) from public.operational_leg_counters c where c.leg_id=l.leg_id),'[]'),
     'checkin_windows',coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_key) from public.operational_leg_checkin_windows c where c.leg_id=l.leg_id),'[]'))
 from public.operational_flight_legs l left join pg_temp.publish_before b using(leg_id)
 where l.leg_id in(select target_id from pg_temp.publish_targets union select leg_id from pg_temp.publish_plan where operation='retire')
 order by l.leg_id;
 select revision into v_revision from public.operational_workspace_revision where singleton;
 v_result:=jsonb_build_object('status','committed','previewId',p_preview_id,'versionId',v_version,'versionTag',p.preview->>'proposedTag',
   'planningCounts',p.preview->'planningCounts','operationalCounts',p.preview->'operationalCounts','skippedDays',p.preview->'skippedDays',
   'operationalRevision',v_revision::text);
 insert into public.operational_change_events(actor_id,request_id,target_type,target_id,operational_date,changed_fields,before_state,after_state)
 values(v_actor,p.request_id,'seasonalPublish','publish:'||v_version::text,(now() at time zone 'Asia/Ho_Chi_Minh')::date,
   array['publish'],jsonb_build_object('baseVersionId',p.base_version_id),v_result);
 update public.seasonal_publish_previews set status='committed',result=v_result where preview_id=p_preview_id;
 perform pg_notify('operational_projection_wake',v_version::text);
 return v_result;
end;
$$;
revoke all on function public.commit_seasonal_publish_v1(text,uuid,text,text) from public,anon;
grant execute on function public.commit_seasonal_publish_v1(text,uuid,text,text) to authenticated;

create function public.get_seasonal_publish_versions_v1(p_season_id text,p_after_sequence bigint default null,p_page_size integer default 50) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then raise exception 'seasonal.read permission required' using errcode='42501'; end if;
 if p_page_size is null or p_page_size not between 1 and 200 or p_after_sequence<1 then raise exception 'Invalid version page' using errcode='22023'; end if;
 with candidates as materialized(select * from public.seasonal_publish_versions where season_id=p_season_id
   and (p_after_sequence is null or publish_sequence<p_after_sequence) order by publish_sequence desc limit p_page_size+1),
 page as(select * from candidates order by publish_sequence desc limit p_page_size)
 select jsonb_build_object('versions',coalesce(jsonb_agg((to_jsonb(page)-'diff_summary')||jsonb_build_object('publish_sequence',publish_sequence::text) order by publish_sequence desc),'[]'),
   'hasMore',(select count(*)>p_page_size from candidates),'nextSequence',min(publish_sequence)::text) into result from page;
 return result;
end;
$$;
create function public.get_seasonal_published_diff_page_v1(p_version_id uuid,p_after_index bigint default 0,p_page_size integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then raise exception 'seasonal.read permission required' using errcode='42501'; end if;
 if p_page_size is null or p_page_size not between 1 and 500 or p_after_index is null or p_after_index<0 then raise exception 'Invalid diff page' using errcode='22023'; end if;
 if not exists(select 1 from public.seasonal_publish_versions where version_id=p_version_id) then raise exception 'Version not found' using errcode='P0002'; end if;
 with candidates as materialized(select * from public.seasonal_publish_diff_entries where version_id=p_version_id and entry_index>p_after_index
   order by entry_index limit p_page_size+1), page as(select * from candidates order by entry_index limit p_page_size)
 select jsonb_build_object('entries',coalesce(jsonb_agg(to_jsonb(page)||jsonb_build_object('entry_index',entry_index::text) order by entry_index),'[]'),
   'hasMore',(select count(*)>p_page_size from candidates),'nextIndex',max(entry_index)::text) into result from page;
 return result;
end;
$$;
revoke all on function public.get_seasonal_publish_versions_v1(text,bigint,integer),public.get_seasonal_published_diff_page_v1(uuid,bigint,integer) from public,anon;
grant execute on function public.get_seasonal_publish_versions_v1(text,bigint,integer),public.get_seasonal_published_diff_page_v1(uuid,bigint,integer) to authenticated;
commit;
