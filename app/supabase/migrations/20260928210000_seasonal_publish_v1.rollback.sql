begin;
do $$ begin
 if exists(select 1 from public.seasonal_publish_versions where backfill_run_id is null) then
   raise exception 'Native published versions exist; preserve history' using errcode='55000'; end if;
end $$;
drop function public.commit_seasonal_publish_v1(text,uuid,text,text);
drop function public.get_seasonal_publish_versions_v1(text,bigint,integer);
drop function public.get_seasonal_published_diff_page_v1(uuid,bigint,integer);
create or replace function public.seasonal_publish_scope_fingerprint_v1(p_season_id text) returns text
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
drop function public.seasonal_publish_operations_v1(text);
drop index public.operational_seasonal_history_v1;
drop index public.operational_active_counterpart_v1;
alter table public.seasonal_publish_diff_entries drop column entry_index;
commit;
