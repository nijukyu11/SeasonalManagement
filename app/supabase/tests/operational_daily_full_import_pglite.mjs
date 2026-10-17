import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const { db, asWriter, asAdmin } = await buildM0Fixture();

const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 1;

const result = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (name, value) => (await result(`select public.${name}($1::jsonb) r`, [JSON.stringify(value)])).r;
const reject = (fn, code) => assert.rejects(fn, (e) => e.code === code);

const leg = (date, side = 'ARR', number = 'VN900', row = 1, resources = { pax: null, gate: 3, stand: '10' }) => ({
  operationalDate: date,
  scheduledDate: date,
  scheduledTime: '06:00:00',
  side,
  airline: 'VN',
  flightNumber: number,
  rawFlightNumber: number,
  route: 'HAN',
  aircraft: 'A321',
  category: 'C',
  sourceRowNumber: row,
  sheetName: 'AMS',
  resources,
});

const uploadPayload = (dates, zero = [], reqId = id(seq++)) => ({
  contractVersion: '2',
  requestId: reqId,
  fileName: 'daily_full_season.xlsx',
  workbookProfile: 'ams',
  rawChecksum: 'raw_full_season',
  canonicalChecksum: 'canonical_full_season',
  resourcePolicyHash: 'policy_v2',
  affectedDates: dates,
  confirmedZeroFlightDates: zero,
  diagnostics: [],
});

const activeLegs = async (date) => {
  await asAdmin();
  return (
    await db.query(
      `select * from public.operational_flight_legs where operational_date=$1 and status='active' order by side, flight_number`,
      [date]
    )
  ).rows;
};

const migrationUrl = new URL('../migrations/20261016100000_operational_daily_full_import_v2.sql', import.meta.url);
const rollbackUrl = new URL('../migrations/20261016100000_operational_daily_full_import_v2.rollback.sql', import.meta.url);

try {
  console.log('--- Step 0: Ensure M0 backfill & user setup ---');
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`, [M0_FIXTURE.writerId]);

  // Setup operator B for auth isolation tests
  const operatorBId = id(999);
  await asAdmin();
  await db.query(`insert into auth.users(id, email) values($1, 'daily-bulk-b@example.test') on conflict do nothing`, [operatorBId]);
  await db.query(
    `insert into public.app_operators(user_id, email, username, display_name)
     values($1, 'daily-bulk-b@example.test', 'daily-bulk-b', 'Operator B') on conflict do nothing`,
    [operatorBId]
  );
  await db.query(
    `insert into public.app_operator_permission_overrides(user_id, permission_key, effect)
     values($1, 'daily.write', 'allow') on conflict do nothing`,
    [operatorBId]
  );

  const asOperatorB = async () => {
    await db.exec('set role authenticated');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [operatorBId]);
  };

  // --------------------------------------------------------------------------
  // 1. Permission checks
  // --------------------------------------------------------------------------
  console.log('--- Step 1: Permission checks ---');
  await asAdmin();
  const operatorNoPermId = id(888);
  await db.query(`insert into auth.users(id, email) values($1, 'no-perm@example.test') on conflict do nothing`, [operatorNoPermId]);
  await db.query(
    `insert into public.app_operators(user_id, email, username, display_name)
     values($1, 'no-perm@example.test', 'no-perm', 'No Permission') on conflict do nothing`,
    [operatorNoPermId]
  );
  await db.exec('set role authenticated');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [operatorNoPermId]);

  const testDates = ['2030-05-01', '2030-05-02'];
  const testPayload1 = uploadPayload(testDates, [], id(seq++));

  await reject(
    () => db.query(`select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 1)`, [JSON.stringify(testPayload1)]),
    '42501'
  );

  // --------------------------------------------------------------------------
  // 2. Resumable Chunk Upload Lifecycle & Idempotency
  // --------------------------------------------------------------------------
  console.log('--- Step 2: Resumable chunk upload, retry & conflict rejection ---');
  await asWriter();

  const req1 = id(seq++);
  const payload1 = uploadPayload(['2030-05-01'], [], req1);
  const legChunk0 = [leg('2030-05-01', 'ARR', 'VN100', 1, { pax: 150, gate: 1, stand: '10' })];
  const legChunk1 = [leg('2030-05-01', 'DEP', 'VN101', 1, { pax: null, gate: 1, stand: '10' })];

  // Begin upload for 2 chunks, 2 legs
  const session1 = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 2) as r`,
      [JSON.stringify(payload1)]
    )
  ).rows[0].r;

  assert.equal(session1.status, 'uploading');
  assert.equal(session1.chunkCount, 2);
  assert.equal(session1.legCount, 2);
  assert.equal(session1.nextChunkIndex, 0);
  assert.equal(session1.receivedChunks, 0);

  // No operational mutations before finalize/commit
  assert.deepEqual(await activeLegs('2030-05-01'), [], 'No legs written during upload session begin');

  // Resume begin returns existing session and same nextChunkIndex
  const resumedSession1 = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 2) as r`,
      [JSON.stringify(payload1)]
    )
  ).rows[0].r;
  assert.deepEqual(resumedSession1, session1, 'Resuming begin with same requestId returns identical upload session');

  // Reusing same requestId with different parameter rejected
  await reject(
    () => db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 3, 2) as r`,
      [JSON.stringify(payload1)]
    ),
    '23505'
  );

  // Append chunk 0
  const appendChunk0 = (
    await db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(legChunk0)]
    )
  ).rows[0].r;
  assert.equal(appendChunk0.receivedChunks, 1);
  assert.equal(appendChunk0.nextChunkIndex, 1);

  // Calling begin again now reflects nextChunkIndex = 1
  const session1AfterChunk0 = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 2) as r`,
      [JSON.stringify(payload1)]
    )
  ).rows[0].r;
  assert.equal(session1AfterChunk0.nextChunkIndex, 1);
  assert.equal(session1AfterChunk0.receivedChunks, 1);

  // Retry append chunk 0 with identical content is idempotent
  const appendChunk0Retry = (
    await db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(legChunk0)]
    )
  ).rows[0].r;
  assert.equal(appendChunk0Retry.receivedChunks, 1);
  assert.equal(appendChunk0Retry.nextChunkIndex, 1);

  // Conflict: retry append chunk 0 with different content rejected
  const conflictingChunk0 = [leg('2030-05-01', 'ARR', 'VN999', 1)];
  await reject(
    () => db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(conflictingChunk0)]
    ),
    '23505'
  );

  // Out of range chunk index rejected
  await reject(
    () => db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 5, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(legChunk1)]
    ),
    '22023'
  );

  // Finalize incomplete upload rejected
  await reject(
    () => db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [session1.uploadId]),
    '22023'
  );

  // Auth isolation: Operator B cannot append or finalize session 1
  await asOperatorB();
  await reject(
    () => db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 1, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(legChunk1)]
    ),
    'P0002'
  );
  await reject(
    () => db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [session1.uploadId]),
    'P0002'
  );

  // Append chunk 1 as writer
  await asWriter();
  const appendChunk1 = (
    await db.query(
      `select public.append_daily_schedule_import_upload_v2($1::uuid, 1, $2::jsonb) as r`,
      [session1.uploadId, JSON.stringify(legChunk1)]
    )
  ).rows[0].r;
  assert.equal(appendChunk1.receivedChunks, 2);
  assert.equal(appendChunk1.nextChunkIndex, 2);

  // Still NO authority or operational mutations before finalize / commit
  assert.deepEqual(await activeLegs('2030-05-01'), []);
  const authBeforeCommit = (
    await db.query(`select * from public.operational_day_authority where operational_date='2030-05-01'`)
  ).rows;
  assert.equal(authBeforeCommit.length, 0, 'No authority created during chunk upload');

  // Finalize session 1
  const finalized1 = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [session1.uploadId])
  ).rows[0].r;

  assert.equal(finalized1.status, 'validated');
  assert.equal(finalized1.preview.valid, true);
  assert.equal(finalized1.preview.legCount, 2);
  assert.equal(finalized1.preview.replacedLegsCount, 0);
  assert.equal(finalized1.preview.replacedLegsTruncated, false);
  assert.deepEqual(finalized1.preview.affectedDates, ['2030-05-01']);

  // Idempotent finalize replay
  const finalized1Replay = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [session1.uploadId])
  ).rows[0].r;
  assert.deepEqual(finalized1Replay, finalized1, 'Finalize replay returns existing preview');

  // Still NO authority until commit!
  const authAfterFinalize = (
    await db.query(`select * from public.operational_day_authority where operational_date='2030-05-01'`)
  ).rows;
  assert.equal(authAfterFinalize.length, 0, 'No authority before commit');

  // Operator B cannot commit session 1
  await asOperatorB();
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [session1.uploadId, finalized1.previewHash]
    ),
    'P0002'
  );

  // Commit session 1 as writer
  await asWriter();
  const commitReceipt1 = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [session1.uploadId, finalized1.previewHash]
    )
  ).rows[0].r;

  assert.equal(commitReceipt1.status, 'committed');
  assert.equal(commitReceipt1.result.insertedCount, 2);

  // Commit retry is idempotent
  const commitRetry1 = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [session1.uploadId, finalized1.previewHash]
    )
  ).rows[0].r;
  assert.deepEqual(commitRetry1, commitReceipt1, 'Commit retry returns persisted receipt');

  // Verify legs and authority in DB
  const committedLegs1 = await activeLegs('2030-05-01');
  assert.equal(committedLegs1.length, 2);
  const arr1 = committedLegs1.find((l) => l.side === 'ARR');
  const dep1 = committedLegs1.find((l) => l.side === 'DEP');
  assert.equal(arr1.pax, 150);
  assert.equal(dep1.pax, null, 'NULL Pax preserved');
  assert.equal(arr1.linked_leg_id, dep1.leg_id, 'Same-day pair linked');
  assert.equal(dep1.linked_leg_id, arr1.leg_id);
  assert.equal(arr1.link_type, 'sameday');

  const authority1 = (
    await db.query(`select * from public.operational_day_authority where operational_date='2030-05-01'`)
  ).rows[0];
  assert.equal(authority1.leg_count, 2);
  assert.equal(authority1.authority_source, 'daily_import');

  // --------------------------------------------------------------------------
  // 3. Resource Overrides Preservation, Overnight Pair, Pax 0 vs NULL
  // --------------------------------------------------------------------------
  console.log('--- Step 3: Overrides preservation, overnight pairing, Pax 0/NULL ---');
  // Operator applies resource override to ARR leg (e.g. gate=99, stand='55')
  await asWriter();
  const allocSnapshot = (
    await result(`select public.get_operational_schedule_allocation_window_v1('2030-05-01', '2030-05-01') r`)
  ).r.snapshot;

  await result(
    `select public.apply_operational_resource_changes_v1($1::uuid, $2::bigint, $3::jsonb)`,
    [
      id(seq++),
      allocSnapshot.revision,
      JSON.stringify([
        {
          legId: arr1.leg_id,
          expected: { gate: arr1.gate, stand: arr1.stand, counters: [] },
          patch: { gate: 99, stand: '55', counters: [{ counter_group: 'T1', item_index: 0, counter_value: 'C99' }] },
        },
      ]),
    ]
  );

  // Now re-import next day overnight departure with pax=0
  const req2 = id(seq++);
  const payload2 = uploadPayload(['2030-05-01', '2030-05-02'], [], req2);
  const reimportArr = [
    {
      ...leg('2030-05-01', 'ARR', 'VN100', 1, { pax: 0, gate: 5, stand: '12' }),
      scheduledTime: '23:30:00',
    },
  ];
  const reimportDep = [
    {
      ...leg('2030-05-02', 'DEP', 'VN101', 1, { pax: 0, gate: 5, stand: '12' }),
      scheduledTime: '06:30:00',
    },
  ];

  const session2 = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 2) as r`,
      [JSON.stringify(payload2)]
    )
  ).rows[0].r;

  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [session2.uploadId, JSON.stringify(reimportArr)]
  );
  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 1, $2::jsonb)`,
    [session2.uploadId, JSON.stringify(reimportDep)]
  );

  const finalized2 = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [session2.uploadId])
  ).rows[0].r;

  assert.equal(finalized2.status, 'validated');
  assert.equal(finalized2.preview.rebaseCount, 1, 'Matched ARR leg rebased with operator overrides');

  const commitReceipt2 = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [session2.uploadId, finalized2.previewHash]
    )
  ).rows[0].r;
  assert.equal(commitReceipt2.status, 'committed');

  const legs2Day1 = await activeLegs('2030-05-01');
  const legs2Day2 = await activeLegs('2030-05-02');
  assert.equal(legs2Day1.length, 1);
  assert.equal(legs2Day2.length, 1);

  const newArr = legs2Day1[0];
  const newDep = legs2Day2[0];
  assert.equal(newArr.gate, 99, 'Explicit operator override gate=99 preserved');
  assert.equal(newArr.stand, '55', 'Explicit operator override stand=55 preserved');
  assert.equal(newArr.pax, 0, 'Incoming Pax 0 is preserved');
  assert.equal(newArr.linked_leg_id, newDep.leg_id, 'Overnight pair linked across dates');
  assert.equal(newDep.linked_leg_id, newArr.leg_id);
  assert.equal(newArr.link_type, 'overnight');
  assert.equal(newArr.lineage_id, arr1.lineage_id, 'Lineage ID preserved across rebase');
  assert.equal(Number(newArr.lineage_generation), 1);

  // --------------------------------------------------------------------------
  // 4. Zero-Flight Confirmation & Sparse Workbook
  // --------------------------------------------------------------------------
  console.log('--- Step 4: Zero-flight dates & sparse workbook ---');
  const zeroDay = '2030-05-01';
  const reqZero = id(seq++);
  const payloadZero = uploadPayload([zeroDay], [zeroDay], reqZero);

  // p_leg_count = 0, p_chunk_count = 0 -> direct finalize
  const sessionZero = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 0, 0) as r`,
      [JSON.stringify(payloadZero)]
    )
  ).rows[0].r;

  const finalizedZero = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [sessionZero.uploadId])
  ).rows[0].r;

  assert.equal(finalizedZero.status, 'validated');
  assert.equal(finalizedZero.preview.legCount, 0);

  const commitZero = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [sessionZero.uploadId, finalizedZero.previewHash]
    )
  ).rows[0].r;
  assert.equal(commitZero.status, 'committed');
  assert.deepEqual(await activeLegs(zeroDay), [], 'Confirmed zero date replaces all active legs');

  // Dangling survivor outside date (newDep on 2030-05-02) unlinked
  const survivorDep = (await activeLegs('2030-05-02'))[0];
  assert.equal(survivorDep.linked_leg_id, null, 'Dangling outside survivor unlinks safely');

  // --------------------------------------------------------------------------
  // 5. Stale Scope & Preview Invalidation
  // --------------------------------------------------------------------------
  console.log('--- Step 5: Stale scope & preview hash invalidation ---');
  const reqStale = id(seq++);
  const payloadStale = uploadPayload(['2030-05-02'], [], reqStale);
  const sessionStale = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 1, 1) as r`,
      [JSON.stringify(payloadStale)]
    )
  ).rows[0].r;

  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [sessionStale.uploadId, JSON.stringify([leg('2030-05-02', 'ARR', 'VN200', 1)])]
  );
  const finalizedStale = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [sessionStale.uploadId])
  ).rows[0].r;

  // Change underlying operational data before commit
  await asAdmin();
  await db.query(`update public.operational_flight_legs set pax=99 where leg_id=$1`, [survivorDep.leg_id]);

  await asWriter();
  // Commit must reject due to stale scope fingerprint
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [sessionStale.uploadId, finalizedStale.previewHash]
    ),
    'PT409'
  );

  // Preview hash mismatch rejected
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [sessionStale.uploadId, 'wrong_preview_hash']
    ),
    'PT409'
  );

  // --------------------------------------------------------------------------
  // 6. Expiry & Cancellation
  // --------------------------------------------------------------------------
  console.log('--- Step 6: Expiry & Cancellation ---');
  const reqCancel = id(seq++);
  const payloadCancel = uploadPayload(['2030-05-03'], [], reqCancel);
  const sessionCancel = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 1, 1) as r`,
      [JSON.stringify(payloadCancel)]
    )
  ).rows[0].r;
  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [sessionCancel.uploadId, JSON.stringify([leg('2030-05-03', 'ARR', 'VN300', 1)])]
  );
  const finalizedCancel = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [sessionCancel.uploadId])
  ).rows[0].r;

  const cancelled = (
    await db.query(`select public.cancel_daily_schedule_import_v2($1::uuid) as r`, [sessionCancel.uploadId])
  ).rows[0].r;
  assert.equal(cancelled.status, 'cancelled');
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [sessionCancel.uploadId, finalizedCancel.previewHash]
    ),
    'PT409'
  );

  // Expiry check
  const reqExp = id(seq++);
  const payloadExp = uploadPayload(['2030-05-04'], [], reqExp);
  const sessionExp = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 1, 1) as r`,
      [JSON.stringify(payloadExp)]
    )
  ).rows[0].r;
  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [sessionExp.uploadId, JSON.stringify([leg('2030-05-04', 'ARR', 'VN400', 1)])]
  );
  const finalizedExp = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [sessionExp.uploadId])
  ).rows[0].r;

  await asAdmin();
  await db.query(`update public.daily_schedule_import_batches set expires_at=now() - interval '1 minute' where batch_id=$1`, [sessionExp.uploadId]);
  await db.query(`update public.operational_daily_import_uploads set expires_at=now() - interval '1 minute' where upload_id=$1`, [sessionExp.uploadId]);

  await asWriter();
  const expStatus = (
    await db.query(`select public.get_daily_schedule_import_v2_status($1::uuid) as r`, [reqExp])
  ).rows[0].r;
  assert.equal(expStatus.status, 'expired');
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [sessionExp.uploadId, finalizedExp.previewHash]
    ),
    'PT409'
  );

  // --------------------------------------------------------------------------
  // 7. Small-Client V2 Stage RPC Backwards Compatibility
  // --------------------------------------------------------------------------
  console.log('--- Step 7: Small-client stage_daily_schedule_import_v2 backwards compatibility ---');
  const reqSmall = id(seq++);
  const smallPayload = {
    contractVersion: 2,
    requestId: reqSmall,
    fileName: 'small_test.xlsx',
    workbookProfile: 'ams',
    rawChecksum: 'raw_small',
    canonicalChecksum: 'canonical_small',
    resourcePolicyHash: 'policy_small',
    affectedDates: ['2030-05-05'],
    confirmedZeroFlightDates: [],
    diagnostics: [],
    legs: [
      leg('2030-05-05', 'ARR', 'VN500', 1, { pax: 200, gate: 12 }),
      leg('2030-05-05', 'DEP', 'VN501', 1, { pax: 190, gate: 12 }),
    ],
  };

  const smallResult = (
    await db.query(`select public.stage_daily_schedule_import_v2($1::jsonb) as r`, [JSON.stringify(smallPayload)])
  ).rows[0].r;

  assert.equal(smallResult.status, 'validated');
  assert.equal(smallResult.preview.legCount, 2);
  assert.equal(smallResult.preview.replacedLegsCount, 0);

  const smallReceipt = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [smallResult.batchId, smallResult.previewHash]
    )
  ).rows[0].r;
  assert.equal(smallReceipt.status, 'committed');
  assert.equal(smallReceipt.result.insertedCount, 2);

  // Verify committed batch never transitions to expired even after expires_at passes
  await asAdmin();
  await db.query(`update public.daily_schedule_import_batches set expires_at=now() - interval '10 minutes' where batch_id=$1`, [smallResult.batchId]);
  await db.query(`update public.operational_daily_import_uploads set expires_at=now() - interval '10 minutes' where upload_id=$1`, [smallResult.batchId]);
  await asWriter();
  const committedResume = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 1) as r`,
      [JSON.stringify(smallPayload)]
    )
  ).rows[0].r;
  assert.equal(committedResume.status, 'committed');
  const committedStatus = (
    await db.query(`select public.get_daily_schedule_import_v2_status($1::uuid) as r`, [reqSmall])
  ).rows[0].r;
  assert.equal(committedStatus.status, 'committed');
  const committedFinalize = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [smallResult.batchId])
  ).rows[0].r;
  assert.equal(committedFinalize.status, 'committed');

  // Test safe validation of invalid calendar dates (e.g. 2030-02-30) and bad times (99:99:99) without SQL error
  const reqBadSyntax = id(seq++);
  const badSyntaxPayload = uploadPayload(['2030-05-06'], [], reqBadSyntax);
  const sessionBad = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 1) as r`,
      [JSON.stringify(badSyntaxPayload)]
    )
  ).rows[0].r;
  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [
      sessionBad.uploadId,
      JSON.stringify([
        {
          ...leg('2030-05-06', 'ARR', 'VN991', 1),
          operationalDate: '2030-02-30', // calendar invalid
        },
        {
          ...leg('2030-05-06', 'DEP', 'VN992', 2),
          scheduledTime: '99:99:99', // time invalid
          resources: { gate: 'non-integer-gate' },
        },
      ]),
    ]
  );
  const finalizedBad = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [sessionBad.uploadId])
  ).rows[0].r;
  assert.equal(finalizedBad.status, 'failed');
  const badCodes = finalizedBad.diagnostics.map((d) => d.code);
  assert.ok(badCodes.includes('DAILY_INVALID_LEG'));
  // --------------------------------------------------------------------------
  // 8. Full-Season Scale Acceptance Test (>= 100k legs / 50k pairs)
  // --------------------------------------------------------------------------
  console.log('--- Step 8: Full-season scale acceptance (100k+ legs, 50k pairs over 180 days) ---');
  const scaleSeasonStart = '2031-04-01';
  const pairCount = 50000; // 50k pairs = 100k legs
  const dayCount = 180;
  const chunkSize = 10000; // 10 chunks of 10,000 legs each

  console.log(`Generating ${pairCount} pairs (100,000 legs) across ${dayCount} days...`);
  const affectedDatesSet = new Set();
  const allLegs = [];

  for (let i = 0; i < pairCount; i++) {
    const dayOffset = i % dayCount;
    const d = new Date('2031-04-01T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    affectedDatesSet.add(dateStr);

    const arrFlight = `VN${2 * i}`;
    const depFlight = `VN${2 * i + 1}`;
    const rowNum = i + 1;

    allLegs.push({
      operationalDate: dateStr,
      scheduledDate: dateStr,
      scheduledTime: '08:00:00',
      side: 'ARR',
      airline: 'VN',
      flightNumber: arrFlight,
      rawFlightNumber: arrFlight,
      route: 'SGN',
      aircraft: 'A321',
      category: 'C',
      sourceRowNumber: rowNum,
      sheetName: 'AMS',
      resources: { pax: i % 2 === 0 ? 150 : null, gate: (i % 30) + 1, stand: `${(i % 50) + 1}` },
    });

    allLegs.push({
      operationalDate: dateStr,
      scheduledDate: dateStr,
      scheduledTime: '10:00:00',
      side: 'DEP',
      airline: 'VN',
      flightNumber: depFlight,
      rawFlightNumber: depFlight,
      route: 'SGN',
      aircraft: 'A321',
      category: 'C',
      sourceRowNumber: rowNum,
      sheetName: 'AMS',
      resources: { pax: i % 2 === 0 ? 160 : 0, gate: (i % 30) + 1, stand: `${(i % 50) + 1}` },
    });
  }

  const scaleAffectedDates = Array.from(affectedDatesSet).sort();
  assert.equal(allLegs.length, 100000);
  assert.equal(scaleAffectedDates.length, dayCount);

  const totalChunks = Math.ceil(allLegs.length / chunkSize);
  const scaleReqId = id(seq++);
  const scalePayload = uploadPayload(scaleAffectedDates, [], scaleReqId);

  console.log(`Starting chunked upload session for 100k legs across ${totalChunks} chunks...`);
  const scaleSession = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, $2, $3) as r`,
      [JSON.stringify(scalePayload), allLegs.length, totalChunks]
    )
  ).rows[0].r;

  for (let c = 0; c < totalChunks; c++) {
    const chunkLegs = allLegs.slice(c * chunkSize, (c + 1) * chunkSize);
    const appendRes = (
      await db.query(
        `select public.append_daily_schedule_import_upload_v2($1::uuid, $2, $3::jsonb) as r`,
        [scaleSession.uploadId, c, JSON.stringify(chunkLegs)]
      )
    ).rows[0].r;
    assert.equal(appendRes.receivedChunks, c + 1);
  }

  console.log('Finalizing 100k legs bulk stage...');
  const t0Stage = Date.now();
  const scaleFinalized = (
    await db.query(
      `select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`,
      [scaleSession.uploadId]
    )
  ).rows[0].r;
  const stageDuration = Date.now() - t0Stage;
  console.log(`100k legs finalize completed in ${stageDuration}ms`);

  assert.equal(scaleFinalized.status, 'validated');
  assert.equal(scaleFinalized.preview.valid, true);
  assert.equal(scaleFinalized.preview.legCount, 100000);
  assert.equal(scaleFinalized.preview.affectedDates.length, 180);
  assert.equal(scaleFinalized.preview.replacedLegsTruncated, false);
  assert.equal(scaleFinalized.preview.replacedLegsCount, 0);

  console.log('Committing 100k legs bulk atomic import...');
  const t0Commit = Date.now();
  const scaleReceipt = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [scaleSession.uploadId, scaleFinalized.previewHash]
    )
  ).rows[0].r;
  const commitDuration = Date.now() - t0Commit;
  console.log(`100k legs commit completed in ${commitDuration}ms`);

  assert.equal(scaleReceipt.status, 'committed');
  assert.equal(scaleReceipt.result.insertedCount, 100000);
  assert.equal(scaleReceipt.result.affectedDates.length, 180);

  // Sample check: verify pairing & authority on sample date
  const sampleDate = scaleAffectedDates[0];
  const sampleLegs = await activeLegs(sampleDate);
  assert.ok(sampleLegs.length > 0);
  const sampleArr = sampleLegs.find((l) => l.side === 'ARR');
  const sampleDep = sampleLegs.find((l) => l.side === 'DEP' && l.source_row_number === sampleArr.source_row_number);
  assert.ok(sampleArr && sampleDep);
  assert.equal(sampleArr.linked_leg_id, sampleDep.leg_id);
  assert.equal(sampleDep.linked_leg_id, sampleArr.leg_id);
  assert.ok(sampleArr.turnaround_id.startsWith('TRN_DAILY_V2_'));

  const sampleAuthority = (
    await db.query(`select * from public.operational_day_authority where operational_date=$1`, [sampleDate])
  ).rows[0];
  assert.equal(sampleAuthority.leg_count, sampleLegs.length);

  // Assert capped preview (>200 legs) truncation metadata
  console.log('--- Testing capped preview (>200 replaced legs) and mid-commit failpoint rollback ---');
  const reqTrunc = id(seq++);
  const truncPayload = uploadPayload([sampleDate], [], reqTrunc);
  const truncSession = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 2, 1) as r`,
      [JSON.stringify(truncPayload)]
    )
  ).rows[0].r;
  await db.query(
    `select public.append_daily_schedule_import_upload_v2($1::uuid, 0, $2::jsonb)`,
    [
      truncSession.uploadId,
      JSON.stringify([
        leg(sampleDate, 'ARR', 'VN_NEW1', 1, { pax: 180, gate: 1 }),
        leg(sampleDate, 'DEP', 'VN_NEW2', 1, { pax: 170, gate: 1 }),
      ]),
    ]
  );
  const truncFinalized = (
    await db.query(`select public.finalize_daily_schedule_import_upload_v2($1::uuid) as r`, [truncSession.uploadId])
  ).rows[0].r;
  assert.equal(truncFinalized.status, 'validated');
  assert.equal(truncFinalized.preview.replacedLegsTruncated, true);
  assert.equal(truncFinalized.preview.replacedLegs.length, 200);
  assert.equal(truncFinalized.preview.replacedLegsCount, sampleLegs.length);
  assert.ok(truncFinalized.preview.replacedLegsCount > 200);

  // Mid-commit failure rollback: install temporary failpoint trigger on operational_flight_legs
  const baselineLegsJson = JSON.stringify(await activeLegs(sampleDate));
  const baselineAuthJson = JSON.stringify(
    (await db.query(`select * from public.operational_day_authority where operational_date=$1`, [sampleDate])).rows[0]
  );
  const baselineBatchJson = JSON.stringify(
    (await db.query(`select status, preview_hash, committed_at from public.daily_schedule_import_batches where batch_id=$1`, [truncSession.uploadId])).rows[0]
  );

  await asAdmin();
  await db.exec(`
    create or replace function pg_temp.fail_on_inserted_leg() returns trigger as $$
    begin
      if new.flight_number = 'VN_NEW1' then
        raise exception 'Injected failpoint trigger mid-commit' using errcode = 'P0001';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger test_mid_commit_failpoint
    before insert on public.operational_flight_legs
    for each row execute function pg_temp.fail_on_inserted_leg();
  `);

  await asWriter();
  await reject(
    () => db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [truncSession.uploadId, truncFinalized.previewHash]
    ),
    'P0001'
  );

  // Assert all old active legs, authority row, and batch status remain completely byte-equivalent
  const postAbortLegsJson = JSON.stringify(await activeLegs(sampleDate));
  const postAbortAuthJson = JSON.stringify(
    (await db.query(`select * from public.operational_day_authority where operational_date=$1`, [sampleDate])).rows[0]
  );
  const postAbortBatchJson = JSON.stringify(
    (await db.query(`select status, preview_hash, committed_at from public.daily_schedule_import_batches where batch_id=$1`, [truncSession.uploadId])).rows[0]
  );
  assert.equal(postAbortLegsJson, baselineLegsJson);
  assert.equal(postAbortAuthJson, baselineAuthJson);
  assert.equal(postAbortBatchJson, baselineBatchJson);

  // Remove temporary trigger, now same batch commits successfully once
  await asAdmin();
  await db.exec(`drop trigger test_mid_commit_failpoint on public.operational_flight_legs;`);

  await asWriter();
  const retryReceipt = (
    await db.query(
      `select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`,
      [truncSession.uploadId, truncFinalized.previewHash]
    )
  ).rows[0].r;
  assert.equal(retryReceipt.status, 'committed');
  assert.equal(retryReceipt.result.insertedCount, 2);
  assert.equal(retryReceipt.result.replacedCount, sampleLegs.length);

  const postCommitLegs = await activeLegs(sampleDate);
  assert.equal(postCommitLegs.length, 2);
  assert.equal(postCommitLegs.filter((l) => l.status === 'active').length, 2);
  // --------------------------------------------------------------------------
  // 9. Rollback Guard & Clean Reapply
  // --------------------------------------------------------------------------
  console.log('--- Step 9: Rollback safety guard & clean reapply ---');
  // While upload tables are populated, rollback must refuse with 55000
  await asAdmin();
  await reject(
    async () => {
      await db.exec(await readFile(rollbackUrl, 'utf8'));
    },
    '55000'
  );
  await db.exec('rollback');

  // Clean disposable upload staging rows to test clean rollback
  await db.query('delete from public.operational_daily_import_upload_chunks');
  await db.query('delete from public.operational_daily_import_uploads');

  // Rollback cleanly drops the new upload tables and restores prior RPCs
  await db.exec(await readFile(rollbackUrl, 'utf8'));

  // Under rolled back M5, begin_daily_schedule_import_upload_v2 does not exist
  await asWriter();
  await reject(
    () => db.query(`select public.begin_daily_schedule_import_upload_v2($1::jsonb, 1, 1)`, [JSON.stringify(payload1)]),
    '42883' // undefined function
  );

  // Re-apply migration
  await asAdmin();
  await db.exec(await readFile(migrationUrl, 'utf8'));

  // After re-apply, begin_daily_schedule_import_upload_v2 is restored
  await asWriter();
  const reapplyBegin = (
    await db.query(
      `select public.begin_daily_schedule_import_upload_v2($1::jsonb, 1, 1) as r`,
      [JSON.stringify(uploadPayload(['2030-05-10'], [], id(seq++)))]
    )
  ).rows[0].r;
  assert.equal(reapplyBegin.status, 'uploading');

  console.log('ALL TESTS PASSED: Daily Full Import V2 chunked upload, resumability, bulk 100k legs, invariants, auth, rollback.');
} finally {
  await db.close();
}
