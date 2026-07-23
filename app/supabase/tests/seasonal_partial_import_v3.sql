begin;

do $$
declare
  v_existing_target boolean;
  v_new_target boolean;
  v_existing_insert_target boolean;
  v_new_insert_target boolean;
  v_error_code text;
  v_source_row_nullable text;
begin
  if (
    select source_provenance_mode
    from public.seasons
    where id = 'season-with-source'
  ) is distinct from 'full' then
    raise exception 'season with source snapshot was not backfilled to full provenance';
  end if;

  if (
    select source_provenance_mode
    from public.seasons
    where id = 'season-existing'
  ) is distinct from 'none' then
    raise exception 'season without source snapshot did not retain none provenance';
  end if;

  select target_existed_at_stage
  into v_existing_target
  from public.season_import_batches
  where request_id = '10000000-0000-4000-8000-000000000001';

  select target_existed_at_stage
  into v_new_target
  from public.season_import_batches
  where request_id = '10000000-0000-4000-8000-000000000002';

  if v_existing_target is distinct from true then
    raise exception 'existing-season V2 batch target was not backfilled';
  end if;
  if v_new_target is distinct from false then
    raise exception 'new-season V2 batch target was incorrectly backfilled';
  end if;

  begin
    update public.season_import_batches
    set status = 'committed'
    where request_id = '10000000-0000-4000-8000-000000000001';
    raise exception 'existing-season V2 commit guard did not fire';
  exception
    when feature_not_supported then
      get stacked diagnostics v_error_code = returned_sqlstate;
      if v_error_code <> '0A000' then
        raise;
      end if;
  end;

  update public.season_import_batches
  set status = 'committed'
  where request_id = '10000000-0000-4000-8000-000000000002';

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    checksum,
    status,
    created_by
  ) values (
    '10000000-0000-4000-8000-000000000003',
    'season-existing',
    'S26',
    7,
    'existing-after-migration',
    'validated',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );

  insert into public.season_import_batches (
    request_id,
    season_id,
    season_code,
    expected_data_version,
    checksum,
    status,
    created_by
  ) values (
    '10000000-0000-4000-8000-000000000004',
    null,
    'W27',
    0,
    'new-after-migration',
    'validated',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );

  select target_existed_at_stage
  into v_existing_insert_target
  from public.season_import_batches
  where request_id = '10000000-0000-4000-8000-000000000003';

  select target_existed_at_stage
  into v_new_insert_target
  from public.season_import_batches
  where request_id = '10000000-0000-4000-8000-000000000004';

  if v_existing_insert_target is distinct from true
    or v_new_insert_target is distinct from false
  then
    raise exception 'target existence insert trigger returned incorrect values';
  end if;

  begin
    insert into public.season_import_batches (
      request_id,
      season_id,
      season_code,
      expected_data_version,
      checksum,
      status,
      contract_version,
      apply_strategy,
      preview,
      preview_hash,
      expires_at,
      created_by
    ) values (
      '10000000-0000-4000-8000-000000000005',
      'season-existing',
      'S26',
      7,
      'invalid-v3',
      'validated',
      3,
      null,
      '{}'::jsonb,
      'preview',
      now() + interval '1 hour',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    raise exception 'invalid V3 contract metadata was accepted';
  exception
    when check_violation then null;
  end;

  insert into public.season_import_batches (
    batch_id,
    request_id,
    season_id,
    season_code,
    expected_data_version,
    checksum,
    status,
    contract_version,
    apply_strategy,
    target_existed_at_stage,
    preview,
    preview_hash,
    expires_at,
    cancelled_at,
    created_by
  ) values (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006',
    'season-existing',
    'S26',
    7,
    'valid-v3',
    'cancelled',
    3,
    'merge',
    true,
    '{}'::jsonb,
    'preview',
    now() + interval '1 hour',
    now(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );

  insert into public.season_import_batch_records_v3 (
    batch_id,
    occurrence_key,
    generated_record_id,
    source_staging_row_index,
    source_row_index,
    record_hash,
    record_data
  ) values (
    '20000000-0000-4000-8000-000000000001',
    'season-existing|2026-06-06|KC|KC259',
    'LEG_A_2026-06-06_KC259',
    0,
    1,
    'record-hash',
    '{"recordId":"LEG_A_2026-06-06_KC259"}'::jsonb
  );

  insert into public.season_import_batch_preimages_v3 (
    batch_id,
    record_id,
    existed_before
  ) values (
    '20000000-0000-4000-8000-000000000001',
    'LEG_A_2026-06-06_KC259',
    false
  );

  if pg_catalog.has_table_privilege(
    'authenticated',
    'public.season_import_batch_records_v3',
    'select'
  ) then
    raise exception 'authenticated retained direct staged-record read access';
  end if;

  if pg_catalog.has_table_privilege(
    'authenticated',
    'public.season_import_batch_preimages_v3',
    'select'
  ) then
    raise exception 'authenticated retained direct preimage read access';
  end if;

  select columns.is_nullable
  into v_source_row_nullable
  from information_schema.columns columns
  where columns.table_schema = 'public'
    and columns.table_name = 'season_flight_records'
    and columns.column_name = 'source_row_index';

  if v_source_row_nullable is distinct from 'NO' then
    raise exception 'source_row_index workbook identity was redefined';
  end if;

  if not exists (
    select 1
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'season_flight_records'
      and columns.column_name = 'source_import_batch_id'
      and columns.data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns columns
    where columns.table_schema = 'public'
      and columns.table_name = 'season_flight_records'
      and columns.column_name = 'source_import_staging_row_index'
      and columns.data_type = 'integer'
  ) then
    raise exception 'record-level import provenance columns are missing';
  end if;
end;
$$;

rollback;
