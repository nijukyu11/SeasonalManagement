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

  if has_function_privilege(
    'authenticated',
    'public.preserve_season_import_batch_staging_metadata_v2()',
    'EXECUTE'
  ) then
    raise exception 'authenticated must not execute the staging metadata trigger function';
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

  if v_result->>'status' <> 'staged' or not (v_result->>'valid')::boolean then
    raise exception 'authenticated RPC execute path failed: %', v_result;
  end if;
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

  if v_first->>'status' <> 'staged'
    or (v_first->>'sourceRowCount')::integer <> 1
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

  select batches.result #>> '{_staging,requestFingerprint}'
  into v_fingerprint_before
  from public.season_import_batches batches
  where batches.batch_id = (v_first->>'batchId')::uuid;

  if char_length(coalesce(v_fingerprint_before, '')) <> 64 then
    raise exception 'server request fingerprint was not persisted compactly';
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

  select batches.result #>> '{_staging,requestFingerprint}'
  into v_fingerprint_after
  from public.season_import_batches batches
  where batches.batch_id = (v_first->>'batchId')::uuid;

  if v_fingerprint_after is distinct from v_fingerprint_before
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

  if (v_second - array['batchId', 'status', 'sourceRowCount', 'diagnostics', 'valid']) <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(v_second)) <> 5
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

  if v_result->>'status' <> 'staged' or not (v_result->>'valid')::boolean then
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
begin
  perform set_config('request.jwt.claim.sub', '99465540-43d7-47a2-a1f4-59946e96e36d', true);

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

rollback;
