// ============================================================================
// Behavioral Test Suite: seasonal_draft_changes_pglite.mjs
// Verifies authoritative get_seasonal_draft_changes_page_v1 RPC:
//   - get_seasonal_draft_changes_page_v1
//   - multi-day group spanning page size & date gaps
//   - distinct identities & date-shift separation
//   - full totals unaffected by filters (stable pair summary)
//   - dates, search, and category field filters
//   - exact day expansion in days view
//   - server-side prior version resolution (null base resolves to latest published)
//   - auth, season not found, and inverted dates validation
//   - rollback & reapply parity
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
  const rejected = (fn, code) => assert.rejects(fn, (e) => {
    if (code && e.code !== code) {
      throw new Error(`Expected error code ${code}, got ${e.code}: ${e.message}`);
    }
    return true;
  });

  await asAdmin();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);

  const dates = await row(`
    select
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 5)::text d1,
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 6)::text d2,
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 7)::text d3,
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 8)::text d4
  `);

  await asWriter();

  // --------------------------------------------------------------------------
  // 1. Stage and commit initial season with flights across multiple dates
  //    JX701 operates on d1, d2, d4 (with gap at d3)
  //    JX702 operates on d1
  // --------------------------------------------------------------------------
  const importRequestId = randomUUID();
  const imported = await rpc('stage_seasonal_draft_import_v1', '$1::jsonb', [
    JSON.stringify({
      requestId: importRequestId,
      checksum: importRequestId,
      seasonCode: 'W99',
      expectedRevision: '0',
      fileName: 'draft_changes.xlsx',
      sourceRows: [
        // JX701 ARR on d1, d2, d4
        seasonalRow({ rowIndex: 1, effective: dates.d1, discontinue: dates.d1, arrFlight: '701', arrRoute: 'HAN', sta: '08:00' }),
        seasonalRow({ rowIndex: 2, effective: dates.d2, discontinue: dates.d2, arrFlight: '701', arrRoute: 'HAN', sta: '08:00' }),
        seasonalRow({ rowIndex: 3, effective: dates.d4, discontinue: dates.d4, arrFlight: '701', arrRoute: 'HAN', sta: '08:00' }),
        // JX702 DEP on d1
        seasonalRow({ rowIndex: 4, effective: dates.d1, discontinue: dates.d1, depFlight: '702', depRoute: 'SGN', std: '11:00' }),
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

  // Set explicit properties on drafts:
  const win0 = await window();
  const jx701Drafts = win0.drafts.filter(x => x.flight_number === 'JX701');
  assert.equal(jx701Drafts.length, 3, '3 initial JX701 drafts found');
  for (const d of jx701Drafts) {
    await patchDraft(d, { pax: 150, aircraft: '321' });
  }

  // Publish V1
  const previewV1 = await preview();
  const receiptV1 = await commitPublish(previewV1, 'Initial V1');
  const v1Id = receiptV1.versionId;
  assert.ok(v1Id, 'V1 published');

  // --------------------------------------------------------------------------
  // 2. Modify live Draft (leave unpublished, so Draft differs from V1):
  //    - Modify JX701 schedule from 08:00 to 09:30 on d1, d2, d4 (time change)
  //    - Modify JX702 gate from null to 5 on d1 (other change)
  //    - Add JX703 on d2 and d3 (added)
  // --------------------------------------------------------------------------
  const win1 = await window();
  const jx701ToPatch = win1.drafts.filter(x => x.flight_number === 'JX701');
  assert.equal(jx701ToPatch.length, 3, '3 JX701 drafts found in draft');
  for (const d of jx701ToPatch) {
    await patchDraft(d, { schedule: '09:30' });
  }
  const jx702 = win1.drafts.find(x => x.flight_number === 'JX702');
  assert.ok(jx702, 'JX702 draft found');
  await patchDraft(jx702, { gate: 5 });

  const addJx703_d2 = {
    draftId: 'DRF_JX703_D2',
    expected: null,
    patch: { type: 'D', airline: 'JX', flight_number: 'JX703', date: dates.d2, schedule: '16:00', route: 'DAD', pax: 180, aircraft: '321' },
  };
  const addJx703_d3 = {
    draftId: 'DRF_JX703_D3',
    expected: null,
    patch: { type: 'D', airline: 'JX', flight_number: 'JX703', date: dates.d3, schedule: '16:00', route: 'DAD', pax: 180, aircraft: '321' },
  };

  await rpc('apply_seasonal_draft_changes_v1', '$1,$2::uuid,$3::bigint,$4::jsonb', [
    season, randomUUID(), (await window()).revision, JSON.stringify([addJx703_d2, addJx703_d3])
  ]);

  // --------------------------------------------------------------------------
  // Check 1: Auth & validation
  // --------------------------------------------------------------------------
  await asAdmin();
  // Null season parameter rejected
  await rejected(() => db.query("select public.get_seasonal_draft_changes_page_v1(null)"), '22023');
  // Non-existent season rejected
  await rejected(() => rpc('get_seasonal_draft_changes_page_v1', '$1', ['non-existent-season']), 'P0002');
  // Inverted date range rejected
  await rejected(() => rpc('get_seasonal_draft_changes_page_v1', '$1,null,$2,null,50,$3,null,$4::date,$5::date', [
    season, 'groups', 'all', dates.d4, dates.d1
  ]), '22023');

  await asWriter();

  // --------------------------------------------------------------------------
  // Check 2: Server-side prior version auto-resolution (p_base_version_id is null)
  //          Comparing Draft with null base resolves automatically to latest published V1!
  // --------------------------------------------------------------------------
  const draftAutoDiff = await rpc('get_seasonal_draft_changes_page_v1', '$1,null', [season]);
  assert.equal(draftAutoDiff.version.versionId, 'draft');
  assert.equal(draftAutoDiff.baseVersion.versionId, v1Id, 'Resolved latest published version V1');
  assert.equal(draftAutoDiff.baseVersion.notes, 'Initial V1');
  assert.ok(draftAutoDiff.draftEpoch, 'draftEpoch populated');
  assert.ok(draftAutoDiff.draftRevision, 'draftRevision populated');
  assert.equal(draftAutoDiff.baseVersionId, v1Id, 'baseVersionId populated');

  // Verify Summary:
  // 2 added (JX703 d2, d3), 0 removed, 4 modified (3x JX701, 1x JX702) -> totalChanges = 6
  assert.equal(draftAutoDiff.summary.totalChanges, 6);
  assert.equal(draftAutoDiff.summary.added, 2);
  assert.equal(draftAutoDiff.summary.removed, 0);
  assert.equal(draftAutoDiff.summary.modified, 4);
  // --------------------------------------------------------------------------
  // Check 3: Multi-day grouping in 'groups' view
  // --------------------------------------------------------------------------
  const groupsView = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3', [season, v1Id, 'groups']);
  assert.equal(groupsView.totalRows, 3, '3 groups: JX701, JX702, JX703');
  assert.equal(groupsView.filteredOccurrenceCount, 6, 'Total 6 occurrences');

  // Verify JX701 group:
  const jx701Group = groupsView.entries.find(e => e.flight_number === 'JX701');
  assert.ok(jx701Group, 'JX701 group found');
  assert.equal(jx701Group.change_type, 'modified');
  assert.equal(jx701Group.occurrence_count, 3);
  assert.deepEqual(jx701Group.dates, [dates.d1, dates.d2, dates.d4], 'Distinct dates with d3 gap preserved');
  assert.ok(jx701Group.group_key, 'group_key is populated');
  assert.ok(jx701Group.before_state && jx701Group.after_state, 'Before and after states present');

  // Verify JX703 group (added):
  const jx703Group = groupsView.entries.find(e => e.flight_number === 'JX703');
  assert.ok(jx703Group, 'JX703 group found');
  assert.equal(jx703Group.change_type, 'added');
  assert.equal(jx703Group.occurrence_count, 2);
  assert.deepEqual(jx703Group.dates, [dates.d2, dates.d3]);

  // --------------------------------------------------------------------------
  // Check 4: Days view (individual occurrences)
  // --------------------------------------------------------------------------
  const daysView = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3', [season, v1Id, 'days']);
  assert.equal(daysView.totalRows, 6, '6 occurrences expanded individually');
  assert.equal(daysView.entries.length, 6);

  // --------------------------------------------------------------------------
  // Check 5: Category field filters & stable summary
  // --------------------------------------------------------------------------
  // Filter by 'time': JX701 (modified schedule) included, JX702 (gate only) excluded
  const timeFiltered = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,null,null,null,$5', [
    season, v1Id, 'groups', 'all', 'time'
  ]);
  assert.ok(timeFiltered.entries.some(e => e.flight_number === 'JX701'), 'JX701 included in time filter');
  assert.ok(!timeFiltered.entries.some(e => e.flight_number === 'JX702'), 'JX702 excluded from time filter');
  assert.equal(timeFiltered.summary.totalChanges, 6, 'Summary totals remain stable across filters');
  // Filter by 'other': JX702 (gate modified) matches
  const otherOnly = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,null,null,null,$5', [
    season, v1Id, 'groups', 'all', 'other'
  ]);
  assert.ok(otherOnly.entries.some(e => e.flight_number === 'JX702'), 'JX702 matches other field filter');

  // Filter by search: 'JX703'
  const searchResult = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,$5', [
    season, v1Id, 'groups', 'all', 'JX703'
  ]);
  assert.equal(searchResult.totalRows, 1, 'Only JX703 matches search');
  assert.equal(searchResult.entries[0].flight_number, 'JX703');

  // --------------------------------------------------------------------------
  // Check 6: Pagination with page_size = 1
  // --------------------------------------------------------------------------
  // Page 1 with null base resolves to v1Id, returns baseVersionId and draftRevision
  const p1 = await rpc('get_seasonal_draft_changes_page_v1', '$1,null,$2,null,1', [season, 'groups']);
  assert.equal(p1.entries.length, 1);
  assert.equal(p1.hasMore, true);
  assert.ok(p1.nextCursor, 'nextCursor returned');
  assert.equal(p1.baseVersionId, v1Id, 'Page 1 returned baseVersionId');

  // Page 2 pins baseVersionId and expectedRevision from Page 1 to guard against base/revision drift
  const p2 = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,$4,1,$5,null,null,null,$6,null,$7,$8::bigint', [
    season, p1.baseVersionId, 'groups', p1.nextCursor, 'all', 'all', p1.draftEpoch, Number(p1.draftRevision)
  ]);
  assert.equal(p2.entries.length, 1);
  assert.notEqual(p2.entries[0].group_key, p1.entries[0].group_key, 'Second page returns distinct group');

  // --------------------------------------------------------------------------
  // Check 7: STABLE Epoch and Revision fencing (rejects 40001 on conflict)
  // --------------------------------------------------------------------------
  // Valid fence matching current draft succeeds
  const validFence = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,null,null,null,$5,null,$6,$7::bigint', [
    season, v1Id, 'groups', 'all', 'all', p1.draftEpoch, Number(p1.draftRevision)
  ]);
  assert.equal(validFence.summary.totalChanges, 6, 'Valid fence returns changes cleanly');

  // Mismatched revision rejected with 40001 snapshot_changed
  await rejected(() => rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,null,null,null,$5,null,null,$6::bigint', [
    season, v1Id, 'groups', 'all', 'all', 999999
  ]), '40001');

  // Mismatched epoch rejected with 40001 snapshot_changed
  await rejected(() => rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid,$3,null,50,$4,null,null,null,$5,null,$6,null', [
    season, v1Id, 'groups', 'all', 'all', randomUUID()
  ]), '40001');

  // --------------------------------------------------------------------------
  // Check 8: Parity with get_seasonal_version_changes_page_v1
  //          Publish Draft as V2, verify published RPC yields identical summary & groups
  // --------------------------------------------------------------------------
  const previewV2 = await preview();
  const receiptV2 = await commitPublish(previewV2, 'Changes in V2');
  const v2Id = receiptV2.versionId;

  const publishedVersionChanges = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid', [v2Id, v1Id]);
  assert.equal(draftAutoDiff.summary.totalChanges, publishedVersionChanges.summary.totalChanges, 'totalChanges parity');
  assert.equal(draftAutoDiff.summary.added, publishedVersionChanges.summary.added, 'added count parity');
  assert.equal(draftAutoDiff.summary.removed, publishedVersionChanges.summary.removed, 'removed count parity');
  assert.equal(draftAutoDiff.summary.modified, publishedVersionChanges.summary.modified, 'modified count parity');
  assert.equal(draftAutoDiff.totalRows, publishedVersionChanges.totalRows, 'totalRows parity');
  assert.equal(draftAutoDiff.filteredOccurrenceCount, publishedVersionChanges.filteredOccurrenceCount, 'filteredOccurrenceCount parity');

  // --------------------------------------------------------------------------
  // Check 9: Rollback and Reapply parity
  // --------------------------------------------------------------------------
  const migrationUrl = new URL('../migrations/20261012140000_seasonal_draft_changes_v1.sql', import.meta.url);
  const rollbackUrl = new URL('../migrations/20261012140000_seasonal_draft_changes_v1.rollback.sql', import.meta.url);

  // Apply rollback
  await asAdmin();
  await db.exec(await readFile(rollbackUrl, 'utf8'));

  // Function dropped on rollback
  await rejected(() => rpc('get_seasonal_draft_changes_page_v1', '$1', [season]), '42883');

  // Reapply migration
  await db.exec(await readFile(migrationUrl, 'utf8'));

  // Functional after reapply
  await asWriter();
  const postReapply = await rpc('get_seasonal_draft_changes_page_v1', '$1,$2::uuid', [season, v1Id]);
  assert.equal(postReapply.summary.totalChanges, 6, 'Reapplied migration functions identically');
  assert.equal(postReapply.totalRows, 3);

  console.log('seasonal_draft_changes_pglite: ALL BEHAVIORAL CHECKS PASSED');
} catch (e) {
  throw new Error(`${e.message} [${e.code ?? ''}] ${e.where ?? ''}\n${e.stack ?? ''}`, { cause: e });
} finally {
  if (db) await db.close();
}
