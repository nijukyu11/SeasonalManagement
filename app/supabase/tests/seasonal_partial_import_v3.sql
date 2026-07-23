begin;

do $$
declare
  v_error_code text;
begin
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
          'airline', 'KE',
          'aircraft', '789',
          'daysOfWeek', '[false,false,false,false,false,true,false]'::jsonb,
          'sta', '11:00',
          'arrFlight', '123',
          'arrRoute', 'ICN'
        )
      )
    )
  );

  if v_replace->>'status' <> 'validated'
    or v_replace->>'strategy' <> 'replace'
    or (v_replace #>> '{counts,removeImportedCount}')::integer <> 1
  then
    raise exception 'replace preview was not staged correctly: %', v_replace;
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

rollback;
