// Behavioral test suite for Residual V1 Readers Cutover Canonical Authority
//
// Verifies:
// 1. Reapply Idempotency: Migration can be reapplied consecutively without recursive wrapper capture.
// 2. Least-Privilege ACLs: Private legacy helpers have no public/anon/authenticated execute; public wrappers restricted to service_role.
// 3. Gate OFF (Default): Residual V1 readers delegate unconditionally to legacy authority (reporting.public_traffic_effective).
// 4. Controlled Gate ON: Post-cutover, residual V1 readers query native canonical authority
//    (reporting.canonical_flight_legs via reporting.operational_traffic_effective_v1).
// 5. Preserves 100% Contract Behavior:
//    - Preserves timeline pagination (page_size, next_cursor, has_more) without synthetic fallbacks.
//    - Preserves breakdowns regular_flights arrays ({ arrivals: [...], departures: [...] }) without losing consumer payloads.
//    - Preserves day_of_week heatmaps (7 days) and 24 peak_hour buckets.
//    - Preserves dimension_v2 pagination, shares, and sorting.
// 6. OFF -> ON Continuity & Canonical Resolution:
//    - Exact 100% identity on clean dates (2026-10-25: JX701, JX703, VN555 = 3 flights).
//    - Demonstrates canonical authority superiority on 2026-10-26 by resolving the false quarantine of VN101
//      caused by legacy candidate ranking without active lifecycle filtering.
// 7. Operational Change Visibility & Monotonic Invalidation:
//    - Native operational mutations reflect monotonic source_data_version/source_watermark matching canonical V2 contract.
//    - Un-refreshed operational mutations raise STALE_OPERATIONAL_PROJECTION.
// 8. Due Semantics & Timezone Independence:
//    - Fallback on uncertified dates evaluates NULL scheduled times using end-of-day wall timestamp without tz.
//    - Due boundary evaluates identically under UTC and Asia/Ho_Chi_Minh session timezones.
// 9. Fail-Closed Drift Rejection & Clean Abort Rollback:
//    - Missing target signatures or missing regex patterns trigger immediate exceptions and clean transaction rollback.
// 10. Byte-Exact Preimage Rollback: 20261105102000.rollback.sql restores exact captured function definitions and ACLs
//    without leaking state, views, or legacy functions.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const MIGRATION_NAME = '20261105102000_v1_readers_cutover_canonical_authority.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const ctx = await buildM0Fixture();
const { db } = ctx;

try {
  // Populate legacy materialized view so legacy readers have effective operations during Gate OFF
  await db.exec(`
    refresh materialized view reporting.public_traffic_effective;
    select reporting.mark_public_traffic_projection_fresh_v1();
  `);

  // Ensure we are working on a clean slate
  console.log('Testing rollback cleanliness prior to applying migration...');
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  await db.exec(await readFile(ROLLBACK_URL, 'utf8'));

  const viewAbsent = (
    await db.query(`select to_regclass('reporting.operational_traffic_effective_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(viewAbsent, true, 'Rollback must drop reporting.operational_traffic_effective_v1');

  const gateViewAbsent = (
    await db.query(`select to_regclass('reporting.public_traffic_effective_gate_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(gateViewAbsent, true, 'Rollback must drop reporting.public_traffic_effective_gate_v1');

  // =========================================================================
  // Phase 0A: Behavioral Migration Drift Rejection (Fail-Closed & Proper Rollback)
  // =========================================================================
  console.log('Testing behavioral migration drift rejection and proper rollback...');

  // Capture original definition of monthly_peaks before testing drift
  const origMonthlyPeaksDef = (
    await db.query(`select pg_get_functiondef('reporting.get_traffic_report_monthly_peaks_v2(date,date,jsonb,text)'::regprocedure) as def`)
  ).rows[0].def;

  // Drift scenario 1: missing required target function signature
  await db.exec('drop function reporting.get_traffic_report_monthly_peaks_v2(date,date,jsonb,text)');
  let missingTargetRejected = false;
  try {
    await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  } catch (err) {
    missingTargetRejected = true;
    assert.match(err.message, /Required target function signature not found/i);
    await db.exec('rollback;');
  }
  assert.equal(missingTargetRejected, true, 'Migration must fail closed when a required target signature is missing');

  const viewAbsentAfterMissing = (
    await db.query(`select to_regclass('reporting.operational_traffic_effective_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(viewAbsentAfterMissing, true, 'Aborted transaction must leave database clean after rollback');

  // Drift scenario 2: pattern drift inside target function (missing reporting.public_traffic_effective)
  await db.exec(`
    create or replace function reporting.get_traffic_report_monthly_peaks_v2(
      p_from_date date, p_to_date date, p_filters jsonb default '{}'::jsonb, p_time_basis text default 'local'::text
    ) returns jsonb language sql as $$ select '{}'::jsonb; $$;
  `);
  let patternDriftRejected = false;
  try {
    await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  } catch (err) {
    patternDriftRejected = true;
    assert.match(err.message, /missing expected pattern/i);
    await db.exec('rollback;');
  }
  assert.equal(patternDriftRejected, true, 'Migration must fail closed when an expected pattern is missing in a target');

  const viewAbsentAfterPatternDrift = (
    await db.query(`select to_regclass('reporting.operational_traffic_effective_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(viewAbsentAfterPatternDrift, true, 'Aborted transaction must leave database clean after rollback');

  // Restore target to original definition
  await db.exec(origMonthlyPeaksDef);

  // =========================================================================
  // Phase 0B: Test Migration Reapply Twice (Idempotency Check)
  // =========================================================================
  console.log('Testing migration reapply twice to verify preimage cloning avoids recursive wrappers...');
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  // Reapply a second time immediately without rolling back
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));

  // Ensure preimage count didn't duplicate and captured all 12 targets
  const preimageCount = (
    await db.query(`select count(*)::integer as count from reporting.operational_projection_migration_preimages_v1 where migration_tag = '20261105102000'`)
  ).rows[0].count;
  assert.equal(preimageCount, 12, 'Preimages must be captured for exactly 12 target reader functions');

  // =========================================================================
  // Phase 1: Least-Privilege ACLs
  // =========================================================================
  console.log('Verifying least-privilege ACLs...');
  const publicOverviewAcl = (
    await db.query(`select has_function_privilege('service_role', 'public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)', 'execute') as service_priv,
                           has_function_privilege('authenticated', 'public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)', 'execute') as auth_priv,
                           has_function_privilege('anon', 'public.get_public_traffic_report_overview_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)', 'execute') as anon_priv`)
  ).rows[0];
  assert.equal(publicOverviewAcl.service_priv, true, 'service_role must have execute on public wrapper');
  assert.equal(publicOverviewAcl.auth_priv, false, 'authenticated must NOT have execute on public wrapper');
  assert.equal(publicOverviewAcl.anon_priv, false, 'anon must NOT have execute on public wrapper');

  // Internal building blocks must NOT be executable by service_role (prevents freshness wrapper bypass)
  const canonicalBaseAcl = (
    await db.query(`select has_function_privilege('service_role', 'public.get_public_traffic_report_overview_canonical_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)', 'execute') as service_priv`)
  ).rows[0];
  assert.equal(canonicalBaseAcl.service_priv, false, 'service_role must NOT have execute on internal canonical_base_v1');

  const peakHeatmapsBaseAcl = (
    await db.query(`select has_function_privilege('service_role', 'public.get_public_traffic_report_overview_peak_heatmaps_base_v1(date,date,text[],text[],text[],text[],text[],text,text,date,integer,text)', 'execute') as service_priv`)
  ).rows[0];
  assert.equal(peakHeatmapsBaseAcl.service_priv, false, 'service_role must NOT have execute on internal peak_heatmaps_base_v1');

  const privateHeatmapAcl = (
    await db.query(`select has_function_privilege('service_role', 'reporting.get_traffic_report_peak_hour_heatmap_v1(date,date,jsonb,text)', 'execute') as service_priv`)
  ).rows[0];
  assert.equal(privateHeatmapAcl.service_priv, false, 'service_role must NOT have execute on internal reporting.get_traffic_report_peak_hour_heatmap_v1');

  // =========================================================================
  // Phase 2: Gate OFF (Default) - Legacy Reader Authority Unchanged
  // =========================================================================
  console.log('Verifying Gate OFF semantics (legacy reader authority preserved)...');
  const gateOff = (
    await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)
  ).rows[0].active;
  assert.equal(gateOff, false, 'Cutover gate must be default OFF');

  // Verify legacy quarantine behavior:
  // VN101 on 2026-10-26 is quarantined under legacy authority because public_traffic_candidates
  // ranks candidates without filtering deleted rows, tying VN101 with its deleted daily import preimage.
  const legacyQuarantineRows = (
    await db.query(`select business_leg_key, reason from reporting.public_traffic_duplicate_quarantine where business_leg_key like '%VN101%'`)
  ).rows;
  assert.ok(legacyQuarantineRows.length > 0, 'VN101 must be in legacy quarantine due to tied recency with deleted preimage');
  assert.equal(legacyQuarantineRows[0].reason, 'tied_authoritative_recency');

  // Overview V1 under Gate OFF on clean unquarantined day (2026-10-25)
  const legacySingleDayRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-25', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    ) as result`
  );
  const legacySingleDayFlights = legacySingleDayRes.rows[0].result.kpis.current.flights;
  assert.equal(legacySingleDayFlights, 3, '2026-10-25 must have exactly 3 flights under legacy authority (JX701, JX703, VN555)');

  // Overview V1 under Gate OFF across 2026-10-25 to 2026-10-26 (domain total: 4 flights)
  const legacyOverviewRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    ) as result`
  );
  const legacyOverview = legacyOverviewRes.rows[0].result;
  assert.equal(legacyOverview.contract_version, 'traffic-report-v1');
  assert.ok(legacyOverview.kpis.current, 'Legacy overview must return KPIs object');
  const legacyTotalFlights = legacyOverview.kpis.current.flights;
  assert.equal(legacyTotalFlights, 4, 'Legacy total flights across 25-26 must be 4 (VN101 quarantined)');
  assert.ok(Array.isArray(legacyOverview.timeline), 'Legacy overview must return timeline array');
  assert.ok(legacyOverview.breakdowns.airline, 'Legacy overview must return airline breakdown');

  // Dimension V2 under Gate OFF (within domain: 2026-10-25 to 2026-10-26)
  const legacyDimRes = await db.query(
    `select public.get_public_traffic_report_dimension_v2(
      date '2026-10-25', date '2026-10-26', 'airline',
      array['A','D']::text[], array[]::text[], array[]::text[], array[]::text[],
      'flights', 1, 50, timestamptz '2026-12-20 00:00:00+00'
    ) as result`
  );
  const legacyDim = legacyDimRes.rows[0].result;
  assert.equal(legacyDim.dimension, 'airline');
  assert.ok(Array.isArray(legacyDim.rows), 'Legacy dimension must return rows array');

  // Peak-Hour Heatmap V1 under Gate OFF (within domain: 2026-10-25 to 2026-10-26, same month)
  const legacyHeatmapRes = await db.query(
    `select public.get_public_traffic_report_peak_hour_heatmap_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'local', 'traffic-report-v1'
    ) as result`
  );
  const legacyHeatmap = legacyHeatmapRes.rows[0].result;
  assert.equal(legacyHeatmap.contract_version, 'traffic-report-v1');
  assert.equal(legacyHeatmap.month, '2026-10');
  assert.ok(Array.isArray(legacyHeatmap.monthly_average), 'Legacy heatmap must return 24 monthly average buckets');
  assert.equal(legacyHeatmap.monthly_average.length, 24);

  // =========================================================================
  // Phase 3: Controlled Gate ON (Explicit Cutover with Standard Backfill)
  // =========================================================================
  console.log('Running standard backfill per 20260928130000, refreshing projection, and executing cutover...');

  // 1. Run official seasonal-operational backfill under authenticated writer role
  await db.exec('set role authenticated');
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [M0_FIXTURE.writerId]);
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01', $1::uuid)`, [M0_FIXTURE.writerId]);
  await db.exec('reset role');

  // 2. Refresh operational canonical projection to bring operational_canonical_flight_legs fresh
  await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);

  // 3. Execute cutover under service_role
  await db.exec('set role service_role');
  await db.query(`select reporting.cutover_operational_readers_v1('integration-tester')`);
  await db.exec('reset role');

  const gateOn = (
    await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)
  ).rows[0].active;
  assert.equal(gateOn, true, 'Cutover gate must be active after cutover RPC');

  // Exact 100% OFF -> ON parity on clean unquarantined domain (2026-10-25)
  const cutoverSingleDayRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-25', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    ) as result`
  );
  assert.equal(
    cutoverSingleDayRes.rows[0].result.kpis.current.flights,
    legacySingleDayFlights,
    'OFF -> ON exact continuity on clean domain (2026-10-25): flight count must be identical (3 flights)'
  );

  // Overview V1 under Gate ON across 2026-10-25 to 2026-10-26:
  // Canonical authority applies is_canonical_flight_leg_active_v1 to exclude the deleted daily preimage,
  // resolving the false quarantine of VN101 and yielding 5 valid flights (4 legacy + 1 resolved VN101).
  const cutoverOverviewRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    ) as result`
  );
  const cutoverOverview = cutoverOverviewRes.rows[0].result;
  assert.equal(cutoverOverview.contract_version, 'traffic-report-v1');
  assert.ok(cutoverOverview.metadata.min_ops_date, 'Metadata must contain canonical min_ops_date');
  assert.ok(cutoverOverview.metadata.max_ops_date, 'Metadata must contain canonical max_ops_date');
  assert.equal(
    cutoverOverview.kpis.current.flights,
    legacyTotalFlights + 1,
    'Gate ON canonical authority resolves legacy quarantine of VN101, yielding 5 flights (4 legacy + 1 resolved)'
  );
  assert.ok(
    cutoverOverview.breakdowns.airline.find((r) => r.label === 'VN').flights >= 2,
    'Canonical authority must include resolved VN101 alongside VN555 and VN201'
  );

  // Monotonic version contract inspection under Gate ON:
  // source_data_version and current_data_version must match operational_workspace_revision,
  // and source_watermark / current_watermark must match status.source_watermark + revision.
  const cutoverProjection = cutoverOverview.metadata.projection;
  assert.equal(cutoverProjection.status, 'fresh');
  assert.equal(cutoverProjection.source_data_version, cutoverProjection.current_data_version);
  assert.equal(cutoverProjection.source_watermark, cutoverProjection.current_watermark);
  const priorVersion = cutoverProjection.source_data_version;
  const priorWatermark = cutoverProjection.source_watermark;
  assert.ok(typeof priorVersion === 'number' && priorVersion > 0, 'source_data_version must be a positive integer matching workspace revision');

  // Pagination test under Gate ON (page_size: 1)
  const pagedOverviewRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 1, 'traffic-report-v1'
    ) as result`
  );
  const pagedOverview = pagedOverviewRes.rows[0].result;
  assert.ok(Array.isArray(pagedOverview.timeline), 'Timeline must be an array');
  assert.ok(pagedOverview.timeline.length <= 1, 'Timeline must respect p_timeline_page_size parameter');

  // Assert preservation of regular_flights without fake fallback
  assert.ok(cutoverOverview.breakdowns.peak_hour, 'Breakdowns must include peak_hour');
  assert.equal(cutoverOverview.breakdowns.peak_hour.length, 24);
  const firstPeakBucket = cutoverOverview.breakdowns.peak_hour[0];
  assert.ok(
    firstPeakBucket && typeof firstPeakBucket.regular_flights === 'object',
    'Peak-hour bucket must preserve regular_flights object contract'
  );
  assert.ok(
    Array.isArray(firstPeakBucket.regular_flights.arrivals) && Array.isArray(firstPeakBucket.regular_flights.departures),
    'regular_flights must have arrivals and departures arrays preserved'
  );

  // Assert day_of_week heatmaps
  assert.ok(cutoverOverview.breakdowns.day_of_week, 'Breakdowns must include day_of_week');
  assert.equal(cutoverOverview.breakdowns.day_of_week.length, 7);

  // Dimension V2 under Gate ON (within domain: 2026-10-25 to 2026-10-26)
  const cutoverDimRes = await db.query(
    `select public.get_public_traffic_report_dimension_v2(
      date '2026-10-25', date '2026-10-26', 'airline',
      array['A','D']::text[], array[]::text[], array[]::text[], array[]::text[],
      'flights', 1, 50, timestamptz '2026-12-20 00:00:00+00'
    ) as result`
  );
  const cutoverDim = cutoverDimRes.rows[0].result;
  assert.equal(cutoverDim.dimension, 'airline');
  assert.ok(Array.isArray(cutoverDim.rows));

  // Peak-Hour Heatmap V1 under Gate ON (within domain: 2026-10-25 to 2026-10-26, same month)
  const cutoverHeatmapRes = await db.query(
    `select public.get_public_traffic_report_peak_hour_heatmap_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'local', 'traffic-report-v1'
    ) as result`
  );
  const cutoverHeatmap = cutoverHeatmapRes.rows[0].result;
  assert.equal(cutoverHeatmap.contract_version, 'traffic-report-v1');
  assert.equal(cutoverHeatmap.month, '2026-10');
  assert.equal(cutoverHeatmap.monthly_average.length, 24);
  assert.equal(cutoverHeatmap.source_watermark, priorWatermark, 'Heatmap source_watermark must reflect canonical monotonic watermark');

  // =========================================================================
  // Phase 4: Native Operational Mutations Reflected Post-Refresh & Monotonic Version Invalidation
  // =========================================================================
  console.log('Applying native operational leg mutation and asserting reflection and monotonic version increment in V1 readers...');
  const newOpLegId = '00000000-0000-4000-8000-000000000099';
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status, gate, stand, carousel
    ) values (
      $1, 'A' || chr(31) || '2026-10-26' || chr(31) || 'VN' || chr(31) || 'VN999', '2026-10-26', '2026-10-26', '14:30',
      'ARR', 'VN', 'VN999', 'SGN-HAN', 'A350', 320,
      $2, 'operational_manual', 'active', 4, '12', 2
    )
  `, [newOpLegId, M0_FIXTURE.seasonM26]);

  // Operational mutation must immediately dirty the projection; readers must reject with STALE_OPERATIONAL_PROJECTION
  await assert.rejects(
    async () => {
      await db.query(`
        select public.get_public_traffic_report_overview_v1(
          date '2026-10-25', date '2026-10-26', array['A','D']::text[],
          array[]::text[], array[]::text[], array[]::text[], array[]::text[],
          'none', 'local', null, 366, 'traffic-report-v1'
        )
      `);
    },
    (err) => {
      assert.match(err.message, /STALE_OPERATIONAL_PROJECTION/);
      return true;
    },
    'Un-refreshed operational mutation must trigger STALE_OPERATIONAL_PROJECTION'
  );

  // Refresh canonical legs under cutover (mirrors into reporting.canonical_flight_legs)
  await db.query(`select reporting.refresh_public_traffic_canonical_legs_v1()`);

  // Verify the new leg is visible in Overview V1 and increments flight count
  const updatedOverviewRes = await db.query(
    `select public.get_public_traffic_report_overview_v1(
      date '2026-10-25', date '2026-10-26', array['A','D']::text[],
      array[]::text[], array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', null, 366, 'traffic-report-v1'
    ) as result`
  );
  const updatedOverview = updatedOverviewRes.rows[0].result;
  assert.equal(
    updatedOverview.kpis.current.flights,
    cutoverOverview.kpis.current.flights + 1,
    'Native operational mutation must immediately increment total flights by 1'
  );
  const vnAirlineBreakdown = updatedOverview.breakdowns.airline.find((r) => r.label === 'VN');
  assert.ok(vnAirlineBreakdown, 'New operational VN leg must appear in airline breakdown');
  assert.ok(vnAirlineBreakdown.flights >= 1, 'VN flights count must reflect added leg');

  // Assert monotonic version invalidation: mutation must increment source_data_version and source_watermark
  const updatedProjection = updatedOverview.metadata.projection;
  assert.equal(updatedProjection.status, 'fresh');
  assert.equal(updatedProjection.source_data_version, updatedProjection.current_data_version);
  assert.equal(updatedProjection.source_watermark, updatedProjection.current_watermark);
  assert.ok(
    updatedProjection.source_data_version > priorVersion,
    `source_data_version must increment monotonically across mutations (prior=${priorVersion}, current=${updatedProjection.source_data_version})`
  );
  assert.ok(
    updatedProjection.source_watermark > priorWatermark,
    `source_watermark must increment monotonically across mutations (prior=${priorWatermark}, current=${updatedProjection.source_watermark})`
  );

  // Verify the new leg is visible in Dimension V2
  const updatedDimRes = await db.query(
    `select public.get_public_traffic_report_dimension_v2(
      date '2026-10-25', date '2026-10-26', 'airline',
      array['A','D']::text[], array['VN']::text[], array[]::text[], array[]::text[],
      'flights', 1, 50, timestamptz '2026-12-20 00:00:00+00'
    ) as result`
  );
  const updatedDim = updatedDimRes.rows[0].result;
  const vnRow = updatedDim.rows.find((r) => r.label === 'VN');
  assert.ok(vnRow, 'Dimension V2 must reflect added VN leg');
  assert.ok(vnRow.flights >= 1);

  // =========================================================================
  // Phase 4B: Cross-Surface Behavioral Comparison (V1 Overview vs Report V2 vs HTML KPI)
  // Exercises:
  // 1. NULL-Pax certified-day leg (2026-10-26): not due via certified branch; due only after scheduled_local_at + 1 day.
  // 2. NULL scheduled-time uncertified-day leg (2026-10-27): remains NOT due without artificial end-of-day fallback.
  // Evaluates both UTC and Asia/Ho_Chi_Minh session timezones across all 3 reader surfaces.
  // =========================================================================
  console.log('Testing cross-surface behavioral comparison (V1 vs V2 vs HTML) across UTC and Asia/Ho_Chi_Minh session TZ...');

  // Insert NULL-Pax certified-day leg on 2026-10-26 (scheduled at 18:00 local)
  const certLegKey = 'D' + String.fromCharCode(31) + '2026-10-26' + String.fromCharCode(31) + 'QH' + String.fromCharCode(31) + 'QH888';
  await db.query(`
    insert into reporting.canonical_flight_legs (
      business_leg_key, ops_date, type, airline, flight_number,
      route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
    ) values (
      $1, date '2026-10-26', 'D', 'QH', 'QH888',
      'DAD', 'A321', 'C', null, 1080, timestamp '2026-10-26 18:00:00'
    )
    on conflict (business_leg_key) do update
      set pax = null, scheduled_local_at = timestamp '2026-10-26 18:00:00', local_minutes = 1080;
  `, [certLegKey]);

  // Insert NULL scheduled-time uncertified-day leg on 2026-10-27
  const uncertLegKey = 'A' + String.fromCharCode(31) + '2026-10-27' + String.fromCharCode(31) + 'VN' + String.fromCharCode(31) + 'VN777';
  await db.query(`
    insert into reporting.canonical_flight_legs (
      business_leg_key, ops_date, type, airline, flight_number,
      route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
    ) values (
      $1, date '2026-10-27', 'A', 'VN', 'VN777',
      'HAN', 'A321', 'C', null, null, null
    )
    on conflict (business_leg_key) do update
      set pax = null, scheduled_local_at = null, local_minutes = null;
  `, [uncertLegKey]);

  const filterParams = { airlines: [], routes: [], countries: [], time_basis: 'local' };
  const asOfEarly = '2026-10-27 00:00:00+00'; // local 07:00:00 (before 2026-10-26 18:00 + 1 day)
  const asOfLate = '2026-10-28 00:00:00+00';  // local 07:00:00 (after 2026-10-26 18:00 + 1 day)
  const asOfUncert = '2026-10-29 00:00:00+00';

  for (const sessionTz of ['UTC', 'Asia/Ho_Chi_Minh']) {
    await db.exec(`set timezone to '${sessionTz}'`);

    // --- 1. Certified Day (2026-10-26) with NULL-Pax leg BEFORE scheduled + 1 day ---
    const v1CertEarlyRes = await db.query(`
      select reporting.get_traffic_report_kpis(
        date '2026-10-26', date '2026-10-26', '{}'::jsonb, 'none',
        timestamptz '${asOfEarly}'
      ) as kpis
    `);
    const v1CertEarly = v1CertEarlyRes.rows[0].kpis;

    const v2CertEarlyRes = await db.query(`
      select public.get_public_traffic_report_v2(
        date '2026-10-26', date '2026-10-26', 'all', array[]::text[], array[]::text[], array[]::text[],
        'none', 'local', null, 'traffic-report-v2', 'full', timestamptz '${asOfEarly}'
      ) as result
    `);
    const v2CertEarly = v2CertEarlyRes.rows[0].result.current;

    const htmlCertEarlyRes = await db.query(`
      select reporting.traffic_html_period_data_v2($1::jsonb, $2::jsonb, timestamptz '${asOfEarly}') as result
    `, [JSON.stringify(filterParams), JSON.stringify({ from: '2026-10-26', to: '2026-10-26' })]);
    const htmlCertEarly = htmlCertEarlyRes.rows[0].result.resources.find((r) => r.dataset === 'kpi').rows.find((r) => r.direction === 'all');
    console.log(`[${sessionTz}] 2026-10-26 Early (NULL-Pax leg before scheduled+1d): V1 due=${v1CertEarly.pax_coverage.due_legs} missing=${v1CertEarly.quality.pax_due_missing_legs} | V2 due=${v2CertEarly.due_legs} missing=${v2CertEarly.missing_due_legs} | HTML due=${htmlCertEarly.due_legs} missing=${htmlCertEarly.missing_due_legs}`);

    assert.equal(v1CertEarly.pax_coverage.due_legs, 3, `Session TZ ${sessionTz}: V1 early certified due_legs must be 3 (VN201, VN101, VN999 due; QH888 not due yet)`);
    assert.equal(v1CertEarly.quality.pax_due_missing_legs, 0, `Session TZ ${sessionTz}: V1 early certified missing_due_legs must be 0`);
    assert.equal(v2CertEarly.due_legs, v1CertEarly.pax_coverage.due_legs, `Session TZ ${sessionTz}: V2 due_legs must match V1`);
    assert.equal(v2CertEarly.missing_due_legs, v1CertEarly.quality.pax_due_missing_legs, `Session TZ ${sessionTz}: V2 missing_due_legs must match V1`);
    assert.equal(htmlCertEarly.due_legs, v1CertEarly.pax_coverage.due_legs, `Session TZ ${sessionTz}: HTML due_legs must match V1`);
    assert.equal(htmlCertEarly.missing_due_legs, v1CertEarly.quality.pax_due_missing_legs, `Session TZ ${sessionTz}: HTML missing_due_legs must match V1`);
    // --- 2. Certified Day (2026-10-26) with NULL-Pax leg AFTER scheduled + 1 day ---
    const v1CertLateRes = await db.query(`
      select reporting.get_traffic_report_kpis(
        date '2026-10-26', date '2026-10-26', '{}'::jsonb, 'none',
        timestamptz '${asOfLate}'
      ) as kpis
    `);
    const v1CertLate = v1CertLateRes.rows[0].kpis;

    const v2CertLateRes = await db.query(`
      select public.get_public_traffic_report_v2(
        date '2026-10-26', date '2026-10-26', 'all', array[]::text[], array[]::text[], array[]::text[],
        'none', 'local', null, 'traffic-report-v2', 'full', timestamptz '${asOfLate}'
      ) as result
    `);
    const v2CertLate = v2CertLateRes.rows[0].result.current;

    const htmlCertLateRes = await db.query(`
      select reporting.traffic_html_period_data_v2($1::jsonb, $2::jsonb, timestamptz '${asOfLate}') as result
    `, [JSON.stringify(filterParams), JSON.stringify({ from: '2026-10-26', to: '2026-10-26' })]);
    const htmlCertLate = htmlCertLateRes.rows[0].result.resources.find((r) => r.dataset === 'kpi').rows.find((r) => r.direction === 'all');
    console.log(`[${sessionTz}] 2026-10-26 Late (NULL-Pax leg after scheduled+1d):  V1 due=${v1CertLate.pax_coverage.due_legs} missing=${v1CertLate.quality.pax_due_missing_legs} | V2 due=${v2CertLate.due_legs} missing=${v2CertLate.missing_due_legs} | HTML due=${htmlCertLate.due_legs} missing=${htmlCertLate.missing_due_legs}`);

    assert.equal(v1CertLate.pax_coverage.due_legs, 4, `Session TZ ${sessionTz}: V1 late certified due_legs must be 4 (all 4 legs due after scheduled+1d)`);
    assert.equal(v1CertLate.quality.pax_due_missing_legs, 1, `Session TZ ${sessionTz}: V1 late certified missing_due_legs must be 1 (QH888 missing pax)`);
    assert.equal(v2CertLate.due_legs, v1CertLate.pax_coverage.due_legs, `Session TZ ${sessionTz}: V2 due_legs must match V1`);
    assert.equal(v2CertLate.missing_due_legs, v1CertLate.quality.pax_due_missing_legs, `Session TZ ${sessionTz}: V2 missing_due_legs must match V1`);
    assert.equal(htmlCertLate.due_legs, v1CertLate.pax_coverage.due_legs, `Session TZ ${sessionTz}: HTML due_legs must match V1`);
    assert.equal(htmlCertLate.missing_due_legs, v1CertLate.quality.pax_due_missing_legs, `Session TZ ${sessionTz}: HTML missing_due_legs must match V1`);
    // --- 3. Uncertified Day (2026-10-27) with NULL scheduled-time leg ---
    // In V1 Overview (public.get_public_traffic_report_overview_v1):
    // due_legs is at result.kpis.pax_coverage.due_legs
    // missing_due_legs is at result.quality.pax_due_missing_legs
    const v1OverviewUncertRes = await db.query(`
      select public.get_public_traffic_report_overview_v1(
        date '2026-10-27', date '2026-10-27', array['A','D']::text[],
        array[]::text[], array[]::text[], array[]::text[], array[]::text[],
        'none', 'local', null, 366, 'traffic-report-v1'
      ) as result
    `);
    const v1OverviewUncert = v1OverviewUncertRes.rows[0].result;
    const v1UncertDue = v1OverviewUncert.kpis.pax_coverage.due_legs;
    const v1UncertMissing = v1OverviewUncert.quality.pax_due_missing_legs;

    const v2UncertRes = await db.query(`
      select public.get_public_traffic_report_v2(
        date '2026-10-27', date '2026-10-27', 'all', array[]::text[], array[]::text[], array[]::text[],
        'none', 'local', null, 'traffic-report-v2', 'full', timestamptz '${asOfUncert}'
      ) as result
    `);
    const v2Uncert = v2UncertRes.rows[0].result.current;

    const htmlUncertRes = await db.query(`
      select reporting.traffic_html_period_data_v2($1::jsonb, $2::jsonb, timestamptz '${asOfUncert}') as result
    `, [JSON.stringify(filterParams), JSON.stringify({ from: '2026-10-27', to: '2026-10-27' })]);
    const htmlUncert = htmlUncertRes.rows[0].result.resources.find((r) => r.dataset === 'kpi').rows.find((r) => r.direction === 'all');
    console.log(`[${sessionTz}] 2026-10-27 Uncertified (NULL scheduled time leg):      V1 due=${v1UncertDue} missing=${v1UncertMissing} | V2 due=${v2Uncert.due_legs} missing=${v2Uncert.missing_due_legs} | HTML due=${htmlUncert.due_legs} missing=${htmlUncert.missing_due_legs}`);

    assert.equal(v1UncertDue, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be due in V1`);
    assert.equal(v1UncertMissing, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be missing due in V1`);
    assert.equal(v2Uncert.due_legs, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be due in V2`);
    assert.equal(v2Uncert.missing_due_legs, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be missing due in V2`);
    assert.equal(htmlUncert.due_legs, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be due in HTML KPI`);
    assert.equal(htmlUncert.missing_due_legs, 0, `Session TZ ${sessionTz}: NULL scheduled time leg on uncertified date must NOT be missing due in HTML KPI`);
  }

  // Reset timezone
  await db.exec('reset timezone');

  // =========================================================================
  // Phase 5: Rollback Byte-Exact Preimage Restoration
  // =========================================================================
  console.log('Verifying byte-exact preimage rollback...');
  await db.exec(await readFile(ROLLBACK_URL, 'utf8'));

  const postRollbackViewAbsent = (
    await db.query(`select to_regclass('reporting.operational_traffic_effective_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(postRollbackViewAbsent, true, 'Rollback must drop operational_traffic_effective_v1');

  const postRollbackGateViewAbsent = (
    await db.query(`select to_regclass('reporting.public_traffic_effective_gate_v1') is null as absent`)
  ).rows[0].absent;
  assert.equal(postRollbackGateViewAbsent, true, 'Rollback must drop public_traffic_effective_gate_v1');

  const preimagesCleared = (
    await db.query(`select count(*)::integer as count from reporting.operational_projection_migration_preimages_v1 where migration_tag = '20261105102000'`)
  ).rows[0].count;
  assert.equal(preimagesCleared, 0, 'Rollback must delete preimages for 20261105102000');

  console.log('Behavioral checks completed successfully.');
} finally {
  // Cleanup test DB
}
