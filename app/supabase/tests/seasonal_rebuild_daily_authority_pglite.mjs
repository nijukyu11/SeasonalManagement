import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const files = [
  '../schema.sql',
  '../migrations/20260828083000_allow_alphanumeric_stand_values.sql',
  '../migrations/20260828090000_daily_schedule_import_v1.sql',
  '../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql',
  '../migrations/20260829150000_canonical_flight_leg_store.sql',
  '../migrations/20260829153000_daily_schedule_canonical_commit.sql',
  '../migrations/20260829160000_canonical_manual_modifications.sql',
  '../migrations/20260829163000_canonical_effective_read.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260906011000_active_seasonal_export_snapshot.sql',
];
const sql = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
const db = await createSupabasePGlite();
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seasonId = 'season-seasonal-authority';
const dailyBatchId = '20000000-0000-4000-8000-000000000001';

const replacementPayload = {
  contractVersion: 3,
  requestId: '30000000-0000-4000-8000-000000000001',
  checksum: 'seasonal-authority-replace',
  strategy: 'replace',
  seasonId,
  seasonCode: 'S26',
  expectedDataVersion: 5,
  fileName: 'S26-rebuild.xlsx',
  uploadedAt: 1,
  sourceRows: [
    {
      rowIndex: 1,
      effective: '2026-08-23',
      discontinue: '2026-08-23',
      airline: 'VN',
      aircraft: '321',
      daysOfWeek: [false, false, false, false, false, false, true],
      std: '06:00',
      depFlight: '101',
      depRoute: 'SGN',
      depFlightCategory: 'J',
      depIntDomInd: 'D',
    },
    {
      rowIndex: 2,
      effective: '2026-08-24',
      discontinue: '2026-08-24',
      airline: 'VN',
      aircraft: '321',
      daysOfWeek: [true, false, false, false, false, false, false],
      sta: '07:00',
      arrFlight: '202',
      arrRoute: 'HAN',
      arrFlightCategory: 'J',
      arrIntDomInd: 'D',
    },
    {
      rowIndex: 3,
      effective: '2026-08-26',
      discontinue: '2026-08-26',
      airline: 'VN',
      aircraft: '321',
      daysOfWeek: [false, false, true, false, false, false, false],
      std: '10:00',
      depFlight: '404',
      depRoute: 'CXR',
      depFlightCategory: 'J',
      depIntDomInd: 'D',
    },
  ],
};

try {
  for (const source of sql) await db.exec(source);
  assert.deepEqual((await db.query(`select * from public.normalize_seasonal_flight_number_v2('VN','VN1A')`)).rows, [{ flight_number: 'VN001A', raw_flight_number: '001A' }]);
  await db.query(`insert into auth.users(id,email) values ($1,'repair@example.test')`, [userId]);
  await db.query(`insert into public.app_operators(user_id,email,username,display_name) values ($1,'repair@example.test','repair','Repair')`, [userId]);
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values ($1,'seasonal.read','allow'),($1,'seasonal.write','allow'),($1,'season.repair','allow'),($1,'daily.read','allow')`, [userId]);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',3,0,5)`, [seasonId]);
  await db.query(`
    insert into public.season_flight_records(
      season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status,action,pax
    ) values
      ($1,'OLD-SEASONAL','A','VN202','202','VN','HAN','07:00','2026-08-24','2026-08-24','07:00','2026-08-24','seasonal','ARR','active',null,100),
      ($1,'LIVE-DAILY','D','VN101','101','VN','SGN','06:00','2026-08-23','2026-08-23','06:00','2026-08-23','daily','DEP','active',null,120),
      ($1,'LIVE-MANUAL','D','VN303','303','VN','DAD','08:00','2026-08-25','2026-08-25','08:00','2026-08-25','manual','DEP','active','added',80)
  `, [seasonId]);
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields,gate) values ($1,'OLD-SEASONAL','modified',array['gate'],9)`, [seasonId]);
  await db.query(`
    insert into public.daily_schedule_import_batches(
      batch_id,request_id,contract_version,status,file_name,workbook_profile,raw_checksum,
      canonical_checksum,resource_policy_hash,diagnostics,preview,preview_hash,result,created_by,committed_at
    ) values ($1,'20000000-0000-4000-8000-000000000002',1,'committed','daily.xlsx','compact-lb',
      'raw','canonical','policy','[]','{}','preview','{}',$2,now())
  `, [dailyBatchId, userId]);
  await db.query(`
    insert into public.schedule_replacement_scopes(
      season_id,ops_date,authority_source,source_batch_id,expected_leg_count,
      canonical_checksum,data_version,committed_by
    ) values
      ($1,'2026-08-23','daily',$2,1,'daily-scope',5,$3),
      ($1,'2026-08-26','daily',$2,0,'daily-zero-scope',5,$3)
  `, [seasonId, dailyBatchId, userId]);
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);

  const stagedResult = await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [JSON.stringify(replacementPayload)]);
  const staged = stagedResult.rows[0].result;
  assert.equal(staged.status, 'validated', JSON.stringify(staged));
  assert.equal(staged.counts.removeImportedCount, 1, 'replace preview must count Seasonal rows only');
  assert.equal(staged.counts.clearStructuralOverlayCount, 0, 'replace preview must preserve operational overlays');
  assert.equal(staged.counts.preservedOverlayCount, 1);

  const committedResult = await db.query(`select public.commit_seasonal_import_v3($1,$2,$3) as result`, [staged.batchId, 5, staged.previewHash]);
  const committed = committedResult.rows[0].result;
  assert.equal(committed.status, 'committed');
  const oldSeasonal = await db.query(`select status,action,deletion_reason from public.season_flight_records where record_id='OLD-SEASONAL'`);
  assert.deepEqual(oldSeasonal.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'seasonal_rebuild' }]);

  const daily = await db.query(`select status,action,pax from public.season_flight_records where record_id='LIVE-DAILY'`);
  assert.deepEqual(daily.rows, [{ status: 'active', action: null, pax: 120 }]);
  const manual = await db.query(`select status,action,pax from public.season_flight_records where record_id='LIVE-MANUAL'`);
  assert.deepEqual(manual.rows, [{ status: 'active', action: 'added', pax: 80 }]);

  const protectedSeasonal = await db.query(`
    select status,action,deletion_reason
    from public.season_flight_records
    where season_id=$1 and source_kind='seasonal' and operational_date='2026-08-23'
      and source_import_batch_id=$2
  `, [seasonId, staged.batchId]);
  assert.deepEqual(protectedSeasonal.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'daily_authority' }]);
  const zeroFlightProtected = await db.query(`
    select status,action,deletion_reason
    from public.season_flight_records
    where season_id=$1 and source_kind='seasonal' and operational_date='2026-08-26'
      and source_import_batch_id=$2
  `, [seasonId, staged.batchId]);
  assert.deepEqual(zeroFlightProtected.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'daily_authority' }], 'zero-flight Daily authority must remain terminal during Seasonal Full Replace');

  const rebuilt = await db.query(`
    select records.record_id,mods.gate
    from public.canonical_active_flight_records_v1 records
    left join public.season_modifications mods on mods.leg_id=records.record_id
    where records.season_id=$1 and records.source_kind='seasonal' and records.operational_date='2026-08-24'
  `, [seasonId]);
  assert.equal(rebuilt.rows.length, 1);
  assert.equal(rebuilt.rows[0].gate, 9, 'unique Seasonal occurrence must retain the operational gate overlay');

  const effective = await db.query(`select source_kind,count(*)::integer as count,sum(pax)::integer as pax from reporting.canonical_effective_flight_legs where season_id=$1 group by source_kind order by source_kind`, [seasonId]);
  assert.deepEqual(effective.rows, [
    { source_kind: 'daily', count: 1, pax: 120 },
    { source_kind: 'manual', count: 1, pax: 80 },
    { source_kind: 'seasonal', count: 1, pax: null },
  ]);
  const scope = await db.query(`select ops_date::text,source_batch_id,expected_leg_count from public.schedule_replacement_scopes where season_id=$1 order by ops_date`, [seasonId]);
  assert.deepEqual(scope.rows, [
    { ops_date: '2026-08-23', source_batch_id: dailyBatchId, expected_leg_count: 1 },
    { ops_date: '2026-08-26', source_batch_id: dailyBatchId, expected_leg_count: 0 },
  ]);

  const mergePayload = {
    ...replacementPayload,
    requestId: '30000000-0000-4000-8000-000000000002',
    checksum: 'seasonal-authority-merge',
    strategy: 'merge',
    expectedDataVersion: 6,
    sourceRows: [replacementPayload.sourceRows[0]],
  };
  const mergeStageResult = await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [JSON.stringify(mergePayload)]);
  const mergeStage = mergeStageResult.rows[0].result;
  assert.equal(mergeStage.status, 'validated', JSON.stringify(mergeStage));
  await db.query(`select public.commit_seasonal_import_v3($1,$2,$3)`, [mergeStage.batchId, 6, mergeStage.previewHash]);
  const afterMerge = await db.query(`select record_id,source_kind,status,pax from public.canonical_active_flight_records_v1 where season_id=$1 order by record_id`, [seasonId]);
  assert.deepEqual(afterMerge.rows, [
    { record_id: 'LIVE-DAILY', source_kind: 'daily', status: 'active', pax: 120 },
    { record_id: 'LIVE-MANUAL', source_kind: 'manual', status: 'active', pax: 80 },
    { record_id: rebuilt.rows[0].record_id, source_kind: 'seasonal', status: 'active', pax: null },
  ].sort((left, right) => left.record_id.localeCompare(right.record_id)), 'Seasonal Merge must not mutate Daily or Manual live legs');
  const mergeProtected = await db.query(`select status,action,deletion_reason from public.season_flight_records where source_import_batch_id=$1`, [mergeStage.batchId]);
  assert.deepEqual(mergeProtected.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'daily_authority' }]);

  const version = async () => (await db.query('select data_version from public.seasons where id=$1', [seasonId])).rows[0].data_version;
  const importAgain = async (input) => {
    const expected = await version();
    const batch = (await db.query('select public.stage_seasonal_import_v3($1::jsonb) as result', [JSON.stringify({ ...input, expectedDataVersion: expected })])).rows[0].result;
    assert.equal(batch.status, 'validated', JSON.stringify(batch));
    const receipt = (await db.query('select public.commit_seasonal_import_v3($1,$2,$3) as result', [batch.batchId, expected, batch.previewHash])).rows[0].result;
    assert.equal(receipt.status, 'committed');
    return batch;
  };
  for (const suffix of ['003','004']) {
    await importAgain({ ...mergePayload, requestId: `30000000-0000-4000-8000-000000000${suffix}`, checksum: `repeat-${suffix}` });
  }
  assert.deepEqual((await db.query(`select record_id from public.canonical_active_flight_records_v1 where season_id=$1 and operational_date='2026-08-23'`, [seasonId])).rows, [{ record_id: 'LIVE-DAILY' }]);

  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [seasonId, JSON.stringify({ legId: rebuilt.rows[0].record_id, action: 'deleted', changedFields: [] })]);
  let tombstone = rebuilt.rows[0].record_id;
  for (const [suffix, strategy] of [['005','replace'], ['006','merge'], ['007','replace']]) {
    const imported = await importAgain({ ...replacementPayload, strategy, sourceRows: [replacementPayload.sourceRows[1]], requestId: `30000000-0000-4000-8000-000000000${suffix}`, checksum: `terminal-${suffix}` });
    const terminal = (await db.query(`select record_id,status,action,deletion_reason,supersedes_record_id from public.season_flight_records where source_import_batch_id=$1`, [imported.batchId])).rows;
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].status, 'deleted');
    assert.equal(terminal[0].deletion_reason, 'overlay_deleted');
    assert.equal(terminal[0].supersedes_record_id, tombstone);
    await assert.rejects(db.query(`select public.remove_canonical_season_modification_v1($1,$2)`, [seasonId, tombstone]), /cannot be restored|superseded|stale/i);
    tombstone = terminal[0].record_id;
  }
  await db.query(`select public.remove_canonical_season_modification_v1($1,$2)`, [seasonId, tombstone]);
  await importAgain({ ...replacementPayload, sourceRows: [replacementPayload.sourceRows[1]], requestId: '30000000-0000-4000-8000-000000000008', checksum: 'after-valid-undo' });
  assert.equal((await db.query(`select count(*)::int as n from public.canonical_active_flight_records_v1 where season_id=$1 and flight_number='VN202'`, [seasonId])).rows[0].n, 1, 'valid Undo must not inherit an older deleted overlay');

  // Snapshot excludes historical manual-added owners AND their children.
  await db.query(`insert into public.season_flight_records(season_id,record_id,type,flight_number,airline,date,source_kind,source_side,status,action)
    values ($1,'HISTORICAL-MANUAL','D','VN999','VN','2026-08-23','manual','DEP','deleted','deleted')`, [seasonId]);
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields,stand)
    values ($1,'HISTORICAL-MANUAL','added',array['addedLeg'],'20A'),($1,'LIVE-MANUAL','added',array['addedLeg'],'20A')`, [seasonId]);
  await db.query(`insert into public.season_modification_counters(leg_id,counter_group,item_index,counter_value)
    values ('HISTORICAL-MANUAL','counter',0,30),('LIVE-MANUAL','counter',0,31)`);
  const exportVersion = await version();
  await db.exec('set role authenticated');
  const snapshot = (await db.query(`select public.get_seasonal_export_snapshot_v2($1,$2) as result`, [seasonId, exportVersion])).rows[0].result;
  assert.equal(snapshot.totalCount, snapshot.flightRecords.length);
  assert.equal(snapshot.flightRecords.length, 3);
  assert.ok(snapshot.flightRecords.every(row => row.status === 'active' && row.action !== 'deleted'));
  assert.deepEqual(snapshot.modifications.map(row => row.leg_id), ['LIVE-MANUAL']);
  assert.equal(snapshot.modifications[0].stand, '20A');
  assert.deepEqual(snapshot.modificationCounters.map(row => row.leg_id), ['LIVE-MANUAL']);
  assert.deepEqual(snapshot.modificationAddedLegs, []);
  await assert.rejects(db.query(`select public.get_seasonal_export_snapshot_v2($1,$2)`, [seasonId, exportVersion - 1]), error => error.code === 'PT409');
  await db.exec('reset role');
  const duplicate = { ...replacementPayload, requestId: '30000000-0000-4000-8000-000000000009', expectedDataVersion: exportVersion,
    sourceRows: [replacementPayload.sourceRows[1], { ...replacementPayload.sourceRows[1], rowIndex: 12, sta: '12:00', arrRoute: 'SGN' }] };
  assert.equal((await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [JSON.stringify(duplicate)])).rows[0].result.status, 'failed');
  console.log(JSON.stringify({ suite: 'seasonal-rebuild-daily-authority', status: 'passed' }));
} finally {
  await db.close();
}
