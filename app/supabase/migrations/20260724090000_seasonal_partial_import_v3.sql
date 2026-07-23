alter table public.season_import_batches
  add column if not exists contract_version smallint not null default 2,
  add column if not exists apply_strategy text,
  add column if not exists target_existed_at_stage boolean,
  add column if not exists preview jsonb,
  add column if not exists preview_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists cancelled_at timestamptz;

alter table public.season_import_batches
  drop constraint if exists season_import_batches_status_check;

alter table public.season_import_batches
  add constraint season_import_batches_status_check
  check (
    status in (
      'staged',
      'validated',
      'committed',
      'failed',
      'cancelled',
      'expired'
    )
  );

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.season_import_batches'::pg_catalog.regclass
      and constraints.conname = 'season_import_batches_v3_contract_check'
  ) then
    alter table public.season_import_batches
      add constraint season_import_batches_v3_contract_check
      check (
        contract_version in (2, 3)
        and (
          contract_version <> 3
          or (
            apply_strategy is not null
            and apply_strategy in ('merge', 'replace')
            and preview is not null
            and pg_catalog.jsonb_typeof(preview) = 'object'
            and preview_hash is not null
            and pg_catalog.btrim(preview_hash) <> ''
            and expires_at is not null
          )
        )
      );
  end if;
end;
$$;

create table if not exists public.season_import_batch_records_v3 (
  batch_id uuid not null
    references public.season_import_batches(batch_id) on delete cascade,
  occurrence_key text not null,
  generated_record_id text not null,
  source_staging_row_index integer not null,
  source_row_index integer not null,
  linked_occurrence_key text,
  record_hash text not null,
  record_data jsonb not null,
  primary key (batch_id, occurrence_key),
  unique (batch_id, generated_record_id),
  check (pg_catalog.btrim(occurrence_key) <> ''),
  check (pg_catalog.btrim(generated_record_id) <> ''),
  check (source_staging_row_index >= 0),
  check (source_row_index >= 0),
  check (pg_catalog.btrim(record_hash) <> ''),
  check (pg_catalog.jsonb_typeof(record_data) = 'object')
);

create index if not exists season_import_batch_records_v3_source_idx
  on public.season_import_batch_records_v3 (batch_id, source_staging_row_index);

create table if not exists public.season_import_batch_preimages_v3 (
  batch_id uuid not null
    references public.season_import_batches(batch_id) on delete restrict,
  record_id text not null,
  existed_before boolean not null,
  record_data jsonb,
  modification_data jsonb,
  counter_rows jsonb not null default '[]'::jsonb,
  checkin_window_rows jsonb not null default '[]'::jsonb,
  added_leg_data jsonb,
  primary key (batch_id, record_id),
  check (pg_catalog.btrim(record_id) <> ''),
  check (record_data is null or pg_catalog.jsonb_typeof(record_data) = 'object'),
  check (
    modification_data is null
    or pg_catalog.jsonb_typeof(modification_data) = 'object'
  ),
  check (pg_catalog.jsonb_typeof(counter_rows) = 'array'),
  check (pg_catalog.jsonb_typeof(checkin_window_rows) = 'array'),
  check (added_leg_data is null or pg_catalog.jsonb_typeof(added_leg_data) = 'object')
);

alter table public.season_import_batch_records_v3 enable row level security;
alter table public.season_import_batch_preimages_v3 enable row level security;

revoke all on table public.season_import_batch_records_v3
  from public, anon, authenticated;
revoke all on table public.season_import_batch_preimages_v3
  from public, anon, authenticated;

alter table public.season_flight_records
  add column if not exists source_import_batch_id uuid,
  add column if not exists source_import_staging_row_index integer;

alter table public.seasons
  add column if not exists source_provenance_mode text not null default 'none',
  add column if not exists last_import_batch_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.seasons'::pg_catalog.regclass
      and constraints.conname = 'seasons_source_provenance_mode_check'
  ) then
    alter table public.seasons
      add constraint seasons_source_provenance_mode_check
      check (source_provenance_mode in ('none', 'full', 'fragmented'));
  end if;
end;
$$;

update public.seasons seasons
set source_provenance_mode = 'full'
where seasons.source_provenance_mode = 'none'
  and exists (
    select 1
    from public.season_source_rows source_rows
    where source_rows.season_id = seasons.id
  );

create or replace function public.set_season_import_target_existence_v3()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.target_existed_at_stage is not null then
    return new;
  end if;

  if new.season_id is not null and pg_catalog.btrim(new.season_id) <> '' then
    perform 1
    from public.seasons seasons
    where seasons.id = new.season_id
    for key share;
  else
    perform 1
    from public.seasons seasons
    where pg_catalog.upper(pg_catalog.btrim(seasons.season_code))
      = pg_catalog.upper(pg_catalog.btrim(new.season_code))
    order by seasons.id
    limit 1
    for key share;
  end if;

  new.target_existed_at_stage := found;
  return new;
end;
$$;

drop trigger if exists set_season_import_target_existence_v3
  on public.season_import_batches;

create trigger set_season_import_target_existence_v3
before insert on public.season_import_batches
for each row
execute function public.set_season_import_target_existence_v3();

update public.season_import_batches batches
set target_existed_at_stage = (
  exists (
    select 1
    from public.seasons seasons
    where batches.season_id is not null
      and seasons.id = batches.season_id
  )
  or exists (
    select 1
    from public.seasons seasons
    where batches.season_id is null
      and pg_catalog.upper(pg_catalog.btrim(seasons.season_code))
        = pg_catalog.upper(pg_catalog.btrim(batches.season_code))
  )
)
where batches.target_existed_at_stage is null;

alter table public.season_import_batches
  alter column target_existed_at_stage set not null;

create or replace function public.guard_legacy_existing_season_import_v3()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.contract_version = 2
    and old.target_existed_at_stage
    and old.status is distinct from 'committed'
    and new.status = 'committed'
  then
    raise exception
      'Existing-season Import V2 is disabled; use Import V3 preview with merge or replace'
      using errcode = '0A000';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_legacy_existing_season_import_v3
  on public.season_import_batches;

create trigger guard_legacy_existing_season_import_v3
before update of status on public.season_import_batches
for each row
execute function public.guard_legacy_existing_season_import_v3();

revoke execute on function public.set_season_import_target_existence_v3()
  from public, anon, authenticated;
revoke execute on function public.guard_legacy_existing_season_import_v3()
  from public, anon, authenticated;

create or replace function public.seasonal_import_v3_response(p_batch_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.jsonb_build_object(
    'batchId', batches.batch_id,
    'requestId', batches.request_id,
    'seasonId', coalesce(
      batches.season_id,
      batches.result #>> '{_staging,targetSeasonId}'
    ),
    'seasonCode', batches.season_code,
    'strategy', batches.apply_strategy,
    'status', batches.status,
    'valid', coalesce((batches.preview->>'valid')::boolean, false),
    'expectedDataVersion', batches.expected_data_version,
    'previewHash', batches.preview_hash,
    'counts', batches.preview->'counts',
    'diagnosticCount', coalesce(
      (batches.preview->>'diagnosticCount')::integer,
      0
    ),
    'diagnosticsTruncated', coalesce(
      (batches.preview->>'diagnosticsTruncated')::boolean,
      false
    ),
    'diagnostics', coalesce(batches.preview->'diagnostics', '[]'::jsonb),
    'expiresAt', batches.expires_at
  )
  from public.season_import_batches batches
  where batches.batch_id = p_batch_id
    and batches.contract_version = 3
$$;

create or replace function public.stage_seasonal_import_v3(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request_id uuid;
  v_strategy text;
  v_expected_data_version integer;
  v_checksum text;
  v_target_season_id text;
  v_target_exists boolean := false;
  v_current_data_version integer := 0;
  v_batch public.season_import_batches%rowtype;
  v_stage_v2 jsonb;
  v_counts jsonb;
  v_preview jsonb;
  v_preview_hash text;
  v_diagnostics jsonb := '[]'::jsonb;
  v_diagnostic_count integer := 0;
  v_diagnostics_truncated boolean := false;
  v_generated_count integer := 0;
  v_insert_count integer := 0;
  v_baseline_update_count integer := 0;
  v_unchanged_count integer := 0;
  v_existing_imported_count integer := 0;
  v_matched_count integer := 0;
  v_preserved_outside_count integer := 0;
  v_remove_imported_count integer := 0;
  v_preserved_overlay_count integer := 0;
  v_preserved_deleted_overlay_count integer := 0;
  v_clear_structural_overlay_count integer := 0;
  v_clear_deleted_overlay_count integer := 0;
  v_manual_collision_count integer := 0;
  v_valid boolean := false;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Seasonal import V3'
      using errcode = '42501';
  end if;
  if p_import is null or pg_catalog.jsonb_typeof(p_import) <> 'object' then
    raise exception 'p_import must be a JSON object'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_import->'contractVersion') is distinct from 'number'
    or p_import->>'contractVersion' <> '3'
  then
    raise exception 'contractVersion must be 3'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_import->'strategy') is distinct from 'string' then
    raise exception 'strategy must be merge or replace'
      using errcode = '22023';
  end if;

  v_strategy := pg_catalog.lower(pg_catalog.btrim(p_import->>'strategy'));
  if v_strategy = 'merge' then
    if not public.app_operator_has_permission('seasonal.write') then
      raise exception 'Missing required permission: seasonal.write'
        using errcode = '42501';
    end if;
  elsif v_strategy = 'replace' then
    if not public.app_operator_has_permission('season.repair') then
      raise exception 'Missing required permission: season.repair'
        using errcode = '42501';
    end if;
  else
    raise exception 'strategy must be merge or replace'
      using errcode = '22023';
  end if;

  begin
    v_request_id := nullif(pg_catalog.btrim(p_import->>'requestId'), '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'requestId must be a UUID'
        using errcode = '22023';
  end;
  if v_request_id is null then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  v_stage_v2 := public.stage_seasonal_import_v2(
    pg_catalog.jsonb_build_object(
      'requestId', p_import->'requestId',
      'checksum', p_import->'checksum',
      'mode', case when v_strategy = 'replace' then 'repair' else 'standard' end,
      'seasonId', p_import->'seasonId',
      'seasonCode', p_import->'seasonCode',
      'expectedDataVersion', p_import->'expectedDataVersion',
      'fileName', p_import->'fileName',
      'uploadedAt', p_import->'uploadedAt',
      'sourceRows', p_import->'sourceRows'
    )
  );

  select batches.*
  into v_batch
  from public.season_import_batches batches
  where batches.request_id = v_request_id
    and batches.created_by = auth.uid()
  for update;

  if not found then
    raise exception 'Seasonal import request is not available to the current operator'
      using errcode = '42501';
  end if;

  v_checksum := nullif(pg_catalog.btrim(p_import->>'checksum'), '');
  v_expected_data_version := (p_import->>'expectedDataVersion')::integer;

  if v_batch.contract_version = 3 then
    if v_batch.apply_strategy is distinct from v_strategy
      or v_batch.checksum is distinct from v_checksum
      or v_batch.expected_data_version is distinct from v_expected_data_version
    then
      raise exception 'Import requestId % was already used with a different V3 request',
        v_request_id
        using errcode = '23505';
    end if;
    return public.seasonal_import_v3_response(v_batch.batch_id);
  end if;

  if v_batch.contract_version <> 2
    or v_batch.status not in ('validated', 'failed')
  then
    raise exception 'Import requestId % cannot be upgraded to V3 staging', v_request_id
      using errcode = '23505';
  end if;

  v_target_season_id := nullif(
    v_batch.result #>> '{_staging,targetSeasonId}',
    ''
  );
  if v_target_season_id is null then
    raise exception 'V3 stage is missing a persisted target season identity'
      using errcode = '23505';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_target_season_id, 0)
  );

  select seasons.data_version
  into v_current_data_version
  from public.seasons seasons
  where seasons.id = v_target_season_id
  for share;
  v_target_exists := found;

  if v_target_exists then
    if v_batch.season_id is distinct from v_target_season_id
      or v_current_data_version is distinct from v_expected_data_version
    then
      raise exception 'Stale seasonal data version for %: expected %, current %',
        v_target_season_id,
        v_expected_data_version,
        v_current_data_version
        using errcode = '40001';
    end if;
  elsif v_batch.season_id is not null or v_expected_data_version <> 0 then
    raise exception 'New season % must stage from expectedDataVersion 0',
      v_target_season_id
      using errcode = '40001';
  end if;

  if v_batch.status = 'validated' then
    with generated AS MATERIALIZED (
      select *
      from public.generate_seasonal_import_records_v2(v_batch.batch_id)
    ), generated_with_links as (
      select
        generated.*,
        linked.occurrence_key as linked_occurrence_key,
        source_rows.row_index as source_staging_row_index,
        'SER_'
          || pg_catalog.regexp_replace(generated.type, '[^A-Z0-9]+', '_', 'g')
          || '_'
          || pg_catalog.regexp_replace(generated.airline, '[^A-Z0-9]+', '_', 'g')
          || '_'
          || pg_catalog.regexp_replace(
            generated.flight_number,
            '[^A-Z0-9]+',
            '_',
            'g'
          )
          || '_'
          || pg_catalog.regexp_replace(generated.route, '[^A-Z0-9]+', '_', 'g')
          as flight_series_id
      from generated
      left join generated linked
        on linked.record_id = generated.linked_record_id
      join public.season_import_batch_rows source_rows
        on source_rows.batch_id = v_batch.batch_id
        and (source_rows.row_data->>'rowIndex')::integer
          = generated.source_row_index
    ), prepared as (
      select
        generated_with_links.*,
        pg_catalog.jsonb_build_object(
          'recordId', generated_with_links.record_id,
          'occurrenceKey', generated_with_links.occurrence_key,
          'linkId', generated_with_links.link_id,
          'type', generated_with_links.type,
          'airline', generated_with_links.airline,
          'flightNumber', generated_with_links.flight_number,
          'rawFlightNumber', generated_with_links.raw_flight_number,
          'route', generated_with_links.route,
          'schedule', generated_with_links.schedule,
          'aircraft', generated_with_links.aircraft,
          'category', generated_with_links.category,
          'codeShares', generated_with_links.code_shares,
          'intDomInd', generated_with_links.int_dom_ind,
          'date', generated_with_links.scheduled_date,
          'scheduledDate', generated_with_links.scheduled_date,
          'scheduledTime', generated_with_links.schedule,
          'operationalDate', generated_with_links.operational_date,
          'iataSeasonCode', v_batch.season_code,
          'flightSeriesId', generated_with_links.flight_series_id,
          'dayOfWeek', generated_with_links.day_of_week,
          'sourceRowIndex', generated_with_links.source_row_index,
          'linkedSourceRowIndex', generated_with_links.linked_source_row_index,
          'linkType', generated_with_links.link_type,
          'pairAnchorDate', generated_with_links.pair_anchor_date,
          'linkedRecordId', generated_with_links.linked_record_id,
          'linkedOccurrenceKey', generated_with_links.linked_occurrence_key,
          'sourceKind', 'imported',
          'sourceSide', case
            when generated_with_links.type = 'D' then 'DEP'
            else 'ARR'
          end,
          'status', 'active',
          'turnaroundId', generated_with_links.turnaround_id
        ) as record_data
      from generated_with_links
    )
    insert into public.season_import_batch_records_v3 (
      batch_id,
      occurrence_key,
      generated_record_id,
      source_staging_row_index,
      source_row_index,
      linked_occurrence_key,
      record_hash,
      record_data
    )
    select
      v_batch.batch_id,
      prepared.occurrence_key,
      prepared.record_id,
      prepared.source_staging_row_index,
      prepared.source_row_index,
      prepared.linked_occurrence_key,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            (
              prepared.record_data
              - array['recordId', 'linkId', 'linkedRecordId', 'turnaroundId']
            )::text,
            'UTF8'
          )
        ),
        'hex'
      ),
      prepared.record_data
    from prepared
    on conflict (batch_id, occurrence_key) do nothing;
  end if;

  select pg_catalog.count(*)::integer
  into v_generated_count
  from public.season_import_batch_records_v3 records
  where records.batch_id = v_batch.batch_id;

  with existing_source as (
    select
      records.record_id,
      v_target_season_id
        || '|'
        || coalesce(nullif(records.scheduled_date, ''), records.date)
        || '|'
        || pg_catalog.upper(pg_catalog.btrim(records.airline))
        || '|'
        || normalized.flight_number as occurrence_key,
      pg_catalog.jsonb_build_object(
        'occurrenceKey',
          v_target_season_id
            || '|'
            || coalesce(nullif(records.scheduled_date, ''), records.date)
            || '|'
            || pg_catalog.upper(pg_catalog.btrim(records.airline))
            || '|'
            || normalized.flight_number,
        'type', records.type,
        'airline', pg_catalog.upper(pg_catalog.btrim(records.airline)),
        'flightNumber', normalized.flight_number,
        'rawFlightNumber', records.raw_flight_number,
        'route', records.route,
        'schedule', records.schedule,
        'aircraft', records.aircraft,
        'category', records.category,
        'codeShares', records.code_shares,
        'intDomInd', records.int_dom_ind,
        'date', coalesce(nullif(records.scheduled_date, ''), records.date),
        'scheduledDate', coalesce(nullif(records.scheduled_date, ''), records.date),
        'scheduledTime', coalesce(nullif(records.scheduled_time, ''), records.schedule),
        'operationalDate', records.operational_date,
        'iataSeasonCode', records.iata_season_code,
        'flightSeriesId', records.flight_series_id,
        'dayOfWeek', records.day_of_week,
        'sourceRowIndex', records.source_row_index,
        'linkedSourceRowIndex', records.linked_source_row_index,
        'linkType', records.link_type,
        'pairAnchorDate', records.pair_anchor_date,
        'linkedOccurrenceKey', case
          when linked.record_id is null then null
          else
            v_target_season_id
              || '|'
              || coalesce(nullif(linked.scheduled_date, ''), linked.date)
              || '|'
              || pg_catalog.upper(pg_catalog.btrim(linked.airline))
              || '|'
              || linked_normalized.flight_number
        end,
        'sourceKind', 'imported',
        'sourceSide', case when records.type = 'D' then 'DEP' else 'ARR' end,
        'status', 'active'
      ) as semantic_data
    from public.season_flight_records records
    cross join lateral public.normalize_seasonal_flight_number_v2(
      records.airline,
      coalesce(nullif(records.flight_number, ''), records.raw_flight_number)
    ) normalized
    left join public.season_flight_records linked
      on linked.record_id = records.linked_record_id
      and linked.season_id = records.season_id
    left join lateral public.normalize_seasonal_flight_number_v2(
      linked.airline,
      coalesce(nullif(linked.flight_number, ''), linked.raw_flight_number)
    ) linked_normalized on linked.record_id is not null
    where records.season_id = v_target_season_id
      and records.source_kind = 'imported'
      and records.status = 'active'
      and records.action is distinct from 'deleted'
  ), existing as (
    select
      existing_source.record_id,
      existing_source.occurrence_key,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(existing_source.semantic_data::text, 'UTF8')
        ),
        'hex'
      ) as record_hash
    from existing_source
  ), matched as (
    select incoming.occurrence_key, existing.record_hash as existing_hash,
      incoming.record_hash as incoming_hash
    from public.season_import_batch_records_v3 incoming
    join existing on existing.occurrence_key = incoming.occurrence_key
    where incoming.batch_id = v_batch.batch_id
  )
  select
    (
      select pg_catalog.count(*)::integer
      from public.season_import_batch_records_v3 incoming
      left join existing on existing.occurrence_key = incoming.occurrence_key
      where incoming.batch_id = v_batch.batch_id
        and existing.occurrence_key is null
    ),
    (
      select pg_catalog.count(*)::integer
      from matched
      where matched.existing_hash is distinct from matched.incoming_hash
    ),
    (
      select pg_catalog.count(*)::integer
      from matched
      where matched.existing_hash = matched.incoming_hash
    ),
    (select pg_catalog.count(*)::integer from existing),
    (select pg_catalog.count(*)::integer from matched)
  into
    v_insert_count,
    v_baseline_update_count,
    v_unchanged_count,
    v_existing_imported_count,
    v_matched_count;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where modifications.action = 'deleted'
    )::integer
  into v_preserved_overlay_count, v_preserved_deleted_overlay_count
  from public.season_modifications modifications
  where modifications.season_id = v_target_season_id;

  if v_strategy = 'merge' then
    v_preserved_outside_count := v_existing_imported_count - v_matched_count;
  else
    v_remove_imported_count := v_existing_imported_count - v_matched_count;

    select
      pg_catalog.count(*) filter (
        where modifications.action = 'modified'
          and modifications.changed_fields
            && array['schedule', 'aircraft', 'route', 'codeShares']::text[]
      )::integer,
      pg_catalog.count(*) filter (
        where modifications.action = 'deleted'
      )::integer
    into v_clear_structural_overlay_count, v_clear_deleted_overlay_count
    from public.season_modifications modifications
    join public.season_flight_records records
      on records.record_id = modifications.leg_id
      and records.season_id = modifications.season_id
      and records.source_kind = 'imported'
    where modifications.season_id = v_target_season_id;

    v_preserved_overlay_count := greatest(
      v_preserved_overlay_count
        - v_clear_structural_overlay_count
        - v_clear_deleted_overlay_count,
      0
    );
    v_preserved_deleted_overlay_count := 0;
  end if;

  drop table if exists pg_temp.seasonal_import_v3_diagnostic_items;
  create temporary table seasonal_import_v3_diagnostic_items (
    code text not null,
    message text not null,
    source_row_indexes integer[] not null,
    occurrence_key text,
    affected_date text,
    airline text,
    flight_number text
  ) on commit drop;

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
    coalesce(nullif(diagnostics.issue->>'code', ''), 'unknown-diagnostic'),
    coalesce(nullif(diagnostics.issue->>'message', ''), 'Seasonal import diagnostic.'),
    case
      when pg_catalog.jsonb_typeof(diagnostics.issue->'sourceRowIndexes') = 'array'
        then array(
          select values.value::integer
          from pg_catalog.jsonb_array_elements_text(
            diagnostics.issue->'sourceRowIndexes'
          ) values(value)
          order by values.value::integer
        )
      when pg_catalog.jsonb_typeof(diagnostics.issue->'rowIndex') = 'number'
        then array[(diagnostics.issue->>'rowIndex')::integer]
      else '{}'::integer[]
    end,
    nullif(diagnostics.issue->>'occurrenceKey', ''),
    coalesce(
      nullif(
        pg_catalog.split_part(diagnostics.issue->>'occurrenceKey', '|', 2),
        ''
      ),
      nullif(diagnostics.issue->>'pairAnchorDate', '')
    ),
    nullif(
      pg_catalog.split_part(diagnostics.issue->>'occurrenceKey', '|', 3),
      ''
    ),
    nullif(
      pg_catalog.split_part(diagnostics.issue->>'occurrenceKey', '|', 4),
      ''
    )
  from pg_catalog.jsonb_array_elements(v_batch.diagnostics)
    diagnostics(issue);

  with manual_candidates as (
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
      and (records.source_kind = 'added' or records.action = 'added')
      and records.status = 'active'
      and records.action is distinct from 'deleted'
      and modifications.action is distinct from 'deleted'
    union all
    select
      added_legs.record_id,
      coalesce(nullif(added_legs.scheduled_date, ''), nullif(added_legs.date, '')),
      pg_catalog.upper(pg_catalog.btrim(added_legs.airline)),
      coalesce(
        nullif(added_legs.flight_number, ''),
        added_legs.raw_flight_number
      )
    from public.season_modification_added_legs added_legs
    join public.season_modifications modifications
      on modifications.season_id = added_legs.season_id
      and modifications.leg_id = added_legs.leg_id
    where added_legs.season_id = v_target_season_id
      and added_legs.source_kind = 'added'
      and added_legs.status = 'active'
      and added_legs.action is distinct from 'deleted'
      and modifications.action = 'added'
  ), manual_occurrences as (
    select distinct
      v_target_season_id
        || '|'
        || manual_candidates.scheduled_date
        || '|'
        || manual_candidates.airline
        || '|'
        || normalized.flight_number as occurrence_key,
      manual_candidates.record_id
    from manual_candidates
    cross join lateral public.normalize_seasonal_flight_number_v2(
      manual_candidates.airline,
      manual_candidates.raw_flight_number
    ) normalized
    where manual_candidates.scheduled_date is not null
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
    'manual-occurrence-collision',
    'Incoming occurrence collides with a manual added flight.',
    array[incoming.source_row_index],
    incoming.occurrence_key,
    pg_catalog.split_part(incoming.occurrence_key, '|', 2),
    pg_catalog.split_part(incoming.occurrence_key, '|', 3),
    pg_catalog.split_part(incoming.occurrence_key, '|', 4)
  from public.season_import_batch_records_v3 incoming
  join manual_occurrences manual
    on manual.occurrence_key = incoming.occurrence_key
  where incoming.batch_id = v_batch.batch_id;

  select pg_catalog.count(distinct diagnostics.occurrence_key)::integer
  into v_manual_collision_count
  from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
  where diagnostics.code = 'manual-occurrence-collision';

  with grouped as (
    select
      diagnostics.code,
      diagnostics.source_row_indexes,
      diagnostics.airline,
      diagnostics.flight_number,
      pg_catalog.min(diagnostics.message) as message,
      pg_catalog.count(distinct diagnostics.affected_date) filter (
        where diagnostics.affected_date is not null
      )::integer as affected_date_count,
      pg_catalog.count(distinct diagnostics.occurrence_key) filter (
        where diagnostics.occurrence_key is not null
      )::integer as occurrence_count,
      pg_catalog.min(diagnostics.occurrence_key) as occurrence_key
    from pg_temp.seasonal_import_v3_diagnostic_items diagnostics
    group by
      diagnostics.code,
      diagnostics.source_row_indexes,
      diagnostics.airline,
      diagnostics.flight_number,
      case
        when diagnostics.occurrence_key is null then diagnostics.message
        else ''
      end
  ), ranked as (
    select
      grouped.*,
      pg_catalog.row_number() over (
        order by
          grouped.code,
          grouped.source_row_indexes::text,
          grouped.airline,
          grouped.flight_number
      ) as diagnostic_rank
    from grouped
  )
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) > 200,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'code', ranked.code,
          'message', case
            when ranked.code = 'duplicate-occurrence-key' then pg_catalog.format(
              'Rows %s generate duplicate %s occurrence(s) for %s.',
              pg_catalog.array_to_string(ranked.source_row_indexes, ', '),
              ranked.affected_date_count,
              coalesce(ranked.airline, '') || coalesce(ranked.flight_number, '')
            )
            when ranked.code = 'manual-occurrence-collision' then pg_catalog.format(
              'Incoming %s occurrence(s) for %s collide with manual added flights.',
              ranked.affected_date_count,
              coalesce(ranked.airline, '') || coalesce(ranked.flight_number, '')
            )
            else ranked.message
          end,
          'sourceRowIndexes', pg_catalog.to_jsonb(ranked.source_row_indexes),
          'occurrenceKey', case
            when ranked.occurrence_count = 1 then ranked.occurrence_key
            else null
          end,
          'affectedDateCount', ranked.affected_date_count,
          'sampleDates', coalesce(
            (
              select pg_catalog.jsonb_agg(
                samples.affected_date
                order by samples.affected_date
              )
              from (
                select distinct items.affected_date
                from pg_temp.seasonal_import_v3_diagnostic_items items
                where items.code = ranked.code
                  and items.source_row_indexes = ranked.source_row_indexes
                  and items.airline is not distinct from ranked.airline
                  and items.flight_number is not distinct from ranked.flight_number
                  and items.affected_date is not null
                order by items.affected_date
                limit 5
              ) samples
            ),
            '[]'::jsonb
          )
        )
        order by ranked.diagnostic_rank
      ) filter (where ranked.diagnostic_rank <= 200),
      '[]'::jsonb
    )
  into v_diagnostic_count, v_diagnostics_truncated, v_diagnostics
  from ranked;

  v_counts := pg_catalog.jsonb_build_object(
    'sourceRowCount', v_batch.source_row_count,
    'generatedOccurrenceCount', v_generated_count,
    'insertCount', v_insert_count,
    'baselineUpdateCount', v_baseline_update_count,
    'unchangedCount', v_unchanged_count,
    'preservedOutsideScopeCount', v_preserved_outside_count,
    'preservedOverlayCount', v_preserved_overlay_count,
    'preservedDeletedOverlayCount', v_preserved_deleted_overlay_count,
    'removeImportedCount', v_remove_imported_count,
    'clearStructuralOverlayCount', v_clear_structural_overlay_count,
    'clearDeletedOverlayCount', v_clear_deleted_overlay_count,
    'manualCollisionCount', v_manual_collision_count
  );

  v_valid := v_batch.status = 'validated'
    and v_generated_count > 0
    and v_diagnostic_count = 0
    and v_manual_collision_count = 0;

  v_preview := pg_catalog.jsonb_build_object(
    'valid', v_valid,
    'counts', v_counts,
    'diagnosticCount', v_diagnostic_count,
    'diagnosticsTruncated', v_diagnostics_truncated,
    'diagnostics', v_diagnostics
  );

  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contractVersion', 3,
          'requestId', v_request_id,
          'checksum', v_checksum,
          'strategy', v_strategy,
          'expectedDataVersion', v_expected_data_version,
          'records', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_array(
                  records.occurrence_key,
                  records.record_hash
                )
                order by records.occurrence_key
              )
              from public.season_import_batch_records_v3 records
              where records.batch_id = v_batch.batch_id
            ),
            '[]'::jsonb
          ),
          'counts', v_counts
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  into v_preview_hash;

  update public.season_import_batches batches
  set
    contract_version = 3,
    apply_strategy = v_strategy,
    target_existed_at_stage = v_target_exists,
    status = case when v_valid then 'validated' else 'failed' end,
    generated_record_count = v_generated_count,
    diagnostics = v_diagnostics,
    preview = v_preview,
    preview_hash = v_preview_hash,
    expires_at = pg_catalog.now() + interval '24 hours'
  where batches.batch_id = v_batch.batch_id
  returning batches.* into v_batch;

  return public.seasonal_import_v3_response(v_batch.batch_id);
end;
$$;

create or replace function public.get_seasonal_import_v3_status(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_batch public.season_import_batches%rowtype;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Seasonal import V3 status'
      using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'p_request_id is required'
      using errcode = '22023';
  end if;

  select batches.*
  into v_batch
  from public.season_import_batches batches
  where batches.request_id = p_request_id
    and batches.created_by = auth.uid()
    and batches.contract_version = 3
  for update;

  if not found then
    raise exception 'Seasonal import request is not available to the current operator'
      using errcode = '42501';
  end if;

  if v_batch.status in ('validated', 'failed')
    and v_batch.expires_at <= pg_catalog.now()
  then
    update public.season_import_batches batches
    set status = 'expired'
    where batches.batch_id = v_batch.batch_id
    returning batches.* into v_batch;
  end if;

  return public.seasonal_import_v3_response(v_batch.batch_id);
end;
$$;

create or replace function public.cancel_seasonal_import_v3(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_batch public.season_import_batches%rowtype;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Seasonal import V3 cancel'
      using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'p_batch_id is required'
      using errcode = '22023';
  end if;

  select batches.*
  into v_batch
  from public.season_import_batches batches
  where batches.batch_id = p_batch_id
    and batches.created_by = auth.uid()
    and batches.contract_version = 3
  for update;

  if not found then
    raise exception 'Seasonal import request is not available to the current operator'
      using errcode = '42501';
  end if;

  if v_batch.status = 'cancelled' then
    return pg_catalog.jsonb_build_object(
      'batchId', v_batch.batch_id,
      'status', 'cancelled'
    );
  end if;
  if v_batch.status not in ('validated', 'failed') then
    raise exception 'Seasonal import batch cannot be cancelled from status %',
      v_batch.status
      using errcode = '22023';
  end if;

  update public.season_import_batches batches
  set
    status = 'cancelled',
    cancelled_at = pg_catalog.now()
  where batches.batch_id = v_batch.batch_id;

  return pg_catalog.jsonb_build_object(
    'batchId', v_batch.batch_id,
    'status', 'cancelled'
  );
end;
$$;

revoke execute on function public.seasonal_import_v3_response(uuid)
  from public, anon, authenticated;
revoke execute on function public.stage_seasonal_import_v3(jsonb)
  from public, anon;
grant execute on function public.stage_seasonal_import_v3(jsonb)
  to authenticated;
revoke execute on function public.get_seasonal_import_v3_status(uuid)
  from public, anon;
grant execute on function public.get_seasonal_import_v3_status(uuid)
  to authenticated;
revoke execute on function public.cancel_seasonal_import_v3(uuid)
  from public, anon;
grant execute on function public.cancel_seasonal_import_v3(uuid)
  to authenticated;
