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
  v_diagnostics jsonb := '[]'::jsonb;
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

  if pg_catalog.jsonb_array_length(v_source_rows) > 100000 then
    raise exception 'sourceRows exceeds maximum of 100000 rows'
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
        select pg_catalog.jsonb_agg(
          diagnostic_items.issue
          order by
            diagnostic_items.staging_row_index,
            diagnostic_items.issue_order,
            diagnostic_items.column_name
        )
        from diagnostic_items
      ),
      '[]'::jsonb
    )
  into v_canonical_source_rows, v_diagnostics;

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

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    file_name,
    checksum,
    status,
    source_row_count,
    diagnostics
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
    v_diagnostics
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

    if v_batch.season_code is distinct from v_season_code
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
      'diagnostics', v_batch.diagnostics,
      'valid', pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
    );
  end if;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select
    v_batch.batch_id,
    (source_rows.ordinality - 1)::integer,
    source_rows.row_data
  from pg_catalog.jsonb_array_elements(v_canonical_source_rows)
    with ordinality as source_rows(row_data, ordinality);

  return pg_catalog.jsonb_build_object(
    'batchId', v_batch.batch_id,
    'status', v_batch.status,
    'sourceRowCount', v_batch.source_row_count,
    'diagnostics', v_batch.diagnostics,
    'valid', pg_catalog.jsonb_array_length(v_batch.diagnostics) = 0
  );
end;
$$;

revoke all on table public.season_import_batches from public, anon, authenticated;
revoke all on table public.season_import_batch_rows from public, anon, authenticated;

revoke execute on function public.stage_seasonal_import_v2(jsonb) from public;
revoke execute on function public.stage_seasonal_import_v2(jsonb) from anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated;
