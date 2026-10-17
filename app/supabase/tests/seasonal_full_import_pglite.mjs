// ============================================================================
// Behavioral Test Suite: seasonal_full_import_pglite.mjs
// Verifies full-file seasonal planning import:
//   - Full-file snapshot semantics only (no strategy selector)
//   - Obsolete merge strategy rejection (22023)
//   - Only 'seasonal.write' permission required for stage & commit (no 'season.repair')
//   - All absent active drafts (including independent manual drafts) tombstoned
//   - Resource preservation on matched flights (pax 0/null, gate, stand, counters, windows)
//   - Reciprocal pairs & overnight pair integrity
//   - Operations isolation (no writes to operations prior to explicit publish)
//   - Stale detection & idempotent stage/commit receipt replay
//   - Invalidation and rejection of legacy staged merge batch commits (40001)
//   - Publish + Restore roundtrip preservation
//   - Rollback cleanliness & reapply
// ============================================================================

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE, seasonalRow } from './seasonal_operational_separation_fixture.mjs';

let db;
try {
  const ctx = await buildM0Fixture();
  db = ctx.db;
  const { asWriter, asAdmin } = ctx;

  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const rpc = async (name, params, args) => (await row(`select public.${name}(${params}) r`, args)).r;
  const rejected = (fn, code) => assert.rejects(fn, e => {
    if (code && e.code !== code) {
      throw new Error(`Expected error code ${code}, got ${e.code}: ${e.message}`);
    }
    return true;
  });

  await asAdmin();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);

  const dates = await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 5)::text d1, ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 6)::text d2, ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 7)::text d3");

  const window = async (seasonId) => {
    await asWriter();
    try {
      return await rpc('get_seasonal_draft_window_v1', '$1', [seasonId]);
    } finally {
      await asSeasonalWriter();
    }
  };
  const draft = async (seasonId, flight, date) => (await window(seasonId)).drafts.find(d => d.flight_number === flight && d.date === date);

  // --------------------------------------------------------------------------
  // 1. Operator permissions: seasonal.write-only user (no season.repair)
  // --------------------------------------------------------------------------
  const writerOnlyId = randomUUID();
  await asAdmin();
  await db.query("insert into auth.users(id, email) values($1, 'writer-only@test.local')", [writerOnlyId]);
  await db.query("insert into public.app_operators(user_id, email, username, display_name) values($1, 'writer-only@test.local', 'writer_only', 'Writer Only')", [writerOnlyId]);
  await db.query("insert into public.app_operator_permission_overrides(user_id, permission_key, effect) values($1, 'seasonal.write', 'allow')", [writerOnlyId]);

  const asSeasonalWriter = async () => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [writerOnlyId]);
    await db.exec('set role authenticated');
  };

  const noPermId = randomUUID();
  await asAdmin();
  await db.query("insert into auth.users(id, email) values($1, 'no-perm@test.local')", [noPermId]);
  await db.query("insert into public.app_operators(user_id, email, username, display_name) values($1, 'no-perm@test.local', 'no_perm', 'No Perm')", [noPermId]);

  const asNoPerm = async () => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [noPermId]);
    await db.exec('set role authenticated');
  };

  // --------------------------------------------------------------------------
  // 2. Stage with no strategy selector succeeds with seasonal.write only
  // --------------------------------------------------------------------------
  await asSeasonalWriter();
  const req1 = randomUUID();
  const sourceRows1 = [
    seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '501', arrRoute: 'SGN', sta: '10:00' }),
    seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '501', arrRoute: 'SGN', sta: '10:00' }),
  ];

  const stageInput1 = {
    requestId: req1,
    checksum: req1,
    seasonCode: 'W50',
    expectedRevision: '0',
    fileName: 'full_import_1.xlsx',
    sourceRows: sourceRows1,
  };

  const staged1 = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify(stageInput1)]);
  assert.equal(staged1.status, 'validated', 'Staged successfully with seasonal.write only');
  assert.equal(staged1.preview.strategy, 'replace');
  assert.equal(staged1.preview.fullFileImport, true);
  assert.equal(staged1.counts.preservedOutsideScopeCount, 0, 'No drafts preserved outside file scope');
  assert.equal(staged1.counts.insertCount, 2);

  // Status and preview endpoints work with seasonal.write
  const status1 = await rpc('get_seasonal_draft_import_status_v1', '$1::uuid', [req1]);
  assert.equal(status1.batchId, staged1.batchId);
  const preview1 = await rpc('get_seasonal_draft_import_preview_v1', '$1::uuid, null, 10', [staged1.batchId]);
  assert.equal(preview1.entries.length, 2);
  assert.equal(preview1.stale, false);

  // User without seasonal.write rejected
  await asNoPerm();
  await rejected(() => rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({ ...stageInput1, requestId: randomUUID() })]), '42501');
  await rejected(() => rpc('get_seasonal_draft_import_status_v1', '$1::uuid', [req1]), '42501');
  await rejected(() => rpc('get_seasonal_draft_import_preview_v1', '$1::uuid, null, 10', [staged1.batchId]), '42501');
  await rejected(() => rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [staged1.batchId, staged1.previewHash]), '42501');

  // --------------------------------------------------------------------------
  // 3. Obsolete merge strategy rejected with 22023
  // --------------------------------------------------------------------------
  await asSeasonalWriter();
  await rejected(() => rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({ ...stageInput1, requestId: randomUUID(), strategy: 'merge' })
  ]), '22023');

  await rejected(() => rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({ ...stageInput1, requestId: randomUUID(), strategy: 'replace' })
  ]), '22023');

  await rejected(() => rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({ ...stageInput1, requestId: randomUUID(), strategy: 'unsupported_strat' })
  ]), '22023');

  // --------------------------------------------------------------------------
  // 4. Commit works with seasonal.write only; Operations isolated
  // --------------------------------------------------------------------------
  await asAdmin();
  const opsBefore = await rows('select to_jsonb(o) state from public.operational_flight_legs o order by leg_id');
  await asSeasonalWriter();

  const committed1 = await rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [staged1.batchId, staged1.previewHash]);
  assert.equal(committed1.status, 'committed');
  const seasonW50 = committed1.seasonId;

  // Operations table had zero writes during planning draft commit
  await asAdmin();
  const opsAfter = await rows('select to_jsonb(o) state from public.operational_flight_legs o order by leg_id');
  assert.deepEqual(opsAfter, opsBefore, 'Operational flight legs unchanged by draft import commit');

  // Verify drafts created
  await asSeasonalWriter();
  const w1 = await window(seasonW50);
  assert.equal(w1.drafts.length, 2);
  assert.ok(w1.drafts.every(d => d.flight_number === 'JX501'));

  // --------------------------------------------------------------------------
  // 5. LostACK / Idempotent stage & commit replay
  // --------------------------------------------------------------------------
  const replayedStage = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify(stageInput1)]);
  assert.equal(replayedStage.batchId, staged1.batchId, 'Replayed stage returns exact same batchId');

  const replayedCommit = await rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [staged1.batchId, staged1.previewHash]);
  assert.equal(replayedCommit.status, 'committed');
  assert.equal(replayedCommit.batchId, staged1.batchId, 'Replayed commit returns exact same committed receipt');

  // --------------------------------------------------------------------------
  // 6. Resources zero/null preservation on uniquely matched flight
  // --------------------------------------------------------------------------
  const flightD1 = await draft(seasonW50, 'JX501', dates.d1);
  assert.ok(flightD1);

  // Set allocations: pax=0, gate=null, stand='31', counters, windows
  const allocations = {
    pax: 0,
    gate: null,
    stand: '31',
    counters: [{ counter_group: 'A', item_index: 0, counter_value: '12' }],
    checkin_windows: [{ counter_key: '12', window_start: '07:30', window_end: '09:30' }],
  };

  const patchReq = randomUUID();
  await rpc('apply_seasonal_draft_changes_v1', '$1, $2::uuid, $3::bigint, $4::jsonb', [
    seasonW50, patchReq, w1.revision, JSON.stringify([{
      draftId: flightD1.draft_id,
      expected: { pax: flightD1.pax, gate: flightD1.gate, stand: flightD1.stand, counters: flightD1.counters, checkin_windows: flightD1.checkin_windows },
      patch: allocations,
    }])
  ]);

  const patchedFlight = await draft(seasonW50, 'JX501', dates.d1);
  assert.equal(patchedFlight.pax, 0);
  assert.equal(patchedFlight.gate, null);
  assert.equal(patchedFlight.stand, '31');
  assert.deepEqual(patchedFlight.counters, allocations.counters);
  assert.deepEqual(patchedFlight.checkin_windows, allocations.checkin_windows);

  // Re-import file with changed schedule (10:00 -> 11:30) for flight 501 on d1
  const wAfterPatch = await window(seasonW50);
  const req2 = randomUUID();
  const staged2 = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: req2,
    checksum: req2,
    seasonId: seasonW50,
    seasonCode: 'W50',
    expectedEpoch: wAfterPatch.epoch,
    expectedRevision: wAfterPatch.revision,
    fileName: 'full_import_2.xlsx',
    sourceRows: [
      seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '501', arrRoute: 'SGN', sta: '11:30' }),
      seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '501', arrRoute: 'SGN', sta: '10:00' }),
    ],
  })]);
  assert.equal(staged2.status, 'validated');
  assert.equal(staged2.counts.baselineUpdateCount, 1);
  assert.equal(staged2.counts.unchangedCount, 1);

  await rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [staged2.batchId, staged2.previewHash]);

  const reimportedFlight = await draft(seasonW50, 'JX501', dates.d1);
  assert.equal(reimportedFlight.schedule, '11:30', 'Schedule updated to 11:30');
  assert.equal(reimportedFlight.pax, 0, 'Pax 0 preserved');
  assert.equal(reimportedFlight.gate, null, 'Gate null preserved');
  assert.equal(reimportedFlight.stand, '31', 'Stand 31 preserved');
  assert.deepEqual(reimportedFlight.counters, allocations.counters, 'Counters preserved');
  assert.deepEqual(reimportedFlight.checkin_windows, allocations.checkin_windows, 'Checkin windows preserved');

  // --------------------------------------------------------------------------
  // 7. Manual absence removal: independent manual drafts tombstoned
  // --------------------------------------------------------------------------
  const wBeforeManual = await window(seasonW50);
  const manualDraftId = 'DRF_MANUAL_TEST_ABSENT';
  await rpc('apply_seasonal_draft_changes_v1', '$1, $2::uuid, $3::bigint, $4::jsonb', [
    seasonW50, randomUUID(), wBeforeManual.revision, JSON.stringify([{
      draftId: manualDraftId,
      expected: null,
      patch: {
        type: 'A',
        airline: 'VN',
        flight_number: 'VN999',
        route: 'HAN',
        date: dates.d3,
        schedule: '15:00',
        pax: 150,
      }
    }])
  ]);

  const wWithManual = await window(seasonW50);
  assert.ok(wWithManual.drafts.some(d => d.flight_number === 'VN999'), 'Manual draft active in workspace');

  // Now import a full file that only contains flight 501 on d1 and d2 (VN999 is absent)
  const req3 = randomUUID();
  const staged3 = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: req3,
    checksum: req3,
    seasonId: seasonW50,
    seasonCode: 'W50',
    expectedEpoch: wWithManual.epoch,
    expectedRevision: wWithManual.revision,
    fileName: 'full_import_3.xlsx',
    sourceRows: [
      seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '501', arrRoute: 'SGN', sta: '11:30' }),
      seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '501', arrRoute: 'SGN', sta: '10:00' }),
    ],
  })]);

  assert.equal(staged3.status, 'validated');
  assert.equal(staged3.counts.supersedeManualCount, 1, 'Manual absent draft counted in supersede/delete');

  await rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [staged3.batchId, staged3.previewHash]);

  const wAfterCommit3 = await window(seasonW50);
  assert.equal(wAfterCommit3.drafts.length, 2, 'Exactly 2 active drafts in season');
  assert.equal(wAfterCommit3.drafts.some(d => d.flight_number === 'VN999'), false, 'Absent manual draft is no longer active');

  // Verify the manual draft was tombstoned (soft-deleted), not hard-deleted
  await asAdmin();
  const tombstonedRow = await row("select * from public.seasonal_flight_drafts where draft_id = $1", [manualDraftId]);
  assert.ok(tombstonedRow, 'Tombstoned row exists in table');
  assert.equal(tombstonedRow.status, 'deleted');
  assert.equal(tombstonedRow.action, 'deleted');
  assert.equal(tombstonedRow.deletion_reason, 'draft_import_replaced');

  // --------------------------------------------------------------------------
  // 8. Reciprocal pairs & overnight pairs
  // --------------------------------------------------------------------------
  await asSeasonalWriter();
  const reqPair = randomUUID();
  const stagedPair = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: reqPair,
    checksum: reqPair,
    seasonCode: 'W51',
    expectedRevision: '0',
    fileName: 'overnight_pair.xlsx',
    sourceRows: [
      seasonalRow({
        rowIndex: 1,
        effective: dates.d1,
        discontinue: dates.d1,
        airline: 'VN',
        arrFlight: '101',
        arrRoute: 'HAN',
        sta: '23:30',
        depFlight: '102',
        depRoute: 'HAN',
        std: '01:00',
      })
    ],
  })]);

  assert.equal(stagedPair.status, 'validated');
  const committedPair = await rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [stagedPair.batchId, stagedPair.previewHash]);
  const seasonW51 = committedPair.seasonId;

  const pairDrafts = (await window(seasonW51)).drafts;
  assert.equal(pairDrafts.length, 2, '2 drafts created for overnight pair');
  const arrDraft = pairDrafts.find(d => d.type === 'A');
  const depDraft = pairDrafts.find(d => d.type === 'D');
  assert.equal(arrDraft.linked_draft_id, depDraft.draft_id);
  assert.equal(depDraft.linked_draft_id, arrDraft.draft_id);
  assert.equal(arrDraft.link_type, 'overnight');
  assert.equal(depDraft.link_type, 'overnight');
  assert.equal(arrDraft.date, dates.d1);
  assert.equal(depDraft.date, dates.d2);

  // --------------------------------------------------------------------------
  // 9. Stale workspace rejection on commit
  // --------------------------------------------------------------------------
  const wBeforeStale = await window(seasonW51);
  const reqStale = randomUUID();
  const stagedStale = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: reqStale,
    checksum: reqStale,
    seasonId: seasonW51,
    seasonCode: 'W51',
    expectedEpoch: wBeforeStale.epoch,
    expectedRevision: wBeforeStale.revision,
    fileName: 'stale_check.xlsx',
    sourceRows: [
      seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '101', arrRoute: 'HAN', sta: '23:00' })
    ],
  })]);
  assert.equal(stagedStale.status, 'validated');

  // Intervening mutation bumps revision
  await rpc('apply_seasonal_draft_changes_v1', '$1, $2::uuid, $3::bigint, $4::jsonb', [
    seasonW51, randomUUID(), wBeforeStale.revision, JSON.stringify([{
      draftId: arrDraft.draft_id,
      expected: { pax: arrDraft.pax },
      patch: { pax: 99 },
    }])
  ]);

  // Attempt to commit stale staged batch fails with 40001
  await rejected(() => rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [stagedStale.batchId, stagedStale.previewHash]), '40001');

  // --------------------------------------------------------------------------
  // 10. Rejection of legacy staged merge AND old-replace preview commits
  // --------------------------------------------------------------------------
  await asAdmin();
  const legacyBatchId = randomUUID();
  const legacyReqId = randomUUID();
  await db.query(`
    insert into public.season_import_batches (
      batch_id, request_id, season_id, season_code, file_name, checksum,
      contract_version, apply_strategy, status, preview, preview_hash,
      source_row_count, generated_record_count, created_by, expires_at
    ) values (
      $1, $2, $3, 'W51', 'legacy_merge.xlsx', 'leg-check',
      4, 'merge', 'validated', '{"valid": true}'::jsonb, 'legacy-hash',
      1, 1, $4, now() + interval '1 hour'
    )
  `, [legacyBatchId, legacyReqId, seasonW51, writerOnlyId]);

  await db.query(`
    insert into public.seasonal_draft_import_stages (
      batch_id, request_payload, target_season_id, draft_epoch, draft_revision, draft_checksum
    ) values (
      $1, '{"strategy":"merge"}'::jsonb, $2, (select epoch from public.seasonal_draft_workspace where season_id = $2),
      (select revision from public.seasonal_draft_workspace where season_id = $2), 'ck'
    )
  `, [legacyBatchId, seasonW51]);

  // Old replace batch without preview.fullFileImport = true
  const legacyReplaceBatchId = randomUUID();
  const legacyReplaceReqId = randomUUID();
  await db.query(`
    insert into public.season_import_batches (
      batch_id, request_id, season_id, season_code, file_name, checksum,
      contract_version, apply_strategy, status, preview, preview_hash,
      source_row_count, generated_record_count, created_by, expires_at
    ) values (
      $1, $2, $3, 'W51', 'legacy_replace.xlsx', 'leg-rep-check',
      4, 'replace', 'validated', '{"valid": true, "strategy": "replace"}'::jsonb, 'legacy-rep-hash',
      1, 1, $4, now() + interval '1 hour'
    )
  `, [legacyReplaceBatchId, legacyReplaceReqId, seasonW51, writerOnlyId]);

  await db.query(`
    insert into public.seasonal_draft_import_stages (
      batch_id, request_payload, target_season_id, draft_epoch, draft_revision, draft_checksum
    ) values (
      $1, '{"strategy":"replace"}'::jsonb, $2, (select epoch from public.seasonal_draft_workspace where season_id = $2),
      (select revision from public.seasonal_draft_workspace where season_id = $2), 'ck-rep'
    )
  `, [legacyReplaceBatchId, seasonW51]);

  await asSeasonalWriter();
  // Both legacy merge AND legacy replace lacking fullFileImport are rejected
  await rejected(() => rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [legacyBatchId, 'legacy-hash']), '40001');
  await rejected(() => rpc('commit_seasonal_draft_import_v1', '$1::uuid, $2', [legacyReplaceBatchId, 'legacy-rep-hash']), '40001');
  // --------------------------------------------------------------------------
  // 11. Publish + Restore roundtrip remains fully valid
  // --------------------------------------------------------------------------
  // Publish seasonW50 (currently has 2 active drafts of flight 501 on d1 and d2)
  await asWriter();
  const pubPreview = await rpc('preview_seasonal_publish_v1', '$1, $2::uuid', [seasonW50, randomUUID()]);
  assert.equal(pubPreview.status, 'ready');
  const pubReceipt = await rpc('commit_seasonal_publish_v1', '$1, $2::uuid, $3, $4, $5::boolean', [
    seasonW50, pubPreview.previewId, pubPreview.previewHash, 'Publish V1', false
  ]);
  assert.equal(pubReceipt.status, 'committed');
  const v1Id = pubReceipt.versionId;

  // Mutate draft in planning
  const wBeforeRestore = await window(seasonW50);
  const draftToMutate = wBeforeRestore.drafts[0];
  await rpc('apply_seasonal_draft_changes_v1', '$1, $2::uuid, $3::bigint, $4::jsonb', [
    seasonW50, randomUUID(), wBeforeRestore.revision, JSON.stringify([{
      draftId: draftToMutate.draft_id,
      expected: { route: draftToMutate.route },
      patch: { route: 'CXR' },
    }])
  ]);

  const mutatedDraft = await draft(seasonW50, draftToMutate.flight_number, draftToMutate.date);
  assert.equal(mutatedDraft.route, 'CXR');

  // Restore published version V1
  const wForRestore = await window(seasonW50);
  const restoreReceipt = await rpc('restore_seasonal_published_draft_v1', '$1, $2::uuid, $3::uuid, $4::bigint, $5::uuid', [
    seasonW50, v1Id, randomUUID(), wForRestore.revision, wForRestore.epoch
  ]);
  assert.equal(restoreReceipt.status, 'committed');

  // Verify draft restored to pre-mutation route
  const restoredDraft = await draft(seasonW50, draftToMutate.flight_number, draftToMutate.date);
  assert.equal(restoredDraft.route, 'SGN', 'Route restored to published V1 value');

  // --------------------------------------------------------------------------
  // 12. Rollback cleanliness & reapply
  // --------------------------------------------------------------------------
  await asAdmin();
  const migrationUrl = new URL('../migrations/20261016090000_seasonal_full_import_v1.sql', import.meta.url);
  const rollbackUrl = new URL('../migrations/20261016090000_seasonal_full_import_v1.rollback.sql', import.meta.url);

  // Apply rollback
  await db.exec(await readFile(rollbackUrl, 'utf8'));

  // Under rolled back M6 functions, strategy is required
  await asSeasonalWriter();
  await rejected(() => rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: randomUUID(),
    checksum: 'rollback-check',
    seasonCode: 'W99',
    expectedRevision: '0',
    fileName: 'rollback.xlsx',
    sourceRows: sourceRows1,
  })]), '22023');

  // Reapply migration
  await asAdmin();
  await db.exec(await readFile(migrationUrl, 'utf8'));

  // After reapply, strategy is again omitted and full-file import succeeds
  await asSeasonalWriter();
  for (const requestId of [legacyReqId, legacyReplaceReqId]) {
    const invalidated = await rpc('get_seasonal_draft_import_status_v1', '$1::uuid', [requestId]);
    assert.equal(invalidated.status, 'failed');
    assert.ok(invalidated.diagnostics.some(issue => issue.code === 'legacy-import-unsupported'));
  }
  const reapplyReq = randomUUID();
  const reapplyStage = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [JSON.stringify({
    requestId: reapplyReq,
    checksum: reapplyReq,
    seasonCode: 'W99',
    expectedRevision: '0',
    fileName: 'reapply.xlsx',
    sourceRows: sourceRows1,
  })]);
  assert.equal(reapplyStage.status, 'validated');
  assert.equal(reapplyStage.preview.fullFileImport, true);

  console.log('seasonal_full_import_pglite: All tests completed successfully.');
} finally {
  if (db) await db.close();
}
