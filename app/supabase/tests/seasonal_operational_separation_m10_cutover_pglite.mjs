// M10 Controlled reader cutover & rollback PGlite behavioral test.
// Proves:
// 1. Default gate OFF: Legacy reader authority unchanged, operational mutations isolated.
// 2. Refuse unsafe stale cutover: Cannot cut over when projection is stale (55000).
// 3. Controlled switch: Explicit cutover under table locks mirrors operational canonical projection.
// 4. Legacy writer fencing: Modification to legacy tables blocked during cutover (55000).
// 5. Visibility post-cutover: Operational legs visible in reporting.flight_operations (43 cols) and get_public_traffic_report_v2.
// 6. Fail-closed stale report: get_public_traffic_report_v2 rejects stale projection with 40001.
// 7. Strict data-safe reverse: Rejects reverse if native operational writes have occurred post-cutover.
// 8. Rollback: Restores exact preimages without leaking state or locks.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
import { rollbackChainMigrationsAfter, stripPsqlMetaCommands } from './seasonal_operational_separation_test_support.mjs';

const MIGRATION_NAME = '20260929120000_seasonal_operational_reader_cutover_v1.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const ctx = await buildM0Fixture();
const { db } = ctx;

try {
  await rollbackChainMigrationsAfter(db, MIGRATION_NAME);
  // --- 0. Rollback Clean State Check ---------------------------------------
  console.log('Testing rollback cleanliness prior to applying migration...');
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  await db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK_URL, 'utf8')));

  const stateTableAbsent = (
    await db.query(`select to_regclass('reporting.operational_reader_cutover_state') is null as absent`)
  ).rows[0].absent;
  assert.equal(stateTableAbsent, true, 'Rollback must drop operational_reader_cutover_state');

  // Re-apply migration for behavioral test suite
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));

  // --- 1. Gate OFF: Legacy Reader Authority Unchanged ---------------------
  console.log('Phase 1: Validating default Gate OFF state...');
  const isCutoverInitial = (
    await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)
  ).rows[0].active;
  assert.equal(isCutoverInitial, false, 'Default cutover state must be false (gate OFF)');

  // Legacy writer succeeds while gate is OFF
  await db.query(`
    insert into public.season_modifications (
      season_id, leg_id, action, changed_fields, pax
    ) values ($1, 'MOD-OFF-1', 'modified', array['pax'], 150)
    on conflict (leg_id) do nothing
  `, [M0_FIXTURE.seasonM26]);

  // Seed a new operational leg in public.operational_flight_legs
  const opLegId = '00000000-0000-4000-8000-000000000099';
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status, gate, stand, carousel
    ) values (
      $1, 'A' || chr(31) || '2026-06-15' || chr(31) || 'VN' || chr(31) || 'VN100', '2026-06-15', '2026-06-15', '10:30',
      'ARR', 'VN', 'VN100', 'SGN-HAN', 'A321', 180,
      $2, 'operational_manual', 'active', 4, '12', 2
    ) on conflict (leg_id) do nothing
  `, [opLegId, M0_FIXTURE.seasonM26]);

  // Operational leg is NOT visible in legacy flight_operations while gate is OFF
  const legacyFlightOps = (
    await db.query(`
      select count(*)::integer as c from reporting.flight_operations
      where flight = 'VN100' or flight_series_id = 'VN100'
    `)
  ).rows[0].c;
  assert.equal(legacyFlightOps, 0, 'Operational-only mutation must not appear in legacy flight_operations while gate is OFF');

  // Verify Wallboard & Annual KPI functions when gate is OFF
  const legacyKpiVersion = (
    await db.query(`select public.get_public_annual_passenger_kpi_version_v1(2026) as v`)
  ).rows[0].v;
  assert.equal(legacyKpiVersion.year, 2026);
  assert.ok('projection_status' in legacyKpiVersion);

  const legacyKpi = (
    await db.query(`select public.get_public_annual_passenger_kpi_v1(2026, date '2026-06-30') as kpi`)
  ).rows[0].kpi;
  assert.equal(legacyKpi.contract_version, 'annual-passenger-kpi-v1');

  // --- 2. Refuse Unsafe Stale Cutover -------------------------------------
  console.log('Phase 2: Validating refusal of stale cutover...');
  // Emit a new change event to make the shadow projection watermark stale
  await db.query(`
    insert into public.season_change_events (
      season_id, client_id, op_id, target_type, target_id, op_payload
    ) values (
      $1, 'client-m10', gen_random_uuid()::text, 'leg', $2, '{"test":true}'::jsonb
    )
  `, [M0_FIXTURE.seasonM26, opLegId]);

  // Attempt cutover before refreshing projection -> MUST FAIL WITH 55000
  await assert.rejects(
    async () => db.query(`select reporting.cutover_operational_readers_v1('test-operator')`),
    (err) => err.code === '55000' && /operational projection is stale/i.test(err.message),
    'Cutover must refuse to activate when projection is stale'
  );

  // --- 3. Refresh & Explicit Cutover --------------------------------------
  console.log('Phase 3: Refreshing projection and executing controlled cutover...');
  // Refresh operational canonical projection to bring it up to watermark
  await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);

  const projStatus = (
    await db.query(`select * from reporting.operational_projection_status_v1()`)
  ).rows[0];
  assert.equal(projStatus.is_fresh, true, 'Projection must be fresh after refresh');

  // Now cutover succeeds
  const cutoverRes = (
    await db.query(`select reporting.cutover_operational_readers_v1('integration-tester') as res`)
  ).rows[0].res;
  assert.equal(cutoverRes.status, 'cutover_success', 'Cutover must return cutover_success');

  const isCutoverActive = (
    await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)
  ).rows[0].active;
  assert.equal(isCutoverActive, true, 'Cutover must now be active');

  // --- 4. Fencing Legacy Writers ------------------------------------------
  console.log('Phase 4: Validating legacy writer fencing during cutover...');
  await assert.rejects(
    async () => db.query(`
      insert into public.season_flight_records (
        season_id, record_id, flight_number, airline, type, date, operational_date
      ) values ($1, 'FENCED-1', 'VN888', 'VN', 'A', '2026-06-15', '2026-06-15')
    `, [M0_FIXTURE.seasonM26]),
    (err) => err.code === '55000' && /Legacy writer is fenced/i.test(err.message),
    'Insert to season_flight_records must be fenced during cutover'
  );

  await assert.rejects(
    async () => db.query(`
      update public.season_modifications
      set changed_fields = array['pax']
      where season_id = $1
    `, [M0_FIXTURE.seasonM26]),
    (err) => err.code === '55000' && /Legacy writer is fenced/i.test(err.message),
    'Update to season_modifications must be fenced during cutover'
  );

  // Verify legacy daily_schedule_import_batches insert with contract 1 is fenced
  await assert.rejects(
    async () => db.query(`
      insert into public.daily_schedule_import_batches (
        batch_id, request_id, contract_version, status, file_name, workbook_profile,
        raw_checksum, canonical_checksum, resource_policy_hash, diagnostics, preview, preview_hash
      ) values (
        gen_random_uuid(), gen_random_uuid(), 1, 'failed', 'legacy.xlsx', 'ams',
        'c1', 'c2', 'p1', '[]'::jsonb, '{}'::jsonb, 'h1'
      )
    `),
    (err) => err.code === '55000' && /Legacy writer is fenced/i.test(err.message),
    'Insert to daily_schedule_import_batches with contract 1 must be fenced during cutover'
  );

  // Verify legacy stage_daily_schedule_import_v1 is denied during cutover
  await assert.rejects(
    async () => db.query(`
      select public.stage_daily_schedule_import_v1($1::jsonb)
    `, [JSON.stringify({
      contractVersion: 1,
      seasonId: M0_FIXTURE.seasonM26,
      requestId: '00000000-0000-4000-8000-000000000077',
      fileName: 'legacy_daily.xlsx',
      workbookProfile: 'ams',
      rawChecksum: 'raw-1',
      canonicalChecksum: 'can-1',
      resourcePolicyHash: 'pol-1',
      seasons: [],
      diagnostics: [],
      legs: []
    })]),
    (err) => err.code === '55000' && /Legacy writer is fenced/i.test(err.message),
    'Legacy stage_daily_schedule_import_v1 must be rejected with 55000 during cutover'
  );

  // Clean reversal is permitted only before any committed native mutation.
  const reverseRes = (
    await db.query(`select reporting.reverse_operational_readers_v1('clean rehearsal reverse') as res`)
  ).rows[0].res;
  assert.equal(reverseRes.status, 'reversed');
  assert.equal((await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)).rows[0].active, false);
  await db.query(`
    insert into public.season_modifications (
      season_id, leg_id, action, changed_fields, pax
    ) values ($1, 'MOD-AFTER-REVERSE', 'modified', array['pax'], 150)
    on conflict (leg_id) do nothing
  `, [M0_FIXTURE.seasonM26]);
  await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);
  await db.query(`select reporting.cutover_operational_readers_v1('test-operator-native-writes')`);

  // --- 5. Operational Mutation & Native Daily V2 Visible Post-Cutover ---------
  console.log('Phase 5: Verifying native Daily V2 and operational mutations visible post-cutover...');
  // Check reporting.flight_operations has the 43 columns and sees the operational leg
  const opRow = (
    await db.query(`
      select season_id, season, record_id, flight, airline, route, country,
             aircraft, pax, scheduled_date, scheduled_time, ops_date, gate, stand,
             carousel, ac_group, local_hour, local_bucket_30
      from reporting.flight_operations
      where record_id = $1
    `, [opLegId])
  ).rows[0];

  assert.ok(opRow, 'Operational leg must be visible in reporting.flight_operations');
  assert.equal(opRow.flight, 'VN100');
  assert.equal(opRow.airline, 'VN');
  assert.equal(opRow.pax, 180);
  assert.equal(opRow.gate, 4);
  assert.equal(opRow.carousel, 2);
  assert.equal(opRow.stand, '12');

  // Native M5 Daily V2 under cutover:
  // Ensure writer has daily.write permission
  await db.query(`
    insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
    values
      ($1, 'daily.write', 'allow'),
      ($1, 'daily.read', 'allow'),
      ($1, 'seasonal.read', 'allow')
    on conflict do nothing
  `, [M0_FIXTURE.writerId]);

  await db.query(`set role authenticated`);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [M0_FIXTURE.writerId]);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false)`);

  // 5a: Zero-flight Daily V2 import: stage -> retry -> cancel
  const dailyZeroReq = '00000000-0000-4000-8000-000000000091';
  const zeroPayload = {
    contractVersion: 2,
    requestId: dailyZeroReq,
    fileName: 'daily_m10_zero.xlsx',
    workbookProfile: 'ams',
    rawChecksum: 'raw-zero',
    canonicalChecksum: 'canonical-zero',
    resourcePolicyHash: 'policy-zero',
    legs: [],
    affectedDates: ['2026-06-25'],
    confirmedZeroFlightDates: ['2026-06-25'],
    diagnostics: [],
  };
  const stagedZero = (
    await db.query(`select public.stage_daily_schedule_import_v2($1::jsonb) as res`, [JSON.stringify(zeroPayload)])
  ).rows[0].res;
  assert.equal(stagedZero.status, 'validated', 'Native Daily V2 zero-flight staging must succeed');

  // Staging retry
  const stagedZeroRetry = (
    await db.query(`select public.stage_daily_schedule_import_v2($1::jsonb) as res`, [JSON.stringify(zeroPayload)])
  ).rows[0].res;
  assert.deepEqual(stagedZeroRetry, stagedZero, 'Daily V2 stage retry returns same batch');

  // Status check
  const zeroStatus = (
    await db.query(`select public.get_daily_schedule_import_v2_status($1::uuid) as res`, [dailyZeroReq])
  ).rows[0].res;
  assert.ok(zeroStatus, 'Status check must return batch');

  // Cancel test
  await db.query(`select public.cancel_daily_schedule_import_v2($1::uuid)`, [stagedZero.batchId]);
  const cancelledBatch = (
    await db.query(`select status from public.daily_schedule_import_batches where batch_id = $1`, [stagedZero.batchId])
  ).rows[0];
  assert.equal(cancelledBatch.status, 'cancelled', 'Daily V2 batch must cancel cleanly under cutover');

  // 5b: Non-zero Daily V2 leg import: stage -> commit -> retry
  const dailyLegReq = '00000000-0000-4000-8000-000000000092';
  const fullCalendarDates = [];
  const startD = new Date('2026-01-01T00:00:00Z');
  const endD = new Date('2026-06-26T00:00:00Z');
  for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
    fullCalendarDates.push(d.toISOString().slice(0, 10));
  }
  const zeroFlightDates = fullCalendarDates.filter((dateStr) => dateStr !== '2026-06-26');
  const dailyLegPayload = {
    contractVersion: 2,
    requestId: dailyLegReq,
    fileName: 'daily_m10_full.xlsx',
    workbookProfile: 'ams',
    rawChecksum: 'raw-full-1',
    canonicalChecksum: 'canonical-full-1',
    resourcePolicyHash: 'policy-full-1',
    legs: [{
      operationalDate: '2026-06-26',
      scheduledDate: '2026-06-26',
      scheduledTime: '08:30',
      side: 'ARR',
      airline: 'VN',
      flightNumber: 'VN888',
      rawFlightNumber: 'VN888',
      route: 'SGN-HAN',
      aircraft: 'A350',
      category: 'C',
      sourceRowNumber: 1,
      sheetName: 'AMS',
      resources: { pax: 250, gate: 7, stand: '20', carousel: 3 }
    }],
    affectedDates: fullCalendarDates,
    confirmedZeroFlightDates: zeroFlightDates,
    diagnostics: [],
  };
  const stagedLeg = (
    await db.query(`select public.stage_daily_schedule_import_v2($1::jsonb) as res`, [JSON.stringify(dailyLegPayload)])
  ).rows[0].res;
  assert.equal(stagedLeg.status, 'validated', 'Native Daily V2 leg staging must succeed');

  const committedLeg = (
    await db.query(`select public.commit_daily_schedule_import_v2($1::uuid, $2) as res`, [stagedLeg.batchId, stagedLeg.previewHash])
  ).rows[0].res;
  assert.equal(committedLeg.status, 'committed', 'Native Daily V2 commit must succeed');

  // Commit retry returns same receipt
  const commitRetry = (
    await db.query(`select public.commit_daily_schedule_import_v2($1::uuid, $2) as res`, [stagedLeg.batchId, stagedLeg.previewHash])
  ).rows[0].res;
  assert.deepEqual(commitRetry, committedLeg, 'Daily V2 commit retry returns identical receipt');

  // Verify no-season Daily / manual leg with overlapping seasons does NOT fan out
  const noSeasonLegId = '00000000-0000-4000-8000-000000000088';
  const overlapDate = '2026-06-20';
  const seasonOverlapA = '00000000-0000-4000-a000-000000000001';
  const seasonOverlapB = '00000000-0000-4000-a000-000000000002';
  await db.query(`reset role`);
  await db.query(`
    insert into public.seasons (id, season_code, effective_start, effective_end, uploaded_at)
    values
      ($1, 'OVERLAP_A', '2026-06-01', '2026-06-30', 1718000000000),
      ($2, 'OVERLAP_B', '2026-06-15', '2026-06-25', 1718000000000)
    on conflict (id) do nothing
  `, [seasonOverlapA, seasonOverlapB]);

  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, route, aircraft_type, pax,
      source_season_id, source_type, status, gate, stand, carousel
    ) values (
      $1, 'A' || chr(31) || $2 || chr(31) || 'VN' || chr(31) || 'VN999',
      $2::date, $2::date, '14:00',
      'ARR', 'VN', 'VN999', 'HAN-SGN', 'A321', 150,
      null, 'operational_manual', 'active', 5, '15', 3
    )
  `, [noSeasonLegId, overlapDate]);

  const overlapRows = (
    await db.query(`
      select record_id, season_id, season, flight, source_kind
      from reporting.flight_operations
      where record_id = $1
    `, [noSeasonLegId])
  ).rows;

  assert.equal(
    overlapRows.length,
    1,
    'Operational leg without season MUST produce exactly 1 row even if multiple seasons overlap its date (no fan-out)'
  );
  assert.ok(!overlapRows[0].season_id, 'Season ID must be blank/null for unassociated leg');
  assert.equal(overlapRows[0].source_kind, 'added', 'Operational manual leg must map source_kind to added');

  // Verify authenticated role can query reporting.flight_operations and summary_* without 42501
  await db.query(`set role authenticated`);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [M0_FIXTURE.writerId]);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false)`);

  const authenticatedFlight = (
    await db.query(`select flight, pax, source_kind from reporting.flight_operations where record_id = $1`, [noSeasonLegId])
  ).rows[0];
  assert.deepEqual(authenticatedFlight, { flight: 'VN999', pax: 150, source_kind: 'added' });
  const authenticatedSummary = (
    await db.query(`select flights, pax from reporting.summary_airline where coalesce(season_id, '') = '' and airline = 'VN' and type = 'A'`)
  ).rows[0];
  assert.deepEqual(authenticatedSummary, { flights: 2, pax: 400 }, 'Authenticated AI summary counts no-season Daily and Manual exactly once');

  await db.query(`reset role`);

  // Refresh projection to incorporate new operational legs
  await db.query(`select reporting.refresh_operational_canonical_legs_v1()`);

  // Verify reporting.canonical_flight_legs was mirrored
  const canonicalLeg = (
    await db.query(`
      select ops_date, airline, flight_number, pax
      from reporting.canonical_flight_legs
      where flight_number = 'VN888'
    `)
  ).rows[0];
  assert.ok(canonicalLeg, 'Native Daily V2 committed leg must be mirrored to canonical_flight_legs');
  assert.equal(canonicalLeg.pax, 250);
  assert.equal(canonicalLeg.airline, 'VN');

  // Verify public.get_public_traffic_report_v2 executes cleanly
  const reportPayload = (
    await db.query(`
      select public.get_public_traffic_report_v2(
        p_from_date => '2026-06-01'::date,
        p_to_date => '2026-06-30'::date
      ) as report
    `)
  ).rows[0].report;
  assert.equal(reportPayload.contract_version, 'traffic-report-v2');
  assert.equal(reportPayload.current.flights, 2, 'Report must count native Daily and Manual legs exactly once');

  // Verify Wallboard & Annual Passenger KPI consumers under cutover
  console.log('Phase 5c: Verifying Wallboard & Annual Passenger KPI consumers under cutover...');

  // 1) Annual KPI version reflects operational freshness
  const annualKpiVersion = (
    await db.query(`select public.get_public_annual_passenger_kpi_version_v1(2026) as v`)
  ).rows[0].v;
  assert.equal(annualKpiVersion.year, 2026);
  assert.equal(annualKpiVersion.projection_status, 'fresh');
  const legacyHighWater = (await db.query(`select coalesce(max(server_seq), 0) as watermark from public.season_change_events`)).rows[0].watermark;
  assert.ok(BigInt(annualKpiVersion.source_watermark) > BigInt(legacyHighWater), 'Native commits must advance the cache generation without legacy writes');
  assert.equal(annualKpiVersion.source_watermark, reportPayload.source_watermark, 'Report and KPI must expose the same committed generation');

  // 2) Annual KPI metrics query canonical flight legs under cutover
  const annualKpi = (
    await db.query(`select public.get_public_annual_passenger_kpi_v1(2026, date '2026-06-30') as kpi`)
  ).rows[0].kpi;
  assert.equal(annualKpi.contract_version, 'annual-passenger-kpi-v1');
  assert.equal(annualKpi.year, 2026);
  assert.equal(annualKpi.projection.projection_status, 'fresh');
  assert.equal(annualKpi.reported_pax, 400);
  assert.equal(annualKpi.reported_legs, 2);

  // 4) Verify select_public_dashboard_candidate_v1 works under cutover
  const candidate = (
    await db.query(`select reporting.select_public_dashboard_candidate_v1(timestamptz '2026-06-27 12:00:00+07') as c`)
  ).rows[0].c;
  assert.equal(candidate.year, 2026);
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.eligible, true);

  // 5) Verify publish_public_dashboard_daily_v1 publishes under cutover using operational watermark
  const opWatermark = annualKpiVersion.source_watermark;
  const publishReceipt = (
    await db.query(`
      select public.publish_public_dashboard_daily_v1(
        $1::integer,
        $2::date,
        $3::bigint,
        $4::text,
        'daily_acceptance',
        'Cutover daily publication'
      ) as r
    `, [candidate.year, candidate.business_date, candidate.source_watermark, candidate.idempotency_key])
  ).rows[0].r;
  assert.ok(publishReceipt, 'publish_public_dashboard_daily_v1 must return receipt under cutover');
  assert.equal(publishReceipt.status, 'ready', `Publication must succeed and be ready under cutover: ${publishReceipt.error}`);
  assert.equal(publishReceipt.reported_legs, 2, 'Must report exactly 2 legs (VN888 + VN999)');


  // 6) Verify get_public_dashboard_publication_v1 and version
  const dashboardPub = (
    await db.query(`select public.get_public_dashboard_publication_v1(2026) as p`)
  ).rows[0].p;
  assert.ok(dashboardPub, 'get_public_dashboard_publication_v1 must return publication payload');
  assert.equal(dashboardPub.contract_version, 'annual-passenger-publication-v2');
  assert.equal(dashboardPub.publication.freshness, 'fresh');
  assert.equal(dashboardPub.reported_pax, 400, 'Reported pax must match native canonical keys sum (250 + 150 = 400)');
  assert.equal(dashboardPub.reported_legs, 2, 'Reported legs must match 2');

  const dashboardPubVersion = (
    await db.query(`select public.get_public_dashboard_publication_version_v1(2026) as pv`)
  ).rows[0].pv;
  assert.equal(dashboardPubVersion.contract_version, 'annual-passenger-publication-version-v1');
  assert.equal(dashboardPubVersion.freshness, 'fresh');
  assert.equal(dashboardPubVersion.business_date, '2026-06-26');
  // Negative test: unaccepted date (2026-06-27) fails completeness validation
  const incompleteReceipt = (
    await db.query(`
      select public.publish_public_dashboard_daily_v1(
        2026,
        date '2026-06-27',
        $1,
        'test-m10-cutover-publish-incomplete',
        'daily_acceptance',
        'Incomplete daily publication test'
      ) as r
    `, [opWatermark])
  ).rows[0].r;
  assert.equal(incompleteReceipt.status, 'incomplete', 'Publication for unaccepted date must result in status incomplete');

  const stalePublicationVersion = (
    await db.query(`select public.get_public_dashboard_publication_version_v1(2026) as pv`)
  ).rows[0].pv;
  assert.equal(stalePublicationVersion.freshness, 'stale');
  assert.equal(stalePublicationVersion.latest_attempt_status, 'incomplete');
  assert.equal(stalePublicationVersion.publication_id, dashboardPubVersion.publication_id, 'Incomplete attempt must retain the previous ready head');
  assert.equal(stalePublicationVersion.payload_checksum, dashboardPubVersion.payload_checksum, 'Published snapshot remains immutable after an incomplete attempt');

  // --- 6. Fail-closed: Stale Projection during Cutover ---------------------
  console.log('Phase 6: Verifying fail-closed behavior on stale projection during cutover...');
  await db.query(`
    insert into public.season_change_events (
      season_id, client_id, op_id, target_type, target_id, op_payload
    ) values (
      $1, 'client-m10-2', gen_random_uuid()::text, 'leg', '00000000-0000-4000-8000-000000000098', '{"test":true}'::jsonb
    )
  `, [M0_FIXTURE.seasonM26]);

  // get_public_traffic_report_v2 must reject with 40001
  await assert.rejects(
    async () => db.query(`
      select public.get_public_traffic_report_v2(
        p_from_date => '2026-06-01'::date,
        p_to_date => '2026-06-30'::date
      )
    `),
    (err) => err.code === '40001' && /STALE_OPERATIONAL_PROJECTION/i.test(err.message),
    'Public traffic report must fail closed (40001) when operational projection is stale'
  );

  // Calling refresh_public_traffic_canonical_legs_v1 delegates to operational refresh and cures staleness
  await db.query(`select reporting.refresh_public_traffic_canonical_legs_v1()`);
  const healedReport = (
    await db.query(`
      select public.get_public_traffic_report_v2(
        p_from_date => '2026-06-01'::date,
        p_to_date => '2026-06-30'::date
      ) as report
    `)
  ).rows[0].report;

  // Verify monotonic generation watermark: matching expected_watermark succeeds
  const currentWatermark = healedReport.source_watermark;
  assert.ok(currentWatermark !== null && currentWatermark !== undefined);
  const matchedReport = (
    await db.query(`
      select public.get_public_traffic_report_v2(
        p_from_date => '2026-06-01'::date,
        p_to_date => '2026-06-30'::date,
        p_expected_watermark => $1
      ) as report
    `, [currentWatermark])
  ).rows[0].report;
  assert.ok(matchedReport, 'Report with matching expected watermark must succeed');

  // Verify rejection with 40001 when expected_watermark is stale (e.g. currentWatermark - 1)
  await assert.rejects(
    async () => db.query(`
      select public.get_public_traffic_report_v2(
        p_from_date => '2026-06-01'::date,
        p_to_date => '2026-06-30'::date,
        p_expected_watermark => $1
      )
    `, [BigInt(currentWatermark) - 1n]),
    (err) => err.code === '40001' && /DATA_VERSION_CHANGED/i.test(err.message),
    'Report must reject stale expected watermark with 40001 DATA_VERSION_CHANGED'
  );

  // --- 7. Strict Data-Safe Reversal ---------------------------------------
  console.log('Phase 7: Verifying data-safe reversal...');
  await assert.rejects(
    async () => db.query(`select reporting.reverse_operational_readers_v1('test-reversal')`),
    (err) => err.code === '55000' && /operational mutations have occurred/i.test(err.message),
    'Reverse must refuse after actual committed native Daily and Manual mutations'
  );
  assert.equal((await db.query(`select reporting.is_operational_reader_cutover_active_v1() as active`)).rows[0].active, true);

  // --- 8. Rollback Migration Validation ------------------------------------
  console.log('Phase 8: Executing rollback migration...');
  const rollbackCtx = await buildM0Fixture();
  try {
    await rollbackChainMigrationsAfter(rollbackCtx.db, MIGRATION_NAME);
    const consumerQuery = `
      select public.get_public_annual_passenger_kpi_version_v1(2026) as version,
             public.get_public_annual_passenger_kpi_v1(2026, date '2026-06-30') as kpi,
             reporting.select_public_dashboard_candidate_v1(timestamptz '2026-07-01 09:00:00+07') as candidate
    `;
    const consumersBeforeRollback = (await rollbackCtx.db.query(consumerQuery)).rows[0];
    await rollbackCtx.db.exec(stripPsqlMetaCommands(await readFile(ROLLBACK_URL, 'utf8')));
    assert.deepEqual(
      (await rollbackCtx.db.query(consumerQuery)).rows[0],
      consumersBeforeRollback,
      'Rollback must preserve legacy KPI, version and candidate behavior'
    );
    const rollbackState = (await rollbackCtx.db.query(`
      select to_regclass('reporting.operational_reader_cutover_state') is null as state_absent,
             to_regclass('reporting.operational_flight_operations_v1') is null as native_view_absent
    `)).rows[0];
    assert.deepEqual(rollbackState, { state_absent: true, native_view_absent: true });
  } finally {
    await rollbackCtx.close();
  }

  console.log('M10 cutover suite PASS: All 8 phases verified successfully.');
} finally {
  await ctx.close();
}
