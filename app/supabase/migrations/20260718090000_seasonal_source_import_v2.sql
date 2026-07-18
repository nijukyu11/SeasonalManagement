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

alter table public.season_import_batches enable row level security;
alter table public.season_import_batch_rows enable row level security;

create or replace function public.stage_seasonal_import_v2(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
  v_request_id_text text;
  v_checksum text;
  v_season_code text;
  v_requested_season_id text;
  v_season_id text;
  v_expected_data_version integer;
  v_file_name text;
  v_source_rows jsonb;
  v_diagnostics jsonb := '[]'::jsonb;
  v_batch public.season_import_batches%rowtype;
begin
  if not public.app_operator_has_permission('seasonal.write') then
    raise exception 'Missing required permission: seasonal.write'
      using errcode = '42501';
  end if;

  if p_import is null or jsonb_typeof(p_import) <> 'object' then
    raise exception 'p_import must be a JSON object'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_import->'requestId') is distinct from 'string' then
    raise exception 'requestId is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_import->'checksum') is distinct from 'string' then
    raise exception 'checksum is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_import->'seasonCode') is distinct from 'string' then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if p_import ? 'seasonId'
    and jsonb_typeof(p_import->'seasonId') not in ('string', 'null')
  then
    raise exception 'seasonId must be a string when provided'
      using errcode = '22023';
  end if;

  if p_import ? 'fileName'
    and jsonb_typeof(p_import->'fileName') not in ('string', 'null')
  then
    raise exception 'fileName must be a string when provided'
      using errcode = '22023';
  end if;

  v_request_id_text := nullif(btrim(p_import->>'requestId'), '');
  v_checksum := nullif(btrim(p_import->>'checksum'), '');
  v_season_code := nullif(upper(btrim(p_import->>'seasonCode')), '');
  v_requested_season_id := nullif(btrim(p_import->>'seasonId'), '');
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

  if v_season_code is null then
    raise exception 'seasonCode is required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_source_rows) is distinct from 'array' then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  if jsonb_array_length(v_source_rows) = 0 then
    raise exception 'sourceRows must be a non-empty JSON array'
      using errcode = '22023';
  end if;

  if p_import ? 'expectedDataVersion'
    and jsonb_typeof(p_import->'expectedDataVersion') <> 'null'
  then
    if jsonb_typeof(p_import->'expectedDataVersion') <> 'number'
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

  if v_requested_season_id is not null then
    select seasons.id
    into v_season_id
    from public.seasons
    where seasons.id = v_requested_season_id
      and upper(seasons.season_code) = v_season_code;

    if not found then
      raise exception 'seasonId % does not match seasonCode %', v_requested_season_id, v_season_code
        using errcode = '22023';
    end if;
  else
    select seasons.id
    into v_season_id
    from public.seasons
    where upper(seasons.season_code) = v_season_code;
  end if;

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    file_name,
    checksum,
    status,
    source_row_count
  )
  values (
    v_request_id,
    v_season_id,
    v_season_code,
    v_expected_data_version,
    v_file_name,
    v_checksum,
    'staged',
    jsonb_array_length(v_source_rows)
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

    if v_batch.created_by is distinct from auth.uid() then
      raise exception 'Import requestId belongs to another operator'
        using errcode = '42501';
    end if;

    if v_batch.checksum is distinct from v_checksum then
      raise exception 'Import requestId % was already used with a different checksum', v_request_id
        using errcode = '23505';
    end if;

    return jsonb_build_object(
      'batchId', v_batch.batch_id,
      'status', v_batch.status,
      'sourceRowCount', v_batch.source_row_count,
      'diagnostics', v_batch.diagnostics,
      'valid', jsonb_array_length(v_batch.diagnostics) = 0
    );
  end if;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select
    v_batch.batch_id,
    (source_rows.ordinality - 1)::integer,
    source_rows.row_data
  from jsonb_array_elements(v_source_rows) with ordinality as source_rows(row_data, ordinality);

  with raw_rows as (
    select
      rows.row_index as staging_row_index,
      rows.row_data,
      jsonb_typeof(rows.row_data) = 'object' as row_is_object,
      case
        when coalesce(rows.row_data->>'rowIndex', '') ~ '^[0-9]{1,9}$'
          then (rows.row_data->>'rowIndex')::integer
        else rows.row_index
      end as diagnostic_row_index,
      coalesce(rows.row_data->>'rowIndex', '') ~ '^[0-9]{1,9}$' as row_index_is_valid,
      nullif(btrim(rows.row_data->>'effective'), '') as effective_value,
      nullif(btrim(rows.row_data->>'discontinue'), '') as discontinue_value,
      nullif(btrim(rows.row_data->>'airline'), '') as airline_value,
      nullif(btrim(rows.row_data->>'aircraft'), '') as aircraft_value,
      nullif(btrim(rows.row_data->>'sta'), '') as sta_value,
      nullif(btrim(rows.row_data->>'arrFlight'), '') as arr_flight_value,
      nullif(btrim(rows.row_data->>'arrRoute'), '') as arr_route_value,
      nullif(btrim(rows.row_data->>'std'), '') as std_value,
      nullif(btrim(rows.row_data->>'depFlight'), '') as dep_flight_value,
      nullif(btrim(rows.row_data->>'depRoute'), '') as dep_route_value,
      case
        when jsonb_typeof(rows.row_data->'daysOfWeek') = 'array'
          then rows.row_data->'daysOfWeek'
        else '[]'::jsonb
      end as days_value,
      jsonb_typeof(rows.row_data->'daysOfWeek') = 'array' as days_is_array
    from public.season_import_batch_rows rows
    where rows.batch_id = v_batch.batch_id
  ), validated_rows as (
    select
      raw_rows.*,
      case
        when effective_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then to_char(to_date(effective_value, 'FXYYYY-MM-DD'), 'YYYY-MM-DD') = effective_value
        else false
      end as effective_is_valid,
      case
        when discontinue_value ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          then to_char(to_date(discontinue_value, 'FXYYYY-MM-DD'), 'YYYY-MM-DD') = discontinue_value
        else false
      end as discontinue_is_valid,
      days_is_array
        and jsonb_array_length(days_value) = 7
        and not exists (
          select 1
          from jsonb_array_elements(days_value) day_value
          where jsonb_typeof(day_value) <> 'boolean'
        ) as days_are_valid,
      sta_value is not null or arr_flight_value is not null or arr_route_value is not null as has_arrival,
      sta_value is not null and arr_flight_value is not null and arr_route_value is not null as has_complete_arrival,
      std_value is not null or dep_flight_value is not null or dep_route_value is not null as has_departure,
      std_value is not null and dep_flight_value is not null and dep_route_value is not null as has_complete_departure
    from raw_rows
  ), diagnostic_items as (
    select staging_row_index, 10 as issue_order, jsonb_build_object(
      'rowIndex', staging_row_index,
      'code', 'invalid-row',
      'column', null,
      'message', format('Row %s: source row must be a JSON object.', staging_row_index)
    ) as issue
    from validated_rows
    where not row_is_object

    union all

    select staging_row_index, 20, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-row-index',
      'column', 'rowIndex',
      'message', format('Row %s: rowIndex must be a non-negative integer.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and not row_index_is_valid

    union all

    select staging_row_index, 30, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-effective-date',
      'column', 'Effective',
      'message', format('Row %s: Effective must be a valid ISO date.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and not effective_is_valid

    union all

    select staging_row_index, 40, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-discontinue-date',
      'column', 'Discontinue',
      'message', format('Row %s: Discontinue must be a valid ISO date.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and not discontinue_is_valid

    union all

    select staging_row_index, 50, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'reversed-date-range',
      'column', null,
      'message', format('Row %s: Effective must be on or before Discontinue.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object
      and effective_is_valid
      and discontinue_is_valid
      and effective_value > discontinue_value

    union all

    select staging_row_index, 60, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-day-value',
      'column', 'daysOfWeek',
      'message', format('Row %s: daysOfWeek must contain exactly seven booleans.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and not days_are_valid

    union all

    select staging_row_index, 70, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'no-operating-days',
      'column', null,
      'message', format('Row %s: at least one operating day is required.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object
      and days_are_valid
      and not (days_value @> '[true]'::jsonb)

    union all

    select staging_row_index, 80, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'missing-airline',
      'column', 'Airline',
      'message', format('Row %s: Airline is required.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and airline_value is null

    union all

    select staging_row_index, 90, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'missing-aircraft',
      'column', 'Aircraft',
      'message', format('Row %s: Aircraft is required.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and aircraft_value is null

    union all

    select staging_row_index, 100, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-time',
      'column', 'STA',
      'message', format('Row %s: STA must use HH:mm from 00:00 through 23:59.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object
      and sta_value is not null
      and sta_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'

    union all

    select staging_row_index, 110, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'invalid-time',
      'column', 'STD',
      'message', format('Row %s: STD must use HH:mm from 00:00 through 23:59.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object
      and std_value is not null
      and std_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'

    union all

    select staging_row_index, 120, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'incomplete-flight-side',
      'column', 'ARR',
      'message', format('Row %s: ARR must include STA, ARRFlight, and ARRRoute together.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and has_arrival and not has_complete_arrival

    union all

    select staging_row_index, 130, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'incomplete-flight-side',
      'column', 'DEP',
      'message', format('Row %s: DEP must include STD, DEPFlight, and DEPRoute together.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and has_departure and not has_complete_departure

    union all

    select staging_row_index, 140, jsonb_build_object(
      'rowIndex', diagnostic_row_index,
      'code', 'no-flight-side',
      'column', null,
      'message', format('Row %s: at least one complete ARR or DEP side is required.', diagnostic_row_index)
    )
    from validated_rows
    where row_is_object and not has_complete_arrival and not has_complete_departure
  )
  select coalesce(jsonb_agg(issue order by staging_row_index, issue_order), '[]'::jsonb)
  into v_diagnostics
  from diagnostic_items;

  update public.season_import_batches
  set diagnostics = v_diagnostics,
      status = case
        when jsonb_array_length(v_diagnostics) = 0 then 'staged'
        else 'failed'
      end
  where batch_id = v_batch.batch_id
  returning * into v_batch;

  return jsonb_build_object(
    'batchId', v_batch.batch_id,
    'status', v_batch.status,
    'sourceRowCount', v_batch.source_row_count,
    'diagnostics', v_batch.diagnostics,
    'valid', jsonb_array_length(v_batch.diagnostics) = 0
  );
end;
$$;

revoke all on table public.season_import_batches from public, anon, authenticated;
revoke all on table public.season_import_batch_rows from public, anon, authenticated;

revoke execute on function public.stage_seasonal_import_v2(jsonb) from public;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated;
