create table if not exists public.season_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  client_id text not null,
  season_id text references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer,
  file_name text not null default '',
  uploaded_at bigint not null default 0,
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

create index if not exists idx_season_flight_records_occurrence_lookup
  on public.season_flight_records (season_id, scheduled_date, airline, flight_number, type);
create index if not exists idx_season_flight_records_operational_date
  on public.season_flight_records (season_id, operational_date);
create index if not exists idx_season_flight_records_turnaround
  on public.season_flight_records (season_id, turnaround_id)
  where turnaround_id is not null;

alter table public.season_import_batches enable row level security;
alter table public.season_import_batch_rows enable row level security;
revoke all on public.season_import_batches from anon, authenticated;
revoke all on public.season_import_batch_rows from anon, authenticated;

create or replace function public.normalize_seasonal_flight_number_v2(p_airline text, p_raw text)
returns table (flight_number text, raw_flight_number text)
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select
      upper(regexp_replace(coalesce(p_airline, ''), '[^A-Za-z0-9]', '', 'g')) as airline,
      upper(regexp_replace(coalesce(p_raw, ''), '\s+', '', 'g')) as raw_value
  ), stripped as (
    select airline, raw_value,
      case when airline <> '' and raw_value like airline || '%' then substr(raw_value, length(airline) + 1) else raw_value end as suffix
    from normalized
  )
  select
    airline || case
      when suffix ~ '^\d+$' and length(suffix) < 3 then lpad(suffix, 3, '0')
      else suffix
    end,
    raw_value
  from stripped
$$;

create or replace function public.seasonal_operational_date_v2(p_scheduled_date date, p_schedule time)
returns date
language sql
immutable
as $$
  select case when p_schedule < time '05:00' then p_scheduled_date - 1 else p_scheduled_date end
$$;

create or replace function public.seasonal_record_id_v2(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
) returns text
language sql
immutable
as $$
  select 'LEG_' || upper(p_type) || '_' || to_char(p_scheduled_date, 'YYYY-MM-DD') || '_' || substr(md5(
    coalesce(p_season_id, '') || '|' || upper(p_type) || '|' || p_scheduled_date::text || '|' || upper(p_airline) || '|' || upper(p_flight_number)
  ), 1, 20)
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
security definer
set search_path = public
as $$
  with batch as (
    select b.batch_id, coalesce(b.season_id, 'pending:' || b.batch_id::text) as identity_season_id
    from public.season_import_batches b where b.batch_id = p_batch_id
  ), canonical_rows as (
    select r.batch_id, r.row_index, r.row_data,
      case when r.row_data->>'effective' ~ '^\d{4}-\d{2}-\d{2}$' then (r.row_data->>'effective')::date else to_date(r.row_data->>'effective', 'DD-Mon-YY') end as effective_date,
      case when r.row_data->>'discontinue' ~ '^\d{4}-\d{2}-\d{2}$' then (r.row_data->>'discontinue')::date else to_date(r.row_data->>'discontinue', 'DD-Mon-YY') end as discontinue_date
    from public.season_import_batch_rows r where r.batch_id = p_batch_id
  ), operating_days as (
    select rows.*, day_value::date as anchor_date
    from canonical_rows rows
    cross join lateral generate_series(rows.effective_date, rows.discontinue_date, interval '1 day') day_value
    where coalesce((rows.row_data->'daysOfWeek'->>(extract(isodow from day_value)::integer - 1))::boolean, false)
  ), side_expansion as (
    select days.*,
      side.side_name,
      side.type,
      side.schedule,
      side.raw_flight,
      side.route,
      side.category,
      side.code_shares,
      side.int_dom_ind,
      case
        when side.type = 'D'
          and nullif(days.row_data->>'arrFlight', '') is not null
          and coalesce(nullif(days.row_data->>'linkType', ''),
            case when (days.row_data->>'std')::time < (days.row_data->>'sta')::time then 'overnight' else 'sameday' end
          ) = 'overnight'
        then days.anchor_date + 1
        else days.anchor_date
      end as scheduled_day,
      coalesce(
        nullif(days.row_data->>'linkType', ''),
        case when nullif(days.row_data->>'arrFlight', '') is not null and nullif(days.row_data->>'depFlight', '') is not null
          then case when (days.row_data->>'std')::time < (days.row_data->>'sta')::time then 'overnight' else 'sameday' end
          else null end
      ) as resolved_link_type,
      case
        when nullif(days.row_data->>'arrFlight', '') is not null and nullif(days.row_data->>'depFlight', '') is not null then days.row_index
        when nullif(days.row_data->>'overnightLinkRowIndex', '') is not null then least(days.row_index, (days.row_data->>'overnightLinkRowIndex')::integer)
        else null
      end as link_group
    from operating_days days
    cross join lateral (
      values
        ('ARR', 'A', days.row_data->>'sta', days.row_data->>'arrFlight', days.row_data->>'arrRoute', days.row_data->>'arrFlightCategory', days.row_data->>'arrCodeShares', days.row_data->>'arrIntDomInd'),
        ('DEP', 'D', days.row_data->>'std', days.row_data->>'depFlight', days.row_data->>'depRoute', days.row_data->>'depFlightCategory', days.row_data->>'depCodeShares', days.row_data->>'depIntDomInd')
    ) side(side_name, type, schedule, raw_flight, route, category, code_shares, int_dom_ind)
    where nullif(side.raw_flight, '') is not null and nullif(side.schedule, '') is not null
  ), normalized as (
    select sides.*, numbers.flight_number, numbers.raw_flight_number,
      upper(regexp_replace(sides.row_data->>'airline', '[^A-Za-z0-9]', '', 'g')) as airline,
      (sides.schedule)::time as schedule_time
    from side_expansion sides
    cross join lateral public.normalize_seasonal_flight_number_v2(sides.row_data->>'airline', sides.raw_flight) numbers
  ), identified as (
    select normalized.*,
      public.seasonal_record_id_v2(batch.identity_season_id, normalized.type, normalized.scheduled_day, normalized.airline, normalized.flight_number) as generated_id,
      normalized.type || '|' || normalized.scheduled_day::text || '|' || normalized.airline || '|' || normalized.flight_number as generated_occurrence_key,
      case when normalized.link_group is null then '' else 'PAIR_' || substr(md5(batch.identity_season_id || '|' || normalized.anchor_date::text || '|' || normalized.link_group::text), 1, 20) end as generated_link_id,
      case when normalized.link_group is null then null else 'TRN_' || substr(md5(batch.identity_season_id || '|' || normalized.anchor_date::text || '|' || normalized.link_group::text), 1, 20) end as generated_turnaround_id
    from normalized cross join batch
  )
  select
    identified.generated_id,
    identified.generated_occurrence_key,
    identified.generated_link_id,
    identified.type,
    identified.airline,
    identified.flight_number,
    identified.raw_flight_number,
    coalesce(identified.route, ''),
    identified.schedule,
    coalesce(identified.row_data->>'aircraft', ''),
    coalesce(identified.category, 'PAX'),
    nullif(identified.code_shares, ''),
    nullif(identified.int_dom_ind, ''),
    identified.scheduled_day::text,
    public.seasonal_operational_date_v2(identified.scheduled_day, identified.schedule_time)::text,
    extract(isodow from identified.scheduled_day)::integer,
    identified.row_index,
    nullif(identified.row_data->>'overnightLinkRowIndex', '')::integer,
    identified.resolved_link_type,
    identified.anchor_date::text,
    counterpart.generated_id,
    identified.generated_turnaround_id
  from identified
  left join identified counterpart
    on counterpart.anchor_date = identified.anchor_date
   and counterpart.link_group = identified.link_group
   and counterpart.type <> identified.type
   and identified.link_group is not null
$$;

create or replace function public.stage_seasonal_import_v2(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_batch public.season_import_batches%rowtype;
  staged_batch public.season_import_batches%rowtype;
  diagnostics jsonb := '[]'::jsonb;
  duplicate_diagnostics jsonb := '[]'::jsonb;
  generated_count integer := 0;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.write') then
    raise exception 'seasonal.write permission required' using errcode = '42501';
  end if;
  if nullif(p_import->>'requestId', '') is null
     or nullif(p_import->>'clientId', '') is null
     or nullif(p_import->>'checksum', '') is null
     or nullif(p_import->>'seasonCode', '') is null
     or jsonb_typeof(p_import->'sourceRows') <> 'array'
     or jsonb_array_length(p_import->'sourceRows') = 0 then
    raise exception 'requestId, clientId, checksum, seasonCode, and non-empty sourceRows are required' using errcode = '22023';
  end if;

  select * into existing_batch from public.season_import_batches where request_id = (p_import->>'requestId')::uuid;
  if found then
    if existing_batch.checksum <> p_import->>'checksum' then
      raise exception 'requestId was already used with a different checksum' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'batchId', existing_batch.batch_id, 'status', existing_batch.status,
      'sourceRowCount', existing_batch.source_row_count, 'diagnostics', existing_batch.diagnostics,
      'generatedCount', existing_batch.generated_record_count,
      'duplicateCount', (select count(*) from jsonb_array_elements(existing_batch.diagnostics) item where item->>'code' = 'duplicate-occurrence'),
      'valid', existing_batch.status in ('validated', 'committed')
    );
  end if;

  insert into public.season_import_batches (
    request_id, client_id, season_id, season_code, expected_data_version, file_name, uploaded_at,
    checksum, status, source_row_count, created_by
  ) values (
    (p_import->>'requestId')::uuid, p_import->>'clientId', nullif(p_import->>'seasonId', ''), upper(p_import->>'seasonCode'),
    nullif(p_import->>'expectedDataVersion', '')::integer, coalesce(p_import->>'fileName', ''), coalesce((p_import->>'uploadedAt')::bigint, 0),
    p_import->>'checksum', 'staged', jsonb_array_length(p_import->'sourceRows'), auth.uid()
  ) returning * into staged_batch;

  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  select staged_batch.batch_id, coalesce((row_value->>'rowIndex')::integer, ordinal::integer), row_value
  from jsonb_array_elements(p_import->'sourceRows') with ordinality rows(row_value, ordinal);

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', 'invalid-source-row', 'rowIndex', rows.row_index,
    'message', 'Required canonical source-row fields are missing or invalid.'
  ) order by rows.row_index), '[]'::jsonb)
  into diagnostics
  from public.season_import_batch_rows rows
  where rows.batch_id = staged_batch.batch_id
    and (
      nullif(rows.row_data->>'effective', '') is null
      or nullif(rows.row_data->>'discontinue', '') is null
      or nullif(rows.row_data->>'airline', '') is null
      or nullif(rows.row_data->>'aircraft', '') is null
      or jsonb_typeof(rows.row_data->'daysOfWeek') <> 'array'
      or jsonb_array_length(rows.row_data->'daysOfWeek') <> 7
      or (
        nullif(rows.row_data->>'arrFlight', '') is null
        and nullif(rows.row_data->>'depFlight', '') is null
      )
    );

  if jsonb_array_length(diagnostics) = 0 then
    select count(*) into generated_count from public.generate_seasonal_import_records_v2(staged_batch.batch_id);
    select coalesce(jsonb_agg(jsonb_build_object(
      'code', 'duplicate-occurrence', 'occurrenceKey', duplicates.occurrence_key,
      'message', 'Multiple source rows generate the same flight occurrence.'
    )), '[]'::jsonb)
    into duplicate_diagnostics
    from (
      select occurrence_key from public.generate_seasonal_import_records_v2(staged_batch.batch_id)
      group by occurrence_key having count(*) > 1
    ) duplicates;
    diagnostics := diagnostics || duplicate_diagnostics;
    if generated_count = 0 then
      diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code', 'zero-generated-records', 'message', 'Source rows generate no flights.'));
    end if;
  end if;

  update public.season_import_batches
  set generated_record_count = generated_count,
      diagnostics = diagnostics,
      status = case when jsonb_array_length(diagnostics) = 0 then 'validated' else 'failed' end
  where batch_id = staged_batch.batch_id
  returning * into staged_batch;

  return jsonb_build_object(
    'batchId', staged_batch.batch_id, 'status', staged_batch.status,
    'sourceRowCount', staged_batch.source_row_count, 'diagnostics', staged_batch.diagnostics,
    'generatedCount', staged_batch.generated_record_count,
    'duplicateCount', (select count(*) from jsonb_array_elements(staged_batch.diagnostics) item where item->>'code' = 'duplicate-occurrence'),
    'valid', staged_batch.status = 'validated'
  );
end;
$$;

create or replace function public.commit_seasonal_import_v2(p_batch_id uuid, p_expected_data_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch public.season_import_batches%rowtype;
  season_row public.seasons%rowtype;
  next_version integer;
  server_high_water bigint;
  removed_count integer := 0;
  preserved_count integer := 0;
  committed_source_count integer;
  committed_record_count integer;
  success_result jsonb;
  created_new_season boolean := false;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.write') then
    raise exception 'seasonal.write permission required' using errcode = '42501';
  end if;
  select * into batch from public.season_import_batches where batch_id = p_batch_id for update;
  if not found then raise exception 'Import batch % not found', p_batch_id using errcode = 'P0002'; end if;
  if batch.status = 'committed' then return batch.result; end if;
  if batch.status <> 'validated' or jsonb_array_length(batch.diagnostics) > 0 then
    raise exception 'Import batch % is not validated', p_batch_id using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(coalesce(batch.season_id, batch.season_code), 0));
  if batch.season_id is null then
    created_new_season := true;
    insert into public.seasons (
      season_code, name, file_name, uploaded_at, effective_start, effective_end,
      total_legs, total_source_rows, data_version, last_synced_at
    ) values (batch.season_code, batch.season_code, batch.file_name, batch.uploaded_at, '', '', 0, 0, 0, batch.uploaded_at)
    returning * into season_row;
    update public.season_import_batches set season_id = season_row.id where batch_id = p_batch_id;
    batch.season_id := season_row.id;
  else
    select * into season_row from public.seasons where id = batch.season_id for update;
    if not found then raise exception 'Season % not found', batch.season_id using errcode = 'P0002'; end if;
  end if;
  if not created_new_season and p_expected_data_version is distinct from season_row.data_version then
    raise exception 'Season data version changed from % to %', p_expected_data_version, season_row.data_version using errcode = '40001';
  end if;

  drop table if exists pg_temp.import_generated_records;
  create temporary table import_generated_records on commit drop as
    select * from public.generate_seasonal_import_records_v2(p_batch_id);
  create unique index on import_generated_records(occurrence_key);

  if exists (
    select 1 from import_generated_records generated
    join public.season_flight_records existing
      on existing.season_id = batch.season_id and existing.source_kind = 'added'
     and existing.type = generated.type and existing.date = generated.scheduled_date
     and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number
  ) then
    raise exception 'Manual-added flight collides with imported occurrence' using errcode = '23505';
  end if;

  if exists (
    select 1 from import_generated_records generated
    join public.season_flight_records existing
      on existing.season_id = batch.season_id and existing.source_kind = 'imported'
     and existing.type = generated.type and existing.date = generated.scheduled_date
     and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number
    group by generated.occurrence_key having count(*) > 1
  ) then
    raise exception 'Ambiguous legacy imported occurrence match' using errcode = '23505';
  end if;

  update import_generated_records generated
  set record_id = existing.record_id
  from public.season_flight_records existing
  where existing.season_id = batch.season_id and existing.source_kind = 'imported'
    and existing.type = generated.type and existing.date = generated.scheduled_date
    and upper(existing.airline) = generated.airline and upper(existing.flight_number) = generated.flight_number;

  update import_generated_records generated
  set linked_record_id = counterpart.record_id
  from import_generated_records counterpart
  where generated.turnaround_id is not null and counterpart.turnaround_id = generated.turnaround_id and counterpart.type <> generated.type;

  select count(*) into preserved_count
  from import_generated_records generated
  join public.season_flight_records existing on existing.record_id = generated.record_id;

  delete from public.season_modifications modifications
  using import_generated_records generated
  where modifications.leg_id = generated.record_id
    and modifications.action in ('deleted', 'modified')
    and not (modifications.changed_fields && array['gate','stand','counter','carousel','mct','fb','lb','bhs','ghs','checkInStart','checkInEnd','checkInAllocationMode']);

  update public.season_modifications modifications
  set changed_fields = array(
    select field from unnest(modifications.changed_fields) field
    where field = any(array['gate','stand','counter','carousel','mct','fb','lb','bhs','ghs','checkInStart','checkInEnd','checkInAllocationMode'])
  ), action = 'modified', schedule = null, aircraft = null, route = null, code_shares = null
  where modifications.leg_id in (select record_id from import_generated_records)
    and modifications.action = 'modified';

  delete from public.season_flight_records existing
  where existing.season_id = batch.season_id and existing.source_kind = 'imported'
    and not exists (select 1 from import_generated_records generated where generated.record_id = existing.record_id);
  get diagnostics removed_count = row_count;

  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, code_shares, int_dom_ind, date, scheduled_date,
    scheduled_time, operational_date, day_of_week, source_row_index, linked_source_row_index,
    link_type, pair_anchor_date, linked_record_id, source_kind, source_side, status, turnaround_id
  )
  select batch.season_id, generated.record_id, generated.link_id, generated.type, generated.airline,
    generated.flight_number, generated.raw_flight_number, generated.route, generated.schedule,
    generated.aircraft, generated.category, generated.code_shares, generated.int_dom_ind,
    generated.scheduled_date, generated.scheduled_date, generated.schedule, generated.operational_date,
    generated.day_of_week, generated.source_row_index, generated.linked_source_row_index,
    generated.link_type, generated.pair_anchor_date, generated.linked_record_id, 'imported',
    case when generated.type = 'A' then 'ARR' else 'DEP' end, 'active', generated.turnaround_id
  from import_generated_records generated
  on conflict (record_id) do update set
    link_id = excluded.link_id, type = excluded.type, airline = excluded.airline,
    flight_number = excluded.flight_number, raw_flight_number = excluded.raw_flight_number,
    route = excluded.route, schedule = excluded.schedule, aircraft = excluded.aircraft,
    category = excluded.category, code_shares = excluded.code_shares, int_dom_ind = excluded.int_dom_ind,
    date = excluded.date, scheduled_date = excluded.scheduled_date, scheduled_time = excluded.scheduled_time,
    operational_date = excluded.operational_date, day_of_week = excluded.day_of_week,
    source_row_index = excluded.source_row_index, linked_source_row_index = excluded.linked_source_row_index,
    link_type = excluded.link_type, pair_anchor_date = excluded.pair_anchor_date,
    linked_record_id = excluded.linked_record_id, source_kind = 'imported', status = 'active', turnaround_id = excluded.turnaround_id;

  delete from public.season_source_rows where season_id = batch.season_id;
  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft, sta, arr_flight, arr_route,
    arr_category, arr_code_shares, arr_int_dom_ind, std, dep_flight, dep_route, dep_category,
    dep_code_shares, dep_int_dom_ind, overnight_link_row_index, link_type
  )
  select batch.season_id, rows.row_index, rows.row_data->>'effective', rows.row_data->>'discontinue',
    rows.row_data->>'airline', rows.row_data->>'aircraft', nullif(rows.row_data->>'sta',''), nullif(rows.row_data->>'arrFlight',''),
    nullif(rows.row_data->>'arrRoute',''), nullif(rows.row_data->>'arrFlightCategory',''), nullif(rows.row_data->>'arrCodeShares',''),
    nullif(rows.row_data->>'arrIntDomInd',''), nullif(rows.row_data->>'std',''), nullif(rows.row_data->>'depFlight',''),
    nullif(rows.row_data->>'depRoute',''), nullif(rows.row_data->>'depFlightCategory',''), nullif(rows.row_data->>'depCodeShares',''),
    nullif(rows.row_data->>'depIntDomInd',''), nullif(rows.row_data->>'overnightLinkRowIndex','')::integer,
    nullif(rows.row_data->>'linkType','')
  from public.season_import_batch_rows rows where rows.batch_id = p_batch_id;

  insert into public.season_source_row_days (season_id, row_index, iso_dow)
  select batch.season_id, rows.row_index, day_index
  from public.season_import_batch_rows rows
  cross join generate_series(1, 7) day_index
  where rows.batch_id = p_batch_id and coalesce((rows.row_data->'daysOfWeek'->>(day_index - 1))::boolean, false);

  next_version := season_row.data_version + 1;
  update public.seasons
  set season_code = batch.season_code, file_name = batch.file_name, uploaded_at = batch.uploaded_at,
      effective_start = coalesce((select min(scheduled_date) from import_generated_records), ''),
      effective_end = coalesce((select max(scheduled_date) from import_generated_records), ''),
      total_legs = (select count(*) from import_generated_records), total_source_rows = batch.source_row_count,
      data_version = next_version, last_synced_at = batch.uploaded_at
  where id = batch.season_id;

  insert into public.season_change_events (
    season_id, client_id, op_id, actor_user_id, target_type, target_id, changed_fields, op_payload
  ) values (
    batch.season_id, batch.client_id, batch.request_id::text, auth.uid(), 'season', batch.season_id,
    array['import'], jsonb_build_object('kind', 'seasonal-import-v2', 'batchId', batch.batch_id)
  ) returning server_seq into server_high_water;

  select count(*) into committed_source_count from public.season_source_rows where season_id = batch.season_id;
  select count(*) into committed_record_count from public.season_flight_records where season_id = batch.season_id and source_kind = 'imported';
  if committed_source_count <> batch.source_row_count or committed_record_count <> batch.generated_record_count then
    raise exception 'Import read-back verification failed: source %/% records %/%',
      committed_source_count, batch.source_row_count, committed_record_count, batch.generated_record_count;
  end if;

  success_result := jsonb_build_object(
    'batchId', batch.batch_id, 'seasonId', batch.season_id, 'seasonCode', batch.season_code,
    'status', 'committed', 'sourceRowCount', committed_source_count,
    'flightRecordCount', committed_record_count, 'preservedOperationalCount', preserved_count,
    'removedImportedCount', removed_count, 'dataVersion', next_version,
    'serverHighWater', server_high_water, 'checksum', batch.checksum
  );
  update public.season_import_batches
  set status = 'committed', result = success_result, committed_at = now()
  where batch_id = p_batch_id;
  return success_result;
end;
$$;

revoke execute on function public.stage_seasonal_import_v2(jsonb) from public, anon;
revoke execute on function public.commit_seasonal_import_v2(uuid, integer) from public, anon;
grant execute on function public.stage_seasonal_import_v2(jsonb) to authenticated, service_role;
grant execute on function public.commit_seasonal_import_v2(uuid, integer) to authenticated, service_role;

create or replace function public.get_seasonal_export_snapshot_v2(
  p_season_id text,
  p_expected_data_version integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version integer;
  current_high_water bigint;
  snapshot jsonb;
begin
  if auth.role() <> 'service_role' and not public.app_operator_has_permission('seasonal.read') then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  select data_version into current_version
  from public.seasons
  where id = p_season_id
  for share;
  if not found then
    raise exception 'Season % not found', p_season_id using errcode = 'P0002';
  end if;
  if p_expected_data_version is distinct from current_version then
    raise exception 'Season data version changed from % to %', p_expected_data_version, current_version using errcode = '40001';
  end if;

  select coalesce(max(server_seq), 0) into current_high_water
  from public.season_change_events
  where season_id = p_season_id;

  with flight_record_rows as (
    select r.* from public.season_flight_records r
    where r.season_id = p_season_id order by r.record_id
  ), flight_record_ids as (
    select record_id from flight_record_rows
  ), modification_rows as (
    select m.* from public.season_modifications m
    where m.season_id = p_season_id
      and (
        m.leg_id in (select record_id from flight_record_ids)
        or (m.action = 'added' and exists (
          select 1 from public.season_modification_added_legs al
          where al.season_id = p_season_id and al.leg_id = m.leg_id
        ))
      )
    order by m.leg_id
  ), modification_leg_ids as (
    select leg_id from modification_rows
  )
  select jsonb_build_object(
    'seasonId', p_season_id,
    'dataVersion', current_version,
    'serverHighWater', current_high_water,
    'totalCount', (select count(*) from flight_record_rows),
    'truncated', false,
    'flightRecords', coalesce((select jsonb_agg(to_jsonb(r) order by r.record_id) from flight_record_rows r), '[]'::jsonb),
    'flightRecordCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.record_id, c.counter_group, c.item_index) from public.season_flight_record_counters c where c.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'flightRecordWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.record_id, w.counter_key) from public.season_flight_record_checkin_windows w where w.record_id in (select record_id from flight_record_ids)), '[]'::jsonb),
    'modifications', coalesce((select jsonb_agg(to_jsonb(m) order by m.leg_id) from modification_rows m), '[]'::jsonb),
    'modificationCounters', coalesce((select jsonb_agg(to_jsonb(c) order by c.leg_id, c.counter_group, c.item_index) from public.season_modification_counters c where c.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationWindows', coalesce((select jsonb_agg(to_jsonb(w) order by w.leg_id, w.counter_key) from public.season_modification_checkin_windows w where w.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb),
    'modificationAddedLegs', coalesce((select jsonb_agg(to_jsonb(al) order by al.leg_id) from public.season_modification_added_legs al where al.leg_id in (select leg_id from modification_leg_ids)), '[]'::jsonb)
  ) into snapshot;

  return snapshot;
end;
$$;

revoke execute on function public.get_seasonal_export_snapshot_v2(text, integer) from public, anon;
grant execute on function public.get_seasonal_export_snapshot_v2(text, integer) to authenticated, service_role;
