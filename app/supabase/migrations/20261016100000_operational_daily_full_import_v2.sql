-- ============================================================================
-- Migration: 20261016100000_operational_daily_full_import_v2.sql
-- Description: Production-grade resumable chunked upload API and bulk-optimized
--              stage and commit for Operational Daily Import V2 (supporting 100k+ legs).
--              - Tables: operational_daily_import_uploads, operational_daily_import_upload_chunks
--              - RPC: begin_daily_schedule_import_upload_v2
--              - RPC: append_daily_schedule_import_upload_v2
--              - RPC: finalize_daily_schedule_import_upload_v2
--              - Bulk-optimized stage_daily_schedule_import_v2 & commit_daily_schedule_import_v2
--              - Retains all Daily V2 invariants: lineage, overrides, overnight pairing,
--                permissions, zero/sparse dates, scope fingerprint, idempotent receipt.
-- ============================================================================

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';

-- 1. Chunked upload staging tables
create table if not exists public.operational_daily_import_uploads (
  upload_id uuid primary key,
  request_id uuid not null,
  chunk_count integer not null check ((chunk_count = 0 and leg_count = 0) or (chunk_count > 0 and leg_count >= 0)),
  leg_count integer not null check (leg_count >= 0),
  received_chunks integer not null default 0 check (received_chunks >= 0),
  status text not null default 'uploading' check (status in ('uploading', 'staged', 'failed', 'committed', 'cancelled', 'expired')),
  input_payload jsonb not null,
  affected_dates date[] not null,
  confirmed_zero_dates date[] not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  unique (created_by, request_id)
);

create table if not exists public.operational_daily_import_upload_chunks (
  upload_id uuid not null references public.operational_daily_import_uploads(upload_id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  chunk_hash text not null,
  leg_count integer not null check (leg_count >= 0),
  legs jsonb not null check (jsonb_typeof(legs) = 'array'),
  received_at timestamptz not null default now(),
  primary key (upload_id, chunk_index)
);

create index if not exists operational_daily_import_uploads_expiry_idx
  on public.operational_daily_import_uploads(expires_at)
  where status in ('uploading', 'staged');

create index if not exists operational_daily_import_legs_pairing_idx
  on public.operational_daily_import_legs(batch_id, sheet_name, source_row_number);

create index if not exists operational_flight_legs_leg_key_scheduled_date_idx
  on public.operational_flight_legs(leg_key, scheduled_date);

revoke all on public.operational_daily_import_uploads, public.operational_daily_import_upload_chunks from public, anon, authenticated;

-- 2. begin_daily_schedule_import_upload_v2
create or replace function public.begin_daily_schedule_import_upload_v2(
  p_import jsonb,
  p_leg_count integer,
  p_chunk_count integer
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '30s' as $$
declare
  v_actor uuid := auth.uid();
  v_request uuid;
  v_dates date[];
  v_zero date[];
  v_existing_upload public.operational_daily_import_uploads%rowtype;
  v_upload_id uuid;
  v_next_chunk integer;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;
  if octet_length(p_import::text) > 8388608 then
    raise exception 'Import metadata payload exceeds 8 MiB' using errcode = '22023';
  end if;
  if p_leg_count is null or p_leg_count < 0
     or p_chunk_count is null or p_chunk_count < 0
     or (p_chunk_count = 0 and p_leg_count > 0)
     or p_chunk_count > 1000 or p_leg_count > 500000 then
    raise exception 'Invalid chunk or leg count' using errcode = '22023';
  end if;
  if jsonb_typeof(p_import) is distinct from 'object'
     or p_import->>'contractVersion' is distinct from '2'
     or jsonb_typeof(p_import->'affectedDates') is distinct from 'array'
     or jsonb_typeof(coalesce(p_import->'confirmedZeroFlightDates', '[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_import->'diagnostics', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Invalid Daily V2 payload' using errcode = '22023';
  end if;
  if coalesce(btrim(p_import->>'canonicalChecksum'), '') = '' then
    raise exception 'Canonical checksum is required' using errcode = '22023';
  end if;
  v_request := (p_import->>'requestId')::uuid;
  if v_request is null then
    raise exception 'requestId is required' using errcode = '22023';
  end if;

  select array_agg(distinct d::date order by d::date) into v_dates
  from jsonb_array_elements_text(p_import->'affectedDates') d;

  select coalesce(array_agg(distinct d::date order by d::date), '{}'::date[]) into v_zero
  from jsonb_array_elements_text(coalesce(p_import->'confirmedZeroFlightDates', '[]'::jsonb)) d;

  if coalesce(cardinality(v_dates), 0) = 0 or exists (select 1 from unnest(v_dates || v_zero) d where d is null or not isfinite(d)) then
    raise exception 'Explicit finite affected dates are required, including for a zero-flight workbook' using errcode = '22023';
  end if;
  if not (v_zero <@ v_dates) then
    raise exception 'Zero-flight dates must belong to affectedDates' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('daily-upload:' || v_actor::text || ':' || v_request::text, 0));

  select * into v_existing_upload
  from public.operational_daily_import_uploads
  where created_by = v_actor and request_id = v_request
  for update;

  if found then
    if v_existing_upload.chunk_count <> p_chunk_count
       or v_existing_upload.leg_count <> p_leg_count
       or v_existing_upload.input_payload is distinct from p_import then
      raise exception 'Request ID reused with different parameters' using errcode = '23505';
    end if;

    -- Only non-terminal sessions can transition to expired
    if v_existing_upload.expires_at <= now() and v_existing_upload.status in ('uploading', 'staged', 'failed') then
      update public.operational_daily_import_uploads set status = 'expired' where upload_id = v_existing_upload.upload_id;
      update public.daily_schedule_import_batches set status = 'expired' where batch_id = v_existing_upload.upload_id and status in ('validated', 'failed');
      v_existing_upload.status := 'expired';
    end if;

    if v_existing_upload.status = 'committed' then
      return jsonb_build_object(
        'uploadId', v_existing_upload.upload_id,
        'batchId', v_existing_upload.upload_id,
        'requestId', v_request,
        'nextChunkIndex', v_existing_upload.chunk_count,
        'chunkCount', v_existing_upload.chunk_count,
        'legCount', v_existing_upload.leg_count,
        'receivedChunks', v_existing_upload.received_chunks,
        'status', 'committed'
      );
    end if;

    if v_existing_upload.status = 'uploading' then
      if p_chunk_count = 0 then
        v_next_chunk := 0;
      else
        select coalesce(min(s.idx), v_existing_upload.chunk_count) into v_next_chunk
        from generate_series(0, v_existing_upload.chunk_count - 1) s(idx)
        where not exists (
          select 1 from public.operational_daily_import_upload_chunks c
          where c.upload_id = v_existing_upload.upload_id and c.chunk_index = s.idx
        );
      end if;
      return jsonb_build_object(
        'uploadId', v_existing_upload.upload_id,
        'batchId', v_existing_upload.upload_id,
        'requestId', v_request,
        'nextChunkIndex', v_next_chunk,
        'chunkCount', v_existing_upload.chunk_count,
        'legCount', v_existing_upload.leg_count,
        'receivedChunks', v_existing_upload.received_chunks,
        'status', v_existing_upload.status
      );
    else
      return jsonb_build_object(
        'uploadId', v_existing_upload.upload_id,
        'batchId', v_existing_upload.upload_id,
        'requestId', v_request,
        'nextChunkIndex', v_existing_upload.chunk_count,
        'chunkCount', v_existing_upload.chunk_count,
        'legCount', v_existing_upload.leg_count,
        'receivedChunks', v_existing_upload.received_chunks,
        'status', v_existing_upload.status
      );
    end if;
  end if;

  v_upload_id := gen_random_uuid();

  insert into public.operational_daily_import_uploads(
    upload_id, request_id, chunk_count, leg_count, received_chunks, status,
    input_payload, affected_dates, confirmed_zero_dates, created_by, created_at, expires_at
  ) values (
    v_upload_id, v_request, p_chunk_count, p_leg_count, 0, 'uploading',
    p_import, v_dates, v_zero, v_actor, now(), now() + interval '2 hours'
  );

  insert into public.daily_schedule_import_batches(
    batch_id, request_id, contract_version, status, file_name, workbook_profile,
    raw_checksum, canonical_checksum, resource_policy_hash, diagnostics, preview, preview_hash, created_by, expires_at
  ) values (
    v_upload_id, v_request, 2, 'failed', coalesce(p_import->>'fileName', ''), coalesce(p_import->>'workbookProfile', 'unknown'),
    coalesce(p_import->>'rawChecksum', ''), p_import->>'canonicalChecksum', coalesce(p_import->>'resourcePolicyHash', ''),
    coalesce(p_import->'diagnostics', '[]'::jsonb), '{}'::jsonb, 'pending', v_actor, now() + interval '2 hours'
  );

  return jsonb_build_object(
    'uploadId', v_upload_id,
    'batchId', v_upload_id,
    'requestId', v_request,
    'nextChunkIndex', 0,
    'chunkCount', p_chunk_count,
    'legCount', p_leg_count,
    'receivedChunks', 0,
    'status', 'uploading'
  );
end;
$$;

-- 3. append_daily_schedule_import_upload_v2
create or replace function public.append_daily_schedule_import_upload_v2(
  p_upload_id uuid,
  p_chunk_index integer,
  p_legs jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '30s' as $$
declare
  v_actor uuid := auth.uid();
  v_upload public.operational_daily_import_uploads%rowtype;
  v_chunk public.operational_daily_import_upload_chunks%rowtype;
  v_chunk_hash text;
  v_next_chunk integer;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;
  if octet_length(p_legs::text) > 33554432 then
    raise exception 'Chunk payload exceeds 32 MiB' using errcode = '22023';
  end if;

  select * into v_upload
  from public.operational_daily_import_uploads
  where upload_id = p_upload_id and created_by = v_actor
  for update;

  if not found then
    raise exception 'Upload session not found' using errcode = 'P0002';
  end if;
  if v_upload.status = 'committed' then
    raise exception 'Upload session is already committed' using errcode = '22023';
  end if;
  if v_upload.status = 'staged' then
    raise exception 'Upload session is already staged' using errcode = '22023';
  end if;
  if v_upload.expires_at <= now() then
    update public.operational_daily_import_uploads set status = 'expired' where upload_id = p_upload_id;
    update public.daily_schedule_import_batches set status = 'expired' where batch_id = p_upload_id;
    raise exception 'Upload session has expired' using errcode = 'PT409';
  end if;
  if v_upload.status <> 'uploading' then
    raise exception 'Upload session is not in uploading status' using errcode = '22023';
  end if;
  if p_chunk_index < 0 or p_chunk_index >= v_upload.chunk_count then
    raise exception 'Chunk index % is out of range (total %)', p_chunk_index, v_upload.chunk_count using errcode = '22023';
  end if;
  if jsonb_typeof(p_legs) is distinct from 'array' then
    raise exception 'p_legs must be a jsonb array' using errcode = '22023';
  end if;

  v_chunk_hash := encode(sha256(convert_to(p_legs::text, 'UTF8')), 'hex');

  select * into v_chunk
  from public.operational_daily_import_upload_chunks
  where upload_id = p_upload_id and chunk_index = p_chunk_index;

  if found then
    if v_chunk.chunk_hash is distinct from v_chunk_hash then
      raise exception 'Chunk % already received with different content', p_chunk_index using errcode = '23505';
    end if;
  else
    insert into public.operational_daily_import_upload_chunks(
      upload_id, chunk_index, chunk_hash, leg_count, legs, received_at
    ) values (
      p_upload_id, p_chunk_index, v_chunk_hash, jsonb_array_length(p_legs), p_legs, now()
    );
    update public.operational_daily_import_uploads
    set received_chunks = (select count(*)::integer from public.operational_daily_import_upload_chunks where upload_id = p_upload_id)
    where upload_id = p_upload_id;
  end if;

  select coalesce(min(s.idx), v_upload.chunk_count) into v_next_chunk
  from generate_series(0, v_upload.chunk_count - 1) s(idx)
  where not exists (
    select 1 from public.operational_daily_import_upload_chunks c
    where c.upload_id = p_upload_id and c.chunk_index = s.idx
  );

  return jsonb_build_object(
    'uploadId', p_upload_id,
    'nextChunkIndex', v_next_chunk,
    'receivedChunks', (select count(*)::integer from public.operational_daily_import_upload_chunks where upload_id = p_upload_id),
    'totalChunks', v_upload.chunk_count
  );
end;
$$;

-- 4. finalize_daily_schedule_import_upload_v2
create or replace function public.finalize_daily_schedule_import_upload_v2(
  p_upload_id uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '300s' as $$
declare
  v_actor uuid := auth.uid();
  v_upload public.operational_daily_import_uploads%rowtype;
  v_batch public.daily_schedule_import_batches%rowtype;
  v_dates date[];
  v_zero date[];
  v_diag jsonb;
  v_fingerprint text;
  v_status text;
  v_preview jsonb;
  v_preview_hash text;
  v_replaced_count integer;
  v_rebase_count integer;
  v_received_count integer;
  v_actual_legs integer;
  v_day date;
  v_count integer;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  -- Lock hierarchy: Level 1 workspace revision (share), Level 2 upload (update), Level 3 batch (update)
  perform 1 from public.operational_workspace_revision where singleton for share;

  select * into v_upload
  from public.operational_daily_import_uploads
  where upload_id = p_upload_id and created_by = v_actor
  for update;

  if not found then
    raise exception 'Upload session not found' using errcode = 'P0002';
  end if;

  select * into v_batch
  from public.daily_schedule_import_batches
  where batch_id = p_upload_id and created_by = v_actor
  for update;

  -- Immutable terminal & staged receipts returned immediately
  if v_upload.status = 'committed' then
    return public.daily_schedule_import_v1_response(p_upload_id);
  end if;
  if v_upload.status = 'staged' then
    return public.daily_schedule_import_v1_response(p_upload_id);
  end if;
  if v_upload.expires_at <= now() then
    update public.operational_daily_import_uploads set status = 'expired' where upload_id = p_upload_id;
    update public.daily_schedule_import_batches set status = 'expired' where batch_id = p_upload_id;
    raise exception 'Upload session has expired' using errcode = 'PT409';
  end if;
  if v_upload.status <> 'uploading' then
    raise exception 'Upload session is in % status, cannot finalize', v_upload.status using errcode = '22023';
  end if;

  select count(*) into v_received_count
  from public.operational_daily_import_upload_chunks
  where upload_id = p_upload_id;

  if v_received_count <> v_upload.chunk_count then
    raise exception 'Upload incomplete: received % of % chunks', v_received_count, v_upload.chunk_count using errcode = '22023';
  end if;

  select coalesce(sum(leg_count), 0) into v_actual_legs
  from public.operational_daily_import_upload_chunks
  where upload_id = p_upload_id;

  if v_actual_legs <> v_upload.leg_count then
    raise exception 'Leg count mismatch: expected %, received %', v_upload.leg_count, v_actual_legs using errcode = '22023';
  end if;

  v_dates := v_upload.affected_dates;
  v_zero := v_upload.confirmed_zero_dates;

  v_fingerprint := public.operational_daily_scope_fingerprint_v2(v_dates);

  insert into public.operational_daily_import_stages(
    batch_id, input_payload, affected_dates, confirmed_zero_dates, source_fingerprint
  ) values (
    p_upload_id, v_upload.input_payload, v_dates, v_zero, v_fingerprint
  ) on conflict (batch_id) do update set
    input_payload = excluded.input_payload,
    affected_dates = excluded.affected_dates,
    confirmed_zero_dates = excluded.confirmed_zero_dates,
    source_fingerprint = excluded.source_fingerprint;

  v_diag := coalesce(v_upload.input_payload->'diagnostics', '[]'::jsonb);

  -- 4.1 Raw legs extraction into temporary table
  drop table if exists pg_temp.temp_raw_legs;
  create temporary table temp_raw_legs on commit drop as
  select
    c.chunk_index,
    l.ordinality as leg_index,
    l.value as leg_data,
    l.value->>'operationalDate' as op_date_str,
    l.value->>'scheduledDate' as sched_date_str,
    l.value->>'scheduledTime' as sched_time_str,
    l.value->>'side' as side_str,
    upper(btrim(coalesce(l.value->>'airline', ''))) as airline_str,
    upper(btrim(coalesce(l.value->>'flightNumber', ''))) as flight_str,
    coalesce(l.value->>'rawFlightNumber', '') as raw_flight_str,
    upper(btrim(coalesce(l.value->>'route', ''))) as route_str,
    coalesce(l.value->>'sheetName', '') as sheet_name_str,
    case when (l.value->>'sourceRowNumber') ~ '^[1-9][0-9]*$' then (l.value->>'sourceRowNumber')::integer else null end as source_row_num,
    l.value#>>'{resources,checkInAllocationMode}' as alloc_mode_str,
    l.value#>'{resources,checkInCounterWindows}' as windows_json,
    nullif(upper(btrim(coalesce(l.value#>>'{resources,stand}', ''))), '') as stand_str,
    l.value#>>'{resources,gate}' as gate_str,
    l.value#>>'{resources,carousel}' as carousel_str,
    l.value#>>'{resources,pax}' as pax_str
  from public.operational_daily_import_upload_chunks c
  cross join lateral jsonb_array_elements(c.legs) with ordinality l(value, ordinality)
  where c.upload_id = p_upload_id;

  -- 4.2 Validate raw syntax safely using pg_input_is_valid (PG 16+)
  drop table if exists pg_temp.temp_validated_legs;
  create temporary table temp_validated_legs on commit drop as
  select
    r.*,
    case
      when r.op_date_str is null or not pg_input_is_valid(r.op_date_str, 'date') then false
      when r.sched_date_str is null or not pg_input_is_valid(r.sched_date_str, 'date') then false
      when r.sched_time_str is null or not pg_input_is_valid(r.sched_time_str, 'time') then false
      when r.side_str not in ('ARR', 'DEP') or r.side_str is null then false
      when r.airline_str = '' or r.flight_str = '' or r.route_str = '' then false
      when r.source_row_num is null or r.source_row_num <= 0 then false
      when r.alloc_mode_str is not null and r.alloc_mode_str not in ('grouped', 'broken') then false
      when r.windows_json is not null and (
        jsonb_typeof(r.windows_json) <> 'object'
        or exists (select 1 from jsonb_each(r.windows_json) w where w.value->>'start' is null or w.value->>'end' is null)
      ) then false
      when r.stand_str is not null and r.stand_str !~ '^[1-9][0-9]*[A-Z]?$' then false
      when nullif(r.gate_str, '') is not null and (not pg_input_is_valid(r.gate_str, 'integer') or r.gate_str::integer <= 0) then false
      when nullif(r.carousel_str, '') is not null and (not pg_input_is_valid(r.carousel_str, 'integer') or r.carousel_str::integer <= 0) then false
      when nullif(r.pax_str, '') is not null and not pg_input_is_valid(r.pax_str, 'integer') then false
      else true
    end as syntax_valid
  from temp_raw_legs r;

  -- Append syntax invalid diagnostics
  select coalesce(v_diag || jsonb_agg(jsonb_build_object(
    'severity', 'blocking',
    'code', 'DAILY_INVALID_LEG',
    'message', 'Leg date/side/resource is invalid or outside affectedDates',
    'rowNumber', coalesce(source_row_num, 0),
    'operationalDate', op_date_str
  )), v_diag)
  into v_diag
  from temp_validated_legs
  where not syntax_valid;

  -- 4.3 Safe typed date verification for syntax-valid legs
  drop table if exists pg_temp.temp_typed_legs;
  create temporary table temp_typed_legs on commit drop as
  select
    v.leg_data,
    v.source_row_num,
    v.sheet_name_str as sheet_name,
    v.side_str as side,
    v.airline_str as airline,
    v.flight_str as flight_number,
    v.raw_flight_str as raw_flight_number,
    v.route_str as route,
    v.op_date_str::date as operational_date,
    v.sched_date_str::date as scheduled_date,
    v.sched_time_str::time as scheduled_time,
    (case v.side_str when 'ARR' then 'A' else 'D' end) || chr(31) || (v.op_date_str::date)::text || chr(31) || v.airline_str || chr(31) || v.flight_str as leg_key,
    concat_ws('|', (v.op_date_str::date)::text, v.side_str, v.airline_str, v.flight_str, v.route_str, v.sched_time_str) as occurrence_key,
    case
      when not (v.op_date_str::date = any(v_dates)) then false
      when v.op_date_str::date is distinct from public.seasonal_operational_date_v2(v.sched_date_str::date, v.sched_time_str::time) then false
      else true
    end as date_valid
  from temp_validated_legs v
  where v.syntax_valid;

  select coalesce(v_diag || jsonb_agg(jsonb_build_object(
    'severity', 'blocking',
    'code', 'DAILY_INVALID_LEG',
    'message', 'Leg date/side is invalid or outside affectedDates',
    'rowNumber', source_row_num,
    'operationalDate', operational_date::text
  )), v_diag)
  into v_diag
  from temp_typed_legs
  where not date_valid;

  -- 4.4 Intra-batch duplicate check
  drop table if exists pg_temp.temp_intra_collisions;
  create temporary table temp_intra_collisions on commit drop as
  select
    leg_key,
    scheduled_date,
    count(*) as cnt,
    (array_agg(source_row_num order by source_row_num))[2] as dup_row_num,
    (array_agg(operational_date))[1] as dup_op_date
  from temp_typed_legs
  where date_valid
  group by leg_key, scheduled_date
  having count(*) > 1;

  select coalesce(v_diag || jsonb_agg(jsonb_build_object(
    'severity', 'blocking',
    'code', 'DAILY_LOOSE_IDENTITY_COLLISION',
    'message', 'DAILY_LOOSE_IDENTITY_COLLISION: duplicate key value violates unique constraint',
    'rowNumber', dup_row_num,
    'operationalDate', dup_op_date::text
  )), v_diag)
  into v_diag
  from temp_intra_collisions;

  -- 4.5 DB collision and lineage matching against operational_flight_legs
  drop table if exists pg_temp.temp_db_matched;
  create temporary table temp_db_matched on commit drop as
  with distinct_keys as (
    select distinct leg_key, scheduled_date from temp_typed_legs where date_valid
  ),
  matched_active as (
    select
      d.leg_key,
      d.scheduled_date,
      count(*) as active_cnt,
      (array_agg(l.leg_id))[1] as active_id,
      (array_agg(l.lineage_id))[1] as active_lineage,
      (array_agg(l.lineage_generation))[1] as active_generation
    from distinct_keys d
    join public.operational_flight_legs l on l.leg_key = d.leg_key and l.scheduled_date = d.scheduled_date and l.status = 'active'
    group by d.leg_key, d.scheduled_date
  ),
  matched_terminal as (
    select
      d.leg_key,
      d.scheduled_date,
      count(distinct l.lineage_id) as term_lineages,
      (array_agg(l.leg_id order by l.lineage_generation desc))[1] as term_id,
      (array_agg(l.lineage_id order by l.lineage_generation desc))[1] as term_lineage,
      (array_agg(l.lineage_generation order by l.lineage_generation desc))[1] as term_generation
    from distinct_keys d
    join public.operational_flight_legs l on l.leg_key = d.leg_key and l.scheduled_date = d.scheduled_date and l.status <> 'active'
    where not exists (select 1 from matched_active a where a.leg_key = d.leg_key and a.scheduled_date = d.scheduled_date)
    group by d.leg_key, d.scheduled_date
  )
  select
    d.leg_key,
    d.scheduled_date,
    coalesce(a.active_cnt, 0) as active_count,
    a.active_id,
    a.active_lineage,
    a.active_generation,
    coalesce(t.term_lineages, 0) as terminal_lineages,
    t.term_id,
    t.term_lineage,
    t.term_generation
  from distinct_keys d
  left join matched_active a on a.leg_key = d.leg_key and a.scheduled_date = d.scheduled_date
  left join matched_terminal t on t.leg_key = d.leg_key and t.scheduled_date = d.scheduled_date;

  -- Add diagnostics for several active sources
  select coalesce(v_diag || jsonb_agg(jsonb_build_object(
    'severity', 'blocking',
    'code', 'DAILY_LOOSE_IDENTITY_COLLISION',
    'message', 'DAILY_LOOSE_IDENTITY_COLLISION: several active sources',
    'rowNumber', t.source_row_num,
    'operationalDate', t.operational_date::text
  )), v_diag)
  into v_diag
  from temp_typed_legs t
  join temp_db_matched m on m.leg_key = t.leg_key and m.scheduled_date = t.scheduled_date
  where m.active_count > 1;

  -- Add diagnostics for several terminal lineages
  select coalesce(v_diag || jsonb_agg(jsonb_build_object(
    'severity', 'blocking',
    'code', 'DAILY_LOOSE_IDENTITY_COLLISION',
    'message', 'DAILY_LOOSE_IDENTITY_COLLISION: several terminal lineages',
    'rowNumber', t.source_row_num,
    'operationalDate', t.operational_date::text
  )), v_diag)
  into v_diag
  from temp_typed_legs t
  join temp_db_matched m on m.leg_key = t.leg_key and m.scheduled_date = t.scheduled_date
  where m.active_count = 0 and m.terminal_lineages > 1;

  -- 4.6 Insert clean legs into operational_daily_import_legs
  delete from public.operational_daily_import_legs where batch_id = p_upload_id;

  insert into public.operational_daily_import_legs(
    batch_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
    route, sheet_name, source_row_number, occurrence_key, matched_leg_id, lineage_id, lineage_generation,
    override_fields, leg_data
  )
  select
    p_upload_id,
    t.leg_key,
    t.operational_date,
    t.scheduled_date,
    t.scheduled_time,
    t.side,
    t.airline,
    t.flight_number,
    t.route,
    t.sheet_name,
    t.source_row_num,
    t.occurrence_key,
    case when m.active_count = 1 then m.active_id when m.terminal_lineages = 1 then m.term_id else null end,
    case when m.active_count = 1 then m.active_lineage when m.terminal_lineages = 1 then m.term_lineage else gen_random_uuid() end,
    case when m.active_count = 1 then m.active_generation + 1 when m.terminal_lineages = 1 then m.term_generation + 1 else 0 end,
    coalesce(o.fields, '{}'::jsonb),
    t.leg_data
  from temp_typed_legs t
  join temp_db_matched m on m.leg_key = t.leg_key and m.scheduled_date = t.scheduled_date
  left join public.operational_resource_overrides o on o.leg_id = (
    case when m.active_count = 1 then m.active_id when m.terminal_lineages = 1 then m.term_id else null end
  )
  where t.date_valid
    and not exists (select 1 from temp_intra_collisions i where i.leg_key = t.leg_key and i.scheduled_date = t.scheduled_date)
    and m.active_count <= 1
    and (m.active_count > 0 or m.terminal_lineages <= 1);

  -- 4.7 Zero-flight date confirmation check
  foreach v_day in array v_dates loop
    select count(*) into v_count
    from public.operational_daily_import_legs
    where batch_id = p_upload_id and operational_date = v_day;

    if (v_count = 0) is distinct from (v_day = any(v_zero)) then
      v_diag := v_diag || jsonb_build_array(jsonb_build_object(
        'severity', 'blocking',
        'code', 'DAILY_ZERO_FLIGHT_CONFIRMATION',
        'message', 'A zero-flight date must be explicitly confirmed and must contain no legs',
        'operationalDate', v_day
      ));
    end if;
  end loop;

  v_status := case when exists (select 1 from jsonb_array_elements(v_diag) d where d->>'severity' = 'blocking')
                   then 'failed' else 'validated' end;

  -- 4.8 Build bounded preview with total counts & truncation metadata
  select count(*) into v_replaced_count
  from public.operational_flight_legs
  where status = 'active' and operational_date = any(v_dates);

  select count(*) into v_rebase_count
  from public.operational_daily_import_legs
  where batch_id = p_upload_id and override_fields <> '{}'::jsonb;

  select jsonb_build_object(
    'importGuardVersion', '2',
    'valid', v_status = 'validated',
    'affectedDates', v_dates,
    'confirmedZeroFlightDates', v_zero,
    'sourceFingerprint', v_fingerprint,
    'legCount', (select count(*) from public.operational_daily_import_legs where batch_id = p_upload_id),
    'rebaseCount', v_rebase_count,
    'replacedLegsCount', v_replaced_count,
    'replacedLegsTruncated', v_replaced_count > 200,
    'replacedLegs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'legId', sub.leg_id,
        'sourceType', sub.source_type,
        'operationalDate', sub.operational_date,
        'side', sub.side,
        'airline', sub.airline,
        'flightNumber', sub.flight_number,
        'scheduledTime', sub.scheduled_time,
        'route', sub.route
      ) order by sub.operational_date, sub.scheduled_time, sub.leg_id)
      from (
        select leg_id, source_type, operational_date, side, airline, flight_number, scheduled_time, route
        from public.operational_flight_legs
        where status = 'active' and operational_date = any(v_dates)
        order by operational_date, scheduled_time, leg_id
        limit 200
      ) sub
    ), '[]'::jsonb),
    'rebasedOverridesCount', v_rebase_count,
    'rebasedOverridesTruncated', v_rebase_count > 200,
    'rebasedOverrides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'occurrenceKey', sub.occurrence_key,
        'matchedLegId', sub.matched_leg_id,
        'fields', sub.override_fields
      ) order by sub.occurrence_key)
      from (
        select occurrence_key, matched_leg_id, override_fields
        from public.operational_daily_import_legs
        where batch_id = p_upload_id and override_fields <> '{}'::jsonb
        order by occurrence_key
        limit 200
      ) sub
    ), '[]'::jsonb),
    'replacedBySource', coalesce((
      select jsonb_object_agg(source_type, n) from (
        select source_type, count(*) as n
        from public.operational_flight_legs
        where status = 'active' and operational_date = any(v_dates)
        group by source_type
      ) counts
    ), '{}'::jsonb),
    'inputHash', coalesce(v_upload.input_payload->>'canonicalChecksum', encode(sha256(convert_to(v_upload.input_payload::text, 'UTF8')), 'hex'))
  ) into v_preview;

  v_preview_hash := encode(sha256(convert_to(v_preview::text, 'UTF8')), 'hex');

  update public.daily_schedule_import_batches
  set status = v_status,
      diagnostics = v_diag,
      preview = v_preview,
      preview_hash = v_preview_hash
  where batch_id = p_upload_id;

  update public.operational_daily_import_uploads
  set status = case when v_status = 'validated' then 'staged' else 'failed' end
  where upload_id = p_upload_id;

  return public.daily_schedule_import_v1_response(p_upload_id);
end;
$$;

-- 5. stage_daily_schedule_import_v2 (Small-client backwards compatibility & bulk delegation)
create or replace function public.stage_daily_schedule_import_v2(
  p_import jsonb
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '300s' as $$
declare
  v_actor uuid := auth.uid();
  v_request uuid;
  v_batch uuid := gen_random_uuid();
  v_existing public.daily_schedule_import_batches%rowtype;
  v_dates date[];
  v_zero date[];
  v_legs jsonb := coalesce(p_import->'legs', '[]'::jsonb);
  v_leg_count integer;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;
  if p_import->>'contractVersion' is distinct from '2'
     or jsonb_typeof(p_import->'legs') is distinct from 'array'
     or jsonb_typeof(p_import->'affectedDates') is distinct from 'array'
     or jsonb_typeof(coalesce(p_import->'confirmedZeroFlightDates', '[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_import->'diagnostics', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Invalid Daily V2 payload' using errcode = '22023';
  end if;
  if coalesce(btrim(p_import->>'canonicalChecksum'), '') = '' then
    raise exception 'Canonical checksum is required' using errcode = '22023';
  end if;
  v_request := (p_import->>'requestId')::uuid;
  if v_request is null then
    raise exception 'requestId is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('daily-v2:' || v_actor::text || ':' || v_request::text, 0));

  select * into v_existing
  from public.daily_schedule_import_batches
  where created_by = v_actor and request_id = v_request;

  if found then
    if v_existing.contract_version <> 2 or not exists (
      select 1 from public.operational_daily_import_stages
      where batch_id = v_existing.batch_id and input_payload = p_import
    ) then
      raise exception 'Request ID reused with different payload' using errcode = '23505';
    end if;
    return public.daily_schedule_import_v1_response(v_existing.batch_id);
  end if;

  select array_agg(distinct d::date order by d::date) into v_dates
  from jsonb_array_elements_text(p_import->'affectedDates') d;

  select coalesce(array_agg(distinct d::date order by d::date), '{}'::date[]) into v_zero
  from jsonb_array_elements_text(coalesce(p_import->'confirmedZeroFlightDates', '[]'::jsonb)) d;

  if coalesce(cardinality(v_dates), 0) = 0 or exists (select 1 from unnest(v_dates || v_zero) d where d is null or not isfinite(d)) then
    raise exception 'Explicit finite affected dates are required, including for a zero-flight workbook' using errcode = '22023';
  end if;
  if not (v_zero <@ v_dates) then
    raise exception 'Zero-flight dates must belong to affectedDates' using errcode = '22023';
  end if;

  v_leg_count := jsonb_array_length(v_legs);

  insert into public.operational_daily_import_uploads(
    upload_id, request_id, chunk_count, leg_count, received_chunks, status,
    input_payload, affected_dates, confirmed_zero_dates, created_by
  ) values (
    v_batch, v_request, case when v_leg_count = 0 then 0 else 1 end, v_leg_count,
    case when v_leg_count = 0 then 0 else 1 end, 'uploading',
    p_import, v_dates, v_zero, v_actor
  );

  insert into public.daily_schedule_import_batches(
    batch_id, request_id, contract_version, status, file_name, workbook_profile,
    raw_checksum, canonical_checksum, resource_policy_hash, diagnostics, preview, preview_hash, created_by
  ) values (
    v_batch, v_request, 2, 'failed', coalesce(p_import->>'fileName', ''), coalesce(p_import->>'workbookProfile', 'unknown'),
    coalesce(p_import->>'rawChecksum', ''), coalesce(p_import->>'canonicalChecksum', ''), coalesce(p_import->>'resourcePolicyHash', ''),
    coalesce(p_import->'diagnostics', '[]'::jsonb), '{}'::jsonb, 'pending', v_actor
  );

  if v_leg_count > 0 then
    insert into public.operational_daily_import_upload_chunks(
      upload_id, chunk_index, chunk_hash, leg_count, legs
    ) values (
      v_batch, 0, encode(sha256(convert_to(v_legs::text, 'UTF8')), 'hex'), v_leg_count, v_legs
    );
  end if;

  return public.finalize_daily_schedule_import_upload_v2(v_batch);
end;
$$;

-- 6. commit_daily_schedule_import_v2 (Bulk-optimized atomic execution)
create or replace function public.commit_daily_schedule_import_v2(
  p_batch_id uuid,
  p_preview_hash text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '300s' as $$
declare
  v_actor uuid := auth.uid();
  v_batch public.daily_schedule_import_batches%rowtype;
  v_upload public.operational_daily_import_uploads%rowtype;
  v_stage public.operational_daily_import_stages%rowtype;
  v_day date;
  v_result jsonb;
  v_replaced integer;
  v_revision bigint;
begin
  if v_actor is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  -- Deadlock-free hierarchy: Level 1 workspace (update), Level 2 upload (update), Level 3 batch (update)
  perform 1 from public.operational_workspace_revision where singleton for update;

  select * into v_upload
  from public.operational_daily_import_uploads
  where upload_id = p_batch_id and created_by = v_actor
  for update;

  select * into v_batch
  from public.daily_schedule_import_batches
  where batch_id = p_batch_id and created_by = v_actor
  for update;

  if not found or v_batch.contract_version <> 2 then
    raise exception 'Daily V2 batch not found' using errcode = 'P0002';
  end if;
  if p_preview_hash is distinct from v_batch.preview_hash then
    raise exception 'Preview hash changed' using errcode = 'PT409';
  end if;
  if v_batch.status = 'committed' then
    return public.daily_schedule_import_v1_response(p_batch_id);
  end if;
  if v_batch.expires_at <= now() then
    update public.daily_schedule_import_batches set status = 'expired' where batch_id = p_batch_id;
    update public.operational_daily_import_uploads set status = 'expired' where upload_id = p_batch_id;
    raise exception 'Batch is not committable' using errcode = 'PT409';
  end if;
  if v_batch.status <> 'validated' then
    raise exception 'Batch is not committable' using errcode = 'PT409';
  end if;

  select * into strict v_stage
  from public.operational_daily_import_stages
  where batch_id = p_batch_id;

  for v_day in
    select d from unnest(v_stage.affected_dates) d
    union select operational_date from public.operational_flight_legs where status = 'active' and (
      linked_leg_id in (select leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
      or leg_id in (select linked_leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
    ) order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('operational-day:' || v_day::text, 0));
  end loop;

  if public.operational_daily_scope_fingerprint_v2(v_stage.affected_dates) is distinct from v_stage.source_fingerprint then
    raise exception 'Operational scope changed; stage again' using errcode = 'PT409';
  end if;

  perform 1 from public.operational_flight_legs
  where operational_date = any(v_stage.affected_dates)
     or linked_leg_id in (select leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
     or leg_id in (select linked_leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
  order by leg_id for update;

  -- Survivor unlinking in a single set-based statement
  with survivors as (
    select l.leg_id, l.operational_date, to_jsonb(l) as before_row
    from public.operational_flight_legs l
    where l.status = 'active' and not (l.operational_date = any(v_stage.affected_dates)) and (
      l.linked_leg_id in (select leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
      or l.leg_id in (select linked_leg_id from public.operational_flight_legs where operational_date = any(v_stage.affected_dates))
    )
  ),
  updated_survivors as (
    update public.operational_flight_legs l
    set linked_leg_id = null, turnaround_id = null, link_type = null, pair_anchor_date = null,
        updated_at = now(), updated_by = v_actor
    from survivors s
    where l.leg_id = s.leg_id
    returning l.leg_id, l.operational_date, to_jsonb(l) as after_row
  )
  insert into public.operational_change_events(
    actor_id, request_id, target_id, operational_date, changed_fields, before_state, after_state
  )
  select
    v_actor, v_batch.request_id, u.leg_id::text, u.operational_date,
    array['linked_leg_id', 'turnaround_id', 'link_type', 'pair_anchor_date'],
    s.before_row, u.after_row
  from updated_survivors u
  join survivors s on s.leg_id = u.leg_id;

  update public.operational_flight_legs
  set status = 'deleted', deletion_reason = 'daily_replacement',
      linked_leg_id = null, turnaround_id = null, link_type = null, pair_anchor_date = null,
      updated_at = now(), updated_by = v_actor
  where status = 'active' and operational_date = any(v_stage.affected_dates);

  get diagnostics v_replaced = row_count;

  -- Pre-compute pairs into indexed temp table for single-pass insert into operational_flight_legs
  drop table if exists pg_temp.temp_pairs;
  create temporary table temp_pairs on commit drop as
  select sheet_name, source_row_number,
    (array_agg(leg_id) filter(where side='ARR'))[1] as arrival,
    (array_agg(leg_id) filter(where side='DEP'))[1] as departure,
    min(scheduled_date) filter(where side='ARR') as arrival_date,
    min(scheduled_date) filter(where side='DEP') as departure_date
  from public.operational_daily_import_legs
  where batch_id = p_batch_id
  group by sheet_name, source_row_number
  having count(*) filter(where side='ARR') = 1 and count(*) filter(where side='DEP') = 1;

  create unique index temp_pairs_arr_idx on temp_pairs(arrival);
  create unique index temp_pairs_dep_idx on temp_pairs(departure);

  -- Single-pass bulk insert operational flight legs with pairs already linked!
  insert into public.operational_flight_legs(
    leg_id, lineage_id, lineage_generation, leg_key, operational_date, scheduled_date, scheduled_time,
    side, airline, flight_number, raw_flight_number, route, aircraft_type, flight_category, pax,
    code_shares, int_dom_ind,
    gate, stand, carousel, counter_token, mct, fb, lb, bhs, ghs, check_in_start, check_in_end,
    check_in_allocation_mode,
    linked_leg_id, turnaround_id, link_type, pair_anchor_date,
    source_type, source_batch_id, source_occurrence_key, source_row_number,
    created_by, updated_by
  )
  select
    l.leg_id,
    l.lineage_id,
    l.lineage_generation,
    l.leg_key,
    l.operational_date,
    l.scheduled_date,
    l.scheduled_time,
    l.side,
    l.airline,
    l.flight_number,
    l.leg_data->>'rawFlightNumber',
    l.route,
    coalesce(l.leg_data->>'aircraft', 'Unknown'),
    coalesce(l.leg_data->>'category', 'C'),
    nullif(l.leg_data#>>'{resources,pax}', '')::integer,
    l.leg_data#>>'{resources,codeShares}',
    l.leg_data->>'intDomInd',
    case when l.override_fields ? 'gate' then (l.override_fields->>'gate')::integer
         else nullif(l.leg_data#>>'{resources,gate}', '')::integer end,
    case when l.override_fields ? 'stand' then nullif(upper(btrim(l.override_fields->>'stand')), '')
         else nullif(upper(btrim(l.leg_data#>>'{resources,stand}')), '') end,
    case when l.override_fields ? 'carousel' then (l.override_fields->>'carousel')::integer
         else nullif(l.leg_data#>>'{resources,carousel}', '')::integer end,
    case when l.override_fields ? 'counter_token' then nullif(l.override_fields->>'counter_token', '')
         else nullif(l.leg_data#>>'{resources,counter}', '') end,
    case when l.override_fields ? 'mct' then l.override_fields->>'mct' else l.leg_data#>>'{resources,mct}' end,
    case when l.override_fields ? 'fb' then l.override_fields->>'fb' else l.leg_data#>>'{resources,fb}' end,
    case when l.override_fields ? 'lb' then l.override_fields->>'lb' else l.leg_data#>>'{resources,lb}' end,
    case when l.override_fields ? 'bhs' then l.override_fields->>'bhs' else l.leg_data#>>'{resources,bhs}' end,
    case when l.override_fields ? 'ghs' then l.override_fields->>'ghs' else l.leg_data#>>'{resources,ghs}' end,
    case when l.override_fields ? 'check_in_start' then l.override_fields->>'check_in_start' else l.leg_data#>>'{resources,checkInStart}' end,
    case when l.override_fields ? 'check_in_end' then l.override_fields->>'check_in_end' else l.leg_data#>>'{resources,checkInEnd}' end,
    case when l.override_fields ? 'check_in_allocation_mode' then l.override_fields->>'check_in_allocation_mode' else l.leg_data#>>'{resources,checkInAllocationMode}' end,
    case when l.side = 'ARR' then p_arr.departure else p_dep.arrival end as linked_leg_id,
    case when l.side = 'ARR' and p_arr.arrival is not null then 'TRN_DAILY_V2_' || md5(p_batch_id::text || ':' || l.sheet_name || ':' || l.source_row_number::text)
         when l.side = 'DEP' and p_dep.departure is not null then 'TRN_DAILY_V2_' || md5(p_batch_id::text || ':' || l.sheet_name || ':' || l.source_row_number::text)
         else null end as turnaround_id,
    case when l.side = 'ARR' and p_arr.arrival is not null then
           case when p_arr.departure_date > p_arr.arrival_date then 'overnight' else 'sameday' end
         when l.side = 'DEP' and p_dep.departure is not null then
           case when p_dep.departure_date > p_dep.arrival_date then 'overnight' else 'sameday' end
         else null end as link_type,
    case when l.side = 'ARR' and p_arr.arrival is not null then p_arr.arrival_date
         when l.side = 'DEP' and p_dep.departure is not null then p_dep.arrival_date
         else null end as pair_anchor_date,
    'daily_import',
    p_batch_id,
    l.occurrence_key,
    l.source_row_number,
    v_actor,
    v_actor
  from public.operational_daily_import_legs l
  left join temp_pairs p_arr on l.side = 'ARR' and p_arr.arrival = l.leg_id
  left join temp_pairs p_dep on l.side = 'DEP' and p_dep.departure = l.leg_id
  where l.batch_id = p_batch_id;

  -- Bulk insert counters
  insert into public.operational_leg_counters(leg_id, counter_group, item_index, counter_value)
  select l.leg_id, c.counter_group, c.item_index, c.counter_value
  from public.operational_daily_import_legs l
  cross join lateral jsonb_to_recordset(l.override_fields->'counters') c(counter_group text, item_index integer, counter_value text)
  where l.batch_id = p_batch_id and l.override_fields ? 'counters';

  insert into public.operational_leg_counters(leg_id, counter_group, item_index, counter_value)
  select l.leg_id, '__single__', (t.ordinality - 1)::integer, btrim(t.value)
  from public.operational_daily_import_legs l
  cross join lateral unnest(string_to_array(
    case when l.override_fields ? 'counter_token' then nullif(l.override_fields->>'counter_token', '')
         else nullif(l.leg_data#>>'{resources,counter}', '') end,
    ','
  )) with ordinality t(value, ordinality)
  where l.batch_id = p_batch_id and not (l.override_fields ? 'counters') and btrim(t.value) <> '';

  -- Bulk insert check-in windows with safe non-object check
  insert into public.operational_leg_checkin_windows(leg_id, counter_key, window_start, window_end)
  select l.leg_id, w.counter_key, w.window_start, w.window_end
  from public.operational_daily_import_legs l
  cross join lateral jsonb_to_recordset(l.override_fields->'checkin_windows') w(counter_key text, window_start text, window_end text)
  where l.batch_id = p_batch_id and l.override_fields ? 'checkin_windows';

  insert into public.operational_leg_checkin_windows(leg_id, counter_key, window_start, window_end)
  select l.leg_id, w.key, w.value->>'start', w.value->>'end'
  from public.operational_daily_import_legs l
  cross join lateral jsonb_each(
    case when jsonb_typeof(l.leg_data#>'{resources,checkInCounterWindows}') = 'object'
         then l.leg_data#>'{resources,checkInCounterWindows}'
         else '{}'::jsonb end
  ) w
  where l.batch_id = p_batch_id and not (l.override_fields ? 'checkin_windows')
    and w.value->>'start' is not null and w.value->>'end' is not null;

  -- Bulk insert resource overrides
  insert into public.operational_resource_overrides(leg_id, fields)
  select l.leg_id, l.override_fields
  from public.operational_daily_import_legs l
  where l.batch_id = p_batch_id and l.override_fields <> '{}'::jsonb;

  -- Set-based Authority update for all affected days
  drop table if exists pg_temp.temp_commit_day_counts;
  create temporary table temp_commit_day_counts on commit drop as
  select operational_date, count(*) as leg_count
  from public.operational_daily_import_legs
  where batch_id = p_batch_id
  group by operational_date;

  -- Record previous authority states for change events
  insert into public.operational_change_events(
    actor_id, request_id, target_type, target_id, operational_date, changed_fields, before_state, after_state
  )
  select
    v_actor, v_batch.request_id, 'dailyAuthority', d::text, d, array['daily_import'],
    coalesce(to_jsonb(a), 'null'::jsonb),
    jsonb_build_object(
      'operational_date', d,
      'authority_source', 'daily_import',
      'source_batch_id', p_batch_id,
      'leg_count', coalesce(c.leg_count, 0),
      'canonical_checksum', v_batch.canonical_checksum,
      'authority_revision', coalesce(a.authority_revision, 0) + 1,
      'committed_by', v_actor
    )
  from unnest(v_stage.affected_dates) d
  left join public.operational_day_authority a on a.operational_date = d
  left join temp_commit_day_counts c on c.operational_date = d;

  insert into public.operational_day_authority(
    operational_date, authority_source, source_batch_id, leg_count, canonical_checksum, committed_by
  )
  select
    d, 'daily_import', p_batch_id, coalesce(c.leg_count, 0), v_batch.canonical_checksum, v_actor
  from unnest(v_stage.affected_dates) d
  left join temp_commit_day_counts c on c.operational_date = d
  on conflict (operational_date) do update set
    source_batch_id = excluded.source_batch_id,
    leg_count = excluded.leg_count,
    canonical_checksum = excluded.canonical_checksum,
    authority_revision = public.operational_day_authority.authority_revision + 1,
    committed_at = now(),
    committed_by = v_actor,
    reset_at = null,
    reset_by = null,
    reset_reason = null;

  insert into public.operational_day_authority_events(
    operational_date, event_type, source_batch_id, leg_count, canonical_checksum, authority_revision, actor_user_id
  )
  select
    a.operational_date, 'commit', p_batch_id, a.leg_count, a.canonical_checksum, a.authority_revision, v_actor
  from public.operational_day_authority a
  where a.operational_date = any(v_stage.affected_dates);

  select revision into v_revision from public.operational_workspace_revision where singleton;

  v_result := jsonb_build_object(
    'status', 'committed',
    'batchId', p_batch_id,
    'affectedDates', v_stage.affected_dates,
    'insertedCount', (select count(*) from public.operational_daily_import_legs where batch_id = p_batch_id),
    'replacedCount', v_replaced,
    'revision', v_revision::text
  );

  update public.daily_schedule_import_batches
  set status = 'committed', committed_at = now(), result = v_result
  where batch_id = p_batch_id;

  update public.operational_daily_import_uploads
  set status = 'committed'
  where upload_id = p_batch_id;

  perform pg_notify('operational_projection_wake', p_batch_id::text);
  return public.daily_schedule_import_v1_response(p_batch_id);
end;
$$;

-- 7. get_daily_schedule_import_v2_status & cancel_daily_schedule_import_v2
create or replace function public.get_daily_schedule_import_v2_status(
  p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_batch uuid;
begin
  if auth.uid() is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  select batch_id into v_batch
  from public.daily_schedule_import_batches
  where request_id = p_request_id and created_by = auth.uid() and contract_version = 2
  for update;

  if not found then
    return null;
  end if;

  update public.daily_schedule_import_batches
  set status = 'expired'
  where batch_id = v_batch and status in ('validated', 'failed') and expires_at <= now();

  update public.operational_daily_import_uploads
  set status = 'expired'
  where upload_id = v_batch and status in ('uploading', 'staged') and expires_at <= now();

  return public.daily_schedule_import_v1_response(v_batch);
end;
$$;

create or replace function public.cancel_daily_schedule_import_v2(
  p_batch_id uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_upload public.operational_daily_import_uploads%rowtype;
  v_batch public.daily_schedule_import_batches%rowtype;
begin
  if auth.uid() is null or public.app_operator_has_permission('daily.write') is not true then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;

  -- Deadlock-free hierarchy: Level 2 upload (update), Level 3 batch (update)
  select * into v_upload
  from public.operational_daily_import_uploads
  where upload_id = p_batch_id and created_by = auth.uid()
  for update;

  select * into v_batch
  from public.daily_schedule_import_batches
  where batch_id = p_batch_id and created_by = auth.uid() and contract_version = 2
  for update;

  if not found then
    raise exception 'Daily V2 batch not found' using errcode = 'P0002';
  end if;

  update public.daily_schedule_import_batches
  set status = 'cancelled', cancelled_at = now()
  where batch_id = p_batch_id and status in ('validated', 'failed');

  update public.operational_daily_import_uploads
  set status = 'cancelled'
  where upload_id = p_batch_id and status in ('uploading', 'staged', 'failed');

  return public.daily_schedule_import_v1_response(p_batch_id);
end;
$$;

-- 8. Grants
revoke all on function public.begin_daily_schedule_import_upload_v2(jsonb, integer, integer),
  public.append_daily_schedule_import_upload_v2(uuid, integer, jsonb),
  public.finalize_daily_schedule_import_upload_v2(uuid),
  public.stage_daily_schedule_import_v2(jsonb),
  public.commit_daily_schedule_import_v2(uuid, text),
  public.get_daily_schedule_import_v2_status(uuid),
  public.cancel_daily_schedule_import_v2(uuid)
  from public, anon;

grant execute on function public.begin_daily_schedule_import_upload_v2(jsonb, integer, integer),
  public.append_daily_schedule_import_upload_v2(uuid, integer, jsonb),
  public.finalize_daily_schedule_import_upload_v2(uuid),
  public.stage_daily_schedule_import_v2(jsonb),
  public.commit_daily_schedule_import_v2(uuid, text),
  public.get_daily_schedule_import_v2_status(uuid),
  public.cancel_daily_schedule_import_v2(uuid)
  to authenticated;

commit;
