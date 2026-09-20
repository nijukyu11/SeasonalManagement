-- The daily duplicate guard reported every active authority row as a Daily leg,
-- but replace never resets a season's legs: a replace commit inserts beside the
-- rows already stored (measured on the production chain: a replace stage plus
-- commit on a two-leg season left both legs active and added the file's leg).
-- An Add Flight row (source_kind='manual') therefore keeps its blocking meaning
-- in replace mode; only the classification was wrong. Manual authority rows now
-- raise their own manual-occurrence-collision code in both strategies, Daily
-- store rows keep daily-occurrence-collision, and the manual collision counter
-- is recomputed after the guard so replace previews report it.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $daily_guard_classification$
declare
  v_definition text;
begin
  select pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.stage_seasonal_import_v3(jsonb)'::regprocedure
      ),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;

  -- A hotfix may already carry this classification.
  if position('daily-guard-kind-classification' in v_definition) > 0 then
    return;
  end if;

  if position($old_guard$
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

$old_guard$ in v_definition) = 0 then
    raise exception 'stage_seasonal_import_v3 daily guard classification preimage changed';
  end if;

  v_definition := replace(v_definition,
$old_guard$
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

$old_guard$,
$new_guard$
  -- daily-guard-kind-classification
  with authority_candidates as (
    select
      records.record_id,
      records.source_kind,
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
      and records.status = 'active'
      and records.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'
  ), authority_occurrences as (
    select
      distinct_occurrences.source_kind,
      distinct_occurrences.occurrence_key,
      pg_catalog.min(distinct_occurrences.record_id) as record_id
    from (
      select distinct
        authority_candidates.source_kind,
        v_target_season_id
          || '|'
          || authority_candidates.scheduled_date
          || '|'
          || authority_candidates.airline
          || '|'
          || normalized.flight_number as occurrence_key,
        authority_candidates.record_id
      from authority_candidates
      cross join lateral public.normalize_seasonal_flight_number_v2(
        authority_candidates.airline,
        authority_candidates.raw_flight_number
      ) normalized
      where authority_candidates.scheduled_date is not null
    ) distinct_occurrences
    group by distinct_occurrences.source_kind, distinct_occurrences.occurrence_key
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
    case
      when authority.source_kind = 'manual' then 'manual-occurrence-collision'
      else 'daily-occurrence-collision'
    end,
    case
      when authority.source_kind = 'manual'
        then 'Incoming occurrence collides with a manual added flight.'
      else pg_catalog.format(
        'Incoming occurrence collides with an active Daily leg (%s): each flight number may appear only once within a calendar day.',
        authority.record_id
      )
    end,
    array[incoming.source_row_index],
    incoming.occurrence_key,
    pg_catalog.split_part(incoming.occurrence_key, '|', 2),
    pg_catalog.split_part(incoming.occurrence_key, '|', 3),
    pg_catalog.split_part(incoming.occurrence_key, '|', 4)
  from public.season_import_batch_records_v3 incoming
  join authority_occurrences authority
    on authority.occurrence_key = incoming.occurrence_key
  where incoming.batch_id = v_batch.batch_id;

  select pg_catalog.count(distinct diagnostics.occurrence_key)::integer
  into v_manual_collision_count
  from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
  where diagnostics.code = 'manual-occurrence-collision';

$new_guard$);

  if position('daily-guard-kind-classification' in v_definition) = 0
    or position('authority_occurrences' in v_definition) = 0
  then
    raise exception 'daily guard kind classification replacement was incomplete';
  end if;

  execute v_definition;
end
$daily_guard_classification$;

comment on function public.stage_seasonal_import_v3(jsonb) is
  'Stages a seasonal plan import batch; a plan occurrence colliding with an active Daily leg raises daily-occurrence-collision and one colliding with an active Add Flight row raises manual-occurrence-collision, both blocking.';

notify pgrst, 'reload schema';
commit;
