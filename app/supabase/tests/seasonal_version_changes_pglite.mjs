// ============================================================================
// Behavioral Test Suite: seasonal_version_changes_pglite.mjs
// Verifies user-friendly seasonal version changes presentation:
//   - get_seasonal_version_changes_page_v1
//   - multi-day group spanning page size & date gaps
//   - distinct identities & date-shift separation
//   - full totals unaffected by filters (stable pair summary)
//   - dates, search, and category field filters
//   - empty / same version comparison
//   - exact day expansion via groupKey in days view
//   - auth & cross-season validation
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
      fileName: 'version_changes.xlsx',
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
  // JX701 on all dates: pax = 150, aircraft = '321'
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
  // Publish V2:
  // - Modify JX701 schedule from 08:00 to 09:30 on d1, d2, d4 (time change)
  // - Modify JX702 gate from null to 5 on d1 (other change)
  // - Add JX703 on d2 and d3 (added)
  // --------------------------------------------------------------------------
  const win1 = await window();
  const jx701ToPatch = win1.drafts.filter(x => x.flight_number === 'JX701');
  assert.equal(jx701ToPatch.length, 3, '3 JX701 drafts found in V2');
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

  const previewV2 = await preview();
  const receiptV2 = await commitPublish(previewV2, 'Changes in V2');
  const v2Id = receiptV2.versionId;
  assert.ok(v2Id, 'V2 published');

  // --------------------------------------------------------------------------
  // Check 1: Auth & validation
  // --------------------------------------------------------------------------
  await asAdmin();
  // Seasonal read permission check
  await rejected(() => db.query("select public.get_seasonal_version_changes_page_v1(null)"), '22023');
  // Non-existent version
  await rejected(() => rpc('get_seasonal_version_changes_page_v1', '$1::uuid', [randomUUID()]), 'P0002');
  // Cross-season comparison rejected
  const fakeOtherSeasonVersion = (await row("select version_id from public.seasonal_publish_versions where season_id <> $1 limit 1", [season]))?.version_id;
  if (fakeOtherSeasonVersion) {
    await rejected(() => rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid', [v2Id, fakeOtherSeasonVersion]), '22023');
  }

  await asWriter();

  // --------------------------------------------------------------------------
  // Check 2: Server-side prior version resolution (p_base_version_id is null)
  //          Comparing V2 with null base resolves automatically to V1!
  // --------------------------------------------------------------------------
  const v2AutoDiff = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,null', [v2Id]);
  assert.equal(v2AutoDiff.version.versionId, v2Id);
  assert.equal(v2AutoDiff.baseVersion.versionId, v1Id, 'Resolved immediately prior version V1 via publish_sequence');
  assert.equal(v2AutoDiff.version.notes, 'Changes in V2');
  assert.equal(v2AutoDiff.baseVersion.notes, 'Initial V1');

  // --------------------------------------------------------------------------
  // Check 3: Explicit same version (p_base_version_id = p_version_id)
  //          Yields 0 changes, 0 entries, unchanged = total flights
  // --------------------------------------------------------------------------
  const sameVersionDiff = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid', [v2Id, v2Id]);
  assert.equal(sameVersionDiff.entries.length, 0);
  assert.equal(sameVersionDiff.hasMore, false);
  assert.equal(sameVersionDiff.nextCursor, null);
  assert.equal(sameVersionDiff.totalRows, 0);
  assert.equal(sameVersionDiff.filteredOccurrenceCount, 0);
  assert.equal(sameVersionDiff.summary.totalChanges, 0);
  assert.equal(sameVersionDiff.summary.added, 0);
  assert.equal(sameVersionDiff.summary.removed, 0);
  assert.equal(sameVersionDiff.summary.modified, 0);
  assert.ok(sameVersionDiff.summary.unchanged > 0, 'Unchanged equals total flights for identical version');

  // --------------------------------------------------------------------------
  // Check 4: Multi-day group spanning page size & date gaps
  //          JX701 was modified on d1, d2, d4 (with gap at d3).
  //          JX703 was added on d2, d3.
  //          JX702 was modified on d1.
  //          Total business changes: 3 groups (JX701 modified, JX702 modified, JX703 added).
  //          Total day occurrences: JX701 (3 days) + JX702 (1 day) + JX703 (2 days) = 6 occurrences.
  // --------------------------------------------------------------------------
  const v2Groups = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50', [v2Id, v1Id, 'groups']);
  assert.equal(v2Groups.summary.totalChanges, 6, 'Full pair summary has 6 total change occurrences');
  assert.equal(v2Groups.summary.modified, 4, '4 modified occurrences (JX701 x3, JX702 x1)');
  assert.equal(v2Groups.summary.added, 2, '2 added occurrences (JX703 x2)');
  assert.equal(v2Groups.summary.removed, 0);
  assert.equal(v2Groups.totalRows, 3, '3 collapsed groups in group view');
  assert.equal(v2Groups.filteredOccurrenceCount, 6, '6 total occurrences represented by 3 groups');

  // Verify JX701 group:
  const jx701Group = v2Groups.entries.find(e => e.flight_number === 'JX701');
  assert.ok(jx701Group, 'JX701 group found');
  assert.equal(jx701Group.change_type, 'modified');
  assert.equal(jx701Group.occurrence_count, 3, 'JX701 occurrence_count is 3');
  assert.deepEqual(jx701Group.dates, [dates.d1, dates.d2, dates.d4], 'Complete sorted distinct dates with d3 gap preserved');
  assert.ok(jx701Group.group_key, 'group_key is populated');
  assert.ok(jx701Group.before_state && jx701Group.after_state, 'Representative raw before/after states present');

  // Verify JX703 group (added):
  const jx703Group = v2Groups.entries.find(e => e.flight_number === 'JX703');
  assert.ok(jx703Group, 'JX703 group found');
  assert.equal(jx703Group.change_type, 'added');
  assert.equal(jx703Group.occurrence_count, 2);
  assert.deepEqual(jx703Group.dates, [dates.d2, dates.d3]);
  // Pagination test with page_size = 1
  const page1 = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,1', [v2Id, v1Id, 'groups']);
  assert.equal(page1.entries.length, 1);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);
  assert.equal(page1.totalRows, 3);
  assert.equal(page1.filteredOccurrenceCount, 6);

  const page2 = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,$4,1', [v2Id, v1Id, 'groups', page1.nextCursor]);
  assert.equal(page2.entries.length, 1);
  assert.equal(page2.hasMore, true);
  assert.ok(page2.nextCursor);
  assert.notEqual(page2.entries[0].group_key, page1.entries[0].group_key, 'Page 2 advances to next distinct group');

  const page3 = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,$4,1', [v2Id, v1Id, 'groups', page2.nextCursor]);
  assert.equal(page3.entries.length, 1);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, null);

  // --------------------------------------------------------------------------
  // Check 5: Exact day expansion via groupKey in days view
  // --------------------------------------------------------------------------
  const expandedDays = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,null,null,null,$5,$6', [
    v2Id, v1Id, 'days', 'all', 'all', jx701Group.group_key
  ]);
  assert.equal(expandedDays.totalRows, 3, 'Exact 3 day rows for JX701 group');
  assert.equal(expandedDays.filteredOccurrenceCount, 3);
  assert.equal(expandedDays.entries.length, 3);
  assert.deepEqual(expandedDays.entries.map(e => e.operational_date), [dates.d1, dates.d2, dates.d4]);
  for (const entry of expandedDays.entries) {
    assert.equal(entry.occurrence_count, 1);
    assert.equal(entry.group_key, jx701Group.group_key);
    assert.equal(entry.after_state.schedule, '09:30');
    assert.equal(entry.before_state.schedule, '08:00');
  }

  // --------------------------------------------------------------------------
  // Check 6: Full totals unaffected by filters (stable pair summary)
  //          When filtering by change_type = 'added', summary still reports
  //          full pair counts (modified: 4, added: 2, total: 6) while totalRows
  //          and filteredOccurrenceCount reflect only added rows.
  // --------------------------------------------------------------------------
  const addedFiltered = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4', [
    v2Id, v1Id, 'groups', 'added'
  ]);
  assert.equal(addedFiltered.summary.totalChanges, 6, 'Summary remains full unfiltered total');
  assert.equal(addedFiltered.summary.added, 2);
  assert.equal(addedFiltered.summary.modified, 4);
  assert.equal(addedFiltered.totalRows, 1, 'Only 1 group matches added filter (JX703)');
  assert.equal(addedFiltered.filteredOccurrenceCount, 2);
  assert.equal(addedFiltered.entries[0].flight_number, 'JX703');

  // --------------------------------------------------------------------------
  // Check 7: Filters: dates, search, and category field
  // --------------------------------------------------------------------------
  // Date filter: only d1
  const dateFiltered = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,null,$5::date,$6::date', [
    v2Id, v1Id, 'groups', 'all', dates.d1, dates.d1
  ]);
  assert.equal(dateFiltered.summary.totalChanges, 6, 'Summary unchanged');
  assert.equal(dateFiltered.filteredOccurrenceCount, 2, '2 occurrences on d1 (JX701 and JX702)');
  assert.equal(dateFiltered.totalRows, 2);

  // Search filter: '702'
  const searchFiltered = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,$5', [
    v2Id, v1Id, 'groups', 'all', '702'
  ]);
  assert.equal(searchFiltered.totalRows, 1);
  assert.equal(searchFiltered.entries[0].flight_number, 'JX702');

  // Field category filter: 'time'
  // JX701 has schedule changed (time), JX702 has only gate changed (other)
  const timeFiltered = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,null,null,null,$5', [
    v2Id, v1Id, 'groups', 'all', 'time'
  ]);
  assert.ok(timeFiltered.entries.some(e => e.flight_number === 'JX701'), 'JX701 included in time filter');
  assert.ok(!timeFiltered.entries.some(e => e.flight_number === 'JX702'), 'JX702 excluded from time filter');

  // Field category filter: 'other'
  const otherFiltered = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,null,null,null,$5', [
    v2Id, v1Id, 'groups', 'all', 'other'
  ]);
  assert.ok(otherFiltered.entries.some(e => e.flight_number === 'JX702'), 'JX702 included in other filter');


  // --------------------------------------------------------------------------
  // Check 8: Canonical Normalization of Diverse Shapes (scalars, arrays, objects)
  //          and stripping of date-bound technical window IDs (internal helper asAdmin)
  // --------------------------------------------------------------------------
  await asAdmin();
  const stateWithScalars = await row(`
    select public.internal_seasonal_normalize_business_state_v1($1::jsonb) as s
  `, [JSON.stringify({
    schedule: '08:00',
    route: 'HAN',
    codeShares: 'VN123, AF456',
    counters: '15, 16',
    checkinWindows: { counter_key: '15', window_start: '06:30', window_end: '08:30' },
  })]);

  const stateWithObjects = await row(`
    select public.internal_seasonal_normalize_business_state_v1($1::jsonb) as s
  `, [JSON.stringify({
    scheduledTime: '08:00',
    route: 'HAN',
    code_shares: ['AF456', 'VN123'],
    counter: [
      { counter_group: 'T1', item_index: 0, counter_value: '15', window_id: 'TECH_ID_D1' },
      { counter_value: '16', item_index: 1, window_id: 'TECH_ID_D1' }
    ],
    checkin_windows: [
      { counter_key: '15', window_start: '06:30', window_end: '08:30', id: 'TECH_DATE_ID' }
    ],
  })]);

  assert.deepEqual(stateWithScalars.s.code_shares, ['AF456', 'VN123'], 'Scalar codeShares string normalized to sorted array');
  assert.deepEqual(stateWithScalars.s.counters, ['15', '16'], 'Scalar counters normalized to sorted array');
  assert.deepEqual(stateWithObjects.s.code_shares, ['AF456', 'VN123'], 'Array code_shares normalized to sorted array');
  assert.deepEqual(stateWithObjects.s.counters, ['15', '16'], 'Object counters normalized and technical window_id stripped');
  assert.deepEqual(stateWithScalars.s.checkin_windows, stateWithObjects.s.checkin_windows, 'Object and array checkin windows normalize to identical shape');

  // --------------------------------------------------------------------------
  // Check 9: Search across both before and after route
  //          JX701 in V1 has route HAN.
  // --------------------------------------------------------------------------
  await asWriter();
  const searchBeforeRoute = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,$5', [
    v2Id, v1Id, 'groups', 'all', 'HAN'
  ]);
  assert.ok(searchBeforeRoute.entries.some(e => e.flight_number === 'JX701'), 'Searching before-route "HAN" finds JX701');

  const searchAfterRoute = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid,$3,null,50,$4,$5', [
    v2Id, v1Id, 'groups', 'all', 'DAD'
  ]);
  assert.ok(searchAfterRoute.entries.some(e => e.flight_number === 'JX703'), 'Searching after-route "DAD" finds JX703');

  // --------------------------------------------------------------------------
  // Check 11: Rollback and Reapply Parity
  // --------------------------------------------------------------------------
  const rollbackUrl = new URL('../migrations/20261011120000_seasonal_version_changes_v1.rollback.sql', import.meta.url);
  const migrationUrl = new URL('../migrations/20261011120000_seasonal_version_changes_v1.sql', import.meta.url);

  await asAdmin();
  await db.exec(await readFile(rollbackUrl, 'utf8'));

  // Function dropped on rollback
  await rejected(() => rpc('get_seasonal_version_changes_page_v1', '$1::uuid', [v2Id]), '42883');

  // Reapply migration
  await db.exec(await readFile(migrationUrl, 'utf8'));

  // Functional after reapply
  await asWriter();
  const postReapply = await rpc('get_seasonal_version_changes_page_v1', '$1::uuid,$2::uuid', [v2Id, v1Id]);
  assert.equal(postReapply.summary.totalChanges, 6, 'Reapplied migration works identically');
  assert.equal(postReapply.totalRows, 3);

  console.log('seasonal_version_changes_pglite: ALL BEHAVIORAL CHECKS PASSED');
} catch (e) {
  throw new Error(`${e.message} [${e.code ?? ''}] ${e.where ?? ''}\n${e.stack ?? ''}`, { cause: e });
} finally {
  if (db) await db.close();
}
