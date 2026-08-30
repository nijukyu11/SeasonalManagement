-- Seasonal V3 owns only source_kind='seasonal'. Daily/manual rows and Daily
-- replacement scopes remain authoritative across Merge and Full Replace.

do $patch_stage$
declare
  v_definition text;
  v_updated text;
begin
  select pg_catalog.pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure)
    into v_definition;
  v_definition := replace(v_definition,chr(13)||chr(10),chr(10));
  v_updated := replace(v_definition,
    'records.source_kind = ''imported''',
    'records.source_kind = ''seasonal''');
  v_updated := replace(v_updated,
    '''sourceKind'', ''imported''',
    '''sourceKind'', ''seasonal''');
  v_updated := replace(v_updated,
    'records.source_kind = ''added''',
    'records.source_kind = ''manual''');
  v_updated := replace(v_updated,
    'where records.season_id = v_target_season_id
      union',
    'where records.season_id = v_target_season_id
        and records.source_kind = ''seasonal''
        and records.status = ''active''
        and records.action is distinct from ''deleted''
      union');
  v_updated := replace(v_updated,
    '    v_preserved_overlay_count := 0;
    v_preserved_deleted_overlay_count := 0;',
    '    select pg_catalog.count(*)::integer,
      pg_catalog.count(*) filter(where modifications.action=''deleted'')::integer
    into v_preserved_overlay_count,v_preserved_deleted_overlay_count
    from public.season_modifications modifications
    where modifications.season_id=v_target_season_id;
    v_clear_structural_overlay_count := 0;
    v_clear_deleted_overlay_count := 0;');
  if v_updated=v_definition
    or v_updated not like '%records.source_kind = ''seasonal''%'
  then
    raise exception 'Could not patch Seasonal V3 stage for canonical source authority';
  end if;
  execute v_updated;
end;
$patch_stage$;

do $patch_commit$
declare
  v_definition text;
  v_updated text;
  v_anchor text;
  v_replacement text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure
  ) into v_definition;
  v_definition := replace(v_definition,chr(13)||chr(10),chr(10));
  v_updated := replace(v_definition,
    'records.source_kind = ''imported''',
    'records.source_kind = ''seasonal''');
  v_updated := replace(v_updated,
    '''sourceKind'', ''imported''',
    '''sourceKind'', ''seasonal''');
  v_updated := replace(v_updated,
    'records.source_kind = ''added''',
    'records.source_kind = ''manual''');
  v_updated := replace(v_updated,
    'added_legs.source_kind = ''added''',
    'added_legs.source_kind = ''manual''');
  v_updated := replace(v_updated,
    '''imported'',
    incoming.record_data->>''sourceSide''',
    '''seasonal'',
    incoming.record_data->>''sourceSide''');

  -- Match old Seasonal occurrences for overlay rebase, but issue batch-scoped
  -- record IDs so the old rows can remain as deleted history.
  v_anchor := '  create unique index seasonal_import_commit_generated_id_v3
    on pg_temp.seasonal_import_commit_records_v3 (generated_record_id);';
  v_replacement := '  if v_batch.apply_strategy = ''replace'' then
    update pg_temp.seasonal_import_commit_records_v3 incoming
    set matched_record_id = existing.record_id
    from (
      select records.record_id,
        v_target_season_id || ''|''
          || coalesce(nullif(records.scheduled_date, ''''), records.date) || ''|''
          || pg_catalog.upper(pg_catalog.btrim(records.airline)) || ''|''
          || normalized.flight_number as occurrence_key
      from public.season_flight_records records
      cross join lateral public.normalize_seasonal_flight_number_v2(
        records.airline,coalesce(nullif(records.flight_number, ''''),records.raw_flight_number)
      ) normalized
      where records.season_id=v_target_season_id
        and records.source_kind=''seasonal''
        and public.is_canonical_flight_leg_active_v1(records.status,records.action)
    ) existing
    where existing.occurrence_key=incoming.occurrence_key;

    update pg_temp.seasonal_import_commit_records_v3 incoming
    set generated_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        final_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        is_insert=true,
        needs_update=false;
  end if;

' || v_anchor;
  if strpos(v_updated,v_anchor)=0 then
    raise exception 'Seasonal V3 generated-id anchor changed';
  end if;
  v_updated := replace(v_updated,v_anchor,v_replacement);

  -- Full Replace preimage/removal scope contains Seasonal rows only.
  v_updated := replace(v_updated,
    'where records.season_id = v_target_season_id
    and v_batch.apply_strategy = ''replace''',
    'where records.season_id = v_target_season_id
    and v_batch.apply_strategy = ''replace''
    and records.source_kind = ''seasonal''
    and public.is_canonical_flight_leg_active_v1(records.status,records.action)');
  v_updated := replace(v_updated,
    'where records.season_id = v_target_season_id
      union',
    'where records.season_id = v_target_season_id
        and records.source_kind = ''seasonal''
        and public.is_canonical_flight_leg_active_v1(records.status,records.action)
      union');
  v_updated := replace(v_updated,
    '    v_preserved_overlay_count := 0;
    v_preserved_deleted_overlay_count := 0;',
    '    select pg_catalog.count(*)::integer,
      pg_catalog.count(*) filter(where modifications.action=''deleted'')::integer
    into v_preserved_overlay_count,v_preserved_deleted_overlay_count
    from public.season_modifications modifications
    where modifications.season_id=v_target_season_id;
    v_clear_structural_overlay_count := 0;
    v_clear_deleted_overlay_count := 0;');

  -- Preserve history, overlays, Daily/Manual rows and entity versions. Only the
  -- active Seasonal generation is superseded.
  v_anchor := '  if v_batch.apply_strategy = ''replace'' then
    delete from public.season_mod_history_entries history
    where history.season_id = v_target_season_id;

    delete from public.season_modifications modifications
    where modifications.season_id = v_target_season_id;

    delete from public.season_flight_records records
    where records.season_id = v_target_season_id;

    delete from public.season_entity_versions versions
    where versions.season_id = v_target_season_id;
  end if;';
  v_replacement := '  if v_batch.apply_strategy = ''replace'' then
    update public.season_flight_records records
    set status=''deleted'',action=''deleted'',deletion_reason=''seasonal_rebuild'',
        lifecycle_changed_at=pg_catalog.now(),lifecycle_changed_by=auth.uid()
    where records.season_id=v_target_season_id
      and records.source_kind=''seasonal''
      and public.is_canonical_flight_leg_active_v1(records.status,records.action);
  end if;';
  if strpos(v_updated,v_anchor)=0 then
    raise exception 'Seasonal V3 replace-delete anchor changed';
  end if;
  v_updated := replace(v_updated,v_anchor,v_replacement);

  -- Merge is never allowed to update a Daily or Manual base row.
  v_updated := replace(v_updated,
    'and records.season_id = v_target_season_id
    and incoming.needs_update;',
    'and records.season_id = v_target_season_id
    and records.source_kind = ''seasonal''
    and incoming.needs_update;');

  -- Rows falling inside an active Daily authority scope are retained only as
  -- inactive Seasonal history; this also covers explicit zero-flight days.
  v_updated := replace(v_updated,
    '    linked_record_id,
    source_kind,
    source_side,
    status,
    turnaround_id,',
    '    linked_record_id,
    action,
    source_kind,
    source_side,
    status,
    deletion_reason,
    lifecycle_changed_at,
    lifecycle_changed_by,
    turnaround_id,');
  v_updated := replace(v_updated,
    '    incoming.linked_final_record_id,
    ''seasonal'',
    incoming.record_data->>''sourceSide'',
    ''active'',
    incoming.resolved_turnaround_id,',
    '    incoming.linked_final_record_id,
    case when exists (
      select 1 from public.schedule_replacement_scopes scopes
      where scopes.season_id=v_target_season_id and scopes.reset_at is null
        and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
          incoming.record_data->>''operationalDate'',incoming.record_data->>''scheduledDate'',
          incoming.record_data->>''date'',incoming.record_data->>''scheduledTime'',
          incoming.record_data->>''schedule'')
    ) then ''deleted'' else null end,
    ''seasonal'',
    incoming.record_data->>''sourceSide'',
    case when exists (
      select 1 from public.schedule_replacement_scopes scopes
      where scopes.season_id=v_target_season_id and scopes.reset_at is null
        and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
          incoming.record_data->>''operationalDate'',incoming.record_data->>''scheduledDate'',
          incoming.record_data->>''date'',incoming.record_data->>''scheduledTime'',
          incoming.record_data->>''schedule'')
    ) then ''deleted'' else ''active'' end,
    case when exists (
      select 1 from public.schedule_replacement_scopes scopes
      where scopes.season_id=v_target_season_id and scopes.reset_at is null
        and scopes.ops_date=public.canonical_flight_leg_ops_date_v1(
          incoming.record_data->>''operationalDate'',incoming.record_data->>''scheduledDate'',
          incoming.record_data->>''date'',incoming.record_data->>''scheduledTime'',
          incoming.record_data->>''schedule'')
    ) then ''daily_authority'' else null end,
    pg_catalog.now(),auth.uid(),
    incoming.resolved_turnaround_id,');

  -- Rebase only committed operational overlays. Structural schedule/route/Pax
  -- values remain owned by the newly imported Seasonal row.
  v_anchor := '  perform pg_catalog.set_config(
    ''app.seasonal_import_v3_bulk_season_id'',
    '''',
    true
  );';
  v_replacement := '  insert into public.season_modifications(
    season_id,leg_id,action,changed_fields,gate,stand,carousel,mct,fb,lb,bhs,ghs,
    check_in_start,check_in_end,check_in_allocation_mode
  )
  select mods.season_id,incoming.final_record_id,mods.action,
    case when mods.action=''deleted'' then mods.changed_fields else coalesce((
      select array_agg(field order by ordinal)
      from unnest(mods.changed_fields) with ordinality allowed(field,ordinal)
      where field=any(array[''gate'',''stand'',''carousel'',''counter'',''checkInStart'',
        ''checkInEnd'',''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs''])
    ),''{}''::text[]) end,
    mods.gate,mods.stand,mods.carousel,mods.mct,mods.fb,mods.lb,mods.bhs,mods.ghs,
    mods.check_in_start,mods.check_in_end,mods.check_in_allocation_mode
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modifications mods
    on mods.season_id=v_target_season_id and mods.leg_id=incoming.matched_record_id
  where incoming.matched_record_id is not null
    and incoming.final_record_id<>incoming.matched_record_id
    and mods.action in (''modified'',''deleted'')
    and (mods.action=''deleted'' or mods.changed_fields && array[
      ''gate'',''stand'',''carousel'',''counter'',''checkInStart'',''checkInEnd'',
      ''checkInAllocationMode'',''mct'',''fb'',''lb'',''bhs'',''ghs'']::text[])
  on conflict(leg_id) do nothing;

  insert into public.season_modification_counters(leg_id,counter_group,item_index,counter_value)
  select incoming.final_record_id,counters.counter_group,counters.item_index,counters.counter_value
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_counters counters on counters.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;

  insert into public.season_modification_checkin_windows(leg_id,counter_key,window_start,window_end)
  select incoming.final_record_id,windows.counter_key,windows.window_start,windows.window_end
  from pg_temp.seasonal_import_commit_records_v3 incoming
  join public.season_modification_checkin_windows windows on windows.leg_id=incoming.matched_record_id
  join public.season_modifications mods on mods.leg_id=incoming.final_record_id
  where incoming.final_record_id<>incoming.matched_record_id
  on conflict do nothing;

' || v_anchor;
  if strpos(v_updated,v_anchor)=0 then
    raise exception 'Seasonal V3 post-insert anchor changed';
  end if;
  v_updated := replace(v_updated,v_anchor,v_replacement);

  -- Season totals/range are always derived from the same canonical effective
  -- base predicate, regardless of Merge versus Replace.
  v_anchor := '  if v_batch.apply_strategy = ''replace'' then
    v_effective_record_count := v_imported_record_count;
    select
      pg_catalog.min(
        coalesce(
          nullif(incoming.record_data->>''scheduledDate'', ''''),
          nullif(incoming.record_data->>''date'', '''')
        )
      ),
      pg_catalog.max(
        coalesce(
          nullif(incoming.record_data->>''scheduledDate'', ''''),
          nullif(incoming.record_data->>''date'', '''')
        )
      )
    into v_effective_start, v_effective_end
    from pg_temp.seasonal_import_commit_records_v3 incoming;
  else
    select pg_catalog.count(*)::integer
    into v_imported_record_count
    from public.season_flight_records records
    where records.season_id = v_target_season_id
      and records.source_kind = ''seasonal'';

    with effective_schedule as (
      select
        records.record_id,
        coalesce(nullif(records.scheduled_date, ''''), nullif(records.date, ''''))
          as scheduled_date
      from public.season_flight_records records
      left join public.season_modifications modifications
        on modifications.season_id = records.season_id
        and modifications.leg_id = records.record_id
      where records.season_id = v_target_season_id
        and records.status = ''active''
        and records.action is distinct from ''deleted''
        and modifications.action is distinct from ''deleted''
      union
      select
        added_legs.record_id,
        coalesce(
          nullif(added_legs.scheduled_date, ''''),
          nullif(added_legs.date, '''')
        )
      from public.season_modification_added_legs added_legs
      join public.season_modifications modifications
        on modifications.season_id = added_legs.season_id
        and modifications.leg_id = added_legs.leg_id
      where added_legs.season_id = v_target_season_id
        and added_legs.status = ''active''
        and added_legs.action is distinct from ''deleted''
        and modifications.action = ''added''
    )
    select
      pg_catalog.count(*)::integer,
      pg_catalog.min(effective_schedule.scheduled_date),
      pg_catalog.max(effective_schedule.scheduled_date)
    into v_effective_record_count, v_effective_start, v_effective_end
    from effective_schedule;
  end if;';
  v_replacement := '  select pg_catalog.count(*)::integer
  into v_imported_record_count
  from public.canonical_active_flight_records_v1 records
  where records.season_id=v_target_season_id and records.source_kind=''seasonal'';

  select pg_catalog.count(*)::integer,
    pg_catalog.min(coalesce(nullif(records.scheduled_date,''''),nullif(records.date,''''))),
    pg_catalog.max(coalesce(nullif(records.scheduled_date,''''),nullif(records.date,'''')))
  into v_effective_record_count,v_effective_start,v_effective_end
  from public.canonical_active_flight_records_v1 records
  left join public.season_modifications modifications
    on modifications.season_id=records.season_id and modifications.leg_id=records.record_id
  where records.season_id=v_target_season_id
    and modifications.action is distinct from ''deleted'';';
  if strpos(v_updated,v_anchor)=0 then
    raise exception 'Seasonal V3 effective-count anchor changed';
  end if;
  v_updated := replace(v_updated,v_anchor,v_replacement);

  if v_updated=v_definition
    or v_updated not like '%source_kind = ''seasonal''%'
    or v_updated not like '%deletion_reason=''seasonal_rebuild''%'
    or v_updated not like '%schedule_replacement_scopes%'
  then
    raise exception 'Could not patch Seasonal V3 commit for canonical authority';
  end if;
  execute v_updated;
end;
$patch_commit$;

-- Transitional writers have now been replaced. Reject any new legacy kind.
alter table public.season_flight_records
  drop constraint if exists season_flight_records_source_kind_check;
alter table public.season_flight_records
  add constraint season_flight_records_source_kind_check
  check(source_kind in ('seasonal','daily','manual')) not valid;
alter table public.season_flight_records
  validate constraint season_flight_records_source_kind_check;

create or replace function public.commit_seasonal_import_v2(
  p_batch_id uuid,
  p_expected_data_version integer
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,pg_temp
as $$
begin
  raise exception 'Seasonal import V2 commit is disabled after canonical flight-leg cutover; use V3 preview/commit'
    using errcode='0A000';
end;
$$;

revoke execute on function public.commit_seasonal_import_v2(uuid,integer)
  from public,anon;
grant execute on function public.commit_seasonal_import_v2(uuid,integer)
  to authenticated;
