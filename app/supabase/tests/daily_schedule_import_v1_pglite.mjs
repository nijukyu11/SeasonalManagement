import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const standMigration = await readFile(new URL('../migrations/20260828083000_allow_alphanumeric_stand_values.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/20260828090000_daily_schedule_import_v1.sql', import.meta.url), 'utf8');
const seasonalInteractionMigration = await readFile(new URL('../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql', import.meta.url), 'utf8');
const db = await createSupabasePGlite();
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seasonId = 'season-daily-import-v1';
const secondSeasonId = 'season-daily-import-v1-w26';

function payload(requestId, expectedDataVersion = 3) {
  const leg = {
    sourceRowNumber: 1, sheetName: 'Daily', side: 'DEP', seasonCode: 'S26', operationalDate: '2026-08-23',
    scheduledDate: '2026-08-23', scheduledTime: '06:00', airline: 'VN', flightNumber: 'VN101', rawFlightNumber: '101',
    route: 'SGN', aircraft: '321', category: 'J', flightType: 'PAX', requestStatusCode: null,
    resources: { route: 'SGN', schedule: '06:00', stand: '20A', gate: 1, counter: '30,M1' },
    rawResourceTokens: { stand: 'Stand20A', gate: 'G1', counter: 'C30 M1', carousel: null },
    occurrenceKey: 'S26|2026-08-23|DEP|VN|VN101|SGN|06:00', looseOccurrenceKey: 'S26|2026-08-23|DEP|VN|VN101',
  };
  return {
    contractVersion: 1, requestId, fileName: 'daily.xlsx', workbookProfile: 'compact-lb', rawChecksum: `raw-${requestId}`,
    canonicalChecksum: `canonical-${requestId}`, resourcePolicyHash: 'policy-v1', legs: [leg], diagnostics: [],
    seasons: [{ seasonId, seasonCode: 'S26', expectedDataVersion, rangeStart: '2026-08-23', rangeEnd: '2026-08-23', affectedDates: ['2026-08-23'], legCount: 1 }],
  };
}

try {
  await db.exec(schema);
  await db.exec(`
    insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
    values ('stand-reporting-fixture','S25','S25','',0,'2025-03-30','2025-10-25',1,1,1);
    insert into public.season_flight_records(season_id,record_id,type,flight_number,airline,route,schedule,date,operational_date,status,stand)
    values ('stand-reporting-fixture','STAND-REPORTING-1','D','VN100','VN','HAN','06:00','2025-08-23','2025-08-23','active',20);
    create view reporting.test_daily_public_traffic_candidates with (security_invoker = true) as
      select record_id, stand from reporting.effective_flight_operations where season_id='stand-reporting-fixture';
    create materialized view reporting.test_daily_public_traffic_effective as
      select record_id, stand from reporting.test_daily_public_traffic_candidates with data;
    create unique index test_daily_public_traffic_effective_record_idx
      on reporting.test_daily_public_traffic_effective(record_id);
    revoke all on reporting.test_daily_public_traffic_effective from public, anon, authenticated;
    grant select on reporting.test_daily_public_traffic_effective to anon;
  `);
  await db.exec(standMigration);
  const preservedReportingSnapshot = await db.query(`
    select
      to_regclass('reporting.test_daily_public_traffic_effective')::text as relation_name,
      pg_catalog.pg_typeof(stand)::text as stand_type,
      stand,
      has_table_privilege('anon','reporting.test_daily_public_traffic_effective','SELECT') as preserved_role_select,
      has_table_privilege('authenticated','reporting.test_daily_public_traffic_effective','SELECT') as authenticated_select,
      to_regclass('reporting.test_daily_public_traffic_effective_record_idx') is not null as index_preserved
    from reporting.test_daily_public_traffic_effective
  `);
  assert.deepEqual(preservedReportingSnapshot.rows, [{
    relation_name: 'reporting.test_daily_public_traffic_effective',
    stand_type: 'text',
    stand: '20',
    preserved_role_select: true,
    authenticated_select: false,
    index_preserved: true,
  }], 'stand migration must rebuild dependent reporting materialized views without widening their grants');
  await db.exec(migration);
  await db.exec(seasonalInteractionMigration);
  await db.query(`insert into auth.users(id,email) values ($1,'daily@example.test')`, [userId]);
  await db.query(`insert into public.app_operators(user_id,email,username,display_name) values ($1,'daily@example.test','daily','Daily')`, [userId]);
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values ($1,'daily.write','allow'),($1,'daily.read','allow'),($1,'seasonal.read','allow')`, [userId]);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',0,0,3)`, [seasonId]);
  await db.query(`insert into public.season_flight_records(season_id,record_id,type,flight_number,airline,route,schedule,date,operational_date,status) values ($1,'BASE-1','D','VN101','VN','HAN','05:00','2026-08-23','2026-08-23','active')`, [seasonId]);
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields,gate) values ($1,'BASE-1','modified',array['gate'],9)`, [seasonId]);
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);
  await db.query(`select public.upsert_season_flight_record_from_json($1,$2::jsonb)`, [seasonId, JSON.stringify({ id: 'STAND-20A', type: 'A', flightNumber: 'VN102', rawFlightNumber: '102', airline: 'VN', route: 'HAN', schedule: '07:00', date: '2026-08-24', operationalDate: '2026-08-24', stand: '20A' })]);
  await db.query(`select public.upsert_season_modification_from_json($1,$2::jsonb)`, [seasonId, JSON.stringify({ legId: 'STAND-20A', action: 'modified', stand: '20A' })]);
  const standRoundTrip = await db.query(`select records.stand as record_stand, mods.stand as mod_stand from public.season_flight_records records join public.season_modifications mods on mods.leg_id=records.record_id where records.record_id='STAND-20A'`);
  assert.deepEqual(standRoundTrip.rows, [{ record_stand: '20A', mod_stand: '20A' }]);

  const staged = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(payload('10000000-0000-4000-8000-000000000001'))]);
  const stageResult = staged.rows[0].result;
  assert.equal(stageResult.status, 'validated');
  const repeatedStage = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(payload('10000000-0000-4000-8000-000000000001'))]);
  assert.equal(repeatedStage.rows[0].result.batchId, stageResult.batchId, 'same requestId and checksums must recover the original staged batch');
  const reusedRequest = payload('10000000-0000-4000-8000-000000000001');
  reusedRequest.rawChecksum = 'different-raw-checksum';
  await assert.rejects(
    db.query(`select public.stage_daily_schedule_import_v1($1::jsonb)`, [JSON.stringify(reusedRequest)]),
    (error) => error?.code === '23505',
  );
  assert.equal(stageResult.preview.seasons[0].counts.beforeCount, 1);
  assert.equal(stageResult.preview.seasons[0].counts.afterCount, 1);
  assert.equal(stageResult.preview.seasons[0].counts.matchedCount, 1);
  assert.equal(stageResult.preview.seasons[0].counts.insertedCount, 0);

  const committed = await db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`, [stageResult.batchId, JSON.stringify({ [seasonId]: 3 }), stageResult.previewHash]);
  assert.equal(committed.rows[0].result.status, 'committed');
  const repeatedCommit = await db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`, [stageResult.batchId, JSON.stringify({ [seasonId]: 3 }), stageResult.previewHash]);
  assert.deepEqual(repeatedCommit.rows[0].result, committed.rows[0].result, 'repeated commit recovery must return the durable receipt without applying twice');
  const recoveredStatus = await db.query(`select public.get_daily_schedule_import_v1_status($1) as result`, ['10000000-0000-4000-8000-000000000001']);
  assert.equal(recoveredStatus.rows[0].result.status, 'committed');
  assert.deepEqual(recoveredStatus.rows[0].result.result, committed.rows[0].result);
  const active = await db.query(`select batch_id from public.daily_schedule_active_days where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.equal(active.rows.length, 1);
  const baseline = await db.query(`select count(*)::integer as count from public.season_flight_records where season_id=$1`, [seasonId]);
  assert.equal(baseline.rows[0].count, 2, 'Daily commit must not delete Seasonal baseline rows');
  const effective = await db.query(`select stand,gate,counter_token,schedule_source from public.daily_schedule_effective_legs_v1 where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(effective.rows, [{ stand: '20A', gate: 1, counter_token: '30,M1', schedule_source: 'daily' }]);
  await db.exec('begin; set local role authenticated');
  const effectiveAsOperator = await db.query(`select stand,gate from public.daily_schedule_effective_legs_v1 where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(effectiveAsOperator.rows, [{ stand: '20A', gate: 1 }], 'RLS/security-invoker views must expose active Daily data only through daily.read');
  await db.exec('rollback');
  const workspace = await db.query(`select public.get_season_schedule_allocation_window_v2($1,'2026-08-23','2026-08-23','schedule',500) as result`, [seasonId]);
  assert.equal(workspace.rows[0].result.flightRecords[0].record_id, 'BASE-1');
  assert.equal(workspace.rows[0].result.flightRecords[0].stand, '20A');
  assert.equal(workspace.rows[0].result.modifications[0].gate, 9, 'stable identity must retain the operational gate overlay');
  assert.deepEqual(workspace.rows[0].result.flightRecordCounters.map((row) => row.counter_value), ['30', 'M1']);
  const reporting = await db.query(`select stand,gate from reporting.effective_flight_operations where season_id=$1 and ops_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(reporting.rows, [{ stand: '20A', gate: 9 }], 'reporting must read the active Daily snapshot and its stable operational overlay');

  const gapPayload = payload('10000000-0000-4000-8000-000000000003', 4);
  gapPayload.legs.push({
    ...gapPayload.legs[0],
    sourceRowNumber: 2,
    operationalDate: '2026-08-25',
    scheduledDate: '2026-08-25',
    occurrenceKey: 'S26|2026-08-25|DEP|VN|VN101|SGN|06:00',
    looseOccurrenceKey: 'S26|2026-08-25|DEP|VN|VN101',
  });
  gapPayload.seasons[0] = { ...gapPayload.seasons[0], rangeEnd: '2026-08-25', affectedDates: ['2026-08-23', '2026-08-25'], legCount: 2 };
  const gapStage = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(gapPayload)]);
  assert.equal(gapStage.rows[0].result.status, 'failed');
  assert.ok(gapStage.rows[0].result.diagnostics.some((item) => item.code === 'DAILY_COVERAGE_GAP'));

  const replacementPayload = payload('10000000-0000-4000-8000-000000000004', 4);
  replacementPayload.legs[0].resources.gate = 2;
  replacementPayload.legs[0].rawResourceTokens.gate = 'G2';
  const replacementStage = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(replacementPayload)]);
  assert.equal(replacementStage.rows[0].result.preview.seasons[0].counts.beforeCount, 1, 'overlapping preview must count the active Daily snapshot');
  const replacementReceipt = await db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`, [replacementStage.rows[0].result.batchId, JSON.stringify({ [seasonId]: 4 }), replacementStage.rows[0].result.previewHash]);
  assert.equal(replacementReceipt.rows[0].result.status, 'committed');
  const replacedDaily = await db.query(`select gate from public.daily_schedule_effective_legs_v1 where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(replacedDaily.rows, [{ gate: 2 }], 'a later Daily batch must atomically replace the previously active Daily day');
  const eventReceipt = await db.query(`select op_payload from public.season_change_events where event_id=$1`, [`daily-import-v1:${replacementStage.rows[0].result.batchId}:${seasonId}`]);
  assert.equal(eventReceipt.rows[0].op_payload.kind, 'commit_daily_schedule_import_v1');
  assert.equal(eventReceipt.rows[0].op_payload.rawChecksum, replacementPayload.rawChecksum);

  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'W26','W26','',0,'2026-10-25','2027-03-27',0,0,2)`, [secondSeasonId]);
  await db.exec(`
    create or replace function public.test_fail_daily_commit_after_pointer() returns trigger language plpgsql as $$
    begin
      if current_setting('app.test_fail_daily_commit_season',true)=new.id then raise exception 'injected Daily multi-season commit failure'; end if;
      return new;
    end $$;
    create trigger test_fail_daily_commit_after_pointer before update on public.seasons
    for each row execute function public.test_fail_daily_commit_after_pointer();
  `);
  const rollbackPayload = payload('10000000-0000-4000-8000-000000000005', 5);
  rollbackPayload.legs[0].resources.gate = 3;
  rollbackPayload.legs.push({
    ...rollbackPayload.legs[0],
    sourceRowNumber: 2,
    seasonCode: 'W26',
    operationalDate: '2026-12-01',
    scheduledDate: '2026-12-01',
    flightNumber: 'VN201',
    rawFlightNumber: '201',
    occurrenceKey: 'W26|2026-12-01|DEP|VN|VN201|SGN|06:00',
    looseOccurrenceKey: 'W26|2026-12-01|DEP|VN|VN201',
  });
  rollbackPayload.seasons.push({ seasonId: secondSeasonId, seasonCode: 'W26', expectedDataVersion: 2, rangeStart: '2026-12-01', rangeEnd: '2026-12-01', affectedDates: ['2026-12-01'], legCount: 1 });
  const rollbackStage = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(rollbackPayload)]);
  await db.exec(`select set_config('app.test_fail_daily_commit_season','${secondSeasonId}',false)`);
  await assert.rejects(
    db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3)`, [rollbackStage.rows[0].result.batchId, JSON.stringify({ [seasonId]: 5, [secondSeasonId]: 2 }), rollbackStage.rows[0].result.previewHash]),
    /injected Daily multi-season commit failure/,
  );
  await db.exec(`select set_config('app.test_fail_daily_commit_season','',false)`);
  const activeAfterInjectedFailure = await db.query(`select batch_id from public.daily_schedule_active_days where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.equal(activeAfterInjectedFailure.rows[0].batch_id, replacementStage.rows[0].result.batchId, 'failure in the last season must roll back the first season active pointer');
  const secondSeasonAfterFailure = await db.query(`select data_version from public.seasons where id=$1`, [secondSeasonId]);
  assert.equal(secondSeasonAfterFailure.rows[0].data_version, 2);
  const secondSeasonActiveAfterFailure = await db.query(`select count(*)::integer as count from public.daily_schedule_active_days where season_id=$1`, [secondSeasonId]);
  assert.equal(secondSeasonActiveAfterFailure.rows[0].count, 0, 'failed multi-season commit must not leave an active day in the last season');
  const failedBatchEvents = await db.query(`select count(*)::integer as count from public.season_change_events where op_id=$1`, [rollbackStage.rows[0].result.batchId]);
  assert.equal(failedBatchEvents.rows[0].count, 0, 'failed multi-season commit must roll back all audit/realtime events');
  await db.exec(`drop trigger test_fail_daily_commit_after_pointer on public.seasons; drop function public.test_fail_daily_commit_after_pointer()`);
  await db.exec(`select set_config('app.seasonal_import_v3_bulk_season_id','${seasonId}',false)`);
  await db.query(`delete from public.season_modifications where season_id=$1`, [seasonId]);
  await db.query(`delete from public.season_flight_records where season_id=$1`, [seasonId]);
  await db.exec(`select set_config('app.seasonal_import_v3_bulk_season_id','',false)`);
  const preservedOverlay = await db.query(`select gate from public.season_modifications where season_id=$1 and leg_id='BASE-1'`, [seasonId]);
  assert.deepEqual(preservedOverlay.rows, [{ gate: 9 }], 'Seasonal full replace must preserve operational overlays attached to active Daily identities');
  const dailyAfterSeasonalReset = await db.query(`select stand,schedule_source from public.daily_schedule_effective_legs_v1 where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(dailyAfterSeasonalReset.rows, [{ stand: '20A', schedule_source: 'daily' }], 'Seasonal full replace must not remove the active Daily snapshot');

  const stale = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(payload('10000000-0000-4000-8000-000000000002', 5))]);
  await db.query(`update public.seasons set data_version=6 where id=$1`, [seasonId]);
  await assert.rejects(
    db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3)`, [stale.rows[0].result.batchId, JSON.stringify({ [seasonId]: 5 }), stale.rows[0].result.previewHash]),
    (error) => error?.code === '40001',
  );
  const stillActive = await db.query(`select batch_id from public.daily_schedule_active_days where season_id=$1 and operational_date='2026-08-23'`, [seasonId]);
  assert.equal(stillActive.rows[0].batch_id, replacementStage.rows[0].result.batchId, 'stale commit must leave the previous active snapshot intact');
  console.log(JSON.stringify({ suite: 'daily-schedule-import-v1', status: 'passed' }));
} finally {
  await db.close();
}
