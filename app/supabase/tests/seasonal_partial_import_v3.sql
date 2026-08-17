begin;

do $$
declare
  v_error_code text;
  v_flight_number text;
  v_raw_flight_number text;
begin
  select normalized.flight_number, normalized.raw_flight_number
  into v_flight_number, v_raw_flight_number
  from public.normalize_seasonal_flight_number_v2(' tg ', ' TG59 ') normalized;

  if v_flight_number is distinct from 'TG059'
    or v_raw_flight_number is distinct from '059'
  then
    raise exception 'optimized flight normalization changed canonical output';
  end if;

  if exists (
    select 1
    from public.normalize_seasonal_flight_number_v2('TG', '   ')
  ) then
    raise exception 'optimized flight normalization must not emit blank flights';
  end if;

  if (
    select source_provenance_mode
    from public.seasons
    where id = 'season-29cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) is distinct from 'full' then
    raise exception 'season with source snapshot was not backfilled to full provenance';
  end if;

  if (
    select source_provenance_mode
    from public.seasons
    where id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) is distinct from 'none' then
    raise exception 'season without source snapshot did not retain none provenance';
  end if;

  if (
    select target_existed_at_stage
    from public.season_import_batches
    where request_id = '10000000-0000-4000-8000-000000000001'
  ) is distinct from true then
    raise exception 'existing-season V2 batch target was not backfilled';
  end if;

  if (
    select target_existed_at_stage
    from public.season_import_batches
    where request_id = '10000000-0000-4000-8000-000000000002'
  ) is distinct from false then
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

  if pg_catalog.has_table_privilege(
    'authenticated',
    'public.season_import_batch_records_v3',
    'select'
  ) or pg_catalog.has_table_privilege(
    'authenticated',
    'public.season_import_batch_preimages_v3',
    'select'
  ) then
    raise exception 'authenticated retained direct V3 staging table access';
  end if;
end;
$$;

insert into public.season_flight_records (
  season_id,
  record_id,
  link_id,
  type,
  airline,
  flight_number,
  raw_flight_number,
  route,
  schedule,
  aircraft,
  category,
  date,
  scheduled_date,
  scheduled_time,
  operational_date,
  iata_season_code,
  flight_series_id,
  day_of_week,
  source_row_index,
  source_kind,
  source_side,
  status
) values
  (
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_A_EXISTING_UNRELATED',
    'LEG_A_EXISTING_UNRELATED',
    'A',
    'VN',
    'VN336',
    '336',
    'KIX',
    '07:05',
    '321',
    'J',
    '2026-06-07',
    '2026-06-07',
    '07:05',
    '2026-06-07',
    'S26',
    'SER_A_VN_VN336_KIX',
    0,
    99,
    'imported',
    'ARR',
    'active'
  ),
  (
    'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_A_MANUAL_KC999',
    'LEG_A_MANUAL_KC999',
    'A',
    'KC',
    'KC999',
    '999',
    'ICN',
    '10:00',
    '738',
    'J',
    '2026-06-06',
    '2026-06-06',
    '10:00',
    '2026-06-06',
    'S26',
    'SER_A_KC_KC999_ICN',
    6,
    0,
    'added',
    'ARR',
    'active'
  );

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  true
);

do $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'contractVersion', 3,
    'requestId', '30000000-0000-5000-8000-000000000001',
    'checksum', 'merge-no-permission',
    'strategy', 'merge',
    'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'seasonCode', 'S26',
    'expectedDataVersion', 7,
    'fileName', 'S26.xlsx',
    'uploadedAt', 1,
    'sourceRows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'rowIndex', 1,
        'effective', '2026-06-06',
        'discontinue', '2026-06-06',
        'airline', 'KC',
        'aircraft', '738',
        'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
        'sta', '23:15',
        'arrFlight', '259',
        'arrFlightType', 'PAX',
        'arrRoute', 'ICN',
        'arrFlightCategory', 'J',
        'arrCodeShares', null,
        'arrIntDomInd', 'I',
        'std', null,
        'depFlight', null,
        'depFlightType', null,
        'depRoute', null,
        'depFlightCategory', null,
        'depCodeShares', null,
        'depIntDomInd', null,
        'overnightLinkRowIndex', null,
        'linkType', null
      )
    )
  );
begin
  begin
    perform public.stage_seasonal_import_v3(v_payload);
    raise exception 'merge without seasonal.write was accepted';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%seasonal.write%' then
        raise;
      end if;
  end;

  begin
    perform public.stage_seasonal_import_v3(
      pg_catalog.jsonb_set(v_payload, '{strategy}', '"replace"'::jsonb)
    );
    raise exception 'replace without season.repair was accepted';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%season.repair%' then
        raise;
      end if;
  end;
end;
$$;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_source_row jsonb := pg_catalog.jsonb_build_object(
    'rowIndex', 1,
    'effective', '2026-06-06',
    'discontinue', '2026-06-06',
    'airline', 'KC',
    'aircraft', '738',
    'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
    'sta', '23:15',
    'arrFlight', '259',
    'arrFlightType', 'PAX',
    'arrRoute', 'ICN',
    'arrFlightCategory', 'J',
    'arrCodeShares', null,
    'arrIntDomInd', 'I',
    'std', null,
    'depFlight', null,
    'depFlightType', null,
    'depRoute', null,
    'depFlightCategory', null,
    'depCodeShares', null,
    'depIntDomInd', null,
    'overnightLinkRowIndex', null,
    'linkType', null
  );
  v_payload jsonb;
  v_result jsonb;
  v_retry jsonb;
  v_batch_id uuid;
  v_before_seasons bigint;
  v_before_records bigint;
  v_before_modifications bigint;
  v_before_events bigint;
  v_before_versions bigint;
begin
  select pg_catalog.count(*) into v_before_seasons from public.seasons;
  select pg_catalog.count(*) into v_before_records from public.season_flight_records;
  select pg_catalog.count(*) into v_before_modifications from public.season_modifications;
  select pg_catalog.count(*) into v_before_events from public.season_change_events;
  select pg_catalog.count(*) into v_before_versions from public.season_entity_versions;

  v_payload := pg_catalog.jsonb_build_object(
    'contractVersion', 3,
    'requestId', '30000000-0000-5000-8000-000000000010',
    'checksum', 'merge-valid',
    'strategy', 'merge',
    'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'seasonCode', 'S26',
    'expectedDataVersion', 7,
    'fileName', 'S26.xlsx',
    'uploadedAt', 1,
    'sourceRows', pg_catalog.jsonb_build_array(v_source_row)
  );

  v_result := public.stage_seasonal_import_v3(v_payload);
  v_retry := public.stage_seasonal_import_v3(v_payload);
  v_batch_id := (v_result->>'batchId')::uuid;

  if v_retry is distinct from v_result then
    raise exception 'same-request V3 stage did not return the persisted result';
  end if;
  if v_result->>'status' <> 'validated'
    or (v_result->>'valid')::boolean is distinct from true
    or v_result->>'strategy' <> 'merge'
    or v_result->>'seasonId'
      <> 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  then
    raise exception 'valid merge stage returned an invalid contract: %', v_result;
  end if;
  if (v_result #>> '{counts,sourceRowCount}')::integer <> 1
    or (v_result #>> '{counts,generatedOccurrenceCount}')::integer <> 1
    or (v_result #>> '{counts,insertCount}')::integer <> 1
    or (v_result #>> '{counts,baselineUpdateCount}')::integer <> 0
    or (v_result #>> '{counts,unchangedCount}')::integer <> 0
    or (v_result #>> '{counts,preservedOutsideScopeCount}')::integer <> 1
    or (v_result #>> '{counts,removeImportedCount}')::integer <> 0
    or (v_result #>> '{counts,clearStructuralOverlayCount}')::integer <> 0
    or (v_result #>> '{counts,clearDeletedOverlayCount}')::integer <> 0
  then
    raise exception 'merge preview counts are inconsistent: %', v_result->'counts';
  end if;
  if (select pg_catalog.count(*) from public.seasons) <> v_before_seasons
    or (select pg_catalog.count(*) from public.season_flight_records) <> v_before_records
    or (select pg_catalog.count(*) from public.season_modifications) <> v_before_modifications
    or (select pg_catalog.count(*) from public.season_change_events) <> v_before_events
    or (select pg_catalog.count(*) from public.season_entity_versions) <> v_before_versions
  then
    raise exception 'stage mutated season workspace data';
  end if;

  for v_payload in
    select changed.payload
    from (
      values
        (pg_catalog.jsonb_set(v_payload, '{checksum}', '"changed"'::jsonb)),
        (pg_catalog.jsonb_set(v_payload, '{strategy}', '"replace"'::jsonb)),
        (pg_catalog.jsonb_set(v_payload, '{expectedDataVersion}', '8'::jsonb))
    ) changed(payload)
  loop
    begin
      perform public.stage_seasonal_import_v3(v_payload);
      raise exception 'request identity conflict was accepted';
    exception
      when unique_violation then null;
    end;
  end loop;
end;
$$;

reset role;

do $$
begin
  if (
    select pg_catalog.count(*)
    from public.season_import_batch_records_v3 records
    join public.season_import_batches batches
      on batches.batch_id = records.batch_id
    where batches.request_id = '30000000-0000-5000-8000-000000000010'
  ) <> 1 then
    raise exception 'valid stage did not persist exactly one generated occurrence';
  end if;
end;
$$;


set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_invalid jsonb;
  v_collision jsonb;
  v_replace jsonb;
begin
  v_invalid := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000020',
      'checksum', 'invalid-row',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'invalid.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 1,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', '',
          'aircraft', '738',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '23:15',
          'arrFlight', '259',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if v_invalid->>'status' <> 'failed'
    or (v_invalid->>'valid')::boolean is distinct from false
    or (v_invalid->>'diagnosticCount')::integer < 1
    or pg_catalog.jsonb_array_length(v_invalid->'diagnostics') < 1
    or v_invalid #>> '{diagnostics,0,code}' is null
    or v_invalid #> '{diagnostics,0,sourceRowIndexes}' is null
  then
    raise exception 'invalid stage did not return structured diagnostics: %', v_invalid;
  end if;

  v_collision := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000021',
      'checksum', 'manual-collision',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'collision.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 2,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'KC',
          'aircraft', '738',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '10:00',
          'arrFlight', '999',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if (v_collision #>> '{counts,manualCollisionCount}')::integer <> 1
    or (v_collision->>'valid')::boolean is distinct from false
  then
    raise exception 'manual occurrence collision was not represented in preview: %', v_collision;
  end if;

  v_replace := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000022',
      'checksum', 'replace-valid',
      'strategy', 'replace',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'replace.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 3,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'KC',
          'aircraft', '789',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '11:00',
          'arrFlight', '999',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if v_replace->>'status' <> 'validated'
    or v_replace->>'strategy' <> 'replace'
    or (v_replace #>> '{counts,insertCount}')::integer <> 1
    or (v_replace #>> '{counts,removeImportedCount}')::integer <> 2
    or (v_replace #>> '{counts,manualCollisionCount}')::integer <> 0
  then
    raise exception 'replace preview did not bypass manual collisions: %', v_replace;
  end if;
end;
$$;

do $$
declare
  v_stage jsonb;
  v_cancel jsonb;
  v_status jsonb;
begin
  v_stage := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000030',
      'checksum', 'cancel-me',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'cancel.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 4,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'OZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '12:00',
          'arrFlight', '101',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  v_status := public.get_seasonal_import_v3_status(
    '30000000-0000-5000-8000-000000000030'
  );
  if v_status is distinct from v_stage then
    raise exception 'status did not return the persisted stage result';
  end if;

  v_cancel := public.cancel_seasonal_import_v3((v_stage->>'batchId')::uuid);
  if v_cancel->>'status' <> 'cancelled'
    or v_cancel->>'batchId' <> v_stage->>'batchId'
  then
    raise exception 'cancel returned an invalid response: %', v_cancel;
  end if;

  v_status := public.get_seasonal_import_v3_status(
    '30000000-0000-5000-8000-000000000030'
  );
  if v_status->>'status' <> 'cancelled'
    or (v_status->>'valid')::boolean is distinct from true
  then
    raise exception 'cancel did not retain the persisted valid preview: %', v_status;
  end if;
end;
$$;

do $$
declare
  v_valid jsonb;
  v_invalid jsonb;
begin
  v_valid := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000040',
      'checksum', 'canonical-time-valid',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'time-valid.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 40,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'TM',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '1025',
          'arrFlight', '401',
          'arrRoute', 'ICN'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 41,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'TM',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '925',
          'arrFlight', '402',
          'arrRoute', 'ICN'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 42,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'TM',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '10:25',
          'arrFlight', '403',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if v_valid->>'status' <> 'validated'
    or (v_valid->>'valid')::boolean is distinct from true
  then
    raise exception 'V3 stage rejected compact schedule times: %', v_valid;
  end if;

  v_invalid := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '30000000-0000-5000-8000-000000000041',
      'checksum', 'canonical-time-invalid',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'time-invalid.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 43,
          'effective', '2026-06-06',
          'discontinue', '2026-06-06',
          'airline', 'TM',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '2500',
          'arrFlight', '404',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if v_invalid->>'status' <> 'failed'
    or (v_invalid->>'valid')::boolean is distinct from false
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_invalid->'diagnostics') diagnostics(value)
      where diagnostics.value->>'code' = 'invalid-time'
    )
  then
    raise exception 'V3 stage accepted invalid compact schedule time: %', v_invalid;
  end if;
end;
$$;

reset role;

do $$
declare
  v_schedules text[];
begin
  select pg_catalog.array_agg(
    records.record_data->>'schedule'
    order by records.source_staging_row_index
  )
  into v_schedules
  from public.season_import_batch_records_v3 records
  join public.season_import_batches batches
    on batches.batch_id = records.batch_id
  where batches.request_id = '30000000-0000-5000-8000-000000000040';

  if v_schedules is distinct from array['10:25', '09:25', '10:25']::text[] then
    raise exception 'V3 stage did not persist canonical schedule times: %', v_schedules;
  end if;

  if exists (
    select 1
    from public.season_import_batch_records_v3 records
    join public.season_import_batches batches
      on batches.batch_id = records.batch_id
    where batches.request_id = '30000000-0000-5000-8000-000000000041'
  ) then
    raise exception 'V3 stage persisted records for an invalid schedule time';
  end if;
end;
$$;

insert into public.seasons (
  id,
  season_code,
  name,
  data_version,
  total_legs,
  total_source_rows
) values (
  'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'M26',
  'M26 merge fixture',
  3,
  5,
  0
);

insert into public.season_flight_records (
  season_id,
  record_id,
  link_id,
  type,
  airline,
  flight_number,
  raw_flight_number,
  route,
  schedule,
  aircraft,
  category,
  int_dom_ind,
  gate,
  date,
  scheduled_date,
  scheduled_time,
  operational_date,
  iata_season_code,
  flight_series_id,
  day_of_week,
  source_row_index,
  source_kind,
  source_side,
  status
) values
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_UNCHANGED',
    'LEG_M26_UNCHANGED',
    'A',
    'MZ',
    'MZ101',
    '101',
    'ICN',
    '08:00',
    '321',
    'J',
    'I',
    null,
    '2026-08-01',
    '2026-08-01',
    '08:00',
    '2026-08-01',
    'M26',
    'SER_A_MZ_MZ101_ICN',
    6,
    1,
    'imported',
    'ARR',
    'active'
  ),
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_CHANGED',
    'LEG_M26_CHANGED',
    'A',
    'MZ',
    'MZ102',
    '102',
    'OLD',
    '09:00',
    '320',
    'J',
    'I',
    24,
    '2026-08-01',
    '2026-08-01',
    '09:00',
    '2026-08-01',
    'M26',
    'SER_A_MZ_MZ102_OLD',
    6,
    2,
    'imported',
    'ARR',
    'active'
  ),
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_DELETED_OVERLAY',
    'LEG_M26_DELETED_OVERLAY',
    'A',
    'MZ',
    'MZ103',
    '103',
    'ICN',
    '10:00',
    '321',
    'J',
    'I',
    null,
    '2026-08-01',
    '2026-08-01',
    '10:00',
    '2026-08-01',
    'M26',
    'SER_A_MZ_MZ103_ICN',
    6,
    3,
    'imported',
    'ARR',
    'active'
  ),
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_OMITTED',
    'LEG_M26_OMITTED',
    'A',
    'MZ',
    'MZ104',
    '104',
    'ICN',
    '11:00',
    '321',
    'J',
    'I',
    null,
    '2026-08-01',
    '2026-08-01',
    '11:00',
    '2026-08-01',
    'M26',
    'SER_A_MZ_MZ104_ICN',
    6,
    4,
    'imported',
    'ARR',
    'active'
  ),
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_MANUAL',
    'LEG_M26_MANUAL',
    'A',
    'MZ',
    'MZ999',
    '999',
    'ICN',
    '12:00',
    '321',
    'J',
    'I',
    30,
    '2026-08-01',
    '2026-08-01',
    '12:00',
    '2026-08-01',
    'M26',
    'SER_A_MZ_MZ999_ICN',
    6,
    0,
    'added',
    'ARR',
    'active'
  );

insert into public.season_modifications (
  season_id,
  leg_id,
  action,
  changed_fields,
  schedule,
  gate,
  check_in_start,
  check_in_end,
  check_in_allocation_mode
) values
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_CHANGED',
    'modified',
    array[
      'schedule',
      'gate',
      'counter',
      'checkInStart',
      'checkInEnd',
      'checkInAllocationMode',
      'checkInCounterWindows'
    ],
    '09:30',
    25,
    '07:00',
    '08:30',
    'grouped'
  ),
  (
    'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
    'LEG_M26_DELETED_OVERLAY',
    'deleted',
    '{}'::text[],
    null,
    null,
    null,
    null,
    null
  );

insert into public.season_modification_counters (
  leg_id,
  counter_group,
  item_index,
  counter_value
) values ('LEG_M26_CHANGED', 'A', 0, '24');

insert into public.season_modification_checkin_windows (
  leg_id,
  counter_key,
  window_start,
  window_end
) values ('LEG_M26_CHANGED', '24', '07:00', '08:30');

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_preview jsonb;
  v_committed jsonb;
  v_retry jsonb;
  v_batch_id uuid;
  v_unchanged_before jsonb;
  v_modifications_before jsonb;
  v_counters_before jsonb;
  v_windows_before jsonb;
begin
  select pg_catalog.to_jsonb(records)
  into v_unchanged_before
  from public.season_flight_records records
  where records.record_id = 'LEG_M26_UNCHANGED';

  select pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(modifications)
    order by modifications.leg_id
  )
  into v_modifications_before
  from public.season_modifications modifications
  where modifications.season_id
    = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6';

  select pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(counters)
    order by counters.leg_id, counters.counter_group, counters.item_index
  )
  into v_counters_before
  from public.season_modification_counters counters
  where counters.leg_id = 'LEG_M26_CHANGED';

  select pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(windows)
    order by windows.leg_id, windows.counter_key
  )
  into v_windows_before
  from public.season_modification_checkin_windows windows
  where windows.leg_id = 'LEG_M26_CHANGED';

  v_preview := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '40000000-0000-5000-8000-000000000001',
      'checksum', 'merge-commit-fixture',
      'strategy', 'merge',
      'seasonId', 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'M26',
      'expectedDataVersion', 3,
      'fileName', 'M26-partial.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 1,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '08:00',
          'arrFlight', '101',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 2,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '738',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '09:00',
          'arrFlight', '102',
          'arrRoute', 'HND',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 3,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '10:00',
          'arrFlight', '103',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 5,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '13:00',
          'arrFlight', '105',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        )
      )
    )
  );

  if v_preview->>'status' <> 'validated'
    or (v_preview #>> '{counts,insertCount}')::integer <> 1
    or (v_preview #>> '{counts,baselineUpdateCount}')::integer <> 1
    or (v_preview #>> '{counts,unchangedCount}')::integer <> 2
    or (v_preview #>> '{counts,preservedOutsideScopeCount}')::integer <> 1
    or (v_preview #>> '{counts,preservedDeletedOverlayCount}')::integer <> 1
    or (v_preview #>> '{counts,clearDeletedOverlayCount}')::integer <> 0
  then
    raise exception 'merge commit fixture preview is incorrect: %', v_preview;
  end if;

  v_batch_id := (v_preview->>'batchId')::uuid;
  v_committed := public.commit_seasonal_import_v3(
    v_batch_id,
    3,
    v_preview->>'previewHash'
  );
  v_retry := public.commit_seasonal_import_v3(
    v_batch_id,
    3,
    v_preview->>'previewHash'
  );

  if v_retry is distinct from v_committed
    or v_committed->>'status' <> 'committed'
    or (v_committed->>'dataVersion')::integer <> 4
    or (v_committed->>'importedRecordCount')::integer <> 5
    or (v_committed->>'totalEffectiveRecordCount')::integer <> 5
    or (v_committed #>> '{counts,preservedDeletedOverlayCount}')::integer <> 1
    or (v_committed #>> '{counts,clearDeletedOverlayCount}')::integer <> 0
  then
    raise exception 'merge commit result or idempotency is incorrect: %', v_committed;
  end if;

  if (
    select pg_catalog.to_jsonb(records)
    from public.season_flight_records records
    where records.record_id = 'LEG_M26_UNCHANGED'
  ) is distinct from v_unchanged_before then
    raise exception 'unchanged incoming record was rewritten';
  end if;

  if not exists (
    select 1
    from public.season_flight_records records
    where records.record_id = 'LEG_M26_CHANGED'
      and records.route = 'HND'
      and records.aircraft = '738'
      and records.gate = 24
      and records.source_import_batch_id = v_batch_id
  ) then
    raise exception 'changed baseline did not preserve ID/operational values: %',
      (
        select pg_catalog.to_jsonb(records)
        from public.season_flight_records records
        where records.record_id = 'LEG_M26_CHANGED'
      );
  end if;

  if (
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(modifications)
      order by modifications.leg_id
    )
    from public.season_modifications modifications
    where modifications.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) is distinct from v_modifications_before then
    raise exception 'merge changed modification overlays';
  end if;

  if (
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(counters)
      order by counters.leg_id, counters.counter_group, counters.item_index
    )
    from public.season_modification_counters counters
    where counters.leg_id = 'LEG_M26_CHANGED'
  ) is distinct from v_counters_before
    or (
      select pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(windows)
        order by windows.leg_id, windows.counter_key
      )
      from public.season_modification_checkin_windows windows
      where windows.leg_id = 'LEG_M26_CHANGED'
    ) is distinct from v_windows_before
  then
    raise exception 'merge changed modification child rows';
  end if;

  if not exists (
    select 1
    from public.season_modifications modifications
    where modifications.leg_id = 'LEG_M26_DELETED_OVERLAY'
      and modifications.action = 'deleted'
  ) or not exists (
    select 1
    from public.season_flight_records records
    where records.record_id = 'LEG_M26_OMITTED'
  ) or not exists (
    select 1
    from public.season_flight_records records
    where records.record_id = 'LEG_M26_MANUAL'
      and records.source_kind = 'added'
  ) or not exists (
    select 1
    from public.season_flight_records records
    where records.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and records.flight_number = 'MZ105'
      and records.source_kind = 'imported'
  ) then
    raise exception 'merge removed a preserved record or failed to add the new occurrence';
  end if;

  if exists (
    select 1
    from public.season_flight_records records
    left join public.season_modifications modifications
      on modifications.season_id = records.season_id
      and modifications.leg_id = records.record_id
    where records.record_id = 'LEG_M26_DELETED_OVERLAY'
      and modifications.action is distinct from 'deleted'
  ) then
    raise exception 'merge made a deleted overlay effective after commit';
  end if;

  if exists (
    select 1
    from public.season_source_rows source_rows
    where source_rows.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) or (
    select total_source_rows
    from public.seasons
    where id = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) <> 0 then
    raise exception 'merge rewrote the full source snapshot';
  end if;

  if not exists (
    select 1
    from public.seasons seasons
    where seasons.id = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and seasons.data_version = 4
      and seasons.source_provenance_mode = 'fragmented'
      and seasons.last_import_batch_id = v_batch_id
      and seasons.total_legs = 5
  ) then
    raise exception 'merge season metadata is incorrect';
  end if;

  if (
    select pg_catalog.count(*)
    from public.season_change_events events
    where events.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and events.op_id = v_batch_id::text
  ) <> 1 then
    raise exception 'merge did not persist exactly one change event';
  end if;
end;
$$;

reset role;

do $$
begin
  if (
    select pg_catalog.count(*)
    from public.season_import_batch_preimages_v3 preimages
    join public.season_import_batches batches
      on batches.batch_id = preimages.batch_id
    where batches.request_id = '40000000-0000-5000-8000-000000000001'
  ) <> 4 then
    raise exception 'merge did not persist one preimage per incoming occurrence';
  end if;

  if not exists (
    select 1
    from public.season_import_batch_preimages_v3 preimages
    join public.season_import_batches batches
      on batches.batch_id = preimages.batch_id
    where batches.request_id = '40000000-0000-5000-8000-000000000001'
      and preimages.record_id = 'LEG_M26_CHANGED'
      and preimages.modification_data->>'action' = 'modified'
      and pg_catalog.jsonb_array_length(preimages.counter_rows) = 1
      and pg_catalog.jsonb_array_length(preimages.checkin_window_rows) = 1
  ) then
    raise exception 'merge preimage omitted operational overlay details';
  end if;
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_row jsonb := pg_catalog.jsonb_build_object(
    'rowIndex', 1,
    'effective', '2026-09-24',
    'discontinue', '2026-10-29',
    'airline', 'KE',
    'aircraft', '333',
    'daysOfWeek', '[false,false,false,true,false,false,false]'::jsonb,
    'sta', '08:30',
    'arrFlight', '2093',
    'arrFlightType', 'PAX',
    'arrRoute', 'ICN',
    'arrFlightCategory', 'J',
    'arrCodeShares', null,
    'arrIntDomInd', 'I',
    'std', '10:00',
    'depFlight', '2094',
    'depFlightType', 'PAX',
    'depRoute', 'ICN',
    'depFlightCategory', 'J',
    'depCodeShares', null,
    'depIntDomInd', 'I',
    'overnightLinkRowIndex', null,
    'linkType', null
  );
  v_result jsonb;
begin
  v_result := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '60000000-0000-5000-8000-000000000001',
      'checksum', 'grouped-ke-duplicates',
      'strategy', 'merge',
      'seasonId', 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'S26',
      'expectedDataVersion', 7,
      'fileName', 'grouped-ke-duplicates.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        v_row,
        pg_catalog.jsonb_set(v_row, '{rowIndex}', '2'::jsonb)
      )
    )
  );

  if v_result->>'status' <> 'failed'
    or (v_result->>'valid')::boolean
    or (v_result->>'diagnosticCount')::integer <> 2
    or pg_catalog.jsonb_array_length(v_result->'diagnostics') <> 2
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_result->'diagnostics')
        diagnostics(item)
      where diagnostics.item->>'code' <> 'duplicate-occurrence-key'
        or diagnostics.item->'sourceRowIndexes' <> '[1,2]'::jsonb
        or (diagnostics.item->>'affectedDateCount')::integer <> 6
        or pg_catalog.jsonb_array_length(diagnostics.item->'sampleDates') <> 5
    )
    or (
      select pg_catalog.array_agg(
        diagnostics.item->>'message'
        order by diagnostics.item->>'message'
      )
      from pg_catalog.jsonb_array_elements(v_result->'diagnostics')
        diagnostics(item)
    ) <> array[
      'Rows 1, 2 generate duplicate 6 occurrence(s) for KE2093.',
      'Rows 1, 2 generate duplicate 6 occurrence(s) for KE2094.'
    ]::text[]
  then
    raise exception 'grouped duplicate diagnostics are incorrect: %', v_result;
  end if;

  perform public.cancel_seasonal_import_v3((v_result->>'batchId')::uuid);
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  true
);

do $$
declare
  v_preview jsonb;
begin
  v_preview := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '50000000-0000-5000-8000-000000000001',
      'checksum', 'replace-permission-fixture',
      'strategy', 'replace',
      'seasonId', 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'M26',
      'expectedDataVersion', 4,
      'fileName', 'M26-replace-permission.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 1,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '08:00',
          'arrFlight', '101',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        )
      )
    )
  );

  if v_preview->>'status' <> 'validated' then
    raise exception 'replace permission fixture did not stage: %', v_preview;
  end if;
end;
$$;

reset role;

delete from public.app_operator_permission_overrides
where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  and permission_key = 'season.repair';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  true
);

do $$
declare
  v_status jsonb;
begin
  v_status := public.get_seasonal_import_v3_status(
    '50000000-0000-5000-8000-000000000001'
  );

  begin
    perform public.commit_seasonal_import_v3(
      (v_status->>'batchId')::uuid,
      4,
      v_status->>'previewHash'
    );
    raise exception 'replace commit without season.repair was accepted';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%season.repair%' then
        raise;
      end if;
  end;
end;
$$;

reset role;

insert into public.app_operator_permission_overrides (
  user_id,
  permission_key,
  effect
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'season.repair',
  'allow'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  true
);

do $$
declare
  v_status jsonb;
begin
  v_status := public.get_seasonal_import_v3_status(
    '50000000-0000-5000-8000-000000000001'
  );
  perform public.cancel_seasonal_import_v3((v_status->>'batchId')::uuid);
end;
$$;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_preview jsonb;
begin
  v_preview := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '50000000-0000-5000-8000-000000000002',
      'checksum', 'replace-drift-fixture',
      'strategy', 'replace',
      'seasonId', 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'M26',
      'expectedDataVersion', 4,
      'fileName', 'M26-replace-drift.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 1,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '08:00',
          'arrFlight', '101',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        )
      )
    )
  );

  begin
    insert into public.season_modifications (
      season_id,
      leg_id,
      action,
      changed_fields,
      route
    ) values (
      'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'LEG_M26_UNCHANGED',
      'modified',
      array['route'],
      'DRIFT'
    );

    perform public.commit_seasonal_import_v3(
      (v_preview->>'batchId')::uuid,
      4,
      v_preview->>'previewHash'
    );
    raise exception 'replace preview count drift was accepted';
  exception
    when raise_exception then
      if sqlerrm not like '%preview counts changed%' then
        raise;
      end if;
  end;

  perform public.cancel_seasonal_import_v3((v_preview->>'batchId')::uuid);
end;
$$;

reset role;

insert into public.season_mod_history_entries (
  season_id,
  entry_id,
  timestamp,
  description
) values (
  'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'HISTORY_M26_BEFORE_REPLACE',
  1,
  'Old modification history'
);

insert into public.season_mod_history_changes (
  entry_id,
  change_index,
  leg_id,
  previous_mod_snapshot,
  new_mod_snapshot
) values (
  'HISTORY_M26_BEFORE_REPLACE',
  0,
  'LEG_M26_CHANGED',
  null,
  '{"action":"modified"}'::jsonb
);

insert into public.season_entity_versions (
  season_id,
  target_type,
  target_id,
  entity_version,
  field_versions,
  updated_by
) values (
  'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
  'flightRecord',
  'LEG_M26_CHANGED_BEFORE_REPLACE',
  9,
  '{"schedule":9}'::jsonb,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_preview jsonb;
  v_committed jsonb;
  v_retry jsonb;
  v_batch_id uuid;
begin
  v_preview := public.stage_seasonal_import_v3(
    pg_catalog.jsonb_build_object(
      'contractVersion', 3,
      'requestId', '50000000-0000-5000-8000-000000000003',
      'checksum', 'replace-commit-fixture',
      'strategy', 'replace',
      'seasonId', 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6',
      'seasonCode', 'M26',
      'expectedDataVersion', 4,
      'fileName', 'M26-replace.xlsx',
      'uploadedAt', 1,
      'sourceRows', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'rowIndex', 1,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '08:00',
          'arrFlight', '101',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 2,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '738',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '09:00',
          'arrFlight', '102',
          'arrRoute', 'HND',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 3,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '10:00',
          'arrFlight', '103',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        ),
        pg_catalog.jsonb_build_object(
          'rowIndex', 5,
          'effective', '2026-08-01',
          'discontinue', '2026-08-01',
          'airline', 'MZ',
          'aircraft', '321',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '13:00',
          'arrFlight', '105',
          'arrRoute', 'ICN',
          'arrFlightCategory', 'J',
          'arrIntDomInd', 'I'
        )
      )
    )
  );

  if v_preview->>'status' <> 'validated'
    or (v_preview #>> '{counts,insertCount}')::integer <> 4
    or (v_preview #>> '{counts,baselineUpdateCount}')::integer <> 0
    or (v_preview #>> '{counts,unchangedCount}')::integer <> 0
    or (v_preview #>> '{counts,removeImportedCount}')::integer <> 6
    or (v_preview #>> '{counts,clearStructuralOverlayCount}')::integer <> 1
    or (v_preview #>> '{counts,clearDeletedOverlayCount}')::integer <> 1
    or (v_preview #>> '{counts,preservedOverlayCount}')::integer <> 0
    or (v_preview #>> '{counts,manualCollisionCount}')::integer <> 0
  then
    raise exception 'replace commit fixture preview is incorrect: %', v_preview;
  end if;

  v_batch_id := (v_preview->>'batchId')::uuid;
  v_committed := public.commit_seasonal_import_v3(
    v_batch_id,
    4,
    v_preview->>'previewHash'
  );
  v_retry := public.commit_seasonal_import_v3(
    v_batch_id,
    4,
    v_preview->>'previewHash'
  );

  if v_retry is distinct from v_committed
    or v_committed->>'status' <> 'committed'
    or v_committed->>'strategy' <> 'replace'
    or (v_committed->>'dataVersion')::integer <> 5
    or (v_committed->>'importedRecordCount')::integer <> 4
    or (v_committed->>'totalEffectiveRecordCount')::integer <> 4
    or (v_committed #>> '{counts,clearDeletedOverlayCount}')::integer <> 1
  then
    raise exception 'replace commit result or idempotency is incorrect: %',
      v_committed;
  end if;
end;
$$;

reset role;

do $$
declare
  v_batch_id uuid;
begin
  select batches.batch_id
  into v_batch_id
  from public.season_import_batches batches
  where batches.request_id = '50000000-0000-5000-8000-000000000003';

  if exists (
    select 1
    from public.season_flight_records records
    where records.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and records.record_id like 'LEG_M26_%'
  ) or (
    select pg_catalog.count(*)
    from public.season_flight_records records
    where records.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and records.source_kind = 'imported'
      and records.source_import_batch_id = v_batch_id
  ) <> 4 then
    raise exception 'replace did not rebuild the season exclusively from the new batch';
  end if;

  if exists (
    select 1
    from public.season_modifications modifications
    where modifications.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) or exists (
    select 1
    from public.season_modification_counters counters
    where counters.leg_id like 'LEG_M26_%'
  ) or exists (
    select 1
    from public.season_modification_checkin_windows windows
    where windows.leg_id like 'LEG_M26_%'
  ) then
    raise exception 'replace retained old modification state';
  end if;

  if exists (
    select 1
    from public.season_mod_history_entries history
    where history.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) or exists (
    select 1
    from public.season_entity_versions versions
    where versions.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and versions.target_type <> 'seasonImport'
  ) then
    raise exception 'replace retained old history or entity versions';
  end if;

  if (
    select pg_catalog.count(*)
    from public.season_source_rows source_rows
    where source_rows.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) <> 4 or (
    select pg_catalog.count(*)
    from public.season_source_row_days source_days
    where source_days.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
  ) <> 4 then
    raise exception 'replace did not rewrite the complete source snapshot';
  end if;

  if not exists (
    select 1
    from public.seasons seasons
    where seasons.id = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and seasons.data_version = 5
      and seasons.source_provenance_mode = 'full'
      and seasons.last_import_batch_id = v_batch_id
      and seasons.total_source_rows = 4
      and seasons.total_legs = 4
  ) then
    raise exception 'replace season metadata is incorrect';
  end if;

  if (
    select pg_catalog.count(*)
    from public.season_import_batch_preimages_v3 preimages
    where preimages.batch_id = v_batch_id
  ) <> 9 or (
    select pg_catalog.count(*)
    from public.season_import_batch_preimages_v3 preimages
    where preimages.batch_id = v_batch_id
      and preimages.existed_before
  ) <> 6 then
    raise exception 'replace did not snapshot every affected record identity';
  end if;

  if (
    select pg_catalog.count(*)
    from public.season_change_events events
    where events.season_id
      = 'season-39cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
      and events.op_id = v_batch_id::text
  ) <> 1 then
    raise exception 'replace did not persist exactly one change event';
  end if;
end;
$$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  true
);

do $$
begin
  begin
    perform public.get_seasonal_import_v3_status(
      '30000000-0000-5000-8000-000000000010'
    );
    raise exception 'another operator read a V3 import status';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.cancel_seasonal_import_v3(
      (
        select batch_id
        from public.season_import_batches
        where request_id = '30000000-0000-5000-8000-000000000010'
      )
    );
    raise exception 'another operator cancelled a V3 import';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;

update public.season_import_batches batches
set status = 'cancelled'
where batches.request_id = '10000000-0000-4000-8000-000000000001';

select pg_catalog.set_config(
  'test.cancelled_seasonal_import_batch_id',
  (
    select batches.batch_id::text
    from public.season_import_batches batches
    where batches.request_id = '10000000-0000-4000-8000-000000000001'
  ),
  true
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  true
);

do $$
declare
  v_batch_id uuid;
begin
  v_batch_id := pg_catalog.current_setting(
    'test.cancelled_seasonal_import_batch_id'
  )::uuid;

  begin
    perform public.commit_seasonal_import_v2(v_batch_id, 7);
    raise exception 'cancelled V2 batch was committed';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.resume_seasonal_import_v2(
      '10000000-0000-4000-8000-000000000001',
      7
    );
    raise exception 'cancelled V2 batch was resumed';
  exception
    when invalid_parameter_value then null;
  end;
end;
$$;

rollback;
