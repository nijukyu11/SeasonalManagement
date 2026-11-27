// app/supabase/tests/production_readiness_inventory_reconciliation_pglite.mjs
//
// Behavioral test suite for:
// 1. scripts/inventory-production-db-readonly.sql
// 2. scripts/reconcile-production-db-readonly.sql
//
// Covers:
// - Bounded inventory execution against populated post-backfill DB.
// - Bounded inventory execution against bare legacy DB (proving safety when all M1+ tables are absent).
// - Post-backfill pre-cutover reconciliation PASS on healthy fixture.
// - Sensitivity/Fail-closed verification:
//   * Pax drift detection
//   * Occurrence count / leg omission detection via EXCEPT ALL
//   * Quarantine drift detection
//   * Day authority drift detection

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildM0Fixture,
  M0_FIXTURE,
} from './seasonal_operational_separation_fixture.mjs';
import {
  createSeasonalOperationalSeparationDb,
  stripPsqlMetaCommands,
} from './seasonal_operational_separation_test_support.mjs';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const INVENTORY_SQL_URL = new URL('../../../scripts/inventory-production-db-readonly.sql', import.meta.url);
const RECONCILIATION_SQL_URL = new URL('../../../scripts/reconcile-production-db-readonly.sql', import.meta.url);

const inventorySql = stripPsqlMetaCommands(await readFile(INVENTORY_SQL_URL, 'utf8'));
const reconciliationSql = stripPsqlMetaCommands(await readFile(RECONCILIATION_SQL_URL, 'utf8'));

// ----------------------------------------------------------------------------
// Phase 1: Setup Populated Post-Backfill DB Fixture
// ----------------------------------------------------------------------------
console.log('--- Phase 1: Building M0 Fixture, Backfill & Projection ---');
const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const writerId = M0_FIXTURE.writerId;

// Run M2 backfill to populate operational flight legs, day authority, drafts, and baseline versions
await asWriter();
await db.query(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid) as result`, ['2026-10-01', writerId]);
await asAdmin();

// Refresh operational canonical legs projection (M3)
await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);

// ----------------------------------------------------------------------------
// Phase 2: Bounded Inventory on Populated Database
// ----------------------------------------------------------------------------
console.log('--- Phase 2: Testing Bounded Inventory on Populated DB ---');
// Executing inventory SQL must complete without throwing any error
await db.exec(inventorySql);

// Verify that inventory correctly detects operational and planning tables
const tableInventory = (
  await db.query(`
    select target.tablename,
           (to_regclass(format('%I.%I', target.schemaname, target.tablename)) is not null) as is_present
    from (
      values
        ('public', 'operational_flight_legs'),
        ('public', 'seasonal_flight_drafts'),
        ('public', 'operational_day_authority'),
        ('reporting', 'operational_canonical_flight_legs'),
        ('reporting', 'canonical_flight_legs')
    ) as target(schemaname, tablename)
  `)
).rows;

for (const row of tableInventory) {
  assert.equal(row.is_present, true, `Table ${row.tablename} must be detected as present in populated DB`);
}

// ----------------------------------------------------------------------------
// Phase 3: Bounded Inventory on Bare Baseline (Missing All New Tables)
// ----------------------------------------------------------------------------
console.log('--- Phase 3: Testing Bounded Inventory on Bare Baseline DB ---');
const bareDb = await createSupabasePGlite();
try {
  await bareDb.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));

  // Ensure M1+ tables do NOT exist on this bare baseline
  const opLegsCheck = (
    await bareDb.query(`select to_regclass('public.operational_flight_legs') is not null as present`)
  ).rows[0].present;
  assert.equal(opLegsCheck, false, 'Bare baseline must lack operational_flight_legs');

  // Executing inventory SQL on bare baseline MUST succeed without throwing 42P01
  await bareDb.exec(inventorySql);

  const bareTableInventory = (
    await bareDb.query(`
      select target.tablename,
             (to_regclass(format('%I.%I', target.schemaname, target.tablename)) is not null) as is_present
      from (
        values
          ('public', 'operational_flight_legs'),
          ('public', 'seasonal_flight_drafts'),
          ('public', 'seasons')
      ) as target(schemaname, tablename)
    `)
  ).rows;

  const seasonsRow = bareTableInventory.find((r) => r.tablename === 'seasons');
  const opLegsRow = bareTableInventory.find((r) => r.tablename === 'operational_flight_legs');
  assert.equal(seasonsRow.is_present, true, 'seasons core table must be present');
  assert.equal(opLegsRow.is_present, false, 'operational_flight_legs must be safely reported as absent');
} finally {
  await bareDb.close();
}

// ----------------------------------------------------------------------------
// Phase 4: Post-Backfill Pre-Cutover Reconciliation on Healthy Fixture (PASS)
// ----------------------------------------------------------------------------
console.log('--- Phase 4: Testing Reconciliation SQL on Healthy Fixture ---');
// Executing reconciliation SQL on healthy fixture must succeed without throwing
await db.exec(reconciliationSql);

// Verify individual check results directly
const summaryRows = (
  await db.query(`
    with
    canonical_legs as (
      select business_leg_key, ops_date, type, airline, flight_number, route,
             aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
      from reporting.canonical_flight_legs
    ),
    operational_legs as (
      select business_leg_key, ops_date, type, airline, flight_number, route,
             aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
      from reporting.operational_canonical_flight_legs
    ),
    diff_c_minus_o as (
      select * from canonical_legs except all select * from operational_legs
    ),
    diff_o_minus_c as (
      select * from operational_legs except all select * from canonical_legs
    ),
    diff_quar_c_minus_o as (
      select ops_date, candidate_count from reporting.canonical_flight_legs_quarantine
      except all
      select ops_date, candidate_count from reporting.operational_canonical_flight_legs_quarantine
    ),
    diff_quar_o_minus_c as (
      select ops_date, candidate_count from reporting.operational_canonical_flight_legs_quarantine
      except all
      select ops_date, candidate_count from reporting.canonical_flight_legs_quarantine
    ),
    legacy_auth as (
      select distinct on (scopes.ops_date)
        scopes.ops_date as operational_date, 'daily_import'::text as authority_source,
        scopes.source_batch_id, scopes.expected_leg_count as leg_count, scopes.canonical_checksum, (scopes.reset_at is not null) as is_reset
      from public.schedule_replacement_scopes scopes
      order by scopes.ops_date, scopes.committed_at desc, scopes.data_version desc, scopes.season_id
    ),
    operational_auth as (
      select operational_date, authority_source, source_batch_id, leg_count, canonical_checksum, (reset_at is not null) as is_reset
      from public.operational_day_authority
    ),
    diff_auth_l_minus_o as (
      select * from legacy_auth except all select * from operational_auth
    ),
    diff_auth_o_minus_l as (
      select * from operational_auth except all select * from legacy_auth
    )
    select
      (select count(*) from diff_c_minus_o) as legs_c_minus_o,
      (select count(*) from diff_o_minus_c) as legs_o_minus_c,
      (select count(*) from diff_quar_c_minus_o) as quar_c_minus_o,
      (select count(*) from diff_quar_o_minus_c) as quar_o_minus_c,
      (select count(*) from diff_auth_l_minus_o) as auth_l_minus_o,
      (select count(*) from diff_auth_o_minus_l) as auth_o_minus_l
  `)
).rows[0];

assert.equal(Number(summaryRows.legs_c_minus_o), 0, 'EXCEPT ALL Canonical minus Operational must be 0');
assert.equal(Number(summaryRows.legs_o_minus_c), 0, 'EXCEPT ALL Operational minus Canonical must be 0');
assert.equal(Number(summaryRows.quar_c_minus_o), 0, 'EXCEPT ALL Quarantine Canonical minus Operational must be 0');
assert.equal(Number(summaryRows.quar_o_minus_c), 0, 'EXCEPT ALL Quarantine Operational minus Canonical must be 0');
assert.equal(Number(summaryRows.auth_l_minus_o), 0, 'EXCEPT ALL Authority Legacy minus Operational must be 0');
assert.equal(Number(summaryRows.auth_o_minus_l), 0, 'EXCEPT ALL Authority Operational minus Legacy must be 0');

// A missing backfill-link table was previously reported as a prerequisite
// failure but did not participate in the reconciliation guard.
console.log('  4.1: Testing Required Backfill-Link Prerequisite');
await db.exec('alter table public.operational_leg_backfill_links rename to operational_leg_backfill_links_test_missing');
try {
  await assert.rejects(
    async () => {
      await db.exec(reconciliationSql);
    },
    (err) => {
      assert.match(err.message, /POST_BACKFILL_RECONCILIATION_PREREQUISITE_MISSING/);
      return true;
    },
    'Reconciliation must fail closed when the backfill-link prerequisite is absent'
  );
} finally {
  await db.exec('alter table public.operational_leg_backfill_links_test_missing rename to operational_leg_backfill_links');
}

// Verify the fixture remains healthy after restoring the prerequisite.
await db.exec(reconciliationSql);

// ----------------------------------------------------------------------------
// Phase 5: Sensitivity & Fail-Closed Mutation Probes
// ----------------------------------------------------------------------------
console.log('--- Phase 5: Testing Mutation Sensitivity / Fail-Closed Guard ---');

// 5.1 Pax Drift Mutation
console.log('  5.1: Testing Pax Drift Sensitivity');
const targetLeg = (
  await db.query(`select business_leg_key, pax from reporting.operational_canonical_flight_legs limit 1`)
).rows[0];
const originalPax = targetLeg.pax;

await db.query(
  `update reporting.operational_canonical_flight_legs set pax = 999 where business_leg_key = $1`,
  [targetLeg.business_leg_key]
);

await assert.rejects(
  async () => {
    await db.exec(reconciliationSql);
  },
  (err) => {
    assert.match(err.message, /POST_BACKFILL_RECONCILIATION_FAILED/);
    return true;
  },
  'Reconciliation must fail closed on Pax drift'
);

// Restore original Pax
await db.query(
  `update reporting.operational_canonical_flight_legs set pax = $1 where business_leg_key = $2`,
  [originalPax, targetLeg.business_leg_key]
);

// Verify healthy again
await db.exec(reconciliationSql);

// 5.2 Leg Omission / Count Mismatch Mutation
console.log('  5.2: Testing Leg Count / Omission Sensitivity');
await db.exec('begin');
await db.query('delete from reporting.operational_canonical_flight_legs where business_leg_key = $1', [targetLeg.business_leg_key]);

await assert.rejects(
  async () => {
    await db.exec(reconciliationSql);
  },
  (err) => {
    assert.match(err.message, /POST_BACKFILL_RECONCILIATION_FAILED/);
    return true;
  },
  'Reconciliation must fail closed on missing leg'
);

await db.exec('rollback');

// Verify healthy again
await db.exec(reconciliationSql);

// 5.3 Quarantine Drift Mutation
console.log('  5.3: Testing Quarantine Drift Sensitivity');
await db.query(
  `insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
   values ('2099-01-01', 5)`
);

await assert.rejects(
  async () => {
    await db.exec(reconciliationSql);
  },
  (err) => {
    assert.match(err.message, /POST_BACKFILL_RECONCILIATION_FAILED/);
    return true;
  },
  'Reconciliation must fail closed on quarantine drift'
);

// Remove synthetic quarantine row
await db.query(`delete from reporting.operational_canonical_flight_legs_quarantine where ops_date = '2099-01-01'`);

// Verify healthy again
await db.exec(reconciliationSql);

// 5.4 Day Authority Drift Mutation
console.log('  5.4: Testing Day Authority Drift Sensitivity');
const authRow = (
  await db.query(`select operational_date, leg_count from public.operational_day_authority limit 1`)
).rows[0];
const origLegCount = authRow.leg_count;

await db.query(
  `update public.operational_day_authority set leg_count = leg_count + 10 where operational_date = $1`,
  [authRow.operational_date]
);

await assert.rejects(
  async () => {
    await db.exec(reconciliationSql);
  },
  (err) => {
    assert.match(err.message, /POST_BACKFILL_RECONCILIATION_FAILED/);
    return true;
  },
  'Reconciliation must fail closed on day authority drift'
);

// Restore original leg count
await db.query(
  `update public.operational_day_authority set leg_count = $1 where operational_date = $2`,
  [origLegCount, authRow.operational_date]
);

// Final verification of healthy baseline
await db.exec(reconciliationSql);

await ctx.close();
console.log('--- ALL BEHAVIORAL INVENTORY & RECONCILIATION TESTS PASSED ---');
