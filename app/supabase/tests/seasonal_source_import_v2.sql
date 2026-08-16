begin;

set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000123';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000123',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'workspace-v2-test@example.invalid', '', now(), now()
)
on conflict (id) do nothing;

do $$
declare
  request_id uuid := gen_random_uuid();
  payload jsonb;
  staged jsonb;
  committed jsonb;
  repeated jsonb;
begin
  if (select flight_number from public.normalize_seasonal_flight_number_v2('5J', '5J5756')) <> '5J5756' then
    raise exception 'four-digit flight suffix was truncated';
  end if;

  if (select flight_number from public.normalize_seasonal_flight_number_v2('LJ', '81')) <> 'LJ081' then
    raise exception 'short numeric flight suffix was not padded';
  end if;

  begin
    perform public.stage_seasonal_import_v2(jsonb_build_object(
      'requestId', gen_random_uuid(), 'clientId', 'sql-test', 'checksum', 'empty',
      'seasonCode', 'T26', 'sourceRows', '[]'::jsonb
    ));
    raise exception 'empty sourceRows should fail';
  exception when sqlstate '22023' then null;
  end;

  payload := jsonb_build_object(
    'requestId', request_id,
    'clientId', 'sql-test-client',
    'checksum', 'checksum-one',
    'seasonId', null,
    'seasonCode', 'T26',
    'expectedDataVersion', null,
    'fileName', 'test.xlsx',
    'uploadedAt', 1774828800000,
    'sourceRows', jsonb_build_array(jsonb_build_object(
      'rowIndex', 1,
      'effective', '2026-03-30',
      'discontinue', '2026-03-30',
      'airline', 'LJ',
      'aircraft', '321',
      'daysOfWeek', jsonb_build_array(true, false, false, false, false, false, false),
      'sta', null,
      'arrFlight', null,
      'arrRoute', null,
      'arrFlightCategory', null,
      'arrCodeShares', null,
      'arrIntDomInd', null,
      'std', '04:30',
      'depFlight', '81',
      'depRoute', 'ICN',
      'depFlightCategory', 'PAX',
      'depCodeShares', null,
      'depIntDomInd', 'I'
    ))
  );

  staged := public.stage_seasonal_import_v2(payload);
  if staged->>'status' <> 'validated'
     or (staged->>'valid')::boolean is not true
     or (staged->>'sourceRowCount')::integer <> 1 then
    raise exception 'valid import did not stage: %', staged;
  end if;

  repeated := public.stage_seasonal_import_v2(payload);
  if repeated->>'batchId' <> staged->>'batchId' then
    raise exception 'same request/checksum did not return the existing batch';
  end if;

  begin
    perform public.stage_seasonal_import_v2(jsonb_set(payload, '{checksum}', '"different"'));
    raise exception 'reused request with different checksum should fail';
  exception when unique_violation then null;
  end;

  if not exists (
    select 1 from public.generate_seasonal_import_records_v2((staged->>'batchId')::uuid)
    where flight_number = 'LJ081'
      and scheduled_date = '2026-03-30'
      and operational_date = '2026-03-29'
  ) then
    raise exception 'set-based generator did not normalize identity/operational date';
  end if;

  committed := public.commit_seasonal_import_v2((staged->>'batchId')::uuid, null);
  if committed->>'status' <> 'committed'
     or (committed->>'sourceRowCount')::integer <> 1
     or (committed->>'flightRecordCount')::integer <> 1
     or (committed->>'dataVersion')::integer <> 1
     or (committed->>'serverHighWater')::bigint <= 0 then
    raise exception 'valid import did not commit: %', committed;
  end if;

  repeated := public.stage_seasonal_import_v2(payload);
  if repeated->>'batchId' <> staged->>'batchId'
     or repeated->>'status' <> 'committed'
     or (repeated->>'valid')::boolean is not true then
    raise exception 'retry after committed response did not recover the stored batch: %', repeated;
  end if;

  repeated := public.commit_seasonal_import_v2((staged->>'batchId')::uuid, null);
  if repeated <> committed then
    raise exception 'recommit did not return the exact stored result';
  end if;
  if (select count(*) from public.season_change_events where op_id = request_id::text) <> 1 then
    raise exception 'idempotent commit inserted more than one change event';
  end if;
  repeated := public.get_seasonal_export_snapshot_v2(
    committed->>'seasonId',
    (committed->>'dataVersion')::integer
  );
  if repeated->>'truncated' <> 'false'
     or (repeated->>'totalCount')::integer <> jsonb_array_length(repeated->'flightRecords')
     or (repeated->>'dataVersion')::integer <> (committed->>'dataVersion')::integer
     or (repeated->>'serverHighWater')::bigint <> (committed->>'serverHighWater')::bigint then
    raise exception 'export snapshot is incomplete or not version-fenced: %', repeated;
  end if;
end;
$$;

rollback;
