-- The seasonal stage blocks duplicate occurrence keys inside one file, but it
-- only compares them against active seasonal plan rows: a plan row re-imported
-- for a calendar day that already carries an active Daily leg was staged as a
-- clean insert and committed a second active leg for the same
-- (calendar date, airline, normalized flight number) tuple -- the exact shape
-- that made the export duplicate gate reject a season and blocked Add Flight.
-- The daily store stays the authority, so a plan occurrence colliding with an
-- active Daily leg is now a blocking diagnostic (daily-occurrence-collision)
-- instead of a silent insert. Overlay-deleted daily rows are not active and do
-- not collide, legacy plan kinds (imported/added) are not authority rows, and
-- manual added flights keep their own manual-occurrence-collision code in merge
-- mode.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $daily_guard$
declare
  v_definition text;
begin
  select replace(
      pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;

  -- A hotfix may already carry this guard.
  if position('daily-occurrence-collision' in v_definition) > 0 then
    return;
  end if;

  if position($anchor$  select pg_catalog.count(distinct diagnostics.occurrence_key)::integer
  into v_manual_collision_count
  from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
  where diagnostics.code = 'manual-occurrence-collision';

  with grouped as (
$anchor$ in v_definition) = 0 then
    raise exception 'stage_seasonal_import_v3 daily guard preimage changed';
  end if;

  v_definition := replace(v_definition,
$anchor$  select pg_catalog.count(distinct diagnostics.occurrence_key)::integer
  into v_manual_collision_count
  from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
  where diagnostics.code = 'manual-occurrence-collision';

  with grouped as (
$anchor$,
$body$  select pg_catalog.count(distinct diagnostics.occurrence_key)::integer
  into v_manual_collision_count
  from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
  where diagnostics.code = 'manual-occurrence-collision';

  with daily_candidates as (
    select
      records.record_id,
      coalesce(nullif(records.scheduled_date, ''), nullif(records.date, ''))
        as scheduled_date,
      pg_catalog.upper(pg_catalog.btrim(records.airline)) as airline,
      coalesce(nullif(records.flight_number, ''), records.raw_flight_number)
        as raw_flight_number
    from public.season_flight_records records
    left join public.season_modifications modifications
      on modifications.season_id = records.season_id
      and modifications.leg_id = records.record_id
    where records.season_id = v_target_season_id
      and records.source_kind not in ('seasonal', 'imported', 'added')
      and records.action is distinct from 'added'
      and (v_strategy <> 'merge' or records.source_kind <> 'manual')
      and records.status = 'active'
      and records.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'
  ), daily_occurrences as (
    select
      distinct_occurrences.occurrence_key,
      pg_catalog.min(distinct_occurrences.record_id) as record_id
    from (
      select distinct
        v_target_season_id
          || '|'
          || daily_candidates.scheduled_date
          || '|'
          || daily_candidates.airline
          || '|'
          || normalized.flight_number as occurrence_key,
        daily_candidates.record_id
      from daily_candidates
      cross join lateral public.normalize_seasonal_flight_number_v2(
        daily_candidates.airline,
        daily_candidates.raw_flight_number
      ) normalized
      where daily_candidates.scheduled_date is not null
    ) distinct_occurrences
    group by distinct_occurrences.occurrence_key
  )
  insert into pg_temp.seasonal_import_v3_diagnostic_items (
    code,
    message,
    source_row_indexes,
    occurrence_key,
    affected_date,
    airline,
    flight_number
  )
  select
    'daily-occurrence-collision',
    pg_catalog.format(
      'Incoming occurrence collides with an active Daily leg (%s): each flight number may appear only once within a calendar day.',
      daily.record_id
    ),
    array[incoming.source_row_index],
    incoming.occurrence_key,
    pg_catalog.split_part(incoming.occurrence_key, '|', 2),
    pg_catalog.split_part(incoming.occurrence_key, '|', 3),
    pg_catalog.split_part(incoming.occurrence_key, '|', 4)
  from public.season_import_batch_records_v3 incoming
  join daily_occurrences daily
    on daily.occurrence_key = incoming.occurrence_key
  where incoming.batch_id = v_batch.batch_id;

  with grouped as (
$body$);

  if position('daily-occurrence-collision' in v_definition) = 0 then
    raise exception 'daily occurrence collision guard replacement was incomplete';
  end if;

  execute v_definition;
end
$daily_guard$;

comment on function public.stage_seasonal_import_v3(jsonb) is
  'Stages a seasonal plan import batch; a plan occurrence colliding with an active Daily leg is a blocking daily-occurrence-collision diagnostic.';

notify pgrst, 'reload schema';
commit;
