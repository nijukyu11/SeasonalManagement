create table if not exists public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  checksum text not null,
  status text not null check (status in ('staged', 'validated', 'committed', 'failed')),
  source_row_count integer not null default 0,
  generated_record_count integer not null default 0,
  diagnostics jsonb not null default '[]'::jsonb,
  result jsonb,
  constraint season_import_batches_result_object_check
    check (result is null or pg_catalog.jsonb_typeof(result) = 'object'),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create table if not exists public.season_import_batch_rows (
  batch_id uuid not null references public.season_import_batches(batch_id) on delete cascade,
  row_index integer not null,
  row_data jsonb not null,
  primary key (batch_id, row_index)
);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.season_import_batches'::pg_catalog.regclass
      and constraints.conname = 'season_import_batches_result_object_check'
  ) then
    alter table public.season_import_batches
      add constraint season_import_batches_result_object_check
      check (result is null or pg_catalog.jsonb_typeof(result) = 'object');
  end if;
end;
$$;

alter table public.season_import_batches enable row level security;
alter table public.season_import_batch_rows enable row level security;

create or replace function public.preserve_season_import_batch_staging_metadata_v2()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.result is not null
    and pg_catalog.jsonb_typeof(new.result) <> 'object'
  then
    raise exception 'season_import_batches.result must be null or a JSON object'
      using errcode = '22023';
  end if;

  if old.result ? '_staging' then
    new.result := (
      coalesce(new.result, '{}'::jsonb) - '_staging'
    ) || pg_catalog.jsonb_build_object('_staging', old.result->'_staging');
  end if;

  return new;
end;
$$;

drop trigger if exists preserve_season_import_batch_staging_metadata_v2
  on public.season_import_batches;

create trigger preserve_season_import_batch_staging_metadata_v2
before update of result on public.season_import_batches
for each row
execute function public.preserve_season_import_batch_staging_metadata_v2();

create or replace function public.normalize_seasonal_flight_number_v2(
  p_airline text,
  p_raw text
)
returns table (
  flight_number text,
  raw_flight_number text
)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  with normalized_input as (
    select
      pg_catalog.upper(pg_catalog.btrim(p_airline)) as airline,
      pg_catalog.upper(pg_catalog.btrim(p_raw)) as raw_value
  ), without_airline_prefix as (
    select
      normalized_input.airline,
      case
        when normalized_input.airline <> ''
          and pg_catalog.char_length(normalized_input.raw_value)
            > pg_catalog.char_length(normalized_input.airline)
          and pg_catalog.left(
            normalized_input.raw_value,
            pg_catalog.char_length(normalized_input.airline)
          ) = normalized_input.airline
          then pg_catalog.substr(
            normalized_input.raw_value,
            pg_catalog.char_length(normalized_input.airline) + 1
          )
        else normalized_input.raw_value
      end as flight_part
    from normalized_input
  ), normalized_flight as (
    select
      without_airline_prefix.airline,
      case
        when without_airline_prefix.flight_part ~ '^[0-9]+$'
          and pg_catalog.char_length(without_airline_prefix.flight_part) < 3
          then pg_catalog.repeat(
            '0',
            3 - pg_catalog.char_length(without_airline_prefix.flight_part)
          ) || without_airline_prefix.flight_part
        else without_airline_prefix.flight_part
      end as flight_part
    from without_airline_prefix
  )
  select
    normalized_flight.airline || normalized_flight.flight_part,
    normalized_flight.flight_part
  from normalized_flight
  where normalized_flight.flight_part <> ''
$$;

create or replace function public.seasonal_operational_date_v2(
  p_scheduled_date date,
  p_schedule time
)
returns date
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_schedule < time '05:00' then p_scheduled_date - 1
    else p_scheduled_date
  end
$$;

create or replace function public.seasonal_record_id_v2(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select
    'LEG_'
    || pg_catalog.upper(pg_catalog.btrim(p_type))
    || '_'
    || p_scheduled_date::text
    || '_'
    || pg_catalog.substr(
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            p_season_id
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_type))
            || chr(31)
            || p_scheduled_date::text
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_airline))
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_flight_number)),
            'UTF8'
          )
        ),
        'hex'
      ),
      1,
      32
    )
$$;

create or replace function public.generate_seasonal_import_records_v2(p_batch_id uuid)
returns table (
  record_id text,
  occurrence_key text,
  link_id text,
  type text,
  airline text,
  flight_number text,
  raw_flight_number text,
  route text,
  schedule text,
  aircraft text,
  category text,
  code_shares text,
  int_dom_ind text,
  scheduled_date text,
  operational_date text,
  day_of_week integer,
  source_row_index integer,
  linked_source_row_index integer,
  link_type text,
  pair_anchor_date text,
  linked_record_id text,
  turnaround_id text
)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  with canonical_rows as (
    select
      rows.row_index as staging_row_index,
      coalesce(batches.season_id, 'pending:' || batches.season_code) as season_identity,
      (rows.row_data->>'rowIndex')::integer as source_row_index,
      (rows.row_data->>'effective')::date as effective_date,
      (rows.row_data->>'discontinue')::date as discontinue_date,
      rows.row_data->>'airline' as airline,
      rows.row_data->>'aircraft' as aircraft,
      rows.row_data->'daysOfWeek' as days_of_week,
      rows.row_data->>'sta' as sta,
      rows.row_data->>'arrFlight' as arr_flight,
      rows.row_data->>'arrRoute' as arr_route,
      rows.row_data->>'arrFlightCategory' as arr_category,
      rows.row_data->>'arrCodeShares' as arr_code_shares,
      rows.row_data->>'arrIntDomInd' as arr_int_dom_ind,
      rows.row_data->>'std' as std,
      rows.row_data->>'depFlight' as dep_flight,
      rows.row_data->>'depRoute' as dep_route,
      rows.row_data->>'depFlightCategory' as dep_category,
      rows.row_data->>'depCodeShares' as dep_code_shares,
      rows.row_data->>'depIntDomInd' as dep_int_dom_ind,
      nullif(rows.row_data->>'overnightLinkRowIndex', '')::integer
        as explicit_linked_source_row_index,
      nullif(rows.row_data->>'linkType', '') as source_link_type,
      rows.row_data->>'arrFlight' is not null
        and rows.row_data->>'sta' is not null as has_arrival,
      rows.row_data->>'depFlight' is not null
        and rows.row_data->>'std' is not null as has_departure
    from public.season_import_batch_rows rows
    join public.season_import_batches batches on batches.batch_id = rows.batch_id
    where rows.batch_id = p_batch_id
      and batches.status in ('staged', 'validated')
      and pg_catalog.jsonb_array_length(batches.diagnostics) = 0
  ), generated_dates as (
    select
      canonical_rows.*,
      generated_date::date as source_scheduled_date
    from canonical_rows
    cross join lateral pg_catalog.generate_series(
      canonical_rows.effective_date,
      canonical_rows.discontinue_date,
      interval '1 day'
    ) generated_date
  ), dow_filtered_dates as (
    select generated_dates.*
    from generated_dates
    where (generated_dates.days_of_week->(
      extract(isodow from generated_dates.source_scheduled_date)::integer - 1
    ))::boolean
  ), arr_dep_expansion as (
    select
      dow_filtered_dates.*,
      sides.type,
      sides.raw_flight,
      sides.route,
      sides.schedule,
      sides.category,
      sides.code_shares,
      sides.int_dom_ind
    from dow_filtered_dates
    cross join lateral (
      values
        (
          'A'::text,
          dow_filtered_dates.arr_flight,
          dow_filtered_dates.arr_route,
          dow_filtered_dates.sta,
          dow_filtered_dates.arr_category,
          dow_filtered_dates.arr_code_shares,
          dow_filtered_dates.arr_int_dom_ind,
          dow_filtered_dates.has_arrival
        ),
        (
          'D'::text,
          dow_filtered_dates.dep_flight,
          dow_filtered_dates.dep_route,
          dow_filtered_dates.std,
          dow_filtered_dates.dep_category,
          dow_filtered_dates.dep_code_shares,
          dow_filtered_dates.dep_int_dom_ind,
          dow_filtered_dates.has_departure
        )
    ) sides(type, raw_flight, route, schedule, category, code_shares, int_dom_ind, side_is_present)
    where sides.side_is_present
  ), linked_reference_counts as (
    select
      canonical_rows.explicit_linked_source_row_index as target_source_row_index,
      pg_catalog.count(*)::integer as reference_count
    from canonical_rows
    where canonical_rows.explicit_linked_source_row_index is not null
    group by canonical_rows.explicit_linked_source_row_index
  ), pair_anchor_resolution as (
    select
      arr_dep_expansion.*,
      case
        when arr_dep_expansion.has_arrival and arr_dep_expansion.has_departure
          then case
            when arr_dep_expansion.std::time < arr_dep_expansion.sta::time
              then 'overnight'
            else 'sameday'
          end
        when arr_dep_expansion.explicit_linked_source_row_index is not null
          then coalesce(
            arr_dep_expansion.source_link_type,
            linked_row.source_link_type,
            'overnight'
          )
        else null
      end as resolved_link_type,
      case
        when arr_dep_expansion.has_arrival
          and arr_dep_expansion.has_departure
          and arr_dep_expansion.type = 'D'
          and arr_dep_expansion.std::time < arr_dep_expansion.sta::time
          then arr_dep_expansion.source_scheduled_date + 1
        else arr_dep_expansion.source_scheduled_date
      end as resolved_scheduled_date,
      case
        when arr_dep_expansion.has_arrival and arr_dep_expansion.has_departure
          then arr_dep_expansion.source_scheduled_date
        when arr_dep_expansion.explicit_linked_source_row_index is not null
          and arr_dep_expansion.type = 'D'
          and coalesce(
            arr_dep_expansion.source_link_type,
            linked_row.source_link_type,
            'overnight'
          ) = 'overnight'
          then arr_dep_expansion.source_scheduled_date - 1
        when arr_dep_expansion.explicit_linked_source_row_index is not null
          then arr_dep_expansion.source_scheduled_date
        else null
      end as resolved_pair_anchor_date,
      case
        when arr_dep_expansion.has_arrival and arr_dep_expansion.has_departure
          then arr_dep_expansion.source_row_index
        else arr_dep_expansion.explicit_linked_source_row_index
      end as resolved_linked_source_row_index,
      arr_dep_expansion.has_arrival and arr_dep_expansion.has_departure
        or arr_dep_expansion.explicit_linked_source_row_index is not null as requires_pair,
      case
        when arr_dep_expansion.explicit_linked_source_row_index is null then true
        when linked_row.source_row_index is null then false
        when linked_row.source_row_index = arr_dep_expansion.source_row_index then false
        when linked_row.explicit_linked_source_row_index
          is distinct from arr_dep_expansion.source_row_index then false
        when linked_reference_count.reference_count <> 1 then false
        when arr_dep_expansion.has_arrival = arr_dep_expansion.has_departure then false
        when linked_row.has_arrival = linked_row.has_departure then false
        when arr_dep_expansion.has_arrival = linked_row.has_arrival then false
        when arr_dep_expansion.airline is distinct from linked_row.airline then false
        when arr_dep_expansion.source_link_type is not null
          and linked_row.source_link_type is not null
          and arr_dep_expansion.source_link_type <> linked_row.source_link_type then false
        else true
      end as relationship_is_valid
    from arr_dep_expansion
    left join canonical_rows linked_row
      on linked_row.source_row_index = arr_dep_expansion.explicit_linked_source_row_index
    left join linked_reference_counts linked_reference_count
      on linked_reference_count.target_source_row_index = linked_row.source_row_index
  ), normalized_flight_identity as (
    select
      pair_anchor_resolution.*,
      normalized.flight_number,
      normalized.raw_flight_number,
      public.seasonal_operational_date_v2(
        pair_anchor_resolution.resolved_scheduled_date,
        pair_anchor_resolution.schedule::time
      ) as resolved_operational_date
    from pair_anchor_resolution
    cross join lateral public.normalize_seasonal_flight_number_v2(
      pair_anchor_resolution.airline,
      pair_anchor_resolution.raw_flight
    ) normalized
  ), deterministic_ids as (
    select
      normalized_flight_identity.*,
      public.seasonal_record_id_v2(
        normalized_flight_identity.season_identity,
        normalized_flight_identity.type,
        normalized_flight_identity.resolved_scheduled_date,
        normalized_flight_identity.airline,
        normalized_flight_identity.flight_number
      ) as generated_record_id,
      normalized_flight_identity.season_identity
        || '|'
        || normalized_flight_identity.resolved_scheduled_date::text
        || '|'
        || normalized_flight_identity.airline
        || '|'
        || normalized_flight_identity.flight_number as generated_occurrence_key
    from normalized_flight_identity
  ), counterpart_candidates as (
    select
      source.staging_row_index,
      source.source_row_index,
      source.type,
      source.resolved_scheduled_date,
      source.generated_record_id,
      pg_catalog.min(candidate.generated_record_id) as record_id,
      pg_catalog.min(candidate.generated_occurrence_key) as occurrence_key,
      pg_catalog.count(*)::integer as candidate_count
    from deterministic_ids source
    join deterministic_ids candidate
      on candidate.source_row_index = source.resolved_linked_source_row_index
      and candidate.resolved_linked_source_row_index = source.source_row_index
      and candidate.type <> source.type
      and candidate.resolved_pair_anchor_date = source.resolved_pair_anchor_date
      and candidate.relationship_is_valid
    where source.requires_pair
    group by
      source.staging_row_index,
      source.source_row_index,
      source.type,
      source.resolved_scheduled_date,
      source.generated_record_id
  ), reciprocal_links as (
    select
      deterministic_ids.*,
      counterpart.record_id as counterpart_record_id,
      counterpart.occurrence_key as counterpart_occurrence_key,
      counterpart.candidate_count,
      not deterministic_ids.requires_pair
        or (
          deterministic_ids.relationship_is_valid
          and counterpart.candidate_count = 1
        ) as pair_is_valid,
      case
        when deterministic_ids.requires_pair
          and deterministic_ids.relationship_is_valid
          and counterpart.candidate_count = 1
          then 'TRN_' || pg_catalog.substr(
            pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  deterministic_ids.season_identity
                  || chr(31)
                  || deterministic_ids.resolved_pair_anchor_date::text
                  || chr(31)
                  || least(
                    deterministic_ids.generated_record_id,
                    counterpart.record_id
                  )
                  || chr(31)
                  || greatest(
                    deterministic_ids.generated_record_id,
                    counterpart.record_id
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ),
            1,
            32
          )
        else null
      end as generated_turnaround_id
    from deterministic_ids
    left join counterpart_candidates counterpart
      on counterpart.staging_row_index = deterministic_ids.staging_row_index
      and counterpart.source_row_index = deterministic_ids.source_row_index
      and counterpart.type = deterministic_ids.type
      and counterpart.resolved_scheduled_date = deterministic_ids.resolved_scheduled_date
      and counterpart.generated_record_id = deterministic_ids.generated_record_id
  ), duplicate_key_diagnostics as (
    select
      reciprocal_links.generated_occurrence_key as occurrence_key,
      pg_catalog.count(*)::integer as occurrence_count
    from reciprocal_links
    where reciprocal_links.pair_is_valid
    group by reciprocal_links.generated_occurrence_key
    having pg_catalog.count(*) > 1
  ), committable_records as (
    select reciprocal_links.*
    from reciprocal_links
    left join duplicate_key_diagnostics own_duplicate
      on own_duplicate.occurrence_key = reciprocal_links.generated_occurrence_key
    left join duplicate_key_diagnostics counterpart_duplicate
      on counterpart_duplicate.occurrence_key = reciprocal_links.counterpart_occurrence_key
    where reciprocal_links.pair_is_valid
      and own_duplicate.occurrence_key is null
      and counterpart_duplicate.occurrence_key is null
  )
  select
    committable_records.generated_record_id,
    committable_records.generated_occurrence_key,
    coalesce(
      committable_records.generated_turnaround_id,
      committable_records.generated_record_id
    ),
    committable_records.type,
    committable_records.airline,
    committable_records.flight_number,
    committable_records.raw_flight_number,
    coalesce(committable_records.route, ''),
    committable_records.schedule,
    committable_records.aircraft,
    coalesce(committable_records.category, ''),
    committable_records.code_shares,
    committable_records.int_dom_ind,
    committable_records.resolved_scheduled_date::text,
    committable_records.resolved_operational_date::text,
    extract(dow from committable_records.resolved_scheduled_date)::integer,
    committable_records.source_row_index,
    committable_records.resolved_linked_source_row_index,
    committable_records.resolved_link_type,
    committable_records.resolved_pair_anchor_date::text,
    case
      when committable_records.requires_pair
        then committable_records.counterpart_record_id
      else null
    end,
    committable_records.generated_turnaround_id
  from committable_records
  order by
    committable_records.resolved_scheduled_date,
    committable_records.type,
    committable_records.airline,
    committable_records.flight_number,
    committable_records.source_row_index
$$;

create or replace function public.seasonal_import_generation_diagnostics_v2(
  p_batch_id uuid
)
returns table (
  staging_row_index integer,
  issue_order integer,
  column_name text,
  issue jsonb
)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  with canonical_rows as (
    select
      rows.row_index as staging_row_index,
      coalesce(batches.season_id, 'pending:' || batches.season_code) as season_identity,
      (rows.row_data->>'rowIndex')::integer as source_row_index,
      (rows.row_data->>'effective')::date as effective_date,
      (rows.row_data->>'discontinue')::date as discontinue_date,
      rows.row_data->>'airline' as airline,
      rows.row_data->'daysOfWeek' as days_of_week,
      rows.row_data->>'sta' as sta,
      rows.row_data->>'arrFlight' as arr_flight,
      rows.row_data->>'std' as std,
      rows.row_data->>'depFlight' as dep_flight,
      nullif(rows.row_data->>'overnightLinkRowIndex', '')::integer
        as explicit_linked_source_row_index,
      nullif(rows.row_data->>'linkType', '') as source_link_type,
      rows.row_data->>'arrFlight' is not null
        and rows.row_data->>'sta' is not null as has_arrival,
      rows.row_data->>'depFlight' is not null
        and rows.row_data->>'std' is not null as has_departure
    from public.season_import_batch_rows rows
    join public.season_import_batches batches on batches.batch_id = rows.batch_id
    where rows.batch_id = p_batch_id
  ), linked_reference_counts as (
    select
      canonical_rows.explicit_linked_source_row_index as target_source_row_index,
      pg_catalog.count(*)::integer as reference_count
    from canonical_rows
    where canonical_rows.explicit_linked_source_row_index is not null
    group by canonical_rows.explicit_linked_source_row_index
  ), linked_relationships as (
    select
      canonical_rows.*,
      linked_row.source_row_index as target_source_row_index,
      linked_row.explicit_linked_source_row_index as target_linked_source_row_index,
      linked_row.source_link_type as target_link_type,
      linked_row.airline as target_airline,
      linked_row.has_arrival as target_has_arrival,
      linked_row.has_departure as target_has_departure,
      coalesce(
        canonical_rows.source_link_type,
        linked_row.source_link_type,
        'overnight'
      ) as resolved_link_type,
      linked_reference_count.reference_count,
      linked_row.source_row_index is not null
        and linked_row.source_row_index <> canonical_rows.source_row_index
        and linked_row.explicit_linked_source_row_index = canonical_rows.source_row_index
        and linked_reference_count.reference_count = 1
        and canonical_rows.has_arrival <> canonical_rows.has_departure
        and linked_row.has_arrival <> linked_row.has_departure
        and canonical_rows.has_arrival <> linked_row.has_arrival
        and canonical_rows.airline = linked_row.airline
        and not (
          canonical_rows.source_link_type is not null
          and linked_row.source_link_type is not null
          and canonical_rows.source_link_type <> linked_row.source_link_type
        ) as relationship_is_valid
    from canonical_rows
    left join canonical_rows linked_row
      on linked_row.source_row_index = canonical_rows.explicit_linked_source_row_index
    left join linked_reference_counts linked_reference_count
      on linked_reference_count.target_source_row_index = linked_row.source_row_index
  ), generated_dates as (
    select
      linked_relationships.*,
      generated_date::date as source_scheduled_date
    from linked_relationships
    cross join lateral pg_catalog.generate_series(
      linked_relationships.effective_date,
      linked_relationships.discontinue_date,
      interval '1 day'
    ) generated_date
    where (linked_relationships.days_of_week->(
      extract(isodow from generated_date::date)::integer - 1
    ))::boolean
  ), rows_without_operating_dates as (
    select linked_relationships.*
    from linked_relationships
    where not exists (
      select 1
      from generated_dates
      where generated_dates.staging_row_index = linked_relationships.staging_row_index
    )
  ), explicit_pair_anchors as (
    select
      generated_dates.*,
      case
        when generated_dates.has_arrival then generated_dates.source_scheduled_date
        when generated_dates.resolved_link_type = 'overnight'
          then generated_dates.source_scheduled_date - 1
        else generated_dates.source_scheduled_date
      end as pair_anchor_date
    from generated_dates
    where generated_dates.explicit_linked_source_row_index is not null
      and generated_dates.relationship_is_valid
  ), unmatched_pair_dates as (
    select source_anchor.*
    from explicit_pair_anchors source_anchor
    where not exists (
      select 1
      from explicit_pair_anchors target_anchor
      where target_anchor.source_row_index = source_anchor.explicit_linked_source_row_index
        and target_anchor.explicit_linked_source_row_index = source_anchor.source_row_index
        and target_anchor.pair_anchor_date = source_anchor.pair_anchor_date
    )
  ), arr_dep_expansion as (
    select
      generated_dates.staging_row_index,
      generated_dates.season_identity,
      generated_dates.source_row_index,
      generated_dates.airline,
      sides.type,
      sides.raw_flight,
      case
        when generated_dates.has_arrival
          and generated_dates.has_departure
          and sides.type = 'D'
          and generated_dates.std::time < generated_dates.sta::time
          then generated_dates.source_scheduled_date + 1
        else generated_dates.source_scheduled_date
      end as scheduled_date
    from generated_dates
    cross join lateral (
      values
        ('A'::text, generated_dates.arr_flight, generated_dates.has_arrival),
        ('D'::text, generated_dates.dep_flight, generated_dates.has_departure)
    ) sides(type, raw_flight, side_is_present)
    where sides.side_is_present
  ), normalized_occurrences as (
    select
      arr_dep_expansion.*,
      normalized.flight_number,
      arr_dep_expansion.season_identity
        || '|'
        || arr_dep_expansion.scheduled_date::text
        || '|'
        || arr_dep_expansion.airline
        || '|'
        || normalized.flight_number as occurrence_key
    from arr_dep_expansion
    cross join lateral public.normalize_seasonal_flight_number_v2(
      arr_dep_expansion.airline,
      arr_dep_expansion.raw_flight
    ) normalized
  ), duplicate_occurrences as (
    select
      pg_catalog.min(normalized_occurrences.staging_row_index) as staging_row_index,
      pg_catalog.min(normalized_occurrences.source_row_index) as source_row_index,
      normalized_occurrences.occurrence_key,
      pg_catalog.array_agg(
        distinct normalized_occurrences.source_row_index
        order by normalized_occurrences.source_row_index
      ) as source_row_indexes
    from normalized_occurrences
    group by normalized_occurrences.occurrence_key
    having pg_catalog.count(*) > 1
  ), zero_row_diagnostics as (
    select
      rows_without_operating_dates.staging_row_index,
      190 as issue_order,
      'daysOfWeek'::text as column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', rows_without_operating_dates.source_row_index,
        'stagingRowIndex', rows_without_operating_dates.staging_row_index,
        'code', 'zero-generated-records',
        'column', 'daysOfWeek',
        'message', pg_catalog.format(
          'Row %s: no selected operating day occurs within Effective through Discontinue.',
          rows_without_operating_dates.source_row_index
        )
      ) as issue
    from rows_without_operating_dates
  ), relationship_diagnostics as (
    select
      linked_relationships.staging_row_index,
      relationship_issues.issue_order,
      'overnightLinkRowIndex'::text as column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', linked_relationships.source_row_index,
        'stagingRowIndex', linked_relationships.staging_row_index,
        'code', relationship_issues.issue_code,
        'column', 'overnightLinkRowIndex',
        'message', relationship_issues.issue_message
      ) as issue
    from linked_relationships
    cross join lateral (
      values
        (
          200,
          linked_relationships.explicit_linked_source_row_index is not null
            and linked_relationships.target_source_row_index is null,
          'missing-linked-row',
          pg_catalog.format(
            'Row %s: linked source row %s does not exist.',
            linked_relationships.source_row_index,
            linked_relationships.explicit_linked_source_row_index
          )
        ),
        (
          210,
          linked_relationships.target_source_row_index is not null
            and (
              linked_relationships.target_source_row_index = linked_relationships.source_row_index
              or linked_relationships.target_linked_source_row_index
                is distinct from linked_relationships.source_row_index
              or linked_relationships.reference_count <> 1
            ),
          'ambiguous-pair',
          pg_catalog.format(
            'Row %s: linked source row %s is not a unique reciprocal pair.',
            linked_relationships.source_row_index,
            linked_relationships.explicit_linked_source_row_index
          )
        ),
        (
          220,
          linked_relationships.target_source_row_index is not null
            and (
              linked_relationships.has_arrival = linked_relationships.has_departure
              or linked_relationships.target_has_arrival = linked_relationships.target_has_departure
              or linked_relationships.has_arrival = linked_relationships.target_has_arrival
              or linked_relationships.airline is distinct from linked_relationships.target_airline
            ),
          'incompatible-pair-type',
          pg_catalog.format(
            'Row %s: linked rows must be opposite ARR-only and DEP-only sides for one airline.',
            linked_relationships.source_row_index
          )
        ),
        (
          230,
          linked_relationships.target_source_row_index is not null
            and linked_relationships.source_link_type is not null
            and linked_relationships.target_link_type is not null
            and linked_relationships.source_link_type <> linked_relationships.target_link_type,
          'incompatible-link-type',
          pg_catalog.format(
            'Row %s: linked rows must use the same linkType.',
            linked_relationships.source_row_index
          )
        )
    ) relationship_issues(issue_order, applies, issue_code, issue_message)
    where relationship_issues.applies
  ), pair_date_diagnostics as (
    select
      unmatched_pair_dates.staging_row_index,
      240 as issue_order,
      'daysOfWeek'::text as column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', unmatched_pair_dates.source_row_index,
        'stagingRowIndex', unmatched_pair_dates.staging_row_index,
        'code', 'incompatible-pair-date',
        'column', 'daysOfWeek',
        'message', pg_catalog.format(
          'Row %s: linked row %s has no %s counterpart for pair anchor %s.',
          unmatched_pair_dates.source_row_index,
          unmatched_pair_dates.explicit_linked_source_row_index,
          unmatched_pair_dates.resolved_link_type,
          unmatched_pair_dates.pair_anchor_date
        ),
        'pairAnchorDate', unmatched_pair_dates.pair_anchor_date::text
      ) as issue
    from unmatched_pair_dates
  ), duplicate_diagnostics as (
    select
      duplicate_occurrences.staging_row_index,
      250 as issue_order,
      null::text as column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', duplicate_occurrences.source_row_index,
        'stagingRowIndex', duplicate_occurrences.staging_row_index,
        'code', 'duplicate-occurrence-key',
        'column', null,
        'message', pg_catalog.format(
          'Rows %s generate duplicate occurrence %s.',
          pg_catalog.array_to_string(duplicate_occurrences.source_row_indexes, ', '),
          duplicate_occurrences.occurrence_key
        ),
        'occurrenceKey', duplicate_occurrences.occurrence_key,
        'sourceRowIndexes', pg_catalog.to_jsonb(duplicate_occurrences.source_row_indexes)
      ) as issue
    from duplicate_occurrences
  )
  select * from zero_row_diagnostics
  union all
  select * from relationship_diagnostics
  union all
  select * from pair_date_diagnostics
  union all
  select * from duplicate_diagnostics
$$;

create or replace function public.stage_seasonal_import_v2(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request_id uuid;
  v_request_id_text text;
  v_checksum text;
  v_season_code text;
  v_requested_season_id text;
  v_season_id text;
  v_season_match_count integer := 0;
  v_expected_data_version integer;
  v_file_name text;
  v_source_rows jsonb;
  v_source_row_count integer;
  v_canonical_source_rows jsonb := '[]'::jsonb;
  v_persisted_source_rows jsonb := '[]'::jsonb;
  v_request_fingerprint text;
  v_persisted_request_fingerprint text;
  v_diagnostics jsonb := '[]'::jsonb;
  v_diagnostic_count integer := 0;
  v_generation_diagnostics jsonb := '[]'::jsonb;
  v_generation_diagnostic_count integer := 0;
  v_generated_record_count integer := 0;
  v_oversized_staging_row_index integer;
  v_oversized_column text;
  v_oversized_maximum_length integer;
  v_max_actionable_diagnostics constant integer := 1999;
  v_batch public.season_import_batches%rowtype;
begin
  if not public.app_operator_has_permission('seasonal.write') then
    raise exception 'Missing required permission: seasonal.write'
      using errcode = '42501';
  end if;

  if p_import is null or pg_catalog.jsonb_typeof(p_import) <> 'object' then
    raise exception 'p_import must be a JSON object'
      using errcode = '22023';
  end if;

  if pg_catalog.octet_length(p_import::text) > 67108864 then
    raise exception 'p_import exceeds maximum size of 67108864 bytes'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'requestId') is distinct from 'string' then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'checksum') is distinct from 'string' then
    raise exception 'checksum is required'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_import->'seasonCode') is distinct from 'string' then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if p_import ? 'seasonId'
    and pg_catalog.jsonb_typeof(p_import->'seasonId') not in ('string', 'null')
  then
    raise exception 'seasonId must be a string when provided'
      using errcode = '22023';
  end if;

  if p_import ? 'fileName'
    and pg_catalog.jsonb_typeof(p_import->'fileName') not in ('string', 'null')
  then
    raise exception 'fileName must be a string when provided'
      using errcode = '22023';
  end if;

  v_request_id_text := nullif(pg_catalog.btrim(p_import->>'requestId'), '');
  v_checksum := nullif(pg_catalog.btrim(p_import->>'checksum'), '');
  v_season_code := nullif(pg_catalog.upper(pg_catalog.btrim(p_import->>'seasonCode')), '');
  v_requested_season_id := nullif(pg_catalog.btrim(p_import->>'seasonId'), '');
  v_file_name := coalesce(p_import->>'fileName', '');
  v_source_rows := p_import->'sourceRows';

  if v_request_id_text is null then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  begin
    v_request_id := v_request_id_text::uuid;
  exception
    when invalid_text_representation then
      raise exception 'requestId must be a UUID'
        using errcode = '22023';
  end;

  if v_checksum is null then
    raise exception 'checksum is required'
      using errcode = '22023';
  end if;

  if char_length(v_checksum) > 256 then
    raise exception 'checksum exceeds maximum length of 256'
      using errcode = '22023';
  end if;

  if v_season_code is null then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_season_code) > 32 then
    raise exception 'seasonCode exceeds maximum length of 32'
      using errcode = '22023';
  end if;

  if v_requested_season_id is not null
    and pg_catalog.char_length(v_requested_season_id) > 256
  then
    raise exception 'seasonId exceeds maximum length of 256'
      using errcode = '22023';
  end if;

  if char_length(v_file_name) > 1024 then
    raise exception 'fileName exceeds maximum length of 1024'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_source_rows) is distinct from 'array' then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  v_source_row_count := pg_catalog.jsonb_array_length(v_source_rows);
  if v_source_row_count = 0 then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_source_rows) > 20000 then
    raise exception 'sourceRows exceeds maximum of 20000 rows'
      using errcode = '22023';
  end if;

  if p_import ? 'expectedDataVersion'
    and pg_catalog.jsonb_typeof(p_import->'expectedDataVersion') <> 'null'
  then
    if pg_catalog.jsonb_typeof(p_import->'expectedDataVersion') <> 'number'
      or coalesce(p_import->>'expectedDataVersion', '') !~ '^[0-9]+$'
    then
      raise exception 'expectedDataVersion must be an integer'
        using errcode = '22023';
    end if;

    begin
      v_expected_data_version := (p_import->>'expectedDataVersion')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'expectedDataVersion must be an integer'
          using errcode = '22023';
    end;

    if v_expected_data_version < 0 then
      raise exception 'expectedDataVersion must not be negative'
        using errcode = '22023';
    end if;
  end if;

  select
    (source_rows.ordinality - 1)::integer,
    field_limits.column_name,
    field_limits.maximum_length
  into
    v_oversized_staging_row_index,
    v_oversized_column,
    v_oversized_maximum_length
  from pg_catalog.jsonb_array_elements(v_source_rows)
    with ordinality as source_rows(raw_row, ordinality)
  cross join lateral (
    values
      ('Effective', 'effective', 10),
      ('Discontinue', 'discontinue', 10),
      ('Airline', 'airline', 16),
      ('Aircraft', 'aircraft', 64),
      ('STA', 'sta', 5),
      ('ARRFlight', 'arrFlight', 64),
      ('ARRFlightType', 'arrFlightType', 32),
      ('ARRRoute', 'arrRoute', 512),
      ('ARRFlightCategory', 'arrFlightCategory', 64),
      ('ARRCodeShares', 'arrCodeShares', 4096),
      ('ARRIntDomInd', 'arrIntDomInd', 32),
      ('STD', 'std', 5),
      ('DEPFlight', 'depFlight', 64),
      ('DEPFlightType', 'depFlightType', 32),
      ('DEPRoute', 'depRoute', 512),
      ('DEPFlightCategory', 'depFlightCategory', 64),
      ('DEPCodeShares', 'depCodeShares', 4096),
      ('DEPIntDomInd', 'depIntDomInd', 32),
      ('linkType', 'linkType', 16)
  ) as field_limits(column_name, json_key, maximum_length)
  where pg_catalog.jsonb_typeof(source_rows.raw_row) = 'object'
    and pg_catalog.jsonb_typeof(source_rows.raw_row->field_limits.json_key) = 'string'
    and pg_catalog.char_length(
      pg_catalog.btrim(source_rows.raw_row->>field_limits.json_key)
    ) > field_limits.maximum_length
  order by source_rows.ordinality, field_limits.column_name
  limit 1;

  if found then
    raise exception 'sourceRows[%] canonical source field % exceeds maximum length of %',
      v_oversized_staging_row_index,
      v_oversized_column,
      v_oversized_maximum_length
      using errcode = '22023';
  end if;

  with input_rows as (
    select
      (source_rows.ordinality - 1)::integer as staging_row_index,
      source_rows.raw_row
    from pg_catalog.jsonb_array_elements(v_source_rows)
      with ordinality as source_rows(raw_row, ordinality)
  ), typed_rows as (
    select
      input_rows.*,
      pg_catalog.jsonb_typeof(raw_row) is not distinct from 'object' as row_is_object,
      case
        when pg_catalog.jsonb_typeof(raw_row->'rowIndex') = 'number' then
          (raw_row->>'rowIndex')::numeric = pg_catalog.trunc((raw_row->>'rowIndex')::numeric)
          and (raw_row->>'rowIndex')::numeric between 0 and 999999999
        else false
      end as row_index_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'effective') is not distinct from 'string'
        as effective_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'discontinue') is not distinct from 'string'
        as discontinue_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'airline') is not distinct from 'string'
        as airline_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'aircraft') is not distinct from 'string'
        as aircraft_type_is_valid,
      pg_catalog.jsonb_typeof(raw_row->'daysOfWeek') is not distinct from 'array'
        as days_is_array,
      case
        when pg_catalog.jsonb_typeof(raw_row->'daysOfWeek') = 'array'
          then raw_row->'daysOfWeek'
        else '[]'::jsonb
      end as raw_days,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex'), 'null') = 'null'
          then true
        when pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex') = 'number' then
          (raw_row->>'overnightLinkRowIndex')::numeric
            = pg_catalog.trunc((raw_row->>'overnightLinkRowIndex')::numeric)
          and (raw_row->>'overnightLinkRowIndex')::numeric between 0 and 999999999
        else false
      end as overnight_link_index_type_is_valid,
      coalesce(pg_catalog.jsonb_typeof(raw_row->'linkType'), 'null')
        in ('string', 'null') as link_type_type_is_valid
    from input_rows
  ), normalized_rows as (
    select
      typed_rows.*,
      case
        when row_index_is_valid then (raw_row->>'rowIndex')::integer
        else null
      end as logical_row_index,
      case
        when row_index_is_valid then (raw_row->>'rowIndex')::integer
        else staging_row_index
      end as diagnostic_row_index,
      case
        when effective_type_is_valid
          then nullif(pg_catalog.btrim(raw_row->>'effective'), '')
        else null
      end as effective_value,
      case
        when discontinue_type_is_valid
          then nullif(pg_catalog.btrim(raw_row->>'discontinue'), '')
        else null
      end as discontinue_value,
      case
        when airline_type_is_valid
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'airline')), '')
        else null
      end as airline_value,
      case
        when aircraft_type_is_valid
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'aircraft')), '')
        else null
      end as aircraft_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'sta'), 'null') in ('string', 'null')
          then nullif(pg_catalog.btrim(raw_row->>'sta'), '')
        else null
      end as sta_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlight'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlight')), '')
        else null
      end as arr_flight_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlightType'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlightType')), '')
        else null
      end as arr_flight_type_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrRoute'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrRoute')), '')
        else null
      end as arr_route_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrFlightCategory'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrFlightCategory')), '')
        else null
      end as arr_flight_category_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrCodeShares'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrCodeShares')), '')
        else null
      end as arr_code_shares_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'arrIntDomInd'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'arrIntDomInd')), '')
        else null
      end as arr_int_dom_ind_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'std'), 'null') in ('string', 'null')
          then nullif(pg_catalog.btrim(raw_row->>'std'), '')
        else null
      end as std_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlight'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlight')), '')
        else null
      end as dep_flight_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlightType'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlightType')), '')
        else null
      end as dep_flight_type_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depRoute'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depRoute')), '')
        else null
      end as dep_route_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depFlightCategory'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depFlightCategory')), '')
        else null
      end as dep_flight_category_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depCodeShares'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depCodeShares')), '')
        else null
      end as dep_code_shares_value,
      case
        when coalesce(pg_catalog.jsonb_typeof(raw_row->'depIntDomInd'), 'null') in ('string', 'null')
          then nullif(pg_catalog.upper(pg_catalog.btrim(raw_row->>'depIntDomInd')), '')
        else null
      end as dep_int_dom_ind_value,
      case
        when overnight_link_index_type_is_valid
          and pg_catalog.jsonb_typeof(raw_row->'overnightLinkRowIndex') = 'number'
          then (raw_row->>'overnightLinkRowIndex')::integer
        else null
      end as overnight_link_row_index_value,
      case
        when link_type_type_is_valid
          and pg_catalog.jsonb_typeof(raw_row->'linkType') = 'string'
          then nullif(pg_catalog.lower(pg_catalog.btrim(raw_row->>'linkType')), '')
        else null
      end as link_type_value,
      days_is_array
        and pg_catalog.jsonb_array_length(raw_days) = 7
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(raw_days) as day_values(day_value)
          where pg_catalog.jsonb_typeof(day_value) <> 'boolean'
        ) as days_are_valid
    from typed_rows
  ), date_parts as (
    select
      normalized_rows.*,
      coalesce(
        effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
        false
      ) as effective_shape_is_valid,
      coalesce(
        discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
        false
      ) as discontinue_shape_is_valid,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 1, 4)::integer
        else null
      end as effective_year,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 6, 2)::integer
        else null
      end as effective_month,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(effective_value, 9, 2)::integer
        else null
      end as effective_day,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 1, 4)::integer
        else null
      end as discontinue_year,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 6, 2)::integer
        else null
      end as discontinue_month,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then pg_catalog.substr(discontinue_value, 9, 2)::integer
        else null
      end as discontinue_day
    from normalized_rows
  ), validated_rows as (
    select
      date_parts.*,
      effective_shape_is_valid
        and effective_day <= case effective_month
          when 2 then 28 + case
            when pg_catalog.mod(effective_year, 400) = 0
              or (pg_catalog.mod(effective_year, 4) = 0 and pg_catalog.mod(effective_year, 100) <> 0)
              then 1
            else 0
          end
          when 4 then 30
          when 6 then 30
          when 9 then 30
          when 11 then 30
          else 31
        end as effective_is_valid,
      discontinue_shape_is_valid
        and discontinue_day <= case discontinue_month
          when 2 then 28 + case
            when pg_catalog.mod(discontinue_year, 400) = 0
              or (pg_catalog.mod(discontinue_year, 4) = 0 and pg_catalog.mod(discontinue_year, 100) <> 0)
              then 1
            else 0
          end
          when 4 then 30
          when 6 then 30
          when 9 then 30
          when 11 then 30
          else 31
        end as discontinue_is_valid,
      sta_value is not null or arr_flight_value is not null or arr_route_value is not null
        as has_arrival,
      sta_value is not null and arr_flight_value is not null and arr_route_value is not null
        as has_complete_arrival,
      std_value is not null or dep_flight_value is not null or dep_route_value is not null
        as has_departure,
      std_value is not null and dep_flight_value is not null and dep_route_value is not null
        as has_complete_departure
    from date_parts
  ), counted_rows as (
    select
      validated_rows.*,
      pg_catalog.count(*) over (partition by logical_row_index) as logical_row_index_count
    from validated_rows
  ), canonical_rows as (
    select
      counted_rows.*,
      pg_catalog.jsonb_build_object(
        'rowIndex', logical_row_index,
        'effective', effective_value,
        'discontinue', discontinue_value,
        'airline', airline_value,
        'aircraft', aircraft_value,
        'daysOfWeek', case when days_are_valid then raw_days else '[]'::jsonb end,
        'sta', sta_value,
        'arrFlight', arr_flight_value,
        'arrFlightType', arr_flight_type_value,
        'arrRoute', arr_route_value,
        'arrFlightCategory', arr_flight_category_value,
        'arrCodeShares', arr_code_shares_value,
        'arrIntDomInd', arr_int_dom_ind_value,
        'std', std_value,
        'depFlight', dep_flight_value,
        'depFlightType', dep_flight_type_value,
        'depRoute', dep_route_value,
        'depFlightCategory', dep_flight_category_value,
        'depCodeShares', dep_code_shares_value,
        'depIntDomInd', dep_int_dom_ind_value,
        'overnightLinkRowIndex', overnight_link_row_index_value,
        'linkType', link_type_value
      ) as canonical_row
    from counted_rows
  ), row_diagnostic_items as (
    select
      canonical_rows.staging_row_index,
      row_issues.issue_order,
      row_issues.column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', canonical_rows.diagnostic_row_index,
        'stagingRowIndex', canonical_rows.staging_row_index,
        'code', row_issues.issue_code,
        'column', row_issues.column_name,
        'message', row_issues.issue_message
      ) as issue
    from canonical_rows
    cross join lateral (
      values
        (
          10,
          not canonical_rows.row_is_object,
          'invalid-row',
          null::text,
          pg_catalog.format(
            'Row %s: source row must be a JSON object.',
            canonical_rows.staging_row_index
          )
        ),
        (
          20,
          canonical_rows.row_is_object and not canonical_rows.row_index_is_valid,
          'invalid-row-index',
          'rowIndex',
          pg_catalog.format(
            'Row %s: rowIndex must be a non-negative JSON integer number.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          25,
          canonical_rows.row_is_object
            and canonical_rows.row_index_is_valid
            and canonical_rows.logical_row_index_count > 1,
          'duplicate-row-index',
          'rowIndex',
          pg_catalog.format(
            'Row %s: rowIndex is duplicated within sourceRows.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          30,
          canonical_rows.row_is_object and not canonical_rows.effective_is_valid,
          'invalid-effective-date',
          'Effective',
          pg_catalog.format(
            'Row %s: Effective must be a valid ISO calendar date.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          40,
          canonical_rows.row_is_object and not canonical_rows.discontinue_is_valid,
          'invalid-discontinue-date',
          'Discontinue',
          pg_catalog.format(
            'Row %s: Discontinue must be a valid ISO calendar date.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          50,
          canonical_rows.row_is_object
            and canonical_rows.effective_is_valid
            and canonical_rows.discontinue_is_valid
            and (
              canonical_rows.effective_year * 10000
              + canonical_rows.effective_month * 100
              + canonical_rows.effective_day
            ) > (
              canonical_rows.discontinue_year * 10000
              + canonical_rows.discontinue_month * 100
              + canonical_rows.discontinue_day
            ),
          'reversed-date-range',
          null::text,
          pg_catalog.format(
            'Row %s: Effective must be on or before Discontinue.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          60,
          canonical_rows.row_is_object and not canonical_rows.days_are_valid,
          'invalid-day-value',
          'daysOfWeek',
          pg_catalog.format(
            'Row %s: daysOfWeek must contain exactly seven JSON booleans.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          70,
          canonical_rows.row_is_object
            and canonical_rows.days_are_valid
            and not (canonical_rows.raw_days @> '[true]'::jsonb),
          'no-operating-days',
          null::text,
          pg_catalog.format(
            'Row %s: at least one operating day is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          80,
          canonical_rows.row_is_object
            and canonical_rows.airline_type_is_valid
            and canonical_rows.airline_value is null,
          'missing-airline',
          'Airline',
          pg_catalog.format(
            'Row %s: Airline is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          90,
          canonical_rows.row_is_object
            and canonical_rows.aircraft_type_is_valid
            and canonical_rows.aircraft_value is null,
          'missing-aircraft',
          'Aircraft',
          pg_catalog.format(
            'Row %s: Aircraft is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          100,
          canonical_rows.row_is_object
            and coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'sta'), 'null')
              in ('string', 'null')
            and canonical_rows.sta_value is not null
            and canonical_rows.sta_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',
          'invalid-time',
          'STA',
          pg_catalog.format(
            'Row %s: STA must use HH:mm from 00:00 through 23:59.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          110,
          canonical_rows.row_is_object
            and coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'std'), 'null')
              in ('string', 'null')
            and canonical_rows.std_value is not null
            and canonical_rows.std_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$',
          'invalid-time',
          'STD',
          pg_catalog.format(
            'Row %s: STD must use HH:mm from 00:00 through 23:59.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          120,
          canonical_rows.row_is_object
            and canonical_rows.has_arrival
            and not canonical_rows.has_complete_arrival,
          'incomplete-flight-side',
          'ARR',
          pg_catalog.format(
            'Row %s: ARR must include STA, ARRFlight, and ARRRoute together.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          130,
          canonical_rows.row_is_object
            and canonical_rows.has_departure
            and not canonical_rows.has_complete_departure,
          'incomplete-flight-side',
          'DEP',
          pg_catalog.format(
            'Row %s: DEP must include STD, DEPFlight, and DEPRoute together.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          140,
          canonical_rows.row_is_object
            and not canonical_rows.has_complete_arrival
            and not canonical_rows.has_complete_departure,
          'no-flight-side',
          null::text,
          pg_catalog.format(
            'Row %s: at least one complete ARR or DEP side is required.',
            canonical_rows.diagnostic_row_index
          )
        ),
        (
          150,
          canonical_rows.row_is_object
            and canonical_rows.link_type_type_is_valid
            and canonical_rows.link_type_value is not null
            and canonical_rows.link_type_value not in ('overnight', 'sameday'),
          'invalid-link-type',
          'linkType',
          pg_catalog.format(
            'Row %s: linkType must be overnight or sameday.',
            canonical_rows.diagnostic_row_index
          )
        )
    ) as row_issues(issue_order, applies, issue_code, column_name, issue_message)
    where row_issues.applies
  ), type_diagnostic_items as (
    select
      canonical_rows.staging_row_index,
      75 as issue_order,
      field_types.column_name,
      pg_catalog.jsonb_build_object(
        'rowIndex', canonical_rows.diagnostic_row_index,
        'stagingRowIndex', canonical_rows.staging_row_index,
        'code', 'invalid-field-type',
        'column', field_types.column_name,
        'message', pg_catalog.format(
          'Row %s: %s must be %s.',
          canonical_rows.diagnostic_row_index,
          field_types.column_name,
          field_types.expected_type
        )
      ) as issue
    from canonical_rows
    cross join lateral (
      values
        ('Effective', canonical_rows.effective_type_is_valid, 'a JSON string'),
        ('Discontinue', canonical_rows.discontinue_type_is_valid, 'a JSON string'),
        ('Airline', canonical_rows.airline_type_is_valid, 'a JSON string'),
        ('Aircraft', canonical_rows.aircraft_type_is_valid, 'a JSON string'),
        (
          'STA',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'sta'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlight',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlight'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlightType',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlightType'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRRoute',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrRoute'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRFlightCategory',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrFlightCategory'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRCodeShares',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrCodeShares'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'ARRIntDomInd',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'arrIntDomInd'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'STD',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'std'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlight',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlight'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlightType',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlightType'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPRoute',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depRoute'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPFlightCategory',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depFlightCategory'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPCodeShares',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depCodeShares'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'DEPIntDomInd',
          coalesce(pg_catalog.jsonb_typeof(canonical_rows.raw_row->'depIntDomInd'), 'null')
            in ('string', 'null'),
          'a JSON string, null, or absent'
        ),
        (
          'overnightLinkRowIndex',
          canonical_rows.overnight_link_index_type_is_valid,
          'a non-negative JSON integer number, null, or absent'
        ),
        (
          'linkType',
          canonical_rows.link_type_type_is_valid,
          'a JSON string, null, or absent'
        )
    ) as field_types(column_name, type_is_valid, expected_type)
    where canonical_rows.row_is_object
      and not field_types.type_is_valid
  ), diagnostic_items as (
    select * from row_diagnostic_items
    union all
    select * from type_diagnostic_items
  )
  select
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          canonical_rows.canonical_row
          order by canonical_rows.staging_row_index
        )
        from canonical_rows
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select pg_catalog.jsonb_agg(limited_diagnostics.issue order by limited_diagnostics.item_order)
        from (
          select
            diagnostic_items.issue,
            pg_catalog.row_number() over (
              order by
                diagnostic_items.staging_row_index,
                diagnostic_items.issue_order,
                diagnostic_items.column_name
            ) as item_order
          from diagnostic_items
          order by
            diagnostic_items.staging_row_index,
            diagnostic_items.issue_order,
            diagnostic_items.column_name
          limit v_max_actionable_diagnostics
        ) limited_diagnostics
      ),
      '[]'::jsonb
    ),
    (select pg_catalog.count(*)::integer from diagnostic_items)
  into v_canonical_source_rows, v_diagnostics, v_diagnostic_count;

  if v_diagnostic_count > v_max_actionable_diagnostics then
    v_diagnostics := v_diagnostics || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'rowIndex', null,
        'stagingRowIndex', null,
        'code', 'diagnostics-truncated',
        'column', null,
        'message', pg_catalog.format(
          'Showing the first %s of %s diagnostics. Fix the listed rows and retry.',
          v_max_actionable_diagnostics,
          v_diagnostic_count
        ),
        'shownDiagnostics', v_max_actionable_diagnostics,
        'totalDiagnostics', v_diagnostic_count
      )
    );
  end if;

  -- Block concurrent season inserts/updates until lookup and batch insert finish.
  lock table public.seasons in share mode;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(seasons.id)
  into v_season_match_count, v_season_id
  from public.seasons seasons
  where pg_catalog.upper(pg_catalog.btrim(seasons.season_code)) = v_season_code;

  if v_season_match_count > 1 then
    raise exception 'Ambiguous seasonCode % matched % existing seasons', v_season_code, v_season_match_count
      using errcode = '21000';
  end if;

  if v_requested_season_id is not null
    and (v_season_match_count = 0 or v_season_id is distinct from v_requested_season_id)
  then
    raise exception 'seasonId % does not match seasonCode %', v_requested_season_id, v_season_code
      using errcode = '22023';
  end if;

  v_request_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'fingerprintVersion', 1,
          'sourceRows', v_source_rows,
          'seasonIdentity', pg_catalog.jsonb_build_object(
            'seasonCode', v_season_code,
            'seasonId', v_season_id
          ),
          'expectedDataVersion', v_expected_data_version,
          'fileName', v_file_name
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    file_name,
    checksum,
    status,
    source_row_count,
    diagnostics,
    result
  )
  values (
    v_request_id,
    v_season_id,
    v_season_code,
    v_expected_data_version,
    v_file_name,
    v_checksum,
    case
      when pg_catalog.jsonb_array_length(v_diagnostics) = 0 then 'staged'
      else 'failed'
    end,
    v_source_row_count,
    v_diagnostics,
    pg_catalog.jsonb_build_object(
      '_staging', pg_catalog.jsonb_build_object(
        'fingerprintVersion', 1,
        'requestFingerprint', v_request_fingerprint
      )
    )
  )
  on conflict (request_id) do nothing
  returning * into v_batch;

  if not found then
    select batches.*
    into v_batch
    from public.season_import_batches batches
    where batches.request_id = v_request_id;

    if not found then
      raise exception 'Unable to resolve concurrent seasonal import request %', v_request_id
        using errcode = '40001';
    end if;

    v_persisted_request_fingerprint :=
      v_batch.result #>> '{_staging,requestFingerprint}';

    select coalesce(
      pg_catalog.jsonb_agg(rows.row_data order by rows.row_index),
      '[]'::jsonb
    )
    into v_persisted_source_rows
    from public.season_import_batch_rows rows
    where rows.batch_id = v_batch.batch_id;

    if v_batch.checksum is distinct from v_checksum then
      raise exception 'Import requestId % was already used with a different checksum', v_request_id
        using errcode = '23505';
    end if;

    if v_persisted_request_fingerprint is distinct from v_request_fingerprint then
      raise exception 'Import requestId % was already used with a different payload', v_request_id
        using errcode = '23505';
    end if;

    if v_batch.season_code is distinct from v_season_code
      or v_batch.season_id is distinct from v_season_id
      or v_batch.expected_data_version is distinct from v_expected_data_version
      or v_batch.file_name is distinct from v_file_name
      or v_persisted_source_rows is distinct from v_canonical_source_rows
    then
      raise exception 'Import requestId % was already used with a different payload', v_request_id
        using errcode = '23505';
    end if;

    return pg_catalog.jsonb_build_object(
      'batchId', v_batch.batch_id,
      'status', v_batch.status,
      'sourceRowCount', v_batch.source_row_count,
      'generatedRecordCount', v_batch.generated_record_count,
      'diagnostics', v_batch.diagnostics,
      'valid', v_batch.status in ('validated', 'committed')
        and pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
    );
  end if;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select
    v_batch.batch_id,
    (source_rows.ordinality - 1)::integer,
    source_rows.row_data
  from pg_catalog.jsonb_array_elements(v_canonical_source_rows)
    with ordinality as source_rows(row_data, ordinality);

  if v_batch.status = 'staged' then
    select
      pg_catalog.count(*)::integer,
      coalesce(
      pg_catalog.jsonb_agg(
        ranked_diagnostics.issue
        order by
            ranked_diagnostics.staging_row_index,
            ranked_diagnostics.issue_order,
            ranked_diagnostics.column_name
        ) filter (
          where ranked_diagnostics.diagnostic_rank <= v_max_actionable_diagnostics
        ),
        '[]'::jsonb
      )
    into v_generation_diagnostic_count, v_generation_diagnostics
    from (
      select
        diagnostics.*,
        pg_catalog.row_number() over (
          order by
            diagnostics.staging_row_index,
            diagnostics.issue_order,
            diagnostics.column_name
        ) as diagnostic_rank
      from public.seasonal_import_generation_diagnostics_v2(v_batch.batch_id) diagnostics
    ) ranked_diagnostics;

    if v_generation_diagnostic_count > v_max_actionable_diagnostics then
      v_generation_diagnostics := v_generation_diagnostics || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', null,
          'stagingRowIndex', null,
          'code', 'diagnostics-truncated',
          'column', null,
          'message', pg_catalog.format(
            'Showing the first %s of %s generation diagnostics. Fix the listed rows and retry.',
            v_max_actionable_diagnostics,
            v_generation_diagnostic_count
          ),
          'shownDiagnostics', v_max_actionable_diagnostics,
          'totalDiagnostics', v_generation_diagnostic_count
        )
      );
    end if;

    select pg_catalog.count(*)::integer
    into v_generated_record_count
    from public.generate_seasonal_import_records_v2(v_batch.batch_id);

    if v_generated_record_count = 0 and v_generation_diagnostic_count = 0 then
      v_generation_diagnostics := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', null,
          'stagingRowIndex', null,
          'code', 'zero-generated-records',
          'column', null,
          'message', 'The canonical source rows do not generate any flight occurrences.'
        )
      );
      v_generation_diagnostic_count := 1;
    end if;

    v_diagnostics := v_batch.diagnostics || v_generation_diagnostics;

    update public.season_import_batches batches
    set
      status = case
        when v_generated_record_count > 0
          and v_generation_diagnostic_count = 0
          then 'validated'
        else 'failed'
      end,
      generated_record_count = v_generated_record_count,
      diagnostics = v_diagnostics
    where batches.batch_id = v_batch.batch_id
    returning batches.* into v_batch;
  end if;

  return pg_catalog.jsonb_build_object(
    'batchId', v_batch.batch_id,
    'status', v_batch.status,
    'sourceRowCount', v_batch.source_row_count,
    'generatedRecordCount', v_batch.generated_record_count,
    'diagnostics', v_batch.diagnostics,
    'valid', v_batch.status in ('validated', 'committed')
      and pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
  );
end;
$$;

revoke all on table public.season_import_batches from public, anon, authenticated;
revoke all on table public.season_import_batch_rows from public, anon, authenticated;

revoke execute on function public.preserve_season_import_batch_staging_metadata_v2()
  from public, anon, authenticated;
revoke execute on function public.normalize_seasonal_flight_number_v2(text, text)
  from public, anon, authenticated;
revoke execute on function public.seasonal_operational_date_v2(date, time)
  from public, anon, authenticated;
revoke execute on function public.seasonal_record_id_v2(text, text, date, text, text)
  from public, anon, authenticated;
revoke execute on function public.generate_seasonal_import_records_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.seasonal_import_generation_diagnostics_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from public;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated;
