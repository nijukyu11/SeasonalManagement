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
const db = await createSupabasePGlite();

async function addSeason(id, code) {
  await db.query(`
    insert into public.seasons (
      id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
      total_legs, total_source_rows, data_version, last_synced_at
    ) values ($1, $2, $2, '', 1, '2026-01-01', '2026-12-31', 0, 0, 1, 1)
  `, [id, code]);
}

async function addRecord({ seasonId, id, date, time, type = 'A', airline = 'VN', flight = id, route = 'HAN', aircraft = 'A321', pax = null }) {
  await db.query(`
    insert into public.season_flight_records (
      season_id, record_id, type, airline, flight_number, route, schedule, aircraft,
      pax, date, scheduled_date, operational_date, source_side, status
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, '', $11, 'active')
  `, [seasonId, id, type, airline, flight, route, time, aircraft, pax, date, type === 'A' ? 'ARR' : 'DEP']);
}

try {
  await db.exec(schemaSql);
  // schema.sql mirrors the production migration. Re-applying it verifies the
  // additive migration stays safe for an already provisioned database.
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
  await db.exec(aircraftTypeSql);
  await db.exec(removeSuppressionSql);
  await db.exec(removeSuppressionSql);
  await db.exec(regularFlightsSql);
  await db.exec(regularFlightsSql);
  await db.exec(annualPassengerKpiSql);
  await db.exec(annualPassengerKpiSql);
  await db.exec(annualPassengerKpiOwnerSql);
  await db.exec(annualPassengerKpiOwnerSql);
  await db.exec(liveCandidateSliceSql);
  await db.exec(liveCandidateSliceSql);
  await db.exec(liveAggregateV2Sql);
  await db.exec(liveAggregateV2Sql);
  await db.exec(dashboardDailyPublicationSql);
  await db.exec(dashboardDailyPublicationSql);

  await addSeason('old-season', 'W25');
  await addSeason('new-season', 'S26');
  await db.query(`insert into public.operational_aircraft_groups (id, name) values ('narrowbody', 'Narrowbody')`);
  await db.query(`insert into public.operational_aircraft_group_types (group_id, aircraft_type) values ('narrowbody', 'A320'), ('narrowbody', 'A321'), ('narrowbody', 'B738')`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('old-season', 'import', 'old', 'seasonImport', 'old-season')`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('new-season', 'import', 'new', 'seasonImport', 'new-season')`);

  await addRecord({ seasonId: 'old-season', id: 'old-duplicate', date: '2026-03-02', time: '06:00', flight: 'VN101', pax: 100 });
  await addRecord({ seasonId: 'new-season', id: 'new-duplicate', date: '2026-03-02', time: '06:00', flight: 'VN101', pax: 120 });
  await db.query(`insert into public.season_modifications (season_id, leg_id, action) values ('new-season', 'new-duplicate', 'deleted')`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('new-season', 'edit', 'delete', 'modification', 'new-duplicate')`);

  await addRecord({ seasonId: 'new-season', id: 'before-five', date: '2026-03-03', time: '04:59', flight: 'VN201', pax: 80 });
  await addRecord({ seasonId: 'new-season', id: 'at-five', date: '2026-03-03', time: '05:00', flight: 'VN202', pax: 0 });
  await addRecord({ seasonId: 'new-season', id: 'departure', date: '2026-03-03', time: '07:00', type: 'D', flight: 'VN203', route: 'SGN', pax: null });
  await addRecord({ seasonId: 'new-season', id: 'arrival-two', date: '2026-03-03', time: '08:00', flight: 'VN204', pax: 40 });
  await addRecord({ seasonId: 'new-season', id: 'arrival-three', date: '2026-03-03', time: '08:30', flight: 'VN205', pax: 50 });
  await addRecord({ seasonId: 'new-season', id: 'departure-two', date: '2026-03-03', time: '09:00', type: 'D', flight: 'VN206', pax: 60 });
  await addRecord({ seasonId: 'new-season', id: 'departure-three', date: '2026-03-03', time: '09:30', type: 'D', flight: 'VN207', route: 'SGN', pax: null });
  await addRecord({ seasonId: 'new-season', id: 'departure-four', date: '2026-03-03', time: '10:00', type: 'D', flight: 'VN208', route: 'SGN', pax: null });
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');
  await db.query(`insert into reporting.public_traffic_coverage (from_date, to_date, status, reason_code, certified_at) values (date '2026-03-04', date '2026-03-05', 'complete', 'test-certified-zero', now())`);

  const effective = await db.query(`select ops_date::text, count(*)::integer as flights from reporting.public_traffic_effective group by ops_date order by ops_date`);
  assert.deepEqual(effective.rows, [
    { ops_date: '2026-03-02', flights: 1 },
    { ops_date: '2026-03-03', flights: 7 },
  ], '04:59/05:00 Ops Date boundary or tombstone dedupe is wrong');

  const duplicate = await db.query(`select count(*)::integer as count from reporting.public_traffic_effective where airline = 'VN' and ops_date = date '2026-03-02' and pax = 100`);
  assert.equal(duplicate.rows[0].count, 0, 'a newer tombstone resurrected the older cross-season leg');
  const projectionState = await db.query(`select status,source_data_version,source_watermark is not null as has_watermark,snapshot_rows from reporting.public_traffic_projection_state where projection_name='public_traffic_effective'`);
  assert.deepEqual(projectionState.rows, [{ status: 'fresh', source_data_version: 1, has_watermark: true, snapshot_rows: 8 }]);

  const annualKpiConfig = (await db.query(`select public.get_public_annual_passenger_kpi_config_v1(2026) as result`)).rows[0].result;
  assert.equal(annualKpiConfig.items.length, 1);
  assert.equal(annualKpiConfig.items[0].target_reported_pax, 7500000);
  const annualKpiOwners = (await db.query(`
    select table_owner.tableowner, function_owner.function_owner
    from (
      select tableowner
      from pg_tables
      where schemaname = 'reporting' and tablename = 'annual_passenger_kpis'
    ) table_owner
    cross join (
      select pg_get_userbyid(proowner) as function_owner
      from pg_proc
      where oid = 'public.upsert_annual_passenger_kpi_v1(integer,bigint)'::regprocedure
    ) function_owner
  `)).rows[0];
  assert.equal(annualKpiOwners.tableowner, annualKpiOwners.function_owner, 'the SECURITY DEFINER writer must own its protected table');
  await db.exec('set role service_role');
  try {
    const roleSavedKpi = (await db.query(`select public.upsert_annual_passenger_kpi_v1(2026, 7500000) as result`)).rows[0].result;
    assert.equal(roleSavedKpi.target_reported_pax, 7500000, 'the Edge service role must be able to write only through the SECURITY DEFINER wrapper');
  } finally {
    await db.exec('reset role');
  }

  const annualKpi = (await db.query(`select public.get_public_annual_passenger_kpi_v1(2026, date '2026-03-04') as result`)).rows[0].result;
  assert.equal(annualKpi.contract_version, 'annual-passenger-kpi-v1');
  assert.equal(annualKpi.period_state, 'current');
  assert.equal(annualKpi.period_to, '2026-03-03');
  assert.equal(annualKpi.reported_pax, 230);
  assert.equal(annualKpi.arrival_reported_pax + annualKpi.departure_reported_pax, annualKpi.reported_pax);
  assert.equal(annualKpi.data_ready, false, 'incomplete Pax coverage must block countdown and forecast');
  assert.equal(annualKpi.required_reported_pax_today, null);
  assert.equal(annualKpi.forecast_reported_pax, null);
  assert.equal(annualKpi.status, 'unknown');
  assert.equal(annualKpi.monthly[2].reported_pax, null, 'an incomplete month must be a gap, not a misleading zero');
  assert.equal(annualKpi.projection.projection_status, 'fresh');

  const futureAnnualKpi = (await db.query(`select public.get_public_annual_passenger_kpi_v1(2027, date '2026-03-04') as result`)).rows[0].result;
  assert.equal(futureAnnualKpi.period_state, 'future');
  assert.equal(futureAnnualKpi.reported_pax, null);
  assert.equal(futureAnnualKpi.status, 'not_started');

  const savedAnnualKpi = (await db.query(`select public.upsert_annual_passenger_kpi_v1(2027, 8000000) as result`)).rows[0].result;
  assert.equal(savedAnnualKpi.target_reported_pax, 8000000);
  assert.equal((await db.query(`select count(*)::integer as count from reporting.annual_passenger_kpis where year=2027`)).rows[0].count, 1);

  await db.query(`insert into reporting.public_traffic_coverage (
    from_date, to_date, status, reason_code, certified_at
  ) values (date '2026-01-01', date '2026-03-02', 'complete', 'test-daily-publication', now())`);
  const publicationWatermark = Number((await db.query(`
    select coalesce(max(server_seq), 0)::bigint as watermark from public.season_change_events
  `)).rows[0].watermark);
  await db.exec('set role service_role');
  let firstPublication;
  let repeatedPublication;
  let rejectedPublication;
  let correctionPublication;
  let dashboardPublication;
  try {
    firstPublication = (await db.query(`select public.publish_public_dashboard_daily_v1(
      2026, date '2026-03-02', $1, 'test-2026-03-02-first', 'daily_acceptance', 'Daily data accepted'
    ) as result`, [publicationWatermark])).rows[0].result;
    repeatedPublication = (await db.query(`select public.publish_public_dashboard_daily_v1(
      2026, date '2026-03-02', $1, 'test-2026-03-02-first', 'daily_acceptance', 'Daily data accepted'
    ) as result`, [publicationWatermark])).rows[0].result;
    rejectedPublication = (await db.query(`select public.publish_public_dashboard_daily_v1(
      2026, date '2026-03-02', $1, 'test-2026-03-02-stale', 'daily_acceptance', 'Stale source rehearsal'
    ) as result`, [publicationWatermark - 1])).rows[0].result;
    dashboardPublication = (await db.query(`
      select public.get_public_dashboard_publication_v1(2026) as result
    `)).rows[0].result;
    correctionPublication = (await db.query(`select public.publish_public_dashboard_daily_v1(
      2026, date '2026-03-02', $1, 'test-2026-03-02-correction', 'manual_correction', 'Accepted correction publication'
    ) as result`, [publicationWatermark])).rows[0].result;
  } finally {
    await db.exec('reset role');
  }
  assert.equal(firstPublication.status, 'ready', 'only a complete fixed-as-of result may advance the Dashboard head');
  assert.equal(repeatedPublication.publication_id, firstPublication.publication_id, 'publisher retries must be idempotent');
  assert.equal(rejectedPublication.status, 'rejected_version', 'a stale expected watermark must fail closed');
  assert.equal(dashboardPublication.publication.publication_id, firstPublication.publication_id, 'a rejected attempt must preserve last-known-good');
  assert.equal(dashboardPublication.publication.freshness, 'stale', 'a failed newer attempt must make staleness visible');
  assert.equal(dashboardPublication.reported_pax, 80, 'a deleted newer lineage must suppress its older predecessor in the live canonical metrics');
  assert.equal(dashboardPublication.true_zero_reported_legs, 0);
  assert.ok(correctionPublication.publication_id > firstPublication.publication_id, 'an accepted correction must create a new immutable version');
  await assert.rejects(
    db.query(`update reporting.public_dashboard_publications set reason = 'changed' where id = $1`, [firstPublication.publication_id]),
    /immutable/,
    'a finalized publication must not be editable in place',
  );
  await assert.rejects(
    db.query(`delete from reporting.public_dashboard_publications where id = $1`, [firstPublication.publication_id]),
    /immutable/,
    'a finalized publication must not be deleted in place',
  );
  await db.exec('set role service_role');
  try {
    const correctedDashboard = (await db.query(`
      select public.get_public_dashboard_publication_v1(2026) as result
    `)).rows[0].result;
    assert.equal(correctedDashboard.publication.publication_id, correctionPublication.publication_id);
    assert.equal(correctedDashboard.publication.freshness, 'fresh');
    await assert.rejects(
      db.query(`select count(*) from reporting.public_dashboard_publications`),
      /permission denied/,
      'the Edge service role must not read the private publication ledger directly',
    );
  } finally {
    await db.exec('reset role');
  }

  const timelineResult = await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-02', date '2026-03-06', null, null, 'day', null, 366, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
  const timeline = timelineResult.rows[0].result;
  assert.equal(timeline.series.length, 5, 'inclusive date spine must contain every day');
  assert.deepEqual(timeline.series.map((row) => row.ops_date), ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-02').flights, 1, 'the internal report must publish a truthful 1-leg aggregate');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-03').flights, 7);
  assert.equal(timeline.series.filter((row) => row.suppressed).length, 0, 'suppression is disabled for the internal aggregate report');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-04').flights, 0, 'certified coverage may publish a true zero');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-06').flights, null, 'an uncovered empty day must not be converted to zero');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-06').completeness, 'missing');

  const kpiResult = await db.query(`select reporting.get_traffic_report_kpis(date '2026-03-03', date '2026-03-03', '{}'::jsonb, 'none', timestamptz '2026-03-10 00:00:00+00') as result`);
  const kpis = kpiResult.rows[0].result;
  assert.equal(kpis.current.flights, 7);
  assert.equal(kpis.current.arrivals + kpis.current.departures, kpis.current.flights);
  assert.equal(kpis.current.reported_pax, 150, 'Pax zero is a reported value and must not change the Pax total');
  assert.equal(kpis.pax_coverage.due_legs, 7);
  assert.equal(kpis.pax_coverage.reported_legs, 4, 'only Pax NULL is missing from coverage');

  const overviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-03', date '2026-03-03', array['A','D'], array[]::text[], array[]::text[], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const overview = overviewResult.rows[0].result;
  assert.equal(overview.contract_version, 'traffic-report-v1');
  assert.equal(overview.metadata.day_count, 1);
  assert.equal(overview.metadata.projection.status, 'fresh');
  assert.equal(overview.metadata.projection.source_data_version, overview.metadata.projection.current_data_version);
  assert.equal(overview.metadata.projection.snapshot_rows, 8);
  assert.equal(overview.timeline.length, 1);
  assert.equal(overview.kpis.current.flights, overview.timeline[0].flights);
  assert.equal(overview.kpis.current.status, 'partial', 'uncertified observed days must remain partial until coverage is certified');
  assert.equal(overview.metadata.partial_day_count, 1);
  assert.equal(overview.metadata.missing_day_count, 0);
  assert.deepEqual(overview.metadata.available_dimensions, ['route', 'country', 'airline']);
  assert.deepEqual(overview.metadata.suppression_policy, { threshold: 0, applied: false });
  assert.equal(overview.breakdowns.peak_hour.length, 24, 'peak-hour publication must include every hour, including zero buckets');
  assert.equal(overview.breakdowns.peak_hour_monthly.length, 1, 'monthly peak publication must include each selected month');
  assert.equal(overview.breakdowns.day_of_week.length, 7, 'day-of-week publication must include Monday through Sunday');
  assert.deepEqual(overview.breakdowns.day_of_week.map((row) => row.day_index), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(overview.metadata.filter_options.airline.includes('VN'), 'publishable airline options must come from the database snapshot');
  assert.ok(overview.metadata.filter_options.route.includes('HAN'), 'publishable route options must come from the database snapshot');
  assert.deepEqual(overview.breakdowns.peak_hour.flatMap((row) => row.regular_flights.arrivals), [], 'short or isolated schedules must not be labeled as recurring');
  assert.ok(!JSON.stringify(overview).includes('record_id'));

  const noPaxOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-03', date '2026-03-03', array['D'], array[]::text[], array['SGN'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const noPaxOverview = noPaxOverviewResult.rows[0].result;
  assert.equal(noPaxOverview.kpis.current.flights, 3);
  assert.equal(noPaxOverview.kpis.current.reported_pax, null, 'a scope with no reported passenger legs must not publish a misleading zero');
  assert.equal(noPaxOverview.kpis.current.arrival_reported_pax, null);
  assert.equal(noPaxOverview.kpis.current.departure_reported_pax, null, 'an all-NULL departure scope must stay unknown instead of becoming zero');
  assert.equal(noPaxOverview.breakdowns.route.find((row) => row.label === 'SGN').reported_pax, null, 'an all-NULL breakdown bucket must remain unknown');
  assert.equal(noPaxOverview.breakdowns.aircraft_type.find((row) => row.label === 'A321').reported_pax, null, 'an all-NULL aircraft type must remain unknown');

  const candidateSliceDiff = (await db.query(`
    with expected as materialized (
      select * from reporting.public_traffic_candidates
      where ops_date between date '2026-03-02' and date '2026-03-03'
        and effective_action is distinct from 'deleted'
    ), actual as materialized (
      select * from reporting.get_public_traffic_candidate_slice_v1(
        date '2026-03-02', date '2026-03-03'
      ) where effective_action is distinct from 'deleted'
    )
    select
      (select count(*)::integer from expected) as expected_count,
      (select count(*)::integer from actual) as actual_count,
      (select count(*)::integer from (select * from expected except all select * from actual) diff)
        as expected_minus_actual,
      (select count(*)::integer from (select * from actual except all select * from expected) diff)
        as actual_minus_expected
  `)).rows[0];
  assert.deepEqual(candidateSliceDiff, {
    expected_count: 9,
    actual_count: 9,
    expected_minus_actual: 0,
    actual_minus_expected: 0,
  }, 'the bounded live seam must preserve every canonical candidate field before ranking');
  const boundedTombstones = (await db.query(`
    select count(*)::integer as count
    from reporting.get_public_traffic_candidate_slice_v1(date '2026-03-02', date '2026-03-03')
    where effective_action = 'deleted'
  `)).rows[0].count;
  assert.equal(boundedTombstones, 1, 'the bounded seam must retain tombstones until canonical lineage ranking');

  await db.exec('set role service_role');
  try {
    await assert.rejects(
      db.query(`select * from reporting.get_public_traffic_candidate_slice_v1(
        date '2026-03-02', date '2026-03-03'
      )`),
      /permission denied/,
    );
    await assert.rejects(
      db.query('select * from reporting.get_public_traffic_canonical_bounds_v1()'),
      /permission denied/,
    );
  } finally {
    await db.exec('reset role');
  }

  const liveV2 = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2'
  ) as result`)).rows[0].result;
  assert.equal(liveV2.contract_version, 'traffic-report-v2');
  assert.equal(liveV2.source_mode, 'live');
  assert.equal(liveV2.timeline.length, 1);
  assert.equal(liveV2.current.flights, 7);
  assert.equal(liveV2.current.arrivals + liveV2.current.departures, liveV2.current.flights);
  assert.equal(liveV2.current.reported_pax, 150, 'live v2 must include positive and true-zero reported Pax without reading the snapshot');
  assert.equal(liveV2.current.reported_legs, 4, 'Pax zero is a reported leg in live v2');
  assert.equal(liveV2.current.true_zero_reported_legs, 1);
  assert.equal(liveV2.current.missing_due_legs, 3);
  assert.equal(liveV2.timeline[0].reported_pax, 150);
  assert.equal(liveV2.report.min_ops_date, overview.metadata.min_ops_date);
  assert.equal(liveV2.report.max_ops_date, overview.metadata.max_ops_date);
  assert.equal(liveV2.report.breakdowns.peak_hour.length, 24);
  assert.equal(liveV2.report.breakdowns.day_of_week.length, 7);
  assert.deepEqual(
    liveV2.report.breakdowns.peak_hour.map((row) => [row.hour_bucket, row.arrivals, row.departures]),
    overview.breakdowns.peak_hour.map((row) => [row.hour_bucket, row.arrivals, row.departures]),
    'v2 feature-parity peak-hour totals must match the snapshot contract',
  );
  assert.deepEqual(
    liveV2.report.breakdowns.day_of_week.map((row) => [row.day_index, row.total_flights, row.arrivals, row.departures]),
    overview.breakdowns.day_of_week.map((row) => [row.day_index, row.total_flights, row.arrivals, row.departures]),
    'v2 feature-parity weekday totals must match the snapshot contract',
  );
  assert.deepEqual(
    liveV2.report.breakdowns.aircraft_group.map((row) => [row.label, row.flights, row.reported_pax]),
    overview.breakdowns.aircraft_group.map((row) => [row.label, row.flights, row.reported_pax]),
    'v2 feature-parity aircraft groups must match the snapshot contract',
  );
  assert.deepEqual(
    liveV2.report.breakdowns.aircraft_type.map((row) => [row.label, row.aircraft_group, row.flights, row.reported_pax]),
    overview.breakdowns.aircraft_type.map((row) => [row.label, row.aircraft_group, row.flights, row.reported_pax]),
    'v2 feature-parity aircraft types must match the snapshot contract',
  );
  assert.ok(!JSON.stringify(liveV2).includes('record_id'), 'the live public contract must remain aggregate-only');
  assert.equal(liveV2.source_watermark, overview.source_watermark, 'v1/v2 differential comparison requires one source watermark');
  assert.deepEqual(
    {
      flights: liveV2.current.flights,
      arrivals: liveV2.current.arrivals,
      departures: liveV2.current.departures,
      reported_pax: liveV2.current.reported_pax,
    },
    {
      flights: overview.kpis.current.flights,
      arrivals: overview.kpis.current.arrivals,
      departures: overview.kpis.current.departures,
      reported_pax: overview.kpis.current.reported_pax,
    },
    'v1 snapshot and v2 live KPI aggregates must match at the same watermark',
  );
  assert.deepEqual(
    liveV2.timeline.map((row) => [row.ops_date, row.flights, row.arrivals, row.departures, row.reported_pax]),
    overview.timeline.map((row) => [row.ops_date, row.flights, row.arrivals, row.departures, row.reported_pax]),
    'v1 snapshot and v2 live daily aggregates must match at the same watermark',
  );
  assert.deepEqual(
    liveV2.dimensions.route.map((row) => [row.label, row.flights, row.reported_pax]),
    overview.breakdowns.route.map((row) => [row.label, row.flights, row.reported_pax]),
    'v1 snapshot and v2 live route aggregates must match at the same watermark',
  );
  const liveV2TimelineScope = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2', 'timeline'
  ) as result`)).rows[0].result;
  const liveV2DimensionScope = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2', 'dimensions'
  ) as result`)).rows[0].result;
  assert.deepEqual(liveV2TimelineScope.timeline, liveV2.timeline, 'timeline scope must preserve the full bundle timeline');
  assert.deepEqual(liveV2DimensionScope.dimensions, liveV2.dimensions, 'dimension scope must preserve the full bundle dimensions');
  assert.equal(liveV2TimelineScope.source_watermark, liveV2.source_watermark);
  assert.equal(liveV2DimensionScope.source_watermark, liveV2.source_watermark);
  const beforePaxMaturity = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2', 'timeline',
    timestamptz '2026-03-03 12:00:00+07'
  ) as result`)).rows[0].result;
  const afterPaxMaturity = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2', 'timeline',
    timestamptz '2026-03-05 12:00:00+07'
  ) as result`)).rows[0].result;
  assert.equal(beforePaxMaturity.source_watermark, afterPaxMaturity.source_watermark, 'time-based maturity may change without a data mutation');
  assert.equal(Date.parse(beforePaxMaturity.data_as_of), Date.parse('2026-03-03T05:00:00Z'));
  assert.equal(Date.parse(afterPaxMaturity.data_as_of), Date.parse('2026-03-05T05:00:00Z'));
  assert.equal(beforePaxMaturity.current.reported_pax, null, 'fixed pre-maturity as-of must not expose Pax early');
  assert.equal(afterPaxMaturity.current.reported_pax, liveV2.current.reported_pax, 'fixed mature as-of must reproduce the compatible report value');
  await assert.rejects(
    db.query(`select public.get_public_traffic_report_v2(
      date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
      array[]::text[], 'none', 'local', null, 'traffic-report-v2', 'raw'
    )`),
    /invalid payload_scope/,
  );

  const liveV2EmptyDays = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-04', date '2026-03-06', 'all', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2'
  ) as result`)).rows[0].result;
  assert.deepEqual(
    liveV2EmptyDays.timeline.map((row) => [row.ops_date, row.flights, row.status]),
    [
      ['2026-03-04', 0, 'zero'],
      ['2026-03-05', 0, 'zero'],
      ['2026-03-06', null, 'missing'],
    ],
    'v2 must distinguish certified zero-flight days from uncovered missing days',
  );

  const liveV2NoPax = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'D', array[]::text[], array['SGN'],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2'
  ) as result`)).rows[0].result;
  assert.equal(liveV2NoPax.current.flights, 3);
  assert.equal(liveV2NoPax.current.reported_pax, null, 'an all-NULL live scope must remain NULL rather than zero');
  assert.equal(liveV2NoPax.current.reported_legs, 0);
  assert.equal(liveV2NoPax.dimensions.route[0].reported_pax, null);

  const liveV2Arrival = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'A', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2'
  ) as result`)).rows[0].result;
  const liveV2Departure = (await db.query(`select public.get_public_traffic_report_v2(
    date '2026-03-03', date '2026-03-03', 'D', array[]::text[], array[]::text[],
    array[]::text[], 'none', 'local', null, 'traffic-report-v2'
  ) as result`)).rows[0].result;
  assert.equal(liveV2Arrival.current.flights + liveV2Departure.current.flights, liveV2.current.flights);
  assert.equal(liveV2Arrival.current.reported_pax + liveV2Departure.current.reported_pax, liveV2.current.reported_pax);
  assert.equal(liveV2Arrival.source_watermark, liveV2.source_watermark);
  assert.equal(liveV2Departure.source_watermark, liveV2.source_watermark);
  await assert.rejects(
    db.query(`select public.get_public_traffic_report_v2(
      date '2026-03-03', date '2026-03-03', 'all', array[]::text[], array[]::text[],
      array[]::text[], 'none', 'local', 0, 'traffic-report-v2'
    )`),
    /DATA_VERSION_CHANGED/,
  );

  const dimensionResult = await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-03', date '2026-03-03', 'route', array['A','D'], array[]::text[], array[]::text[], array[]::text[], 'flights', 1, 50, timestamptz '2026-03-10 00:00:00+00') as result`);
  const dimension = dimensionResult.rows[0].result;
  assert.equal(dimension.dimension, 'route');
  assert.equal(dimension.total_rows, 2);
  assert.equal(dimension.rows[0].label, 'HAN');
  assert.equal(dimension.rows[0].flights, 4, 'the detailed aggregate must publish the full route count');
  assert.equal(Number(dimension.rows[0].flight_share), 4 / 7);
  assert.equal(dimension.rows[0].reported_pax, 150);
  assert.equal(Number(dimension.rows[0].pax_share), 1);
  assert.equal(dimension.rows[1].flights, 3);
  assert.equal(dimension.rows[1].reported_pax, null, 'Pax NULL remains unknown after suppression is removed');

  const defaultOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1() as result`);
  assert.equal(defaultOverviewResult.rows[0].result.metadata.normalized_filter.from, '2026-03-02');
  assert.equal(defaultOverviewResult.rows[0].result.metadata.normalized_filter.to, '2026-03-03');
  await assert.rejects(
    db.query(`select public.get_public_traffic_report_overview_v1(date '2026-01-01', date '2026-03-03')`),
    /outside available Ops Date domain/,
  );

  for (let index = 0; index < 3; index += 1) {
    await addRecord({ seasonId: 'new-season', id: `zero-prev-a320-a-${index}`, date: '2026-03-06', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'ZERO', aircraft: 'A320', pax: 0 });
    await addRecord({ seasonId: 'new-season', id: `zero-a320-a-${index}`, date: '2026-03-07', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'ZERO', aircraft: 'A320', pax: 0 });
    await addRecord({ seasonId: 'new-season', id: `type-b738-a-${index}`, date: '2026-03-07', time: `${String(9 + index).padStart(2, '0')}:00`, type: 'A', route: 'TYPE', aircraft: 'B738', pax: 20 });
    await addRecord({ seasonId: 'new-season', id: `type-a320-d-${index}`, date: '2026-03-07', time: `${12 + index}:00`, type: 'D', route: 'TYPE', aircraft: 'A320', pax: 10 });
    await addRecord({ seasonId: 'new-season', id: `type-b738-d-${index}`, date: '2026-03-07', time: `${15 + index}:00`, type: 'D', route: 'TYPE', aircraft: 'B738', pax: null });
  }
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');

  const trueZeroOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-07', date '2026-03-07', array['A'], array[]::text[], array['ZERO'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const trueZeroOverview = trueZeroOverviewResult.rows[0].result;
  assert.equal(trueZeroOverview.kpis.current.flights, 3);
  assert.equal(trueZeroOverview.kpis.current.reported_pax, 0, 'three reported zero-Pax legs must publish a truthful zero');
  assert.equal(trueZeroOverview.kpis.current.arrival_reported_pax, 0, 'a publishable arrival scope must preserve a truthful Pax zero');
  assert.equal(trueZeroOverview.kpis.current.departure_reported_pax, null, 'a direction excluded by the scope must remain unknown');
  assert.equal(trueZeroOverview.breakdowns.route.find((row) => row.label === 'ZERO').reported_pax, 0, 'a due breakdown bucket with three reported zero-Pax legs must publish zero');
  const normalizedFilterOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-07', date '2026-03-07', array['a'], array[]::text[], array[' zero '], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  assert.equal(normalizedFilterOverviewResult.rows[0].result.kpis.current.reported_pax, 0, 'overview helpers must use the same canonical filter values as the base aggregate');
  assert.equal(normalizedFilterOverviewResult.rows[0].result.breakdowns.aircraft_type.find((row) => row.label === 'A320').flights, 3);
  const trueZeroTimeline = (await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-07', date '2026-03-07', null, null, 'day', null, 10, '{"types":["A"],"routes":["ZERO"]}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`)).rows[0].result;
  assert.equal(trueZeroTimeline.series[0].reported_pax, 0, 'timeline must preserve a reported true zero');
  const trueZeroDimension = (await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-07', date '2026-03-07', 'route', array['A'], array[]::text[], array['ZERO'], array[]::text[], 'flights', 1, 50, timestamptz '2026-03-10 00:00:00+00') as result`)).rows[0].result;
  assert.equal(trueZeroDimension.rows[0].reported_pax, 0, 'dimension must preserve a reported true zero');
  const trueZeroComparisonResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-07', date '2026-03-07', array['A'], array[]::text[], array['ZERO'], array[]::text[], array[]::text[], 'previous_period', 'local', null, 366, 'traffic-report-v1') as result`);
  assert.equal(trueZeroComparisonResult.rows[0].result.kpis.comparison.reported_pax, 0, 'a comparison period with three reported zero-Pax legs must also publish zero');
  assert.equal(trueZeroComparisonResult.rows[0].result.kpis.comparison.arrival_reported_pax, 0);
  assert.equal(trueZeroComparisonResult.rows[0].result.kpis.comparison.departure_reported_pax, null);
  const duePaxPresenceResult = await db.query(`select reporting.get_traffic_report_pax_presence_v1(date '2026-03-07', date '2026-03-07', array['A','D'], array[]::text[], array['TYPE'], array[]::text[], array[]::text[], timestamptz '2026-03-08 04:30:00+00') as result`);
  assert.equal(duePaxPresenceResult.rows[0].result.reported_legs, 3);
  assert.equal(duePaxPresenceResult.rows[0].result.reported_pax, 60, 'future reported legs must not leak into the due Pax presence check');

  const aircraftOverview = async (types) => {
    const result = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-07', date '2026-03-07', $1::text[], array[]::text[], array[]::text[], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`, [types]);
    return result.rows[0].result;
  };
  const aircraftAll = await aircraftOverview(['A', 'D']);
  const aircraftA = await aircraftOverview(['A']);
  const aircraftD = await aircraftOverview(['D']);
  assert.equal(aircraftAll.kpis.current.reported_pax, 90);
  assert.equal(aircraftAll.kpis.current.arrival_reported_pax, 60);
  assert.equal(aircraftAll.kpis.current.departure_reported_pax, 30);
  assert.equal(
    aircraftAll.kpis.current.reported_pax,
    aircraftAll.kpis.current.arrival_reported_pax + aircraftAll.kpis.current.departure_reported_pax,
    'all-scope Pax must equal arrival plus departure when both directions are publishable',
  );
  assert.equal(aircraftA.kpis.current.reported_pax, 60);
  assert.equal(aircraftA.kpis.current.arrival_reported_pax, 60);
  assert.equal(aircraftA.kpis.current.departure_reported_pax, null);
  assert.equal(aircraftD.kpis.current.reported_pax, 30);
  assert.equal(aircraftD.kpis.current.arrival_reported_pax, null);
  assert.equal(aircraftD.kpis.current.departure_reported_pax, 30);
  const childrenByLabel = (result) => new Map(result.breakdowns.aircraft_type.map((row) => [row.label, row]));
  const allChildren = childrenByLabel(aircraftAll);
  const arrivalChildren = childrenByLabel(aircraftA);
  const departureChildren = childrenByLabel(aircraftD);
  assert.deepEqual([...allChildren.keys()].sort(), ['A320', 'B738']);
  assert.equal(allChildren.get('A320').aircraft_group, 'Narrowbody');
  assert.equal(allChildren.get('A320').flights, 6);
  assert.equal(allChildren.get('B738').flights, 6);
  assert.equal(allChildren.get('A320').reported_pax, 30);
  assert.equal(allChildren.get('B738').reported_pax, 60);
  assert.equal(Number(allChildren.get('A320').share), 0.5);
  assert.equal([...allChildren.values()].reduce((sum, row) => sum + row.flights, 0), aircraftAll.breakdowns.aircraft_group.find((row) => row.label === 'Narrowbody').flights, 'aircraft children must reconcile to their publishable parent');
  assert.equal(arrivalChildren.get('A320').reported_pax, 0, 'aircraft child must preserve a reported Pax zero');
  assert.equal(departureChildren.get('B738').reported_pax, null, 'aircraft child with only Pax NULL must remain unknown');
  assert.equal(allChildren.get('A320').flights, arrivalChildren.get('A320').flights + departureChildren.get('A320').flights);
  assert.equal(allChildren.get('B738').flights, arrivalChildren.get('B738').flights + departureChildren.get('B738').flights);

  for (const opsDate of ['2026-03-08', '2026-03-09']) {
    for (let index = 0; index < 3; index += 1) {
      await addRecord({
        seasonId: 'new-season',
        id: `directional-privacy-a-${opsDate}-${index}`,
        date: opsDate,
        time: `${String(6 + index).padStart(2, '0')}:00`,
        type: 'A',
        route: 'PRIV',
        aircraft: 'A320',
        pax: 10,
      });
      await addRecord({
        seasonId: 'new-season',
        id: `directional-privacy-reverse-d-${opsDate}-${index}`,
        date: opsDate,
        time: `${String(12 + index).padStart(2, '0')}:00`,
        type: 'D',
        route: 'PRIVREV',
        aircraft: 'B738',
        pax: 10,
      });
    }
    await addRecord({
      seasonId: 'new-season',
      id: `directional-privacy-d-${opsDate}`,
      date: opsDate,
      time: '09:00',
      type: 'D',
      route: 'PRIV',
      aircraft: 'A320',
      pax: 7,
    });
    await addRecord({
      seasonId: 'new-season',
      id: `directional-privacy-reverse-a-${opsDate}`,
      date: opsDate,
      time: '15:00',
      type: 'A',
      route: 'PRIVREV',
      aircraft: 'B738',
      pax: 7,
    });
  }
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');
  const privacyAllResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['A','D'], array[]::text[], array['PRIV'], array[]::text[], array[]::text[], 'previous_period', 'local', null, 366, 'traffic-report-v1') as result`);
  const privacyAll = privacyAllResult.rows[0].result;
  assert.equal(privacyAll.kpis.current.flights, 4, 'all-scope aggregate remains visible with suppression disabled');
  assert.equal(privacyAll.kpis.current.reported_pax, 37);
  assert.equal(privacyAll.kpis.current.arrival_reported_pax, 30);
  assert.equal(privacyAll.kpis.current.departure_reported_pax, 7);
  assert.equal(privacyAll.kpis.comparison.reported_pax, 37);
  assert.equal(privacyAll.kpis.comparison.flights, 4);
  assert.equal(privacyAll.kpis.comparison.arrival_reported_pax, 30);
  assert.equal(privacyAll.kpis.comparison.departure_reported_pax, 7);
  const privacyArrivalResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['A'], array[]::text[], array['PRIV'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  assert.equal(privacyArrivalResult.rows[0].result.kpis.current.reported_pax, 30);
  assert.equal(privacyArrivalResult.rows[0].result.kpis.current.flights, 3);
  assert.equal(privacyArrivalResult.rows[0].result.kpis.current.arrival_reported_pax, 30, 'a sole selected direction remains publishable at three reported legs');
  assert.equal(privacyArrivalResult.rows[0].result.kpis.current.departure_reported_pax, null);
  const privacyDepartureResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['D'], array[]::text[], array['PRIV'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  assert.equal(privacyDepartureResult.rows[0].result.kpis.current.flights, 1);
  assert.equal(privacyDepartureResult.rows[0].result.kpis.current.reported_pax, 7, 'one selected reported leg remains visible in the internal aggregate report');
  assert.equal(privacyDepartureResult.rows[0].result.kpis.current.departure_reported_pax, 7);
  const reversePrivacyAll = (await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['A','D'], array[]::text[], array['PRIVREV'], array[]::text[], array[]::text[], 'previous_period', 'local', null, 366, 'traffic-report-v1') as result`)).rows[0].result;
  assert.equal(reversePrivacyAll.kpis.current.flights, 4);
  assert.equal(reversePrivacyAll.kpis.current.reported_pax, 37);
  assert.equal(reversePrivacyAll.kpis.current.arrival_reported_pax, 7);
  assert.equal(reversePrivacyAll.kpis.current.departure_reported_pax, 30);
  assert.equal(reversePrivacyAll.kpis.comparison.flights, 4);
  assert.equal(reversePrivacyAll.kpis.comparison.reported_pax, 37);
  const reversePrivacyDeparture = (await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['D'], array[]::text[], array['PRIVREV'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`)).rows[0].result;
  assert.equal(reversePrivacyDeparture.kpis.current.flights, 3);
  assert.equal(reversePrivacyDeparture.kpis.current.reported_pax, 30);
  const reversePrivacyArrival = (await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-09', date '2026-03-09', array['A'], array[]::text[], array['PRIVREV'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`)).rows[0].result;
  assert.equal(reversePrivacyArrival.kpis.current.flights, 1);
  assert.equal(reversePrivacyArrival.kpis.current.reported_pax, 7);

  for (let index = 0; index < 3; index += 1) {
    await addRecord({ seasonId: 'new-season', id: `low-pax-${index}`, date: '2026-03-10', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'LOW', aircraft: 'A320', pax: index === 0 ? 11 : null });
    await addRecord({ seasonId: 'new-season', id: `high-pax-${index}`, date: '2026-03-11', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'HIGH', aircraft: 'B738', pax: 20 });
    await addRecord({ seasonId: 'new-season', id: `flight-primary-a-${index}`, date: '2026-03-12', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'FPRIMARY', aircraft: 'A320', pax: null });
    await addRecord({ seasonId: 'new-season', id: `flight-safe-a-${index}`, date: '2026-03-13', time: `${String(6 + index).padStart(2, '0')}:00`, type: 'A', route: 'FSAFE', aircraft: 'B738', pax: null });
    await addRecord({ seasonId: 'new-season', id: `flight-safe-d-${index}`, date: '2026-03-13', time: `${String(9 + index).padStart(2, '0')}:00`, type: 'D', route: 'FSAFE', aircraft: 'B738', pax: null });
  }
  await addRecord({ seasonId: 'new-season', id: 'flight-primary-d', date: '2026-03-12', time: '09:00', type: 'D', route: 'FPRIMARY', aircraft: 'A320', pax: null });
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');

  const lowPaxOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-10', date '2026-03-11', array['A'], array[]::text[], array['LOW','HIGH'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const lowPaxOverview = lowPaxOverviewResult.rows[0].result;
  assert.equal(lowPaxOverview.kpis.current.flights, 6);
  assert.equal(lowPaxOverview.kpis.current.reported_pax, 71);
  assert.deepEqual(lowPaxOverview.timeline.map((row) => row.flights), [3, 3]);
  assert.deepEqual(lowPaxOverview.timeline.map((row) => row.reported_pax), [11, 60], 'reported Pax aggregates remain visible without suppression');
  const lowRoutes = new Map(lowPaxOverview.breakdowns.route.map((row) => [row.label, row]));
  assert.equal(lowRoutes.get('LOW').flights, 3);
  assert.equal(lowRoutes.get('HIGH').flights, 3);
  assert.equal(lowRoutes.get('LOW').reported_pax, 11);
  assert.equal(lowRoutes.get('HIGH').reported_pax, 60);
  const lowAircraft = new Map(lowPaxOverview.breakdowns.aircraft_type.map((row) => [row.label, row]));
  assert.equal(lowAircraft.get('A320').reported_pax, 11);
  assert.equal(lowAircraft.get('B738').reported_pax, 60);

  const lowTimelinePage1 = (await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-10', date '2026-03-11', null, null, 'day', null, 1, '{"types":["A"],"routes":["LOW","HIGH"]}'::jsonb, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  const lowTimelinePage2 = (await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-10', date '2026-03-11', null, null, 'day', date '2026-03-10', 1, '{"types":["A"],"routes":["LOW","HIGH"]}'::jsonb, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  assert.deepEqual([...lowTimelinePage1.series, ...lowTimelinePage2.series].map((row) => row.reported_pax), [11, 60], 'pagination must retain all published timeline aggregates');

  const lowDimensionPage1 = (await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-10', date '2026-03-11', 'route', array['A'], array[]::text[], array['LOW','HIGH'], array[]::text[], 'label', 1, 1, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  const lowDimensionPage2 = (await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-10', date '2026-03-11', 'route', array['A'], array[]::text[], array['LOW','HIGH'], array[]::text[], 'label', 2, 1, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  const lowDimensionRows = [...lowDimensionPage1.rows, ...lowDimensionPage2.rows];
  assert.deepEqual(lowDimensionRows.map((row) => row.reported_pax), [60, 11]);
  assert.deepEqual(lowDimensionRows.map((row) => Number(row.pax_share)), [60 / 71, 11 / 71]);
  assert.deepEqual(lowDimensionRows.map((row) => row.flights), [3, 3]);
  assert.equal(lowDimensionPage1.data_as_of, lowDimensionPage2.data_as_of, 'all export pages must retain one snapshot cutoff');
  assert.ok(Date.parse(lowDimensionPage1.data_as_of) < Date.parse('2099-01-01T00:00:00Z'), 'dimension cutoff must be capped by snapshot_refreshed_at');

  const flightPrivacyOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-12', date '2026-03-13', array['A','D'], array[]::text[], array['FPRIMARY','FSAFE'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const flightPrivacyOverview = flightPrivacyOverviewResult.rows[0].result;
  assert.equal(flightPrivacyOverview.kpis.current.flights, 10, 'the aggregate remains publishable when both directions have at least three legs overall');
  assert.deepEqual(flightPrivacyOverview.timeline.map((row) => row.flights), [4, 6]);
  assert.deepEqual(flightPrivacyOverview.breakdowns.route.map((row) => row.flights), [6, 4]);
  assert.ok(flightPrivacyOverview.breakdowns.aircraft_type.every((row) => row.flights != null && !row.suppressed), 'aircraft children must publish every aggregate row');
  const flightDimensionPage1 = (await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-12', date '2026-03-13', 'route', array['A','D'], array[]::text[], array['FPRIMARY','FSAFE'], array[]::text[], 'label', 1, 1, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  const flightDimensionPage2 = (await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-12', date '2026-03-13', 'route', array['A','D'], array[]::text[], array['FPRIMARY','FSAFE'], array[]::text[], 'label', 2, 1, timestamptz '2099-01-01 00:00:00+00') as result`)).rows[0].result;
  assert.deepEqual([...flightDimensionPage1.rows, ...flightDimensionPage2.rows].map((row) => row.flights), [4, 6], 'dimension pagination must retain every aggregate row');

  for (let index = 0; index < 3; index += 1) {
    await addRecord({
      seasonId: 'new-season',
      id: `future-pax-a321-${index}`,
      date: '2099-01-01',
      time: `${String(6 + index).padStart(2, '0')}:00`,
      type: 'A',
      route: 'FUTURE',
      aircraft: 'A321',
      pax: 25,
    });
  }
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');
  const futurePaxOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2099-01-01', date '2099-01-01', array['A'], array[]::text[], array['FUTURE'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const futurePaxOverview = futurePaxOverviewResult.rows[0].result;
  assert.equal(futurePaxOverview.kpis.current.flights, 3);
  assert.equal(futurePaxOverview.kpis.current.reported_pax, null, 'reported Pax on legs that are not yet due must not enter the KPI');
  assert.equal(futurePaxOverview.kpis.current.arrival_reported_pax, null);
  assert.equal(futurePaxOverview.kpis.current.departure_reported_pax, null);
  assert.equal(futurePaxOverview.breakdowns.route.find((row) => row.label === 'FUTURE').reported_pax, null, 'reported Pax on legs that are not yet due must not enter overview breakdowns');
  assert.equal(futurePaxOverview.breakdowns.aircraft_type.find((row) => row.label === 'A321').reported_pax, null, 'reported Pax on legs that are not yet due must not enter aircraft-type breakdowns');

  await db.query(`update public.season_flight_records set aircraft = 'A321' where season_id = 'new-season' and record_id = 'type-b738-a-0'`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('new-season', 'edit', 'aircraft-after-snapshot', 'flightRecord', 'type-b738-a-0')`);
  const staleTypeOverview = await aircraftOverview(['A', 'D']);
  assert.equal(staleTypeOverview.breakdowns.aircraft_type.some((row) => row.label === 'A321'), false, 'an aircraft type changed after the snapshot must not leak ahead of the published snapshot');
  assert.equal(staleTypeOverview.breakdowns.aircraft_type.find((row) => row.label === 'B738').flights, 6, 'the report must keep serving the aircraft type captured by the last snapshot');

  const firstPageResult = await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-02', date '2026-03-05', null, null, 'day', null, 2, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
  const secondPageResult = await db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-02', date '2026-03-05', null, null, 'day', date '2026-03-03', 2, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
  assert.equal(firstPageResult.rows[0].result.next_cursor, '2026-03-03');
  assert.deepEqual(
    [...firstPageResult.rows[0].result.series, ...secondPageResult.rows[0].result.series].map((row) => row.ops_date),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
    'cursor pages must join without gaps or duplicate dates',
  );

  try {
    await db.exec('set role anon');
    await assert.rejects(
      db.query(`select public.get_public_traffic_report_overview_v1()`),
      /permission denied/,
      'anonymous database roles must not bypass the aggregate Edge boundary',
    );
  } finally {
    await db.exec('reset role');
  }

  try {
    await db.exec('set role service_role');
    await assert.rejects(
      db.query(`select reporting.get_traffic_report_timeline_v2(date '2026-03-02', date '2026-03-05') as result`),
      /permission denied/,
      'the Edge service role must not bypass the single public wrapper',
    );
    await assert.rejects(
      db.query(`select reporting.get_traffic_report_timeline_operational_base_v2(date '2026-03-02', date '2026-03-05') as result`),
      /permission denied/,
      'the Edge service role must not bypass partition-wide suppression through the timeline base',
    );
    await assert.rejects(
      db.query(`select public.get_public_traffic_report_overview_canonical_base_v1()`),
      /permission denied/,
      'the Edge service role must not bypass freshness and Pax corrections through the renamed base function',
    );
    await assert.rejects(
      db.query(`select reporting.get_traffic_report_aircraft_types_v1(date '2026-03-02', date '2026-03-03')`),
      /permission denied/,
      'the Edge service role must not execute the internal aircraft-type aggregate directly',
    );
    await assert.rejects(
      db.query(`select reporting.get_traffic_report_pax_presence_v1(date '2026-03-02', date '2026-03-03')`),
      /permission denied/,
      'the Edge service role must not execute the internal presence helper directly',
    );
    await assert.rejects(
      db.query(`select reporting.get_traffic_report_breakdowns(date '2026-03-02', date '2026-03-03')`),
      /permission denied/,
      'the Edge service role must not execute internal breakdowns directly',
    );
    await assert.rejects(
      db.query(`select count(*) from reporting.public_traffic_effective`),
      /permission denied/,
      'the Edge service role must not read the row-level materialized snapshot',
    );
    await assert.rejects(
      db.query(`select public.get_public_traffic_report_dimension_operational_base_v2(date '2026-03-03', date '2026-03-03', 'airline')`),
      /permission denied/,
      'the Edge service role must not bypass snapshot cutoff and complementary suppression through the dimension base',
    );
    const serviceOverview = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-02', date '2026-03-03') as result`);
    assert.equal(serviceOverview.rows[0].result.timeline.length, 2, 'the Edge service role must execute the aggregate-only public wrapper');
    const serviceDimension = await db.query(`select public.get_public_traffic_report_dimension_v2(date '2026-03-03', date '2026-03-03', 'airline') as result`);
    assert.equal(serviceDimension.rows[0].result.rows[0].label, 'VN', 'the Edge service role must execute the aggregate-only dimension wrapper');
  } finally {
    await db.exec('reset role');
  }

  const dueBoundary = await db.query(`
    select
      count(*) filter (where scheduled_local_at + interval '1 day' <= timestamp '2026-03-04 04:59:59')::integer as before_due,
      count(*) filter (where scheduled_local_at + interval '1 day' <= timestamp '2026-03-04 05:00:00')::integer as exactly_due,
      count(*) filter (where scheduled_local_at + interval '1 day' <= timestamp '2026-03-04 08:00:01')::integer as after_due
    from reporting.public_traffic_effective where ops_date = date '2026-03-03'
  `);
  assert.deepEqual(dueBoundary.rows[0], { before_due: 0, exactly_due: 1, after_due: 3 });

  for (const date of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) {
    await addRecord({ seasonId: 'new-season', id: `regular-arrival-${date}`, date, time: '23:10', type: 'A', flight: 'VN901', route: 'HPH' });
    await addRecord({ seasonId: 'new-season', id: `regular-departure-${date}`, date, time: '12:15', type: 'D', airline: 'VJ', flight: 'VJ902', route: 'SGN' });
  }
  await addRecord({ seasonId: 'new-season', id: 'irregular-arrival', date: '2026-09-14', time: '23:20', type: 'A', flight: 'VN999', route: 'HPH' });
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');
  const recurringBreakdowns = (await db.query(`select reporting.get_traffic_report_breakdowns(date '2026-09-01', date '2026-09-30', '{}'::jsonb, 10, 'local', 60, timestamptz '2026-10-15 00:00:00+00') as result`)).rows[0].result;
  const recurringArrivalHour = recurringBreakdowns.peak_hour.find((row) => row.hour_bucket === '23:00');
  const recurringDepartureHour = recurringBreakdowns.peak_hour.find((row) => row.hour_bucket === '12:00');
  assert.deepEqual(recurringArrivalHour.regular_flights.arrivals, [{
    airline: 'VN', flight_number: 'VN901', route: 'HPH', typical_time: '23:10', operating_days: [1], occurrence_days: 4, eligible_days: 4, consistency_percent: 100,
  }], 'a stable same-weekday schedule must be published as a recurring flight');
  assert.equal(recurringArrivalHour.regular_flights.arrivals.some((row) => row.flight_number === 'VN999'), false, 'an isolated flight must not enter the recurring schedule');
  assert.deepEqual(recurringDepartureHour.regular_flights.departures, [{
    airline: 'VJ', flight_number: 'VJ902', route: 'SGN', typical_time: '12:15', operating_days: [1], occurrence_days: 4, eligible_days: 4, consistency_percent: 100,
  }]);

  await addSeason('missing-one', 'W27');
  await addSeason('missing-two', 'S28');
  await addRecord({ seasonId: 'missing-one', id: 'missing-a', date: '2027-01-01', time: '06:00', flight: 'VN999', pax: 20 });
  await addRecord({ seasonId: 'missing-two', id: 'missing-b', date: '2027-01-01', time: '06:00', flight: 'VN999', pax: 30 });
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  await db.exec('select reporting.mark_public_traffic_projection_fresh_v1()');
  const missingQuarantine = await db.query(`select reason from reporting.public_traffic_duplicate_quarantine where business_leg_key like 'A%' and business_leg_key like '%VN999'`);
  assert.deepEqual(missingQuarantine.rows, [{ reason: 'missing_authoritative_recency' }]);
  const missingPublished = await db.query(`select count(*)::integer as count from reporting.public_traffic_effective where ops_date = date '2027-01-01'`);
  assert.equal(missingPublished.rows[0].count, 0, 'cross-season candidates without authoritative recency must not publish');

  await db.exec(`
    refresh materialized view reporting.public_traffic_effective_pre_aircraft_fixture;
    drop materialized view reporting.public_traffic_effective;
    alter materialized view reporting.public_traffic_effective_pre_aircraft_fixture
      rename to public_traffic_effective;
    select reporting.mark_public_traffic_projection_fresh_v1();
  `);
  const rollbackOverview = (await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-07', date '2026-03-07', array['A'], array[]::text[], array['ZERO'], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`)).rows[0].result;
  assert.deepEqual(rollbackOverview.breakdowns.aircraft_type, [], 'the public contract must fail closed to an empty aircraft detail after the explicit 16-column MV rollback');
  assert.equal(rollbackOverview.kpis.current.reported_pax, 0, 'the rollback MV must preserve the existing Pax zero contract');

  console.log(JSON.stringify({ suite: 'public-traffic-report-v1', status: 'passed', requestHash: overview.request_hash.slice(0, 12) }));
} finally {
  await db.close();
}
