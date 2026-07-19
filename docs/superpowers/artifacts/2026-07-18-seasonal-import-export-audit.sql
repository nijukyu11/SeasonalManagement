-- Seasonal import/export production integrity audit.
-- This artifact is intentionally read-only. It must be run with:
--   psql -X -v ON_ERROR_STOP=1 -f 2026-07-18-seasonal-import-export-audit.sql

\pset pager off
\pset null '<null>'
\set ON_ERROR_STOP on

begin transaction isolation level repeatable read read only;
set local statement_timeout = '120s';

\echo 'AUDIT 01 - season inventory'
select
  pg_catalog.now() at time zone 'UTC' as audited_at_utc,
  seasons.season_code,
  seasons.id as season_id,
  seasons.name,
  seasons.file_name,
  seasons.effective_start,
  seasons.effective_end,
  seasons.total_legs,
  seasons.total_source_rows,
  seasons.data_version
from public.seasons seasons
order by seasons.season_code, seasons.id;

\echo 'AUDIT 01B - deterministic season state fingerprints'
select
  seasons.season_code,
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
  )) as state_fingerprint,
  (select pg_catalog.count(*) from public.season_flight_records records
    where records.season_id = seasons.id) as base_record_count,
  (select pg_catalog.count(*) from public.season_modifications modifications
    where modifications.season_id = seasons.id) as modification_count,
  (select pg_catalog.count(*) from public.season_source_rows source_rows
    where source_rows.season_id = seasons.id) as source_row_count,
  (select pg_catalog.count(*) from public.season_modification_added_legs added_legs
    where added_legs.season_id = seasons.id) as added_leg_count
from public.seasons seasons
order by seasons.season_code, seasons.id;

\echo 'AUDIT 02 - counts and blocking findings'
with
base_prepared as (
  select
    seasons.season_code,
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
  join public.seasons seasons on seasons.id = records.season_id
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
    seasons.season_code,
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
  join public.seasons seasons on seasons.id = added_legs.season_id
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
    base.season_code,
    base.season_id,
    base.record_id,
    base.type,
    base.occurrence_date,
    base.normalized_airline as airline,
    base.canonical_flight_number as flight_number,
    case
      when 'schedule' = any(coalesce(modifications.changed_fields, '{}'::text[]))
        then modifications.schedule
      else base.schedule
    end as schedule,
    base.linked_record_id,
    base.turnaround_id,
    base.source_kind,
    base.status
  from base_records base
  left join public.season_modifications modifications
    on modifications.season_id = base.season_id
   and modifications.leg_id = base.record_id
  where base.status = 'active'
    and base.action is distinct from 'deleted'
    and modifications.action is distinct from 'deleted'

  union all

  select
    added.season_code,
    added.season_id,
    added.record_id,
    added.type,
    added.occurrence_date,
    added.normalized_airline,
    added.canonical_flight_number,
    added.schedule,
    added.linked_record_id,
    added.turnaround_id,
    added.source_kind,
    added.status
  from effective_added_records added
),
baseline_counts as (
  select
    base.season_code,
    base.season_id,
    base.source_kind,
    base.status,
    base.action,
    pg_catalog.count(*)::bigint as finding_count,
    (pg_catalog.array_agg(base.record_id order by base.record_id))[1:10] as record_ids
  from base_records base
  group by base.season_code, base.season_id, base.source_kind, base.status, base.action
),
effective_counts as (
  select
    effective.season_code,
    effective.season_id,
    effective.source_kind,
    effective.status,
    pg_catalog.count(*)::bigint as finding_count,
    (pg_catalog.array_agg(effective.record_id order by effective.record_id))[1:10] as record_ids
  from effective_records effective
  group by effective.season_code, effective.season_id, effective.source_kind, effective.status
),
base_duplicates as (
  select
    base.season_code,
    base.season_id,
    base.occurrence_date,
    base.normalized_airline,
    base.canonical_flight_number,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.array_agg(base.record_id order by base.record_id) as record_ids,
    pg_catalog.string_agg(
      base.record_id || ':' || base.source_kind || ':' || base.status || ':'
        || coalesce(base.action, 'null') || ':mod=' || coalesce(modifications.action, 'null'),
      ', ' order by base.record_id
    ) as state_label
  from base_records base
  left join public.season_modifications modifications
    on modifications.season_id = base.season_id
   and modifications.leg_id = base.record_id
  where nullif(base.occurrence_date, '') is not null
    and nullif(base.canonical_flight_number, '') is not null
  group by
    base.season_code,
    base.season_id,
    base.occurrence_date,
    base.normalized_airline,
    base.canonical_flight_number
  having pg_catalog.count(*) > 1
),
active_imported_duplicates as (
  select
    base.season_code,
    base.season_id,
    base.occurrence_date,
    base.normalized_airline,
    base.canonical_flight_number,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.array_agg(base.record_id order by base.record_id) as record_ids
  from base_records base
  where base.source_kind = 'imported'
    and base.status = 'active'
    and base.action is distinct from 'deleted'
    and nullif(base.occurrence_date, '') is not null
    and nullif(base.canonical_flight_number, '') is not null
  group by
    base.season_code,
    base.season_id,
    base.occurrence_date,
    base.normalized_airline,
    base.canonical_flight_number
  having pg_catalog.count(*) > 1
),
active_imported_required_route_empty as (
  select
    base.season_code,
    base.season_id,
    base.type,
    base.normalized_airline,
    base.canonical_flight_number,
    pg_catalog.count(*)::bigint as finding_count,
    (pg_catalog.array_agg(base.record_id order by base.record_id))[1:10] as record_ids,
    pg_catalog.min(base.occurrence_date) as min_date,
    pg_catalog.max(base.occurrence_date) as max_date
  from base_records base
  where base.source_kind = 'imported'
    and base.status = 'active'
    and base.action is distinct from 'deleted'
    and base.type in ('A', 'D')
    and nullif(pg_catalog.btrim(base.route), '') is null
  group by
    base.season_code,
    base.season_id,
    base.type,
    base.normalized_airline,
    base.canonical_flight_number
),
effective_duplicates as (
  select
    effective.season_code,
    effective.season_id,
    effective.occurrence_date,
    effective.airline,
    effective.flight_number,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.array_agg(effective.record_id order by effective.record_id) as record_ids
  from effective_records effective
  where nullif(effective.occurrence_date, '') is not null
    and nullif(effective.flight_number, '') is not null
  group by
    effective.season_code,
    effective.season_id,
    effective.occurrence_date,
    effective.airline,
    effective.flight_number
  having pg_catalog.count(*) > 1
),
orphan_links as (
  select
    effective.season_code,
    effective.season_id,
    effective.record_id,
    effective.linked_record_id,
    effective.occurrence_date,
    effective.flight_number
  from effective_records effective
  left join effective_records counterpart
    on counterpart.season_id = effective.season_id
   and counterpart.record_id = effective.linked_record_id
  where nullif(pg_catalog.btrim(effective.linked_record_id), '') is not null
    and counterpart.record_id is null
),
nonreciprocal_links as (
  select
    effective.season_code,
    effective.season_id,
    effective.record_id,
    effective.linked_record_id,
    counterpart.linked_record_id as counterpart_linked_record_id,
    effective.occurrence_date,
    effective.flight_number,
    counterpart.flight_number as counterpart_flight_number
  from effective_records effective
  join effective_records counterpart
    on counterpart.season_id = effective.season_id
   and counterpart.record_id = effective.linked_record_id
  where nullif(pg_catalog.btrim(effective.linked_record_id), '') is not null
    and counterpart.linked_record_id is distinct from effective.record_id
),
invalid_turnarounds as (
  select
    effective.season_code,
    effective.season_id,
    effective.turnaround_id,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.array_agg(effective.record_id order by effective.record_id) as record_ids,
    pg_catalog.string_agg(
      effective.occurrence_date || ' ' || effective.flight_number,
      ', ' order by effective.occurrence_date, effective.flight_number, effective.record_id
    ) as flight_label
  from effective_records effective
  where nullif(pg_catalog.btrim(effective.turnaround_id), '') is not null
  group by effective.season_code, effective.season_id, effective.turnaround_id
  having pg_catalog.count(*) <> 2
),
orphan_modifications as (
  select
    seasons.season_code,
    modifications.season_id,
    modifications.leg_id,
    modifications.action
  from public.season_modifications modifications
  join public.seasons seasons on seasons.id = modifications.season_id
  left join public.season_flight_records base
    on base.season_id = modifications.season_id
   and base.record_id = modifications.leg_id
  left join public.season_modification_added_legs added
    on added.season_id = modifications.season_id
   and added.leg_id = modifications.leg_id
  where base.record_id is null and added.leg_id is null
),
added_relation_anomalies as (
  select
    seasons.season_code,
    coalesce(modifications.season_id, added.season_id) as season_id,
    coalesce(modifications.leg_id, added.leg_id) as leg_id,
    modifications.action,
    added.record_id,
    case
      when modifications.leg_id is null then 'child-parent-identity-mismatch'
      when modifications.action = 'added' and added.leg_id is null then 'added-parent-missing-child'
      when modifications.action <> 'added' and added.leg_id is not null then 'non-added-parent-has-child'
      when added.leg_id is not null and added.leg_id is distinct from added.record_id then 'child-id-mismatch'
      when added.leg_id is not null and added.action is distinct from 'added' then 'child-action-mismatch'
      when added.leg_id is not null and added.source_kind is distinct from 'added' then 'child-source-kind-mismatch'
      when added.leg_id is not null and added.status is distinct from 'active' then 'child-status-mismatch'
      when added.leg_id is not null and added.source_side is distinct from
        case when added.type = 'A' then 'ARR' else 'DEP' end then 'child-source-side-mismatch'
      when added.leg_id is not null
        and not ('addedLeg' = any(coalesce(modifications.changed_fields, '{}'::text[])))
        then 'parent-changed-fields-missing-added-leg'
    end as anomaly
  from public.season_modifications modifications
  full join public.season_modification_added_legs added
    on added.season_id = modifications.season_id
   and added.leg_id = modifications.leg_id
  join public.seasons seasons
    on seasons.id = coalesce(modifications.season_id, added.season_id)
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
),
base_added_id_collisions as (
  select
    seasons.season_code,
    base.season_id,
    base.record_id,
    modifications.leg_id,
    added.record_id as added_record_id
  from public.season_flight_records base
  join public.seasons seasons on seasons.id = base.season_id
  join public.season_modifications modifications
    on modifications.season_id = base.season_id
   and modifications.action = 'added'
  left join public.season_modification_added_legs added
    on added.season_id = modifications.season_id
   and added.leg_id = modifications.leg_id
  where base.record_id = modifications.leg_id
     or base.record_id = added.record_id
),
normalization_candidates as (
  select
    base.season_code,
    base.season_id,
    base.record_id,
    base.airline,
    base.flight_number,
    base.raw_flight_number,
    base.normalized_airline,
    base.canonical_flight_number,
    case
      when base.normalized_flight_part ~ '^[0-9]+$'
        and pg_catalog.char_length(base.normalized_flight_part) < 3
        then pg_catalog.repeat('0', 3 - pg_catalog.char_length(base.normalized_flight_part))
          || base.normalized_flight_part
      else base.normalized_flight_part
    end as canonical_raw_flight_number,
    'base'::text as identity_source
  from base_records base

  union all

  select
    added.season_code,
    added.season_id,
    added.record_id,
    added.airline,
    added.flight_number,
    added.raw_flight_number,
    added.normalized_airline,
    added.canonical_flight_number,
    case
      when added.normalized_flight_part ~ '^[0-9]+$'
        and pg_catalog.char_length(added.normalized_flight_part) < 3
        then pg_catalog.repeat('0', 3 - pg_catalog.char_length(added.normalized_flight_part))
          || added.normalized_flight_part
      else added.normalized_flight_part
    end as canonical_raw_flight_number,
    'added-leg'::text as identity_source
  from effective_added_records added
),
normalization_findings as (
  select
    candidates.*,
    case
      when candidates.airline is distinct from candidates.normalized_airline
        or candidates.flight_number is distinct from candidates.canonical_flight_number
        then 'canonical-identity-mismatch-' || candidates.identity_source
      else 'raw-flight-number-padding-' || candidates.identity_source
    end as category
  from normalization_candidates candidates
  where candidates.airline is distinct from candidates.normalized_airline
     or candidates.flight_number is distinct from candidates.canonical_flight_number
     or candidates.raw_flight_number is distinct from candidates.canonical_raw_flight_number
),
normalization_summary as (
  select
    invalid.season_code,
    invalid.season_id,
    invalid.category,
    (pg_catalog.array_agg(invalid.record_id order by invalid.record_id))[1:10] as record_ids,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.count(*) filter (
      where invalid.airline is distinct from invalid.normalized_airline
    )::bigint as airline_mismatch_count,
    pg_catalog.count(*) filter (
      where invalid.flight_number is distinct from invalid.canonical_flight_number
    )::bigint as flight_number_mismatch_count,
    pg_catalog.count(*) filter (
      where invalid.raw_flight_number is distinct from invalid.canonical_raw_flight_number
    )::bigint as raw_flight_number_mismatch_count
  from normalization_findings invalid
  group by invalid.season_code, invalid.season_id, invalid.category
),
source_row_generation as (
  select
    seasons.season_code,
    source_rows.season_id,
    source_rows.row_index,
    source_rows.effective,
    source_rows.discontinue,
    source_rows.airline,
    source_rows.arr_flight,
    source_rows.dep_flight,
    (
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
    ) as generated_occurrence_count
  from public.season_source_rows source_rows
  join public.seasons seasons on seasons.id = source_rows.season_id
),
source_counts as (
  select
    seasons.season_code,
    seasons.id as season_id,
    pg_catalog.count(distinct source_rows.row_index)::bigint as source_row_count,
    (
      select pg_catalog.count(*)::bigint
      from public.season_source_row_days all_days
      where all_days.season_id = seasons.id
    ) as source_day_count,
    coalesce(pg_catalog.sum(generation.generated_occurrence_count), 0)::bigint
      as generated_occurrence_count,
    (pg_catalog.array_agg(source_rows.row_index order by source_rows.row_index)
      filter (where source_rows.row_index is not null))[1:10] as row_indexes
  from public.seasons seasons
  left join public.season_source_rows source_rows on source_rows.season_id = seasons.id
  left join source_row_generation generation
    on generation.season_id = source_rows.season_id
   and generation.row_index = source_rows.row_index
  group by seasons.season_code, seasons.id
),
w25_baseline_proof as (
  select
    seasons.season_code,
    seasons.id as season_id,
    pg_catalog.count(base.record_id)::bigint as record_count,
    pg_catalog.count(*) filter (where base.source_kind = 'added')::bigint as added_count,
    pg_catalog.count(*) filter (
      where base.status = 'active' and base.action is distinct from 'deleted'
    )::bigint as active_count,
    pg_catalog.count(distinct base.source_row_index)::bigint as source_index_count,
    pg_catalog.min(base.occurrence_date) as min_date,
    pg_catalog.max(base.occurrence_date) as max_date,
    (pg_catalog.array_agg(base.record_id order by base.record_id))[1:10] as record_ids
  from public.seasons seasons
  left join base_records base on base.season_id = seasons.id
  where pg_catalog.upper(seasons.season_code) = 'W25'
  group by seasons.season_code, seasons.id
),
legacy_added_base_counts as (
  select
    base.season_code,
    base.season_id,
    (pg_catalog.array_agg(base.record_id order by base.record_id))[1:10] as record_ids,
    pg_catalog.count(*)::bigint as finding_count,
    pg_catalog.min(base.occurrence_date) as min_date,
    pg_catalog.max(base.occurrence_date) as max_date
  from base_records base
  where base.source_kind = 'added'
  group by base.season_code, base.season_id
),
audit_results as (
  select
    'baseline-count'::text as category,
    counts.season_code,
    counts.season_id,
    counts.record_ids,
    pg_catalog.format(
      'source_kind=%s status=%s action=%s',
      counts.source_kind,
      counts.status,
      coalesce(counts.action, '<null>')
    ) as label,
    counts.finding_count
  from baseline_counts counts

  union all

  select
    'effective-count',
    counts.season_code,
    counts.season_id,
    counts.record_ids,
    pg_catalog.format('source_kind=%s status=%s', counts.source_kind, counts.status),
    counts.finding_count
  from effective_counts counts

  union all

  select
    'duplicate-base-occurrence-inventory',
    duplicates.season_code,
    duplicates.season_id,
    duplicates.record_ids,
    pg_catalog.format(
      '%s %s [%s]',
      duplicates.occurrence_date,
      duplicates.canonical_flight_number,
      duplicates.state_label
    ),
    duplicates.finding_count
  from base_duplicates duplicates

  union all

  select
    'duplicate-active-imported-baseline-occurrence',
    duplicates.season_code,
    duplicates.season_id,
    duplicates.record_ids,
    pg_catalog.format(
      '%s %s active imported baseline rows=%s',
      duplicates.occurrence_date,
      duplicates.canonical_flight_number,
      duplicates.finding_count
    ),
    duplicates.finding_count
  from active_imported_duplicates duplicates

  union all

  select
    'active-imported-required-route-empty',
    invalid.season_code,
    invalid.season_id,
    invalid.record_ids,
    pg_catalog.format(
      'type=%s flight=%s empty route rows=%s dates=%s..%s',
      invalid.type,
      invalid.canonical_flight_number,
      invalid.finding_count,
      invalid.min_date,
      invalid.max_date
    ),
    invalid.finding_count
  from active_imported_required_route_empty invalid

  union all

  select
    'duplicate-effective-occurrence',
    duplicates.season_code,
    duplicates.season_id,
    duplicates.record_ids,
    pg_catalog.format(
      '%s %s',
      duplicates.occurrence_date,
      duplicates.flight_number
    ),
    duplicates.finding_count
  from effective_duplicates duplicates

  union all

  select
    'orphan-link',
    orphan.season_code,
    orphan.season_id,
    array[orphan.record_id, orphan.linked_record_id],
    pg_catalog.format(
      '%s %s -> missing %s',
      orphan.occurrence_date,
      orphan.flight_number,
      orphan.linked_record_id
    ),
    1::bigint
  from orphan_links orphan

  union all

  select
    'nonreciprocal-link',
    links.season_code,
    links.season_id,
    array[links.record_id, links.linked_record_id, links.counterpart_linked_record_id],
    pg_catalog.format(
      '%s %s -> %s; counterpart %s -> %s',
      links.occurrence_date,
      links.flight_number,
      links.linked_record_id,
      links.counterpart_flight_number,
      coalesce(links.counterpart_linked_record_id, '<null>')
    ),
    1::bigint
  from nonreciprocal_links links

  union all

  select
    'invalid-turnaround-cardinality',
    turnarounds.season_code,
    turnarounds.season_id,
    turnarounds.record_ids,
    pg_catalog.format(
      'turnaround_id=%s flights=%s',
      turnarounds.turnaround_id,
      turnarounds.flight_label
    ),
    turnarounds.finding_count
  from invalid_turnarounds turnarounds

  union all

  select
    'orphan-modification',
    orphan.season_code,
    orphan.season_id,
    array[orphan.leg_id],
    pg_catalog.format('leg_id=%s action=%s has no base or added-leg owner', orphan.leg_id, orphan.action),
    1::bigint
  from orphan_modifications orphan

  union all

  select
    'added-relation-anomaly',
    anomaly.season_code,
    anomaly.season_id,
    array_remove(array[anomaly.leg_id, anomaly.record_id], null),
    pg_catalog.format(
      'leg_id=%s record_id=%s action=%s anomaly=%s',
      anomaly.leg_id,
      coalesce(anomaly.record_id, '<null>'),
      anomaly.action,
      anomaly.anomaly
    ),
    1::bigint
  from added_relation_anomalies anomaly

  union all

  select
    'base-added-id-collision',
    collision.season_code,
    collision.season_id,
    array_remove(array[collision.record_id, collision.leg_id, collision.added_record_id], null),
    pg_catalog.format(
      'base=%s added_leg=%s added_record=%s',
      collision.record_id,
      collision.leg_id,
      coalesce(collision.added_record_id, '<null>')
    ),
    1::bigint
  from base_added_id_collisions collision

  union all

  select
    invalid.category,
    invalid.season_code,
    invalid.season_id,
    invalid.record_ids,
    pg_catalog.format(
      'classification=%s airline_mismatch=%s flight_number_mismatch=%s raw_flight_number_mismatch=%s',
      case
        when invalid.category like 'canonical-identity-mismatch-%' then 'blocking'
        else 'informational'
      end,
      invalid.airline_mismatch_count,
      invalid.flight_number_mismatch_count,
      invalid.raw_flight_number_mismatch_count
    ),
    invalid.finding_count
  from normalization_summary invalid

  union all

  select
    'legacy-added-base-records',
    legacy.season_code,
    legacy.season_id,
    legacy.record_ids,
    pg_catalog.format(
      'stored_in=season_flight_records added_leg_payloads=0 dates=%s..%s',
      legacy.min_date,
      legacy.max_date
    ),
    legacy.finding_count
  from legacy_added_base_counts legacy

  union all

  select
    'source-row-count',
    counts.season_code,
    counts.season_id,
    coalesce(
      array(select row_index::text from pg_catalog.unnest(counts.row_indexes) row_index),
      '{}'::text[]
    ),
    pg_catalog.format(
      'source_rows=%s source_days=%s generated_occurrences=%s',
      counts.source_row_count,
      counts.source_day_count,
      counts.generated_occurrence_count
    ),
    counts.source_row_count
  from source_counts counts

  union all

  select
    'source-row-generates-no-occurrence',
    generation.season_code,
    generation.season_id,
    array[generation.row_index::text],
    pg_catalog.format(
      'row=%s period=%s..%s airline=%s arr=%s dep=%s',
      generation.row_index,
      generation.effective,
      generation.discontinue,
      generation.airline,
      coalesce(generation.arr_flight, '<null>'),
      coalesce(generation.dep_flight, '<null>')
    ),
    1::bigint
  from source_row_generation generation
  where generation.generated_occurrence_count = 0

  union all

  select
    'w25-baseline-proof',
    proof.season_code,
    proof.season_id,
    proof.record_ids,
    pg_catalog.format(
      'records=%s added=%s active=%s distinct_source_indexes=%s dates=%s..%s season_bounds=2025-10-26..2026-03-28 complete=%s',
      proof.record_count,
      proof.added_count,
      proof.active_count,
      proof.source_index_count,
      proof.min_date,
      proof.max_date,
      case when proof.min_date = '2025-10-26' and proof.max_date = '2026-03-28'
        then 'yes' else 'no' end
    ),
    proof.record_count
  from w25_baseline_proof proof
),
classified_results as (
  select
    audit_results.category,
    case
      when audit_results.category in (
        'duplicate-active-imported-baseline-occurrence',
        'active-imported-required-route-empty',
        'duplicate-effective-occurrence',
        'orphan-link',
        'nonreciprocal-link',
        'invalid-turnaround-cardinality',
        'orphan-modification',
        'added-relation-anomaly',
        'base-added-id-collision',
        'source-row-generates-no-occurrence'
      ) or audit_results.category like 'canonical-identity-mismatch-%'
        then 'error'
      when audit_results.category = 'w25-baseline-proof' then 'proof'
      when audit_results.category in (
        'baseline-count',
        'effective-count',
        'duplicate-base-occurrence-inventory',
        'legacy-added-base-records',
        'source-row-count'
      ) then 'inventory'
      else 'info'
    end::text as severity,
    (
      audit_results.category in (
        'duplicate-active-imported-baseline-occurrence',
        'active-imported-required-route-empty',
        'duplicate-effective-occurrence',
        'orphan-link',
        'nonreciprocal-link',
        'invalid-turnaround-cardinality',
        'orphan-modification',
        'added-relation-anomaly',
        'base-added-id-collision',
        'source-row-generates-no-occurrence'
      ) or audit_results.category like 'canonical-identity-mismatch-%'
    ) as blocking,
    audit_results.season_code,
    audit_results.season_id,
    audit_results.record_ids,
    audit_results.label,
    audit_results.finding_count
  from audit_results
),
blocking_summary as (
  select pg_catalog.count(*) filter (where classified.blocking)::bigint as blocking_count
  from classified_results classified
),
audit_output as (
  select
    classified.category,
    classified.severity,
    classified.blocking,
    classified.season_code,
    classified.season_id,
    classified.record_ids,
    classified.label,
    classified.finding_count,
    summary.blocking_count,
    0 as output_order
  from classified_results classified
  cross join blocking_summary summary

  union all

  select
    '__blocking_summary__'::text,
    'summary'::text,
    false,
    null::text,
    null::text,
    '{}'::text[],
    pg_catalog.format('blocking_count=%s', summary.blocking_count),
    summary.blocking_count,
    summary.blocking_count,
    1
  from blocking_summary summary
)
select
  audit_output.category,
  audit_output.severity,
  audit_output.blocking,
  audit_output.season_code,
  audit_output.season_id,
  audit_output.record_ids,
  audit_output.label,
  audit_output.finding_count,
  audit_output.blocking_count
from audit_output
order by
  audit_output.output_order,
  audit_output.season_code,
  audit_output.category,
  audit_output.label;

rollback;
