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
  '../migrations/20260831010000_fix_daily_multiseason_event_identity.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260829180000_daily_authority_reset.sql',
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
];
const sql = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
const db = await createSupabasePGlite();
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seasonId = 'season-daily-canonical';

function payload(requestId, expectedDataVersion, gate = 1, pax = 123) {
  const leg = {
    sourceRowNumber: 1,
    sheetName: 'Daily',
    side: 'DEP',
    seasonCode: 'S26',
    operationalDate: '2026-08-23',
    scheduledDate: '2026-08-23',
    scheduledTime: '06:00',
    airline: 'VN',
    flightNumber: 'VN101',
    rawFlightNumber: '101',
    route: 'SGN',
    aircraft: '321',
    category: 'J',
    flightType: 'PAX',
    requestStatusCode: null,
    resources: {
      route: 'SGN',
      schedule: '06:00',
      stand: '20A',
      gate,
      counter: '30,M1',
      pax,
    },
    rawResourceTokens: { stand: 'Stand20A', gate: `G${gate}`, counter: 'C30 M1', carousel: null },
    occurrenceKey: 'S26|2026-08-23|DEP|VN|VN101|SGN|06:00',
    looseOccurrenceKey: 'S26|2026-08-23|DEP|VN|VN101',
  };
  return {
    contractVersion: 1,
    requestId,
    fileName: 'LB_20260823_20260827.xlsx',
    workbookProfile: 'compact-lb',
    rawChecksum: `raw-${requestId}`,
    canonicalChecksum: `canonical-${requestId}`,
    resourcePolicyHash: 'policy-v1',
    legs: [leg],
    diagnostics: [],
    seasons: [{
      seasonId,
      seasonCode: 'S26',
      expectedDataVersion,
      rangeStart: '2026-08-23',
      rangeEnd: '2026-08-23',
      affectedDates: ['2026-08-23'],
      confirmedZeroFlightDates: [],
      legCount: 1,
    }],
  };
}

async function stage(input) {
  const result = await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(input)]);
  return result.rows[0].result;
}

async function commit(staged, expectedDataVersion) {
  const result = await db.query(
    `select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`,
    [staged.batchId, JSON.stringify({ [seasonId]: expectedDataVersion }), staged.previewHash],
  );
  return result.rows[0].result;
}

try {
  for (const source of sql) await db.exec(source);
  await db.query(`insert into auth.users(id,email) values ($1,'daily@example.test')`, [userId]);
  await db.query(`insert into public.app_operators(user_id,email,username,display_name) values ($1,'daily@example.test','daily','Daily')`, [userId]);
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values ($1,'daily.write','allow'),($1,'daily.read','allow'),($1,'seasonal.read','allow'),($1,'season.repair','allow')`, [userId]);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',1,1,3)`, [seasonId]);
  await db.query(`
    insert into public.season_flight_records(
      season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status,pax
    ) values ($1,'BASE-1','D','VN101','101','VN','HAN','05:00','2026-08-23',
      '2026-08-23','05:00','2026-08-23','seasonal','DEP','active',99)
  `, [seasonId]);
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields,gate) values ($1,'BASE-1','modified',array['gate'],9)`, [seasonId]);
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);

  await assert.rejects(
    stage(payload('10000000-0000-4000-8000-000000000100', 2)),
    (error) => error?.code === 'PT409',
    'a stale Daily stage must return an HTTP conflict code that PostgREST will not retry',
  );

  const staged = await stage(payload('10000000-0000-4000-8000-000000000101', 3));
  assert.equal(staged.status, 'validated');
  assert.deepEqual(staged.preview.seasons[0].counts, {
    afterCount: 1,
    afterPax: 123,
    afterPaxKnownCount: 1,
    beforeCount: 1,
    beforePax: 99,
    beforePaxKnownCount: 1,
    dailyBeforeCount: 0,
    effectiveAfterCount: 1,
    effectiveAfterPax: 123,
    effectiveAfterPaxKnownCount: 1,
    insertedCount: 1,
    manualBeforeCount: 0,
    matchedCount: 1,
    overlayCandidateCount: 1,
    overlayRebaseCount: 1,
    seasonalBeforeCount: 1,
  });

  const receipt = await commit(staged, 3);
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.seasons[0].deletedCount, 1);
  assert.equal(receipt.seasons[0].insertedCount, 1);
  assert.equal(receipt.seasons[0].beforePax, 99);
  assert.equal(receipt.seasons[0].afterPax, 123);

  const base = await db.query(`select status,action,deletion_reason,superseded_by_batch_id from public.season_flight_records where record_id='BASE-1'`);
  assert.deepEqual(base.rows, [{
    status: 'deleted',
    action: 'deleted',
    deletion_reason: 'daily_replacement',
    superseded_by_batch_id: staged.batchId,
  }]);
  const active = await db.query(`select record_id,source_kind,pax,gate,stand,source_import_batch_id,supersedes_record_id from public.canonical_active_flight_records_v1 where season_id=$1`, [seasonId]);
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].source_kind, 'daily');
  assert.equal(active.rows[0].pax, 123);
  assert.equal(active.rows[0].gate, 1);
  assert.equal(active.rows[0].stand, '20A');
  assert.equal(active.rows[0].source_import_batch_id, staged.batchId);
  assert.equal(active.rows[0].supersedes_record_id, 'BASE-1');
  const canonicalRecordId = active.rows[0].record_id;
  const rebased = await db.query(`select action,changed_fields,gate from public.season_modifications where leg_id=$1`, [canonicalRecordId]);
  assert.deepEqual(rebased.rows, [{ action: 'modified', changed_fields: ['gate'], gate: 9 }]);
  const reporting = await db.query(`select pax,gate,stand from reporting.effective_flight_operations where season_id=$1 and ops_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(reporting.rows, [{ pax: 123, gate: 9, stand: '20A' }]);
  const pointerCount = await db.query(`select count(*)::integer as count from public.daily_schedule_active_days where season_id=$1`, [seasonId]);
  assert.equal(pointerCount.rows[0].count, 0, 'canonical commit must not mutate the legacy active-day pointer');
  const scope = await db.query(`select expected_leg_count,data_version,source_batch_id from public.schedule_replacement_scopes where season_id=$1 and ops_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(scope.rows, [{ expected_leg_count: 1, data_version: 4, source_batch_id: staged.batchId }]);
  assert.deepEqual(await commit(staged, 3), receipt, 'commit recovery must return the durable receipt');

  const replacement = await stage(payload('10000000-0000-4000-8000-000000000102', 4, 2, 125));
  assert.equal(replacement.preview.seasons[0].counts.dailyBeforeCount, 1);
  const replacementReceipt = await commit(replacement, 4);
  assert.equal(replacementReceipt.seasons[0].deletedCount, 1);
  const replacementActive = await db.query(`select record_id,pax,gate,supersedes_record_id from public.canonical_active_flight_records_v1 where season_id=$1`, [seasonId]);
  assert.equal(replacementActive.rows.length, 1);
  assert.equal(replacementActive.rows[0].pax, 125);
  assert.equal(replacementActive.rows[0].gate, 2);
  assert.equal(replacementActive.rows[0].supersedes_record_id, canonicalRecordId);
  const replacementEffective = await db.query(`select pax,gate from reporting.effective_flight_operations where season_id=$1 and ops_date='2026-08-23'`, [seasonId]);
  assert.deepEqual(replacementEffective.rows, [{ pax: 125, gate: 9 }], 'operational gate overlay must rebase while Pax remains Daily authority');

  for (const [index, failpoint] of ['after_delete', 'after_insert', 'before_audit'].entries()) {
    const failed = await stage(payload(`10000000-0000-4000-8000-00000000011${index}`, 5, 3 + index, 130 + index));
    await db.exec(`select set_config('app.test_daily_canonical_failpoint','${failpoint}',false)`);
    await assert.rejects(commit(failed, 5), new RegExp(`injected Daily canonical failure ${failpoint.replace('_', ' ')}`));
    await db.exec(`select set_config('app.test_daily_canonical_failpoint','',false)`);
    const afterFailure = await db.query(`select record_id,pax,gate from public.canonical_active_flight_records_v1 where season_id=$1`, [seasonId]);
    assert.deepEqual(afterFailure.rows, replacementActive.rows.map(({ record_id, pax, gate }) => ({ record_id, pax, gate })));
    const version = await db.query(`select data_version from public.seasons where id=$1`, [seasonId]);
    assert.equal(version.rows[0].data_version, 5);
    const batch = await db.query(`select status from public.daily_schedule_import_batches where batch_id=$1`, [failed.batchId]);
    assert.equal(batch.rows[0].status, 'validated');
  }

  await db.query(`
    insert into public.season_flight_records(
      season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,status,pax
    ) values ($1,'BASE-ZERO-DAY','D','VN999','999','VN','HAN','07:00','2026-08-24',
      '2026-08-24','07:00','2026-08-24','seasonal','DEP','active',10)
  `, [seasonId]);
  const zeroDayPayload = payload('10000000-0000-4000-8000-000000000120', 5, 4, 140);
  zeroDayPayload.seasons[0].rangeEnd = '2026-08-24';
  zeroDayPayload.seasons[0].affectedDates = ['2026-08-23', '2026-08-24'];
  zeroDayPayload.seasons[0].confirmedZeroFlightDates = ['2026-08-24'];
  const zeroDayStage = await stage(zeroDayPayload);
  assert.equal(zeroDayStage.status, 'validated');
  assert.deepEqual(zeroDayStage.preview.seasons[0].confirmedZeroFlightDates, ['2026-08-24']);
  await commit(zeroDayStage, 5);
  const zeroDayActive = await db.query(`select count(*)::integer as count from public.canonical_active_flight_records_v1 where season_id=$1 and operational_date='2026-08-24'`, [seasonId]);
  assert.equal(zeroDayActive.rows[0].count, 0);
  const zeroDayScope = await db.query(`select expected_leg_count from public.schedule_replacement_scopes where season_id=$1 and ops_date='2026-08-24'`, [seasonId]);
  assert.deepEqual(zeroDayScope.rows, [{ expected_leg_count: 0 }]);

  const resetPreviewResult = await db.query(
    `select public.preview_daily_authority_reset_v1($1,array['2026-08-23','2026-08-24']::date[],6) as result`,
    [seasonId],
  );
  const resetPreview = resetPreviewResult.rows[0].result;
  assert.equal(resetPreview.currentDailyCount, 1);
  assert.equal(resetPreview.preimageCount, 2);
  const resetRequestId = '10000000-0000-4000-8000-000000000121';
  await assert.rejects(
    db.query(`select public.reset_daily_authority_v1($1,$2,array['2026-08-23','2026-08-24']::date[],6,'WRONG','Operational rollback test')`, [resetRequestId, seasonId]),
    /confirmation does not match preview/,
  );
  const stillDaily = await db.query(`select count(*)::integer as count from public.canonical_active_flight_records_v1 where season_id=$1 and source_kind='daily' and source_import_batch_id=$2`, [seasonId, zeroDayStage.batchId]);
  assert.equal(stillDaily.rows[0].count, 1, 'failed reset must rollback the complete preimage');
  const resetResult = await db.query(
    `select public.reset_daily_authority_v1($1,$2,array['2026-08-23','2026-08-24']::date[],6,$3,'Operational rollback test') as result`,
    [resetRequestId, seasonId, resetPreview.confirmationText],
  );
  assert.equal(resetResult.rows[0].result.restoredPreimageCount, 2);
  const restored = await db.query(`select operational_date,source_kind,pax from public.canonical_active_flight_records_v1 where season_id=$1 order by operational_date`, [seasonId]);
  assert.deepEqual(restored.rows, [
    { operational_date: '2026-08-23', source_kind: 'daily', pax: 125 },
    { operational_date: '2026-08-24', source_kind: 'seasonal', pax: 10 },
  ]);
  const resetScopes = await db.query(`select count(*)::integer as count from public.schedule_replacement_scopes where season_id=$1 and reset_at is not null`, [seasonId]);
  assert.equal(resetScopes.rows[0].count, 2);
  const retryReset = await db.query(
    `select public.reset_daily_authority_v1($1,$2,array['2026-08-23','2026-08-24']::date[],6,$3,'Operational rollback test') as result`,
    [resetRequestId, seasonId, resetPreview.confirmationText],
  );
  assert.deepEqual(retryReset.rows[0].result, resetResult.rows[0].result);

  const deletedLineageSeason = 'season-daily-deleted-lineage';
  await db.query(`
    insert into public.seasons(
      id,season_code,name,file_name,uploaded_at,effective_start,effective_end,
      total_legs,total_source_rows,data_version
    ) values ($1,'S28','S28','',0,'2028-03-26','2028-10-28',0,0,0)
  `, [deletedLineageSeason]);
  await db.query(`
    insert into public.season_flight_records(
      season_id,record_id,type,flight_number,raw_flight_number,airline,route,schedule,
      date,scheduled_date,scheduled_time,operational_date,source_kind,source_side,
      status,action,deletion_reason,lifecycle_changed_at,source_import_batch_id,supersedes_record_id
    ) values
      ($1,'DELETED-BASE','D','VN888','888','VN','SGN','05:00','2028-04-01',
        '2028-04-01','05:00','2028-04-01','seasonal','DEP','deleted','deleted',
        'overlay_deleted','2028-04-01T00:00:00Z',null,null),
      ($1,'DELETED-DAILY-LATEST','D','VN888','888','VN','SGN','06:00','2028-04-01',
        '2028-04-01','06:00','2028-04-01','daily','DEP','deleted','deleted',
        'overlay_deleted','2028-04-02T00:00:00Z',$2,'DELETED-BASE')
  `, [deletedLineageSeason, replacement.batchId]);
  await db.query(`
    insert into public.season_modifications(season_id,leg_id,action,changed_fields)
    values ($1,'DELETED-BASE','deleted','{}'),($1,'DELETED-DAILY-LATEST','deleted','{}')
  `, [deletedLineageSeason]);
  await db.query(`
    insert into public.schedule_replacement_scopes(
      season_id,ops_date,authority_source,source_batch_id,expected_leg_count,
      canonical_checksum,data_version,committed_by
    ) values ($1,'2028-04-01','daily',$2,0,'deleted-lineage',0,$3)
  `, [deletedLineageSeason, replacement.batchId, userId]);
  const deletedLineagePayload = payload('10000000-0000-4000-8000-000000000125', 0, 5, 160);
  deletedLineagePayload.legs[0] = {
    ...deletedLineagePayload.legs[0],
    seasonCode: 'S28',
    operationalDate: '2028-04-01',
    scheduledDate: '2028-04-01',
    flightNumber: 'VN888',
    rawFlightNumber: '888',
    occurrenceKey: 'S28|2028-04-01|DEP|VN|VN888|SGN|06:00',
    looseOccurrenceKey: 'S28|2028-04-01|DEP|VN|VN888',
  };
  deletedLineagePayload.seasons = [{
    seasonId: deletedLineageSeason,
    seasonCode: 'S28',
    expectedDataVersion: 0,
    rangeStart: '2028-04-01',
    rangeEnd: '2028-04-01',
    affectedDates: ['2028-04-01'],
    confirmedZeroFlightDates: [],
    legCount: 1,
  }];
  const deletedLineageStage = await stage(deletedLineagePayload);
  assert.equal(deletedLineageStage.status, 'validated');
  assert.equal(deletedLineageStage.preview.seasons[0].counts.matchedCount, 1);
  assert.equal(deletedLineageStage.preview.seasons[0].counts.effectiveAfterCount, 0);
  const deletedLineageMatch = await db.query(`
    select matched_record_id from public.daily_schedule_import_batch_legs where batch_id=$1
  `, [deletedLineageStage.batchId]);
  assert.deepEqual(deletedLineageMatch.rows, [{ matched_record_id: 'DELETED-DAILY-LATEST' }]);

  const multiSeasonA = 'season-daily-multi-w26';
  const multiSeasonB = 'season-daily-multi-s27';
  await db.query(`
    insert into public.seasons(
      id,season_code,name,file_name,uploaded_at,effective_start,effective_end,
      total_legs,total_source_rows,data_version
    ) values
      ($1,'W26','W26','',0,'2026-10-25','2027-03-27',0,0,0),
      ($2,'S27','S27','',0,'2027-03-28','2027-10-30',0,0,0)
  `, [multiSeasonA, multiSeasonB]);
  const multiPayload = payload('10000000-0000-4000-8000-000000000130', 0, 5, 150);
  const firstMultiLeg = {
    ...multiPayload.legs[0],
    seasonCode: 'W26',
    operationalDate: '2026-11-01',
    scheduledDate: '2026-11-01',
    occurrenceKey: 'W26|2026-11-01|DEP|VN|VN101|SGN|06:00',
    looseOccurrenceKey: 'W26|2026-11-01|DEP|VN|VN101',
  };
  const secondMultiLeg = {
    ...multiPayload.legs[0],
    seasonCode: 'S27',
    operationalDate: '2027-04-01',
    scheduledDate: '2027-04-01',
    flightNumber: 'VN102',
    rawFlightNumber: '102',
    occurrenceKey: 'S27|2027-04-01|DEP|VN|VN102|SGN|06:00',
    looseOccurrenceKey: 'S27|2027-04-01|DEP|VN|VN102',
  };
  multiPayload.legs = [firstMultiLeg, secondMultiLeg];
  multiPayload.seasons = [
    {
      seasonId: multiSeasonA,
      seasonCode: 'W26',
      expectedDataVersion: 0,
      rangeStart: '2026-11-01',
      rangeEnd: '2026-11-01',
      affectedDates: ['2026-11-01'],
      confirmedZeroFlightDates: [],
      legCount: 1,
    },
    {
      seasonId: multiSeasonB,
      seasonCode: 'S27',
      expectedDataVersion: 0,
      rangeStart: '2027-04-01',
      rangeEnd: '2027-04-01',
      affectedDates: ['2027-04-01'],
      confirmedZeroFlightDates: [],
      legCount: 1,
    },
  ];
  const multiStage = await stage(multiPayload);
  const multiCommitResult = await db.query(
    `select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`,
    [multiStage.batchId, JSON.stringify({ [multiSeasonA]: 0, [multiSeasonB]: 0 }), multiStage.previewHash],
  );
  assert.equal(multiCommitResult.rows[0].result.status, 'committed');
  assert.equal(multiCommitResult.rows[0].result.seasons.length, 2);
  const multiEvents = await db.query(`
    select count(*)::integer as count, count(distinct op_id)::integer as distinct_op_ids
    from public.season_change_events
    where client_id='daily-canonical-v2' and op_payload->>'batchId'=$1
  `, [multiStage.batchId]);
  assert.deepEqual(multiEvents.rows, [{ count: 2, distinct_op_ids: 2 }]);

  console.log(JSON.stringify({ suite: 'daily-schedule-canonical-commit', status: 'passed' }));
} finally {
  await db.close();
}
