// ============================================================================
// Regression Test: seasonal_version_management_pglite.mjs
// Verifies native seasonal version management:
//   - get_seasonal_published_snapshot_page_v1
//   - get_seasonal_version_comparison_page_v1
//   - get_seasonal_published_export_snapshot_v1
//   - restore_seasonal_published_draft_v1
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
  const rpc = async (name, params, args) => (await row(`select public.${name}(${params}) r`, args)).r;
  const rejected = (fn, code) => assert.rejects(fn, (e) => e.code === code);

  // Migration chain is already applied by createSeasonalOperationalSeparationDb()

  await asWriter();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);

  const dates = await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date+5)::text d1,((now() at time zone 'Asia/Ho_Chi_Minh')::date+6)::text d2");

  // Stage and commit initial season with 3 flights
  const importRequestId = randomUUID();
  const imported = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({
      requestId: importRequestId,
      checksum: importRequestId,
      seasonCode: 'W88',
      expectedRevision: '0',
      fileName: 'version_mgmt.xlsx',
      sourceRows: [
        seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '881', arrRoute: 'TPE', sta: '09:00', depFlight: '882', depRoute: 'TPE', std: '10:30' }),
        seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '883', arrRoute: 'SGN', sta: '14:00' }),
      ],
    }),
  ]);
  assert.equal(imported.status, 'validated', JSON.stringify(imported));
  const commitImport = await rpc('commit_seasonal_draft_import_v1', '$1::uuid,$2', [imported.batchId, imported.previewHash]);
  const season = commitImport.seasonId;

  const window = () => rpc('get_seasonal_draft_window_v1', '$1', [season]);
  const preview = () => rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [season, randomUUID()]);
  const commitPublish = async (p, notes = '', ack = false) => {
    assert.equal(p?.status, 'ready', `Publish preview not ready: ${JSON.stringify(p)}`);
    return rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean', [season, p.previewId, p.previewHash, notes, ack]);
  };
  const patchDraft = async (d, values) =>
    rpc('apply_seasonal_draft_changes_v1', '$1,$2::uuid,$3::bigint,$4::jsonb', [
      season,
      randomUUID(),
      (await window()).revision,
      JSON.stringify([{ draftId: d.draft_id, expected: Object.fromEntries(Object.keys(values).map((k) => [k, d[k]])), patch: values }]),
    ]);

  // Add allocation / counters to a draft
  const initialWindow = await window();
  const flight1 = initialWindow.drafts.find((d) => d.flight_number === 'JX881');
  assert.ok(flight1, 'Flight JX881 exists');
  await patchDraft(flight1, {
    gate: 5,
    pax: 180,
    counters: [{ counter_group: 'T1', item_index: 0, counter_value: '15' }],
    checkin_windows: [{ counter_key: '15', window_start: '06:30', window_end: '08:30' }],
  });

  // --------------------------------------------------------------------------
  // Publish Version 1 (V1)
  // --------------------------------------------------------------------------
  const preview1 = await preview();
  assert.equal(preview1.status, 'ready');
  const receiptV1 = await commitPublish(preview1, 'Version 1 baseline');
  assert.equal(receiptV1.status, 'committed');
  const v1Id = receiptV1.versionId;
  const v1Tag = receiptV1.versionTag;

  // Read snapshot 1 details
  const v1SnapshotRecord = await row('select * from public.seasonal_publish_snapshots where version_id=$1', [v1Id]);
  assert.ok(v1SnapshotRecord, 'Snapshot V1 exists');
  const v1OriginalChecksum = v1SnapshotRecord.checksum;
  const v1OriginalPayload = v1SnapshotRecord.snapshot_payload;

  // --------------------------------------------------------------------------
  // Make edits and publish Version 2 (V2)
  // --------------------------------------------------------------------------
  const windowV1 = await window();
  const draftToModify = windowV1.drafts.find((d) => d.flight_number === 'JX883');
  assert.ok(draftToModify, 'Flight JX883 exists');
  await patchDraft(draftToModify, { pax: 220, route: 'DAD', schedule: '15:15' });

  const preview2 = await preview();
  const receiptV2 = await commitPublish(preview2, 'Version 2 schedule shift');
  const v2Id = receiptV2.versionId;

  // --------------------------------------------------------------------------
  // Make further edits and publish Version 3 (V3)
  // --------------------------------------------------------------------------
  const windowV2 = await window();
  const draftToAdd = {
    draftId: 'DRF_EXTRA_V3',
    expected: null,
    patch: {
      type: 'A',
      airline: 'VN',
      flight_number: 'VN991',
      date: dates.d1,
      schedule: '20:00',
      route: 'NRT',
      pax: 300,
    },
  };
  await rpc('apply_seasonal_draft_changes_v1', '$1,$2::uuid,$3::bigint,$4::jsonb', [
    season,
    randomUUID(),
    windowV2.revision,
    JSON.stringify([draftToAdd]),
  ]);

  const preview3 = await preview();
  const receiptV3 = await commitPublish(preview3, 'Version 3 added VN991');
  const v3Id = receiptV3.versionId;

  // --------------------------------------------------------------------------
  // 1. Behavior regression: old snapshot unchanged after new edits
  // --------------------------------------------------------------------------
  const v1SnapshotAfterNewPublishes = await row('select * from public.seasonal_publish_snapshots where version_id=$1', [v1Id]);
  assert.equal(v1SnapshotAfterNewPublishes.checksum, v1OriginalChecksum, 'Old snapshot checksum unchanged');
  assert.deepEqual(v1SnapshotAfterNewPublishes.snapshot_payload, v1OriginalPayload, 'Old snapshot payload byte-identical');

  // Also query through the new API: get_seasonal_published_snapshot_page_v1
  const v1PageAll = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid', [v1Id]);
  assert.equal(v1PageAll.versionId, v1Id);
  assert.equal(v1PageAll.seasonId, season);
  assert.equal(v1PageAll.checksum, v1OriginalChecksum);
  assert.equal(v1PageAll.totalCount, 3, 'V1 had 3 flights (JX881 arrival, JX882 departure, JX883 arrival)');
  assert.equal(v1PageAll.flights.length, 3);
  assert.equal(v1PageAll.hasMore, false);

  // --------------------------------------------------------------------------
  // 2. Snapshot Pagination: get_seasonal_published_snapshot_page_v1
  // --------------------------------------------------------------------------
  const page1 = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid,$2,$3::integer', [v1Id, null, 2]);
  assert.equal(page1.flights.length, 2);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextDraftId, 'nextDraftId is present on page 1');

  const page2 = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid,$2,$3::integer', [v1Id, page1.nextDraftId, 2]);
  assert.equal(page2.flights.length, 1);
  assert.equal(page2.hasMore, false);

  const combinedDraftIds = [...page1.flights.map((f) => f.draft_id), ...page2.flights.map((f) => f.draft_id)];
  assert.equal(new Set(combinedDraftIds).size, 3, 'Paging covered all 3 distinct flights');

  // Verify canonical SeasonalDraftRecord shape (snake_case)
  assert.ok(page1.flights[0].draft_id);
  assert.ok(page1.flights[0].flight_number);
  assert.ok(page1.flights[0].season_id);
  assert.ok(page1.flights[0].type);
  assert.ok(page1.flights[0].date);

  // --------------------------------------------------------------------------
  // 3. Arbitrary same-season version diff: get_seasonal_version_comparison_page_v1
  // --------------------------------------------------------------------------
  // Immediate diff: V1 -> V2
  const diffImmediate = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid', [v1Id, v2Id]);
  assert.ok(diffImmediate.entries.length >= 1, 'V1->V2 diff entries found');
  assert.ok(diffImmediate.entries.every((e) => e.version_id === v2Id));

  // Arbitrary diff: V1 -> V3 (skipping V2!)
  const diffArbitrary = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid', [v1Id, v3Id]);
  assert.ok(diffArbitrary.entries.length >= 2, 'Arbitrary V1->V3 diff contains modified and added flights');
  const addedInV3 = diffArbitrary.entries.find((e) => e.change_type === 'added');
  assert.ok(addedInV3, 'VN991 added between V1 and V3');
  assert.equal(addedInV3.flight_number, 'VN991');

  // Diff pagination
  const diffPage1 = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid,$3::bigint,$4::integer', [v1Id, v3Id, 0, 1]);
  assert.equal(diffPage1.entries.length, 1);
  if (diffArbitrary.entries.length > 1) {
    assert.equal(diffPage1.hasMore, true);
    assert.ok(diffPage1.nextIndex);
  }

  // Cross-season rejection
  const otherRequestId = randomUUID();
  const otherImport = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({
      requestId: otherRequestId,
      checksum: otherRequestId,
      seasonCode: 'W89',
      expectedRevision: '0',
      fileName: 'other_season.xlsx',
      sourceRows: [
        seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '777', arrRoute: 'HAN', sta: '18:00' }),
      ],
    }),
  ]);
  assert.equal(otherImport.status, 'validated');
  const otherCommit = await rpc('commit_seasonal_draft_import_v1', '$1::uuid,$2', [otherImport.batchId, otherImport.previewHash]);
  const otherSeason = otherCommit.seasonId;
  const otherPreview = await rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [otherSeason, randomUUID()]);
  assert.equal(otherPreview.status, 'ready', `Other preview not ready: ${JSON.stringify(otherPreview)}`);
  const otherVersion = await rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean', [otherSeason, otherPreview.previewId, otherPreview.previewHash, 'Other season V1', false]);
  assert.equal(otherVersion.status, 'committed');
  await rejected(
    () => rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid', [v1Id, otherVersion.versionId]),
    '22023'
  );
  // Unauthorized rejection
  await db.query('set role anon');
  await rejected(
    () => rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid', [v1Id, v3Id]),
    '42501'
  );
  await asWriter();

  // --------------------------------------------------------------------------
  // 4. Historical export parity: get_seasonal_published_export_snapshot_v1
  // --------------------------------------------------------------------------
  const exportV1 = await rpc('get_seasonal_published_export_snapshot_v1', '$1::uuid', [v1Id]);
  assert.equal(exportV1.seasonId, season);
  assert.equal(exportV1.versionId, v1Id);
  assert.equal(exportV1.versionTag, v1Tag);
  assert.equal(exportV1.totalCount, 3);
  assert.equal(exportV1.truncated, false);
  assert.equal(exportV1.flightRecords.length, 3);

  // Check 25-column mapping contract
  const record881 = exportV1.flightRecords.find((r) => r.flight_number === 'JX881');
  assert.ok(record881, 'Flight JX881 present in export');
  assert.equal(record881.record_id, flight1.draft_id);
  assert.equal(record881.gate, 5);
  assert.equal(record881.pax, 180);
  assert.equal(record881.route, 'TPE');
  assert.ok(record881.link_id !== undefined);
  assert.ok(record881.linked_record_id !== undefined);

  // Check counters and windows relational shape
  assert.ok(Array.isArray(exportV1.flightRecordCounters), 'flightRecordCounters is array');
  assert.ok(Array.isArray(exportV1.flightRecordWindows), 'flightRecordWindows is array');
  const counter881 = exportV1.flightRecordCounters.find((c) => c.record_id === flight1.draft_id);
  assert.ok(counter881, 'Counter for JX881 included');
  assert.equal(counter881.counter_value, '15');
  const window881 = exportV1.flightRecordWindows.find((w) => w.record_id === flight1.draft_id);
  assert.ok(window881, 'Window for JX881 included');
  assert.equal(window881.window_start, '06:30');

  // --------------------------------------------------------------------------
  // 5. Restore to draft: restore_seasonal_published_draft_v1
  // --------------------------------------------------------------------------
  // Snapshot Operations table state BEFORE restore
  await asAdmin();
  const opsBeforeRestore = (await db.query('select to_jsonb(l) r from public.operational_flight_legs l order by leg_id')).rows.map((x) => x.r);
  await asWriter();

  // Current draft has V3 flights (including VN991).
  const currentDraftWindow = await window();
  const curRev = currentDraftWindow.revision;
  const curEpoch = currentDraftWindow.epoch;

  // Stale epoch/revision rejection
  await rejected(
    () => rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
      season,
      v1Id,
      randomUUID(),
      BigInt(curRev) + 999n,
      curEpoch,
    ]),
    '40001'
  );

  // Cross-season restore rejection: provide otherSeason's real revision & epoch so only cross-season is violated
  const otherWindow = await rpc('get_seasonal_draft_window_v1', '$1', [otherSeason]);
  await rejected(
    () => rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
      otherSeason,
      v1Id,
      randomUUID(),
      BigInt(otherWindow.revision),
      otherWindow.epoch,
    ]),
    '22023'
  );

  // Valid restore to V1
  const restoreRequestId = randomUUID();
  const restoreResult = await rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
    season,
    v1Id,
    restoreRequestId,
    BigInt(curRev),
    curEpoch,
  ]);

  assert.equal(restoreResult.status, 'committed');
  assert.equal(restoreResult.requestId, restoreRequestId);
  assert.equal(restoreResult.versionId, v1Id);
  assert.ok(BigInt(restoreResult.revision) > BigInt(curRev), 'Revision bumped on restore');
  assert.notEqual(restoreResult.epoch, curEpoch, 'New epoch generated on restore');
  assert.equal(restoreResult.drafts.length, 3, 'Restored active draft has exactly V1 3 flights');

  // Exact idempotent replay
  const replayResult = await rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
    season,
    v1Id,
    restoreRequestId,
    BigInt(curRev),
    curEpoch,
  ]);
  assert.deepEqual(replayResult, restoreResult, 'Exact replay returns identical receipt');

  // Replay with different payload rejected
  await rejected(
    () => rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
      season,
      v2Id, // different version!
      restoreRequestId,
      BigInt(curRev),
      curEpoch,
    ]),
    '22023'
  );

  // Operations / Daily tables UNCHANGED
  await asAdmin();
  const opsAfterRestore = (await db.query('select to_jsonb(l) r from public.operational_flight_legs l order by leg_id')).rows.map((x) => x.r);
  await asWriter();
  assert.deepEqual(opsAfterRestore, opsBeforeRestore, 'Operations legs completely untouched by draft restore');

  // Foreign keys / tombstones retained:
  // VN991 was created in V3; it is NOT in V1. It must exist as a tombstone (deleted), NOT hard-deleted.
  const vn991Draft = await row("select * from public.seasonal_flight_drafts where season_id=$1 and flight_number='VN991'", [season]);
  assert.ok(vn991Draft, 'Draft row for VN991 retained for FK integrity');
  assert.equal(vn991Draft.status, 'deleted', 'VN991 marked deleted in draft');
  assert.equal(vn991Draft.deletion_reason, 'restored_version_superseded');

  // Reciprocal pairing preserved on restored drafts
  const restoredDrafts = (await window()).drafts;
  const pair881 = restoredDrafts.find((d) => d.flight_number === 'JX881');
  const pair882 = restoredDrafts.find((d) => d.flight_number === 'JX882');
  assert.ok(pair881 && pair882, 'Restored reciprocal pair JX881/JX882 exists');
  assert.equal(pair881.linked_draft_id, pair882.draft_id);
  assert.equal(pair882.linked_draft_id, pair881.draft_id);

  // Audit events recorded
  const auditEvents = (await db.query("select * from public.seasonal_draft_events where season_id=$1 and op_id like $2", [season, `${restoreRequestId}:%`])).rows;
  assert.ok(auditEvents.length >= 1, 'Draft audit events recorded for restore');

  // --------------------------------------------------------------------------
  // 6. Restore inspection -> Publish path safe
  // --------------------------------------------------------------------------
  // After restore, the operator inspects and publishes the restored draft
  const previewRestored = await preview();
  assert.equal(previewRestored.status, 'ready', 'Restored draft can be previewed for publish');
  const receiptV4 = await commitPublish(previewRestored, 'Version 4 published from restored V1');
  assert.equal(receiptV4.status, 'committed');
  assert.ok(receiptV4.versionId);

  // --------------------------------------------------------------------------
  // 7. Rollback Safety: functions dropped, historical evidence preserved
  // --------------------------------------------------------------------------
  const rollbackUrl = new URL('../migrations/20261008100000_seasonal_version_management_v1.rollback.sql', import.meta.url);
  const latestMigrationUrl = new URL('../migrations/20261009090000_seasonal_snapshot_integrity_indexed_v1.sql', import.meta.url);
  const latestRollbackUrl = new URL('../migrations/20261009090000_seasonal_snapshot_integrity_indexed_v1.rollback.sql', import.meta.url);
  const migrationUrl = new URL('../migrations/20261008100000_seasonal_version_management_v1.sql', import.meta.url);
  await asAdmin();
  await db.exec(await readFile(latestRollbackUrl, 'utf8'));
  await db.exec(await readFile(rollbackUrl, 'utf8'));
  await asWriter();

  // Functions are dropped
  await rejected(() => rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid', [v1Id]), '42883');
  await rejected(() => rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid', [v1Id, v2Id]), '42883');
  await rejected(() => rpc('get_seasonal_published_export_snapshot_v1', '$1::uuid', [v1Id]), '42883');
  await rejected(() => rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [season, v1Id, randomUUID(), 0n, randomUUID()]), '42883');
  await rejected(() => rpc('seasonal_published_flight_to_draft_json_v1', '$1::jsonb,$2', ['{}', season]), '42883');

  // Historical evidence PRESERVED: versions, snapshots, drafts still exist
  await asAdmin();
  const versionsCount = (await row('select count(*)::int c from public.seasonal_publish_versions where season_id=$1', [season])).c;
  assert.ok(versionsCount >= 4, 'All published versions retained after rollback');
  const snapshotsCount = (await row('select count(*)::int c from public.seasonal_publish_snapshots where season_id=$1', [season])).c;
  assert.ok(snapshotsCount >= 4, 'All snapshots retained after rollback');

  // Reapply migrations to leave clean state with latest functions
  await db.exec(await readFile(migrationUrl, 'utf8'));
  await db.exec(await readFile(latestMigrationUrl, 'utf8'));
  await asWriter();
  const restoredPage = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid', [v1Id]);
  assert.equal(restoredPage.versionId, v1Id, 'Functions work again after reapply');

  console.log('seasonal_version_management_pglite: ALL BEHAVIOR REGRESSIONS PASSED');
} catch (e) {
  throw new Error(`${e.message} [${e.code ?? ''}] ${e.where ?? ''}\n${e.stack ?? ''}`, {
    cause: e,
  });
} finally {
  if (db) await db.close();
}
