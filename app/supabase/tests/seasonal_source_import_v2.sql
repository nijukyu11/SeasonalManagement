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

insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
values ('a2a8ee9c-8e84-4cb7-aef6-358af42c3b31', 'seasonal.write', 'allow');

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
  v_first jsonb;
  v_second jsonb;
  v_persisted_row_count integer;
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
      'airline', 'VN',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(false, false, false, false, false, false, true),
      'sta', '07:05',
      'arrFlight', 'VN336',
      'arrRoute', 'KIX',
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

  v_retry_payload := jsonb_set(
    v_payload,
    '{sourceRows}',
    jsonb_build_array(
      jsonb_build_object('rowIndex', 900, 'effective', 'invalid'),
      jsonb_build_object('rowIndex', 901, 'effective', 'also-invalid')
    )
  );
  v_second := public.stage_seasonal_import_v2(v_retry_payload);

  if v_second->>'status' <> 'staged'
    or (v_second->>'sourceRowCount')::integer <> 1
    or jsonb_array_length(v_second->'diagnostics') <> 0
    or not (v_second->>'valid')::boolean
  then
    raise exception 'idempotent retry must return persisted batch state: %', v_second;
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
