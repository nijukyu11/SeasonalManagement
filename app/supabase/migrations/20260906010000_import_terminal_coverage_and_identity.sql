-- Preserve terminal overlays across import generations. No historical data is
-- rewritten by this migration; the checks run under the writers' season lock.
begin;

create index if not exists season_flight_records_import_successor_idx
  on public.season_flight_records(season_id,supersedes_record_id)
  where supersedes_record_id is not null;

-- Same rule as cleanFlightNumber: VN1A and VN001A have one normalized identity.
-- Existing rows are normalized for matching; this does not rewrite old data.
create or replace function public.normalize_seasonal_flight_number_v2(p_airline text,p_raw text)
returns table(flight_number text,raw_flight_number text)
language plpgsql immutable rows 1 set search_path=pg_catalog,pg_temp as $$
declare airline text := upper(btrim(p_airline)); part text := regexp_replace(upper(btrim(p_raw)),'\s+','','g'); digits text;
begin
  if part is null or part='' then return; end if;
  if airline<>'' and length(part)>length(airline) and left(part,length(airline))=airline then
    part := substr(part,length(airline)+1);
  end if;
  digits := substring(part from '^[0-9]+');
  if digits is not null and length(digits)<3 then part := repeat('0',3-length(digits)) || part; end if;
  flight_number := airline || part; raw_flight_number := part;
  return next;
end;
$$;

create or replace function public.is_rebasable_terminal_flight_leg_v1(records public.season_flight_records)
returns boolean language sql stable set search_path=pg_catalog,pg_temp as $$
  select records.status='deleted' and records.action='deleted'
    and records.deletion_reason='overlay_deleted'
    and records.superseded_by_batch_id is null
    and exists(select 1 from public.season_modifications mods
      where mods.season_id=records.season_id and mods.leg_id=records.record_id and mods.action='deleted')
    and not exists(select 1 from public.season_flight_records successor
      where successor.season_id=records.season_id and successor.supersedes_record_id=records.record_id)
    and not exists(select 1 from public.schedule_replacement_scopes reset_scope
      where reset_scope.season_id=records.season_id and reset_scope.ops_date::text=records.operational_date
        and reset_scope.source_batch_id=records.source_import_batch_id and reset_scope.reset_at is not null)
    and case when exists(select 1 from public.schedule_replacement_scopes scope
      where scope.season_id=records.season_id and scope.ops_date::text=records.operational_date and scope.reset_at is null)
    then exists(select 1 from public.schedule_replacement_scopes scope
      where scope.season_id=records.season_id and scope.ops_date::text=records.operational_date
        and scope.reset_at is null and scope.source_batch_id=records.source_import_batch_id)
    else records.source_kind in ('seasonal','manual') end;
$$;
revoke all on function public.is_rebasable_terminal_flight_leg_v1(public.season_flight_records) from public,anon,authenticated;

create or replace function public.daily_import_source_fingerprint_v1(p_record_id text)
returns text language sql stable set search_path=pg_catalog,pg_temp as $$
  select md5(jsonb_build_object('record',to_jsonb(records),'overlay',to_jsonb(mods),
    'counters',(select jsonb_agg(to_jsonb(c) order by c.counter_group,c.item_index) from public.season_modification_counters c where c.leg_id=p_record_id),
    'windows',(select jsonb_agg(to_jsonb(w) order by w.counter_key) from public.season_modification_checkin_windows w where w.leg_id=p_record_id))::text)
  from public.season_flight_records records left join public.season_modifications mods on mods.leg_id=records.record_id and mods.season_id=records.season_id
  where records.record_id=p_record_id;
$$;
revoke all on function public.daily_import_source_fingerprint_v1(text) from public,anon,authenticated;

do $patch_daily$
declare
  definition text;
  start_at integer;
  end_at integer;
  anchor text;
begin
  select replace(pg_get_functiondef('public.stage_daily_schedule_import_v1(jsonb)'::regprocedure),chr(13)||chr(10),chr(10)) into definition;
  start_at := strpos(definition,E'        or (\n          records.status=''deleted''');
  end_at := strpos(definition,E'      and records.operational_date=v_leg->>''operationalDate''');
  if start_at=0 or end_at<=start_at then raise exception 'Daily terminal-match preimage changed'; end if;
  definition := substr(definition,1,start_at-1)
    || E'        or public.is_rebasable_terminal_flight_leg_v1(records)\n      )\n'
    || substr(definition,end_at);
  anchor := 'if jsonb_array_length(p_import->''legs'') = 0 then';
  if strpos(definition,anchor)=0 then raise exception 'Daily empty-scope preimage changed'; end if;
  definition := replace(definition,anchor,
    'if jsonb_array_length(p_import->''legs'') = 0 and jsonb_array_length(p_import->''seasons'') = 0 then');
  anchor := 'and upper(records.flight_number)=upper(v_leg->>''flightNumber'')';
  if strpos(definition,anchor)=0 then raise exception 'Daily flight identity preimage changed'; end if;
  definition := replace(definition,anchor,
    'and (select flight_number from public.normalize_seasonal_flight_number_v2(records.airline,records.flight_number))
      =(select flight_number from public.normalize_seasonal_flight_number_v2(v_leg->>''airline'',v_leg->>''flightNumber''))');
  anchor := 'jsonb_build_object(''matchedRecordId'',case when v_match_count=1 then v_matched_record_id end)';
  if strpos(definition,anchor)=0 then raise exception 'Daily overlay-plan preimage changed'; end if;
  definition := replace(definition,anchor,
    'jsonb_build_object(''matchedRecordId'',case when v_match_count=1 then v_matched_record_id end,
      ''sourceFingerprint'',case when v_match_count=1 then public.daily_import_source_fingerprint_v1(v_matched_record_id) end)');
  anchor := E'  select jsonb_build_object(\n    ''valid'', jsonb_array_length(v_diagnostics)=0,';
  if strpos(definition,anchor)=0 then raise exception 'Daily preview contract preimage changed'; end if;
  definition := replace(definition,anchor,E'  select jsonb_build_object(\n    ''importGuardVersion'',1,\n    ''valid'', jsonb_array_length(v_diagnostics)=0,');
  anchor := '  insert into public.daily_schedule_import_batches (';
  if strpos(definition,anchor)=0 then raise exception 'Daily batch preimage changed'; end if;
  definition := replace(definition,anchor,$body$
  -- Same calendar day/airline/flight is forbidden even across sides, routes,
  -- times or an Ops Date boundary. Normalize on the server, not caller keys.
  if exists (
    select 1 from jsonb_array_elements(p_import->'legs') incoming(leg)
    cross join lateral public.normalize_seasonal_flight_number_v2(leg->>'airline',leg->>'flightNumber') normalized
    group by leg->>'scheduledDate',upper(btrim(leg->>'airline')),normalized.flight_number
    having count(*)>1
  ) then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
      'severity','blocking','code','DAILY_DUPLICATE_FLIGHT_NUMBER',
      'message','A flight number may occur only once per calendar date and airline'));
  end if;

$body$ || anchor);
  execute definition;
end;
$patch_daily$;

do $daily_commit_fence$
declare definition text; anchor text;
begin
  select replace(pg_get_functiondef('public.commit_daily_schedule_import_v1(uuid,jsonb,text)'::regprocedure),chr(13)||chr(10),chr(10)) into definition;
  anchor := '  if v_batch.status<>''validated'' or v_batch.expires_at<=now() then';
  if strpos(definition,anchor)=0 then raise exception 'Daily committed receipt preimage changed'; end if;
  definition := replace(definition,anchor,E'  if v_batch.preview->>''importGuardVersion'' is distinct from ''1'' then\n    raise exception ''Stale Daily import contract; restage the preview'' using errcode=''PT409'';\n  end if;\n' || anchor);
  anchor := '    if exists (select 1 from public.season_flight_records records';
  if strpos(definition,anchor)=0 then raise exception 'Daily commit fence preimage changed'; end if;
  definition := replace(definition,anchor,$body$
    if exists(select 1 from public.daily_schedule_import_batch_legs legs
      where legs.batch_id=p_batch_id and legs.season_id=v_target.season_id and legs.matched_record_id is not null
        and (legs.overlay_rebase_plan->>'sourceFingerprint' is null
          or legs.overlay_rebase_plan->>'sourceFingerprint' is distinct from public.daily_import_source_fingerprint_v1(legs.matched_record_id)))
    then raise exception 'Stale Daily import source or overlay; restage the preview' using errcode='PT409'; end if;
$body$ || anchor);
  execute definition;
end;
$daily_commit_fence$;

-- Undo on an older Daily terminal generation must not resurrect it after an
-- import transferred the deletion to a successor. Current-leaf Undo is valid.
do $undo_leaf_guard$
declare definition text; anchor text := 'and superseded_by_batch_id is null;';
begin
  select pg_get_functiondef('public.remove_canonical_season_modification_v1(text,text)'::regprocedure) into definition;
  if strpos(definition,anchor)=0 then raise exception 'Canonical Undo preimage changed'; end if;
  definition := replace(definition,anchor,'and public.is_rebasable_terminal_flight_leg_v1(season_flight_records);');
  execute replace(definition,'40001','PT409');
end;
$undo_leaf_guard$;

do $patch_seasonal$
declare
  definition text;
  anchor text;
begin
  select replace(pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),chr(13)||chr(10),chr(10)) into definition;
  anchor := '  if v_batch.status <> ''validated'' then';
  if strpos(definition,anchor)=0 then raise exception 'Seasonal committed receipt preimage changed'; end if;
  definition := replace(definition,anchor,E'  if v_batch.preview->>''importGuardVersion'' is distinct from ''1'' then\n    raise exception ''Stale Seasonal import contract; restage the preview'' using errcode=''PT409'';\n  end if;\n' || anchor);
  anchor := E'  create unique index seasonal_import_commit_generated_id_v3\n    on pg_temp.seasonal_import_commit_records_v3 (generated_record_id);';
  if strpos(definition,anchor)=0 then raise exception 'Seasonal generation preimage changed'; end if;
  definition := replace(definition,anchor,$body$
  -- The active matcher intentionally excludes history. Add only a terminal
  -- leaf in the current authority, never an arbitrary superseded action row.
  if exists (
    select incoming.occurrence_key
    from pg_temp.seasonal_import_commit_records_v3 incoming
    join public.season_flight_records records on records.season_id=v_target_season_id
      and records.source_kind='seasonal' and public.is_rebasable_terminal_flight_leg_v1(records)
    cross join lateral public.normalize_seasonal_flight_number_v2(records.airline,
      coalesce(nullif(records.flight_number,''),records.raw_flight_number)) normalized
    where incoming.matched_record_id is null
      and incoming.occurrence_key=v_target_season_id || '|' || coalesce(nullif(records.scheduled_date,''),records.date)
        || '|' || upper(btrim(records.airline)) || '|' || normalized.flight_number
    group by incoming.occurrence_key having count(*)>1
  ) then raise exception 'Ambiguous terminal Seasonal occurrence' using errcode='PT409'; end if;

  update pg_temp.seasonal_import_commit_records_v3 incoming
  set matched_record_id=records.record_id
  from public.season_flight_records records
  cross join lateral public.normalize_seasonal_flight_number_v2(records.airline,
    coalesce(nullif(records.flight_number,''),records.raw_flight_number)) normalized
  where incoming.matched_record_id is null and records.season_id=v_target_season_id
    and records.source_kind='seasonal' and public.is_rebasable_terminal_flight_leg_v1(records)
    and incoming.occurrence_key=v_target_season_id || '|' || coalesce(nullif(records.scheduled_date,''),records.date)
      || '|' || upper(btrim(records.airline)) || '|' || normalized.flight_number;

  -- Merge also creates generations: an inactive Daily-owned baseline can
  -- already occupy the old deterministic LEG id after the first merge.
  update pg_temp.seasonal_import_commit_records_v3 incoming
  set generated_record_id='SEASONAL_V3_' || md5(p_batch_id::text || '|' || incoming.occurrence_key),
      final_record_id='SEASONAL_V3_' || md5(p_batch_id::text || '|' || incoming.occurrence_key)
  where incoming.is_insert;

$body$ || anchor);
  -- Terminal rows are rebase sources, not active baseline matches in preview
  -- counts. Keep the same count contract as stage while auditing both IDs.
  anchor := 'pg_catalog.count(*) filter (where incoming.matched_record_id is not null)::integer';
  if strpos(definition,anchor)=0 then raise exception 'Seasonal matched-count preimage changed'; end if;
  definition := replace(definition,anchor,
    'pg_catalog.count(*) filter (where incoming.matched_record_id is not null and not incoming.is_insert)::integer');
  anchor := E'  select incoming.final_record_id as record_id\n  from pg_temp.seasonal_import_commit_records_v3 incoming\n  union';
  if strpos(definition,anchor)=0 then raise exception 'Seasonal audit preimage changed'; end if;
  definition := replace(definition,anchor,E'  select incoming.matched_record_id as record_id\n  from pg_temp.seasonal_import_commit_records_v3 incoming\n  where incoming.matched_record_id is not null\n  union\n' || anchor);
  anchor := E'  perform pg_catalog.set_config(\n    ''app.seasonal_import_v3_bulk_season_id'',\n    '''',\n    true\n  );';
  if strpos(definition,anchor)=0 then raise exception 'Seasonal overlay finalization preimage changed'; end if;
  definition := replace(definition,anchor,$body$
  update public.season_flight_records records
  set supersedes_record_id=incoming.matched_record_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.final_record_id and incoming.is_insert
    and incoming.matched_record_id is not null and incoming.final_record_id<>incoming.matched_record_id;

  update public.season_flight_records records
  set superseded_by_batch_id=p_batch_id
  from pg_temp.seasonal_import_commit_records_v3 incoming
  where records.record_id=incoming.matched_record_id and incoming.is_insert
    and incoming.final_record_id<>incoming.matched_record_id;

  -- Rebased terminal deletion is canonical, not merely a hidden UI overlay.
  update public.season_flight_records records
  set status='deleted',action='deleted',deletion_reason='overlay_deleted',
      lifecycle_changed_at=now(),lifecycle_changed_by=auth.uid()
  from public.season_modifications mods
  where records.season_id=v_target_season_id and records.source_import_batch_id=p_batch_id
    and mods.season_id=records.season_id and mods.leg_id=records.record_id and mods.action='deleted';

$body$ || anchor);
  execute definition;
end;
$patch_seasonal$;

-- Business version conflicts must not trigger PostgREST serialization retries.
do $conflicts$
declare signature text; definition text;
begin
  foreach signature in array array['public.stage_seasonal_import_v3(jsonb)','public.commit_seasonal_import_v3(uuid,integer,text)'] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if signature='public.stage_seasonal_import_v3(jsonb)' then
      if strpos(definition,'v_preview := pg_catalog.jsonb_build_object(')=0 then raise exception 'Seasonal preview contract preimage changed'; end if;
      definition := replace(definition,'v_preview := pg_catalog.jsonb_build_object(', 'v_preview := pg_catalog.jsonb_build_object(''importGuardVersion'',1,');
      definition := replace(definition,'''contractVersion'', 3,','''importGuardVersion'',1,''contractVersion'', 3,');
    end if;
    if strpos(definition,'40001')=0 then raise exception 'Seasonal stale-fence preimage changed: %',signature; end if;
    execute replace(definition,'40001','PT409');
  end loop;
end;
$conflicts$;
commit;
