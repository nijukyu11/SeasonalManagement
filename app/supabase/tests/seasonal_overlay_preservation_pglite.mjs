import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const chain = [
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
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260906011000_active_seasonal_export_snapshot.sql',
  '../migrations/20260914090000_daily_loose_identity_live_row_precedence.sql',
  '../migrations/20260915100000_canonical_overlay_deletion_authority.sql',
  '../migrations/20260920170000_seasonal_import_daily_duplicate_guard.sql',
  '../migrations/20260920230000_seasonal_import_daily_guard_kind_classification.sql',
  '../migrations/20260920235500_seasonal_replace_selective_manual_supersede.sql',
  '../migrations/20260920235900_bound_seasonal_commit_replace_temp_update.sql',
  '../migrations/20260920235950_seasonal_import_rpc_statement_timeout.sql',
];

const seasonId = 'season-test-preservation-001';
const writerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db = await createSupabasePGlite();
try {
  for (const rel of chain) {
    const sql = await readFile(new URL(rel, import.meta.url), 'utf8');
    await db.exec(sql);
  }

  // Setup operators and season
  await db.exec(`
    insert into auth.users (id, email) values ('${writerId}', 'writer@example.test')
    on conflict do nothing;
    insert into public.app_operators (user_id, email, username, display_name)
    values ('${writerId}', 'writer@example.test', 'writer', 'Writer')
    on conflict do nothing;
    insert into public.app_operator_permission_overrides (user_id, permission_key, effect) values
      ('${writerId}', 'seasonal.read', 'allow'),
      ('${writerId}', 'seasonal.write', 'allow'),
      ('${writerId}', 'season.repair', 'allow')
    on conflict do nothing;

    insert into public.seasons (id, season_code, name, uploaded_at, data_version) values
      ('${seasonId}', 'W26', 'W26', 0, 0)
    on conflict do nothing;
  `);
  const setAuth = async () => {
    await db.exec(`set role authenticated`);
    await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [writerId]);
  };

  // Helper to build stage payload
  const makePayload = (requestId, strategy, expectedVersion, sourceRows) => ({
    contractVersion: 3,
    requestId,
    checksum: `checksum-${requestId}`,
    strategy,
    seasonId,
    seasonCode: 'W26',
    expectedDataVersion: expectedVersion,
    fileName: 'W26_test.xlsx',
    sourceRows,
  });

  const rowJX701 = {
    rowIndex: 1,
    effective: '2026-10-25',
    discontinue: '2026-10-25',
    airline: 'JX',
    aircraft: '321',
    daysOfWeek: [false, false, false, false, false, false, true],
    sta: '10:00',
    arrFlight: '701',
    arrFlightType: 'PAX',
    arrRoute: 'TPE',
    arrFlightCategory: 'J',
    arrIntDomInd: 'I',
  };

  const rowJX703 = {
    rowIndex: 2,
    effective: '2026-10-25',
    discontinue: '2026-10-25',
    airline: 'JX',
    aircraft: '321',
    daysOfWeek: [false, false, false, false, false, false, true],
    sta: '18:00',
    arrFlight: '703',
    arrFlightType: 'PAX',
    arrRoute: 'TPE',
    arrFlightCategory: 'J',
    arrIntDomInd: 'I',
  };

  // 1. Stage and commit batch 1 (initial schedule with JX701 and JX703)
  await setAuth();
  const stage1Res = await db.query(
    `select public.stage_seasonal_import_v3($1::jsonb) as res`,
    [JSON.stringify(makePayload('11111111-1111-4111-8111-111111111111', 'replace', 0, [rowJX701, rowJX703]))]
  );
  const stage1 = stage1Res.rows[0].res;
  assert.equal(stage1.status, 'validated');
  const batch1Id = stage1.batchId;

  await setAuth();
  const commit1Res = await db.query(
    `select public.commit_seasonal_import_v3($1, $2, $3) as res`,
    [batch1Id, 0, stage1.previewHash]
  );
  assert.equal(commit1Res.rows[0].res.status, 'committed');

  // Check that both legs exist and are active
  const legs1 = (await db.query(
    `select record_id, flight_number, status, action, deletion_reason 
     from public.season_flight_records 
     where season_id = $1 and source_kind = 'seasonal'`,
    [seasonId]
  )).rows;
  assert.equal(legs1.length, 2);
  const leg701 = legs1.find(l => l.flight_number === 'JX701');
  const leg703 = legs1.find(l => l.flight_number === 'JX703');
  assert.ok(leg701 && leg701.status === 'active');
  assert.ok(leg703 && leg703.status === 'active');

  // 2. User modifies JX701 (adds counter, gate, stand, pax)
  await db.exec(`reset role;`);
  await db.exec(`
    insert into public.season_modifications (
      season_id, leg_id, action, changed_fields, gate, stand, carousel, pax,
      check_in_start, check_in_end, check_in_allocation_mode
    ) values (
      '${seasonId}', '${leg701.record_id}', 'modified',
      array['gate', 'stand', 'carousel', 'pax', 'counter', 'checkInStart', 'checkInEnd', 'checkInAllocationMode'],
      20, '31', '4', 180, '08:00', '09:30', 'grouped'
    );
    insert into public.season_modification_counters (leg_id, counter_group, item_index, counter_value)
    values ('${leg701.record_id}', 'A', 0, '21');
    insert into public.season_modification_checkin_windows (leg_id, counter_key, window_start, window_end)
    values ('${leg701.record_id}', '21', '08:00', '09:30');
  `);

  // 3. User deletes JX703 (via canonical modification delete)
  await db.exec(`
    insert into public.season_modifications (season_id, leg_id, action, changed_fields)
    values ('${seasonId}', '${leg703.record_id}', 'deleted', '{}');
    update public.season_flight_records
    set status = 'deleted', action = 'deleted', deletion_reason = 'overlay_deleted',
        lifecycle_changed_at = now()
    where record_id = '${leg703.record_id}';
  `);

  console.log('Setup state complete. JX701 has modifications, JX703 is deleted.');
  // Apply the patch to commit_seasonal_import_v3 from migration file
  await db.exec(`reset role;`);
  const patchSql = await readFile(
    new URL('../migrations/20260921003000_seasonal_selective_preservation_and_import_schedule_precedence.sql', import.meta.url),
    'utf8'
  );
  await db.exec(patchSql);
  console.log('Patch successfully applied to commit_seasonal_import_v3.');

  // 4. Now test what happens when we re-import the season file containing JX701 and JX703 (Replace mode)
  const stage2Res = await db.query(
    `select public.stage_seasonal_import_v3($1::jsonb) as res`,
    [JSON.stringify(makePayload('22222222-2222-4222-8222-222222222222', 'replace', 1, [rowJX701, rowJX703]))]
  );
  const stage2 = stage2Res.rows[0].res;
  assert.equal(stage2.status, 'validated');
  const batch2Id = stage2.batchId;

  await setAuth();
  const commit2Res = await db.query(
    `select public.commit_seasonal_import_v3($1, $2, $3) as res`,
    [batch2Id, 1, stage2.previewHash]
  );
  console.log('Commit 2 result:', commit2Res.rows[0].res);

  // Check state of active records
  const activeLegs = (await db.query(
    `select record_id, flight_number, status, action, deletion_reason, source_import_batch_id
     from public.season_flight_records 
     where season_id = $1 and status = 'active'`,
    [seasonId]
  )).rows;
  console.log('Active legs after commit 2:', activeLegs);

  const allLegsBatch2 = (await db.query(
    `select record_id, flight_number, status, action, deletion_reason, source_import_batch_id
     from public.season_flight_records 
     where source_import_batch_id = $1`,
    [batch2Id]
  )).rows;
  console.log('All legs in batch 2:', allLegsBatch2);

  const newLeg701 = activeLegs.find(l => l.flight_number === 'JX701');
  const newLeg703 = activeLegs.find(l => l.flight_number === 'JX703');

  assert.ok(newLeg701, 'JX701 must be active');
  assert.ok(newLeg703, 'JX703 must be active because the incoming schedule contains it');
  assert.equal(newLeg703.status, 'active');
  assert.equal(newLeg703.action, null);
  assert.equal(newLeg703.deletion_reason, null);

  const mod701 = (await db.query(
    `select * from public.season_modifications where leg_id = $1`,
    [newLeg701.record_id]
  )).rows[0];
  const counters701 = (await db.query(
    `select * from public.season_modification_counters where leg_id = $1`,
    [newLeg701.record_id]
  )).rows;
  console.log('Preserved mod for JX701:', mod701);
  console.log('Preserved counters for JX701:', counters701);
  assert.equal(mod701.pax, 180);
  assert.equal(mod701.gate, 20);
  assert.equal(mod701.stand, '31');
  assert.equal(mod701.carousel, 4);
  assert.equal(counters701.length, 1);
  assert.equal(counters701[0].counter_value, '21');

  const remainingMods = (await db.query(
    `select * from public.season_modifications where season_id = $1`,
    [seasonId]
  )).rows;
  assert.equal(remainingMods.filter(m => m.action === 'deleted').length, 0);
  assert.equal(remainingMods.filter(m => m.leg_id === newLeg701.record_id).length, 1);
  console.log('ALL REPLACE ASSERTIONS PASSED!');

  // 5. Test Merge strategy:
  // In a new season, we have:
  // - JX801 (active, with counter/gate modifications)
  // - JX802 (deleted by user)
  // - JX803 (deleted by user)
  // Merge file contains JX801 and JX802 only (JX802 is re-added by merge, JX803 is untouched outside merge scope).
  const seasonMergeId = 'season-test-preservation-merge';
  await db.exec(`reset role;`);
  await db.exec(`
    insert into public.seasons (id, season_code, name, uploaded_at, data_version) values
      ('${seasonMergeId}', 'M26', 'M26', 0, 0)
    on conflict do nothing;
  `);
  const rowJX801 = { ...rowJX701, arrFlight: '801' };
  const rowJX802 = { ...rowJX703, arrFlight: '802' };
  const rowJX803 = { ...rowJX703, arrFlight: '803', rowIndex: 3 };

  // Initial setup for merge season
  await setAuth();
  const stageMerge1Res = await db.query(
    `select public.stage_seasonal_import_v3($1::jsonb) as res`,
    [JSON.stringify({
      contractVersion: 3,
      requestId: '33333333-3333-4333-8333-333333333333',
      checksum: 'checksum-33333333',
      strategy: 'replace',
      seasonId: seasonMergeId,
      seasonCode: 'M26',
      expectedDataVersion: 0,
      fileName: 'M26_test.xlsx',
      sourceRows: [rowJX801, rowJX802, rowJX803],
    })]
  );
  const batchMerge1Id = stageMerge1Res.rows[0].res.batchId;
  await setAuth();
  await db.query(
    `select public.commit_seasonal_import_v3($1, $2, $3) as res`,
    [batchMerge1Id, 0, stageMerge1Res.rows[0].res.previewHash]
  );

  const legsMerge1 = (await db.query(
    `select record_id, flight_number from public.season_flight_records where season_id = $1 and status = 'active'`,
    [seasonMergeId]
  )).rows;
  const leg801 = legsMerge1.find(l => l.flight_number === 'JX801');
  const leg802 = legsMerge1.find(l => l.flight_number === 'JX802');
  const leg803 = legsMerge1.find(l => l.flight_number === 'JX803');

  // User modifies JX801 (gate, stand, pax, counter)
  await db.exec(`reset role;`);
  await db.exec(`
    insert into public.season_modifications (
      season_id, leg_id, action, changed_fields, gate, stand, pax
    ) values (
      '${seasonMergeId}', '${leg801.record_id}', 'modified',
      array['gate', 'stand', 'pax'],
      12, '15', 200
    );
    insert into public.season_modification_counters (leg_id, counter_group, item_index, counter_value)
    values ('${leg801.record_id}', 'B', 0, '15');
  `);

  // User deletes JX802 and JX803
  await db.exec(`
    insert into public.season_modifications (season_id, leg_id, action, changed_fields)
    values ('${seasonMergeId}', '${leg802.record_id}', 'deleted', '{}'),
           ('${seasonMergeId}', '${leg803.record_id}', 'deleted', '{}');
    update public.season_flight_records
    set status = 'deleted', action = 'deleted', deletion_reason = 'overlay_deleted'
    where record_id in ('${leg802.record_id}', '${leg803.record_id}');
  `);

  // Now Merge file only contains JX801 and JX802 (re-adding JX802; JX803 is not in file)
  await setAuth();
  const stageMerge2Res = await db.query(
    `select public.stage_seasonal_import_v3($1::jsonb) as res`,
    [JSON.stringify({
      contractVersion: 3,
      requestId: '44444444-4444-4444-8444-444444444444',
      checksum: 'checksum-44444444',
      strategy: 'merge',
      seasonId: seasonMergeId,
      seasonCode: 'M26',
      expectedDataVersion: 1,
      fileName: 'M26_partial.xlsx',
      sourceRows: [rowJX801, rowJX802],
    })]
  );
  const stageMerge2 = stageMerge2Res.rows[0].res;
  assert.equal(stageMerge2.status, 'validated');
  const batchMerge2Id = stageMerge2.batchId;

  await setAuth();
  const commitMerge2Res = await db.query(
    `select public.commit_seasonal_import_v3($1, $2, $3) as res`,
    [batchMerge2Id, 1, stageMerge2.previewHash]
  );
  assert.equal(commitMerge2Res.rows[0].res.status, 'committed');

  const activeLegsMerge = (await db.query(
    `select record_id, flight_number, status, action, deletion_reason 
     from public.season_flight_records 
     where season_id = $1 and status = 'active'`,
    [seasonMergeId]
  )).rows;
  console.log('Active legs after merge commit:', activeLegsMerge);

  const active801 = activeLegsMerge.find(l => l.flight_number === 'JX801');
  const active802 = activeLegsMerge.find(l => l.flight_number === 'JX802');
  const active803 = activeLegsMerge.find(l => l.flight_number === 'JX803');

  assert.ok(active801, 'JX801 must be active');
  assert.ok(active802, 'JX802 must be active (re-added by merge schedule)');
  assert.equal(active803, undefined, 'JX803 must remain deleted (outside merge scope)');

  const mod801 = (await db.query(
    `select * from public.season_modifications where leg_id = $1`,
    [active801.record_id]
  )).rows[0];
  assert.equal(mod801.gate, 12);
  assert.equal(mod801.stand, '15');
  assert.equal(mod801.pax, 200);

  console.log('ALL MERGE ASSERTIONS PASSED!');
} finally {
  await db.close();
}
