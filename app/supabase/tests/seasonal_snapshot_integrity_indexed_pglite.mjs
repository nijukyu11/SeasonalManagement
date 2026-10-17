// ============================================================================
// Behavioral Test Suite: seasonal_snapshot_integrity_indexed_pglite.mjs
// Verifies snapshot storage integrity, indexed derived snapshot flights,
// persistent diff comparison cache, corruption rejection, and immutability.
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

  const dates = await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 5)::text d1, ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 6)::text d2");

  await asWriter();

  // --------------------------------------------------------------------------
  // Stage and commit initial season with 3 flights via canonical import RPCs
  // --------------------------------------------------------------------------
  const importRequestId = randomUUID();
  const imported = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({
      requestId: importRequestId,
      checksum: importRequestId,
      seasonCode: 'W89',
      expectedRevision: '0',
      fileName: 'snapshot_integrity.xlsx',
      sourceRows: [
        seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '891', arrRoute: 'TPE', sta: '09:00', depFlight: '892', depRoute: 'TPE', std: '10:30' }),
        seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '893', arrRoute: 'SGN', sta: '14:00' }),
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

  // Set explicit resources on drafts:
  // JX891: pax = 0, gate = 1, stand = '20A', non-empty counters & windows
  const initialWindow = await window();
  const flight891 = initialWindow.drafts.find(d => d.flight_number === 'JX891');
  const flight892 = initialWindow.drafts.find(d => d.flight_number === 'JX892');
  const flight893 = initialWindow.drafts.find(d => d.flight_number === 'JX893');
  assert.ok(flight891 && flight892 && flight893, 'Initial 3 flights exist');

  await patchDraft(flight891, {
    gate: 1,
    stand: '20A',
    pax: 0,
    counters: [{ counter_group: 'T1', item_index: 0, counter_value: '15' }],
    checkin_windows: [{ counter_key: '15', window_start: '06:30', window_end: '08:30' }],
  });

  // JX893: pax = null, gate = null, stand = null, empty counters & windows
  await patchDraft(flight893, {
    gate: null,
    stand: null,
    pax: null,
    counters: [],
    checkin_windows: [],
  });

  // --------------------------------------------------------------------------
  // Publish Version 1 (V1)
  // --------------------------------------------------------------------------
  const preview1 = await preview();
  const receiptV1 = await commitPublish(preview1, 'Publish V1');
  const v1Id = receiptV1.versionId;
  assert.ok(v1Id, 'V1 published successfully');

  await asAdmin();
  const v1OriginalSnapshot = await row('select * from public.seasonal_publish_snapshots where version_id = $1', [v1Id]);
  const v1DerivedFlights = await rows('select * from public.seasonal_published_snapshot_flights where version_id = $1 order by draft_id', [v1Id]);
  assert.equal(v1DerivedFlights.length, 3, '3 derived flight rows inserted for V1');
  assert.equal(v1OriginalSnapshot.active_flight_count, 3, 'Certified active flight count matches 3');

  // --------------------------------------------------------------------------
  // Publish Version 2 (V2): modify 893, add extra flight
  // --------------------------------------------------------------------------
  await asWriter();
  const windowV1 = await window();
  const draftToModify = windowV1.drafts.find(d => d.flight_number === 'JX893');
  await patchDraft(draftToModify, { pax: 220, route: 'DAD', schedule: '15:15' });

  const draftToAdd = {
    draftId: 'DRF_EXTRA_V2',
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
    season, randomUUID(), (await window()).revision, JSON.stringify([draftToAdd])
  ]);

  const preview2 = await preview();
  const receiptV2 = await commitPublish(preview2, 'Publish V2');
  const v2Id = receiptV2.versionId;

  // --------------------------------------------------------------------------
  // Publish Version 3 (V3): modify 891
  // --------------------------------------------------------------------------
  const windowV2 = await window();
  const draft891V2 = windowV2.drafts.find(d => d.flight_number === 'JX891');
  await patchDraft(draft891V2, { gate: 5 });

  const preview3 = await preview();
  const receiptV3 = await commitPublish(preview3, 'Publish V3');
  const v3Id = receiptV3.versionId;

  // --------------------------------------------------------------------------
  // 1. Behavior Regression: Old snapshot byte-identical & derived rows unchanged
  // --------------------------------------------------------------------------
  const v1CurrentSnapshot = await row('select * from public.seasonal_publish_snapshots where version_id = $1', [v1Id]);
  assert.equal(v1CurrentSnapshot.checksum, v1OriginalSnapshot.checksum, 'Old snapshot checksum untouched');
  assert.deepEqual(v1CurrentSnapshot.snapshot_payload, v1OriginalSnapshot.snapshot_payload, 'Old snapshot payload byte-identical');

  const v1CurrentDerivedFlights = await rows('select * from public.seasonal_published_snapshot_flights where version_id = $1 order by draft_id', [v1Id]);
  assert.equal(v1CurrentDerivedFlights.length, 3, 'Old derived flights count identical');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(v1CurrentDerivedFlights[i].draft_payload, v1DerivedFlights[i].draft_payload, `Derived flight ${i} byte-identical`);
  }

  // --------------------------------------------------------------------------
  // 2. Full Paging Ordering & Seek Index Behavior
  // --------------------------------------------------------------------------
  await asWriter();
  // Page 1: page_size = 2
  const page1 = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid,null,2', [v1Id]);
  assert.equal(page1.versionId, v1Id);
  assert.equal(page1.totalCount, 3, 'O(1) certified total count is 3');
  assert.equal(page1.flights.length, 2, 'Page 1 contains 2 flights');
  assert.equal(page1.hasMore, true, 'Page 1 hasMore is true');
  assert.ok(page1.nextDraftId, 'nextDraftId is populated');
  assert.ok(page1.flights[0].draft_id < page1.flights[1].draft_id, 'Drafts sorted strictly by draft_id');

  // Page 2: seek after nextDraftId
  const page2 = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid,$2,2', [v1Id, page1.nextDraftId]);
  assert.equal(page2.flights.length, 1, 'Page 2 contains remaining 1 flight');
  assert.equal(page2.hasMore, false, 'Page 2 hasMore is false');
  assert.ok(page2.flights[0].draft_id > page1.nextDraftId, 'Page 2 draft_id strictly follows Page 1');

  // --------------------------------------------------------------------------
  // 3. Resources NULL vs 0 Representation & Arrays
  // --------------------------------------------------------------------------
  const allV1Flights = [...page1.flights, ...page2.flights];
  const paged891 = allV1Flights.find(f => f.flight_number === 'JX891');
  const paged892 = allV1Flights.find(f => f.flight_number === 'JX892');
  const paged893 = allV1Flights.find(f => f.flight_number === 'JX893');

  assert.equal(paged891.pax, 0, 'Explicit 0 pax is preserved, not coerced to null');
  assert.equal(paged891.gate, 1, 'Gate 1 preserved');
  assert.equal(paged891.stand, '20A', 'Stand 20A preserved');
  assert.ok(Array.isArray(paged891.counters) && paged891.counters.length === 1, 'Non-empty counters preserved');
  assert.ok(Array.isArray(paged891.checkin_windows) && paged891.checkin_windows.length === 1, 'Non-empty checkin_windows preserved');

  assert.equal(paged893.pax, null, 'Explicit NULL pax is preserved, not coerced to 0');
  assert.equal(paged893.gate, null, 'Explicit NULL gate is preserved');
  assert.equal(paged893.stand, null, 'Explicit NULL stand is preserved');
  assert.ok(Array.isArray(paged893.counters) && paged893.counters.length === 0, 'Empty counters preserved as array');

  // Reciprocal pairing in V1
  assert.equal(paged891.linked_draft_id, paged892.draft_id, '891 points to 892');
  assert.equal(paged892.linked_draft_id, paged891.draft_id, '892 points to 891');

  // --------------------------------------------------------------------------
  // 4. Export & Restore Checksum Validation and Corruption Rejection
  // --------------------------------------------------------------------------
  // Export V1 succeeds cleanly when uncorrupted
  const exportV1 = await rpc('get_seasonal_published_export_snapshot_v1', '$1::uuid', [v1Id]);
  assert.equal(exportV1.versionId, v1Id);
  assert.deepEqual(exportV1.flightRecords.map(f => f.flight_number).sort(), ['JX891', 'JX892', 'JX893']);

  // Intentionally tamper with snapshot checksum in DB (disabling trigger to simulate on-disk bitrot)
  await asAdmin();
  await db.query("alter table public.seasonal_publish_snapshots disable trigger seasonal_publish_snapshots_guard_trigger");
  await db.query("update public.seasonal_publish_snapshots set checksum = 'corrupted_bitrot_checksum' where version_id = $1", [v1Id]);
  await db.query("alter table public.seasonal_publish_snapshots enable trigger seasonal_publish_snapshots_guard_trigger");

  await asWriter();
  // Export on corrupted snapshot MUST throw 55000 (no fallback)
  await rejected(() => rpc('get_seasonal_published_export_snapshot_v1', '$1::uuid', [v1Id]), '55000');

  // Restore on corrupted snapshot MUST throw 55000 (no fallback)
  const corruptionWindow = await window();
  await rejected(() => rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [season, v1Id, randomUUID(), corruptionWindow.revision, corruptionWindow.epoch]), '55000');

  // Restore legitimate checksum
  await asAdmin();
  await db.query("alter table public.seasonal_publish_snapshots disable trigger seasonal_publish_snapshots_guard_trigger");
  await db.query("update public.seasonal_publish_snapshots set checksum = $2 where version_id = $1", [v1Id, v1OriginalSnapshot.checksum]);
  await db.query("alter table public.seasonal_publish_snapshots enable trigger seasonal_publish_snapshots_guard_trigger");

  // --------------------------------------------------------------------------
  // 5. Unauthorized Mutation & DB Immutability Guards
  // --------------------------------------------------------------------------
  // Authenticated user cannot insert/update/delete derived snapshot flights
  await asWriter();
  await rejected(() => db.query("delete from public.seasonal_published_snapshot_flights where version_id = $1", [v1Id]), '42501');
  await rejected(() => db.query("update public.seasonal_published_snapshot_flights set status = 'deleted' where version_id = $1", [v1Id]), '42501');
  await rejected(() => db.query("insert into public.seasonal_published_snapshot_flights (snapshot_id, version_id, season_id, draft_id, draft_payload) values ($1, $2, $3, 'hack', '{}'::jsonb)", [v1OriginalSnapshot.snapshot_id, v1Id, season]), '42501');

  // Authenticated user cannot delete or truncate parent snapshots
  await rejected(() => db.query("delete from public.seasonal_publish_snapshots where version_id = $1", [v1Id]), '42501');
  await rejected(() => db.query("truncate table public.seasonal_publish_snapshots"), '42501');

  // Admin DELETE and TRUNCATE are strictly prohibited on published records (no bypass)
  await asAdmin();
  await rejected(() => db.query("delete from public.seasonal_publish_snapshots where version_id = $1", [v1Id]), '22023');
  await rejected(() => db.query("delete from public.seasonal_published_snapshot_flights where version_id = $1", [v1Id]), '22023');
  await rejected(() => db.query("delete from public.seasonal_publish_versions where version_id = $1", [v1Id]), '22023');
  await rejected(() => db.query("truncate table public.seasonal_publish_snapshots cascade"), '22023');

  // Admin non-identical UPDATE on published snapshot is rejected with 22023
  await rejected(() => db.query("update public.seasonal_publish_snapshots set checksum = 'tampered' where version_id = $1", [v1Id]), '22023');
  await rejected(() => db.query("update public.seasonal_publish_snapshots set snapshot_payload = '{\"tampered\": true}'::jsonb where version_id = $1", [v1Id]), '22023');

  // Admin IDEMPOTENT update (where all fields are identical) succeeds cleanly
  await db.query("update public.seasonal_publish_snapshots set checksum = checksum, snapshot_payload = snapshot_payload where version_id = $1", [v1Id]);

  // --------------------------------------------------------------------------
  // 6. Arbitrary Version Diff Paging with Persistent Comparison Cache
  // --------------------------------------------------------------------------
  await asWriter();
  // Compare non-adjacent versions V1 and V3
  const diffPage1 = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid,0,10', [v1Id, v3Id]);
  assert.ok(diffPage1.entries.length > 0, 'Arbitrary diff returns entries');

  // Verify comparison cache run was created with status = completed
  await asAdmin();
  const cacheRun = await row(
    "select * from public.seasonal_publish_diff_cache_runs where season_id = $1 and base_version_id = $2 and version_id = $3",
    [season, v1Id, v3Id]
  );
  assert.ok(cacheRun, 'Diff cache run created');
  assert.equal(cacheRun.status, 'completed', 'Cache run status is completed');
  assert.ok(cacheRun.entry_count > 0, 'Cache run has positive entry_count');

  // Next page reads from cache directly
  await asWriter();
  const diffPageCached = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid,0,10', [v1Id, v3Id]);
  assert.deepEqual(diffPageCached.entries, diffPage1.entries, 'Cached diff matches freshly computed diff');

  // Empty diff (compare V1 to V1) creates completion marker with entry_count = 0
  const emptyDiff = await rpc('get_seasonal_version_comparison_page_v1', '$1::uuid,$2::uuid,0,10', [v1Id, v1Id]);
  assert.equal(emptyDiff.entries.length, 0, 'Same version diff has 0 entries');
  assert.equal(emptyDiff.hasMore, false);

  await asAdmin();
  const emptyCacheRun = await row(
    "select * from public.seasonal_publish_diff_cache_runs where season_id = $1 and base_version_id = $2 and version_id = $3",
    [season, v1Id, v1Id]
  );
  assert.ok(emptyCacheRun, 'Empty diff cache run exists');
  assert.equal(emptyCacheRun.status, 'completed', 'Empty diff run is completed');
  assert.equal(emptyCacheRun.entry_count, 0, 'Empty diff completion marker has entry_count = 0');

  // --------------------------------------------------------------------------
  // 7. Restore to Draft: verifies operational isolation & reciprocal pairing
  // --------------------------------------------------------------------------
  await asWriter();
  const restoreReqId = randomUUID();
  const winBeforeRestore = await window();
  const restoreReceipt = await rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
    season, v1Id, restoreReqId, winBeforeRestore.revision, winBeforeRestore.epoch
  ]);
  assert.equal(restoreReceipt.status, 'committed');
  assert.equal(restoreReceipt.versionId, v1Id);

  // Check restored drafts match V1
  const restoredDrafts = await rows("select * from public.seasonal_flight_drafts where season_id = $1 and status = 'active' order by draft_id", [season]);
  assert.equal(restoredDrafts.length, 3, '3 drafts restored');
  const restored891 = restoredDrafts.find(d => d.flight_number === 'JX891');
  const restored892 = restoredDrafts.find(d => d.flight_number === 'JX892');
  assert.equal(restored891.pax, 0, 'Restored 891 pax is 0');
  assert.equal(restored891.linked_draft_id, restored892.draft_id, 'Restored reciprocal pair 891->892');
  assert.equal(restored892.linked_draft_id, restored891.draft_id, 'Restored reciprocal pair 892->891');

  // Idempotent restore replay
  const replayReceipt = await rpc('restore_seasonal_published_draft_v1', '$1,$2::uuid,$3::uuid,$4::bigint,$5::uuid', [
    season, v1Id, restoreReqId, winBeforeRestore.revision, winBeforeRestore.epoch
  ]);
  assert.deepEqual(replayReceipt, restoreReceipt, 'Idempotent replay returns the original receipt');

  // --------------------------------------------------------------------------
  // 8. Rollback and Reapply Parity
  // --------------------------------------------------------------------------
  const rollbackUrl = new URL('../migrations/20261009090000_seasonal_snapshot_integrity_indexed_v1.rollback.sql', import.meta.url);
  const migrationUrl = new URL('../migrations/20261009090000_seasonal_snapshot_integrity_indexed_v1.sql', import.meta.url);

  await asAdmin();
  await db.exec(await readFile(rollbackUrl, 'utf8'));

  // Derived tables dropped
  const derivedTableExists = (await row("select exists(select 1 from information_schema.tables where table_name = 'seasonal_published_snapshot_flights') e")).e;
  assert.equal(derivedTableExists, false, 'Derived table dropped on rollback');

  // Canonical snapshots and published versions RETAINED
  const retainedSnapshots = (await row("select count(*)::int c from public.seasonal_publish_snapshots where season_id = $1", [season])).c;
  assert.ok(retainedSnapshots >= 3, 'Snapshots retained after rollback');

  // Preimages restored and functional
  await asWriter();
  const preRestorePage = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid', [v1Id]);
  assert.equal(preRestorePage.versionId, v1Id, 'Preimage restored page function works');

  // Reapply migration
  await asAdmin();
  await db.exec(await readFile(migrationUrl, 'utf8'));

  // Re-verified functional after reapply
  await asWriter();
  const postReapplyPage = await rpc('get_seasonal_published_snapshot_page_v1', '$1::uuid', [v1Id]);
  assert.equal(postReapplyPage.versionId, v1Id, 'Upgraded function works after reapply');
  assert.equal(postReapplyPage.totalCount, 3, 'Seek index total count works after reapply');

  console.log('seasonal_snapshot_integrity_indexed_pglite: ALL BEHAVIORAL CHECKS PASSED');
} catch (e) {
  throw new Error(`${e.message} [${e.code ?? ''}] ${e.where ?? ''}\n${e.stack ?? ''}`, { cause: e });
} finally {
  if (db) await db.close();
}
