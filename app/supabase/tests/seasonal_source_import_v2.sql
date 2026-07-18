begin;

select set_config('request.jwt.claim.sub', 'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31', true);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31',
  'authenticated',
  'authenticated',
  'seasonal-import-v2-test@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  'd11b35f2-62b1-4310-b3ca-4d46762c79e8',
  'authenticated',
  'authenticated',
  'seasonal-import-v2-retry@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.app_operators (
  user_id,
  email,
  username,
  display_name
)
values (
  'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31',
  'seasonal-import-v2-test@example.invalid',
  'seasonal_import_v2_test',
  'Seasonal Import V2 Test'
);

insert into public.app_operators (
  user_id,
  email,
  username,
  display_name
)
values (
  'd11b35f2-62b1-4310-b3ca-4d46762c79e8',
  'seasonal-import-v2-retry@example.invalid',
  'seasonal_import_v2_retry',
  'Seasonal Import V2 Retry'
);

insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
values ('a2a8ee9c-8e84-4cb7-aef6-358af42c3b31', 'seasonal.write', 'allow');

insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
values ('d11b35f2-62b1-4310-b3ca-4d46762c79e8', 'seasonal.write', 'allow');

insert into public.seasons (
  id,
  season_code,
  name,
  file_name,
  uploaded_at,
  effective_start,
  effective_end,
  total_legs,
  total_source_rows,
  data_version
)
values (
  'seasonal-import-v2-test-season',
  'TV2',
  'Seasonal Import V2 Test',
  '',
  0,
  '',
  '',
  0,
  0,
  3
);

do $$
begin
  if has_table_privilege('authenticated', 'public.season_import_batches', 'SELECT')
    or has_table_privilege('authenticated', 'public.season_import_batches', 'INSERT')
    or has_table_privilege('authenticated', 'public.season_import_batches', 'UPDATE')
    or has_table_privilege('authenticated', 'public.season_import_batches', 'DELETE')
    or has_table_privilege('authenticated', 'public.season_import_batch_rows', 'SELECT')
    or has_table_privilege('authenticated', 'public.season_import_batch_rows', 'INSERT')
    or has_table_privilege('authenticated', 'public.season_import_batch_rows', 'UPDATE')
    or has_table_privilege('authenticated', 'public.season_import_batch_rows', 'DELETE')
  then
    raise exception 'authenticated must not have direct import staging table privileges';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.stage_seasonal_import_v2(jsonb)',
    'EXECUTE'
  ) then
    raise exception 'authenticated must have execute on stage_seasonal_import_v2(jsonb)';
  end if;

  if has_function_privilege('anon', 'public.stage_seasonal_import_v2(jsonb)', 'EXECUTE') then
    raise exception 'anon must not have execute on stage_seasonal_import_v2(jsonb)';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.commit_seasonal_import_v2(uuid,integer)',
    'EXECUTE'
  ) then
    raise exception 'authenticated must have execute on commit_seasonal_import_v2(uuid,integer)';
  end if;

  if has_function_privilege(
    'anon',
    'public.commit_seasonal_import_v2(uuid,integer)',
    'EXECUTE'
  ) then
    raise exception 'anon must not have execute on commit_seasonal_import_v2(uuid,integer)';
  end if;

  if not exists (
    select 1
    from pg_proc procedures
    join pg_namespace namespaces on namespaces.oid = procedures.pronamespace
    join pg_language languages on languages.oid = procedures.prolang
    where namespaces.nspname = 'public'
      and procedures.proname = 'commit_seasonal_import_v2'
      and pg_get_function_identity_arguments(procedures.oid) = 'p_batch_id uuid, p_expected_data_version integer'
      and languages.lanname = 'plpgsql'
      and procedures.prosecdef
      and coalesce(array_to_string(procedures.proconfig, ','), '')
        like '%search_path=pg_catalog, pg_temp%'
  ) then
    raise exception 'commit_seasonal_import_v2 must be hardened PL/pgSQL SECURITY DEFINER';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.preserve_season_import_batch_staging_metadata_v2()',
    'EXECUTE'
  ) then
    raise exception 'authenticated must not execute the staging metadata trigger function';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.generate_seasonal_import_records_v2(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.seasonal_import_generation_diagnostics_v2(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.generate_seasonal_import_records_v2(uuid)',
    'EXECUTE'
  ) then
    raise exception 'client roles must not execute internal seasonal generation functions';
  end if;

  if not exists (
    select 1
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname in ('season_import_batches', 'season_import_batch_rows')
      and pg_class.relrowsecurity
    group by pg_namespace.nspname
    having count(*) = 2
  ) then
    raise exception 'both seasonal import staging tables must have RLS enabled';
  end if;
end
$$;

set local role authenticated;

do $$
begin
  begin
    insert into public.season_import_batches (
      request_id,
      season_code,
      checksum,
      status,
      created_by
    )
    values (
      '7497b777-0c31-4f3c-909a-c51ac4e260f2',
      'TV2',
      'direct-table-write',
      'staged',
      auth.uid()
    );
    raise exception 'authenticated direct batch insert was not rejected';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.season_import_batch_rows (batch_id, row_index, row_data)
    values ('7497b777-0c31-4f3c-909a-c51ac4e260f2', 0, '{}'::jsonb);
    raise exception 'authenticated direct batch-row insert was not rejected';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

do $$
declare
  v_result jsonb;
  v_commit jsonb;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '6beb1398-52a5-4340-93b8-bb0cb32094ec',
    'checksum', 'authenticated-rpc-path',
    'seasonId', 'seasonal-import-v2-test-season',
    'seasonCode', 'TV2',
    'expectedDataVersion', 3,
    'fileName', 'authenticated.xlsx',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 1,
      'effective', '2028-02-29',
      'discontinue', '2028-02-29',
      'airline', 'VN',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
      'sta', '07:05',
      'arrFlight', 'VN336',
      'arrRoute', 'KIX'
    ))
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 1
    or not (v_result->>'valid')::boolean
  then
    raise exception 'authenticated RPC execute path failed: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '4cce5d13-e658-4b3e-9bb9-9036bb28b3ad',
    'checksum', 'authenticated-commit-path',
    'seasonCode', 'AV2',
    'expectedDataVersion', 0,
    'fileName', 'authenticated-commit.xlsx',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 1,
      'effective', '2028-03-01',
      'discontinue', '2028-03-01',
      'airline', 'VN',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(false, false, true, false, false, false, false),
      'sta', '07:05',
      'arrFlight', 'VN337',
      'arrRoute', 'KIX'
    ))
  ));
  perform set_config(
    'request.jwt.claim.sub',
    'd11b35f2-62b1-4310-b3ca-4d46762c79e8',
    true
  );
  v_commit := public.commit_seasonal_import_v2(
    (v_result->>'batchId')::uuid,
    0
  );

  if v_commit->>'status' <> 'committed'
    or v_commit->>'seasonCode' <> 'AV2'
    or (v_commit->>'sourceRowCount')::integer <> 1
    or (v_commit->>'flightRecordCount')::integer <> 1
    or (v_commit->>'dataVersion')::integer <> 1
  then
    raise exception 'authenticated commit RPC execute path failed: %', v_commit;
  end if;

  perform set_config(
    'request.jwt.claim.sub',
    'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31',
    true
  );
end
$$;

reset role;

do $$
begin
  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', 'dcdf8f0e-9589-4712-a132-047f5d61eb6c',
      'checksum', 'empty-source-rows',
      'seasonCode', 'TV2',
      'sourceRows', '[]'::jsonb
    ));
    raise exception 'empty sourceRows was not rejected';
  exception
    when sqlstate '22023' then
      if position('sourceRows must be a non-empty JSON array' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_payload jsonb;
  v_retry_payload jsonb;
  v_canonical_retry_payload jsonb;
  v_first jsonb;
  v_second jsonb;
  v_persisted_row_count integer;
  v_persisted_row_data jsonb;
  v_fingerprint_before text;
  v_fingerprint_after text;
  v_target_season_id_before text;
  v_target_season_id_after text;
begin
  v_payload := jsonb_build_object(
    'requestId', '94b529f8-ae7c-45d7-9887-8b5501d8a3b2',
    'checksum', 'valid-canonical-row-checksum',
    'seasonId', 'seasonal-import-v2-test-season',
    'seasonCode', 'tv2',
    'expectedDataVersion', 3,
    'fileName', 'TV2.xlsx',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 2,
      'effective', '2026-10-25',
      'discontinue', '2026-10-25',
      'airline', ' vn ',
      'aircraft', ' 321 ',
      'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
      'sta', '07:05',
      'arrFlight', ' vn336 ',
      'arrRoute', ' kix ',
      'std', null,
      'depFlight', null,
      'depRoute', null
    ))
  );

  v_first := public.stage_seasonal_import_v2(v_payload);
  v_second := public.stage_seasonal_import_v2(v_payload);

  if v_first->>'batchId' is distinct from v_second->>'batchId' then
    raise exception 'same requestId and checksum must return the same batchId';
  end if;

  if v_second->>'status' <> 'validated'
    or (v_second->>'generatedRecordCount')::integer <> 1
  then
    raise exception 'idempotent retry did not preserve validated status and generated count: %', v_second;
  end if;

  if v_first->>'status' <> 'validated'
    or (v_first->>'sourceRowCount')::integer <> 1
    or (v_first->>'generatedRecordCount')::integer <> 1
    or jsonb_array_length(v_first->'diagnostics') <> 0
    or not (v_first->>'valid')::boolean
  then
    raise exception 'valid canonical source row returned an unexpected response: %', v_first;
  end if;

  select count(*)
  into v_persisted_row_count
  from public.season_import_batch_rows rows
  where rows.batch_id = (v_first->>'batchId')::uuid;

  if v_persisted_row_count <> 1 then
    raise exception 'valid canonical source row was not staged exactly once';
  end if;

  select rows.row_data
  into v_persisted_row_data
  from public.season_import_batch_rows rows
  where rows.batch_id = (v_first->>'batchId')::uuid
    and rows.row_index = 0;

  if v_persisted_row_data->>'airline' <> 'VN'
    or v_persisted_row_data->>'aircraft' <> '321'
    or v_persisted_row_data->>'arrFlight' <> 'VN336'
    or v_persisted_row_data->>'arrRoute' <> 'KIX'
  then
    raise exception 'staged source row was not canonically normalized: %', v_persisted_row_data;
  end if;

  select
    batches.result #>> '{_staging,requestFingerprint}',
    batches.result #>> '{_staging,targetSeasonId}'
  into v_fingerprint_before, v_target_season_id_before
  from public.season_import_batches batches
  where batches.batch_id = (v_first->>'batchId')::uuid;

  if char_length(coalesce(v_fingerprint_before, '')) <> 64
    or v_target_season_id_before <> 'seasonal-import-v2-test-season'
  then
    raise exception 'existing-season fingerprint or target identity was not persisted correctly';
  end if;

  begin
    update public.season_import_batches
    set result = '"scalar"'::jsonb
    where batch_id = (v_first->>'batchId')::uuid;
    raise exception 'scalar result update was not rejected';
  exception
    when sqlstate '22023' then
      if position('result must be null or a JSON object' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    update public.season_import_batches
    set result = '[]'::jsonb
    where batch_id = (v_first->>'batchId')::uuid;
    raise exception 'array result update was not rejected';
  exception
    when sqlstate '22023' then
      if position('result must be null or a JSON object' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  update public.season_import_batches
  set result = jsonb_build_object('summary', 'future-result')
  where batch_id = (v_first->>'batchId')::uuid;

  select
    batches.result #>> '{_staging,requestFingerprint}',
    batches.result #>> '{_staging,targetSeasonId}'
  into v_fingerprint_after, v_target_season_id_after
  from public.season_import_batches batches
  where batches.batch_id = (v_first->>'batchId')::uuid;

  if v_fingerprint_after is distinct from v_fingerprint_before
    or v_target_season_id_after is distinct from v_target_season_id_before
    or not exists (
      select 1
      from public.season_import_batches batches
      where batches.batch_id = (v_first->>'batchId')::uuid
        and batches.result->>'summary' = 'future-result'
    )
  then
    raise exception 'request fingerprint was not preserved across result update';
  end if;

  v_second := public.stage_seasonal_import_v2(
    jsonb_set(v_payload, '{seasonCode}', '" TV2 "'::jsonb)
  );

  if v_second->>'batchId' is distinct from v_first->>'batchId' then
    raise exception 'normalized season identity retry did not return the original batch: %', v_second;
  end if;

  v_second := public.stage_seasonal_import_v2(v_payload - 'seasonId');

  if v_second->>'batchId' is distinct from v_first->>'batchId' then
    raise exception 'resolved season identity retry did not return the original batch: %', v_second;
  end if;

  v_canonical_retry_payload := jsonb_set(v_payload, '{sourceRows,0,airline}', '"VN"'::jsonb);
  v_canonical_retry_payload := jsonb_set(v_canonical_retry_payload, '{sourceRows,0,aircraft}', '"321"'::jsonb);
  v_canonical_retry_payload := jsonb_set(v_canonical_retry_payload, '{sourceRows,0,arrFlight}', '"VN336"'::jsonb);
  v_canonical_retry_payload := jsonb_set(v_canonical_retry_payload, '{sourceRows,0,arrRoute}', '"KIX"'::jsonb);

  begin
    perform public.stage_seasonal_import_v2(v_canonical_retry_payload);
    raise exception 'same-checksum retry with canonically equivalent but changed sourceRows was not rejected';
  exception
    when unique_violation then
      if position('different payload' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  v_retry_payload := jsonb_set(
    v_payload,
    '{sourceRows}',
    jsonb_build_array(
      jsonb_build_object('rowIndex', 900, 'effective', 'invalid'),
      jsonb_build_object('rowIndex', 901, 'effective', 'bad-date')
    )
  );

  begin
    perform public.stage_seasonal_import_v2(v_retry_payload);
    raise exception 'same-checksum retry with changed sourceRows was not rejected';
  exception
    when unique_violation then
      if position('different payload' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    perform public.stage_seasonal_import_v2(
      v_payload || jsonb_build_object('expectedDataVersion', 4)
    );
    raise exception 'retry with changed expectedDataVersion was not rejected';
  exception
    when unique_violation then
      if position('different payload' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  perform set_config('request.jwt.claim.sub', 'd11b35f2-62b1-4310-b3ca-4d46762c79e8', true);
  v_second := public.stage_seasonal_import_v2(v_payload);
  perform set_config('request.jwt.claim.sub', 'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31', true);

  if v_second->>'batchId' is distinct from v_first->>'batchId' then
    raise exception 'authorized shared retry did not return the original batch: %', v_second;
  end if;

  if (v_second - array[
    'batchId',
    'status',
    'sourceRowCount',
    'generatedRecordCount',
    'diagnostics',
    'valid'
  ]) <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(v_second)) <> 6
  then
    raise exception 'staging response exposed fields outside the planned metadata: %', v_second;
  end if;

  begin
    perform public.stage_seasonal_import_v2(
      v_payload || jsonb_build_object('checksum', 'different-checksum')
    );
    raise exception 'reused requestId with a different checksum was not rejected';
  exception
    when unique_violation then
      if position('different checksum' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_invalid_payload jsonb;
  v_corrected_payload jsonb;
  v_first jsonb;
begin
  v_invalid_payload := jsonb_build_object(
    'requestId', 'a4f147de-42ca-4ff7-a6ef-a28d135d0f8b',
    'checksum', 'invalid-then-corrected-payload',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 6,
      'effective', '2026-10-25',
      'discontinue', '2026-10-25',
      'airline', 'VN',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
      'sta', 705,
      'std', '08:05',
      'depFlight', 'VN337',
      'depRoute', 'KIX'
    ))
  );

  v_first := public.stage_seasonal_import_v2(v_invalid_payload);
  if v_first->>'status' <> 'failed' then
    raise exception 'invalid raw payload did not create the expected failed batch: %', v_first;
  end if;

  v_corrected_payload := jsonb_set(v_invalid_payload, '{sourceRows,0,sta}', 'null'::jsonb);

  begin
    perform public.stage_seasonal_import_v2(v_corrected_payload);
    raise exception 'invalid payload corrected under the same request identity was not rejected';
  exception
    when unique_violation then
      if position('different payload' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '869dfbb7-816a-43e7-82f4-1407931a4ef4',
    'checksum', 'invalid-canonical-row-checksum',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 7,
      'effective', '2026-10-25',
      'discontinue', '2026-10-25',
      'airline', '',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
      'sta', null,
      'arrFlight', null,
      'arrRoute', null,
      'std', null,
      'depFlight', null,
      'depRoute', null
    ))
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'valid')::boolean
    or jsonb_array_length(v_result->'diagnostics') < 2
  then
    raise exception 'invalid canonical row must persist blocking diagnostics: %', v_result;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '7'
      and diagnostic->>'code' = 'missing-airline'
  ) then
    raise exception 'missing-airline row diagnostic was not returned: %', v_result;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '7'
      and diagnostic->>'code' = 'no-flight-side'
  ) then
    raise exception 'no-flight-side row diagnostic was not returned: %', v_result;
  end if;
end
$$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'a1741032-4fb4-4840-b089-e286520e9a82',
    'checksum', 'invalid-calendar-dates',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 21,
        'effective', '2026-02-31',
        'discontinue', '2026-03-01',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '07:05',
        'arrFlight', 'VN321',
        'arrRoute', 'KIX'
      ),
      jsonb_build_object(
        'rowIndex', 22,
        'effective', '2026-04-01',
        'discontinue', '2026-04-31',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '08:05',
        'depFlight', 'VN322',
        'depRoute', 'KIX'
      ),
      jsonb_build_object(
        'rowIndex', 23,
        'effective', '2026-02-29',
        'discontinue', '2026-02-29',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '09:05',
        'arrFlight', 'VN323',
        'arrRoute', 'KIX'
      )
    )
  ));

  if v_result->>'status' <> 'failed' or (v_result->>'valid')::boolean then
    raise exception 'invalid calendar dates must return diagnostics instead of aborting: %', v_result;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '21'
      and diagnostic->>'code' = 'invalid-effective-date'
  ) then
    raise exception '2026-02-31 effective date diagnostic is missing: %', v_result;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '22'
      and diagnostic->>'code' = 'invalid-discontinue-date'
  ) then
    raise exception '2026-04-31 discontinue date diagnostic is missing: %', v_result;
  end if;

  if not exists (
    select 1 from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '23'
      and diagnostic->>'code' in ('invalid-effective-date', 'invalid-discontinue-date')
  ) then
    raise exception 'non-leap 2026-02-29 diagnostic is missing: %', v_result;
  end if;
end
$$;

do $$
declare
  v_result jsonb;
  v_batch_id uuid;
  v_bad_row jsonb;
  v_column text;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'ef8bfc8c-0096-4cfe-a4ce-8393b9b94f95',
    'checksum', 'strict-canonical-json-types',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', '30',
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '07:05',
        'arrFlight', 'VN330',
        'arrRoute', 'KIX'
      ),
      jsonb_build_object(
        'rowIndex', 31.5,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '07:05',
        'arrFlight', 'VN331',
        'arrRoute', 'KIX'
      ),
      jsonb_build_object(
        'rowIndex', 32,
        'effective', jsonb_build_object('bad', true),
        'discontinue', true,
        'airline', jsonb_build_object('bad', true),
        'aircraft', 321,
        'daysOfWeek', jsonb_build_array(true, 'false', false, false, false, false, false),
        'sta', jsonb_build_object('bad', true),
        'arrFlight', jsonb_build_array('VN332'),
        'arrFlightType', 1,
        'arrRoute', true,
        'arrFlightCategory', jsonb_build_object('bad', true),
        'arrCodeShares', jsonb_build_array('VN999'),
        'arrIntDomInd', 0,
        'std', jsonb_build_array('08:05'),
        'depFlight', jsonb_build_object('bad', true),
        'depFlightType', false,
        'depRoute', 12,
        'depFlightCategory', jsonb_build_array('J'),
        'depCodeShares', jsonb_build_object('bad', true),
        'depIntDomInd', true,
        'overnightLinkRowIndex', '30',
        'linkType', jsonb_build_object('bad', true)
      )
    )
  ));

  if v_result->>'status' <> 'failed' or (v_result->>'valid')::boolean then
    raise exception 'wrong canonical JSON types must fail staging: %', v_result;
  end if;

  if (
    select count(*)
    from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'code' = 'invalid-row-index'
  ) <> 2 then
    raise exception 'string and fractional rowIndex values were not both rejected: %', v_result;
  end if;

  foreach v_column in array array[
    'Airline',
    'Aircraft',
    'STA',
    'ARRFlight',
    'ARRFlightType',
    'ARRRoute',
    'ARRFlightCategory',
    'ARRCodeShares',
    'ARRIntDomInd',
    'STD',
    'DEPFlight',
    'DEPFlightType',
    'DEPRoute',
    'DEPFlightCategory',
    'DEPCodeShares',
    'DEPIntDomInd',
    'overnightLinkRowIndex',
    'linkType'
  ]
  loop
    if not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'rowIndex' = '32'
        and diagnostic->>'code' = 'invalid-field-type'
        and diagnostic->>'column' = v_column
    ) then
      raise exception 'missing invalid-field-type diagnostic for %: %', v_column, v_result;
    end if;
  end loop;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '32'
      and diagnostic->>'code' = 'invalid-day-value'
  ) then
    raise exception 'non-boolean DOW value was not rejected: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;
  select rows.row_data
  into v_bad_row
  from public.season_import_batch_rows rows
  where rows.batch_id = v_batch_id
    and rows.row_index = 2;

  if jsonb_typeof(v_bad_row->'rowIndex') <> 'number'
    or (v_bad_row->>'rowIndex')::integer <> 32
    or v_bad_row->'airline' <> 'null'::jsonb
    or v_bad_row->'aircraft' <> 'null'::jsonb
    or v_bad_row->'arrRoute' <> 'null'::jsonb
    or v_bad_row->'depRoute' <> 'null'::jsonb
    or v_bad_row->'daysOfWeek' <> '[]'::jsonb
    or v_bad_row->'overnightLinkRowIndex' <> 'null'::jsonb
    or v_bad_row->'linkType' <> 'null'::jsonb
  then
    raise exception 'invalid raw JSON values were persisted instead of canonical row_data: %', v_bad_row;
  end if;
end
$$;

do $$
declare
  v_result jsonb;
  v_batch_id uuid;
  v_staging_indexes integer[];
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '471b2fc4-01de-4ab8-80dc-1307a366bf06',
    'checksum', 'duplicate-logical-row-index',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 40,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '07:05',
        'arrFlight', 'VN340',
        'arrRoute', 'KIX'
      ),
      jsonb_build_object(
        'rowIndex', 40,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '08:05',
        'depFlight', 'VN341',
        'depRoute', 'KIX'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'valid')::boolean
    or (
      select count(*)
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'rowIndex' = '40'
        and diagnostic->>'code' = 'duplicate-row-index'
    ) <> 2
  then
    raise exception 'duplicate logical rowIndex must diagnose every duplicate row: %', v_result;
  end if;

  if (
    select array_agg((diagnostic->>'stagingRowIndex')::integer order by diagnostic->>'stagingRowIndex')
    from jsonb_array_elements(v_result->'diagnostics') diagnostic
    where diagnostic->>'rowIndex' = '40'
      and diagnostic->>'code' = 'duplicate-row-index'
  ) <> array[0, 1] then
    raise exception 'duplicate diagnostics must identify both staging ordinals: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;
  select array_agg(rows.row_index order by rows.row_index)
  into v_staging_indexes
  from public.season_import_batch_rows rows
  where rows.batch_id = v_batch_id;

  if v_staging_indexes <> array[0, 1] then
    raise exception 'staging row_index must remain the source ordinal: %', v_staging_indexes;
  end if;
end
$$;

do $$
declare
  v_large_rows jsonb;
  v_result jsonb;
  v_batch_count integer;
  v_row_count integer;
begin
  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '69cc5b3b-c24c-4147-8221-4b25c7152c69',
      'checksum', repeat('x', 257),
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object('rowIndex', 1))
    ));
    raise exception 'oversized checksum was not rejected';
  exception
    when sqlstate '22023' then
      if position('checksum exceeds maximum length of 256' in sqlerrm) = 0 then
        raise;
    end if;
  end;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '0d17e04a-b56f-47d6-984d-35ab337c86cd',
      'checksum', 'oversized-season-code',
      'seasonCode', repeat('S', 33),
      'sourceRows', jsonb_build_array(jsonb_build_object('rowIndex', 1))
    ));
    raise exception 'oversized seasonCode was not rejected';
  exception
    when sqlstate '22023' then
      if position('seasonCode exceeds maximum length of 32' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '7a259d52-6988-47d8-9f8d-e01d58d060c1',
      'checksum', 'oversized-season-id',
      'seasonId', repeat('s', 257),
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object('rowIndex', 1))
    ));
    raise exception 'oversized seasonId was not rejected';
  exception
    when sqlstate '22023' then
      if position('seasonId exceeds maximum length of 256' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', 'f496331f-0a8c-4f6c-b0d0-18fd5be5cbdf',
      'checksum', 'oversized-airline-probe',
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object(
        'rowIndex', 60,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', repeat('V', 2097152),
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
        'sta', '07:05',
        'arrFlight', 'VN360',
        'arrRoute', 'KIX'
      ))
    ));
    raise exception 'oversized Airline probe was not rejected';
  exception
    when sqlstate '22023' then
      if position('canonical source field Airline exceeds maximum length of 16' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  select count(*)::integer
  into v_batch_count
  from public.season_import_batches batches
  where batches.request_id = 'f496331f-0a8c-4f6c-b0d0-18fd5be5cbdf';

  select count(*)::integer
  into v_row_count
  from public.season_import_batch_rows rows
  join public.season_import_batches batches on batches.batch_id = rows.batch_id
  where batches.request_id = 'f496331f-0a8c-4f6c-b0d0-18fd5be5cbdf';

  if v_batch_count <> 0 or v_row_count <> 0 then
    raise exception 'oversized Airline probe persisted a batch or row';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '6bd45db7-47b4-4293-812b-2794f25e91c2',
    'checksum', 'near-limit-canonical-fields',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 62,
      'effective', '2026-10-25',
      'discontinue', '2026-10-25',
      'airline', repeat('V', 16),
      'aircraft', repeat('A', 64),
      'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
      'sta', '07:05',
      'arrFlight', repeat('F', 64),
      'arrRoute', repeat('R', 512),
      'arrCodeShares', repeat('C', 4096)
    ))
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 1
    or not (v_result->>'valid')::boolean
  then
    raise exception 'near-limit canonical fields were rejected: %', v_result;
  end if;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '685cafb3-6a9a-4588-92ed-70ffcf36fa02',
      'checksum', 'oversized-file-name',
      'seasonCode', 'TV2',
      'fileName', repeat('x', 1025),
      'sourceRows', jsonb_build_array(jsonb_build_object('rowIndex', 1))
    ));
    raise exception 'oversized fileName was not rejected';
  exception
    when sqlstate '22023' then
      if position('fileName exceeds maximum length of 1024' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  select jsonb_agg(jsonb_build_object('rowIndex', source_index))
  into v_large_rows
  from generate_series(1, 20001) source_index;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '311da643-715f-4cde-b9f9-dc46b1750832',
      'checksum', 'oversized-source-rows',
      'seasonCode', 'TV2',
      'sourceRows', v_large_rows
    ));
    raise exception 'oversized sourceRows was not rejected';
  exception
    when sqlstate '22023' then
      if position('sourceRows exceeds maximum of 20000 rows' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  select count(*)::integer
  into v_batch_count
  from public.season_import_batches batches
  where batches.request_id = '311da643-715f-4cde-b9f9-dc46b1750832';

  select count(*)::integer
  into v_row_count
  from public.season_import_batch_rows rows
  join public.season_import_batches batches on batches.batch_id = rows.batch_id
  where batches.request_id = '311da643-715f-4cde-b9f9-dc46b1750832';

  if v_batch_count <> 0 or v_row_count <> 0 then
    raise exception 'max+1 sourceRows persisted a batch or row';
  end if;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '553123fd-dda8-4ede-a85c-b69e4f9b0270',
      'checksum', 'oversized-total-request',
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object(
        'rowIndex', 61,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
        'sta', '07:05',
        'arrFlight', 'VN361',
        'arrRoute', 'KIX'
      )),
      'padding', repeat('x', 67108864)
    ));
    raise exception 'oversized total request was not rejected';
  exception
    when sqlstate '22023' then
      if position('p_import exceeds maximum size of 67108864 bytes' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_rows jsonb;
  v_result jsonb;
  v_summary jsonb;
begin
  select jsonb_agg(jsonb_build_object('rowIndex', source_index))
  into v_rows
  from generate_series(1, 2000) source_index;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'd65399b0-8365-42d0-9308-777a56cdfef4',
    'checksum', 'bounded-diagnostics',
    'seasonCode', 'TV2',
    'sourceRows', v_rows
  ));

  select diagnostic
  into v_summary
  from jsonb_array_elements(v_result->'diagnostics') diagnostic
  where diagnostic->>'code' = 'diagnostics-truncated';

  if v_result->>'status' <> 'failed'
    or jsonb_array_length(v_result->'diagnostics') <> 2000
    or v_summary is null
    or (v_summary->>'shownDiagnostics')::integer <> 1999
    or (v_summary->>'totalDiagnostics')::integer <= 1999
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'rowIndex' = '1'
        and diagnostic->>'code' <> 'diagnostics-truncated'
    )
  then
    raise exception 'diagnostics output was not capped with actionable rows and summary: %', v_result;
  end if;
end
$$;

do $$
declare
  v_result jsonb;
  v_batch_id uuid;
  v_record_count integer;
  v_distinct_occurrence_count integer;
  v_distinct_turnaround_count integer;
  v_linked_record_count integer;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '2bb2a7ec-e8a6-49d5-a30e-4c48dc0cb084',
    'checksum', 'departure-only-two-mondays',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 100,
      'effective', '2026-07-06',
      'discontinue', '2026-07-13',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'std', '06:00',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
    or not (v_result->>'valid')::boolean
  then
    raise exception 'departure-only Monday fixture did not validate: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer
  into v_record_count, v_distinct_occurrence_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated;

  if v_record_count <> 2
    or v_distinct_occurrence_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.type <> 'D'
        or generated.flight_number <> 'LJ081'
        or generated.raw_flight_number <> '081'
        or generated.scheduled_date not in ('2026-07-06', '2026-07-13')
        or generated.operational_date <> generated.scheduled_date
        or generated.day_of_week <> 1
        or generated.source_row_index <> 100
        or generated.linked_record_id is not null
        or generated.turnaround_id is not null
    )
  then
    raise exception 'departure-only Monday generator parity failed';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '16d8e786-7cb6-48f3-b7f0-2ac0f0fda02b',
    'checksum', 'same-row-sameday-pair',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 110,
      'effective', '2026-07-06',
      'discontinue', '2026-07-06',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'sta', '08:00',
      'arrFlight', '80',
      'arrRoute', 'ICN',
      'std', '09:00',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
  then
    raise exception 'same-row same-day fixture did not validate: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into
    v_record_count,
    v_distinct_occurrence_count,
    v_distinct_turnaround_count,
    v_linked_record_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_record_count <> 2
    or v_distinct_occurrence_count <> 2
    or v_distinct_turnaround_count <> 1
    or v_linked_record_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.scheduled_date <> '2026-07-06'
        or generated.operational_date <> '2026-07-06'
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.link_type <> 'sameday'
        or generated.source_row_index <> 110
        or generated.linked_source_row_index <> 110
    )
  then
    raise exception 'same-row same-day generator parity failed';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'aa074eed-5c38-4514-b96f-176db2516881',
    'checksum', 'same-row-overnight-pair',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 120,
      'effective', '2026-07-06',
      'discontinue', '2026-07-06',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'sta', '23:00',
      'arrFlight', '80',
      'arrRoute', 'ICN',
      'std', '01:30',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
  then
    raise exception 'same-row overnight fixture did not validate: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into
    v_record_count,
    v_distinct_occurrence_count,
    v_distinct_turnaround_count,
    v_linked_record_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_record_count <> 2
    or v_distinct_occurrence_count <> 2
    or v_distinct_turnaround_count <> 1
    or v_linked_record_count <> 2
    or not exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.type = 'A'
        and generated.scheduled_date = '2026-07-06'
        and generated.operational_date = '2026-07-06'
        and generated.day_of_week = 1
    )
    or not exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.type = 'D'
        and generated.scheduled_date = '2026-07-07'
        and generated.operational_date = '2026-07-06'
        and generated.day_of_week = 2
    )
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.link_type <> 'overnight'
    )
  then
    raise exception 'same-row overnight generator parity failed';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '70e15cc0-53f6-4d1a-a45e-b111a3903e1c',
    'checksum', 'explicit-linked-source-rows',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 130,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '10:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 131,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 131,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '11:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 130,
        'linkType', 'sameday'
      )
    )
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
  then
    raise exception 'explicit linked-row fixture did not validate: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into
    v_record_count,
    v_distinct_occurrence_count,
    v_distinct_turnaround_count,
    v_linked_record_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_record_count <> 2
    or v_distinct_occurrence_count <> 2
    or v_distinct_turnaround_count <> 1
    or v_linked_record_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.scheduled_date <> '2026-07-06'
        or generated.operational_date <> '2026-07-06'
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.link_type <> 'sameday'
        or generated.linked_source_row_index not in (130, 131)
        or generated.linked_source_row_index = generated.source_row_index
    )
  then
    raise exception 'explicit linked-row generator parity failed';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '3e7849d3-9f85-494c-9bd8-07ef10705cbf',
    'checksum', 'flight-number-normalization',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 140,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '06:00',
        'depFlight', '81',
        'depRoute', 'ICN'
      ),
      jsonb_build_object(
        'rowIndex', 141,
        'effective', '2026-07-07',
        'discontinue', '2026-07-07',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
        'std', '06:00',
        'depFlight', 'LJ81',
        'depRoute', 'ICN'
      ),
      jsonb_build_object(
        'rowIndex', 142,
        'effective', '2026-07-08',
        'discontinue', '2026-07-08',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, false, true, false, false, false, false),
        'std', '06:00',
        'depFlight', 'LJ081',
        'depRoute', 'ICN'
      )
    )
  ));

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 3
  then
    raise exception 'flight-number normalization fixture did not validate: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer
  into v_record_count, v_distinct_occurrence_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  where generated.flight_number = 'LJ081'
    and generated.raw_flight_number = '081';

  if v_record_count <> 3 or v_distinct_occurrence_count <> 3 then
    raise exception '81, LJ81, and LJ081 did not normalize to LJ081';
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '80c64f57-c42f-4f13-990e-989a05ba8e26',
    'checksum', 'duplicate-occurrence-overlap',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 150,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '06:00',
        'depFlight', '81',
        'depRoute', 'ICN'
      ),
      jsonb_build_object(
        'rowIndex', 151,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '07:00',
        'depFlight', 'LJ081',
        'depRoute', 'PUS'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'generatedRecordCount')::integer <> 0
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'duplicate-occurrence-key'
        and diagnostic->>'occurrenceKey' =
          'seasonal-import-v2-test-season|2026-07-06|LJ|LJ081'
    )
  then
    raise exception 'duplicate occurrence was not blocked with a diagnostic: %', v_result;
  end if;

  v_batch_id := (v_result->>'batchId')::uuid;
  if exists (
    select generated.occurrence_key
    from public.generate_seasonal_import_records_v2(v_batch_id) generated
    group by generated.occurrence_key
    having count(*) > 1
  ) then
    raise exception 'generator exposed duplicate occurrence keys for a failed batch';
  end if;
end
$$;

do $$
declare
  v_normalized_count integer;
  v_first_id text;
  v_second_id text;
begin
  select pg_catalog.count(*)::integer
  into v_normalized_count
  from (
    values ('81'::text), ('LJ81'::text), ('LJ081'::text)
  ) raw_values(raw_value)
  cross join lateral public.normalize_seasonal_flight_number_v2(' lj ', raw_values.raw_value) normalized
  where normalized.flight_number = 'LJ081'
    and normalized.raw_flight_number = '081';

  if v_normalized_count <> 3 then
    raise exception 'flight-number helper diverged from cleanFlightNumber parity';
  end if;

  if public.seasonal_operational_date_v2('2026-07-07', '04:59') <> '2026-07-06'
    or public.seasonal_operational_date_v2('2026-07-07', '05:00') <> '2026-07-07'
  then
    raise exception 'operational-day threshold must remain exactly 05:00';
  end if;

  v_first_id := public.seasonal_record_id_v2(
    'seasonal-import-v2-test-season',
    'D',
    '2026-07-06',
    'LJ',
    'LJ081'
  );
  v_second_id := public.seasonal_record_id_v2(
    'seasonal-import-v2-test-season',
    'D',
    '2026-07-06',
    'LJ',
    'LJ081'
  );

  if v_first_id is distinct from v_second_id
    or v_first_id !~ '^LEG_D_2026-07-06_[0-9a-f]{32}$'
    or v_first_id = public.seasonal_record_id_v2(
      'different-season',
      'D',
      '2026-07-06',
      'LJ',
      'LJ081'
    )
  then
    raise exception 'seasonal record IDs are not deterministic and season-scoped';
  end if;
end
$$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '1ee64a50-132c-4574-8c92-5d195dc72f76',
    'checksum', 'missing-linked-row',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 160,
      'effective', '2026-07-06',
      'discontinue', '2026-07-06',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'sta', '08:00',
      'arrFlight', '80',
      'arrRoute', 'ICN',
      'overnightLinkRowIndex', 999,
      'linkType', 'sameday'
    ))
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'generatedRecordCount')::integer <> 0
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'missing-linked-row'
        and diagnostic->>'rowIndex' = '160'
    )
  then
    raise exception 'missing linked source row was not blocked: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'c3abf3fb-6a48-4e50-bbba-e45faef27804',
    'checksum', 'ambiguous-linked-target',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 170,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 172,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 171,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '09:00',
        'arrFlight', '82',
        'arrRoute', 'PUS',
        'overnightLinkRowIndex', 172,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 172,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '10:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 170,
        'linkType', 'sameday'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'ambiguous-pair'
    )
  then
    raise exception 'ambiguous linked target was not blocked: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'cb141584-8dbd-4745-8495-e591d4a3c57d',
    'checksum', 'incompatible-pair-type',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 180,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 181,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 181,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '09:00',
        'arrFlight', '82',
        'arrRoute', 'PUS',
        'overnightLinkRowIndex', 180,
        'linkType', 'sameday'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'incompatible-pair-type'
    )
  then
    raise exception 'same-side linked rows were not blocked: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '93489717-9362-4fe3-a2b3-7ee3e7039541',
    'checksum', 'incompatible-link-type',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 190,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 191,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 191,
        'effective', '2026-07-07',
        'discontinue', '2026-07-07',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
        'std', '01:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 190,
        'linkType', 'overnight'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'incompatible-link-type'
    )
  then
    raise exception 'conflicting linked-row linkType was not blocked: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '7d27de2f-8bb4-4995-a1cb-43e33ba5b539',
    'checksum', 'incompatible-pair-date',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 200,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 201,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 201,
        'effective', '2026-07-07',
        'discontinue', '2026-07-07',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
        'std', '09:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 200,
        'linkType', 'sameday'
      )
    )
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'generatedRecordCount')::integer <> 0
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'incompatible-pair-date'
    )
  then
    raise exception 'incompatible linked-row dates were not blocked: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '7a614d1c-8c9f-4497-886f-80ac3f9fffb3',
    'checksum', 'zero-generated-records',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 210,
      'effective', '2026-07-06',
      'discontinue', '2026-07-06',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
      'std', '06:00',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  ));

  if v_result->>'status' <> 'failed'
    or (v_result->>'generatedRecordCount')::integer <> 0
    or not exists (
      select 1
      from jsonb_array_elements(v_result->'diagnostics') diagnostic
      where diagnostic->>'code' = 'zero-generated-records'
    )
  then
    raise exception 'zero-generation batch was not blocked: %', v_result;
  end if;
end
$$;

do $$
declare
  v_payload jsonb;
  v_first jsonb;
  v_retry jsonb;
  v_batch_id uuid;
  v_target_season_id text;
  v_target_season_id_after text;
  v_fingerprint text;
  v_record_ids_before text[];
  v_record_ids_after text[];
  v_expected_record_id text;
  v_occurrence_key text;
begin
  v_payload := jsonb_build_object(
    'requestId', '7d11ad76-f172-4eca-9997-1d1689c08031',
    'checksum', 'stable-new-season-target',
    'seasonCode', 'NVI',
    'fileName', 'new-season.csv',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 300,
      'effective', '2026-10-26',
      'discontinue', '2026-10-26',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'std', '06:00',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  );

  v_first := public.stage_seasonal_import_v2(v_payload);
  v_batch_id := (v_first->>'batchId')::uuid;

  select
    batches.result #>> '{_staging,targetSeasonId}',
    batches.result #>> '{_staging,requestFingerprint}'
  into v_target_season_id, v_fingerprint
  from public.season_import_batches batches
  where batches.batch_id = v_batch_id;

  select
    array_agg(generated.record_id order by generated.record_id),
    min(generated.occurrence_key)
  into v_record_ids_before, v_occurrence_key
  from public.generate_seasonal_import_records_v2(v_batch_id) generated;

  v_expected_record_id := public.seasonal_record_id_v2(
    v_target_season_id,
    'D',
    '2026-10-26'::date,
    'LJ',
    'LJ081'
  );

  if v_first->>'status' <> 'validated'
    or (v_first->>'generatedRecordCount')::integer <> 1
    or nullif(v_target_season_id, '') is null
    or char_length(coalesce(v_fingerprint, '')) <> 64
    or cardinality(v_record_ids_before) <> 1
    or v_record_ids_before[1] is distinct from v_expected_record_id
    or v_occurrence_key is distinct from
      v_target_season_id || '|2026-10-26|LJ|LJ081'
  then
    raise exception 'new-season target identity was not persisted before generation: %, %, %',
      v_first,
      v_target_season_id,
      v_record_ids_before;
  end if;

  insert into public.seasons (
    id,
    season_code,
    name,
    file_name,
    uploaded_at,
    effective_start,
    effective_end,
    total_legs,
    total_source_rows,
    data_version
  )
  values (
    v_target_season_id,
    'NVI',
    'Stable New Season Identity',
    '',
    0,
    '',
    '',
    0,
    0,
    0
  );

  v_retry := public.stage_seasonal_import_v2(v_payload);

  select
    batches.result #>> '{_staging,targetSeasonId}',
    array_agg(generated.record_id order by generated.record_id)
  into v_target_season_id_after, v_record_ids_after
  from public.season_import_batches batches
  join lateral public.generate_seasonal_import_records_v2(batches.batch_id) generated on true
  where batches.batch_id = v_batch_id
  group by batches.result;

  if v_retry->>'batchId' is distinct from v_first->>'batchId'
    or v_retry->>'status' is distinct from v_first->>'status'
    or v_retry->>'generatedRecordCount' is distinct from v_first->>'generatedRecordCount'
    or v_target_season_id_after is distinct from v_target_season_id
    or v_record_ids_after is distinct from v_record_ids_before
  then
    raise exception 'new-season retry drifted after Task5-style season creation: %, %, %, %',
      v_first,
      v_retry,
      v_record_ids_before,
      v_record_ids_after;
  end if;
end
$$;

do $$
declare
  v_payload jsonb;
  v_first jsonb;
  v_batch_id uuid;
  v_target_season_id text;
  v_record_ids_before text[];
  v_record_ids_after text[];
begin
  v_payload := jsonb_build_object(
    'requestId', 'f41edb3f-c4a8-4ab4-86f2-0a52ed71f406',
    'checksum', 'new-season-conflicting-target',
    'seasonCode', 'NVC',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 310,
      'effective', '2026-10-26',
      'discontinue', '2026-10-26',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'std', '06:00',
      'depFlight', '82',
      'depRoute', 'ICN'
    ))
  );

  v_first := public.stage_seasonal_import_v2(v_payload);
  v_batch_id := (v_first->>'batchId')::uuid;

  select batches.result #>> '{_staging,targetSeasonId}'
  into v_target_season_id
  from public.season_import_batches batches
  where batches.batch_id = v_batch_id;

  select array_agg(generated.record_id order by generated.record_id)
  into v_record_ids_before
  from public.generate_seasonal_import_records_v2(v_batch_id) generated;

  insert into public.seasons (
    id,
    season_code,
    name,
    file_name,
    uploaded_at,
    effective_start,
    effective_end,
    total_legs,
    total_source_rows,
    data_version
  )
  values (
    'independently-created-nvc-season',
    'NVC',
    'Conflicting New Season Identity',
    '',
    0,
    '',
    '',
    0,
    0,
    0
  );

  begin
    perform public.stage_seasonal_import_v2(v_payload);
    raise exception 'independent same-code season did not conflict with persisted target identity';
  exception
    when unique_violation then
      if position('target season identity conflict' in lower(sqlerrm)) = 0 then
        raise;
      end if;
  end;

  select array_agg(generated.record_id order by generated.record_id)
  into v_record_ids_after
  from public.generate_seasonal_import_records_v2(v_batch_id) generated;

  if nullif(v_target_season_id, '') is null
    or v_target_season_id = 'independently-created-nvc-season'
    or v_record_ids_after is distinct from v_record_ids_before
  then
    raise exception 'conflicting season changed persisted target identity or generated IDs';
  end if;
end
$$;

do $$
declare
  v_rows jsonb;
  v_result jsonb;
  v_max_date_span integer;
  v_atomic_side_count bigint;
begin
  select jsonb_agg(
    jsonb_build_object(
      'rowIndex', source_index,
      'effective', '2026-01-01',
      'discontinue', ('2026-01-01'::date + 499)::text,
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
      'std', '06:00',
      'depFlight', source_index::text,
      'depRoute', 'ICN'
    )
    order by source_index
  )
  into v_rows
  from generate_series(1, 200) source_index;

  select preflight.max_date_span, preflight.atomic_side_count
  into v_max_date_span, v_atomic_side_count
  from public.seasonal_import_expansion_preflight_v2(v_rows) preflight;

  if v_max_date_span <> 500 or v_atomic_side_count <> 100000 then
    raise exception '100000-side preflight boundary was not exact: %, %',
      v_max_date_span,
      v_atomic_side_count;
  end if;

  select jsonb_agg(row_data order by row_index)
  into v_rows
  from (
    select
      source_index as row_index,
      jsonb_build_object(
        'rowIndex', source_index,
        'effective', '2026-01-01',
        'discontinue', case
          when source_index <= 103 then ('2026-01-01'::date + 549)::text
          else ('2026-01-01'::date + 363)::text
        end,
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
        'std', '06:00',
        'depFlight', source_index::text,
        'depRoute', 'ICN'
      ) as row_data
    from generate_series(1, 104) source_index
  ) synthetic_w26;

  select preflight.max_date_span, preflight.atomic_side_count
  into v_max_date_span, v_atomic_side_count
  from public.seasonal_import_expansion_preflight_v2(v_rows) preflight;

  if v_max_date_span <> 550 or v_atomic_side_count <> 57014 then
    raise exception 'W26-scale synthetic preflight was not allowed exactly: %, %',
      v_max_date_span,
      v_atomic_side_count;
  end if;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '844c563c-7704-46ca-ae81-c4a2f36021d9',
      'checksum', 'date-span-over-limit',
      'seasonCode', 'RSC',
      'sourceRows', jsonb_build_array(jsonb_build_object(
        'rowIndex', 320,
        'effective', '2026-01-01',
        'discontinue', ('2026-01-01'::date + 550)::text,
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
        'std', '06:00',
        'depFlight', '81',
        'depRoute', 'ICN'
      ))
    ));
    raise exception '551-day source span was not rejected';
  exception
    when invalid_parameter_value then
      if position('date span' in lower(sqlerrm)) = 0
        or position('550' in sqlerrm) = 0
      then
        raise;
      end if;
  end;

  if exists (
    select 1
    from public.season_import_batches batches
    where batches.request_id = '844c563c-7704-46ca-ae81-c4a2f36021d9'
  ) then
    raise exception 'date-span resource violation persisted a staging batch';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'rowIndex', source_index,
      'effective', '2026-01-01',
      'discontinue', ('2026-01-01'::date + 499)::text,
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
      'std', '06:00',
      'depFlight', source_index::text,
      'depRoute', 'ICN'
    )
    order by source_index
  )
  into v_rows
  from generate_series(1, 201) source_index;

  perform set_config('statement_timeout', '3000', true);
  begin
    v_result := public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '902c91a3-cee5-4f11-bc4a-f35a672ea1f2',
      'checksum', 'atomic-side-count-over-limit',
      'seasonCode', 'RSC',
      'sourceRows', v_rows
    ));
    raise exception '100500 atomic sides were not rejected: %', v_result;
  exception
    when invalid_parameter_value then
      if position('atomic record count' in lower(sqlerrm)) = 0
        or position('100000' in sqlerrm) = 0
      then
        raise;
      end if;
  end;
  perform set_config('statement_timeout', '0', true);

  if exists (
    select 1
    from public.season_import_batches batches
    where batches.request_id = '902c91a3-cee5-4f11-bc4a-f35a672ea1f2'
  ) then
    raise exception 'atomic-count resource violation persisted a staging batch';
  end if;
end
$$;

do $$
declare
  v_result jsonb;
  v_batch_id uuid;
  v_record_count integer;
  v_occurrence_count integer;
  v_turnaround_count integer;
  v_reciprocal_count integer;
begin
  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', 'a4661c07-e25b-413d-887d-d718555de258',
    'checksum', 'inferred-cross-row-sameday',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 330,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 331
      ),
      jsonb_build_object(
        'rowIndex', 331,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '09:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 330
      )
    )
  ));
  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into v_record_count, v_occurrence_count, v_turnaround_count, v_reciprocal_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
    or v_record_count <> 2
    or v_occurrence_count <> 2
    or v_turnaround_count <> 1
    or v_reciprocal_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.link_type <> 'sameday'
        or generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.scheduled_date <> '2026-07-06'
        or generated.operational_date <> '2026-07-06'
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.linked_source_row_index = generated.source_row_index
    )
  then
    raise exception 'missing-linkType same-day cross-row inference failed: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '01d57d2f-3c4e-4994-aadb-0a8d06ee6cb0',
    'checksum', 'inferred-cross-row-overnight',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 340,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '23:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 341
      ),
      jsonb_build_object(
        'rowIndex', 341,
        'effective', '2026-07-07',
        'discontinue', '2026-07-07',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
        'std', '01:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 340
      )
    )
  ));
  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into v_record_count, v_occurrence_count, v_turnaround_count, v_reciprocal_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
    or v_record_count <> 2
    or v_occurrence_count <> 2
    or v_turnaround_count <> 1
    or v_reciprocal_count <> 2
    or not exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.type = 'A'
        and generated.flight_number = 'LJ080'
        and generated.raw_flight_number = '080'
        and generated.scheduled_date = '2026-07-06'
        and generated.operational_date = '2026-07-06'
        and generated.link_type = 'overnight'
        and generated.pair_anchor_date = '2026-07-06'
    )
    or not exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.type = 'D'
        and generated.flight_number = 'LJ081'
        and generated.raw_flight_number = '081'
        and generated.scheduled_date = '2026-07-07'
        and generated.operational_date = '2026-07-06'
        and generated.link_type = 'overnight'
        and generated.pair_anchor_date = '2026-07-06'
    )
  then
    raise exception 'missing-linkType overnight cross-row inference failed: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '2ce249ed-7eb5-44fd-a655-cb0e73bd1e23',
    'checksum', 'explicit-sameday-overrides-inference',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 350,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '23:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 351,
        'linkType', 'sameday'
      ),
      jsonb_build_object(
        'rowIndex', 351,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'std', '01:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 350
      )
    )
  ));
  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into v_record_count, v_occurrence_count, v_turnaround_count, v_reciprocal_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
    or v_record_count <> 2
    or v_occurrence_count <> 2
    or v_turnaround_count <> 1
    or v_reciprocal_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.link_type <> 'sameday'
        or generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.scheduled_date <> '2026-07-06'
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.linked_source_row_index = generated.source_row_index
        or (
          generated.type = 'A'
          and generated.operational_date <> '2026-07-06'
        )
        or (
          generated.type = 'D'
          and generated.operational_date <> '2026-07-05'
        )
    )
  then
    raise exception 'explicit same-day linkType did not override inferred overnight: %', v_result;
  end if;

  v_result := public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', '2c949159-3bef-4cd4-8a90-12649398817f',
    'checksum', 'explicit-overnight-overrides-inference',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(
      jsonb_build_object(
        'rowIndex', 360,
        'effective', '2026-07-06',
        'discontinue', '2026-07-06',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '08:00',
        'arrFlight', '80',
        'arrRoute', 'ICN',
        'overnightLinkRowIndex', 361,
        'linkType', 'overnight'
      ),
      jsonb_build_object(
        'rowIndex', 361,
        'effective', '2026-07-07',
        'discontinue', '2026-07-07',
        'airline', 'LJ',
        'aircraft', '738',
        'daysOfWeek', jsonb_build_array(false, true, false, false, false, false, false),
        'std', '09:00',
        'depFlight', '81',
        'depRoute', 'ICN',
        'overnightLinkRowIndex', 360
      )
    )
  ));
  v_batch_id := (v_result->>'batchId')::uuid;

  select
    count(*)::integer,
    count(distinct generated.occurrence_key)::integer,
    count(distinct generated.turnaround_id)::integer,
    count(*) filter (
      where counterpart.record_id = generated.linked_record_id
        and counterpart.linked_record_id = generated.record_id
        and counterpart.turnaround_id = generated.turnaround_id
    )::integer
  into v_record_count, v_occurrence_count, v_turnaround_count, v_reciprocal_count
  from public.generate_seasonal_import_records_v2(v_batch_id) generated
  left join public.generate_seasonal_import_records_v2(v_batch_id) counterpart
    on counterpart.record_id = generated.linked_record_id;

  if v_result->>'status' <> 'validated'
    or (v_result->>'generatedRecordCount')::integer <> 2
    or v_record_count <> 2
    or v_occurrence_count <> 2
    or v_turnaround_count <> 1
    or v_reciprocal_count <> 2
    or exists (
      select 1
      from public.generate_seasonal_import_records_v2(v_batch_id) generated
      where generated.link_type <> 'overnight'
        or generated.flight_number not in ('LJ080', 'LJ081')
        or generated.raw_flight_number not in ('080', '081')
        or generated.pair_anchor_date <> '2026-07-06'
        or generated.linked_source_row_index = generated.source_row_index
        or (
          generated.type = 'A'
          and (
            generated.scheduled_date <> '2026-07-06'
            or generated.operational_date <> '2026-07-06'
          )
        )
        or (
          generated.type = 'D'
          and (
            generated.scheduled_date <> '2026-07-07'
            or generated.operational_date <> '2026-07-07'
          )
        )
    )
  then
    raise exception 'explicit overnight linkType did not override inferred same-day: %', v_result;
  end if;
end
$$;

do $$
declare
  v_payload jsonb;
  v_utc_result jsonb;
  v_apia_result jsonb;
  v_utc_dates text[];
  v_apia_dates text[];
begin
  perform set_config('statement_timeout', '5000', true);
  perform set_config('TimeZone', 'UTC', true);

  v_payload := jsonb_build_object(
    'checksum', 'timezone-date-series',
    'seasonCode', 'TV2',
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 370,
      'effective', '2011-12-29',
      'discontinue', '2011-12-31',
      'airline', 'LJ',
      'aircraft', '738',
      'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
      'std', '06:00',
      'depFlight', '81',
      'depRoute', 'ICN'
    ))
  );

  v_utc_result := public.stage_seasonal_import_v2(
    v_payload || jsonb_build_object('requestId', 'a96d4566-a175-4510-a55a-f630ff8fe8ba')
  );

  select array_agg(generated.scheduled_date order by generated.scheduled_date)
  into v_utc_dates
  from public.generate_seasonal_import_records_v2((v_utc_result->>'batchId')::uuid) generated;

  perform set_config('TimeZone', 'Pacific/Apia', true);
  v_apia_result := public.stage_seasonal_import_v2(
    v_payload || jsonb_build_object('requestId', '19d82d62-5d35-43a9-8e8d-e36cbe9aceff')
  );

  select array_agg(generated.scheduled_date order by generated.scheduled_date)
  into v_apia_dates
  from public.generate_seasonal_import_records_v2((v_apia_result->>'batchId')::uuid) generated;

  perform set_config('TimeZone', 'UTC', true);
  perform set_config('statement_timeout', '0', true);

  if v_utc_result->>'status' <> 'validated'
    or v_apia_result->>'status' <> 'validated'
    or v_utc_result->>'generatedRecordCount' <> '3'
    or v_apia_result->>'generatedRecordCount' <> '3'
    or v_utc_dates is distinct from array['2011-12-29', '2011-12-30', '2011-12-31']::text[]
    or v_apia_dates is distinct from v_utc_dates
  then
    raise exception 'date expansion changed across UTC/Pacific-Apia: %, %, %, %',
      v_utc_result,
      v_apia_result,
      v_utc_dates,
      v_apia_dates;
  end if;
end
$$;

do $$
declare
  v_stage_definition text;
  v_core_definition text;
  v_generator_definition text;
  v_diagnostics_definition text;
  v_preflight_definition text;
  v_core_language text;
  v_core_volatility "char";
  v_generator_language text;
  v_generator_volatility "char";
  v_core_call text := 'public.seasonal_import_atomic_preview_v2(';
begin
  select pg_get_functiondef('public.stage_seasonal_import_v2(jsonb)'::regprocedure)
  into v_stage_definition;

  select
    pg_get_functiondef(procedures.oid),
    languages.lanname,
    procedures.provolatile
  into v_generator_definition, v_generator_language, v_generator_volatility
  from pg_proc procedures
  join pg_language languages on languages.oid = procedures.prolang
  where procedures.oid = 'public.generate_seasonal_import_records_v2(uuid)'::regprocedure;

  select
    pg_get_functiondef(procedures.oid),
    languages.lanname,
    procedures.provolatile
  into v_core_definition, v_core_language, v_core_volatility
  from pg_proc procedures
  join pg_language languages on languages.oid = procedures.prolang
  where procedures.oid =
    'public.seasonal_import_atomic_preview_v2(uuid)'::regprocedure;

  select pg_get_functiondef(
    'public.seasonal_import_generation_diagnostics_v2(uuid)'::regprocedure
  )
  into v_diagnostics_definition;

  select pg_get_functiondef(
    'public.seasonal_import_expansion_preflight_v2(jsonb)'::regprocedure
  )
  into v_preflight_definition;

  if position('atomic_preview as materialized' in lower(v_stage_definition)) = 0
    or (
      length(lower(v_stage_definition))
      - length(replace(lower(v_stage_definition), v_core_call, ''))
    ) / length(v_core_call) <> 1
    or position('public.generate_seasonal_import_records_v2(' in lower(v_stage_definition)) <> 0
    or position('public.seasonal_import_generation_diagnostics_v2(' in lower(v_stage_definition)) <> 0
    or position('generate_series' in lower(v_stage_definition)) <> 0
    or v_core_language <> 'sql'
    or v_core_volatility <> 's'
    or (
      length(lower(v_core_definition))
      - length(replace(lower(v_core_definition), 'generate_series', ''))
    ) / length('generate_series') <> 1
    or position('generated_dates as materialized' in lower(v_core_definition)) = 0
    or position('day_offsets(day_offset)' in lower(v_core_definition)) = 0
    or position('interval ''1 day''' in lower(v_core_definition)) <> 0
    or v_generator_language <> 'sql'
    or v_generator_volatility <> 's'
    or (
      length(lower(v_generator_definition))
      - length(replace(lower(v_generator_definition), v_core_call, ''))
    ) / length(v_core_call) <> 1
    or position('generate_series' in lower(v_generator_definition)) <> 0
    or (
      length(lower(v_diagnostics_definition))
      - length(replace(lower(v_diagnostics_definition), v_core_call, ''))
    ) / length(v_core_call) <> 1
    or position('generate_series' in lower(v_diagnostics_definition)) <> 0
    or position('generate_series' in lower(v_preflight_definition)) <> 0
  then
    raise exception 'Task4 single-expansion SQL shape contract was not preserved';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.seasonal_import_expansion_preflight_v2(jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.seasonal_import_expansion_preflight_v2(jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.seasonal_import_atomic_preview_v2(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.seasonal_import_atomic_preview_v2(uuid)',
    'EXECUTE'
  ) then
    raise exception 'client roles must not execute internal expansion helpers';
  end if;
end
$$;

insert into public.seasons (
  id,
  season_code,
  name,
  file_name,
  uploaded_at,
  effective_start,
  effective_end,
  total_legs,
  total_source_rows,
  data_version
)
values (
  'seasonal-import-v2-ambiguous-season',
  ' tv2 ',
  'Seasonal Import V2 Ambiguous Test',
  '',
  0,
  '',
  '',
  0,
  0,
  0
);

do $$
begin
  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '4b32dbcd-c51c-45c4-a534-a1675c65d8f4',
      'checksum', 'ambiguous-season-code',
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object(
        'rowIndex', 50,
        'effective', '2026-10-25',
        'discontinue', '2026-10-25',
        'airline', 'VN',
        'aircraft', '321',
        'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
        'sta', '07:05',
        'arrFlight', 'VN350',
        'arrRoute', 'KIX'
      ))
    ));
    raise exception 'ambiguous case-insensitive seasonCode was not rejected';
  exception
    when cardinality_violation then
      if position('Ambiguous seasonCode' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_validated_batch_id uuid;
  v_expected_data_version integer;
begin
  select batches.batch_id, batches.expected_data_version
  into v_validated_batch_id, v_expected_data_version
  from public.season_import_batches batches
  where batches.status = 'validated'
    and batches.expected_data_version is not null
  order by batches.created_at
  limit 1;

  if v_validated_batch_id is null then
    raise exception 'permission fixture could not find a validated batch';
  end if;

  perform set_config('request.jwt.claim.sub', '99465540-43d7-47a2-a1f4-59946e96e36d', true);

  begin
    perform public.commit_seasonal_import_v2(
      v_validated_batch_id,
      v_expected_data_version
    );
    raise exception 'operator without seasonal.write committed a staged import';
  exception
    when insufficient_privilege then
      if position('seasonal.write' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', '7f3a7e0c-84af-4a2e-bbf5-e422611df69d',
      'checksum', 'permission-denied',
      'seasonCode', 'TV2',
      'sourceRows', jsonb_build_array(jsonb_build_object('rowIndex', 2))
    ));
    raise exception 'operator without seasonal.write was not rejected';
  exception
    when insufficient_privilege then
      if position('seasonal.write' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  perform set_config('request.jwt.claim.sub', 'a2a8ee9c-8e84-4cb7-aef6-358af42c3b31', true);
end
$$;

create or replace function pg_temp.task5_source_row(
  p_row_index integer,
  p_scheduled_date text,
  p_arr_flight text,
  p_dep_flight text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'rowIndex', p_row_index,
    'effective', p_scheduled_date,
    'discontinue', p_scheduled_date,
    'airline', 'VN',
    'aircraft', '321',
    'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
    'sta', case when p_arr_flight is null then null else '08:00' end,
    'arrFlight', p_arr_flight,
    'arrRoute', case when p_arr_flight is null then null else 'KIX' end,
    'arrFlightCategory', case when p_arr_flight is null then null else 'J' end,
    'arrCodeShares', null,
    'arrIntDomInd', case when p_arr_flight is null then null else 'I' end,
    'std', case when p_dep_flight is null then null else '09:00' end,
    'depFlight', p_dep_flight,
    'depRoute', case when p_dep_flight is null then null else 'ICN' end,
    'depFlightCategory', case when p_dep_flight is null then null else 'J' end,
    'depCodeShares', null,
    'depIntDomInd', case when p_dep_flight is null then null else 'I' end
  )
$$;

create or replace function pg_temp.task5_stage(
  p_request_id uuid,
  p_season_id text,
  p_season_code text,
  p_expected_data_version integer,
  p_checksum text,
  p_source_rows jsonb
)
returns jsonb
language sql
as $$
  select public.stage_seasonal_import_v2(jsonb_build_object(
    'requestId', p_request_id,
    'checksum', p_checksum,
    'seasonId', p_season_id,
    'seasonCode', p_season_code,
    'expectedDataVersion', p_expected_data_version,
    'fileName', p_season_code || '-task5.xlsx',
    'sourceRows', p_source_rows
  ))
$$;

create or replace function pg_temp.task5_snapshot(
  p_season_id text,
  p_batch_id uuid
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'season', (
      select to_jsonb(seasons)
      from public.seasons seasons
      where seasons.id = p_season_id
    ),
    'sourceRows', coalesce((
      select jsonb_agg(to_jsonb(rows) order by rows.row_index)
      from public.season_source_rows rows
      where rows.season_id = p_season_id
    ), '[]'::jsonb),
    'sourceRowDays', coalesce((
      select jsonb_agg(to_jsonb(days) order by days.row_index, days.iso_dow)
      from public.season_source_row_days days
      where days.season_id = p_season_id
    ), '[]'::jsonb),
    'flightRecords', coalesce((
      select jsonb_agg(to_jsonb(records) order by records.record_id)
      from public.season_flight_records records
      where records.season_id = p_season_id
    ), '[]'::jsonb),
    'flightRecordCounters', coalesce((
      select jsonb_agg(to_jsonb(counters) order by counters.record_id, counters.counter_group, counters.item_index)
      from public.season_flight_record_counters counters
      join public.season_flight_records records on records.record_id = counters.record_id
      where records.season_id = p_season_id
    ), '[]'::jsonb),
    'flightRecordWindows', coalesce((
      select jsonb_agg(to_jsonb(windows) order by windows.record_id, windows.counter_key)
      from public.season_flight_record_checkin_windows windows
      join public.season_flight_records records on records.record_id = windows.record_id
      where records.season_id = p_season_id
    ), '[]'::jsonb),
    'modifications', coalesce((
      select jsonb_agg(to_jsonb(modifications) order by modifications.leg_id)
      from public.season_modifications modifications
      where modifications.season_id = p_season_id
    ), '[]'::jsonb),
    'modificationCounters', coalesce((
      select jsonb_agg(to_jsonb(counters) order by counters.leg_id, counters.counter_group, counters.item_index)
      from public.season_modification_counters counters
      join public.season_modifications modifications on modifications.leg_id = counters.leg_id
      where modifications.season_id = p_season_id
    ), '[]'::jsonb),
    'modificationWindows', coalesce((
      select jsonb_agg(to_jsonb(windows) order by windows.leg_id, windows.counter_key)
      from public.season_modification_checkin_windows windows
      join public.season_modifications modifications on modifications.leg_id = windows.leg_id
      where modifications.season_id = p_season_id
    ), '[]'::jsonb),
    'modificationAddedLegs', coalesce((
      select jsonb_agg(to_jsonb(added_legs) order by added_legs.leg_id)
      from public.season_modification_added_legs added_legs
      where added_legs.season_id = p_season_id
    ), '[]'::jsonb),
    'changeEvents', coalesce((
      select jsonb_agg(to_jsonb(events) order by events.server_seq)
      from public.season_change_events events
      where events.season_id = p_season_id
    ), '[]'::jsonb),
    'entityVersions', coalesce((
      select jsonb_agg(to_jsonb(versions) order by versions.target_type, versions.target_id)
      from public.season_entity_versions versions
      where versions.season_id = p_season_id
    ), '[]'::jsonb),
    'batch', (
      select to_jsonb(batches)
      from public.season_import_batches batches
      where batches.batch_id = p_batch_id
    ),
    'batchRows', coalesce((
      select jsonb_agg(to_jsonb(rows) order by rows.row_index)
      from public.season_import_batch_rows rows
      where rows.batch_id = p_batch_id
    ), '[]'::jsonb)
  )
$$;

do $$
declare
  v_stage jsonb;
begin
  v_stage := pg_temp.task5_stage(
    'f1597f36-ce4c-471e-b463-ac18c59124c3',
    null,
    'X57',
    0,
    'task5-invalid-batch',
    jsonb_build_array(jsonb_build_object(
      'rowIndex', 1,
      'effective', '2026-10-25',
      'discontinue', '2026-10-25',
      'airline', '',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(true, true, true, true, true, true, true),
      'sta', '08:00',
      'arrFlight', 'VN500',
      'arrRoute', 'KIX'
    ))
  );

  if v_stage->>'status' <> 'failed' then
    raise exception 'invalid commit fixture was not staged as failed: %', v_stage;
  end if;

  begin
    perform public.commit_seasonal_import_v2((v_stage->>'batchId')::uuid, 0);
    raise exception 'failed import batch was committed';
  exception
    when data_exception then
      if position('must be validated before commit' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  v_stage jsonb;
  v_batch_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version, last_synced_at
  ) values (
    'task5-stale-season', 'X51', 'Task 5 stale', 'before.xlsx', 1,
    '2026-10-25', '2026-10-25', 0, 0, 4, 1
  );

  v_stage := pg_temp.task5_stage(
    '1f6ed355-ce79-4f62-a4fd-ad1014cb2031',
    'task5-stale-season',
    'X51',
    3,
    'task5-stale',
    jsonb_build_array(pg_temp.task5_source_row(1, '2026-10-25', 'VN501', null))
  );
  v_batch_id := (v_stage->>'batchId')::uuid;
  v_before := pg_temp.task5_snapshot('task5-stale-season', v_batch_id);

  begin
    perform public.commit_seasonal_import_v2(v_batch_id, 3);
    raise exception 'stale expectedDataVersion was not rejected';
  exception
    when serialization_failure then
      if position('data version' in lower(sqlerrm)) = 0 then
        raise;
      end if;
  end;

  v_after := pg_temp.task5_snapshot('task5-stale-season', v_batch_id);
  if v_after is distinct from v_before then
    raise exception 'stale commit changed Seasonal state: before=%, after=%', v_before, v_after;
  end if;
end
$$;

do $$
declare
  v_stage jsonb;
  v_batch_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_record record;
  v_event_count integer;
  v_version integer;
  v_response_key_count integer;
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version, last_synced_at
  ) values (
    'task5-rebase-season', 'X52', 'Task 5 rebase', 'before.xlsx', 10,
    '2026-10-20', '2026-10-30', 4, 2, 7, 10
  );

  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft,
    sta, arr_flight, arr_route
  ) values (
    'task5-rebase-season', 900, '2026-10-20', '2026-10-30', 'VN', '320',
    '07:55', 'VN900', 'OLD'
  );
  insert into public.season_source_row_days values ('task5-rebase-season', 900, 1);

  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    request_status_code, route, schedule, aircraft, category, code_shares, int_dom_ind,
    pax, gate, stand, carousel, mct, fb, lb, bhs, ghs, date, scheduled_date,
    scheduled_time, operational_date, iata_season_code, flight_series_id, day_of_week,
    source_row_index, linked_source_row_index, link_type, pair_anchor_date,
    linked_record_id, source_kind, source_side, status, turnaround_id
  ) values
  (
    'task5-rebase-season', 'legacy-arr-id', 'legacy-turnaround', 'A', 'VN', 'VN501', '501',
    'REQ', 'OLD-ARR', '07:55', '320', 'OLD', 'OLDCS', 'D',
    123, 7, 8, 9, 'MCT', 'FB', 'LB', 'BHS', 'GHS', '2026-10-25', '2026-10-25',
    '07:55', '2026-10-25', 'W26', 'SER_OLD_ARR', 0,
    901, 902, 'sameday', '2026-10-25',
    'legacy-dep-id', 'imported', 'ARR', 'active', 'legacy-turnaround'
  ),
  (
    'task5-rebase-season', 'legacy-dep-id', 'legacy-turnaround', 'D', 'VN', 'VN502', '502',
    null, 'OLD-DEP', '08:55', '320', 'OLD', null, 'D',
    77, 17, 18, null, null, null, null, null, null, '2026-10-25', '2026-10-25',
    '08:55', '2026-10-25', 'W26', 'SER_OLD_DEP', 0,
    902, 901, 'sameday', '2026-10-25',
    'legacy-arr-id', 'imported', 'DEP', 'active', 'legacy-turnaround'
  ),
  (
    'task5-rebase-season', 'legacy-deleted-id', 'legacy-deleted-id', 'A', 'VN', 'VN503', '503',
    null, 'OLD-503', '08:00', '320', 'OLD', null, null,
    3, 4, 5, null, null, null, null, null, null, '2026-10-26', '2026-10-26',
    '08:00', '2026-10-26', 'W26', 'SER_OLD_503', 1,
    903, null, null, null,
    null, 'imported', 'ARR', 'active', null
  ),
  (
    'task5-rebase-season', 'legacy-omitted-id', 'legacy-omitted-id', 'A', 'VN', 'VN999', '999',
    null, 'OLD-999', '08:00', '320', 'OLD', null, null,
    4, 5, 6, null, null, null, null, null, null, '2026-10-27', '2026-10-27',
    '08:00', '2026-10-27', 'W26', 'SER_OLD_999', 2,
    904, null, null, null,
    null, 'imported', 'ARR', 'active', null
  ),
  (
    'task5-rebase-season', 'manual-added-id', 'manual-added-id', 'A', 'VN', 'VN777', '777',
    null, 'MANUAL', '10:00', '321', 'J', null, 'I',
    88, 20, 21, null, null, null, null, null, null, '2026-10-29', '2026-10-29',
    '10:00', '2026-10-29', 'W26', 'SER_MANUAL', 4,
    0, null, null, null,
    null, 'added', 'ARR', 'active', null
  );

  insert into public.season_flight_record_counters
    (record_id, counter_group, item_index, counter_value)
  values ('legacy-arr-id', 'A', 0, '24');
  insert into public.season_flight_record_checkin_windows
    (record_id, counter_key, window_start, window_end)
  values ('legacy-arr-id', '24', '05:00', '07:30');

  insert into public.season_modifications (
    season_id, leg_id, action, changed_fields, schedule, aircraft, route, code_shares,
    pax, gate, stand, carousel, mct, fb, lb, bhs, ghs,
    check_in_start, check_in_end, check_in_allocation_mode
  ) values (
    'task5-rebase-season', 'legacy-arr-id', 'modified',
    array['schedule', 'aircraft', 'route', 'codeShares', 'pax', 'gate', 'counter',
      'checkInStart', 'checkInEnd', 'checkInAllocationMode',
      'checkInCounterWindows', 'mct'],
    '06:00', '359', 'MOD-ROUTE', 'MOD-CS',
    222, 12, null, null, 'MOD-MCT', null, null, null, null,
    '04:30', '07:30', 'broken'
  ), (
    'task5-rebase-season', 'legacy-deleted-id', 'deleted',
    array['schedule'], '06:30', null, null, null,
    null, null, null, null, null, null, null, null, null,
    null, null, null
  ), (
    'task5-rebase-season', 'legacy-omitted-id', 'modified',
    array['gate'], null, null, null, null,
    null, 30, null, null, null, null, null, null, null,
    null, null, null
  );
  insert into public.season_modification_counters
    (leg_id, counter_group, item_index, counter_value)
  values ('legacy-arr-id', 'A', 0, '12');
  insert into public.season_modification_checkin_windows
    (leg_id, counter_key, window_start, window_end)
  values ('legacy-arr-id', '12', '04:30', '07:30');

  v_stage := pg_temp.task5_stage(
    'ea0b20d6-11f4-4ca8-9fad-85ae28a590bd',
    'task5-rebase-season',
    'X52',
    7,
    'task5-rebase',
    jsonb_build_array(
      pg_temp.task5_source_row(10, '2026-10-25', 'VN501', 'VN502'),
      pg_temp.task5_source_row(11, '2026-10-26', 'VN503', null),
      pg_temp.task5_source_row(12, '2026-10-28', 'VN504', null)
    )
  );
  v_batch_id := (v_stage->>'batchId')::uuid;
  if (v_stage->>'status') <> 'validated'
    or (v_stage->>'generatedRecordCount')::integer <> 4
  then
    raise exception 'Task 5 rebase fixture did not stage four records: %', v_stage;
  end if;

  v_first := public.commit_seasonal_import_v2(v_batch_id, 7);

  select count(*) into v_response_key_count from jsonb_object_keys(v_first);
  if v_response_key_count <> 11 or v_first ? '_staging' then
    raise exception 'commit response contains unexpected keys: %', v_first;
  end if;

  if v_first->>'status' <> 'committed'
    or v_first->>'seasonId' <> 'task5-rebase-season'
    or v_first->>'seasonCode' <> 'X52'
    or (v_first->>'sourceRowCount')::integer <> 3
    or (v_first->>'flightRecordCount')::integer <> 4
    or (v_first->>'preservedOperationalCount')::integer <> 3
    or (v_first->>'removedImportedCount')::integer <> 1
    or (v_first->>'dataVersion')::integer <> 8
    or v_first->>'checksum' <> 'task5-rebase'
  then
    raise exception 'commit returned an unexpected rebase result: %', v_first;
  end if;

  select * into v_record
  from public.season_flight_records records
  where records.record_id = 'legacy-arr-id';
  if not found
    or v_record.season_id <> 'task5-rebase-season'
    or v_record.route <> 'KIX'
    or v_record.schedule <> '08:00'
    or v_record.aircraft <> '321'
    or v_record.category <> 'J'
    or v_record.code_shares is not null
    or v_record.int_dom_ind <> 'I'
    or v_record.request_status_code <> 'REQ'
    or v_record.pax <> 123
    or v_record.gate <> 7
    or v_record.stand <> 8
    or v_record.carousel <> 9
    or v_record.mct <> 'MCT'
    or v_record.fb <> 'FB'
    or v_record.lb <> 'LB'
    or v_record.bhs <> 'BHS'
    or v_record.ghs <> 'GHS'
    or v_record.status <> 'active'
    or v_record.action is not null
    or v_record.linked_record_id <> 'legacy-dep-id'
  then
    raise exception 'matched ARR record did not preserve identity/operational state: %', to_jsonb(v_record);
  end if;

  select * into v_record
  from public.season_flight_records records
  where records.record_id = 'legacy-dep-id';
  if not found or v_record.linked_record_id <> 'legacy-arr-id'
    or v_record.turnaround_id is null
    or v_record.link_id <> v_record.turnaround_id
  then
    raise exception 'matched DEP record did not rebase reciprocal links: %', to_jsonb(v_record);
  end if;

  if (select count(*) from public.season_flight_record_counters where record_id = 'legacy-arr-id') <> 1
    or (select count(*) from public.season_flight_record_checkin_windows where record_id = 'legacy-arr-id') <> 1
  then
    raise exception 'matched record child operational rows were not preserved';
  end if;

  if exists (
    select 1 from public.season_flight_records
    where record_id = 'legacy-omitted-id'
  ) or exists (
    select 1 from public.season_modifications
    where leg_id in ('legacy-omitted-id', 'legacy-deleted-id')
  ) then
    raise exception 'omitted imported record or source-owned/deleted modifications survived';
  end if;

  if not exists (
    select 1 from public.season_flight_records
    where record_id = 'legacy-deleted-id' and status = 'active' and action is null
  ) then
    raise exception 'deleted imported occurrence was not restored to baseline';
  end if;

  if not exists (
    select 1 from public.season_flight_records
    where record_id = 'manual-added-id' and source_kind = 'added'
  ) then
    raise exception 'manual added record was removed by re-import';
  end if;

  if not exists (
    select 1
    from public.season_modifications modifications
    where modifications.leg_id = 'legacy-arr-id'
      and modifications.action = 'modified'
      and modifications.changed_fields = array[
        'pax', 'gate', 'counter', 'checkInStart', 'checkInEnd',
        'checkInAllocationMode', 'checkInCounterWindows', 'mct'
      ]::text[]
      and modifications.schedule is null
      and modifications.aircraft is null
      and modifications.route is null
      and modifications.code_shares is null
      and modifications.pax = 222
      and modifications.gate = 12
      and modifications.check_in_start = '04:30'
      and modifications.check_in_end = '07:30'
      and modifications.check_in_allocation_mode = 'broken'
      and modifications.mct = 'MOD-MCT'
  ) then
    raise exception 'operational-only modification was not rebased with corrected changed_fields';
  end if;

  if (select count(*) from public.season_modification_counters where leg_id = 'legacy-arr-id') <> 1
    or (select count(*) from public.season_modification_checkin_windows where leg_id = 'legacy-arr-id') <> 1
  then
    raise exception 'operational modification child rows were not preserved';
  end if;

  if not exists (
    select 1
    from public.seasons seasons
    where seasons.id = 'task5-rebase-season'
      and seasons.file_name = 'X52-task5.xlsx'
      and seasons.effective_start = '2026-10-25'
      and seasons.effective_end = '2026-10-28'
      and seasons.total_legs = 4
      and seasons.total_source_rows = 3
      and seasons.data_version = 8
      and seasons.last_synced_at is not null
  ) then
    raise exception 'season metadata was not updated from committed read-back counts';
  end if;

  select count(*) into v_event_count
  from public.season_change_events events
  where events.season_id = 'task5-rebase-season'
    and events.target_type = 'seasonImport'
    and events.op_id = v_batch_id::text;
  if v_event_count <> 1 then
    raise exception 'commit did not insert exactly one import event';
  end if;

  if (v_first->>'serverHighWater')::bigint is distinct from (
    select events.server_seq
    from public.season_change_events events
    where events.season_id = 'task5-rebase-season'
      and events.op_id = v_batch_id::text
  ) then
    raise exception 'serverHighWater does not equal the import event sequence';
  end if;

  if not exists (
    select 1
    from public.season_import_batches batches
    where batches.batch_id = v_batch_id
      and batches.status = 'committed'
      and batches.season_id = 'task5-rebase-season'
      and batches.committed_at is not null
      and batches.result #>> '{_staging,targetSeasonId}' = 'task5-rebase-season'
      and batches.result - '_staging' = v_first
  ) then
    raise exception 'committed batch did not preserve staging metadata and exact result';
  end if;

  select seasons.data_version into v_version
  from public.seasons seasons where seasons.id = 'task5-rebase-season';
  v_second := public.commit_seasonal_import_v2(v_batch_id, 7);
  if v_second is distinct from v_first then
    raise exception 'recommit did not return the original result: first=%, second=%', v_first, v_second;
  end if;
  if (select data_version from public.seasons where id = 'task5-rebase-season') <> v_version
    or (select count(*) from public.season_change_events where season_id = 'task5-rebase-season') <> v_event_count
  then
    raise exception 'recommit duplicated version or event writes';
  end if;
end
$$;

do $$
declare
  v_stage jsonb;
  v_batch_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version
  ) values (
    'task5-collision-season', 'X53', 'Task 5 collision', '', 0, '', '', 1, 0, 1
  );
  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, date, scheduled_date, scheduled_time,
    operational_date, day_of_week, source_kind, source_side, status
  ) values (
    'task5-collision-season', 'task5-manual-collision', 'task5-manual-collision',
    'D', 'VN', 'VN610', '610', 'MANUAL', '12:00', '321', 'J',
    '2026-11-01', '2026-11-01', '12:00', '2026-11-01', 0,
    'added', 'DEP', 'active'
  );

  v_stage := pg_temp.task5_stage(
    '575494f4-feae-4272-84b9-f315ff4fae32',
    'task5-collision-season',
    'X53',
    1,
    'task5-added-collision',
    jsonb_build_array(pg_temp.task5_source_row(1, '2026-11-01', 'VN610', null))
  );
  v_batch_id := (v_stage->>'batchId')::uuid;
  v_before := pg_temp.task5_snapshot('task5-collision-season', v_batch_id);

  begin
    perform public.commit_seasonal_import_v2(v_batch_id, 1);
    raise exception 'manual-added occurrence collision was not rejected';
  exception
    when unique_violation then
      if position('manual added occurrence collision' in lower(sqlerrm)) = 0 then
        raise;
      end if;
  end;

  v_after := pg_temp.task5_snapshot('task5-collision-season', v_batch_id);
  if v_after is distinct from v_before then
    raise exception 'manual collision changed Seasonal state: before=%, after=%', v_before, v_after;
  end if;
  if not exists (
    select 1 from public.season_flight_records
    where record_id = 'task5-manual-collision' and source_kind = 'added'
  ) then
    raise exception 'manual added record did not survive collision rollback';
  end if;
end
$$;

create or replace function pg_temp.task5_raise_import_event()
returns trigger
language plpgsql
as $$
begin
  if new.season_id = 'task5-exception-season' then
    raise exception 'task5 injected event failure';
  end if;
  return new;
end
$$;

do $$
declare
  v_stage jsonb;
  v_batch_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version, last_synced_at
  ) values (
    'task5-exception-season', 'X54', 'Task 5 exception', 'old.xlsx', 11,
    '2026-11-02', '2026-11-02', 1, 1, 2, 11
  );
  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft,
    sta, arr_flight, arr_route
  ) values (
    'task5-exception-season', 1, '2026-11-02', '2026-11-02', 'VN', '320',
    '07:00', 'VN620', 'OLD'
  );
  insert into public.season_source_row_days values ('task5-exception-season', 1, 1);
  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, gate, date, scheduled_date, scheduled_time,
    operational_date, day_of_week, source_row_index, source_kind, source_side, status
  ) values (
    'task5-exception-season', 'task5-exception-record', 'task5-exception-record',
    'A', 'VN', 'VN620', '620', 'OLD', '07:00', '320', 'OLD', 6,
    '2026-11-02', '2026-11-02', '07:00', '2026-11-02', 1, 1,
    'imported', 'ARR', 'active'
  );
  insert into public.season_modifications (
    season_id, leg_id, action, changed_fields, route, gate
  ) values (
    'task5-exception-season', 'task5-exception-record', 'modified',
    array['route', 'gate'], 'MOD', 14
  );

  v_stage := pg_temp.task5_stage(
    '4b7d9f29-e23b-4cd8-9b3e-354c75c12af8',
    'task5-exception-season',
    'X54',
    2,
    'task5-injected-exception',
    jsonb_build_array(pg_temp.task5_source_row(1, '2026-11-02', 'VN620', null))
  );
  v_batch_id := (v_stage->>'batchId')::uuid;

  create trigger task5_raise_import_event
  before insert on public.season_change_events
  for each row execute function pg_temp.task5_raise_import_event();

  v_before := pg_temp.task5_snapshot('task5-exception-season', v_batch_id);
  begin
    perform public.commit_seasonal_import_v2(v_batch_id, 2);
    raise exception 'injected commit exception did not abort';
  exception
    when raise_exception then
      if position('task5 injected event failure' in sqlerrm) = 0 then
        raise;
      end if;
  end;
  v_after := pg_temp.task5_snapshot('task5-exception-season', v_batch_id);
  if v_after is distinct from v_before then
    raise exception 'injected exception did not roll back every Seasonal write: before=%, after=%',
      v_before, v_after;
  end if;

  drop trigger task5_raise_import_event on public.season_change_events;
end
$$;

do $$
declare
  v_payload jsonb;
  v_stage jsonb;
  v_retry_stage jsonb;
  v_batch_id uuid;
  v_target_season_id text;
  v_staged_record_ids text[];
  v_committed_record_ids text[];
  v_first jsonb;
  v_second jsonb;
begin
  v_payload := jsonb_build_object(
    'requestId', 'f62fce4e-5f8b-41bc-adc2-4a8dcde95a88',
    'checksum', 'task5-new-season',
    'seasonId', null,
    'seasonCode', 'X55',
    'expectedDataVersion', 0,
    'fileName', 'X55-task5.xlsx',
    'sourceRows', jsonb_build_array(
      pg_temp.task5_source_row(1, '2026-11-03', 'VN630', 'VN631')
    )
  );
  v_stage := public.stage_seasonal_import_v2(v_payload);
  v_batch_id := (v_stage->>'batchId')::uuid;

  select batches.result #>> '{_staging,targetSeasonId}'
  into v_target_season_id
  from public.season_import_batches batches
  where batches.batch_id = v_batch_id;
  select array_agg(generated.record_id order by generated.record_id)
  into v_staged_record_ids
  from public.generate_seasonal_import_records_v2(v_batch_id) generated;

  if v_target_season_id is null or cardinality(v_staged_record_ids) <> 2 then
    raise exception 'new-season staging identity fixture is invalid';
  end if;

  v_first := public.commit_seasonal_import_v2(v_batch_id, 0);
  if v_first->>'seasonId' <> v_target_season_id
    or (v_first->>'dataVersion')::integer <> 1
  then
    raise exception 'new-season commit did not use reserved targetSeasonId/version: %', v_first;
  end if;

  select array_agg(records.record_id order by records.record_id)
  into v_committed_record_ids
  from public.season_flight_records records
  where records.season_id = v_target_season_id
    and records.source_kind = 'imported';
  if v_committed_record_ids is distinct from v_staged_record_ids then
    raise exception 'new-season committed IDs drifted from staging: staged=%, committed=%',
      v_staged_record_ids, v_committed_record_ids;
  end if;

  if not exists (
    select 1 from public.seasons seasons
    where seasons.id = v_target_season_id
      and seasons.season_code = 'X55'
      and seasons.data_version = 1
  ) or not exists (
    select 1 from public.season_import_batches batches
    where batches.batch_id = v_batch_id
      and batches.season_id = v_target_season_id
      and batches.result #>> '{_staging,targetSeasonId}' = v_target_season_id
  ) then
    raise exception 'new season or committed batch lost immutable target identity';
  end if;

  v_retry_stage := public.stage_seasonal_import_v2(v_payload);
  v_second := public.commit_seasonal_import_v2(v_batch_id, 0);
  if v_retry_stage->>'batchId' <> v_batch_id::text
    or v_retry_stage->>'status' <> 'committed'
    or v_second is distinct from v_first
  then
    raise exception 'new-season stage/commit retry was not idempotent';
  end if;
end
$$;

create or replace function pg_temp.task5_suppress_source_row()
returns trigger
language plpgsql
as $$
begin
  if new.season_id = 'task5-readback-season' then
    return null;
  end if;
  return new;
end
$$;

do $$
declare
  v_stage jsonb;
  v_batch_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  insert into public.seasons (
    id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
    total_legs, total_source_rows, data_version
  ) values (
    'task5-readback-season', 'X56', 'Task 5 readback', 'old.xlsx', 0,
    '2026-11-04', '2026-11-04', 1, 1, 2
  );
  insert into public.season_source_rows (
    season_id, row_index, effective, discontinue, airline, aircraft,
    sta, arr_flight, arr_route
  ) values (
    'task5-readback-season', 1, '2026-11-04', '2026-11-04', 'VN', '320',
    '07:00', 'VN640', 'OLD'
  );
  insert into public.season_source_row_days values ('task5-readback-season', 1, 3);
  insert into public.season_flight_records (
    season_id, record_id, link_id, type, airline, flight_number, raw_flight_number,
    route, schedule, aircraft, category, date, scheduled_date, scheduled_time,
    operational_date, day_of_week, source_row_index, source_kind, source_side, status
  ) values (
    'task5-readback-season', 'task5-readback-record', 'task5-readback-record',
    'A', 'VN', 'VN640', '640', 'OLD', '07:00', '320', 'OLD',
    '2026-11-04', '2026-11-04', '07:00', '2026-11-04', 3, 1,
    'imported', 'ARR', 'active'
  );

  v_stage := pg_temp.task5_stage(
    'ec3a56a6-a2cf-488a-b119-425929e98e83',
    'task5-readback-season',
    'X56',
    2,
    'task5-readback-mismatch',
    jsonb_build_array(pg_temp.task5_source_row(1, '2026-11-04', 'VN640', null))
  );
  v_batch_id := (v_stage->>'batchId')::uuid;

  create trigger task5_suppress_source_row
  before insert on public.season_source_rows
  for each row execute function pg_temp.task5_suppress_source_row();

  v_before := pg_temp.task5_snapshot('task5-readback-season', v_batch_id);
  begin
    perform public.commit_seasonal_import_v2(v_batch_id, 2);
    raise exception 'read-back source count mismatch returned false success';
  exception
    when raise_exception then
      if position('read-back source row count mismatch' in lower(sqlerrm)) = 0 then
        raise;
      end if;
  end;
  v_after := pg_temp.task5_snapshot('task5-readback-season', v_batch_id);
  if v_after is distinct from v_before then
    raise exception 'read-back mismatch did not roll back every Seasonal write';
  end if;

  drop trigger task5_suppress_source_row on public.season_source_rows;
end
$$;

rollback;
