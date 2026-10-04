// M3.2/M3.3/M3.4 shadow projection contract test: the projection must be read-
// compatible with reporting.canonical_flight_legs, must reproduce the public
// report and dashboard numbers when it is the store the report reads, and must
// only claim freshness up to the writer event high-water it actually reached.
//
// Proves on the M0 fixture that
//   * the chain applies the migration and the rollback drops tables and
//     functions cleanly,
//   * refreshing an empty operational store leaves an empty projection whose
//     status is fresh but bounded by no dates (fresh means "nothing unseen",
//     never "empty equals correct"),
//   * after the M2 backfill the projection holds exactly the canonical rows
//     (field for field) and the same quarantine rows, including the writer-side
//     ledger entry whose candidate count the canonical store also quarantined,
//   * with the projection renamed into the report's table position, the report
//     output (current/comparison/timeline/dimensions/coverage/quality) and the
//     dashboard/window surfaces are identical to the canonical run,
//   * a newer writer event flips the status to stale until the next refresh, and
//     that refresh does not change the projected rows,
//   * authenticated cannot read the projection tables or execute the refresh.
//
// Run: node supabase/tests/seasonal_operational_separation_m3_projection_pglite.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, captureM0ReadSurfaces, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const MIGRATION_NAME = '20260928150000_operational_canonical_projection_v1.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);
const INSECURE = '42501';

const DATE = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const writerId = M0_FIXTURE.writerId;
const request = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => (await request(sql, params)).rows[0];
const LEG_COLUMNS = [
  'business_leg_key', 'ops_date', 'type', 'airline', 'flight_number', 'route',
  'aircraft_type', 'flight_category', 'pax', 'local_minutes', 'scheduled_local_at',
];

const readProjection = async (table, order = 'ops_date, business_leg_key') =>
  (await request(`select ${LEG_COLUMNS.join(', ')} from reporting.${table} order by ${order}`)).rows;

try {
  // --- Rollback drops the whole shadow surface -----------------------------
  await db.exec(await readFile(ROLLBACK_URL, 'utf8'));
  assert.equal(
    (await scalar(`select to_regclass('reporting.operational_canonical_flight_legs') is null as absent`)).absent,
    true,
    'the rollback drops the shadow projection table'
  );
  assert.equal(
    (await scalar(`select to_regprocedure('reporting.refresh_operational_canonical_legs_v1()') is null as absent`)).absent,
    true,
    'the rollback drops the shadow refresh'
  );
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  assert.equal(
    (await scalar(`select to_regprocedure('reporting.refresh_operational_canonical_legs_v1()') is not null as present`)).present,
    true,
    `the migration chain applies ${MIGRATION_NAME}`
  );

  // --- Fresh but empty: nothing to project is not a stale claim ------------
  await request(`select reporting.refresh_operational_canonical_legs_v1()`);
  assert.deepEqual(await readProjection('operational_canonical_flight_legs'), [], 'an empty operational store projects nothing');
  const emptyStatus = await scalar(`select * from reporting.operational_projection_status_v1()`);
  assert.deepEqual(
    pick(emptyStatus, ['is_fresh', 'leg_count', 'quarantine_count']),
    { is_fresh: true, leg_count: 0, quarantine_count: 0 },
    `an empty projection is fresh and says so honestly (${JSON.stringify(emptyStatus)})`
  );
  assert.equal(emptyStatus.ops_min_date, null, 'an empty projection carries no date bounds');

  // --- Populate the operational store, then project it ---------------------
  await asWriter();
  await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid) as result`, ['2026-10-01', writerId]);
  await asAdmin();

  const watermarkBeforeRefresh = Number(
    (await scalar(`select coalesce(max(server_seq), 0)::bigint as seq from public.season_change_events`)).seq
  );
  await request(`select reporting.refresh_operational_canonical_legs_v1()`);
  const shadowLegs = await readProjection('operational_canonical_flight_legs');
  const canonicalLegs = await readProjection('canonical_flight_legs');
  assert.ok(canonicalLegs.length > 0, 'the fixture canonical store is populated');
  assert.deepEqual(shadowLegs, canonicalLegs, 'the shadow projection is field-for-field identical to the canonical store');

  const shadowQuarantine = (
    await request(`select ops_date, candidate_count from reporting.operational_canonical_flight_legs_quarantine order by ops_date, candidate_count`)
  ).rows;
  const canonicalQuarantine = (
    await request(`select ops_date, candidate_count from reporting.canonical_flight_legs_quarantine order by ops_date, candidate_count`)
  ).rows;
  assert.ok(canonicalQuarantine.length > 0, 'the fixture canonical store quarantined at least one key');
  assert.deepEqual(shadowQuarantine, canonicalQuarantine, 'the writer-side ledger reproduces the canonical quarantine rows');

  const status = await scalar(`select * from reporting.operational_projection_status_v1()`);
  assert.deepEqual(
    pick(status, ['is_fresh', 'leg_count', 'quarantine_count']),
    { is_fresh: true, leg_count: shadowLegs.length, quarantine_count: shadowQuarantine.length },
    `the status counts what the projection holds (${JSON.stringify(status)})`
  );
  assert.equal(DATE(status.ops_min_date), DATE(canonicalLegs[0].ops_date), 'the status records the projected lower bound');
  assert.equal(DATE(status.ops_max_date), DATE(canonicalLegs[canonicalLegs.length - 1].ops_date), 'the status records the projected upper bound');
  assert.equal(
    Number(status.source_watermark),
    watermarkBeforeRefresh,
    'the status claims the high-water the refresh saw before it read the source'
  );
  assert.equal(
    Number(status.observed_watermark),
    watermarkBeforeRefresh,
    'an uncontended refresh observes the same high-water after writing its rows'
  );

  // --- The report reads the mesma numbers through either store -------------
  const canonicalSurfaces = await captureM0ReadSurfaces({ db });
  await request(`alter table reporting.canonical_flight_legs rename to canonical_flight_legs_m0_backup`);
  await request(`alter table reporting.canonical_flight_legs_quarantine rename to canonical_flight_legs_quarantine_m0_backup`);
  await request(`alter table reporting.operational_canonical_flight_legs rename to canonical_flight_legs`);
  await request(`alter table reporting.operational_canonical_flight_legs_quarantine rename to canonical_flight_legs_quarantine`);
  try {
    const shadowSurfaces = await captureM0ReadSurfaces({ db });
    assert.deepEqual(
      shadowSurfaces.canonicalStore,
      canonicalSurfaces.canonicalStore,
      'the report reads the same canonical rows through the shadow store'
    );
    assert.deepEqual(shadowSurfaces.quarantine, canonicalSurfaces.quarantine, 'the report reads the same quarantine rows');
    assert.deepEqual(
      shadowSurfaces.report,
      canonicalSurfaces.report,
      `report numbers, coverage and quality are identical when the shadow store is in place (${JSON.stringify(shadowSurfaces.report.quality)})`
    );
    assert.deepEqual(
      pick(shadowSurfaces, ['effectiveLegs', 'seasonalExports', 'operationalWindow']),
      pick(canonicalSurfaces, ['effectiveLegs', 'seasonalExports', 'operationalWindow']),
      'the legacy-chain surfaces the shadow never touches stay identical'
    );
  } finally {
    await request(`alter table reporting.canonical_flight_legs rename to operational_canonical_flight_legs`);
    await request(`alter table reporting.canonical_flight_legs_quarantine rename to operational_canonical_flight_legs_quarantine`);
    await request(`alter table reporting.canonical_flight_legs_m0_backup rename to canonical_flight_legs`);
    await request(`alter table reporting.canonical_flight_legs_quarantine_m0_backup rename to canonical_flight_legs_quarantine`);
  }
  assert.equal(
    (await scalar(`select count(*)::integer as count from reporting.canonical_flight_legs`)).count,
    canonicalLegs.length,
    'the canonical store is back in place after the parity run'
  );

  // --- Freshness tracks the writer high-water, not wall-clock time ---------
  await scalar(
    `insert into public.season_change_events (event_id, season_id, client_id, op_id, target_type, target_id, changed_fields)
     values ('m3-stale-marker', $1, 'm4-resource-mutation', 'm3-3', 'operationalLeg', '00000000-0000-4000-8000-000000000000', array['gate'])
     returning server_seq`,
    [M0_FIXTURE.seasonW26]
  );
  assert.equal(
    (await scalar(`select is_fresh from reporting.operational_projection_status_v1()`)).is_fresh,
    false,
    'a writer event the projection has not seen makes it stale even when the rows did not change'
  );

  await request(`select reporting.refresh_operational_canonical_legs_v1()`);
  const afterRefresh = await scalar(`select * from reporting.operational_projection_status_v1()`);
  assert.equal(afterRefresh.is_fresh, true, 'refreshing to the new high-water makes the projection fresh again');
  assert.deepEqual(
    await readProjection('operational_canonical_flight_legs'),
    shadowLegs,
    'the refresh only re-derives the projection: an event that touches no leg changes no row'
  );

  // --- A writer committing mid-refresh is never claimed as covered ---------
  // The trigger stands in for a concurrent writer: it commits an event while the
  // refresh is writing rows, i.e. after the source read. The projection must not
  // claim that event, or the report would read stale rows and call them fresh.
  await request(
    `create function pg_temp.m3_mid_refresh_writer() returns trigger language plpgsql as $fn$
     begin
       insert into public.season_change_events (event_id, season_id, client_id, op_id, target_type, target_id, changed_fields)
       values ('m3-mid-refresh', '${M0_FIXTURE.seasonW26}', 'm3-race-writer', 'm3-4', 'operationalLeg', '00000000-0000-4000-8000-000000000002', array['gate']);
       return null;
     end;
     $fn$`
  );
  await request(
    `create trigger m3_mid_refresh after insert on reporting.operational_canonical_flight_legs
     for each statement execute function pg_temp.m3_mid_refresh_writer()`
  );
  const beforeRace = await scalar(`select * from reporting.operational_projection_status_v1()`);
  try {
    await request(`select reporting.refresh_operational_canonical_legs_v1()`);
  } finally {
    await request(`drop trigger m3_mid_refresh on reporting.operational_canonical_flight_legs`);
  }
  const raced = await scalar(`select * from reporting.operational_projection_status_v1()`);
  assert.equal(
    Number(raced.source_watermark),
    Number(beforeRace.current_watermark),
    'the raced refresh still claims only the high-water it saw before reading the source'
  );
  assert.ok(
    Number(raced.observed_watermark) > Number(raced.source_watermark),
    `the mid-refresh writer is observed and recorded, not claimed (${JSON.stringify(pick(raced, ['source_watermark', 'observed_watermark']))})`
  );
  assert.equal(raced.is_fresh, false, 'a raced refresh leaves the projection stale instead of lying');

  await request(`select reporting.refresh_operational_canonical_legs_v1()`);
  assert.equal(
    (await scalar(`select is_fresh from reporting.operational_projection_status_v1()`)).is_fresh,
    true,
    'the follow-up refresh picks the missed writer up and becomes fresh'
  );

  // --- Internal surface ----------------------------------------------------
  await asWriter();
  await assert.rejects(
    () => request(`select count(*) from reporting.operational_canonical_flight_legs`),
    (error) => {
      const actual = error?.code ?? error?.cause?.code;
      assert.equal(actual, INSECURE, `authenticated must not read the projection table (got ${actual}: ${error.message})`);
      return true;
    },
    'the projection is a service-side surface'
  );
  await assert.rejects(
    () => request(`select reporting.refresh_operational_canonical_legs_v1()`),
    (error) => {
      const actual = error?.code ?? error?.cause?.code;
      assert.equal(actual, INSECURE, `authenticated must not run the refresh (got ${actual}: ${error.message})`);
      return true;
    },
    'the refresh is a service-side surface'
  );
  await assert.rejects(
    () => request(`select * from reporting.operational_projection_status_v1()`),
    (error) => {
      const actual = error?.code ?? error?.cause?.code;
      assert.equal(actual, INSECURE, `authenticated must not read the freshness status (got ${actual}: ${error.message})`);
      return true;
    },
    'the freshness gate is a service-side surface'
  );
  await asAdmin();

  // --- Regression: preserved legacy recency vs native operational competition ---
  {
    // 1. Verify that the backfilled leg carries an authoritative sequence from actual
    // backfill (M2), not a manual mock link.
    const backfilledJx701 = await scalar(
      `select legs.leg_id, legs.leg_key, legs.pax, legs.route, legs.scheduled_time,
              links.authoritative_server_seq, links.legacy_record_id, links.legacy_season_id
       from public.operational_flight_legs legs
       join public.operational_leg_backfill_links links on links.leg_id = legs.leg_id
       where legs.leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX701' and legs.status = 'active'`
    );
    assert.ok(backfilledJx701, 'backfilled JX701 leg exists from actual M2 backfill');
    assert.ok(
      backfilledJx701.authoritative_server_seq !== null && Number(backfilledJx701.authoritative_server_seq) > 0,
      `backfilled leg link carries known authoritative sequence from actual backfill (${backfilledJx701.authoritative_server_seq})`
    );
    const legacyJx701Seq = Number(backfilledJx701.authoritative_server_seq);

    // 2. Insert a competing native manual leg with the same business key and a newer
    // operational event.
    const nativeLegId = '10000000-0000-4000-8000-000000000701';
    await request(
      `insert into public.operational_flight_legs (
         leg_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
         raw_flight_number, route, aircraft_type, flight_category, pax, source_type, source_season_id, status
       ) values (
         $1, 'A\x1f2026-10-25\x1fJX\x1fJX701', '2026-10-25', '2026-10-25', '10:45:00', 'ARR', 'JX', 'JX701',
         '701', 'KIX', '321', 'J', 215, 'operational_manual', $2, 'active'
       )`,
      [nativeLegId, null]
    );
    const nativeEvent = await scalar(
      `insert into public.season_change_events (
         event_id, season_id, client_id, op_id, target_type, target_id, changed_fields
       ) values (
         'm3-native-publish-jx701', $1, 'm7-publish', 'pub-reg-1', 'operationalLeg', $2, array['schedule', 'pax']
       ) returning server_seq`,
      [M0_FIXTURE.seasonW26, nativeLegId]
    );
    const nativeSeq = Number(nativeEvent.server_seq);
    assert.ok(nativeSeq > legacyJx701Seq, `native event seq (${nativeSeq}) is newer than backfilled seq (${legacyJx701Seq})`);

    // Refresh projection: must choose newer native leg, NOT quarantine or drop flight
    await request(`select reporting.refresh_operational_canonical_legs_v1()`);

    const projectedWinner = await scalar(
      `select business_leg_key, pax, route, scheduled_local_at, local_minutes
       from reporting.operational_canonical_flight_legs
       where business_leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX701'`
    );
    assert.ok(projectedWinner, 'projection must choose the newer native leg and not drop the flight');
    assert.equal(projectedWinner.pax, 215, 'projection chose native leg pax (215 vs backfilled 180)');
    assert.equal(projectedWinner.route, 'KIX', 'projection chose native leg route (KIX vs backfilled TPE)');
    assert.equal(projectedWinner.local_minutes, 645, 'projection chose native leg scheduled time (10:45)');

    const quarantine25 = await scalar(
      `select ops_date, candidate_count
       from reporting.operational_canonical_flight_legs_quarantine
       where ops_date = '2026-10-25'`
    );
    assert.equal(quarantine25, undefined, 'projection must not quarantine 2026-10-25 when competing legs have known recency');

    // 3. Exercise leg-only source fallback when no native event exists:
    // A backfilled leg with captured recency competing against an older candidate wins
    // purely on its backfilled link sequence fallback.
    const backfilledJx703 = await scalar(
      `select legs.leg_id, legs.leg_key, legs.pax, legs.scheduled_time, links.authoritative_server_seq
       from public.operational_flight_legs legs
       join public.operational_leg_backfill_links links on links.leg_id = legs.leg_id
       where legs.leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX703' and legs.status = 'active'`
    );
    assert.ok(backfilledJx703, 'backfilled JX703 leg exists with backfill link');
    const legacyJx703Seq = Number(backfilledJx703.authoritative_server_seq);
    assert.ok(legacyJx703Seq > 1, 'JX703 has captured sequence from backfill');

    // Add an older competitor with an older backfill link sequence
    const olderCompetitorLegId = '10000000-0000-4000-8000-000000000703';
    await request(
      `insert into public.operational_flight_legs (
         leg_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
         raw_flight_number, route, aircraft_type, flight_category, pax, source_type, source_season_id, status
       ) values (
         $1, 'A\x1f2026-10-25\x1fJX\x1fJX703', '2026-10-25', '2026-10-25', '18:00:00', 'ARR', 'JX', 'JX703',
         '703', 'TPE', '321', 'J', 99, 'operational_manual', $2, 'active'
       )`,
      [olderCompetitorLegId, null]
    );
    await request(
      `insert into public.operational_leg_backfill_links (
         legacy_season_id, legacy_record_id, leg_id, authoritative_server_seq
       ) values ($1, 'OLDER-703', $2, 1)`,
      [M0_FIXTURE.seasonLegacy, olderCompetitorLegId]
    );

    await request(`select reporting.refresh_operational_canonical_legs_v1()`);
    const jx703Winner = await scalar(
      `select business_leg_key, pax, local_minutes
       from reporting.operational_canonical_flight_legs
       where business_leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX703'`
    );
    assert.ok(jx703Winner, 'JX703 is projected based on leg-only source fallback');
    assert.equal(jx703Winner.pax, 0, 'backfilled winner pax preserved (0 from overlay vs older competitor 99)');
    assert.equal(jx703Winner.local_minutes, 1125, 'backfilled winner scheduled time preserved (18:45 vs 18:00)');

    // 4. Native entity / day priority: an event on the competitor outranks the backfill link
    const competitorEntityEvent = await scalar(
      `insert into public.season_change_events (
         event_id, season_id, client_id, op_id, target_type, target_id, changed_fields
       ) values (
         'm3-competitor-event-703', $1, 'm4-resource-mutation', 'm3-mut-703', 'operationalLeg', $2, array['pax']
       ) returning server_seq`,
      [M0_FIXTURE.seasonW26, olderCompetitorLegId]
    );
    assert.ok(Number(competitorEntityEvent.server_seq) > legacyJx703Seq, 'entity event sequence is newer');
    await request(`select reporting.refresh_operational_canonical_legs_v1()`);
    const jx703NewWinner = await scalar(
      `select business_leg_key, pax
       from reporting.operational_canonical_flight_legs
       where business_leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX703'`
    );
    assert.ok(jx703NewWinner, 'JX703 is projected');
    assert.equal(jx703NewWinner.pax, 99, 'native entity event outranked backfill link fallback');

    // 5. Truly unknown recency quarantine: existing case on 2026-12-18 (L26 leg has no events)
    // plus a new candidate with NO events and NO backfill link recency.
    const unknownRecencyLegId = '10000000-0000-4000-8000-000000000999';
    await request(
      `insert into public.operational_flight_legs (
         leg_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
         raw_flight_number, route, aircraft_type, flight_category, pax, source_type, source_season_id, status
       ) values (
         $1, 'A\x1f2026-10-25\x1fJX\x1fJX701', '2026-10-25', '2026-10-25', '11:00:00', 'ARR', 'JX', 'JX701',
         '701', 'KIX', '321', 'J', 333, 'operational_manual', $2, 'active'
       )`,
      [unknownRecencyLegId, null]
    );
    await request(`select reporting.refresh_operational_canonical_legs_v1()`);
    const quarantinedDueToUnknown = await scalar(
      `select ops_date, candidate_count
       from reporting.operational_canonical_flight_legs_quarantine
       where ops_date = '2026-10-25'`
    );
    assert.ok(quarantinedDueToUnknown, 'competing against genuinely unknown recency candidate quarantines the date');
    const droppedFromProjected = await scalar(
      `select * from reporting.operational_canonical_flight_legs where business_leg_key = 'A\x1f2026-10-25\x1fJX\x1fJX701'`
    );
    assert.equal(droppedFromProjected, undefined, 'ambiguous flight is not projected into canonical legs');
  }

  console.log('M3.2/M3.3/M3.4 shadow projection holds: identical rows and quarantine through the report position, freshness tied to the writer high-water, and no authenticated access.');
} finally {
  await ctx.close();
}
