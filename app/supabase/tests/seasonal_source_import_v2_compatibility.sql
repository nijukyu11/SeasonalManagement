begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('20000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'compat-owner@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('20000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'compat-other@example.invalid', '', now(), '{}', '{}', now(), now());

insert into public.app_operators (user_id, email, username, display_name)
values
  ('20000000-0000-0000-0000-000000000001', 'compat-owner@example.invalid', 'compat_owner', 'Compatibility Owner'),
  ('20000000-0000-0000-0000-000000000002', 'compat-other@example.invalid', 'compat_other', 'Compatibility Other');

insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
values
  ('20000000-0000-0000-0000-000000000001', 'seasonal.write', 'allow'),
  ('20000000-0000-0000-0000-000000000001', 'season.repair', 'allow'),
  ('20000000-0000-0000-0000-000000000002', 'seasonal.write', 'allow');

insert into public.seasons (
  id, season_code, name, file_name, uploaded_at, effective_start,
  effective_end, total_legs, total_source_rows, data_version
)
values ('compat-v2-season', 'S28', 'S28', '', 0, '', '', 0, 0, 0);

do $$
declare
  v_batch_id constant uuid := '20000000-0000-4000-8000-000000000010';
  v_request_id constant uuid := '20000000-0000-4000-8000-000000000011';
  v_row jsonb := pg_catalog.jsonb_build_object(
    'rowIndex', 1,
    'effective', '2028-03-26',
    'discontinue', '2028-03-26',
    'airline', 'VN',
    'aircraft', '321',
    'daysOfWeek', pg_catalog.jsonb_build_array(true, true, true, true, true, true, true),
    'sta', null,
    'arrFlight', null,
    'arrFlightType', null,
    'arrRoute', null,
    'arrFlightCategory', null,
    'arrCodeShares', null,
    'arrIntDomInd', null,
    'std', '10:00',
    'depFlight', 'VN337',
    'depFlightType', 'CARGO',
    'depRoute', 'KIX',
    'depFlightCategory', 'J',
    'depCodeShares', null,
    'depIntDomInd', 'I',
    'overnightLinkRowIndex', null,
    'linkType', null
  );
  v_source_rows jsonb;
  v_fingerprint text;
begin
  v_source_rows := pg_catalog.jsonb_build_array(v_row);
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'fingerprintVersion', 2,
          'sourceRows', v_source_rows,
          'seasonIdentity', pg_catalog.jsonb_build_object(
            'seasonCode', 'S28',
            'targetSeasonId', 'compat-v2-season'
          ),
          'expectedDataVersion', 0,
          'fileName', 'compat-v2.xlsx'
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  insert into public.season_import_batches (
    batch_id, request_id, season_id, season_code, expected_data_version,
    file_name, checksum, status, source_row_count, generated_record_count,
    diagnostics, result, created_by
  ) values (
    v_batch_id, v_request_id, 'compat-v2-season', 'S28', 0,
    'compat-v2.xlsx', 'compat-v2-checksum', 'validated', 1, 1,
    '[]'::jsonb,
    pg_catalog.jsonb_build_object('_staging', pg_catalog.jsonb_build_object(
      'fingerprintVersion', 2,
      'requestFingerprint', v_fingerprint,
      'targetSeasonId', 'compat-v2-season'
    )),
    '20000000-0000-0000-0000-000000000001'
  );
  insert into public.season_import_batch_rows (batch_id, row_index, row_data)
  values (v_batch_id, 1, v_row);
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);

do $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'requestId', '20000000-0000-4000-8000-000000000011',
    'checksum', 'compat-v2-checksum',
    'seasonId', 'compat-v2-season',
    'seasonCode', 'S28',
    'expectedDataVersion', 0,
    'fileName', 'compat-v2.xlsx',
    'uploadedAt', 0,
    'sourceRows', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'rowIndex', 1,
      'effective', '2028-03-26',
      'discontinue', '2028-03-26',
      'airline', 'VN',
      'aircraft', '321',
      'daysOfWeek', pg_catalog.jsonb_build_array(true, true, true, true, true, true, true),
      'sta', null,
      'arrFlight', null,
      'arrFlightType', null,
      'arrRoute', null,
      'arrFlightCategory', null,
      'arrCodeShares', null,
      'arrIntDomInd', null,
      'std', '10:00',
      'depFlight', 'VN337',
      'depFlightType', 'CARGO',
      'depRoute', 'KIX',
      'depFlightCategory', 'J',
      'depCodeShares', null,
      'depIntDomInd', 'I',
      'overnightLinkRowIndex', null,
      'linkType', null
    ))
  );
  v_stage jsonb;
  v_committed jsonb;
  v_checked jsonb;
begin
  v_stage := public.stage_seasonal_import_v2(v_payload);
  if v_stage->>'batchId' is distinct from '20000000-0000-4000-8000-000000000010'
    or v_stage->>'status' is distinct from 'validated'
  then
    raise exception 'v2 standard stage replay did not resume the existing batch: %', v_stage;
  end if;

  begin
    perform public.stage_seasonal_import_v2(v_payload || '{"mode":"repair"}'::jsonb);
    raise exception 'v2 standard batch was replayed as repair';
  exception when unique_violation then null;
  end;

  v_committed := public.resume_seasonal_import_v2(
    '20000000-0000-4000-8000-000000000011',
    0
  );
  if v_committed->>'status' is distinct from 'committed'
    or v_committed->>'seasonId' is distinct from 'compat-v2-season'
    or v_committed ? 'sourceRows'
    or v_committed ? '_staging'
  then
    raise exception 'v2 recovery commit returned an invalid minimal result: %', v_committed;
  end if;

  v_checked := public.resume_seasonal_import_v2(
    '20000000-0000-4000-8000-000000000011',
    0
  );
  if v_checked is distinct from v_committed then
    raise exception 'v2 committed Resume/Check was not idempotent';
  end if;

  if public.commit_seasonal_import_v2(
    '20000000-0000-4000-8000-000000000010',
    0
  ) is distinct from v_committed then
    raise exception 'v2 direct commit compatibility result changed';
  end if;
end
$$;

reset role;
do $$
begin
  if not exists (
    select 1
    from public.season_source_rows
    where season_id = 'compat-v2-season'
      and row_index = 1
      and arr_flight_type is null
      and dep_flight_type = 'CARGO'
  ) then
    raise exception 'committed v2 source provenance did not preserve null/non-null flight types';
  end if;
end
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
do $$
begin
  begin
    perform public.resume_seasonal_import_v2(
      '20000000-0000-4000-8000-000000000011',
      0
    );
    raise exception 'another operator recovered the owner batch';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

set local role service_role;
do $$
begin
  begin
    perform public.resume_seasonal_import_v2(
      '20000000-0000-4000-8000-000000000011',
      0
    );
    raise exception 'service role recovered an operator receipt through the client recovery RPC';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

rollback;
