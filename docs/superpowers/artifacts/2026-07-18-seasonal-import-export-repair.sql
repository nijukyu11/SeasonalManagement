-- Seasonal import/export production data repair.
--
-- SAFETY:
-- - The checked-in executable final statement is ROLLBACK for Task 9 dry runs.
-- - Task 12 may replace only that final ROLLBACK with COMMIT after additive
--   deployment and S26/W26 shadow parity approval.
-- - The transaction aborts if any production identity, count, or state has
--   drifted from the read-only audit captured on 2026-07-19.

\pset pager off
\pset null '<null>'
\set ON_ERROR_STOP on

begin;
set local statement_timeout = '120s';
set local lock_timeout = '10s';

-- Match commit_seasonal_import_v2 exactly: advisory key is
-- hashtextextended(season_id, 0). Acquire every key in lexical season-ID order
-- before waiting for season rows or taking any table-level maintenance lock.
do $$
declare
  v_season_id text;
begin
  for v_season_id in
    select requested.season_id
    from (values
      ('season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'::text),
      ('season-f77c5ea9-be54-4615-ab0a-d83062b9b854'::text),
      ('season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'::text)
    ) requested(season_id)
    order by season_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_season_id, 0)
    );
  end loop;
end;
$$;

-- Lock the same target season rows used by V2 commit, again in lexical ID
-- order, before taking the broader mutable-table graph locks.
select id, season_code, data_version
from public.seasons
where id in (
  'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'season-f77c5ea9-be54-4615-ab0a-d83062b9b854',
  'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
)
order by id
for update;

-- Block INSERT/UPDATE/DELETE across the complete audited seasonal FK graph
-- while allowing ordinary SELECT readers. The order is fixed and parent-first
-- for every Task 9 run. lock_timeout is per lock wait.
-- statement_timeout is per statement; neither bounds the full transaction.
-- The operator must monitor total wall time and cancel at the approved threshold.
-- Every graph lock uses NOWAIT. A conflicting direct writer aborts this psql run
-- before fingerprints, backups, or mutations. ON_ERROR_STOP closes the session,
-- PostgreSQL rolls back the open transaction, and all earlier advisory/row locks
-- are released. Quiesce direct writers and retry the complete artifact.
lock table public.seasons in share row exclusive mode nowait;
lock table public.season_source_rows in share row exclusive mode nowait;
lock table public.season_source_row_days in share row exclusive mode nowait;
lock table public.season_flight_records in share row exclusive mode nowait;
lock table public.season_flight_record_counters in share row exclusive mode nowait;
lock table public.season_flight_record_checkin_windows in share row exclusive mode nowait;
lock table public.season_modifications in share row exclusive mode nowait;
lock table public.season_modification_added_legs in share row exclusive mode nowait;
lock table public.season_modification_counters in share row exclusive mode nowait;
lock table public.season_modification_checkin_windows in share row exclusive mode nowait;
lock table public.season_mod_history_entries in share row exclusive mode nowait;
lock table public.season_mod_history_changes in share row exclusive mode nowait;
lock table public.season_mod_history_record_changes in share row exclusive mode nowait;
lock table public.season_change_events in share row exclusive mode nowait;
lock table public.schedule_notification_deliveries in share row exclusive mode nowait;
lock table public.season_entity_versions in share row exclusive mode nowait;

-- These staging tables are installed by the additive Task 12 migration. They
-- do not exist on the current predeploy production schema, so the predeploy
-- rollback-only dry run locks them only when present.
do $$
begin
  if pg_catalog.to_regclass('public.season_import_batches') is not null then
    execute 'lock table public.season_import_batches in share row exclusive mode nowait';
  end if;
  if pg_catalog.to_regclass('public.season_import_batch_rows') is not null then
    execute 'lock table public.season_import_batch_rows in share row exclusive mode nowait';
  end if;
end;
$$;

create temporary table task9_locked_season_state on commit drop as
select
  seasons.id as season_id,
  pg_catalog.md5(pg_catalog.concat_ws('|',
    pg_catalog.md5(pg_catalog.to_jsonb(seasons)::text),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(records)::text), '' order by records.record_id
      ))
      from public.season_flight_records records
      where records.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(counters)::text), ''
        order by counters.record_id, counters.counter_group, counters.item_index
      ))
      from public.season_flight_record_counters counters
      join public.season_flight_records records on records.record_id = counters.record_id
      where records.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(windows)::text), ''
        order by windows.record_id, windows.counter_key
      ))
      from public.season_flight_record_checkin_windows windows
      join public.season_flight_records records on records.record_id = windows.record_id
      where records.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(modifications)::text), '' order by modifications.leg_id
      ))
      from public.season_modifications modifications
      where modifications.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(counters)::text), ''
        order by counters.leg_id, counters.counter_group, counters.item_index
      ))
      from public.season_modification_counters counters
      join public.season_modifications modifications on modifications.leg_id = counters.leg_id
      where modifications.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(windows)::text), ''
        order by windows.leg_id, windows.counter_key
      ))
      from public.season_modification_checkin_windows windows
      join public.season_modifications modifications on modifications.leg_id = windows.leg_id
      where modifications.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(added_legs)::text), '' order by added_legs.leg_id
      ))
      from public.season_modification_added_legs added_legs
      where added_legs.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(source_rows)::text), '' order by source_rows.row_index
      ))
      from public.season_source_rows source_rows
      where source_rows.season_id = seasons.id
    ), pg_catalog.md5('')),
    coalesce((
      select pg_catalog.md5(pg_catalog.string_agg(
        pg_catalog.md5(pg_catalog.to_jsonb(days)::text), ''
        order by days.row_index, days.iso_dow
      ))
      from public.season_source_row_days days
      where days.season_id = seasons.id
    ), pg_catalog.md5(''))
  )) as state_fingerprint
from public.seasons seasons
where seasons.id in (
  'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'season-f77c5ea9-be54-4615-ab0a-d83062b9b854',
  'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
);

\echo 'REPAIR 01 - assert exact audited production state'
do $$
declare
  v_count bigint;
  v_min_date text;
  v_max_date text;
begin
  if not exists (
    select 1
    from task9_locked_season_state locked
    where locked.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and locked.state_fingerprint = '097e4e976fb8106343c93f366cdc9ea2'
  ) or not exists (
    select 1
    from task9_locked_season_state locked
    where locked.season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
      and locked.state_fingerprint = '0c1b151941e3c08707fe040152890631'
  ) or not exists (
    select 1
    from task9_locked_season_state locked
    where locked.season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
      and locked.state_fingerprint = '7bd171520a385ec980bff2216e4b1a35'
  ) then
    raise exception 'S26/W25/W26 locked state fingerprint drifted; aborting repair';
  end if;

  if not exists (
    select 1 from public.seasons
    where id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and season_code = 'S26'
      and effective_start = '2026-03-29'
      and effective_end = '2026-10-25'
      and total_legs = 26083
      and total_source_rows = 0
      and data_version = 16572
  ) then
    raise exception 'S26 season identity or audited metadata drifted; aborting repair';
  end if;

  if not exists (
    select 1 from public.seasons
    where id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
      and season_code = 'W25'
      and effective_start = '2025-10-26'
      and effective_end = '2026-03-28'
      and total_legs = 8165
      and total_source_rows = 0
      and data_version = 8227
  ) then
    raise exception 'W25 season identity or audited metadata drifted; aborting repair';
  end if;

  if not exists (
    select 1 from public.seasons
    where id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
      and season_code = 'W26'
      and effective_start = '2026-10-25'
      and effective_end = '2027-03-28'
      and total_legs = 26598
      and total_source_rows = 0
      and data_version = 395
  ) then
    raise exception 'W26 season identity or audited metadata drifted; aborting repair';
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
  if v_count <> 26182 then
    raise exception 'Expected 26182 S26 base records, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451';
  if v_count <> 8165 then
    raise exception 'Expected 8165 W25 base records, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854';
  if v_count <> 26641 then
    raise exception 'Expected 26641 W26 base records, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_source_rows
  where season_id in (
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451',
    'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
  );
  if v_count <> 0 then
    raise exception 'Expected zero S26/W25/W26 source rows, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modification_added_legs
  where season_id in (
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451',
    'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
  );
  if v_count <> 0 then
    raise exception 'Expected zero S26/W25/W26 added-leg payload rows, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where action = 'added'
    and season_id in (
      'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451',
      'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
    );
  if v_count <> 0 then
    raise exception 'Expected zero S26/W25/W26 added modifications, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and action = 'modified';
  if v_count <> 1035 then
    raise exception 'Expected 1035 S26 modified overlays, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and action = 'deleted';
  if v_count <> 391 then
    raise exception 'Expected 391 S26 deleted overlays, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
    and action = 'modified';
  if v_count <> 25 then
    raise exception 'Expected 25 W25 modified overlays, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications modifications
  left join public.season_flight_records base
    on base.season_id = modifications.season_id
   and base.record_id = modifications.leg_id
  left join public.season_modification_added_legs added
    on added.season_id = modifications.season_id
   and added.leg_id = modifications.leg_id
  where base.record_id is null and added.leg_id is null;
  if v_count <> 0 then
    raise exception 'Expected zero orphan modifications, found %', v_count;
  end if;

  -- W25 is a legacy base import stored as source_kind=added, but it is not a
  -- proven complete season. Preserve that classification rather than guessing.
  select
    count(*),
    min(date),
    max(date)
  into v_count, v_min_date, v_max_date
  from public.season_flight_records
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
    and source_kind = 'added'
    and status = 'active'
    and action is distinct from 'deleted'
    and record_id like 'DAILY_IMPORT_%';

  if v_count <> 8165
    or v_min_date <> '2025-10-26'
    or v_max_date <> '2026-02-01' then
    raise exception 'W25 legacy baseline evidence drifted: count %, bounds %..%',
      v_count, v_min_date, v_max_date;
  end if;

  if v_max_date = '2026-03-28' then
    raise exception 'W25 now appears complete; re-audit before any reclassification';
  end if;

  raise notice 'W25 source_kind reclassification intentionally skipped: audited coverage ends %, season ends 2026-03-28',
    v_max_date;
end;
$$;

\echo 'REPAIR 02 - assert exact PR585/PR586 keep/discard states'
do $$
declare
  v_count bigint;
begin
  select count(*) into v_count
  from public.season_flight_records records
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and (
      (
        records.record_id = 'F_NEW_1780796888039_giomqg_1'
        and records.type = 'A'
        and records.flight_number = 'PR585'
        and records.raw_flight_number = '585'
        and records.route = 'MNL'
        and records.schedule = '15:20'
        and records.aircraft = '321'
        and records.source_kind = 'imported'
        and records.status = 'active'
        and records.action is null
        and records.linked_record_id = 'F_NEW_1780795793508_ycwhyq_0'
        and records.turnaround_id = 'TRN_2026-06-10_940_PR_585_586'
        and modifications.leg_id is null
      )
      or
      (
        records.record_id = 'F_NEW_1780795793508_ycwhyq_0'
        and records.type = 'D'
        and records.flight_number = 'PR586'
        and records.raw_flight_number = '586'
        and records.route = 'MNL'
        and records.schedule = '16:30'
        and records.aircraft = '321'
        and records.source_kind = 'imported'
        and records.status = 'active'
        and records.action is null
        and records.linked_record_id = 'F_NEW_1780796888039_giomqg_1'
        and records.turnaround_id = 'TRN_2026-06-10_940_PR_585_586'
        and modifications.leg_id is null
      )
    );
  if v_count <> 2 then
    raise exception 'Expected two exact effective PR keep records, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records records
  join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and records.record_id in (
      'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
      'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
    )
    and records.source_kind = 'imported'
    and records.status = 'active'
    and records.action is null
    and records.linked_record_id is null
    and records.turnaround_id is null
    and modifications.action = 'deleted'
    and modifications.changed_fields = '{}'::text[];
  if v_count <> 2 then
    raise exception 'Expected two exact hidden PR discard records, found %', v_count;
  end if;

  select
    (select count(*) from public.season_flight_record_counters
      where record_id in (
        'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
        'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
      ))
    + (select count(*) from public.season_flight_record_checkin_windows
      where record_id in (
        'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
        'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
      ))
    + (select count(*) from public.season_modification_counters
      where leg_id in (
        'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
        'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
      ))
    + (select count(*) from public.season_modification_checkin_windows
      where leg_id in (
        'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
        'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
      ))
    + (select count(*) from public.season_modification_added_legs
      where leg_id in (
        'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
        'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
      ))
  into v_count;
  if v_count <> 0 then
    raise exception 'Expected zero child rows on discarded PR duplicates, found %', v_count;
  end if;
end;
$$;

\echo 'REPAIR 03 - assert exact turnaround members and verified reciprocity'
do $$
declare
  v_count bigint;
  v_effective_count bigint;
  v_pair_count bigint;
begin
  select
    count(*),
    count(*) filter (
      where records.status = 'active'
        and records.action is distinct from 'deleted'
        and modifications.action is distinct from 'deleted'
    ),
    count(*) filter (
      where counterpart.record_id is not null
        and counterpart.linked_record_id = records.record_id
    ) / 2
  into v_count, v_effective_count, v_pair_count
  from public.season_flight_records records
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  left join public.season_flight_records counterpart
    on counterpart.season_id = records.season_id
   and counterpart.record_id = records.linked_record_id
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and records.turnaround_id = 'TRN_2026-08-23_948_HX_542_543'
    and records.record_id in (
      'LEG_A_2026-08-23_943_HX_HX542_HKG_03_00_320',
      'LEG_D_2026-08-23_943_HX_HX543_HKG_04_00_320',
      'F_NEW_1784417194491_ojlo5j_1',
      'F_NEW_1784417194491_ojlo5j_2',
      'F_NEW_1784417194495_2zf5s7_1',
      'F_NEW_1784417194495_2zf5s7_2'
    );
  if v_count <> 6 or v_effective_count <> 4 or v_pair_count <> 3 then
    raise exception 'HX turnaround drifted: underlying %, effective %, reciprocal pairs %',
      v_count, v_effective_count, v_pair_count;
  end if;

  select
    count(*),
    count(*) filter (
      where records.status = 'active'
        and records.action is distinct from 'deleted'
        and modifications.action is distinct from 'deleted'
    ),
    count(*) filter (
      where counterpart.record_id is not null
        and counterpart.linked_record_id = records.record_id
    ) / 2
  into v_count, v_effective_count, v_pair_count
  from public.season_flight_records records
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  left join public.season_flight_records counterpart
    on counterpart.season_id = records.season_id
   and counterpart.record_id = records.linked_record_id
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and records.turnaround_id = 'TRN_MANUAL_RF_531_532_2026_07_19_LEG_A_2026_07_19_618_RF_RF531_CJJ_23_55_320_LEG_D_2026_07_19_619_RF_RF532_CJJ_00_55_320'
    and records.record_id in (
      'LEG_A_2026-07-19_618_RF_RF531_CJJ_23_55_320',
      'LEG_D_2026-07-19_619_RF_RF532_CJJ_00_55_320',
      'F_NEW_1783648329496_a90ngi_1',
      'F_NEW_1783648329496_a90ngi_2'
    );
  if v_count <> 4 or v_effective_count <> 4 or v_pair_count <> 2 then
    raise exception 'RF turnaround drifted: underlying %, effective %, reciprocal pairs %',
      v_count, v_effective_count, v_pair_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records records
  where records.record_id in (
    'LEG_A_2026-08-23_943_HX_HX542_HKG_03_00_320',
    'LEG_D_2026-08-23_943_HX_HX543_HKG_04_00_320',
    'F_NEW_1784417194491_ojlo5j_1',
    'F_NEW_1784417194491_ojlo5j_2',
    'F_NEW_1784417194495_2zf5s7_1',
    'F_NEW_1784417194495_2zf5s7_2',
    'LEG_A_2026-07-19_618_RF_RF531_CJJ_23_55_320',
    'LEG_D_2026-07-19_619_RF_RF532_CJJ_00_55_320',
    'F_NEW_1783648329496_a90ngi_1',
    'F_NEW_1783648329496_a90ngi_2'
  )
    and not exists (
      select 1
      from public.season_flight_records counterpart
      where counterpart.season_id = records.season_id
        and counterpart.record_id = records.linked_record_id
        and counterpart.linked_record_id = records.record_id
    );
  if v_count <> 0 then
    raise exception 'One or more audited turnaround members are no longer reciprocal';
  end if;
end;
$$;

\echo 'REPAIR 04 - assert W25 JX703 orphan and missing JX704'
do $$
declare
  v_count bigint;
begin
  if not exists (
    select 1
    from public.season_flight_records records
    left join public.season_modifications modifications
      on modifications.season_id = records.season_id
     and modifications.leg_id = records.record_id
    where records.season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
      and records.record_id = 'DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q'
      and records.type = 'A'
      and records.flight_number = 'JX703'
      and records.source_kind = 'added'
      and records.status = 'active'
      and records.linked_record_id = 'DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q'
      and records.turnaround_id = 'TRN_MANUAL_JX_703_704_2025_10_31_DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q_DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q'
      and modifications.leg_id is null
  ) then
    raise exception 'Audited W25 JX703 orphan state drifted';
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
    and record_id = 'DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q';
  if v_count <> 0 then
    raise exception 'W25 JX704 counterpart now exists; re-audit instead of clearing metadata';
  end if;
end;
$$;

\echo 'REPAIR 05 - assert exact W26 SQ173 reciprocal route proof'
create temporary table task9_w26_sq173_route_repair on commit drop as
select
  target.season_id,
  target.record_id as target_record_id,
  target.date as target_date,
  target.flight_number as target_flight_number,
  target.raw_flight_number as target_raw_flight_number,
  target.route as target_route,
  target.schedule as target_schedule,
  target.aircraft as target_aircraft,
  target.category as target_category,
  target.flight_series_id as target_flight_series_id,
  target.source_row_index as target_source_row_index,
  target.linked_source_row_index as target_linked_source_row_index,
  target.link_type as target_link_type,
  target.pair_anchor_date as target_pair_anchor_date,
  target.linked_record_id as target_linked_record_id,
  target.turnaround_id as target_turnaround_id,
  counterpart.record_id as counterpart_record_id,
  counterpart.date as counterpart_date,
  counterpart.type as counterpart_type,
  counterpart.airline as counterpart_airline,
  counterpart.flight_number as counterpart_flight_number,
  counterpart.raw_flight_number as counterpart_raw_flight_number,
  counterpart.route as counterpart_route,
  counterpart.schedule as counterpart_schedule,
  counterpart.aircraft as counterpart_aircraft,
  counterpart.category as counterpart_category,
  counterpart.flight_series_id as counterpart_flight_series_id,
  counterpart.source_kind as counterpart_source_kind,
  counterpart.status as counterpart_status,
  counterpart.action as counterpart_action,
  counterpart.source_row_index as counterpart_source_row_index,
  counterpart.linked_source_row_index as counterpart_linked_source_row_index,
  counterpart.link_type as counterpart_link_type,
  counterpart.pair_anchor_date as counterpart_pair_anchor_date,
  counterpart.linked_record_id as counterpart_linked_record_id,
  counterpart.turnaround_id as counterpart_turnaround_id,
  (
    select pg_catalog.count(*)
    from public.season_flight_records inbound
    where inbound.season_id = target.season_id
      and inbound.source_kind = 'imported'
      and inbound.status = 'active'
      and inbound.action is distinct from 'deleted'
      and inbound.linked_record_id = counterpart.record_id
  ) as target_to_counterpart_reference_count,
  (
    select pg_catalog.count(*)
    from public.season_flight_records inbound
    where inbound.season_id = target.season_id
      and inbound.source_kind = 'imported'
      and inbound.status = 'active'
      and inbound.action is distinct from 'deleted'
      and inbound.linked_record_id = target.record_id
  ) as counterpart_to_target_reference_count,
  (
    select pg_catalog.count(*)
    from public.season_flight_records members
    where members.season_id = target.season_id
      and members.source_kind = 'imported'
      and members.status = 'active'
      and members.action is distinct from 'deleted'
      and members.turnaround_id = target.turnaround_id
  ) as turnaround_member_count
from public.seasons seasons
join public.season_flight_records target on target.season_id = seasons.id
left join public.season_flight_records counterpart
  on counterpart.season_id = target.season_id
 and counterpart.record_id = target.linked_record_id
where seasons.id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
  and seasons.season_code = 'W26'
  and target.source_kind = 'imported'
  and target.status = 'active'
  and target.action is null
  and target.type = 'D'
  and public.seasonal_occurrence_airline_v2(target.airline) = 'SQ'
  and public.seasonal_occurrence_flight_number_v2(
    target.airline,
    target.flight_number,
    target.raw_flight_number
  ) = 'SQ173'
  and pg_catalog.btrim(target.route) = '';

do $$
declare
  v_count bigint;
  v_hash text;
  v_min_date text;
  v_max_date text;
begin
  select
    pg_catalog.count(*),
    pg_catalog.min(proof.target_date),
    pg_catalog.max(proof.target_date),
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(
      pg_catalog.concat_ws(chr(31),
        proof.target_record_id,
        proof.target_date,
        proof.target_flight_number,
        proof.target_raw_flight_number,
        proof.target_route,
        proof.target_schedule,
        proof.target_aircraft,
        proof.target_category,
        proof.target_source_row_index,
        proof.target_linked_source_row_index,
        proof.target_link_type,
        proof.target_pair_anchor_date,
        proof.target_linked_record_id,
        proof.target_turnaround_id,
        proof.counterpart_record_id,
        proof.counterpart_date,
        proof.counterpart_flight_number,
        proof.counterpart_raw_flight_number,
        proof.counterpart_route,
        proof.counterpart_schedule,
        proof.counterpart_aircraft,
        proof.counterpart_category,
        proof.counterpart_source_row_index,
        proof.counterpart_linked_source_row_index,
        proof.counterpart_link_type,
        proof.counterpart_pair_anchor_date,
        proof.counterpart_linked_record_id,
        proof.counterpart_turnaround_id
      ),
      chr(30) order by proof.target_record_id
    ), 'UTF8')), 'hex')
  into v_count, v_min_date, v_max_date, v_hash
  from task9_w26_sq173_route_repair proof;

  if v_count <> 154
    or v_min_date <> '2026-10-25'
    or v_max_date <> '2027-03-27'
    or (select pg_catalog.count(distinct target_date)
        from task9_w26_sq173_route_repair) <> 154
    or (v_max_date::date - v_min_date::date + 1) <> 154
  then
    raise exception 'Expected 154 continuous W26 SQ173 targets from 2026-10-25 through 2027-03-27, found % over %..%',
      v_count, v_min_date, v_max_date;
  end if;

  if v_hash is distinct from 'cf04250dc6f37a3a6a85075f71d39a847f3d58d7f34b2091dad4153c3b10bf5e' then
    raise exception 'W26 SQ173 exact reciprocal pair set drifted: %', v_hash;
  end if;

  if exists (
    select 1
    from task9_w26_sq173_route_repair proof
    where proof.counterpart_record_id is null
      or proof.counterpart_type is distinct from 'A'
      or proof.counterpart_airline is distinct from 'SQ'
      or proof.counterpart_flight_number is distinct from 'SQ174'
      or proof.counterpart_source_kind is distinct from 'imported'
      or proof.counterpart_status is distinct from 'active'
      or proof.counterpart_action is not null
      or proof.target_flight_series_id is distinct from 'SER_D_SQ_SQ173_NONE'
      or proof.counterpart_flight_series_id is distinct from 'SER_A_SQ_SQ174_SIN'
      or proof.target_linked_record_id is distinct from proof.counterpart_record_id
      or proof.counterpart_linked_record_id is distinct from proof.target_record_id
      or proof.target_to_counterpart_reference_count <> 1
      or proof.counterpart_to_target_reference_count <> 1
      or proof.target_turnaround_id is null
      or proof.counterpart_turnaround_id is distinct from proof.target_turnaround_id
      or proof.turnaround_member_count <> 2
      or proof.counterpart_date is distinct from proof.target_date
      or proof.target_pair_anchor_date is distinct from proof.target_date
      or proof.counterpart_pair_anchor_date is distinct from proof.target_date
      or proof.target_link_type is distinct from 'sameday'
      or proof.counterpart_link_type is distinct from 'sameday'
      or proof.target_source_row_index is distinct from proof.counterpart_source_row_index
      or proof.target_linked_source_row_index is distinct from proof.counterpart_source_row_index
      or proof.counterpart_linked_source_row_index is distinct from proof.target_source_row_index
      or pg_catalog.btrim(proof.counterpart_route) is distinct from 'SIN'
  ) then
    raise exception 'W26 SQ173 reciprocal SQ174 topology or route proof failed';
  end if;

  if (select pg_catalog.count(distinct counterpart_record_id)
      from task9_w26_sq173_route_repair) <> 154
    or (select pg_catalog.count(distinct target_turnaround_id)
        from task9_w26_sq173_route_repair) <> 154
    or exists (
      select 1 from task9_w26_sq173_route_repair
      group by target_date having pg_catalog.count(*) <> 1
    )
  then
    raise exception 'W26 SQ173 reciprocal mapping is ambiguous';
  end if;

  select pg_catalog.count(*) into v_count
  from public.season_modifications modifications
  join task9_w26_sq173_route_repair proof
    on proof.season_id = modifications.season_id
   and proof.target_record_id = modifications.leg_id;
  if v_count <> 5 then
    raise exception 'Expected 5 W26 SQ173 non-route modifications, found %', v_count;
  end if;

  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
    pg_catalog.string_agg(
      pg_catalog.md5(pg_catalog.to_jsonb(modifications)::text),
      '' order by modifications.leg_id
    ), ''
  ), 'UTF8')), 'hex')
  into v_hash
  from public.season_modifications modifications
  join task9_w26_sq173_route_repair proof
    on proof.season_id = modifications.season_id
   and proof.target_record_id = modifications.leg_id;
  if v_hash is distinct from 'b44046f3a7a4e0fd202a7658d0d6240e1deea4e478a83f195d219a7c1df624f6' then
    raise exception 'W26 SQ173 modification set drifted: %', v_hash;
  end if;

  if exists (
    select 1
    from public.season_modifications modifications
    join task9_w26_sq173_route_repair proof
      on proof.season_id = modifications.season_id
     and modifications.leg_id in (proof.target_record_id, proof.counterpart_record_id)
    where 'route' = any(coalesce(modifications.changed_fields, '{}'::text[]))
       or modifications.route is not null
  ) then
    raise exception 'W26 SQ173/SQ174 route modification conflict exists';
  end if;

  select pg_catalog.count(*) into v_count
  from public.season_modification_counters counters
  join task9_w26_sq173_route_repair proof on proof.target_record_id = counters.leg_id;
  if v_count <> 23 then
    raise exception 'Expected 23 W26 SQ173 modification-counter rows, found %', v_count;
  end if;

  select
    (select pg_catalog.count(*)
      from public.season_flight_record_counters child
      join task9_w26_sq173_route_repair proof
        on child.record_id in (proof.target_record_id, proof.counterpart_record_id))
    + (select pg_catalog.count(*)
      from public.season_flight_record_checkin_windows child
      join task9_w26_sq173_route_repair proof
        on child.record_id in (proof.target_record_id, proof.counterpart_record_id))
    + (select pg_catalog.count(*)
      from public.season_modification_checkin_windows child
      join task9_w26_sq173_route_repair proof
        on child.leg_id in (proof.target_record_id, proof.counterpart_record_id))
    + (select pg_catalog.count(*)
      from public.season_modification_added_legs child
      join task9_w26_sq173_route_repair proof
        on child.season_id = proof.season_id
       and child.leg_id in (proof.target_record_id, proof.counterpart_record_id))
  into v_count;
  if v_count <> 0 then
    raise exception 'Unexpected W26 SQ173/SQ174 related child rows found: %', v_count;
  end if;

  if exists (
    select 1
    from public.season_flight_records other
    join task9_w26_sq173_route_repair proof
      on proof.season_id = other.season_id
     and proof.target_date = other.date
    where other.record_id <> proof.target_record_id
      and other.status = 'active'
      and other.action is distinct from 'deleted'
      and other.type = 'D'
      and public.seasonal_occurrence_airline_v2(other.airline) = 'SQ'
      and public.seasonal_occurrence_flight_number_v2(
        other.airline,
        other.flight_number,
        other.raw_flight_number
      ) = 'SQ173'
  ) or exists (
    select 1
    from public.season_modification_added_legs added
    join public.season_modifications parent
      on parent.season_id = added.season_id
     and parent.leg_id = added.leg_id
    join task9_w26_sq173_route_repair proof
      on proof.season_id = added.season_id
     and proof.target_date = added.date
    where parent.action = 'added'
      and 'addedLeg' = any(coalesce(parent.changed_fields, '{}'::text[]))
      and added.status = 'active'
      and added.action = 'added'
      and added.type = 'D'
      and public.seasonal_occurrence_airline_v2(added.airline) = 'SQ'
      and public.seasonal_occurrence_flight_number_v2(
        added.airline,
        added.flight_number,
        added.raw_flight_number
      ) = 'SQ173'
  ) then
    raise exception 'W26 SQ173 occurrence ambiguity exists';
  end if;
end;
$$;

-- Capture the effective PR identity before removing the already-hidden rows.
create temporary table task9_repair_metrics (
  metric text primary key,
  value text not null
) on commit drop;

insert into task9_repair_metrics(metric, value)
select
  's26_pr585_pr586_effective_hash',
  pg_catalog.md5(pg_catalog.string_agg(
    pg_catalog.concat_ws('|',
      records.record_id,
      records.type,
      records.date,
      records.airline,
      records.flight_number,
      records.route,
      records.schedule,
      records.aircraft,
      records.linked_record_id,
      records.turnaround_id
    ),
    '||' order by records.record_id
  ))
from public.season_flight_records records
left join public.season_modifications modifications
  on modifications.season_id = records.season_id
 and modifications.leg_id = records.record_id
where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  and records.date = '2026-06-10'
  and records.flight_number in ('PR585', 'PR586')
  and records.status = 'active'
  and records.action is distinct from 'deleted'
  and modifications.action is distinct from 'deleted';

\echo 'REPAIR 06 - create timestamped maintenance backups'
create schema if not exists maintenance;

do $$
declare
  v_tag text := pg_catalog.lower(pg_catalog.to_char(
    pg_catalog.transaction_timestamp() at time zone 'UTC',
    'YYYYMMDD"t"HH24MISS"z"'
  ));
  v_affected_ids text[] := array[
    'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
    'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321',
    'LEG_A_2026-08-23_943_HX_HX542_HKG_03_00_320',
    'LEG_D_2026-08-23_943_HX_HX543_HKG_04_00_320',
    'F_NEW_1784417194491_ojlo5j_1',
    'F_NEW_1784417194491_ojlo5j_2',
    'F_NEW_1784417194495_2zf5s7_1',
    'F_NEW_1784417194495_2zf5s7_2',
    'LEG_A_2026-07-19_618_RF_RF531_CJJ_23_55_320',
    'LEG_D_2026-07-19_619_RF_RF532_CJJ_00_55_320',
    'F_NEW_1783648329496_a90ngi_1',
    'F_NEW_1783648329496_a90ngi_2',
    'DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q'
  ];
  v_route_ids text[];
  v_name text;
  v_count bigint;
begin
  perform pg_catalog.set_config('seasonal.repair_backup_tag', v_tag, true);

  select pg_catalog.array_agg(related.record_id order by related.record_id)
  into v_route_ids
  from (
    select proof.target_record_id as record_id
    from task9_w26_sq173_route_repair proof
    union
    select proof.counterpart_record_id
    from task9_w26_sq173_route_repair proof
  ) related;
  if pg_catalog.array_length(v_route_ids, 1) <> 308 then
    raise exception 'W26 SQ173/SQ174 backup ID set expected 308 rows, found %',
      pg_catalog.array_length(v_route_ids, 1);
  end if;
  v_affected_ids := v_affected_ids || v_route_ids;
  if pg_catalog.array_length(v_affected_ids, 1) <> 321 then
    raise exception 'Combined backup ID set expected 321 rows, found %',
      pg_catalog.array_length(v_affected_ids, 1);
  end if;

  v_name := 'seasonal_fix_' || v_tag || '_seasons';
  execute pg_catalog.format(
    'create table maintenance.%I as select seasons.*, transaction_timestamp() as backed_up_at from public.seasons seasons where seasons.id = any($1)',
    v_name
  ) using array[
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'season-f77c5ea9-be54-4615-ab0a-d83062b9b854',
    'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
  ];
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 3 then raise exception 'Season backup expected 3 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_records';
  execute pg_catalog.format(
    'create table maintenance.%I as select records.*, transaction_timestamp() as backed_up_at from public.season_flight_records records where records.record_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 321 then raise exception 'Record backup expected 321 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_record_counters';
  execute pg_catalog.format(
    'create table maintenance.%I as select child.*, transaction_timestamp() as backed_up_at from public.season_flight_record_counters child where child.record_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 0 then raise exception 'Record-counter backup expected 0 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_record_windows';
  execute pg_catalog.format(
    'create table maintenance.%I as select child.*, transaction_timestamp() as backed_up_at from public.season_flight_record_checkin_windows child where child.record_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 0 then raise exception 'Record-window backup expected 0 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_modifications';
  execute pg_catalog.format(
    'create table maintenance.%I as select modifications.*, transaction_timestamp() as backed_up_at from public.season_modifications modifications where modifications.leg_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 9 then raise exception 'Modification backup expected 9 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_mod_counters';
  execute pg_catalog.format(
    'create table maintenance.%I as select child.*, transaction_timestamp() as backed_up_at from public.season_modification_counters child where child.leg_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 23 then raise exception 'Modification-counter backup expected 23 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_mod_windows';
  execute pg_catalog.format(
    'create table maintenance.%I as select child.*, transaction_timestamp() as backed_up_at from public.season_modification_checkin_windows child where child.leg_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 0 then raise exception 'Modification-window backup expected 0 rows, found %', v_count; end if;

  v_name := 'seasonal_fix_' || v_tag || '_added_legs';
  execute pg_catalog.format(
    'create table maintenance.%I as select child.*, transaction_timestamp() as backed_up_at from public.season_modification_added_legs child where child.leg_id = any($1)',
    v_name
  ) using v_affected_ids;
  execute pg_catalog.format('select count(*) from maintenance.%I', v_name) into v_count;
  if v_count <> 0 then raise exception 'Added-leg backup expected 0 rows, found %', v_count; end if;
end;
$$;

select
  current_setting('seasonal.repair_backup_tag') as backup_tag,
  'maintenance.seasonal_fix_' || current_setting('seasonal.repair_backup_tag') || '_*' as backup_name_pattern;

\echo 'REPAIR 07 - remove only hidden S26 duplicate rows and overlays'
do $$
declare
  v_count bigint;
begin
  delete from public.season_modifications
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and leg_id in (
      'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
      'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
    )
    and action = 'deleted'
    and changed_fields = '{}'::text[];
  get diagnostics v_count = row_count;
  if v_count <> 2 then raise exception 'Expected to delete 2 hidden PR overlays, deleted %', v_count; end if;

  delete from public.season_flight_records
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and record_id in (
      'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
      'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
    )
    and source_kind = 'imported'
    and status = 'active'
    and action is null;
  get diagnostics v_count = row_count;
  if v_count <> 2 then raise exception 'Expected to delete 2 hidden PR records, deleted %', v_count; end if;
end;
$$;

\echo 'REPAIR 08 - split S26 turnaround groups by verified reciprocal IDs'
do $$
declare
  v_count bigint;
begin
  update public.season_flight_records records
  set turnaround_id = mapping.new_turnaround_id
  from (values
    ('LEG_A_2026-08-23_943_HX_HX542_HKG_03_00_320'::text, 'TRN_V2_2026-08-24_HX542_HX543_LEG'::text),
    ('LEG_D_2026-08-23_943_HX_HX543_HKG_04_00_320', 'TRN_V2_2026-08-24_HX542_HX543_LEG'),
    ('F_NEW_1784417194491_ojlo5j_1', 'TRN_V2_2026-09-02_HX542_HX543_FNEW1784417194491'),
    ('F_NEW_1784417194491_ojlo5j_2', 'TRN_V2_2026-09-02_HX542_HX543_FNEW1784417194491'),
    ('F_NEW_1784417194495_2zf5s7_1', 'TRN_V2_2026-09-18_HX542_HX543_FNEW1784417194495'),
    ('F_NEW_1784417194495_2zf5s7_2', 'TRN_V2_2026-09-18_HX542_HX543_FNEW1784417194495'),
    ('LEG_A_2026-07-19_618_RF_RF531_CJJ_23_55_320', 'TRN_V2_2026-07-19_RF531_RF532_LEG'),
    ('LEG_D_2026-07-19_619_RF_RF532_CJJ_00_55_320', 'TRN_V2_2026-07-19_RF531_RF532_LEG'),
    ('F_NEW_1783648329496_a90ngi_1', 'TRN_V2_2026-07-20_RF531_RF532_FNEW1783648329496'),
    ('F_NEW_1783648329496_a90ngi_2', 'TRN_V2_2026-07-20_RF531_RF532_FNEW1783648329496')
  ) mapping(record_id, new_turnaround_id)
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and records.record_id = mapping.record_id;
  get diagnostics v_count = row_count;
  if v_count <> 10 then raise exception 'Expected to split 10 turnaround members, updated %', v_count; end if;
end;
$$;

\echo 'REPAIR 09 - clear only verified orphan JX703 pair pointers'
do $$
declare
  v_count bigint;
begin
  update public.season_flight_records
  set linked_record_id = null,
      turnaround_id = null
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
    and record_id = 'DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q'
    and linked_record_id = 'DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q'
    and turnaround_id = 'TRN_MANUAL_JX_703_704_2025_10_31_DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q_DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q';
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'Expected to clear one JX703 orphan, updated %', v_count; end if;
end;
$$;

\echo 'REPAIR 10 - fill verified W26 SQ173 routes and route-derived series IDs'
do $$
declare
  v_count bigint;
begin
  update public.season_flight_records target
  set
    route = proof.counterpart_route,
    flight_series_id = 'SER_'
      || pg_catalog.regexp_replace(target.type, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(target.airline, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(target.flight_number, '[^A-Z0-9]+', '_', 'g')
      || '_'
      || pg_catalog.regexp_replace(proof.counterpart_route, '[^A-Z0-9]+', '_', 'g')
  from task9_w26_sq173_route_repair proof
  where target.season_id = proof.season_id
    and target.record_id = proof.target_record_id
    and target.route = proof.target_route
    and pg_catalog.btrim(target.route) = ''
    and target.flight_series_id = proof.target_flight_series_id
    and target.linked_record_id = proof.counterpart_record_id
    and target.turnaround_id = proof.target_turnaround_id
    and proof.counterpart_route = 'SIN';
  get diagnostics v_count = row_count;
  if v_count <> 154 then
    raise exception 'Expected to fill exactly 154 W26 SQ173 routes, updated %', v_count;
  end if;
end;
$$;

-- Bump only seasons whose committed server state would change. total_legs is
-- retained: the deleted PR rows were already excluded from effective output.
update public.seasons
set data_version = data_version + 1,
    last_synced_at = (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint
where id in (
  'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'season-f77c5ea9-be54-4615-ab0a-d83062b9b854',
  'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
);

-- This is the actual commit boundary for every deferrable invariant installed
-- by the additive migration. On current predeploy production it can only fire
-- constraints already deployed; Task 12 must rerun after additive deployment.
set constraints all immediate;

-- Production apply is permitted only after the additive Task 12 migration has
-- installed the finalizer. Missing or invalid finalizer state is fail-closed.
do $$
begin
  if pg_catalog.to_regprocedure(
    'public.finalize_seasonal_occurrence_constraints_v2()'
  ) is null then
    raise exception 'Task 12 occurrence finalizer is missing; additive migration is required before repair';
  end if;

  perform public.finalize_seasonal_occurrence_constraints_v2();

  if pg_catalog.to_regclass(
      'public.season_flight_records_active_imported_occurrence_v2_key'
    ) is null
    or not exists (
      select 1
      from pg_catalog.pg_index indexes
      where indexes.indexrelid = pg_catalog.to_regclass(
        'public.season_flight_records_active_imported_occurrence_v2_key'
      )
        and indexes.indisunique
        and indexes.indisvalid
        and indexes.indisready
    )
  then
    raise exception 'Task 12 occurrence finalizer did not create a valid ready unique index';
  end if;
end;
$$;

\echo 'REPAIR 11 - verify repaired state inside transaction'
do $$
declare
  v_count bigint;
  v_hash text;
  v_blocker_summary text;
begin
  select count(*) into v_count
  from public.season_flight_records
  where record_id in (
    'LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321',
    'LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321'
  );
  if v_count <> 0 then raise exception 'Discarded PR duplicate rows remain: %', v_count; end if;

  select pg_catalog.md5(pg_catalog.string_agg(
    pg_catalog.concat_ws('|',
      records.record_id,
      records.type,
      records.date,
      records.airline,
      records.flight_number,
      records.route,
      records.schedule,
      records.aircraft,
      records.linked_record_id,
      records.turnaround_id
    ),
    '||' order by records.record_id
  ))
  into v_hash
  from public.season_flight_records records
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where records.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and records.date = '2026-06-10'
    and records.flight_number in ('PR585', 'PR586')
    and records.status = 'active'
    and records.action is distinct from 'deleted'
    and modifications.action is distinct from 'deleted';

  if v_hash is distinct from (
    select value from task9_repair_metrics
    where metric = 's26_pr585_pr586_effective_hash'
  ) then
    raise exception 'Effective PR585/PR586 output changed while removing hidden duplicates';
  end if;

  select pg_catalog.count(*) into v_count
  from public.season_flight_records target
  join task9_w26_sq173_route_repair proof
    on proof.season_id = target.season_id
   and proof.target_record_id = target.record_id
  join public.season_flight_records counterpart
    on counterpart.season_id = proof.season_id
   and counterpart.record_id = proof.counterpart_record_id
  where target.source_kind = 'imported'
    and target.status = 'active'
    and target.action is null
    and target.type = 'D'
    and target.route = 'SIN'
    and target.flight_series_id = 'SER_D_SQ_SQ173_SIN'
    and target.route = counterpart.route
    and target.linked_record_id = counterpart.record_id
    and counterpart.linked_record_id = target.record_id
    and target.turnaround_id = counterpart.turnaround_id
    and target.turnaround_id = proof.target_turnaround_id
    and target.date = counterpart.date
    and target.date = proof.target_date
    and target.pair_anchor_date = counterpart.pair_anchor_date
    and target.pair_anchor_date = target.date
    and target.link_type = 'sameday'
    and counterpart.link_type = 'sameday';
  if v_count <> 154 then
    raise exception 'Expected 154 repaired reciprocal W26 SQ173/SQ174 pairs, found %', v_count;
  end if;

  if exists (
    select 1
    from public.season_modifications modifications
    join task9_w26_sq173_route_repair proof
      on proof.season_id = modifications.season_id
     and modifications.leg_id in (proof.target_record_id, proof.counterpart_record_id)
    where 'route' = any(coalesce(modifications.changed_fields, '{}'::text[]))
       or modifications.route is not null
  ) then
    raise exception 'W26 SQ173/SQ174 route modification conflict appeared during repair';
  end if;

  with
  base_prepared as (
    select
      records.*,
      records.date as occurrence_date,
      pg_catalog.upper(pg_catalog.btrim(records.airline)) as normalized_airline,
      pg_catalog.upper(pg_catalog.btrim(
        coalesce(
          nullif(pg_catalog.btrim(records.flight_number), ''),
          pg_catalog.btrim(records.raw_flight_number)
        )
      )) as normalized_input
    from public.season_flight_records records
  ),
  base_parts as (
    select
      base_prepared.*,
      case
        when normalized_airline <> ''
          and pg_catalog.char_length(normalized_input) > pg_catalog.char_length(normalized_airline)
          and pg_catalog.left(normalized_input, pg_catalog.char_length(normalized_airline)) = normalized_airline
          then pg_catalog.substr(normalized_input, pg_catalog.char_length(normalized_airline) + 1)
        else normalized_input
      end as normalized_flight_part
    from base_prepared
  ),
  base_records as (
    select
      base_parts.*,
      normalized_airline || case
        when normalized_flight_part ~ '^[0-9]+$'
          and pg_catalog.char_length(normalized_flight_part) < 3
          then pg_catalog.repeat('0', 3 - pg_catalog.char_length(normalized_flight_part))
            || normalized_flight_part
        else normalized_flight_part
      end as canonical_flight_number
    from base_parts
  ),
  added_prepared as (
    select
      added_legs.*,
      modifications.action as parent_action,
      modifications.changed_fields as parent_changed_fields,
      added_legs.date as occurrence_date,
      pg_catalog.upper(pg_catalog.btrim(added_legs.airline)) as normalized_airline,
      pg_catalog.upper(pg_catalog.btrim(
        coalesce(
          nullif(pg_catalog.btrim(added_legs.flight_number), ''),
          pg_catalog.btrim(added_legs.raw_flight_number)
        )
      )) as normalized_input
    from public.season_modification_added_legs added_legs
    left join public.season_modifications modifications
      on modifications.season_id = added_legs.season_id
     and modifications.leg_id = added_legs.leg_id
  ),
  added_parts as (
    select
      added_prepared.*,
      case
        when normalized_airline <> ''
          and pg_catalog.char_length(normalized_input) > pg_catalog.char_length(normalized_airline)
          and pg_catalog.left(normalized_input, pg_catalog.char_length(normalized_airline)) = normalized_airline
          then pg_catalog.substr(normalized_input, pg_catalog.char_length(normalized_airline) + 1)
        else normalized_input
      end as normalized_flight_part
    from added_prepared
  ),
  added_records as (
    select
      added_parts.*,
      normalized_airline || case
        when normalized_flight_part ~ '^[0-9]+$'
          and pg_catalog.char_length(normalized_flight_part) < 3
          then pg_catalog.repeat('0', 3 - pg_catalog.char_length(normalized_flight_part))
            || normalized_flight_part
        else normalized_flight_part
      end as canonical_flight_number
    from added_parts
  ),
  effective_added_records as (
    select added.*
    from added_records added
    where added.parent_action = 'added'
      and 'addedLeg' = any(coalesce(added.parent_changed_fields, '{}'::text[]))
      and added.leg_id = added.record_id
      and added.action = 'added'
      and added.source_kind = 'added'
      and added.status = 'active'
      and added.source_side = case when added.type = 'A' then 'ARR' else 'DEP' end
  ),
  effective_records as (
    select
      base.season_id,
      base.record_id,
      base.type,
      base.occurrence_date,
      base.normalized_airline as airline,
      base.canonical_flight_number as flight_number,
      base.linked_record_id,
      base.turnaround_id
    from base_records base
    left join public.season_modifications modifications
      on modifications.season_id = base.season_id
     and modifications.leg_id = base.record_id
    where base.status = 'active'
      and base.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'

    union all

    select
      added.season_id,
      added.record_id,
      added.type,
      added.occurrence_date,
      added.normalized_airline,
      added.canonical_flight_number,
      added.linked_record_id,
      added.turnaround_id
    from effective_added_records added
  ),
  blocking_findings as (
    select
      'duplicate-imported-base-occurrence'::text as category,
      duplicates.season_id || '|' || duplicates.occurrence_date || '|'
        || duplicates.airline || '|' || duplicates.flight_number as finding_key
    from (
      select
        base.season_id,
        base.occurrence_date,
        base.normalized_airline as airline,
        base.canonical_flight_number as flight_number
      from base_records base
      where base.source_kind = 'imported'
        and base.status = 'active'
        and base.action is distinct from 'deleted'
        and nullif(base.occurrence_date, '') is not null
        and nullif(base.canonical_flight_number, '') is not null
      group by
        base.season_id,
        base.occurrence_date,
        base.normalized_airline,
        base.canonical_flight_number
      having pg_catalog.count(*) > 1
    ) duplicates

    union all

    select
      'active-imported-required-route-empty',
      base.season_id || '|' || base.record_id
    from base_records base
    where base.source_kind = 'imported'
      and base.status = 'active'
      and base.action is distinct from 'deleted'
      and base.type in ('A', 'D')
      and nullif(pg_catalog.btrim(base.route), '') is null

    union all

    select
      'duplicate-effective-occurrence',
      duplicates.season_id || '|' || duplicates.occurrence_date || '|'
        || duplicates.airline || '|' || duplicates.flight_number
    from (
      select
        effective.season_id,
        effective.occurrence_date,
        effective.airline,
        effective.flight_number
      from effective_records effective
      where nullif(effective.occurrence_date, '') is not null
        and nullif(effective.flight_number, '') is not null
      group by
        effective.season_id,
        effective.occurrence_date,
        effective.airline,
        effective.flight_number
      having pg_catalog.count(*) > 1
    ) duplicates

    union all

    select
      'effective-orphan-link',
      effective.season_id || '|' || effective.record_id
    from effective_records effective
    left join effective_records counterpart
      on counterpart.season_id = effective.season_id
     and counterpart.record_id = effective.linked_record_id
    where nullif(pg_catalog.btrim(effective.linked_record_id), '') is not null
      and counterpart.record_id is null

    union all

    select
      'effective-nonreciprocal-link',
      effective.season_id || '|' || effective.record_id
    from effective_records effective
    join effective_records counterpart
      on counterpart.season_id = effective.season_id
     and counterpart.record_id = effective.linked_record_id
    where nullif(pg_catalog.btrim(effective.linked_record_id), '') is not null
      and counterpart.linked_record_id is distinct from effective.record_id

    union all

    select
      'invalid-effective-turnaround',
      invalid.season_id || '|' || invalid.turnaround_id
    from (
      select effective.season_id, effective.turnaround_id
      from effective_records effective
      where nullif(pg_catalog.btrim(effective.turnaround_id), '') is not null
      group by effective.season_id, effective.turnaround_id
      having pg_catalog.count(*) <> 2
    ) invalid

    union all

    select
      'orphan-modification',
      modifications.season_id || '|' || modifications.leg_id
    from public.season_modifications modifications
    left join public.season_flight_records base
      on base.season_id = modifications.season_id
     and base.record_id = modifications.leg_id
    left join public.season_modification_added_legs added
      on added.season_id = modifications.season_id
     and added.leg_id = modifications.leg_id
    where base.record_id is null and added.leg_id is null

    union all

    select
      'added-relation-anomaly',
      coalesce(modifications.season_id, added.season_id) || '|'
        || coalesce(modifications.leg_id, added.leg_id)
    from public.season_modifications modifications
    full join public.season_modification_added_legs added
      on added.season_id = modifications.season_id
     and added.leg_id = modifications.leg_id
    where modifications.leg_id is null
       or (modifications.action = 'added' and added.leg_id is null)
       or (modifications.action <> 'added' and added.leg_id is not null)
       or (added.leg_id is not null and added.leg_id is distinct from added.record_id)
       or (added.leg_id is not null and added.action is distinct from 'added')
       or (added.leg_id is not null and added.source_kind is distinct from 'added')
       or (added.leg_id is not null and added.status is distinct from 'active')
       or (added.leg_id is not null and added.source_side is distinct from
         case when added.type = 'A' then 'ARR' else 'DEP' end)
       or (
         added.leg_id is not null
         and not ('addedLeg' = any(coalesce(modifications.changed_fields, '{}'::text[])))
       )

    union all

    select
      'base-added-id-collision',
      base.season_id || '|' || base.record_id
    from public.season_flight_records base
    join public.season_modifications modifications
      on modifications.season_id = base.season_id
     and modifications.action = 'added'
    left join public.season_modification_added_legs added
      on added.season_id = modifications.season_id
     and added.leg_id = modifications.leg_id
    where base.record_id = modifications.leg_id
       or base.record_id = added.record_id

    union all

    select
      'canonical-identity-mismatch-base',
      base.season_id || '|' || base.record_id
    from base_records base
    where base.airline is distinct from base.normalized_airline
       or base.flight_number is distinct from base.canonical_flight_number

    union all

    select
      'canonical-identity-mismatch-added-leg',
      added.season_id || '|' || added.record_id
    from effective_added_records added
    where added.airline is distinct from added.normalized_airline
       or added.flight_number is distinct from added.canonical_flight_number

    union all

    select
      'source-row-generates-no-occurrence',
      source_rows.season_id || '|' || source_rows.row_index::text
    from public.season_source_rows source_rows
    where (
      select pg_catalog.count(*)::bigint
      from pg_catalog.generate_series(
        source_rows.effective::date,
        source_rows.discontinue::date,
        interval '1 day'
      ) occurrence_date
      join public.season_source_row_days days
        on days.season_id = source_rows.season_id
       and days.row_index = source_rows.row_index
       and days.iso_dow = extract(isodow from occurrence_date)::integer
    ) * (
      case when nullif(source_rows.sta, '') is not null
        and nullif(source_rows.arr_flight, '') is not null
        and nullif(source_rows.arr_route, '') is not null then 1 else 0 end
      + case when nullif(source_rows.std, '') is not null
        and nullif(source_rows.dep_flight, '') is not null
        and nullif(source_rows.dep_route, '') is not null then 1 else 0 end
    ) = 0
  ),
  blocker_counts as (
    select blockers.category, pg_catalog.count(*)::bigint as finding_count
    from blocking_findings blockers
    group by blockers.category
  )
  select
    coalesce(pg_catalog.sum(counts.finding_count), 0)::bigint,
    coalesce(pg_catalog.string_agg(
      counts.category || '=' || counts.finding_count,
      ', ' order by counts.category
    ), '<none>')
  into v_count, v_blocker_summary
  from blocker_counts counts;

  if v_count <> 0 then
    raise exception 'Blocking post-repair audit findings remain (%): %',
      v_count, v_blocker_summary;
  end if;

  raise notice 'Post-repair blocking audit categories: 0 (effective added legs included)';

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
    and source_kind = 'added';
  if v_count <> 8165 then
    raise exception 'W25 legacy source_kind changed unexpectedly: % added rows', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
  if v_count <> 26180 then
    raise exception 'Expected 26180 total S26 records after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and source_kind = 'imported'
    and status = 'active'
    and action is distinct from 'deleted';
  if v_count <> 26063 then
    raise exception 'Expected 26063 active imported S26 records after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
  if v_count <> 1424 then
    raise exception 'Expected 1424 S26 modifications after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451';
  if v_count <> 8165 then
    raise exception 'Expected 8165 total W25 records after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451';
  if v_count <> 25 then
    raise exception 'Expected 25 W25 modifications after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854';
  if v_count <> 26641 then
    raise exception 'Expected 26641 total W26 records after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_flight_records
  where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
    and source_kind = 'imported'
    and status = 'active'
    and action is distinct from 'deleted';
  if v_count <> 26598 then
    raise exception 'Expected 26598 active imported W26 records after repair, found %', v_count;
  end if;

  select count(*) into v_count
  from public.season_modifications
  where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854';
  if v_count <> 627 then
    raise exception 'Expected 627 W26 modifications after repair, found %', v_count;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index indexes
    where indexes.indexrelid = pg_catalog.to_regclass(
      'public.season_flight_records_active_imported_occurrence_v2_key'
    )
      and indexes.indisunique
      and indexes.indisvalid
      and indexes.indisready
  ) then
    raise exception 'Expected valid ready active imported occurrence unique index after repair';
  end if;

  if not exists (
    select 1 from public.seasons
    where id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and data_version = 16573
  ) or not exists (
    select 1 from public.seasons
    where id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
      and data_version = 396
  ) or not exists (
    select 1 from public.seasons
    where id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
      and data_version = 8228
  ) then
    raise exception 'Expected repaired S26/W25/W26 data versions were not produced';
  end if;
end;
$$;

select
  (select count(*) from public.season_flight_records
    where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6') as s26_records_after,
  (select count(*) from public.season_modifications
    where season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6') as s26_modifications_after,
  (select count(*) from public.season_flight_records
    where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451') as w25_records_after,
  (select count(*) from public.season_flight_records
    where season_id = 'season-fbe44d36-5c64-4cca-97c3-00a2a6b36451'
      and source_kind = 'added') as w25_legacy_added_after,
  (select count(*) from public.season_flight_records
    where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854') as w26_records_after,
  (select count(*) from public.season_flight_records
    where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
      and source_kind = 'imported'
      and status = 'active'
      and action is null
      and type = 'D'
      and public.seasonal_occurrence_airline_v2(airline) = 'SQ'
      and public.seasonal_occurrence_flight_number_v2(
        airline,
        flight_number,
        raw_flight_number
      ) = 'SQ173'
      and route = 'SIN') as w26_sq173_routes_after,
  (select count(*) from public.season_flight_records
    where season_id = 'season-f77c5ea9-be54-4615-ab0a-d83062b9b854'
      and source_kind = 'imported'
      and status = 'active'
      and action is null
      and type = 'D'
      and public.seasonal_occurrence_airline_v2(airline) = 'SQ'
      and public.seasonal_occurrence_flight_number_v2(
        airline,
        flight_number,
        raw_flight_number
      ) = 'SQ173'
      and flight_series_id = 'SER_D_SQ_SQ173_SIN') as w26_sq173_series_after,
  (select value from task9_repair_metrics
    where metric = 's26_pr585_pr586_effective_hash') as effective_pr_hash_preserved;

-- TASK 9 DRY RUN: keep this as the final executable statement.
rollback;
-- TASK 12 APPLY ONLY, after additive deploy and shadow parity approval:
-- commit;
