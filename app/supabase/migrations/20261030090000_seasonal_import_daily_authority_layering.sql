-- Seasonal Repair/Replace over Ops Dates already owned by a Daily import.
--
-- commit_seasonal_import_v3 never activates a Seasonal occurrence whose Ops Date
-- carries an active schedule_replacement_scopes row: it inserts the row as
-- status='deleted' so the Daily store stays the operational truth. The stage
-- guard daily-occurrence-collision nevertheless blocked those occurrences by
-- calendar date, so a Repair whose effective range covered any Daily day could
-- not be committed at all (W26 batch 00ea8b43: 311 occurrences, all covered).
--
-- 1. stage_seasonal_import_v3: a Daily collision no longer blocks when the
--    incoming occurrence's Ops Date is covered by an active Daily scope, using
--    the exact predicate commit uses to keep the row inactive. Collisions that
--    commit would activate (e.g. an early-morning leg whose Ops Date falls on a
--    day without Daily authority) still block.
-- 2. commit_seasonal_import_v3: those inactive rows used to be tagged
--    deletion_reason='daily_authority', which reset_daily_authority_v1 never
--    restores, while the replaced Seasonal generation stayed in the reset
--    preimage chain. A later reset therefore revived the previous file. The new
--    rows now take the old generation's place in the bottom (pre-Daily) layer of
--    each Ops Date's chain (deletion_reason='daily_replacement',
--    superseded_by_batch_id = bottom Daily batch) and the generation they
--    replace is retired as seasonal_rebuild: every older Seasonal row on
--    replace, matching occurrences on merge, plus colliding bottom-layer manual
--    rows on replace (mirroring the active manual supersede).
--    reset_daily_authority_v1 and its preview are unchanged: they keep popping
--    exactly one layer.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $layering$
declare
  v_stage text;
  v_commit text;
  v_stage_anchor constant text := $anchor$  where incoming.batch_id = v_batch.batch_id
    and (v_strategy = 'merge' or authority.source_kind <> 'manual');
$anchor$;
  v_commit_anchor constant text := $anchor$  insert into public.season_modifications(
    season_id,leg_id,action,changed_fields,pax,gate,stand,carousel,mct,fb,lb,bhs,ghs,
$anchor$;
begin
  v_stage := replace(
    pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure),
    chr(13) || chr(10), chr(10));
  v_commit := replace(
    pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),
    chr(13) || chr(10), chr(10));

  if position('seasonal_import_daily_authority_layering_v1' in v_stage) > 0
    and position('seasonal_import_daily_authority_layering_v1' in v_commit) > 0
  then
    return;
  end if;
  if position('seasonal_import_daily_authority_layering_v1' in v_stage) > 0
    or position('seasonal_import_daily_authority_layering_v1' in v_commit) > 0
  then
    raise exception 'Seasonal Daily authority layering is only partially installed';
  end if;
  if (length(v_stage) - length(replace(v_stage, v_stage_anchor, ''))) / length(v_stage_anchor) <> 1 then
    raise exception 'stage_seasonal_import_v3 Daily authority layering preimage changed';
  end if;
  if (length(v_commit) - length(replace(v_commit, v_commit_anchor, ''))) / length(v_commit_anchor) <> 1 then
    raise exception 'commit_seasonal_import_v3 Daily authority layering preimage changed';
  end if;

  v_stage := replace(v_stage, v_stage_anchor, replace($body$  where incoming.batch_id = v_batch.batch_id
    and (v_strategy = 'merge' or authority.source_kind <> 'manual')
    -- seasonal_import_daily_authority_layering_v1: commit keeps an occurrence
    -- inactive when its Ops Date has active Daily authority, so it cannot
    -- duplicate the Daily leg and must not block the import.
    and not (
      authority.source_kind <> 'manual'
      and exists (
        select 1 from public.schedule_replacement_scopes scopes
        where scopes.season_id = v_target_season_id and scopes.reset_at is null
          and scopes.ops_date = public.canonical_flight_leg_ops_date_v1(
            incoming.record_data->>'operationalDate', incoming.record_data->>'scheduledDate',
            incoming.record_data->>'date', incoming.record_data->>'scheduledTime',
            incoming.record_data->>'schedule')
      )
    );
$body$, chr(13) || chr(10), chr(10)));

  v_commit := replace(v_commit, v_commit_anchor, replace($body$  -- seasonal_import_daily_authority_layering_v1
  -- Bottom layer of every active Daily-owned Ops Date: walk the reset preimage
  -- chain from the current scope batch through older Daily batches.
  drop table if exists pg_temp.seasonal_import_daily_layers_v3;
  create temporary table seasonal_import_daily_layers_v3 on commit drop as
  with recursive chain(ops_date, batch_id, depth) as (
    select scopes.ops_date, scopes.source_batch_id, 0
    from public.schedule_replacement_scopes scopes
    where scopes.season_id = v_target_season_id and scopes.reset_at is null
    union
    select chain.ops_date, older.source_import_batch_id, chain.depth + 1
    from chain
    join public.season_flight_records older
      on older.season_id = v_target_season_id
      and older.superseded_by_batch_id = chain.batch_id
      and older.source_kind = 'daily'
      and older.status = 'deleted' and older.action = 'deleted'
      and older.deletion_reason = 'daily_replacement'
      and older.source_import_batch_id is not null
      and public.canonical_flight_leg_ops_date_v1(older.operational_date, older.scheduled_date,
        older.date, older.scheduled_time, older.schedule) = chain.ops_date
    where chain.depth < 64
  )
  select chain.ops_date, chain.batch_id as layer_batch_id, chain.depth
  from chain;
  if exists (
    select 1 from pg_temp.seasonal_import_daily_layers_v3 layers
    group by layers.ops_date, layers.depth
    having pg_catalog.count(distinct layers.layer_batch_id) > 1
  ) then
    raise exception 'Ambiguous Daily reset preimage chain for season %', v_target_season_id
      using errcode = 'PT409';
  end if;
  delete from pg_temp.seasonal_import_daily_layers_v3 layers
  where exists (
    select 1 from pg_temp.seasonal_import_daily_layers_v3 deeper
    where deeper.ops_date = layers.ops_date and deeper.depth > layers.depth
  );

  -- Retire the replaced bottom-layer generation so a reset cannot revive it.
  update public.season_flight_records records
  set deletion_reason = 'seasonal_rebuild',
      lifecycle_changed_at = pg_catalog.now(),
      lifecycle_changed_by = auth.uid()
  from pg_temp.seasonal_import_daily_layers_v3 layers
  where records.season_id = v_target_season_id
    and records.superseded_by_batch_id = layers.layer_batch_id
    and records.status = 'deleted' and records.action = 'deleted'
    and records.deletion_reason = 'daily_replacement'
    and public.canonical_flight_leg_ops_date_v1(records.operational_date, records.scheduled_date,
      records.date, records.scheduled_time, records.schedule) = layers.ops_date
    and (
      (records.source_kind = 'seasonal' and v_batch.apply_strategy = 'replace')
      or (
        (records.source_kind = 'seasonal'
          or (records.source_kind = 'manual' and v_batch.apply_strategy = 'replace'))
        and exists (
          select 1 from pg_temp.seasonal_import_commit_records_v3 incoming
          where incoming.is_insert
            and incoming.occurrence_key = v_target_season_id
              || '|' || coalesce(nullif(records.scheduled_date, ''), records.date)
              || '|' || pg_catalog.upper(pg_catalog.btrim(records.airline))
              || '|' || (
                select normalized.flight_number
                from public.normalize_seasonal_flight_number_v2(
                  records.airline,
                  coalesce(nullif(records.flight_number, ''), records.raw_flight_number)
                ) normalized
              )
        )
      )
    );

  -- The new generation takes the bottom-layer place.
  update public.season_flight_records records
  set deletion_reason = 'daily_replacement',
      superseded_by_batch_id = layers.layer_batch_id
  from pg_temp.seasonal_import_daily_layers_v3 layers
  where records.season_id = v_target_season_id
    and records.source_import_batch_id = p_batch_id
    and records.source_kind = 'seasonal'
    and records.status = 'deleted' and records.action = 'deleted'
    and records.deletion_reason = 'daily_authority'
    and public.canonical_flight_leg_ops_date_v1(records.operational_date, records.scheduled_date,
      records.date, records.scheduled_time, records.schedule) = layers.ops_date;
  if exists (
    select 1 from public.season_flight_records records
    where records.season_id = v_target_season_id
      and records.source_import_batch_id = p_batch_id
      and records.deletion_reason = 'daily_authority'
  ) then
    raise exception 'Seasonal Daily-owned rows were not layered for batch %', p_batch_id
      using errcode = 'P0001';
  end if;

$body$, chr(13) || chr(10), chr(10)) || v_commit_anchor);

  execute v_stage;
  execute v_commit;

  if position('seasonal_import_daily_authority_layering_v1' in
      pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure)) = 0
    or position('seasonal_import_daily_authority_layering_v1' in
      pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure)) = 0
  then
    raise exception 'Seasonal Daily authority layering replacement was incomplete';
  end if;
end;
$layering$;

notify pgrst, 'reload schema';
commit;
