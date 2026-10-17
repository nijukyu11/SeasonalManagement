-- ============================================================================
-- Migration: 20261008100000_seasonal_version_management_v1.sql
-- Native seasonal version management:
--   0. seasonal_published_flight_to_draft_json_v1 (canonical SeasonalDraftRecord)
--   1. get_seasonal_published_snapshot_page_v1
--   2. get_seasonal_version_comparison_page_v1
--   3. get_seasonal_published_export_snapshot_v1
--   4. restore_seasonal_published_draft_v1
-- ============================================================================

begin;

-- 0. Canonical mapping helper: transforms snapshot flight into canonical SeasonalDraftRecord
create or replace function public.seasonal_published_flight_to_draft_json_v1(
  f jsonb,
  p_season_id text
) returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'draft_id', coalesce(f->>'draftId', f->>'draft_id'),
    'season_id', p_season_id,
    'link_id', coalesce(f->>'linkId', f->>'link_id', f->>'turnaroundId', f->>'turnaround_id', ''),
    'type', f->>'type',
    'airline', coalesce(f->>'airline', ''),
    'flight_number', coalesce(f->>'flightNumber', f->>'flight_number', ''),
    'raw_flight_number', coalesce(f->>'rawFlightNumber', f->>'raw_flight_number', ''),
    'request_status_code', coalesce(f->>'requestStatusCode', f->>'request_status_code'),
    'route', coalesce(f->>'route', ''),
    'schedule', coalesce(f->>'schedule', ''),
    'aircraft', coalesce(f->>'aircraft', ''),
    'category', coalesce(f->>'category', ''),
    'code_shares', coalesce(f->>'codeShares', f->>'code_shares'),
    'int_dom_ind', coalesce(f->>'intDomInd', f->>'int_dom_ind'),
    'pax', case when f->>'pax' is not null and btrim(f->>'pax') <> '' then (f->>'pax')::integer else null end,
    'gate', case when f->>'gate' is not null and btrim(f->>'gate') <> '' then (f->>'gate')::integer else null end,
    'stand', nullif(btrim(coalesce(f->>'stand', '')), ''),
    'carousel', case when f->>'carousel' is not null and btrim(f->>'carousel') <> '' then (f->>'carousel')::integer else null end,
    'mct', coalesce(f->>'mct', null),
    'fb', coalesce(f->>'fb', null),
    'lb', coalesce(f->>'lb', null),
    'bhs', coalesce(f->>'bhs', null),
    'ghs', coalesce(f->>'ghs', null),
    'date', coalesce(f->>'date', ''),
    'scheduled_date', coalesce(f->>'scheduledDate', f->>'scheduled_date'),
    'scheduled_time', coalesce(f->>'scheduledTime', f->>'scheduled_time'),
    'operational_date', coalesce(f->>'operationalDate', f->>'operational_date'),
    'iata_season_code', coalesce(f->>'iataSeasonCode', f->>'iata_season_code'),
    'flight_series_id', coalesce(f->>'flightSeriesId', f->>'flight_series_id'),
    'day_of_week', coalesce((f->>'dayOfWeek')::integer, (f->>'day_of_week')::integer, 0)
  ) || jsonb_build_object(
    'action', case when coalesce(f->>'status', 'active') = 'deleted' then 'deleted' else coalesce(f->>'action', null) end,
    'source_row_index', coalesce((f->>'sourceRowIndex')::integer, (f->>'source_row_index')::integer, 0),
    'linked_source_row_index', case when f->>'linkedSourceRowIndex' is not null and btrim(f->>'linkedSourceRowIndex') <> '' then (f->>'linkedSourceRowIndex')::integer
                                    when f->>'linked_source_row_index' is not null and btrim(f->>'linked_source_row_index') <> '' then (f->>'linked_source_row_index')::integer else null end,
    'link_type', coalesce(f->>'linkType', f->>'link_type'),
    'pair_anchor_date', coalesce(f->>'pairAnchorDate', f->>'pair_anchor_date'),
    'linked_draft_id', coalesce(f->>'linkedDraftId', f->>'linked_draft_id'),
    'turnaround_id', coalesce(f->>'turnaroundId', f->>'turnaround_id'),
    'source_kind', coalesce(f->>'sourceKind', f->>'source_kind', 'imported'),
    'source_side', coalesce(f->>'sourceSide', f->>'source_side', case coalesce(f->>'type', 'A') when 'A' then 'ARR' else 'DEP' end),
    'status', coalesce(f->>'status', 'active'),
    'deletion_reason', case when coalesce(f->>'status', 'active') = 'deleted' then coalesce(f->>'deletionReason', f->>'deletion_reason', 'restored_as_deleted') else null end,
    'source_import_batch_id', case when f->>'sourceImportBatchId' is not null and btrim(f->>'sourceImportBatchId') <> '' then (f->>'sourceImportBatchId')::uuid
                                   when f->>'source_import_batch_id' is not null and btrim(f->>'source_import_batch_id') <> '' then (f->>'source_import_batch_id')::uuid else null end,
    'source_import_staging_row_index', case when f->>'sourceImportStagingRowIndex' is not null and btrim(f->>'sourceImportStagingRowIndex') <> '' then (f->>'sourceImportStagingRowIndex')::integer
                                           when f->>'source_import_staging_row_index' is not null and btrim(f->>'source_import_staging_row_index') <> '' then (f->>'source_import_staging_row_index')::integer else null end,
    'source_file_hash', coalesce(f->>'sourceFileHash', f->>'source_file_hash'),
    'supersedes_draft_id', coalesce(f->>'supersedesDraftId', f->>'supersedes_draft_id'),
    'counters', coalesce(f->'counters', '[]'::jsonb),
    'checkin_windows', coalesce(f->'checkinWindows', f->'checkin_windows', '[]'::jsonb),
    'check_in_start', coalesce(f->>'checkInStart', f->>'check_in_start'),
    'check_in_end', coalesce(f->>'checkInEnd', f->>'check_in_end'),
    'check_in_allocation_mode', coalesce(f->>'checkInAllocationMode', f->>'check_in_allocation_mode')
  );
$$;

revoke all on function public.seasonal_published_flight_to_draft_json_v1(jsonb, text) from public, anon;
grant execute on function public.seasonal_published_flight_to_draft_json_v1(jsonb, text) to authenticated;

-- 1. Shared snapshot paging: get_seasonal_published_snapshot_page_v1
create or replace function public.get_seasonal_published_snapshot_page_v1(
  p_version_id uuid,
  p_after_draft_id text default null,
  p_page_size integer default 200
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version public.seasonal_publish_versions%rowtype;
  v_snapshot public.seasonal_publish_snapshots%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  if p_page_size is null or p_page_size not between 1 and 1000 then
    raise exception 'Invalid page size' using errcode = '22023';
  end if;

  select * into v_version
  from public.seasonal_publish_versions
  where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  select * into v_snapshot
  from public.seasonal_publish_snapshots
  where version_id = p_version_id;
  if not found then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  with normalized_flights as (
    select public.seasonal_published_flight_to_draft_json_v1(f, v_version.season_id) as draft_row
    from jsonb_array_elements(coalesce(v_snapshot.snapshot_payload->'flights', '[]'::jsonb)) f
  ), active_flights as (
    select draft_row, draft_row->>'draft_id' as draft_id
    from normalized_flights
    where draft_row->>'status' = 'active'
  ), candidates as materialized (
    select draft_row, draft_id
    from active_flights
    where (p_after_draft_id is null or draft_id > p_after_draft_id)
    order by draft_id
    limit p_page_size + 1
  ), page as (
    select draft_row, draft_id
    from candidates
    order by draft_id
    limit p_page_size
  )
  select jsonb_build_object(
    'versionId', v_version.version_id,
    'seasonId', v_version.season_id,
    'seasonCode', v_version.season_code,
    'checksum', v_snapshot.checksum,
    'totalCount', (select count(*) from active_flights),
    'flights', coalesce((select jsonb_agg(draft_row order by draft_id) from page), '[]'::jsonb),
    'hasMore', (select count(*) from candidates) > p_page_size,
    'nextDraftId', (select max(draft_id) from page)
  ) into v_result;

  return v_result;
end;
$$;

-- 2. Arbitrary same-season version diff: get_seasonal_version_comparison_page_v1
create or replace function public.get_seasonal_version_comparison_page_v1(
  p_base_version_id uuid,
  p_version_id uuid,
  p_after_index bigint default 0,
  p_page_size integer default 100
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_base_version public.seasonal_publish_versions%rowtype;
  v_version public.seasonal_publish_versions%rowtype;
  v_base_snapshot jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_result jsonb;
  v_matches_stored boolean := false;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  if p_page_size is null or p_page_size not between 1 and 500 or p_after_index is null or p_after_index < 0 then
    raise exception 'Invalid diff page' using errcode = '22023';
  end if;

  if p_version_id is null then
    raise exception 'Version ID required' using errcode = '22023';
  end if;

  select * into v_version from public.seasonal_publish_versions where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  if p_base_version_id is not null then
    select * into v_base_version from public.seasonal_publish_versions where version_id = p_base_version_id;
    if not found then
      raise exception 'Base version not found' using errcode = 'P0002';
    end if;

    if v_base_version.season_id <> v_version.season_id then
      raise exception 'Cannot compare versions across different seasons' using errcode = '22023';
    end if;
  end if;

  -- Fast path: if exact pair exists in pre-calculated diff entries
  select exists (
    select 1
    from public.seasonal_publish_diff_entries
    where version_id = p_version_id
      and (base_version_id is not distinct from p_base_version_id)
  ) into v_matches_stored;

  if v_matches_stored then
    with candidates as materialized (
      select *
      from public.seasonal_publish_diff_entries
      where version_id = p_version_id
        and (base_version_id is not distinct from p_base_version_id)
        and entry_index > p_after_index
      order by entry_index
      limit p_page_size + 1
    ), page as (
      select *
      from candidates
      order by entry_index
      limit p_page_size
    )
    select jsonb_build_object(
      'entries', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('entry_index', p.entry_index::text) order by p.entry_index) from page p), '[]'::jsonb),
      'hasMore', (select count(*) > p_page_size from candidates),
      'nextIndex', (select max(p.entry_index)::text from page p)
    ) into v_result;

    return v_result;
  end if;

  -- Arbitrary comparison between any two versions of the same season
  if p_base_version_id is not null then
    select snapshot_payload into v_base_snapshot
    from public.seasonal_publish_snapshots
    where version_id = p_base_version_id;
  end if;

  select snapshot_payload into v_snapshot
  from public.seasonal_publish_snapshots
  where version_id = p_version_id;

  with raw_diff as materialized (
    select *
    from public.seasonal_planning_diff_v1(v_base_snapshot, v_snapshot)
    where change_type in ('added', 'modified', 'removed')
  ), ordered_diff as (
    select
      row_number() over (order by operational_date, side, flight_number, source_draft_id) as entry_index,
      gen_random_uuid() as diff_id,
      p_version_id as version_id,
      p_base_version_id as base_version_id,
      v_version.season_id as season_id,
      change_type,
      flight_key,
      source_draft_id,
      operational_date,
      side,
      airline,
      flight_number,
      before_state,
      after_state,
      changed_fields
    from raw_diff
  ), candidates as materialized (
    select *
    from ordered_diff
    where entry_index > p_after_index
    order by entry_index
    limit p_page_size + 1
  ), page as (
    select *
    from candidates
    order by entry_index
    limit p_page_size
  )
  select jsonb_build_object(
    'entries', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('entry_index', p.entry_index::text) order by p.entry_index) from page p), '[]'::jsonb),
    'hasMore', (select count(*) > p_page_size from candidates),
    'nextIndex', (select max(p.entry_index)::text from page p)
  ) into v_result;

  return v_result;
end;
$$;

-- 3. Historical export: get_seasonal_published_export_snapshot_v1
create or replace function public.get_seasonal_published_export_snapshot_v1(
  p_version_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set statement_timeout = '30s'
as $$
declare
  v_version public.seasonal_publish_versions%rowtype;
  v_snapshot public.seasonal_publish_snapshots%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  if p_version_id is null then
    raise exception 'Version ID required' using errcode = '22023';
  end if;

  select * into v_version
  from public.seasonal_publish_versions
  where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  select * into v_snapshot
  from public.seasonal_publish_snapshots
  where version_id = p_version_id;
  if not found then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  with normalized_flights as (
    select public.seasonal_published_flight_to_draft_json_v1(f, v_version.season_id) as draft_row
    from jsonb_array_elements(coalesce(v_snapshot.snapshot_payload->'flights', '[]'::jsonb)) f
  ), active_flights as materialized (
    select
      draft_row->>'draft_id' as draft_id,
      draft_row->'counters' as counters,
      draft_row->'checkin_windows' as checkin_windows,
      (draft_row - array['draft_id', 'counters', 'checkin_windows']) || jsonb_build_object(
        'record_id', draft_row->>'draft_id',
        'linked_record_id', draft_row->>'linked_draft_id'
      ) as export_record
    from normalized_flights
    where draft_row->>'status' = 'active'
  )
  select jsonb_build_object(
    'seasonId', v_version.season_id,
    'seasonCode', v_version.season_code,
    'versionId', v_version.version_id,
    'versionTag', v_version.version_tag,
    'draftRevision', v_version.publish_sequence::text,
    'draftEpoch', v_version.version_id::text,
    'totalCount', (select count(*) from active_flights),
    'serverHighWater', coalesce((select max(server_seq) from public.seasonal_draft_events where season_id = v_version.season_id), 0)::text,
    'truncated', false,
    'flightRecords', coalesce((
      select jsonb_agg(export_record order by draft_id)
      from active_flights
    ), '[]'::jsonb),
    'flightRecordCounters', coalesce((
      select jsonb_agg(
        c || jsonb_build_object('record_id', d.draft_id)
        order by d.draft_id, c->>'counter_group', (c->>'item_index')::integer
      )
      from active_flights d cross join lateral jsonb_array_elements(d.counters) c
    ), '[]'::jsonb),
    'flightRecordWindows', coalesce((
      select jsonb_agg(
        w || jsonb_build_object('record_id', d.draft_id)
        order by d.draft_id, w->>'counter_key'
      )
      from active_flights d cross join lateral jsonb_array_elements(d.checkin_windows) w
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- 4. Restore historical version to draft: restore_seasonal_published_draft_v1
create or replace function public.restore_seasonal_published_draft_v1(
  p_season_id text,
  p_version_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_expected_epoch uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set statement_timeout = '30s'
as $$
declare
  v_actor uuid := auth.uid();
  v_season public.seasons%rowtype;
  v_workspace public.seasonal_draft_workspace%rowtype;
  v_version public.seasonal_publish_versions%rowtype;
  v_snapshot jsonb;
  v_receipt public.seasonal_draft_mutation_receipts%rowtype;
  v_request jsonb := jsonb_build_object(
    'action', 'restore_published_version',
    'seasonId', p_season_id,
    'versionId', p_version_id::text,
    'revision', p_expected_revision::text,
    'epoch', p_expected_epoch::text
  );
  v_result jsonb;
  v_new_revision bigint;
  v_new_epoch uuid;
  v_high_water bigint;
  v_restore_seq bigint;
begin
  if v_actor is null or public.app_operator_has_permission('seasonal.write') is not true then
    raise exception 'seasonal.write permission required' using errcode = '42501';
  end if;

  if p_season_id is null or p_version_id is null or p_request_id is null
     or p_expected_revision is null or p_expected_epoch is null then
    raise exception 'All parameters are required' using errcode = '22023';
  end if;

  -- Advisory lock on actor and request_id to prevent concurrent races
  perform pg_advisory_xact_lock(hashtextextended('restore-draft:' || v_actor::text || ':' || p_request_id::text, 0));

  -- Lock season and draft workspace
  perform 1 from public.seasons where id = p_season_id for update;
  if not found then
    raise exception 'Season not found' using errcode = 'P0002';
  end if;

  insert into public.seasonal_draft_workspace(season_id) values (p_season_id) on conflict do nothing;
  select * into strict v_workspace from public.seasonal_draft_workspace where season_id = p_season_id for update;

  -- Check receipt for exact idempotent retry
  select * into v_receipt
  from public.seasonal_draft_mutation_receipts
  where actor_id = v_actor and request_id = p_request_id;

  if found then
    if v_receipt.request_payload is distinct from v_request then
      raise exception 'Request ID reused with different payload' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;

  -- Guard against concurrent changes or stale workspace snapshot
  if v_workspace.revision <> p_expected_revision or v_workspace.epoch <> p_expected_epoch then
    raise exception 'Draft snapshot changed' using errcode = '40001';
  end if;

  -- Validate version ownership
  select * into v_version
  from public.seasonal_publish_versions
  where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  if v_version.season_id <> p_season_id then
    raise exception 'Version does not belong to specified season' using errcode = '22023';
  end if;

  -- Retrieve snapshot
  select snapshot_payload into v_snapshot
  from public.seasonal_publish_snapshots
  where version_id = p_version_id;
  if not found or v_snapshot is null then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  -- Stage unpacked snapshot flights using canonical helper and jsonb_populate_record
  drop table if exists pg_temp.restored_snapshot_flights;
  create temporary table pg_temp.restored_snapshot_flights on commit drop as
  select d.*
  from jsonb_array_elements(coalesce(v_snapshot->'flights', '[]'::jsonb)) f
  cross join lateral jsonb_populate_record(
    null::public.seasonal_flight_drafts,
    public.seasonal_published_flight_to_draft_json_v1(f, p_season_id)
  ) d;

  -- Snapshot drafts before restore to produce audit diff events
  drop table if exists pg_temp.drafts_before;
  create temporary table pg_temp.drafts_before on commit drop as
  select d.draft_id, to_jsonb(d) as before_state
  from public.seasonal_flight_drafts d
  where d.season_id = p_season_id;

  -- 1. Tombstone active drafts not present in restored active snapshot.
  -- Retains row and FKs for operational lineage and published diff references.
  update public.seasonal_flight_drafts d
  set
    status = 'deleted',
    action = 'deleted',
    deletion_reason = 'restored_version_superseded',
    linked_draft_id = null,
    turnaround_id = null,
    link_type = null,
    pair_anchor_date = null,
    lifecycle_changed_at = now(),
    lifecycle_changed_by = v_actor,
    updated_at = now(),
    updated_by = v_actor
  where d.season_id = p_season_id
    and d.status = 'active'
    and not exists (
      select 1
      from pg_temp.restored_snapshot_flights r
      where r.draft_id = d.draft_id and r.status = 'active'
    );

  -- 2. Update drafts that exist in seasonal_flight_drafts
  update public.seasonal_flight_drafts d
  set
    type = r.type,
    airline = r.airline,
    flight_number = r.flight_number,
    raw_flight_number = r.raw_flight_number,
    request_status_code = r.request_status_code,
    route = r.route,
    schedule = r.schedule,
    aircraft = r.aircraft,
    category = r.category,
    code_shares = r.code_shares,
    int_dom_ind = r.int_dom_ind,
    pax = r.pax,
    gate = r.gate,
    stand = r.stand,
    carousel = r.carousel,
    mct = r.mct,
    fb = r.fb,
    lb = r.lb,
    bhs = r.bhs,
    ghs = r.ghs,
    date = r.date,
    scheduled_date = r.scheduled_date,
    scheduled_time = r.scheduled_time,
    operational_date = r.operational_date,
    iata_season_code = r.iata_season_code,
    flight_series_id = r.flight_series_id,
    day_of_week = r.day_of_week,
    action = r.action,
    source_row_index = r.source_row_index,
    linked_source_row_index = r.linked_source_row_index,
    link_type = r.link_type,
    pair_anchor_date = r.pair_anchor_date,
    linked_draft_id = r.linked_draft_id,
    turnaround_id = r.turnaround_id,
    source_kind = r.source_kind,
    source_side = r.source_side,
    status = r.status,
    deletion_reason = r.deletion_reason,
    source_import_batch_id = r.source_import_batch_id,
    source_import_staging_row_index = r.source_import_staging_row_index,
    source_file_hash = r.source_file_hash,
    supersedes_draft_id = r.supersedes_draft_id,
    counters = r.counters,
    checkin_windows = r.checkin_windows,
    check_in_start = r.check_in_start,
    check_in_end = r.check_in_end,
    check_in_allocation_mode = r.check_in_allocation_mode,
    lifecycle_changed_at = case when d.status <> r.status or coalesce(d.action, '') <> coalesce(r.action, '') then now() else d.lifecycle_changed_at end,
    lifecycle_changed_by = case when d.status <> r.status or coalesce(d.action, '') <> coalesce(r.action, '') then v_actor else d.lifecycle_changed_by end,
    updated_at = now(),
    updated_by = v_actor
  from pg_temp.restored_snapshot_flights r
  where d.season_id = p_season_id and d.draft_id = r.draft_id;

  -- 3. Insert drafts from snapshot that do not exist yet in seasonal_flight_drafts
  insert into public.seasonal_flight_drafts (
    draft_id, season_id, type, airline, flight_number, raw_flight_number, request_status_code,
    route, schedule, aircraft, category, code_shares, int_dom_ind, pax, gate, stand,
    carousel, mct, fb, lb, bhs, ghs, date, scheduled_date, scheduled_time, operational_date,
    iata_season_code, flight_series_id, day_of_week, action, source_row_index,
    linked_source_row_index, link_type, pair_anchor_date, linked_draft_id, turnaround_id,
    source_kind, source_side, status, deletion_reason, source_import_batch_id,
    source_import_staging_row_index, source_file_hash, supersedes_draft_id, counters,
    checkin_windows, check_in_start, check_in_end, check_in_allocation_mode,
    lifecycle_changed_at, lifecycle_changed_by, created_at, updated_at, updated_by
  )
  select
    r.draft_id, p_season_id, r.type, r.airline, r.flight_number, r.raw_flight_number, r.request_status_code,
    r.route, r.schedule, r.aircraft, r.category, r.code_shares, r.int_dom_ind, r.pax, r.gate, r.stand,
    r.carousel, r.mct, r.fb, r.lb, r.bhs, r.ghs, r.date, r.scheduled_date, r.scheduled_time, r.operational_date,
    r.iata_season_code, r.flight_series_id, r.day_of_week, r.action, r.source_row_index,
    r.linked_source_row_index, r.link_type, r.pair_anchor_date, r.linked_draft_id, r.turnaround_id,
    r.source_kind, r.source_side, r.status, r.deletion_reason, r.source_import_batch_id,
    r.source_import_staging_row_index, r.source_file_hash, r.supersedes_draft_id, r.counters,
    r.checkin_windows, r.check_in_start, r.check_in_end, r.check_in_allocation_mode,
    now(), v_actor, now(), now(), v_actor
  from pg_temp.restored_snapshot_flights r
  where not exists (
    select 1
    from public.seasonal_flight_drafts d
    where d.season_id = p_season_id and d.draft_id = r.draft_id
  );

  -- 4. Verify reciprocal pairing for active drafts
  if exists (
    select 1
    from public.seasonal_flight_drafts d
    left join public.seasonal_flight_drafts partner on partner.draft_id = d.linked_draft_id
    where d.season_id = p_season_id and d.status = 'active' and (
      (d.linked_draft_id is not null and partner.draft_id is null)
      or (d.linked_draft_id is not null and partner.status <> 'active')
      or (d.linked_draft_id is not null and partner.linked_draft_id <> d.draft_id)
      or (d.linked_draft_id is not null and partner.season_id <> d.season_id)
    )
  ) then
    raise exception 'Draft pairing must be reciprocal, active and within the season' using errcode = '22023';
  end if;

  -- 5. Record draft audit events
  insert into public.seasonal_draft_events (
    season_id, client_id, op_id, actor_user_id, server_seq, target_type, target_id,
    changed_fields, before_state, after_state
  )
  select
    p_season_id,
    'restore-v1:' || v_actor::text,
    p_request_id::text || ':' || coalesce(d.draft_id, b.draft_id),
    v_actor,
    nextval('public.seasonal_draft_event_seq'),
    'draft',
    coalesce(d.draft_id, b.draft_id),
    array['restore_version'],
    b.before_state,
    to_jsonb(d)
  from (select * from public.seasonal_flight_drafts where season_id = p_season_id) d
  full outer join pg_temp.drafts_before b on b.draft_id = d.draft_id
  where b.before_state is distinct from to_jsonb(d);

  -- 6. Record restore summary event
  v_restore_seq := nextval('public.seasonal_draft_event_seq');
  insert into public.seasonal_draft_events (
    season_id, client_id, op_id, actor_user_id, server_seq, target_type, target_id,
    changed_fields, before_state, after_state
  ) values (
    p_season_id,
    'restore-v1:' || v_actor::text,
    p_request_id::text || ':summary',
    v_actor,
    v_restore_seq,
    'season_restore',
    p_season_id,
    array['restored_version_id', 'restored_version_tag'],
    jsonb_build_object('baseRevision', p_expected_revision::text, 'baseEpoch', p_expected_epoch::text),
    jsonb_build_object('versionId', p_version_id, 'versionTag', v_version.version_tag)
  );

  -- 7. Advance workspace epoch and revision
  update public.seasonal_draft_workspace
  set
    epoch = gen_random_uuid(),
    revision = revision + 1
  where season_id = p_season_id
  returning revision, epoch into v_new_revision, v_new_epoch;

  -- 8. Build authoritative SeasonalDraftWindowResult
  select coalesce(max(server_seq), 0) into v_high_water
  from public.seasonal_draft_events
  where season_id = p_season_id;

  with active_drafts as materialized (
    select *
    from public.seasonal_flight_drafts
    where season_id = p_season_id and status = 'active'
    order by draft_id
  )
  select jsonb_build_object(
    'status', 'committed',
    'requestId', p_request_id,
    'versionId', p_version_id,
    'revision', v_new_revision::text,
    'epoch', v_new_epoch,
    'serverHighWater', v_high_water::text,
    'drafts', coalesce((select jsonb_agg(to_jsonb(d) order by draft_id) from active_drafts d), '[]'::jsonb),
    'hasMore', false,
    'nextDraftId', null
  ) into v_result;

  if v_result is null then
    v_result := jsonb_build_object(
      'status', 'committed',
      'requestId', p_request_id,
      'versionId', p_version_id,
      'revision', v_new_revision::text,
      'epoch', v_new_epoch,
      'serverHighWater', v_high_water::text,
      'drafts', '[]'::jsonb,
      'hasMore', false,
      'nextDraftId', null
    );
  end if;

  -- 9. Record mutation receipt
  insert into public.seasonal_draft_mutation_receipts(
    actor_id, request_id, season_id, request_payload, result
  ) values (
    v_actor, p_request_id, p_season_id, v_request, v_result
  );

  return v_result;
end;
$$;

-- Revoke & Grant permissions
revoke all on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) from public, anon;
grant execute on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) to authenticated;

revoke all on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) from public, anon;
grant execute on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) to authenticated;

revoke all on function public.get_seasonal_published_export_snapshot_v1(uuid) from public, anon;
grant execute on function public.get_seasonal_published_export_snapshot_v1(uuid) to authenticated;

revoke all on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) to authenticated;

commit;
