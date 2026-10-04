import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const schemaSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationSql = await readFile(new URL('../migrations/20260822090000_public_traffic_report_v1.sql', import.meta.url), 'utf8');
const phase23Sql = await readFile(new URL('../migrations/20260822150000_public_traffic_report_phase23.sql', import.meta.url), 'utf8');
const operationalV2Sql = await readFile(new URL('../migrations/20260829130000_public_traffic_report_operational_v2.sql', import.meta.url), 'utf8');
const aircraftSnapshotFixtureSql = await readFile(new URL('./fixtures/public_traffic_effective_aircraft_snapshot.sql', import.meta.url), 'utf8');
const canonicalSourceSql = await readFile(new URL('../migrations/20260829173000_public_traffic_report_canonical_source.sql', import.meta.url), 'utf8');
const paxPresenceSql = await readFile(new URL('../migrations/20260829210000_public_traffic_report_pax_presence_contract.sql', import.meta.url), 'utf8');
const aircraftTypeSql = await readFile(new URL('../migrations/20260830200000_public_traffic_report_aircraft_type_contract.sql', import.meta.url), 'utf8');
const removeSuppressionSql = await readFile(new URL('../migrations/20260830213000_public_traffic_report_remove_suppression.sql', import.meta.url), 'utf8');
const regularFlightsSql = await readFile(new URL('../migrations/20260831120000_public_traffic_report_regular_flights.sql', import.meta.url), 'utf8');
const annualPassengerKpiSql = await readFile(new URL('../migrations/20260831150000_public_annual_passenger_kpi.sql', import.meta.url), 'utf8');
const annualPassengerKpiOwnerSql = await readFile(new URL('../migrations/20260831190000_annual_passenger_kpi_owner.sql', import.meta.url), 'utf8');
const liveCandidateSliceSql = await readFile(new URL('../migrations/20260831205000_public_traffic_candidate_slice_v1.sql', import.meta.url), 'utf8');
const liveAggregateV2Sql = await readFile(new URL('../migrations/20260831210000_public_traffic_live_aggregate_v2.sql', import.meta.url), 'utf8');
const dashboardDailyPublicationSql = await readFile(new URL('../migrations/20260901090000_public_dashboard_daily_publication.sql', import.meta.url), 'utf8');
const dashboardTimelineQualitySql = await readFile(new URL('../migrations/20260901113000_public_dashboard_publication_timeline_quality.sql', import.meta.url), 'utf8');
const dailyAcceptanceSql = await readFile(new URL('../migrations/20260901114500_public_traffic_daily_acceptance.sql', import.meta.url), 'utf8');
const dashboardHybridRunnerSql = await readFile(new URL('../migrations/20260901123000_public_dashboard_hybrid_runner.sql', import.meta.url), 'utf8');
const dashboardPaxCorrectionSql = await readFile(new URL('../migrations/20260902150000_public_dashboard_pax_correction.sql', import.meta.url), 'utf8');
const coverageCountsSql = await readFile(new URL('../migrations/20260911120000_public_traffic_report_coverage_counts.sql', import.meta.url), 'utf8');
const flightCategorySql = await readFile(new URL('../migrations/20260920150000_public_traffic_report_flight_category.sql', import.meta.url), 'utf8');
const flightCategoryBinarySql = await readFile(new URL('../migrations/20260920183000_public_traffic_report_flight_category_binary.sql', import.meta.url), 'utf8');

const storeMigrationSql = await readFile(new URL('../migrations/20260925120000_public_traffic_canonical_legs_store.sql', import.meta.url), 'utf8');
const storeRollbackSql = await readFile(new URL('../migrations/20260925120000_public_traffic_canonical_legs_store.rollback.sql', import.meta.url), 'utf8');

const accelMigrationSql = await readFile(new URL('../migrations/20260925121500_public_traffic_canonical_legs_acceleration.sql', import.meta.url), 'utf8');
const accelRollbackSql = await readFile(new URL('../migrations/20260925121500_public_traffic_canonical_legs_acceleration.rollback.sql', import.meta.url), 'utf8');

const db = await createSupabasePGlite();

try {
  await db.exec(schemaSql);
  await db.exec(migrationSql);
  await db.exec(phase23Sql);
  await db.exec(operationalV2Sql);
  await db.exec(aircraftSnapshotFixtureSql);
  await db.exec(`
    create or replace function public.is_canonical_flight_leg_active_v1(
      p_status text,p_action text
    ) returns boolean language sql immutable as $$
      select p_status = 'active' and p_action is distinct from 'deleted'
    $$;
    create or replace function public.canonical_flight_leg_ops_date_v1(
      p_operational_date text,p_scheduled_date text,p_date text,p_scheduled_time text,p_schedule text
    ) returns date language sql immutable as $$
      select coalesce(nullif(p_operational_date,'')::date,
        coalesce(nullif(p_scheduled_date,''),nullif(p_date,''))::date
          - case when coalesce(nullif(p_scheduled_time,''),p_schedule)::time < time '05:00' then 1 else 0 end)
    $$;
    create or replace view reporting.canonical_effective_flight_legs as
    select effective.*,seasons.data_version as source_data_version
    from reporting.effective_flight_operations effective
    join public.seasons seasons on seasons.id=effective.season_id;
  `);
  await db.exec(canonicalSourceSql);
  await db.exec(paxPresenceSql);
  await db.exec(aircraftTypeSql);
  await db.exec(removeSuppressionSql);
  await db.exec(regularFlightsSql);
  await db.exec(annualPassengerKpiSql);
  await db.exec(annualPassengerKpiOwnerSql);
  await db.exec(liveCandidateSliceSql);
  await db.exec(liveAggregateV2Sql);
  await db.exec(dashboardDailyPublicationSql);
  await db.exec(dashboardTimelineQualitySql);
  await db.exec(dailyAcceptanceSql);
  await db.exec(dashboardHybridRunnerSql);
  await db.exec(dashboardPaxCorrectionSql);
  await db.exec(coverageCountsSql);
  await db.exec(flightCategorySql);
  await db.exec(flightCategoryBinarySql);

  // Check pre-migration MD5
  const preDigest = (await db.query(`
    select md5(pg_get_functiondef('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure)) as md5;
  `)).rows[0].md5;

  assert.equal(preDigest, '425805e862bfd3e0551fa8d5c814ec4b', 'Pre-digest must match production exactly');

  // Apply File A: store
  await db.exec(storeMigrationSql);

  // Verify table exists
  const tableExists = (await db.query(`
    select count(*) as cnt from information_schema.tables 
    where table_schema = 'reporting' and table_name = 'canonical_flight_legs';
  `)).rows[0].cnt;
  assert.equal(Number(tableExists), 1, 'reporting.canonical_flight_legs must exist after store migration');

  // Apply File B: acceleration
  await db.exec(accelMigrationSql);

  const postDigest = (await db.query(`
    select md5(pg_get_functiondef('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure)) as md5;
  `)).rows[0].md5;

  assert.equal(postDigest, 'cc32feac705426cdd309359e447e4bb0', 'Post-digest must match expected accelerated function MD5');

  // Rollback File B
  await db.exec(accelRollbackSql);

  const restoredDigest = (await db.query(`
    select md5(pg_get_functiondef('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure)) as md5;
  `)).rows[0].md5;

  assert.equal(restoredDigest, preDigest, 'Rollback B must restore pre-digest byte-exactly');

  // Rollback File A
  await db.exec(storeRollbackSql);

  const tableAfterRollback = (await db.query(`
    select count(*) as cnt from information_schema.tables 
    where table_schema = 'reporting' and table_name = 'canonical_flight_legs';
  `)).rows[0].cnt;
  assert.equal(Number(tableAfterRollback), 0, 'reporting.canonical_flight_legs must be dropped after rollback A');

  console.log(JSON.stringify({
    suite: 'canonical-flight-legs-acceleration-rehearsal',
    status: 'passed',
    preDigest,
    postDigest,
    restoredDigest,
  }));
} finally {
  await db.close();
}
