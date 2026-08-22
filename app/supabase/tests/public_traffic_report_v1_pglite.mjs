import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const schemaSql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationSql = await readFile(new URL('../migrations/20260822090000_public_traffic_report_v1.sql', import.meta.url), 'utf8');
const db = await createSupabasePGlite();

async function addSeason(id, code) {
  await db.query(`
    insert into public.seasons (
      id, season_code, name, file_name, uploaded_at, effective_start, effective_end,
      total_legs, total_source_rows, data_version, last_synced_at
    ) values ($1, $2, $2, '', 1, '2026-01-01', '2026-12-31', 0, 0, 1, 1)
  `, [id, code]);
}

async function addRecord({ seasonId, id, date, time, type = 'A', airline = 'VN', flight = id, route = 'HAN', pax = null }) {
  await db.query(`
    insert into public.season_flight_records (
      season_id, record_id, type, airline, flight_number, route, schedule, aircraft,
      pax, date, scheduled_date, operational_date, source_side, status
    ) values ($1, $2, $3, $4, $5, $6, $7, 'A321', $8, $9, $9, '', $10, 'active')
  `, [seasonId, id, type, airline, flight, route, time, pax, date, type === 'A' ? 'ARR' : 'DEP']);
}

try {
  await db.exec(schemaSql);
  // schema.sql mirrors the production migration. Re-applying it verifies the
  // additive migration stays safe for an already provisioned database.
  await db.exec(migrationSql);

  await addSeason('old-season', 'W25');
  await addSeason('new-season', 'S26');
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('old-season', 'import', 'old', 'seasonImport', 'old-season')`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('new-season', 'import', 'new', 'seasonImport', 'new-season')`);

  await addRecord({ seasonId: 'old-season', id: 'old-duplicate', date: '2026-03-02', time: '06:00', flight: 'VN101', pax: 100 });
  await addRecord({ seasonId: 'new-season', id: 'new-duplicate', date: '2026-03-02', time: '06:00', flight: 'VN101', pax: 120 });
  await db.query(`insert into public.season_modifications (season_id, leg_id, action) values ('new-season', 'new-duplicate', 'deleted')`);
  await db.query(`insert into public.season_change_events (season_id, client_id, op_id, target_type, target_id) values ('new-season', 'edit', 'delete', 'modification', 'new-duplicate')`);

  await addRecord({ seasonId: 'new-season', id: 'before-five', date: '2026-03-03', time: '04:59', flight: 'VN201', pax: 80 });
  await addRecord({ seasonId: 'new-season', id: 'at-five', date: '2026-03-03', time: '05:00', flight: 'VN202', pax: 0 });
  await addRecord({ seasonId: 'new-season', id: 'departure', date: '2026-03-03', time: '07:00', type: 'D', flight: 'VN203', pax: null });
  await addRecord({ seasonId: 'new-season', id: 'arrival-two', date: '2026-03-03', time: '08:00', flight: 'VN204', pax: 40 });
  await addRecord({ seasonId: 'new-season', id: 'arrival-three', date: '2026-03-03', time: '08:30', flight: 'VN205', pax: 50 });
  await addRecord({ seasonId: 'new-season', id: 'departure-two', date: '2026-03-03', time: '09:00', type: 'D', flight: 'VN206', pax: 60 });
  await addRecord({ seasonId: 'new-season', id: 'departure-three', date: '2026-03-03', time: '09:30', type: 'D', flight: 'VN207', pax: null });
  await db.exec('refresh materialized view reporting.public_traffic_effective');

  const effective = await db.query(`select ops_date::text, count(*)::integer as flights from reporting.public_traffic_effective group by ops_date order by ops_date`);
  assert.deepEqual(effective.rows, [
    { ops_date: '2026-03-02', flights: 1 },
    { ops_date: '2026-03-03', flights: 6 },
  ], '04:59/05:00 Ops Date boundary or tombstone dedupe is wrong');

  const duplicate = await db.query(`select count(*)::integer as count from reporting.public_traffic_effective where airline = 'VN' and ops_date = date '2026-03-02' and pax = 100`);
  assert.equal(duplicate.rows[0].count, 0, 'a newer tombstone resurrected the older cross-season leg');

  const timelineResult = await db.query(`select reporting.get_traffic_report_timeline(date '2026-03-02', date '2026-03-05', null, null, 'day', null, 366, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
  const timeline = timelineResult.rows[0].result;
  assert.equal(timeline.series.length, 4, 'inclusive date spine must contain every day');
  assert.deepEqual(timeline.series.map((row) => row.ops_date), ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-02').flights, null, 'the 1-leg day must be suppressed');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-03').flights, null, 'one additional publishable day must be complementary-suppressed');
  assert.equal(timeline.series.filter((row) => row.suppressed).length, 2, 'primary and complementary suppression must both be explicit');
  assert.equal(timeline.series.find((row) => row.ops_date === '2026-03-04').flights, 0);

  const kpiResult = await db.query(`select reporting.get_traffic_report_kpis(date '2026-03-03', date '2026-03-03', '{}'::jsonb, 'none', timestamptz '2026-03-10 00:00:00+00') as result`);
  const kpis = kpiResult.rows[0].result;
  assert.equal(kpis.current.flights, 6);
  assert.equal(kpis.current.arrivals + kpis.current.departures, kpis.current.flights);
  assert.equal(kpis.current.reported_pax, 150, 'only positive reported Pax can enter the Pax total without an independent status field');
  assert.equal(kpis.pax_coverage.due_legs, 6);
  assert.equal(kpis.pax_coverage.reported_legs, 3);

  const overviewResult = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-03', date '2026-03-03', array['A','D'], array[]::text[], array[]::text[], array[]::text[], array[]::text[], 'none', 'local', null, 366, 'traffic-report-v1') as result`);
  const overview = overviewResult.rows[0].result;
  assert.equal(overview.contract_version, 'traffic-report-v1');
  assert.equal(overview.metadata.day_count, 1);
  assert.equal(overview.timeline.length, 1);
  assert.equal(overview.kpis.current.flights, overview.timeline[0].flights);
  assert.ok(!JSON.stringify(overview).includes('flight_number'));
  assert.ok(!JSON.stringify(overview).includes('record_id'));

  const defaultOverviewResult = await db.query(`select public.get_public_traffic_report_overview_v1() as result`);
  assert.equal(defaultOverviewResult.rows[0].result.metadata.normalized_filter.from, '2026-03-02');
  assert.equal(defaultOverviewResult.rows[0].result.metadata.normalized_filter.to, '2026-03-03');
  await assert.rejects(
    db.query(`select public.get_public_traffic_report_overview_v1(date '2026-01-01', date '2026-03-03')`),
    /outside available Ops Date domain/,
  );

  const firstPageResult = await db.query(`select reporting.get_traffic_report_timeline(date '2026-03-02', date '2026-03-05', null, null, 'day', null, 2, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
  const secondPageResult = await db.query(`select reporting.get_traffic_report_timeline(date '2026-03-02', date '2026-03-05', null, null, 'day', date '2026-03-03', 2, '{}'::jsonb, timestamptz '2026-03-10 00:00:00+00') as result`);
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
      db.query(`select reporting.get_traffic_report_timeline(date '2026-03-02', date '2026-03-05') as result`),
      /permission denied/,
      'the Edge service role must not bypass the single public wrapper',
    );
    const serviceOverview = await db.query(`select public.get_public_traffic_report_overview_v1(date '2026-03-02', date '2026-03-03') as result`);
    assert.equal(serviceOverview.rows[0].result.timeline.length, 2, 'the Edge service role must execute the aggregate-only public wrapper');
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

  await addSeason('missing-one', 'W27');
  await addSeason('missing-two', 'S28');
  await addRecord({ seasonId: 'missing-one', id: 'missing-a', date: '2027-01-01', time: '06:00', flight: 'VN999', pax: 20 });
  await addRecord({ seasonId: 'missing-two', id: 'missing-b', date: '2027-01-01', time: '06:00', flight: 'VN999', pax: 30 });
  await db.exec('refresh materialized view reporting.public_traffic_effective');
  const missingQuarantine = await db.query(`select reason from reporting.public_traffic_duplicate_quarantine where business_leg_key like 'A%' and business_leg_key like '%VN999'`);
  assert.deepEqual(missingQuarantine.rows, [{ reason: 'missing_authoritative_recency' }]);
  const missingPublished = await db.query(`select count(*)::integer as count from reporting.public_traffic_effective where ops_date = date '2027-01-01'`);
  assert.equal(missingPublished.rows[0].count, 0, 'cross-season candidates without authoritative recency must not publish');

  console.log(JSON.stringify({ suite: 'public-traffic-report-v1', status: 'passed', requestHash: overview.request_hash.slice(0, 12) }));
} finally {
  await db.close();
}
