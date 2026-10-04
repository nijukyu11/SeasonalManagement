-- M6: persistent planning edits and immutable, source-bound publish previews.
begin;
do $$ begin
  if exists(select 1 from public.seasonal_publish_snapshots s cross join lateral jsonb_array_elements(s.snapshot_payload->'flights') f
    where not(f ? 'linkedDraftId')) then
    raise exception 'Planning baseline lacks pairing fields; rebuild the isolated shadow baseline before M6. Existing snapshots are not rewritten.' using errcode='55000';
  end if;
end $$;
alter table public.seasonal_flight_drafts add column counters jsonb not null default '[]' check(jsonb_typeof(counters)='array');
alter table public.seasonal_flight_drafts add column checkin_windows jsonb not null default '[]' check(jsonb_typeof(checkin_windows)='array');
alter table public.seasonal_flight_drafts add column check_in_start text;
alter table public.seasonal_flight_drafts add column check_in_end text;
alter table public.seasonal_flight_drafts add column check_in_allocation_mode text check(check_in_allocation_mode in('grouped','broken'));
create table public.seasonal_draft_workspace (
  season_id text primary key references public.seasons on delete cascade,
  epoch uuid not null default gen_random_uuid(),
  revision bigint not null default 0 check(revision>=0)
);
insert into public.seasonal_draft_workspace(season_id) select id from public.seasons;
create table public.seasonal_draft_mutation_receipts (
  actor_id uuid not null references auth.users on delete restrict,
  request_id uuid not null,
  season_id text not null references public.seasons on delete restrict,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id,request_id)
);
alter table public.seasonal_publish_versions add column publish_sequence bigint generated always as identity;
create index seasonal_publish_versions_sequence_idx on public.seasonal_publish_versions(season_id,publish_sequence desc);
create sequence public.seasonal_draft_event_seq;
select setval('public.seasonal_draft_event_seq',greatest(coalesce((select max(server_seq) from public.seasonal_draft_events),0),1),exists(select 1 from public.seasonal_draft_events));
revoke all on public.seasonal_draft_workspace,public.seasonal_draft_mutation_receipts,public.seasonal_draft_event_seq from public,anon,authenticated;
create function public.bump_seasonal_draft_workspace_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_table_name='seasons' then
    insert into public.seasonal_draft_workspace(season_id,revision) select id,1 from new_seasons
      on conflict(season_id) do update set revision=public.seasonal_draft_workspace.revision+1;
  elsif tg_op='DELETE' then
    insert into public.seasonal_draft_workspace(season_id,revision)
      select distinct d.season_id,1 from old_drafts d join public.seasons s on s.id=d.season_id
      on conflict(season_id) do update set revision=public.seasonal_draft_workspace.revision+1;
  else
    insert into public.seasonal_draft_workspace(season_id,revision) select distinct season_id,1 from new_drafts
      on conflict(season_id) do update set revision=public.seasonal_draft_workspace.revision+1;
  end if;
  return null;
end;
$$;
revoke all on function public.bump_seasonal_draft_workspace_v1() from public,anon,authenticated;
create trigger seasonal_draft_workspace_insert after insert on public.seasonal_flight_drafts referencing new table as new_drafts for each statement execute function public.bump_seasonal_draft_workspace_v1();
create trigger seasonal_draft_workspace_update after update on public.seasonal_flight_drafts referencing new table as new_drafts for each statement execute function public.bump_seasonal_draft_workspace_v1();
create trigger seasonal_draft_workspace_delete after delete on public.seasonal_flight_drafts referencing old table as old_drafts for each statement execute function public.bump_seasonal_draft_workspace_v1();
create trigger seasonal_draft_workspace_season_insert after insert on public.seasons referencing new table as new_seasons for each statement execute function public.bump_seasonal_draft_workspace_v1();
create trigger seasonal_draft_workspace_season_update after update on public.seasons referencing new table as new_seasons for each statement execute function public.bump_seasonal_draft_workspace_v1();

create function public.seasonal_draft_planning_state_v1(d public.seasonal_flight_drafts) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_build_object(
   'draftId',d.draft_id,'type',d.type,'airline',d.airline,'flightNumber',d.flight_number,'rawFlightNumber',d.raw_flight_number,
   'requestStatusCode',d.request_status_code,'route',d.route,'schedule',d.schedule,'aircraft',d.aircraft,'category',d.category,
   'codeShares',d.code_shares,'intDomInd',d.int_dom_ind,'pax',d.pax,'gate',d.gate,'stand',d.stand,'carousel',d.carousel,
   'mct',d.mct,'fb',d.fb,'lb',d.lb,'bhs',d.bhs,'ghs',d.ghs,'date',d.date,'scheduledDate',d.scheduled_date,
   'scheduledTime',d.scheduled_time,'operationalDate',d.operational_date,'iataSeasonCode',d.iata_season_code,
   'flightSeriesId',d.flight_series_id,'dayOfWeek',d.day_of_week,'sourceRowIndex',d.source_row_index,
   'linkedSourceRowIndex',d.linked_source_row_index,'linkType',d.link_type,'pairAnchorDate',d.pair_anchor_date,
   'linkedDraftId',d.linked_draft_id,'turnaroundId',d.turnaround_id,'sourceKind',d.source_kind,'sourceSide',d.source_side,
   'status',d.status,'action',d.action,'sourceImportBatchId',d.source_import_batch_id,
   'sourceImportStagingRowIndex',d.source_import_staging_row_index,'sourceFileHash',d.source_file_hash,
   'supersedesDraftId',d.supersedes_draft_id,'counters',d.counters,'checkinWindows',d.checkin_windows,
   'checkInStart',d.check_in_start,'checkInEnd',d.check_in_end,'checkInAllocationMode',d.check_in_allocation_mode
 )
$$;
revoke all on function public.seasonal_draft_planning_state_v1(public.seasonal_flight_drafts) from public,anon,authenticated;
create function public.seasonal_planning_snapshot_v1(p_season_id text) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('seasonId',s.id,'seasonCode',s.season_code,'scope','planning',
   'rangeStart',s.effective_start,'rangeEnd',s.effective_end,
   'counts',jsonb_build_object('total',count(d.draft_id),'active',count(d.draft_id) filter(where d.status='active'),
     'deleted',count(d.draft_id) filter(where d.status='deleted')),
   'flights',coalesce(jsonb_agg(public.seasonal_draft_planning_state_v1(d) order by d.draft_id) filter(where d.draft_id is not null),'[]'::jsonb))
 from public.seasons s left join public.seasonal_flight_drafts d on d.season_id=s.id
 where s.id=p_season_id group by s.id
$$;
revoke all on function public.seasonal_planning_snapshot_v1(text) from public,anon,authenticated;

create function public.apply_seasonal_draft_changes_v1(p_season_id text,p_request_id uuid,p_expected_revision bigint,p_changes jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='15s' as $$
declare
  v_actor uuid:=auth.uid(); v_revision bigint; v_change jsonb; v_patch jsonb; v_field text; v_id text;
  v_old public.seasonal_flight_drafts%rowtype; v_new public.seasonal_flight_drafts%rowtype;
  v_receipt public.seasonal_draft_mutation_receipts%rowtype;
  v_request jsonb:=jsonb_build_object('seasonId',p_season_id,'revision',p_expected_revision::text,'changes',p_changes);
  v_before jsonb; v_after jsonb; v_events jsonb; v_result jsonb; v_seq bigint; v_start_seq bigint; v_new_row boolean;
  v_ids text[]; v_pair_ids text[]:='{}'; v_time time; v_date date; v_invalid boolean;
  v_allowed text[]:=array['type','airline','flight_number','raw_flight_number','request_status_code','route','schedule','aircraft','category',
    'code_shares','int_dom_ind','pax','gate','stand','carousel','mct','fb','lb','bhs','ghs','date','scheduled_date','scheduled_time',
    'flight_series_id','day_of_week','linked_draft_id','turnaround_id','link_type','pair_anchor_date',
    'status','deletion_reason','counters','checkin_windows','check_in_start','check_in_end','check_in_allocation_mode'];
begin
  if v_actor is null or (public.app_operator_has_permission('seasonal.write') or public.app_operator_has_permission('detailed.write')) is not true then
    raise exception 'Planning write permission is required' using errcode='42501';
  end if;
  if p_request_id is null or p_expected_revision is null or jsonb_typeof(p_changes) is distinct from 'array'
    or jsonb_array_length(p_changes) not between 1 and 10000 then raise exception 'Request, revision and 1-10000 changes are required' using errcode='22023'; end if;
  perform 1 from public.seasons where id=p_season_id for update;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  insert into public.seasonal_draft_workspace(season_id) values(p_season_id) on conflict do nothing;
  select revision into strict v_revision from public.seasonal_draft_workspace where season_id=p_season_id for update;
  select * into v_receipt from public.seasonal_draft_mutation_receipts where actor_id=v_actor and request_id=p_request_id;
  if found then
    if v_receipt.request_payload is distinct from v_request then raise exception 'Request ID reused with different payload' using errcode='22023'; end if;
    return v_receipt.result;
  end if;
  if v_revision<>p_expected_revision then raise exception 'Draft revision changed' using errcode='40001'; end if;
  select array_agg(x->>'draftId') into v_ids from jsonb_array_elements(p_changes) x;
  if exists(select 1 from unnest(v_ids) id group by id having count(*)>1) or array_position(v_ids,null) is not null
    or exists(select 1 from unnest(v_ids) id where btrim(id)='') then raise exception 'Draft IDs must be present and distinct' using errcode='22023'; end if;
  select coalesce(max(server_seq),0) into v_start_seq from public.seasonal_draft_events where season_id=p_season_id;
  for v_change in select x from jsonb_array_elements(p_changes) x order by x->>'draftId' loop
    v_id:=v_change->>'draftId'; v_patch:=v_change->'patch';
    if jsonb_typeof(v_patch) is distinct from 'object' or v_patch='{}' then raise exception 'Nonempty patch required' using errcode='22023'; end if;
    select * into v_old from public.seasonal_flight_drafts where draft_id=v_id for update;
    v_new_row:=not found;
    if not v_new_row and v_old.season_id<>p_season_id then raise exception 'Draft belongs to another season' using errcode='42501'; end if;
    if v_new_row then
      if v_change->'expected' is distinct from 'null'::jsonb then raise exception 'New draft requires null preimage' using errcode='40001'; end if;
      insert into public.seasonal_flight_drafts(draft_id,season_id,type,source_kind,source_side,action,updated_by)
        values(v_id,p_season_id,coalesce(v_patch->>'type','A'),'manual',case v_patch->>'type' when 'D' then 'DEP' else 'ARR' end,'added',v_actor)
        returning * into v_old;
      v_before:=null;
    else
      if jsonb_typeof(v_change->'expected') is distinct from 'object' then raise exception 'Field preimage required' using errcode='22023'; end if;
      v_before:=to_jsonb(v_old);
    end if;
    for v_field in select jsonb_object_keys(v_patch) loop
      if not(v_field=any(v_allowed)) then raise exception 'Unsupported draft field: %',v_field using errcode='22023'; end if;
      if not v_new_row and (not(v_change->'expected' ? v_field) or v_change->'expected'->v_field is distinct from v_before->v_field) then
        raise exception 'Draft field preimage changed: %',v_field using errcode='40001';
      end if;
    end loop;
    v_new:=jsonb_populate_record(v_old,v_patch);
    if v_new_row or v_patch ?| array['date','scheduled_date','schedule','scheduled_time'] then
      v_date:=coalesce(nullif(case when v_patch ? 'scheduled_date' then v_new.scheduled_date when v_patch ? 'date' then v_new.date else v_new.scheduled_date end,''),nullif(v_new.date,''))::date;
      v_time:=coalesce(nullif(case when v_patch ? 'schedule' then v_new.schedule when v_patch ? 'scheduled_time' then v_new.scheduled_time else v_new.schedule end,''),nullif(v_new.scheduled_time,''))::time;
      if v_date is null or not isfinite(v_date) or v_time is null then raise exception 'Scheduled date and time required' using errcode='22023'; end if;
      if v_patch ?& array['schedule','scheduled_time'] and v_new.schedule is distinct from v_new.scheduled_time then
        raise exception 'Conflicting scheduled times' using errcode='22023'; end if;
      if v_patch ?& array['date','scheduled_date'] and v_new.date is distinct from v_new.scheduled_date then
        raise exception 'Conflicting scheduled dates' using errcode='22023'; end if;
      v_new.date:=v_date::text; v_new.scheduled_date:=v_date::text;
      v_new.schedule:=to_char(v_time,'HH24:MI'); v_new.scheduled_time:=v_new.schedule;
      v_new.operational_date:=public.seasonal_operational_date_v2(v_date,v_time)::text;
      v_new.day_of_week:=extract(isodow from v_date)::integer;
    end if;
    v_new.airline:=upper(btrim(v_new.airline)); v_new.flight_number:=upper(btrim(v_new.flight_number));
    if v_new.airline='' or v_new.flight_number='' or btrim(v_new.route)='' then raise exception 'Flight identity and route required' using errcode='22023'; end if;
    if v_new.gate<=0 or v_new.carousel<=0 then raise exception 'Gate/carousel must be positive' using errcode='22023'; end if;
    if jsonb_typeof(v_new.counters) is distinct from 'array' or jsonb_typeof(v_new.checkin_windows) is distinct from 'array' then
      raise exception 'Allocation children must be arrays' using errcode='22023'; end if;
    if v_patch ? 'counters' then
      select coalesce(jsonb_agg(to_jsonb(c) order by counter_group,item_index),'[]'::jsonb),
        coalesce(bool_or(counter_group is null or item_index is null or item_index<0 or counter_value is null),false)
          or count(*)<>count(distinct(counter_group,item_index))
        into v_new.counters,v_invalid
        from jsonb_to_recordset(v_new.counters) c(counter_group text,item_index integer,counter_value text);
      if v_invalid then raise exception 'Invalid counters' using errcode='22023'; end if;
    end if;
    if v_patch ? 'checkin_windows' then
      select coalesce(jsonb_agg(to_jsonb(w) order by counter_key),'[]'::jsonb),
        coalesce(bool_or(counter_key is null or window_start is null or window_end is null),false) or count(*)<>count(distinct counter_key)
        into v_new.checkin_windows,v_invalid
        from jsonb_to_recordset(v_new.checkin_windows) w(counter_key text,window_start text,window_end text);
      if v_invalid then raise exception 'Invalid check-in windows' using errcode='22023'; end if;
    end if;
    v_new.source_side:=case v_new.type when 'A' then 'ARR' else 'DEP' end;
    v_new.action:=case when v_new.status='deleted' then 'deleted' when v_old.action='added' then 'added' else 'modified' end;
    if v_new.status='active' then v_new.deletion_reason:=null; end if;
    if v_new.status='deleted' then
      v_new.linked_draft_id:=null; v_new.turnaround_id:=null; v_new.link_type:=null; v_new.pair_anchor_date:=null;
    end if;
    if v_patch ?| array['linked_draft_id','turnaround_id','link_type','pair_anchor_date','status','type'] then
      v_new.link_id:=coalesce(v_new.turnaround_id,v_id);
      v_new.linked_source_row_index:=null;
      v_pair_ids:=array_append(array_append(v_pair_ids,v_id),v_old.linked_draft_id);
    end if;
    update public.seasonal_flight_drafts set type=v_new.type,airline=v_new.airline,flight_number=v_new.flight_number,
      raw_flight_number=v_new.raw_flight_number,request_status_code=v_new.request_status_code,route=v_new.route,schedule=v_new.schedule,
      aircraft=v_new.aircraft,category=v_new.category,code_shares=v_new.code_shares,int_dom_ind=v_new.int_dom_ind,pax=v_new.pax,
      gate=v_new.gate,stand=v_new.stand,carousel=v_new.carousel,mct=v_new.mct,fb=v_new.fb,lb=v_new.lb,bhs=v_new.bhs,ghs=v_new.ghs,
      date=v_new.date,scheduled_date=v_new.scheduled_date,scheduled_time=v_new.scheduled_time,operational_date=v_new.operational_date,
      flight_series_id=v_new.flight_series_id,day_of_week=v_new.day_of_week,source_side=v_new.source_side,
      linked_draft_id=v_new.linked_draft_id,turnaround_id=v_new.turnaround_id,link_type=v_new.link_type,pair_anchor_date=v_new.pair_anchor_date,
      link_id=v_new.link_id,linked_source_row_index=v_new.linked_source_row_index,
      status=v_new.status,action=v_new.action,deletion_reason=v_new.deletion_reason,counters=v_new.counters,checkin_windows=v_new.checkin_windows,
      check_in_start=v_new.check_in_start,check_in_end=v_new.check_in_end,check_in_allocation_mode=v_new.check_in_allocation_mode,
      lifecycle_changed_at=case when v_old.status is distinct from v_new.status then now() else lifecycle_changed_at end,
      lifecycle_changed_by=case when v_old.status is distinct from v_new.status then v_actor else lifecycle_changed_by end,
      updated_at=now(),updated_by=v_actor where draft_id=v_id returning to_jsonb(seasonal_flight_drafts.*) into v_after;
    -- Shared sequence for native draft writers; backfill is disabled once they write.
    v_seq:=nextval('public.seasonal_draft_event_seq');
    insert into public.seasonal_draft_events(season_id,client_id,op_id,actor_user_id,server_seq,target_id,changed_fields,before_state,after_state)
      values(p_season_id,'draft-v1:'||v_actor::text,p_request_id::text||':'||v_id,v_actor,v_seq,v_id,
        array(select jsonb_object_keys(v_patch)),v_before,v_after);
  end loop;
  -- Deleting one half also clears its survivor. Defer until all explicit patches
  -- pass their original preimages; a survivor may itself occur in this batch.
  for v_old in select * from public.seasonal_flight_drafts d
    where d.season_id=p_season_id and d.status='active' and d.linked_draft_id in(
      select draft_id from public.seasonal_flight_drafts where draft_id=any(v_ids) and status='deleted'
    ) order by draft_id for update
  loop
    update public.seasonal_flight_drafts set linked_draft_id=null,turnaround_id=null,link_type=null,pair_anchor_date=null,
      link_id=draft_id,linked_source_row_index=null,
      action=case when action='added' then action else 'modified' end,updated_at=now(),updated_by=v_actor
      where draft_id=v_old.draft_id returning to_jsonb(seasonal_flight_drafts.*) into v_after;
    v_seq:=nextval('public.seasonal_draft_event_seq');
    insert into public.seasonal_draft_events(season_id,client_id,op_id,actor_user_id,server_seq,target_id,changed_fields,before_state,after_state)
      values(p_season_id,'draft-v1:'||v_actor::text,p_request_id::text||':'||v_old.draft_id||':unlink',v_actor,v_seq,v_old.draft_id,
        array['linked_draft_id','turnaround_id','link_type','pair_anchor_date','link_id','linked_source_row_index'],to_jsonb(v_old),v_after);
  end loop;
  if exists(select 1 from public.seasonal_flight_drafts d left join public.seasonal_flight_drafts other on other.draft_id=d.linked_draft_id
    where d.draft_id=any(v_pair_ids) and (
      (d.linked_draft_id is null and (d.turnaround_id is not null or d.link_type is not null or d.pair_anchor_date is not null))
      or (d.linked_draft_id is not null and (d.status<>'active' or other.status is distinct from 'active'
        or other.season_id is distinct from d.season_id or other.linked_draft_id is distinct from d.draft_id
        or other.type=d.type or d.turnaround_id is null or other.turnaround_id is distinct from d.turnaround_id
        or d.link_type is null or other.link_type is distinct from d.link_type or d.pair_anchor_date is null or other.pair_anchor_date is distinct from d.pair_anchor_date))
    )) then raise exception 'Draft pairing must be reciprocal, active and within the season' using errcode='22023'; end if;
  select revision into v_revision from public.seasonal_draft_workspace where season_id=p_season_id;
  -- Aggregate once; appending full JSON rows in the loop makes a seasonal group quadratic.
  select coalesce(jsonb_agg(jsonb_build_object('draftId',target_id,'serverSeq',server_seq::text,'after',after_state) order by server_seq),'[]')
    into v_events from public.seasonal_draft_events where season_id=p_season_id and server_seq>v_start_seq;
  v_result:=jsonb_build_object('status','committed','requestId',p_request_id,'revision',v_revision::text,'events',v_events);
  insert into public.seasonal_draft_mutation_receipts(actor_id,request_id,season_id,request_payload,result) values(v_actor,p_request_id,p_season_id,v_request,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_seasonal_draft_changes_v1(text,uuid,bigint,jsonb) from public,anon;
grant execute on function public.apply_seasonal_draft_changes_v1(text,uuid,bigint,jsonb) to authenticated;

create table public.seasonal_publish_previews (
  preview_id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users on delete restrict,
  request_id uuid not null,
  season_id text not null references public.seasons on delete restrict,
  published_on date not null,
  base_version_id uuid references public.seasonal_publish_versions on delete restrict,
  draft_epoch uuid not null,
  draft_revision bigint not null,
  draft_checksum text not null,
  scope_fingerprint text not null,
  planning_snapshot jsonb not null,
  preview jsonb not null,
  preview_hash text not null,
  status text not null check(status in('ready','blocked','committed')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '2 hours',
  unique(actor_id,request_id)
);
create table public.seasonal_publish_preview_entries (
  preview_id uuid not null references public.seasonal_publish_previews on delete cascade,
  entry_index bigint not null,
  change_type text not null check(change_type in('added','modified','removed')),
  flight_key text not null,
  source_draft_id text not null,
  operational_date date not null,
  side text not null,
  airline text not null,
  flight_number text not null,
  before_state jsonb,
  after_state jsonb,
  changed_fields text[] not null,
  primary key(preview_id,entry_index)
);
revoke all on public.seasonal_publish_previews,public.seasonal_publish_preview_entries from public,anon,authenticated;

create function public.seasonal_publish_bounds_v1(p_season_id text) returns table(start_date date,end_date date)
language sql stable security definer set search_path=pg_catalog,public as $$
 with dates as (
   select coalesce(nullif(d.operational_date,''),public.seasonal_operational_date_v2(
     coalesce(nullif(d.scheduled_date,''),d.date)::date,coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text)::date as ops_day
     from public.seasonal_flight_drafts d where d.season_id=p_season_id and d.status='active'
   union all
   select operational_date from public.operational_flight_legs
     where source_season_id=p_season_id and source_type='published_seasonal' and status='active'
 )
 select least(nullif(s.effective_start,'')::date,(select min(ops_day) from dates)),
   greatest(nullif(s.effective_end,'')::date,(select max(ops_day) from dates))
 from public.seasons s where s.id=p_season_id
$$;
revoke all on function public.seasonal_publish_bounds_v1(text) from public,anon,authenticated;

create function public.seasonal_publish_scope_fingerprint_v1(p_season_id text) returns text
language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_array(
   (now() at time zone 'Asia/Ho_Chi_Minh')::date,
   (select jsonb_build_array(effective_start,effective_end,season_code) from public.seasons where id=p_season_id),
   (select jsonb_agg(to_jsonb(a) order by a.operational_date) from public.operational_day_authority a
     join public.seasonal_publish_bounds_v1(p_season_id) b on a.operational_date between b.start_date and b.end_date),
   (select jsonb_agg(to_jsonb(l) order by l.leg_id) from public.operational_flight_legs l
     where l.source_season_id=p_season_id and l.source_type='published_seasonal' and l.status='active')
 )::text,'UTF8')),'hex')
$$;
revoke all on function public.seasonal_publish_scope_fingerprint_v1(text) from public,anon,authenticated;

create function public.seasonal_planning_diff_v1(p_before jsonb,p_after jsonb)
returns table(change_type text,flight_key text,source_draft_id text,operational_date date,side text,airline text,
  flight_number text,before_state jsonb,after_state jsonb,changed_fields text[])
language sql stable set search_path=pg_catalog,public as $$
 with old_rows as (
   select f->>'draftId' id,f->>'supersedesDraftId' supersedes_id,f->>'schedule' schedule,
     coalesce(nullif(f->>'operationalDate',''),public.seasonal_operational_date_v2(
       coalesce(nullif(f->>'scheduledDate',''),f->>'date')::date,coalesce(nullif(f->>'schedule',''),f->>'scheduledTime')::time)::text)::date op_date,
     case f->>'type' when 'A' then 'ARR' else 'DEP' end side,
     f->>'airline' airline,f->>'flightNumber' flight_number,
     concat_ws(chr(31),f->>'type',
       coalesce(nullif(f->>'operationalDate',''),public.seasonal_operational_date_v2(
         coalesce(nullif(f->>'scheduledDate',''),f->>'date')::date,coalesce(nullif(f->>'schedule',''),f->>'scheduledTime')::time)::text),
       upper(btrim(f->>'airline')),upper(btrim(f->>'flightNumber'))) k,
     f
   from jsonb_array_elements(coalesce(p_before->'flights','[]')) f where f->>'status'='active'
 ), new_rows as (
   select f->>'draftId' id,f->>'supersedesDraftId' supersedes_id,f->>'schedule' schedule,
     coalesce(nullif(f->>'operationalDate',''),public.seasonal_operational_date_v2(
       coalesce(nullif(f->>'scheduledDate',''),f->>'date')::date,coalesce(nullif(f->>'schedule',''),f->>'scheduledTime')::time)::text)::date op_date,
     case f->>'type' when 'A' then 'ARR' else 'DEP' end side,
     f->>'airline' airline,f->>'flightNumber' flight_number,
     concat_ws(chr(31),f->>'type',
       coalesce(nullif(f->>'operationalDate',''),public.seasonal_operational_date_v2(
         coalesce(nullif(f->>'scheduledDate',''),f->>'date')::date,coalesce(nullif(f->>'schedule',''),f->>'scheduledTime')::time)::text),
       upper(btrim(f->>'airline')),upper(btrim(f->>'flightNumber'))) k,
     f
   from jsonb_array_elements(coalesce(p_after->'flights','[]')) f where f->>'status'='active'
 ), id_matches as materialized (
   select o.id old_id,n.id new_id,
     coalesce(n.id,o.id) draft_id,coalesce(n.op_date,o.op_date) op_date,
     coalesce(n.side,o.side) side,coalesce(n.airline,o.airline) airline,
     coalesce(n.flight_number,o.flight_number) flight_number,coalesce(n.k,o.k) flight_key,
     o.k old_k,n.k new_k,o.f old_f,n.f new_f,
     o.supersedes_id old_supersedes_id,n.supersedes_id new_supersedes_id,
     o.schedule old_schedule,n.schedule new_schedule
   from old_rows o full outer join new_rows n on o.id=n.id
 ), old_unmatched as (
   select old_id id,old_k k,op_date,side,airline,flight_number,old_f f,old_supersedes_id supersedes_id,old_schedule schedule
   from id_matches where new_id is null
 ), new_unmatched as (
   select new_id id,new_k k,op_date,side,airline,flight_number,new_f f,new_supersedes_id supersedes_id,new_schedule schedule
   from id_matches where old_id is null
 ), lineage_candidates as (
   select o.id old_id,n.id new_id,count(*) over(partition by o.id) old_count,count(*) over(partition by n.id) new_count
   from old_unmatched o join new_unmatched n on n.supersedes_id=o.id
 ), lineage_pairs as (
   select old_id,new_id from lineage_candidates where old_count=1 and new_count=1
 ), lineage_conflicts as (
   select old_id,new_id from lineage_candidates where old_count<>1 or new_count<>1
 ), old_without_lineage as (
   select * from old_unmatched where id not in(select old_id from lineage_pairs)
     and id not in(select old_id from lineage_conflicts)
 ), new_without_lineage as (
   select * from new_unmatched where id not in(select new_id from lineage_pairs)
     and id not in(select new_id from lineage_conflicts)
 ), key_candidates as (
   select o.id old_id,n.id new_id,count(*) over(partition by o.id) old_count,count(*) over(partition by n.id) new_count
   from old_without_lineage o join new_without_lineage n using(k)
 ), key_pairs as (
   select old_id,new_id from key_candidates where old_count=1 and new_count=1
 ), old_without_key as (
   select * from old_without_lineage where id not in(select old_id from key_pairs)
 ), new_without_key as (
   select * from new_without_lineage where id not in(select new_id from key_pairs)
 ), time_candidates as (
   select o.id old_id,n.id new_id,count(*) over(partition by o.id) old_count,count(*) over(partition by n.id) new_count
   from old_without_key o join new_without_key n on n.k=o.k and n.schedule=o.schedule
 ), time_pairs as (
   select old_id,new_id from time_candidates where old_count=1 and new_count=1
 ), rematch_pairs as (
   select old_id,new_id from lineage_pairs union all select old_id,new_id from key_pairs union all select old_id,new_id from time_pairs
 ), old_left as (
   select * from old_unmatched where id not in(select old_id from rematch_pairs)
 ), new_left as (
   select * from new_unmatched where id not in(select new_id from rematch_pairs)
 ), ambiguous_keys as (
   select k from old_left intersect select k from new_left
 ), combined as (
   select draft_id,op_date,side,airline,flight_number,flight_key,old_f before_,new_f after_,false ambiguous
   from id_matches where old_id is not null and new_id is not null
   union all
   select n.id,n.op_date,n.side,n.airline,n.flight_number,n.k,o.f,n.f,false
   from rematch_pairs p join old_unmatched o on o.id=p.old_id join new_unmatched n on n.id=p.new_id
   union all
   select o.id,o.op_date,o.side,o.airline,o.flight_number,o.k,o.f,null,
     o.k in(select k from ambiguous_keys) or o.id in(select old_id from lineage_conflicts)
   from old_left o
   union all
   select n.id,n.op_date,n.side,n.airline,n.flight_number,n.k,null,n.f,
     n.k in(select k from ambiguous_keys) or n.id in(select new_id from lineage_conflicts)
   from new_left n
 ), semantic as (
   select draft_id,op_date,side,airline,flight_number,flight_key,before_,after_,ambiguous,
     case when ambiguous then 'ambiguous' when before_ is null then 'added' when after_ is null then 'removed'
       when before_=after_ then 'unchanged'
       when (before_-array['draftId','sourceRowIndex','linkedSourceRowIndex','sourceImportBatchId','sourceImportStagingRowIndex','sourceFileHash','supersedesDraftId','action','status'])
            is distinct from
            (after_-array['draftId','sourceRowIndex','linkedSourceRowIndex','sourceImportBatchId','sourceImportStagingRowIndex','sourceFileHash','supersedesDraftId','action','status'])
       then 'modified' else 'unchanged' end change_type,
     case when before_ is not null and after_ is not null and before_=after_ then null
       else before_-array['draftId','sourceRowIndex','linkedSourceRowIndex','sourceImportBatchId','sourceImportStagingRowIndex','sourceFileHash','supersedesDraftId','action','status'] end before_semantic,
     case when before_ is not null and after_ is not null and before_=after_ then null
       else after_-array['draftId','sourceRowIndex','linkedSourceRowIndex','sourceImportBatchId','sourceImportStagingRowIndex','sourceFileHash','supersedesDraftId','action','status'] end after_semantic
   from combined
 )
 select change_type,flight_key,draft_id,op_date,side,airline,flight_number,before_,after_,
   case when change_type in('modified','added','removed','ambiguous') then
     array(select key from jsonb_object_keys(coalesce(before_semantic,'{}')||coalesce(after_semantic,'{}')) key
       where before_semantic->key is distinct from after_semantic->key order by key)
   else array[]::text[] end
 from semantic
$$;
revoke all on function public.seasonal_planning_diff_v1(jsonb,jsonb) from public,anon,authenticated;

create function public.preview_seasonal_publish_v1(p_season_id text,p_request_id uuid,p_published_on date default (now() at time zone 'Asia/Ho_Chi_Minh')::date) returns jsonb
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
  -- Same order as Daily/Publish: operational workspace before season/draft.
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
  -- Materialize the relational diff once; never build a second full JSON copy
  -- of unchanged flights just to count them and insert the changed entries.
  with diff as materialized (
    select * from public.seasonal_planning_diff_v1(v_before,v_snapshot)
  ), built as (
  select jsonb_build_object('baseVersionId',v_base,'draftRevision',v_workspace.revision::text,'draftEpoch',v_workspace.epoch,
    'draftChecksum',v_checksum,'scopeFingerprint',v_scope,'businessToday',v_today,'proposedTag',v_tag,
    'publishedOn',p_published_on,'sequenceInDay',v_sequence,'rangeStart',v_start,'rangeEnd',v_end,'planningCounts',
      (select jsonb_build_object('added',count(*) filter(where d.change_type='added'),'modified',count(*) filter(where d.change_type='modified'),
        'removed',count(*) filter(where d.change_type='removed'),'unchanged',count(*) filter(where d.change_type='unchanged'),
        'ambiguous',count(*) filter(where d.change_type='ambiguous')) from diff d),
    'diagnostics',coalesce((select jsonb_agg(jsonb_build_object('code','AMBIGUOUS_PLANNING_IDENTITY','flightKey',key)) from
      (select distinct d.flight_key key from diff d where d.change_type='ambiguous') x),'[]'::jsonb),
    'skippedDays',coalesce((select jsonb_agg(a.operational_date order by a.operational_date) from public.operational_day_authority a
      where a.operational_date between v_start and v_end and a.reset_at is null),'[]'::jsonb),
    'publishableDays',coalesce((select jsonb_agg(day::date order by day) from generate_series(
      greatest(v_start,v_today+1)::timestamp,v_end::timestamp,interval '1 day') day
      where not exists(select 1 from public.operational_day_authority a where a.operational_date=day::date and a.reset_at is null)),'[]'::jsonb),
    'operationalCounts',jsonb_build_object(
      'write',(select count(*) from public.seasonal_flight_drafts d where d.season_id=p_season_id and d.status='active'
        and coalesce(nullif(d.operational_date,''),public.seasonal_operational_date_v2(coalesce(nullif(d.scheduled_date,''),d.date)::date,coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text)::date>v_today
        and not exists(select 1 from public.operational_day_authority a where a.operational_date=coalesce(nullif(d.operational_date,''),public.seasonal_operational_date_v2(coalesce(nullif(d.scheduled_date,''),d.date)::date,coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text)::date and a.reset_at is null)),
      'retire',(select count(*) from public.operational_flight_legs l where l.source_season_id=p_season_id and l.source_type='published_seasonal'
        and l.status='active' and l.operational_date>v_today
        and not exists(select 1 from public.operational_day_authority a where a.operational_date=l.operational_date and a.reset_at is null)
        and not exists(select 1 from public.seasonal_flight_drafts d where d.season_id=p_season_id and d.draft_id=l.source_draft_id and d.status='active'))
    )
  ) as body
  ), saved as (
    insert into public.seasonal_publish_previews(preview_id,actor_id,request_id,season_id,published_on,base_version_id,
      draft_epoch,draft_revision,draft_checksum,scope_fingerprint,planning_snapshot,preview,preview_hash,status)
    select v_id,v_actor,p_request_id,p_season_id,p_published_on,v_base,v_workspace.epoch,v_workspace.revision,v_checksum,v_scope,
      v_snapshot,b.body,encode(sha256(convert_to(b.body::text,'UTF8')),'hex'),
      case when exists(select 1 from diff where change_type='ambiguous') then 'blocked' else 'ready' end from built b returning *
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

create function public.get_seasonal_publish_preview_page_v1(p_preview_id uuid,p_preview_hash text,p_after_index bigint default 0,p_page_size integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_preview public.seasonal_publish_previews%rowtype; v_result jsonb;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.write') is not true then
    raise exception 'seasonal.write permission required' using errcode='42501'; end if;
  if p_after_index is null or p_after_index<0 or p_page_size is null or p_page_size not between 1 and 500 then
    raise exception 'Invalid preview page' using errcode='22023'; end if;
  select * into v_preview from public.seasonal_publish_previews where preview_id=p_preview_id and actor_id=auth.uid();
  if not found then raise exception 'Preview not found' using errcode='P0002'; end if;
  if v_preview.preview_hash is distinct from p_preview_hash or v_preview.expires_at<=now() then raise exception 'Preview expired or hash changed' using errcode='PT409'; end if;
  with candidates as materialized (
    select * from public.seasonal_publish_preview_entries where preview_id=p_preview_id and entry_index>p_after_index order by entry_index limit p_page_size+1
  ), page as (
    select * from candidates order by entry_index limit p_page_size
  )
  select jsonb_build_object('entries',coalesce((select jsonb_agg(to_jsonb(p)-'preview_id' order by entry_index) from page p),'[]'::jsonb),
    'hasMore',(select count(*) from candidates)>p_page_size,'nextIndex',(select max(entry_index)::text from page),
    'stale',not exists(select 1 from public.seasonal_draft_workspace w where w.season_id=v_preview.season_id
        and w.epoch=v_preview.draft_epoch and w.revision=v_preview.draft_revision)
      or v_preview.draft_checksum is distinct from encode(sha256(convert_to(public.seasonal_planning_snapshot_v1(v_preview.season_id)::text,'UTF8')),'hex')
      or v_preview.scope_fingerprint is distinct from public.seasonal_publish_scope_fingerprint_v1(v_preview.season_id)
      or v_preview.base_version_id is distinct from (select version_id from public.seasonal_publish_versions where season_id=v_preview.season_id order by publish_sequence desc limit 1)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.preview_seasonal_publish_v1(text,uuid,date),public.get_seasonal_publish_preview_page_v1(uuid,text,bigint,integer) from public,anon;
grant execute on function public.preview_seasonal_publish_v1(text,uuid,date),public.get_seasonal_publish_preview_page_v1(uuid,text,bigint,integer) to authenticated;

create or replace function public.backfill_seasonal_draft_allocations_v1() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_ambiguous_draft_id text;
  v_ambiguous_active integer;
begin
  -- Same source selection as backfill_seasonal_flight_drafts_v1: only multiple
  -- base active rows are ambiguous; all-terminal identities take the latest
  -- lifecycle change.
  select
    d.draft_id,
    count(*) filter (where d.status = 'active' and coalesce(d.action, '') <> 'deleted')::integer as active_count
  into
    v_ambiguous_draft_id,
    v_ambiguous_active
  from (
    select
      public.seasonal_draft_id_v1(
        records.season_id,
        records.type,
        public.seasonal_backfill_identity_date_v1(records.scheduled_date, records.operational_date, records.date),
        records.airline,
        records.flight_number
      ) as draft_id,
      records.status,
      records.action
    from public.season_flight_records records
    where records.source_kind = 'seasonal'
  ) d
  group by d.draft_id
  having count(*) filter (where d.status = 'active' and coalesce(d.action, '') <> 'deleted') > 1
  limit 1;

  if v_ambiguous_draft_id is not null then
    raise exception 'Ambiguous seasonal flight draft %: multiple base active source rows found (%)',
      v_ambiguous_draft_id, v_ambiguous_active
      using errcode = '22023';
  end if;

  with scoped as (
    select
      records.*,
      public.seasonal_draft_id_v1(
        records.season_id,
        records.type,
        public.seasonal_backfill_identity_date_v1(records.scheduled_date, records.operational_date, records.date),
        records.airline,
        records.flight_number
      ) as draft_id,
      (records.status = 'active' and coalesce(records.action, '') <> 'deleted') as is_base_active
    from public.season_flight_records records
    where records.source_kind = 'seasonal'
  ),
  chosen as (
    select distinct on (draft_id) scoped.*
    from scoped
    where draft_id is not null
    order by draft_id, case when is_base_active then 0 else 1 end,
      lifecycle_changed_at desc nulls last, record_id desc
  )
  update public.seasonal_flight_drafts d set
    scheduled_time=coalesce(nullif(d.schedule,''),d.scheduled_time),
    operational_date=coalesce(public.seasonal_operational_date_v2(
      public.seasonal_backfill_identity_date_v1(d.scheduled_date,d.operational_date,d.date),
      coalesce(nullif(d.schedule,''),d.scheduled_time)::time)::text,d.operational_date),
    counters=case when coalesce('counter'=any(m.changed_fields),false) then
      coalesce((select jsonb_agg(to_jsonb(c)-'leg_id' order by counter_group,item_index)
        from public.season_modification_counters c where c.leg_id=r.record_id),'[]'::jsonb)
      else coalesce((select jsonb_agg(to_jsonb(c)-'record_id' order by counter_group,item_index)
        from public.season_flight_record_counters c where c.record_id=r.record_id),'[]'::jsonb) end,
    checkin_windows=case when coalesce('checkInCounterWindows'=any(m.changed_fields),false) then
      coalesce((select jsonb_agg(to_jsonb(w)-'leg_id' order by counter_key)
        from public.season_modification_checkin_windows w where w.leg_id=r.record_id),'[]'::jsonb)
      else coalesce((select jsonb_agg(to_jsonb(w)-'record_id' order by counter_key)
        from public.season_flight_record_checkin_windows w where w.record_id=r.record_id),'[]'::jsonb) end,
    check_in_start=m.check_in_start,check_in_end=m.check_in_end,check_in_allocation_mode=m.check_in_allocation_mode
  from chosen r left join public.season_modifications m on m.leg_id=r.record_id
  where d.draft_id=r.draft_id;
  perform setval('public.seasonal_draft_event_seq',greatest(coalesce((select max(server_seq) from public.seasonal_draft_events),0),1),
    exists(select 1 from public.seasonal_draft_events));
end;
$$;
revoke all on function public.backfill_seasonal_draft_allocations_v1() from public,anon,authenticated;

create or replace function public.seed_seasonal_baseline_versions_v1(p_run_id uuid,p_published_on date,p_published_by uuid)
returns integer language plpgsql security definer set search_path=pg_catalog,public set statement_timeout='900s' as $function$
declare v_season public.seasons%rowtype; v_payload jsonb; v_checksum text; v_sequence integer; v_version uuid; v_written integer:=0; v_count integer;
begin
  if p_published_by is null then raise exception 'Baseline operator is required' using errcode='22023'; end if;
  for v_season in select s.* from public.seasons s
    where exists(select 1 from public.seasonal_flight_drafts d where d.season_id=s.id)
      and not exists(select 1 from public.seasonal_publish_versions v where v.season_id=s.id and v.backfill_run_id is not null)
    order by s.id
  loop
    v_payload:=public.seasonal_planning_snapshot_v1(v_season.id);
    v_checksum:=encode(sha256(convert_to(v_payload::text,'UTF8')),'hex');
    v_count:=(v_payload#>>'{counts,active}')::integer;
    select count(*)+1 into v_sequence from public.seasonal_publish_versions where season_id=v_season.id;
    insert into public.seasonal_publish_versions(season_id,season_code,version_tag,sequence_in_day,published_at,published_by,
      publish_notes,range_start,range_end,total_flight_count,added_count,diff_summary,snapshot_checksum,backfill_run_id)
    values(v_season.id,v_season.season_code,public.seasonal_publish_version_tag(v_season.season_code,p_published_on,v_sequence),
      v_sequence,now(),p_published_by,'M2 baseline backfill: planning snapshot without daily operational data',
      coalesce(public.seasonal_backfill_identity_date_v1(v_season.effective_start,null,null),p_published_on),
      coalesce(public.seasonal_backfill_identity_date_v1(v_season.effective_end,null,null),p_published_on),
      v_count,v_count,jsonb_build_object('scope','planning','baseline',true),v_checksum,p_run_id) returning version_id into v_version;
    insert into public.seasonal_publish_snapshots(version_id,season_id,snapshot_payload,flight_count,checksum)
      values(v_version,v_season.id,v_payload,v_count,v_checksum);
    v_written:=v_written+1;
  end loop;
  update public.seasonal_operational_backfill_runs set versions_seeded=v_written where run_id=p_run_id;
  return v_written;
end;
$function$;

create or replace function public.run_seasonal_operational_backfill_v1(p_published_on date,p_published_by uuid,p_replayed_from_high_water bigint default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions,pg_temp set statement_timeout='1800s' as $function$
declare
  v_run_id uuid; v_cutoff timestamptz:=statement_timestamp(); v_high_water bigint;
  v_drafts jsonb; v_versions integer; v_legs jsonb; v_authority integer;
begin
  if (public.app_operator_has_permission('seasonal.write') or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('season.repair')) is not true then
    raise exception 'Backfill permission required' using errcode='42501'; end if;
  perform 1 from public.operational_workspace_revision where singleton for update;
  perform 1 from public.seasons order by id for update;
  if exists(select 1 from public.daily_schedule_import_batches where contract_version=2 and status='committed')
    or exists(select 1 from public.seasonal_draft_mutation_receipts)
    or exists(select 1 from public.seasonal_publish_versions where backfill_run_id is null) then
    raise exception 'Legacy backfill cannot run after native Daily/draft/Publish writes' using errcode='55000'; end if;
  select coalesce(max(server_seq),0) into v_high_water from public.season_change_events;
  insert into public.seasonal_operational_backfill_runs(cutoff_at,source_high_water,replayed_from_high_water,published_on,published_by,status)
    values(v_cutoff,v_high_water,p_replayed_from_high_water,p_published_on,p_published_by,'running') returning run_id into v_run_id;
  begin
    v_drafts:=public.backfill_seasonal_flight_drafts_v1(v_run_id);
    perform public.backfill_seasonal_draft_allocations_v1();
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

create function public.get_seasonal_draft_window_v1(p_season_id text,p_page_size integer default 500,
  p_after_draft_id text default null,p_expected_epoch uuid default null,p_expected_revision bigint default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public set statement_timeout='8s' as $$
declare v_workspace public.seasonal_draft_workspace%rowtype; v_result jsonb;
begin
  if auth.uid() is null or (public.app_operator_has_permission('seasonal.read') or public.app_operator_has_permission('detailed.read')) is not true then
    raise exception 'Planning read permission required' using errcode='42501'; end if;
  if p_page_size is null or p_page_size not between 1 and 1000
    or (p_expected_epoch is null)<>(p_expected_revision is null)
    or (p_after_draft_id is not null and p_expected_revision is null) then
    raise exception 'Invalid draft page or missing snapshot' using errcode='22023'; end if;
  select * into v_workspace from public.seasonal_draft_workspace where season_id=p_season_id;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if p_expected_revision is not null and (p_expected_revision<>v_workspace.revision or p_expected_epoch<>v_workspace.epoch) then
    return jsonb_build_object('status','snapshot_changed','revision',v_workspace.revision::text,'epoch',v_workspace.epoch);
  end if;
  with candidates as materialized (
    select * from public.seasonal_flight_drafts where season_id=p_season_id and status='active'
      and (p_after_draft_id is null or draft_id>p_after_draft_id) order by draft_id limit p_page_size+1
  ), page as (select * from candidates order by draft_id limit p_page_size)
  select jsonb_build_object('status','ok','revision',v_workspace.revision::text,'epoch',v_workspace.epoch,
    'serverHighWater',coalesce((select max(server_seq) from public.seasonal_draft_events where season_id=p_season_id),0)::text,
    'drafts',coalesce((select jsonb_agg(to_jsonb(d) order by draft_id) from page d),'[]'::jsonb),
    'hasMore',(select count(*) from candidates)>p_page_size,'nextDraftId',(select max(draft_id) from page)) into v_result;
  return v_result;
end;
$$;
create function public.get_seasonal_draft_export_snapshot_v1(p_season_id text,p_expected_epoch uuid,p_expected_revision bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public set statement_timeout='30s' as $$
declare v_workspace public.seasonal_draft_workspace%rowtype; v_result jsonb;
begin
  if auth.uid() is null or (public.app_operator_has_permission('seasonal.read') or public.app_operator_has_permission('detailed.read')) is not true then
    raise exception 'Planning read permission required' using errcode='42501'; end if;
  if p_expected_epoch is null or p_expected_revision is null then raise exception 'Draft snapshot required' using errcode='22023'; end if;
  select * into v_workspace from public.seasonal_draft_workspace where season_id=p_season_id;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if p_expected_epoch<>v_workspace.epoch or p_expected_revision<>v_workspace.revision then raise exception 'Draft snapshot changed' using errcode='PT409'; end if;
  with records as materialized(select * from public.seasonal_flight_drafts where season_id=p_season_id and status='active')
  select jsonb_build_object('seasonId',p_season_id,'seasonCode',(select season_code from public.seasons where id=p_season_id),
    'draftRevision',v_workspace.revision::text,'draftEpoch',v_workspace.epoch,'totalCount',(select count(*) from records),
    'serverHighWater',coalesce((select max(server_seq) from public.seasonal_draft_events where season_id=p_season_id),0)::text,
    'truncated',false,'flightRecords',coalesce((select jsonb_agg(
      (to_jsonb(d)-array['draft_id','counters','checkin_windows'])||jsonb_build_object('record_id',d.draft_id,'linked_record_id',d.linked_draft_id)
      order by d.draft_id) from records d),'[]'::jsonb),
    'flightRecordCounters',coalesce((select jsonb_agg(c||jsonb_build_object('record_id',d.draft_id) order by d.draft_id,c->>'counter_group',(c->>'item_index')::integer)
      from records d cross join lateral jsonb_array_elements(d.counters) c),'[]'::jsonb),
    'flightRecordWindows',coalesce((select jsonb_agg(w||jsonb_build_object('record_id',d.draft_id) order by d.draft_id,w->>'counter_key')
      from records d cross join lateral jsonb_array_elements(d.checkin_windows) w),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_seasonal_draft_window_v1(text,integer,text,uuid,bigint),
  public.get_seasonal_draft_export_snapshot_v1(text,uuid,bigint) from public,anon;
grant execute on function public.get_seasonal_draft_window_v1(text,integer,text,uuid,bigint),
  public.get_seasonal_draft_export_snapshot_v1(text,uuid,bigint) to authenticated;
alter policy "seasonal flight drafts read" on public.seasonal_flight_drafts
  using ((select public.app_operator_has_permission('seasonal.read')) or (select public.app_operator_has_permission('detailed.read')));
alter policy "seasonal draft events read" on public.seasonal_draft_events
  using ((select public.app_operator_has_permission('seasonal.read')) or (select public.app_operator_has_permission('detailed.read')));
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='seasonal_draft_events') then
    alter publication supabase_realtime add table public.seasonal_draft_events;
  end if;
end $$;
commit;
