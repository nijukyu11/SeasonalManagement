import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE, seasonalRow } from './seasonal_operational_separation_fixture.mjs';

const { db, asWriter, asAdmin } = await buildM0Fixture();
const rpc = async (name, signature = '', args = []) =>
  (await db.query(`select public.${name}(${signature}) r`, args)).rows[0].r;
const count = async (table, key, id) => Number((await db.query(
  `select count(*) n from public.${table} where ${key}=$1`, [id])).rows[0].n);
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
const migration = new URL('../migrations/20261009110000_schedule_preview_lifecycle_v1.sql', import.meta.url);
const rollback = new URL('../migrations/20261009110000_schedule_preview_lifecycle_v1.rollback.sql', import.meta.url);
try {
  await asWriter();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);
  const date = (await db.query("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date+5)::text d")).rows[0].d;
  const sourceRows = [seasonalRow({ rowIndex: 1, effective: date, discontinue: date,
    arrFlight: '881', arrRoute: 'TPE', sta: '09:00', depFlight: '882', depRoute: 'TPE', std: '10:30' })];
  const initial = { requestId: randomUUID(), checksum: 'initial', seasonCode: 'W88',
    expectedRevision: '0', fileName: 'lifecycle.xlsx', sourceRows };
  const committedDraftStage = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify(initial)]);
  assert.equal(committedDraftStage.status, 'validated', JSON.stringify(committedDraftStage));
  const draftReceipt = await rpc('commit_seasonal_draft_import_v1', '$1::uuid,$2',
    [committedDraftStage.batchId, committedDraftStage.previewHash]);
  const season = draftReceipt.seasonId;
  const w = await rpc('get_seasonal_draft_window_v1', '$1', [season]);
  const draftInput = { ...initial, requestId: randomUUID(), seasonId: season, expectedEpoch: w.epoch,
    expectedRevision: w.revision, sourceRows: sourceRows.map(r => ({ ...r, sta: '09:15' })) };
  const expiredDraft = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify(draftInput)]);
  const freshDraft = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb',
    [JSON.stringify({ ...draftInput, requestId: randomUUID() })]);
  assert.equal(expiredDraft.status, 'validated');
  const committedPublish = await rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [season, randomUUID()]);
  const publishReceipt = await rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean',
    [season, committedPublish.previewId, committedPublish.previewHash, 'lifecycle', false]);
  const d = w.drafts[0];
  await rpc('apply_seasonal_draft_changes_v1', '$1,$2::uuid,$3::bigint,$4::jsonb',
    [season, randomUUID(), w.revision, JSON.stringify([{ draftId: d.draft_id, expected: { route: d.route }, patch: { route: 'DAD' } }])]);
  const expiredPublish = await rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [season, randomUUID()]);
  const freshPublish = await rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [season, randomUUID()]);
  const dailyInput = day => ({ contractVersion: 2, requestId: randomUUID(), fileName: 'daily.xlsx',
    workbookProfile: 'ams', rawChecksum: 'raw', canonicalChecksum: 'canonical', resourcePolicyHash: 'policy',
    affectedDates: [day], confirmedZeroFlightDates: [], diagnostics: [], legs: [{ operationalDate: day,
      scheduledDate: day, scheduledTime: '06:00', side: 'ARR', airline: 'VN', flightNumber: 'VN900',
      rawFlightNumber: 'VN900', route: 'HAN', aircraft: 'A321', category: 'C', sourceRowNumber: 1,
      sheetName: 'AMS', resources: { pax: 0, gate: 3 } }] });
  const expiredDailyInput = dailyInput('2030-04-01');
  const expiredDaily = await rpc('stage_daily_schedule_import_v2', '$1::jsonb', [JSON.stringify(expiredDailyInput)]);
  const freshDaily = await rpc('stage_daily_schedule_import_v2', '$1::jsonb', [JSON.stringify(dailyInput('2030-04-02'))]);
  const committedDaily = await rpc('stage_daily_schedule_import_v2', '$1::jsonb', [JSON.stringify(dailyInput('2030-04-03'))]);
  const dailyReceipt = await rpc('commit_daily_schedule_import_v2', '$1::uuid,$2', [committedDaily.batchId, committedDaily.previewHash]);
  await rejects(() => rpc('cleanup_expired_schedule_preview_entries_v1'), '42501');
  await asAdmin();
  // Deliberately expire both committed and uncommitted requests. Only the latter
  // are reclaimable; timestamps do not override receipt status.
  for (const [table, key, ids] of [
    ['season_import_batches', 'batch_id', [expiredDraft.batchId, committedDraftStage.batchId]],
    ['daily_schedule_import_batches', 'batch_id', [expiredDaily.batchId, committedDaily.batchId]],
    ['seasonal_publish_previews', 'preview_id', [expiredPublish.previewId, committedPublish.previewId]],
  ]) await db.query(`update public.${table} set expires_at=now()-interval '1 day' where ${key}=any($1::uuid[])`, [ids]);
  const before = (await db.query('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l')).rows[0].r;
  const result = await rpc('cleanup_expired_schedule_preview_entries_v1');
  assert.equal(result.dailyLegs, 1);
  assert.ok(result.draftEntries > 0);
  assert.ok(result.publishEntries > 0);
  assert.ok(result.operationalImpactEntries > 0);
  for (const [table, key, expired, fresh, committed] of [
    ['operational_daily_import_legs','batch_id',expiredDaily.batchId,freshDaily.batchId,committedDaily.batchId],
    ['seasonal_draft_import_entries','batch_id',expiredDraft.batchId,freshDraft.batchId,committedDraftStage.batchId],
    ['seasonal_publish_preview_entries','preview_id',expiredPublish.previewId,freshPublish.previewId,committedPublish.previewId],
    ['seasonal_publish_operational_impact_entries','preview_id',expiredPublish.previewId,freshPublish.previewId,committedPublish.previewId],
  ]) {
    assert.equal(await count(table,key,expired), 0, table);
    assert.ok(await count(table,key,fresh) > 0, `${table}: fresh remains`);
    assert.ok(await count(table,key,committed) > 0, `${table}: committed remains`);
  }
  assert.deepEqual(await rpc('cleanup_expired_schedule_preview_entries_v1'),
    { dailyLegs: 0, draftEntries: 0, publishEntries: 0, operationalImpactEntries: 0 });
  assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l')).rows[0].r, before);
  await asWriter();
  const dailyStatus = await rpc('get_daily_schedule_import_v2_status', '$1::uuid', [expiredDailyInput.requestId]);
  assert.equal(dailyStatus.batchId, expiredDaily.batchId);
  assert.equal(dailyStatus.previewHash, expiredDaily.previewHash);
  assert.deepEqual(await rpc('stage_daily_schedule_import_v2', '$1::jsonb', [JSON.stringify(expiredDailyInput)]), dailyStatus);
  await rejects(() => rpc('commit_daily_schedule_import_v2', '$1::uuid,$2', [expiredDaily.batchId, expiredDaily.previewHash]), 'PT409');
  const draftStatus = await rpc('get_seasonal_draft_import_status_v1', '$1::uuid', [draftInput.requestId]);
  assert.equal(draftStatus.batchId, expiredDraft.batchId);
  assert.equal(draftStatus.previewHash, expiredDraft.previewHash);
  const expiredPage = await rpc('get_seasonal_draft_import_preview_v1', '$1::uuid', [expiredDraft.batchId]);
  assert.equal(expiredPage.stale, true);
  await rejects(() => rpc('commit_seasonal_draft_import_v1', '$1::uuid,$2', [expiredDraft.batchId, expiredDraft.previewHash]), '40001');
  await rejects(() => rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean',
    [season, expiredPublish.previewId, expiredPublish.previewHash, '', true]), '40001');
  const dailyReplay = await rpc('commit_daily_schedule_import_v2', '$1::uuid,$2', [committedDaily.batchId, committedDaily.previewHash]);
  assert.deepEqual(dailyReplay.result, dailyReceipt.result);
  assert.equal(dailyReplay.previewHash, dailyReceipt.previewHash);
  const draftReplay = await rpc('commit_seasonal_draft_import_v1', '$1::uuid,$2', [committedDraftStage.batchId, committedDraftStage.previewHash]);
  assert.deepEqual(draftReplay.result, draftReceipt.result);
  assert.equal(draftReplay.previewHash, draftReceipt.previewHash);
  assert.deepEqual(await rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean',
    [season, committedPublish.previewId, committedPublish.previewHash, 'lifecycle', false]), publishReceipt);
  await asAdmin();
  await db.exec(await readFile(rollback, 'utf8'));
  await db.exec(await readFile(migration, 'utf8'));
  await db.exec(await readFile(migration, 'utf8'));
  assert.deepEqual(await rpc('cleanup_expired_schedule_preview_entries_v1'),
    { dailyLegs: 0, draftEntries: 0, publishEntries: 0, operationalImpactEntries: 0 });
  console.log('Preview lifecycle PASS: expired children reclaimed; fresh/committed children and lost-ACK receipts retained; stale commit rejected; permissions, reapply and rollback safe.');
} finally { await db.close(); }
