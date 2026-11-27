// Cutover-aware HTML export data sourcing PGlite behavioral test.
// Proves:
// 0. Exact function def before/after rollback + reapply twice and preserved OFF payload under fixed data_as_of.
// 1. Default Gate OFF: Legacy reader authority unchanged via captured preimage (live candidate slice),
//    native operational mutations isolated, full parity with Report V2 on M0 seeded records.
// 2. Controlled Cutover Lifecycle: Refresh projection -> Activate cutover -> New mutation creates staleness -> Stale read fails closed (40001).
// 3. Post-cutover Visibility & Parity: Cured projection mirrors operational canonical legs, exposes combined watermark,
//    native flights visible, full metric and timeline parity with Report V2, and consumer renderer accepts native payload.
// 4. Semantics: Daily priority, pax NULL vs 0 (missing due vs true zero), and time basis (local vs utc).
// 5. Optional Variance Analysis: Only evaluated if explicitly provided via SEASONAL_VARIANCE_ANALYSIS_MIGRATION_PATH.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
import { stripPsqlMetaCommands } from './seasonal_operational_separation_test_support.mjs';
import { normalizeHtmlRequest } from '../functions/_shared/trafficHtmlReportContract.ts';
import { renderTrafficHtmlReport } from '../functions/_shared/trafficHtmlReportRenderer.ts';
import { validateHtmlEnvelope } from '../functions/_shared/trafficHtmlReportModel.ts';

const MIGRATION_NAME = '20261105100000_public_traffic_html_cutover_v1.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const ctx = await buildM0Fixture();
const { db } = ctx;

try {
  const fromDate = '2026-10-25';
  const toDate = '2026-10-28';
  const htmlReq = normalizeHtmlRequest(
    new URL(`https://report.test/?report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=${fromDate}&to=${toDate}`)
  );

  // --- 0. Exact function def & payload before/after rollback + reapply twice ---
  console.log('Phase 0: Validating rollback + reapply idempotency and exact definition restoration...');
  // The full-chain loader already applied the migration from the folder,
  // so roll back first to return to the pristine pre-migration baseline state before capturing.
  await db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK_URL, 'utf8')));

  // Capture pristine original function definitions before 20261105100000
  const origDataFnDef = (
    await db.query(`select pg_get_functiondef('reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;
  const origExportFnDef = (
    await db.query(`select pg_get_functiondef('public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;

  // Capture pristine baseline export payload under fixed data_as_of
  const baselinePayload = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;

  // Cycle 1: Apply -> Verify OFF payload -> Rollback -> Verify exact def and payload
  await db.exec(stripPsqlMetaCommands(await readFile(MIGRATION_URL, 'utf8')));
  const apply1Payload = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  assert.deepEqual(apply1Payload, baselinePayload, 'Cycle 1: Gate OFF payload must match baseline');

  await db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK_URL, 'utf8')));
  const rollback1DataDef = (
    await db.query(`select pg_get_functiondef('reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;
  const rollback1ExportDef = (
    await db.query(`select pg_get_functiondef('public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;
  assert.equal(rollback1DataDef, origDataFnDef, 'Cycle 1: Rollback must restore exact reporting.traffic_html_period_data_v2 def');
  assert.equal(rollback1ExportDef, origExportFnDef, 'Cycle 1: Rollback must restore exact public.get_public_traffic_html_export_v2 def');

  const rollback1Payload = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  assert.deepEqual(rollback1Payload, baselinePayload, 'Cycle 1: Rolled-back payload must match baseline');

  // Cycle 2: Reapply -> Verify OFF payload -> Rollback -> Verify exact def
  await db.exec(stripPsqlMetaCommands(await readFile(MIGRATION_URL, 'utf8')));
  const apply2Payload = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  assert.deepEqual(apply2Payload, baselinePayload, 'Cycle 2: Gate OFF payload must match baseline');

  await db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK_URL, 'utf8')));
  const rollback2DataDef = (
    await db.query(`select pg_get_functiondef('reporting.traffic_html_period_data_v2(jsonb,jsonb,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;
  const rollback2ExportDef = (
    await db.query(`select pg_get_functiondef('public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)'::regprocedure) as def`)
  ).rows[0].def;
  assert.equal(rollback2DataDef, origDataFnDef, 'Cycle 2: Second rollback restores exact reporting.traffic_html_period_data_v2 def');
  assert.equal(rollback2ExportDef, origExportFnDef, 'Cycle 2: Second rollback restores exact public.get_public_traffic_html_export_v2 def');

  // Final apply for remaining behavioral suite
  await db.exec(stripPsqlMetaCommands(await readFile(MIGRATION_URL, 'utf8')));

  // --- 1. Gate OFF: Legacy Reader Authority Unchanged ---------------------
  console.log('Phase 1: Validating default Gate OFF state with real M0 fixture data...');
  const isCutoverInitial = (
    await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)
  ).rows[0].active;
  assert.equal(isCutoverInitial, false, 'Default cutover state must be false (gate OFF)');

  // Seed a new native operational leg in public.operational_flight_legs on 2026-10-27
  const opLegId = '00000000-0000-4000-8000-000000000099';
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status, gate, stand, carousel
    ) values (
      $1, 'A' || chr(31) || '2026-10-27' || chr(31) || 'VN' || chr(31) || 'VN999', '2026-10-27', '2026-10-27', '10:30',
      'ARR', 'VN', 'VN999', 'SGN-HAN', 'A321', 180,
      $2, 'operational_manual', 'active', 4, '12', 2
    ) on conflict (leg_id) do nothing
  `, [opLegId, M0_FIXTURE.seasonW26]);

  // Execute HTML export under Gate OFF with fixed fixture data_as_of
  const htmlGateOff = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;

  // Execute Report V2 under Gate OFF with matching parameters
  const reportGateOff = (
    await db.query(
      `select public.get_public_traffic_report_v2(
        p_from_date => $1::date,
        p_to_date => $2::date,
        p_data_as_of => $3::timestamptz
      ) as report`,
      [fromDate, toDate, M0_FIXTURE.dataAsOf]
    )
  ).rows[0].report;

  // 1) Watermark check: Gate OFF exposes legacy server_seq watermark
  const legacyWatermark = (await db.query(`select coalesce(max(server_seq), 0)::text as w from public.season_change_events`)).rows[0].w;
  assert.equal(BigInt(htmlGateOff.source_watermark), BigInt(legacyWatermark), 'Gate OFF must expose legacy server_seq watermark');

  // 2) Parity with Report V2 on real seeded legacy records
  const gateOffKpi = htmlGateOff.resources.find(r => r.dataset === 'kpi' && r.period_id === 'current');
  assert.ok(gateOffKpi, 'KPI resource for current period must exist');
  const gateOffAllRow = gateOffKpi.rows.find(r => r.direction === 'all');
  assert.ok(gateOffAllRow, 'KPI all direction row must exist');

  assert.ok(gateOffAllRow.flights > 0, 'Seeded M0 fixture must produce positive flight count');
  assert.equal(gateOffAllRow.flights, reportGateOff.current.flights, 'Gate OFF flights parity between HTML and Report V2');
  assert.equal(gateOffAllRow.reported_pax, reportGateOff.current.reported_pax, 'Gate OFF pax parity between HTML and Report V2');
  assert.equal(gateOffAllRow.reported_legs, reportGateOff.current.reported_legs, 'Gate OFF reported legs parity between HTML and Report V2');

  // 3) Native operational leg VN999 must NOT appear in HTML export while Gate is OFF
  const marketGateOff = htmlGateOff.resources.find(r => r.dataset === 'market' && r.period_id === 'current');
  const nativeMarketGateOff = marketGateOff?.rows?.find(r => r.grain.airline === 'VN' && r.grain.route === 'SGN-HAN');
  assert.equal(nativeMarketGateOff, undefined, 'Native operational leg must not appear in HTML export market dataset while Gate is OFF');

  // --- 2. Controlled Cutover Lifecycle: Refresh -> Activate -> Stale Mutation -> Fail-Closed ---
  console.log('Phase 2: Refreshing projection, activating cutover, and validating stale read refusal...');
  // Run seasonal operational backfill to populate operational flight legs from seasonal schedule
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01', $1::uuid)`, [M0_FIXTURE.writerId]);
  // 1. Refresh projection first so cutover activation succeeds cleanly
  await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);
  const initialProjStatus = (
    await db.query(`select * from reporting.operational_projection_status_v1()`)
  ).rows[0];
  assert.equal(initialProjStatus.is_fresh, true, 'Projection must be fresh after refresh');

  // 2. Activate cutover
  const cutoverRes = (
    await db.query(`select reporting.cutover_operational_readers_v1('test-html-operator') as res`)
  ).rows[0].res;
  assert.equal(cutoverRes.status, 'cutover_success', 'Cutover activation must succeed when projection is fresh');
  assert.equal(
    (await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)).rows[0].active,
    true,
    'Cutover must now be active'
  );

  // 3. Now introduce a mutation in season_change_events to make operational projection stale
  await db.query(`
    insert into public.season_change_events (
      season_id, client_id, op_id, target_type, target_id, op_payload
    ) values (
      $1, 'client-html-stale', gen_random_uuid()::text, 'leg', $2, '{"test":true}'::jsonb
    )
  `, [M0_FIXTURE.seasonW26, opLegId]);

  const staleStatus = (
    await db.query(`select * from reporting.operational_projection_status_v1()`)
  ).rows[0];
  assert.equal(staleStatus.is_fresh, false, 'Projection must become stale after new change event');

  // 4. Stale operational projection must fail-closed with 40001
  await assert.rejects(
    async () => db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    ),
    (err) => err.code === '40001' && /STALE_OPERATIONAL_PROJECTION/i.test(err.message),
    'get_public_traffic_html_export_v2 must reject stale operational projection with 40001'
  );

  await assert.rejects(
    async () => db.query(
      `select public.get_public_traffic_report_v2(
        p_from_date => $1::date,
        p_to_date => $2::date,
        p_data_as_of => $3::timestamptz
      )`,
      [fromDate, toDate, M0_FIXTURE.dataAsOf]
    ),
    (err) => err.code === '40001' && /STALE_OPERATIONAL_PROJECTION/i.test(err.message),
    'Report V2 must also reject stale operational projection with 40001'
  );

  // --- 3. Cured Projection: Visibility & Parity ----------------------------
  console.log('Phase 3: Curing projection, validating post-cutover visibility and Report V2 parity...');
  // Refresh projection to cure staleness and mirror to reporting.canonical_flight_legs
  await db.query(`select reporting.refresh_public_traffic_canonical_legs_v1()`);

  const curedProjStatus = (
    await db.query(`select * from reporting.operational_projection_status_v1()`)
  ).rows[0];
  assert.equal(curedProjStatus.is_fresh, true, 'Projection must be fresh after refresh_public_traffic_canonical_legs_v1');

  // Query HTML export post-cutover
  const htmlPostCutover = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;

  // Query Report V2 post-cutover
  const reportPostCutover = (
    await db.query(
      `select public.get_public_traffic_report_v2(
        p_from_date => $1::date,
        p_to_date => $2::date,
        p_data_as_of => $3::timestamptz
      ) as report`,
      [fromDate, toDate, M0_FIXTURE.dataAsOf]
    )
  ).rows[0].report;

  // 1) Watermark alignment: monotonic operational watermark matches between HTML and Report V2
  assert.equal(
    BigInt(htmlPostCutover.source_watermark),
    BigInt(reportPostCutover.source_watermark),
    'HTML export and Report V2 must expose identical source_watermark under cutover'
  );
  assert.equal(
    htmlPostCutover.data_version,
    reportPostCutover.data_version,
    'HTML export and Report V2 must expose identical data_version under cutover'
  );

  // 2) Native flight visibility: VN999 is now visible in market dataset
  const marketPostCutover = htmlPostCutover.resources.find(r => r.dataset === 'market' && r.period_id === 'current');
  const nativeMarketPost = marketPostCutover?.rows?.find(r => r.grain.airline === 'VN' && r.grain.route === 'SGN-HAN');
  assert.ok(nativeMarketPost, 'Native operational leg VN999 must appear in HTML export market dataset post-cutover');
  assert.equal(nativeMarketPost.flights, 1, 'VN999 flight count must be 1');
  assert.equal(nativeMarketPost.reported_pax, 180, 'VN999 reported pax must be 180');
  // 3) Metric parity with Report V2
  const cutoverKpi = htmlPostCutover.resources.find(r => r.dataset === 'kpi' && r.period_id === 'current');
  const cutoverAllRow = cutoverKpi.rows.find(r => r.direction === 'all');
  assert.equal(cutoverAllRow.flights, reportPostCutover.current.flights, 'Flights parity with Report V2 post-cutover');
  assert.equal(cutoverAllRow.reported_pax, reportPostCutover.current.reported_pax, 'Pax parity with Report V2 post-cutover');
  assert.equal(cutoverAllRow.reported_legs, reportPostCutover.current.reported_legs, 'Reported legs parity with Report V2 post-cutover');
  assert.equal(
    cutoverAllRow.flights,
    gateOffAllRow.flights + 1,
    'Flights continuity post-cutover: backfilled legacy legs + 1 native operational leg'
  );

  // 4) Timeline parity
  const htmlTimeline = htmlPostCutover.resources.find(r => r.dataset === 'timeline' && r.period_id === 'current').rows;
  for (const day of reportPostCutover.timeline) {
    const dayRows = htmlTimeline.filter(r => r.grain.date === day.ops_date);
    const dayFlights = dayRows.every(r => r.flights === null) ? null : dayRows.reduce((acc, r) => acc + (r.flights ?? 0), 0);
    assert.equal(dayFlights, day.flights, `Timeline flights parity for ${day.ops_date}`);
  }

  // 5) Consumer renderer validation: assert native SQL envelope is accepted and renders clean HTML
  await validateHtmlEnvelope(htmlPostCutover, htmlReq);
  const renderedHtml = renderTrafficHtmlReport(htmlPostCutover);
  assert.match(renderedHtml, /<!doctype html>/i, 'Rendered HTML must start with doctype html');
  assert.match(renderedHtml, /id="report"/i, 'Rendered HTML must contain report container');

  // 6) Cutover request filtered to direction with no flights (airline/route filter leaving only ARR)
  const arrOnlyReq = normalizeHtmlRequest(
    new URL(`https://report.test/?report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=${fromDate}&to=${toDate}&route=SGN-HAN`)
  );
  const htmlArrOnly = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(arrOnlyReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  const [{ departures }] = (await db.query(`select count(*)::integer as departures from reporting.canonical_flight_legs where route = 'SGN-HAN' and type = 'D' and ops_date between $1::date and $2::date`, [fromDate, toDate])).rows;
  assert.equal(departures, 0, 'SGN-HAN fixture must have no departures');
  const departureKpi = htmlArrOnly.resources.find(r => r.dataset === 'kpi' && r.period_id === 'current').rows.find(r => r.direction === 'D');
  assert.equal(departureKpi.flights, null, 'Empty departure direction with incomplete coverage must remain unknown, not certified zero');
  assert.equal(departureKpi.reported_legs, 0);
  assert.equal(departureKpi.due_legs, 0);
  await validateHtmlEnvelope(htmlArrOnly, arrOnlyReq);
  const renderedArrOnly = renderTrafficHtmlReport(htmlArrOnly);
  assert.match(renderedArrOnly, /<!doctype html>/i, 'Rendered filtered HTML must start with doctype html');
  assert.match(renderedArrOnly, /id="report"/i, 'Rendered filtered HTML must contain report container');

  // Verify native VN999 is aggregated: verify actual rendered embedded data and browser-visible market route/pax/count
  const embeddedMatch = renderedArrOnly.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embeddedMatch, 'Rendered filtered HTML must embed report data in #report-data');
  const embeddedData = JSON.parse(embeddedMatch[1]);
  const embeddedMarket = embeddedData.resources?.find(r => r.dataset === 'market' && r.period_id === 'current');
  const embeddedLeg = embeddedMarket?.rows?.find(r => r.grain.airline === 'VN' && r.grain.route === 'SGN-HAN');
  assert.ok(embeddedLeg, 'Embedded market data must contain VN on SGN-HAN');
  assert.equal(embeddedLeg.flights, 1, 'Embedded market flights must be 1');
  assert.equal(embeddedLeg.reported_pax, 180, 'Embedded market pax must be 180');
  assert.ok(renderedArrOnly.includes('SGN-HAN'), 'Rendered HTML must display market route SGN-HAN');
  assert.ok(renderedArrOnly.includes('180'), 'Rendered HTML must display reported pax 180');
  assert.equal(
    embeddedData.resources.some(r => r.dataset === 'frequency' && r.rows.some(row => row.grain?.flight_number === 'VN999')),
    false,
    'Native VN999 is aggregated into market, not emitted as unaggregated frequency row'
  );

  // Optional artifact output for parent browser smoke
  const artifactPath = process.env.SEASONAL_HTML_REPORT_ARTIFACT_PATH || process.env.HTML_REPORT_ARTIFACT_PATH;
  if (artifactPath) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, renderedArrOnly, 'utf8');
    console.log(`Saved HTML report artifact to ${artifactPath}`);
  }
  // --- 4. Semantics: Pax NULL vs Zero & Time Basis ------------------------
  console.log('Phase 4: Validating Pax NULL vs 0, quarantine, and time basis...');
  const baselineFlights = cutoverAllRow.flights;
  const baselinePax = cutoverAllRow.reported_pax;
  const baselineReportedLegs = cutoverAllRow.reported_legs;
  const baselineTrueZero = cutoverAllRow.true_zero_reported_legs;
  const baselineMissingDue = cutoverAllRow.missing_due_legs;

  // Insert leg with pax = 0 (true zero) on 2026-10-28
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status
    ) values (
      '00000000-0000-4000-8000-000000000077', 'A' || chr(31) || '2026-10-28' || chr(31) || 'VN' || chr(31) || 'VN777',
      '2026-10-28', '2026-10-28', '08:00',
      'ARR', 'VN', 'VN777', 'HAN-DAD', 'A321', 0,
      null, 'operational_manual', 'active'
    )
  `);

  // Insert leg with pax = null (missing/unreported) on 2026-10-28
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status
    ) values (
      '00000000-0000-4000-8000-000000000066', 'A' || chr(31) || '2026-10-28' || chr(31) || 'VN' || chr(31) || 'VN666',
      '2026-10-28', '2026-10-28', '12:00',
      'ARR', 'VN', 'VN666', 'HAN-DAD', 'A321', null,
      null, 'operational_manual', 'active'
    )
  `);

  await db.query(`select reporting.refresh_public_traffic_canonical_legs_v1()`);

  const htmlSemantics = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  const semanticsKpi = htmlSemantics.resources.find(r => r.dataset === 'kpi' && r.period_id === 'current');
  const semanticsAll = semanticsKpi.rows.find(r => r.direction === 'all');

  assert.equal(semanticsAll.flights, baselineFlights + 2, 'Must count 2 new flights');
  assert.equal(semanticsAll.reported_pax, baselinePax, 'Pax 0 adds 0, pax null excluded: total pax unchanged');
  assert.equal(semanticsAll.reported_legs, baselineReportedLegs + 1, 'Reported legs incremented only by true zero leg VN777');
  assert.equal(semanticsAll.true_zero_reported_legs, baselineTrueZero + 1, 'VN777 must count as true zero reported leg');
  assert.equal(semanticsAll.missing_due_legs, baselineMissingDue + 1, 'VN666 must count as missing due leg');

  // Parity with Report V2 on semantics
  const reportSemantics = (
    await db.query(
      `select public.get_public_traffic_report_v2(
        p_from_date => $1::date,
        p_to_date => $2::date,
        p_data_as_of => $3::timestamptz
      ) as report`,
      [fromDate, toDate, M0_FIXTURE.dataAsOf]
    )
  ).rows[0].report;
  assert.equal(semanticsAll.flights, reportSemantics.current.flights, 'Semantics flights parity with Report V2');
  assert.equal(semanticsAll.reported_pax, reportSemantics.current.reported_pax, 'Semantics pax parity with Report V2');
  assert.equal(semanticsAll.reported_legs, reportSemantics.current.reported_legs, 'Semantics reported legs parity with Report V2');
  assert.equal(semanticsAll.true_zero_reported_legs, reportSemantics.current.true_zero_reported_legs, 'Semantics true zero parity with Report V2');
  assert.equal(semanticsAll.missing_due_legs, reportSemantics.current.missing_due_legs, 'Semantics missing due parity with Report V2');

  // Time basis: UTC shift (using canonical tz=utc)
  const htmlReqUtc = normalizeHtmlRequest(
    new URL(`https://report.test/?report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=${fromDate}&to=${toDate}&tz=utc`)
  );
  const htmlUtc = (
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
      [JSON.stringify(htmlReqUtc), M0_FIXTURE.dataAsOf]
    )
  ).rows[0].res;
  const hoursUtc = htmlUtc.resources.find(r => r.dataset === 'hours' && r.period_id === 'current').rows;
  // VN777 is 08:00 local -> local_minutes = 480 -> (480 + 1020) % 1440 = 60 (01:00 UTC, hour 1)
  const hour1Row = hoursUtc.find(r => r.grain.hour === 1 && r.direction === 'A');
  assert.ok(hour1Row && hour1Row.flights > 0, 'UTC time basis must shift 08:00 local to 01:00 UTC (hour 1)');

  // Expected watermark mismatch
  let versionMismatchFailed = false;
  try {
    await db.query(
      `select public.get_public_traffic_html_export_v2($1::jsonb, 9999999, $2::timestamptz)`,
      [JSON.stringify(htmlReq), M0_FIXTURE.dataAsOf]
    );
  } catch (err) {
    versionMismatchFailed = true;
    assert.match(err.message, /DATA_VERSION_CHANGED/, 'Expected watermark mismatch must raise DATA_VERSION_CHANGED');
  }
  assert.ok(versionMismatchFailed, 'Must fail on expected watermark mismatch');

  // --- 5. Optional Variance Analysis (Explicit Env Path Only) ----------------
  const varianceEnvPath = process.env.SEASONAL_VARIANCE_ANALYSIS_MIGRATION_PATH;
  if (varianceEnvPath) {
    console.log(`Phase 5: Validating Variance Analysis from explicit env path ${varianceEnvPath}...`);
    assert.ok(existsSync(varianceEnvPath), `Explicit variance migration file must exist at ${varianceEnvPath}`);
    const varianceSql = stripPsqlMetaCommands(await readFile(varianceEnvPath, 'utf8'));
    await db.exec(varianceSql);

    const varianceReq = {
      contract_version: 'traffic-html-data-v2',
      html_template: 'variance-analysis-v1',
      report_type: 'VARIANCE_ANALYSIS',
      period_mode: 'custom',
      from: '2026-10-27',
      to: '2026-10-28',
      baseline_from: '2026-10-25',
      baseline_to: '2026-10-26',
      comparisons: [],
      comparison_years: [],
      airlines: [],
      routes: [],
      countries: [],
      time_basis: 'local',
    };

    const varianceRes = (
      await db.query(
        `select public.get_public_traffic_html_export_v2($1::jsonb, null, $2::timestamptz) as res`,
        [JSON.stringify(varianceReq), M0_FIXTURE.dataAsOf]
      )
    ).rows[0].res;

    assert.equal(varianceRes.contract_version, 'traffic-html-data-v2');
    assert.equal(varianceRes.periods.length, 2, 'Variance analysis must produce 2 periods');
    assert.ok(varianceRes.periods.some(p => p.id === 'current'), 'Contains current period');
    assert.ok(varianceRes.periods.some(p => p.id === 'baseline'), 'Contains baseline period');
    assert.deepEqual(
      varianceRes.comparison_pairs.map(p => [p.minuend_period, p.baseline_period]),
      [['current', 'baseline']],
      'Comparison pair must be current-vs-baseline'
    );
    assert.ok(varianceRes.resources.some(r => r.period_id === 'current' && r.dataset === 'kpi'));
    assert.ok(varianceRes.resources.some(r => r.period_id === 'baseline' && r.dataset === 'kpi'));
  }

  console.log(JSON.stringify({ suite: 'seasonal-operational-html-cutover', status: 'passed' }));
} finally {
  await ctx.close();
}
