// Behavioral test suite for Operational Recency and Incremental Reporting.
// Covers:
// - Replacement, removal, and zero-flight authority via Native Daily V2
// - Explicit NULL vs 0 Pax preservation and authority precedence
// - Operational date move and cross-year dirty scope tracking
// - Linked overnight counterparts across day boundary
// - Quarantine parity for unresolvable candidate conflicts
// - Preimage rollback and reapply idempotency with exact digest restoration
// - Concurrency and fail-closed mid-refresh writer race safety
// - Reader cutover Gate OFF vs ON canonical mirror parity
// - Full reconciliation parity and periodic reconcile flag

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture } from './seasonal_operational_separation_fixture.mjs';

const INCREMENTAL_MIGRATION_NAME = '20261009100000_operational_incremental_projection_v1.sql';
const INCREMENTAL_ROLLBACK_NAME = '20261009100000_operational_incremental_projection_v1.rollback.sql';

const INCREMENTAL_MIGRATION_URL = new URL(`../migrations/${INCREMENTAL_MIGRATION_NAME}`, import.meta.url);
const INCREMENTAL_ROLLBACK_URL = new URL(`../migrations/${INCREMENTAL_ROLLBACK_NAME}`, import.meta.url);
const MVCC_MIGRATION_NAME = '20261106090000_operational_projection_mvcc_refresh_v1.sql';
const MVCC_ROLLBACK_NAME = '20261106090000_operational_projection_mvcc_refresh_v1.rollback.sql';

const MVCC_MIGRATION_URL = new URL(`../migrations/${MVCC_MIGRATION_NAME}`, import.meta.url);
const MVCC_ROLLBACK_URL = new URL(`../migrations/${MVCC_ROLLBACK_NAME}`, import.meta.url);

const { db, asWriter, asAdmin } = await buildM0Fixture();

await asAdmin();

async function execFile(url) {
  const sql = await readFile(url, 'utf8');
  await asAdmin();
  await db.exec(sql);
}

async function query(sql, params = []) {
  await asAdmin();
  const res = await db.query(sql, params);
  return res.rows;
}

async function scalar(sql, params = []) {
  const r = await query(sql, params);
  return r[0];
}

let reqSequence = 1;
function makeDailyLeg(date, side = 'ARR', flightNumber = 'VN501', time = '06:00', pax = 150) {
  return {
    operationalDate: date,
    scheduledDate: date,
    scheduledTime: time,
    side,
    airline: 'VN',
    flightNumber,
    rawFlightNumber: flightNumber,
    route: 'HAN',
    aircraft: 'A321',
    category: 'C',
    sourceRowNumber: 1,
    sheetName: 'AMS',
    resources: { pax, gate: 3 },
  };
}

async function runDailyImport(legs, dates = [...new Set(legs.map(l => l.operationalDate))], zero = []) {
  await asWriter();
  const payload = {
    contractVersion: 2,
    requestId: `40000000-0000-4000-8000-${String(reqSequence++).padStart(12, '0')}`,
    fileName: 'daily.xlsx',
    workbookProfile: 'ams',
    rawChecksum: 'raw',
    canonicalChecksum: 'canonical',
    resourcePolicyHash: 'policy',
    legs,
    affectedDates: dates,
    confirmedZeroFlightDates: zero,
    diagnostics: [],
  };

  const staged = (await db.query(`select public.stage_daily_schedule_import_v2($1::jsonb) as r`, [JSON.stringify(payload)])).rows[0].r;
  assert.equal(staged.status, 'validated', JSON.stringify(staged.diagnostics));

  const committed = (await db.query(`select public.commit_daily_schedule_import_v2($1::uuid, $2) as r`, [staged.batchId, staged.previewHash])).rows[0].r;
  await asAdmin();
  return committed;
}

try {
  // =========================================================================
  // 1. Rollback & Reapply Idempotency and Preimage Cleanliness
  // =========================================================================
  // A repeated apply must preserve the original callable rollback target.
  const earlierPreimages = (await db.query("select * from reporting.operational_projection_migration_preimages_v1 where migration_tag <> '20261009100000' order by migration_tag, function_schema, function_name, function_signature")).rows;
  await execFile(INCREMENTAL_MIGRATION_URL);
  await execFile(INCREMENTAL_ROLLBACK_URL);

  const dirtyTableGone = await scalar(`
    select count(*)::integer as c from information_schema.tables
    where table_schema = 'reporting' and table_name = 'operational_projection_dirty_scope_v1'
  `);
  assert.equal(dirtyTableGone.c, 0, 'Dirty scope table cleanly removed on rollback');

  assert.deepEqual(
    (await db.query("select * from reporting.operational_projection_migration_preimages_v1 where migration_tag <> '20261009100000' order by migration_tag, function_schema, function_name, function_signature")).rows,
    earlierPreimages,
    'Incremental rollback preserves rollback data owned by other migrations'
  );
  await query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await scalar('select is_fresh from reporting.operational_projection_status_v1()')).is_fresh, true, 'Rollback after repeated apply restores a working original refresh');

  // Re-apply migration cleanly
  await execFile(INCREMENTAL_MIGRATION_URL);

  const dirtyTableExists = await scalar(`
    select count(*)::integer as c from information_schema.tables
    where table_schema = 'reporting' and table_name = 'operational_projection_dirty_scope_v1'
  `);
  assert.equal(dirtyTableExists.c, 1, 'Dirty scope table created on reapply');

  // =========================================================================
  // 2. Initial Baseline and Full Reconciliation Parity
  // =========================================================================
  // Initial baseline refresh
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  const baselineLegs = await query('select * from reporting.operational_canonical_flight_legs order by business_leg_key');
  const baselineQuarantine = await query('select * from reporting.operational_canonical_flight_legs_quarantine order by ops_date');

  // Force full reconciliation and verify exact parity
  await query('select reporting.refresh_operational_canonical_legs_v1(true)');
  const reconciledLegs = await query('select * from reporting.operational_canonical_flight_legs order by business_leg_key');
  const reconciledQuarantine = await query('select * from reporting.operational_canonical_flight_legs_quarantine order by ops_date');

  assert.deepEqual(reconciledLegs, baselineLegs, 'Full reconciliation matches baseline projection legs exactly');
  assert.deepEqual(reconciledQuarantine, baselineQuarantine, 'Full reconciliation matches baseline quarantine exactly');

  // =========================================================================
  // 3. Incremental Replacement & Removal via Native Daily V2 & Dirty Queue
  // =========================================================================
  const testDate = '2026-11-15';

  // Seed two operational legs on testDate via Daily V2
  await runDailyImport([
    makeDailyLeg(testDate, 'ARR', 'VN501', '10:00', 150),
    makeDailyLeg(testDate, 'DEP', 'VN502', '11:00', 180),
  ]);

  // Dirty scope should now contain testDate
  const dirtyDatesBefore = await query('select ops_date::text from reporting.operational_projection_dirty_scope_v1');
  assert.ok(dirtyDatesBefore.some(d => d.ops_date === testDate), 'Leg insertion dirtied the operational date');

  const statusWhileDirty = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  assert.equal(statusWhileDirty.is_fresh, false, 'Pending dirty scope marks projection stale');

  // Incremental refresh should resolve testDate and clear dirty queue
  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const statusAfterRefresh = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  assert.equal(statusAfterRefresh.is_fresh, true, 'Incremental refresh drains queue and marks projection fresh');

  const projectedDay = await query("select flight_number, pax from reporting.operational_canonical_flight_legs where ops_date=$1 order by flight_number", [testDate]);
  assert.deepEqual(projectedDay, [{ flight_number: 'VN501', pax: 150 }, { flight_number: 'VN502', pax: 180 }]);

  // Replacement / Removal: Re-import testDate with only VN501 (VN502 removed)
  await runDailyImport([
    makeDailyLeg(testDate, 'ARR', 'VN501', '10:00', 150),
  ]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  const afterRemoval = await query("select flight_number from reporting.operational_canonical_flight_legs where ops_date=$1 order by flight_number", [testDate]);
  assert.deepEqual(afterRemoval, [{ flight_number: 'VN501' }], 'Removed leg is pruned from projection without full rebuild');

  // Zero-flight Authority: Commit confirmed zero-flight day via Native Daily V2
  await runDailyImport([], [testDate], [testDate]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  const afterZero = await query("select count(*)::integer as c from reporting.operational_canonical_flight_legs where ops_date=$1", [testDate]);
  assert.equal(afterZero[0].c, 0, 'Zero-flight day authority leaves 0 flights in projection');

  // =========================================================================
  // 4. Explicit NULL vs 0 Pax and Authority Precedence
  // =========================================================================
  const paxDate = '2026-11-20';
  await runDailyImport([
    makeDailyLeg(paxDate, 'ARR', 'VN601', '14:00', null),
    makeDailyLeg(paxDate, 'DEP', 'VN602', '15:00', 0),
  ]);

  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const paxResults = await query("select flight_number, pax from reporting.operational_canonical_flight_legs where ops_date=$1 order by flight_number", [paxDate]);
  assert.deepEqual(paxResults, [
    { flight_number: 'VN601', pax: null },
    { flight_number: 'VN602', pax: 0 }
  ], 'Explicit NULL and 0 Pax are preserved distinct');

  // =========================================================================
  // 5. Operational Date Move Across Years
  // =========================================================================
  const oldYearDate = '2026-12-31';
  const newYearDate = '2027-01-01';
  const movingLegId = '33333333-3333-4000-8000-000000000001';

  await query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, source_type, status, pax
    ) values
    ($1, 'A\x1f2026-12-31\x1fVN\x1fVN701', $2, $2, '23:30:00', 'ARR', 'VN', 'VN701', 'HAN-SGN', 'A350', 'operational_manual', 'active', 250)
  `, [movingLegId, oldYearDate]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  // Move leg across midnight and year boundary
  await query(`
    update public.operational_flight_legs set
      operational_date = $2,
      scheduled_date = $2,
      leg_key = 'A\x1f2027-01-01\x1fVN\x1fVN701'
    where leg_id = $1
  `, [movingLegId, newYearDate]);

  const movedDirty = await query('select ops_date::text from reporting.operational_projection_dirty_scope_v1 order by ops_date');
  assert.ok(movedDirty.some(d => d.ops_date === oldYearDate), 'Old date is dirtied on date move');
  assert.ok(movedDirty.some(d => d.ops_date === newYearDate), 'New date is dirtied on date move');

  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const oldYearCount = await scalar("select count(*)::integer as c from reporting.operational_canonical_flight_legs where ops_date=$1", [oldYearDate]);
  const newYearFlight = await query("select flight_number, ops_date::text from reporting.operational_canonical_flight_legs where ops_date=$1", [newYearDate]);

  assert.equal(oldYearCount.c, 0, 'Flight removed from old year date');
  assert.deepEqual(newYearFlight, [{ flight_number: 'VN701', ops_date: '2027-01-01' }], 'Flight added to new year date');

  // =========================================================================
  // 6. Linked Counterparts Across Day Boundary
  // =========================================================================
  const arrDate = '2026-11-25';
  const depDate = '2026-11-26';
  const arrLeg = '44444444-4444-4000-8000-000000000001';
  const depLeg = '44444444-4444-4000-8000-000000000002';

  await query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, source_type, status, linked_leg_id, link_type
    ) values
    ($1, 'A\x1f2026-11-25\x1fVN\x1fVN801', $3, $3, '23:00:00', 'ARR', 'VN', 'VN801', 'SGN-DAD', 'A321', 'operational_manual', 'active', $2, 'overnight'),
    ($2, 'D\x1f2026-11-26\x1fVN\x1fVN802', $4, $4, '06:00:00', 'DEP', 'VN', 'VN802', 'DAD-SGN', 'A321', 'operational_manual', 'active', $1, 'overnight')
  `, [arrLeg, depLeg, arrDate, depDate]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  // Mutating ARR on arrDate must dirty DEP on depDate via linked counterpart
  await query("update public.operational_flight_legs set pax = 99 where leg_id = $1", [arrLeg]);
  const counterpartDirty = await query('select ops_date::text from reporting.operational_projection_dirty_scope_v1');
  assert.ok(counterpartDirty.some(d => d.ops_date === depDate), 'Counterpart date is dirtied across day boundary');
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  // =========================================================================
  // 7. Quarantine Parity
  // =========================================================================
  const qDate = '2026-11-28';
  const qLeg1 = '55555555-5555-4000-8000-000000000001';
  const qLeg2 = '55555555-5555-4000-8000-000000000002';

  // Insert two competing manual legs with identical scheduled-date business key and no recency
  await query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, source_type, status
    ) values
    ($1, 'A\x1f2026-11-28\x1fVN\x1fVN999', $3, $3, '08:00:00', 'ARR', 'VN', 'VN999', 'HAN-SGN', 'A321', 'operational_manual', 'active'),
    ($2, 'A\x1f2026-11-28\x1fVN\x1fVN999', $3, $3, '08:00:00', 'ARR', 'VN', 'VN999', 'HAN-SGN', 'A321', 'operational_manual', 'active')
  `, [qLeg1, qLeg2, qDate]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  const quarantined = await query("select ops_date::text, candidate_count from reporting.operational_canonical_flight_legs_quarantine where ops_date=$1", [qDate]);
  assert.deepEqual(quarantined, [{ ops_date: '2026-11-28', candidate_count: 2 }], 'Tied recency without daily authority isolates day into quarantine');

  const winnerOnQDate = await query("select flight_number from reporting.operational_canonical_flight_legs where ops_date=$1 and flight_number='VN999'", [qDate]);
  assert.equal(winnerOnQDate.length, 0, 'Quarantined flight is excluded from winner legs');

  // =========================================================================
  // 8. Gate OFF vs Gate ON Canonical Mirror Parity
  // =========================================================================
  const isCutoverInitially = (await scalar('select reporting.is_operational_reader_cutover_active_v1() as active')).active;
  assert.equal(isCutoverInitially, false, 'Default cutover gate is OFF');

  const canonicalCountGateOff = (await scalar('select count(*)::integer as c from reporting.canonical_flight_legs')).c;

  // Mutate an operational leg while gate is OFF
  const gateOffDate = '2026-11-30';
  const gateOffLeg = '66666666-6666-4000-8000-000000000001';
  await query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, source_type, status, pax
    ) values ($1, 'A\x1f2026-11-30\x1fVN\x1fVN111', $2, $2, '12:00:00', 'ARR', 'VN', 'VN111', 'SGN-HAN', 'A321', 'operational_manual', 'active', 77)
  `, [gateOffLeg, gateOffDate]);

  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const canonicalCountAfterGateOff = (await scalar('select count(*)::integer as c from reporting.canonical_flight_legs')).c;
  assert.equal(canonicalCountAfterGateOff, canonicalCountGateOff, 'Gate OFF leaves public canonical tables untouched');

  // Cutover to Gate ON
  await query("select reporting.cutover_operational_readers_v1('test-operator')");
  const isCutoverNow = (await scalar('select reporting.is_operational_reader_cutover_active_v1() as active')).active;
  assert.equal(isCutoverNow, true, 'Cutover gate is now ON');

  // Force full reconciliation under Gate ON
  await query('select reporting.refresh_operational_canonical_legs_v1(true)');
  const canonicalCountGateOn = (await scalar('select count(*)::integer as c from reporting.canonical_flight_legs')).c;
  const operationalCountGateOn = (await scalar('select count(*)::integer as c from reporting.operational_canonical_flight_legs')).c;
  assert.equal(canonicalCountGateOn, operationalCountGateOn, 'Gate ON mirrors operational canonical projection completely');

  // Incremental mutation while Gate ON
  const gateOnDate = '2026-12-05';
  const gateOnLeg = '77777777-7777-4000-8000-000000000001';
  await query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, source_type, status, pax
    ) values ($1, 'A\x1f2026-12-05\x1fVN\x1fVN222', $2, $2, '12:00:00', 'ARR', 'VN', 'VN222', 'SGN-HAN', 'A321', 'operational_manual', 'active', 88)
  `, [gateOnLeg, gateOnDate]);

  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const canonicalMirroredLeg = await scalar("select flight_number, pax from reporting.canonical_flight_legs where ops_date=$1 and flight_number='VN222'", [gateOnDate]);
  assert.deepEqual(canonicalMirroredLeg, { flight_number: 'VN222', pax: 88 }, 'Incremental refresh mirrors dirty dates to canonical store when Gate is ON');

  // =========================================================================
  // 9. Fail-Closed Race Condition & Concurrency Guard
  // =========================================================================
  // Simulate mid-refresh writer race
  await asAdmin();
  await db.exec(`
    create or replace function pg_temp.simulated_mid_refresh_race() returns trigger language plpgsql as $$
    begin
      update public.operational_flight_legs set pax = 999 where leg_id = '${gateOnLeg}';
      return null;
    end;
    $$;
    drop trigger if exists test_mid_refresh_race on reporting.operational_canonical_flight_legs;
    create trigger test_mid_refresh_race after insert on reporting.operational_canonical_flight_legs
    for each statement execute function pg_temp.simulated_mid_refresh_race();
  `);
  await query('update public.operational_flight_legs set pax=89 where leg_id=$1', [gateOnLeg]);
  await query('select reporting.refresh_operational_canonical_legs_v1()');

  const racedStatus = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  assert.equal(racedStatus.is_fresh, false, 'Mid-refresh writer fails-closed and remains stale');

  await query('drop trigger if exists test_mid_refresh_race on reporting.operational_canonical_flight_legs');
  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const cleanStatus = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  assert.equal(cleanStatus.is_fresh, true, 'Subsequent refresh catches up and restores freshness');
  assert.deepEqual(await query('select pax from reporting.operational_canonical_flight_legs where flight_number=\'VN222\''), [{ pax: 999 }], 'The raced payload is projected on catch-up');

  // =========================================================================
  // 10. Periodic Reconcile Status
  // =========================================================================
  const reconcileDueInitial = (await scalar('select reporting.operational_projection_reconcile_due_v1() as due')).due;
  assert.equal(reconcileDueInitial, false, 'Fresh reconciled state reports reconcile_due = false');

  // Mark requires_full_reconcile
  await query('update reporting.operational_canonical_flight_legs_state set requires_full_reconcile = true where singleton');
  const afterForcedReconcileStatus = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  const afterForcedReconcileDue = (await scalar('select reporting.operational_projection_reconcile_due_v1() as due')).due;
  assert.equal(afterForcedReconcileStatus.is_fresh, false, 'Full reconcile requirement marks projection stale');
  assert.equal(afterForcedReconcileDue, true, 'Full reconcile requirement reports reconcile_due = true');

  await query('select reporting.refresh_operational_canonical_legs_v1()');
  const afterReconciledRunStatus = await scalar('select is_fresh from reporting.operational_projection_status_v1()');
  const afterReconciledRunDue = (await scalar('select reporting.operational_projection_reconcile_due_v1() as due')).due;
  assert.equal(afterReconciledRunStatus.is_fresh, true, 'Refresh resolves full reconciliation');
  assert.equal(afterReconciledRunDue, false, 'Refresh resets reconcile_due');

  // =========================================================================
  // 11. Forward MVCC Migration, Rollback & Transaction Lock Non-Exclusive Safety
  // =========================================================================
  // Apply MVCC forward migration
  await execFile(MVCC_MIGRATION_URL);

  // Idempotency: re-applying MVCC migration succeeds without drift error
  await execFile(MVCC_MIGRATION_URL);

  // Rollback restores preimage cleanly
  await execFile(MVCC_ROLLBACK_URL);

  // Verify function restored and workable
  await query('select reporting.refresh_operational_canonical_legs_v1(true)');
  assert.equal((await scalar('select is_fresh from reporting.operational_projection_status_v1()')).is_fresh, true, 'Rollback restored operational refresh');

  // Re-apply forward migration
  await execFile(MVCC_MIGRATION_URL);

  // Behavioral test 1: Full reconcile acquires NO AccessExclusiveLock on read-facing tables
  // In a transaction, execute full refresh and check pg_locks for AccessExclusiveLock
  await asAdmin();
  await db.exec('begin;');
  await db.query('select reporting.refresh_operational_canonical_legs_v1(true);');
  const accessExclusiveLocks = await query(`
    select c.relname, l.mode
    from pg_locks l
    join pg_class c on c.oid = l.relation
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting'
      and c.relname in (
        'operational_canonical_flight_legs',
        'operational_canonical_flight_legs_quarantine',
        'canonical_flight_legs',
        'canonical_flight_legs_quarantine',
        'operational_projection_dirty_scope_v1'
      )
      and l.mode = 'AccessExclusiveLock'
  `);
  assert.equal(accessExclusiveLocks.length, 0, 'No AccessExclusiveLock held on projection tables during full reconcile');

  // Verify that RowExclusiveLock IS held (confirming MVCC delete/insert took place)
  const rowExclusiveLocks = await query(`
    select c.relname
    from pg_locks l
    join pg_class c on c.oid = l.relation
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'reporting'
      and c.relname in (
        'operational_canonical_flight_legs',
        'canonical_flight_legs'
      )
      and l.mode = 'RowExclusiveLock'
  `);
  assert.ok(rowExclusiveLocks.length > 0, 'RowExclusiveLock held indicating concurrent-safe MVCC write');
  await db.exec('commit;');

  // Behavioral test 2: Empty-branch full reconciliation behaves identically under MVCC delete
  await asAdmin();
  await db.exec("update public.operational_flight_legs set status='deleted', deletion_reason='mvcc_empty_scope_test', linked_leg_id=null, link_type=null, pair_anchor_date=null;");
  await query('select reporting.refresh_operational_canonical_legs_v1(true)');
  const emptyOperationalCount = (await scalar('select count(*)::integer as c from reporting.operational_canonical_flight_legs')).c;
  const emptyCanonicalCount = (await scalar('select count(*)::integer as c from reporting.canonical_flight_legs')).c;
  const emptyQuarantineCount = (await scalar('select count(*)::integer as c from reporting.operational_canonical_flight_legs_quarantine')).c;
  const emptyDirtyCount = (await scalar('select count(*)::integer as c from reporting.operational_projection_dirty_scope_v1')).c;
  const emptyState = await scalar('select is_fresh, leg_count, quarantine_count from reporting.operational_projection_status_v1()');

  assert.equal(emptyOperationalCount, 0, 'Empty branch clears operational canonical legs');
  assert.equal(emptyCanonicalCount, 0, 'Empty branch clears canonical flight legs mirror');
  assert.equal(emptyQuarantineCount, 0, 'Empty branch clears quarantine table');
  assert.equal(emptyDirtyCount, 0, 'Empty branch drains dirty scope queue');
  assert.equal(emptyState.is_fresh, true, 'Empty branch marks state fresh');
  assert.equal(emptyState.leg_count, 0, 'Empty branch state leg_count is 0');
  assert.equal(emptyState.quarantine_count, 0, 'Empty branch state quarantine_count is 0');
  console.log('Operational Incremental Projection Behavioral Suite PASS: replacement/removal/zero, NULL/0 pax, date move/year, counterpart dirty propagation, quarantine parity, rollback/reapply, fail-closed concurrency races, gate OFF/ON parity, and periodic reconcile.');
} finally {
  await db.close();
}
