// M3.1 shadow candidate seam contract test: reporting.get_operational_candidate_slice_v1
// must re-project the operational store with the exact column set of the
// canonical candidate slice, without recomputing what the writer already baked.
//
// Proves on the M0 fixture that
//   * the chain applies the migration and the rollback drops it cleanly,
//   * the seam returns exactly the active legs of the requested operational-date
//     window (and nothing outside it, including empty and inverted ranges),
//   * every row maps 1:1 to its leg: business_leg_key = leg_key, record_id =
//     leg_id (the identity M4.2 writes as event target), season_id = lineage
//     season (NULL for daily legs), type from side, uppercased text fields,
//     effective_* equal to the row (overlay already baked by the writer) and
//     pax NULL preserved,
//   * field values agree with reporting.get_public_traffic_candidate_slice_v1 for
//     every business key the canonical seam resolves to a single candidate in
//     the same lineage season, so the two seams describe the same flights,
//   * authoritative_server_seq is entity recency first, day authority second,
//     and NULL when neither exists (ties stay ties instead of being guessed),
//   * the function is internal: authenticated cannot execute it.
//
// Run: node supabase/tests/seasonal_operational_separation_m3_slice_pglite.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const MIGRATION_NAME = '20260928140000_operational_candidate_slice_v1.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);
const INSECURE = '42501';

const WINDOW = ['2026-10-01', '2027-01-31'];
const DATE = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const writerId = M0_FIXTURE.writerId;
const request = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => (await request(sql, params)).rows[0];
const slice = async ([from, to]) =>
  (await request(`select * from reporting.get_operational_candidate_slice_v1($1::date, $2::date)`, [from, to])).rows;

try {
  // --- Rollback drops the seam cleanly -------------------------------------
  await db.exec(await readFile(ROLLBACK_URL, 'utf8'));
  assert.equal(
    (await scalar(`select to_regprocedure('reporting.get_operational_candidate_slice_v1(date,date)') is not null as present`)).present,
    false,
    'the rollback drops the shadow seam'
  );
  await db.exec(await readFile(MIGRATION_URL, 'utf8'));
  assert.equal(
    (await scalar(`select to_regprocedure('reporting.get_operational_candidate_slice_v1(date,date)') is not null as present`)).present,
    true,
    `the migration chain applies ${MIGRATION_NAME}`
  );

  // --- Populate the operational store with the M2 backfill -----------------
  await asWriter();
  await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid) as result`, ['2026-10-01', writerId]);
  await asAdmin();

  // --- Bounds: exactly the active legs of the window -----------------------
  const rows = await slice(WINDOW);
  const legs = (
    await request(
      `select leg_id::text as leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
              side, airline, flight_number, route, aircraft_type, pax, source_season_id, source_type
         from public.operational_flight_legs
        where status = 'active' and operational_date between $1::date and $2::date
        order by leg_key`,
      WINDOW
    )
  ).rows;
  assert.ok(legs.length > 0, 'the fixture produced active legs inside the window');
  assert.equal(rows.length, legs.length, 'the seam returns one row per active leg in the window');
  assert.deepEqual(
    rows.map((row) => row.business_leg_key).sort(),
    legs.map((leg) => leg.leg_key).sort(),
    'the seam covers exactly the business keys of the window'
  );
  assert.deepEqual(await slice(['2020-01-01', '2020-01-31']), [], 'a window with no legs is empty');
  assert.deepEqual(await slice(['2027-01-31', '2026-10-01']), [], 'an inverted window returns nothing');

  // --- Every row maps 1:1 to its leg --------------------------------------
  const byKey = new Map(rows.map((row) => [row.business_leg_key, row]));
  for (const leg of legs) {
    const row = byKey.get(leg.leg_key);
    assert.ok(row, `the seam exposes ${leg.leg_key}`);
    assert.equal(row.record_id, leg.leg_id, 'record_id is the operational identity used as the event target');
    assert.equal(row.season_id, leg.source_season_id, `season_id is the lineage season (${leg.leg_key})`);
    assert.equal(row.type, leg.side === 'ARR' ? 'A' : 'D', 'type derives from side');
    assert.equal(row.airline, leg.airline.toUpperCase(), 'airline is uppercased');
    assert.equal(row.flight_number, leg.flight_number.toUpperCase(), 'flight_number is uppercased');
    assert.equal(row.route, leg.route.toUpperCase(), 'route is uppercased');
    assert.equal(row.aircraft, leg.aircraft_type.toUpperCase(), 'aircraft is uppercased');
    assert.equal(row.pax, leg.pax, `pax is passed through, NULL included (${leg.leg_key})`);
    const scheduledDate = DATE(leg.scheduled_date);
    const scheduledTime = String(leg.scheduled_time).slice(0, 5);
    assert.equal(row.scheduled_date, scheduledDate, 'scheduled_date is the text date');
    assert.equal(row.scheduled_time, scheduledTime, 'scheduled_time is HH:MM');
    assert.equal(
      row.local_minutes,
      Number(scheduledTime.slice(0, 2)) * 60 + Number(scheduledTime.slice(3, 5)),
      'local_minutes is the minute of day'
    );
    assert.equal(DATE(row.ops_date), DATE(leg.operational_date), 'ops_date is the stored operational_date');
    assert.equal(row.business_leg_key, leg.leg_key, 'business_leg_key is the stored leg_key');
    assert.deepEqual(
      pick(row, ['effective_route', 'effective_aircraft', 'effective_pax', 'effective_action']),
      { effective_route: row.route, effective_aircraft: row.aircraft, effective_pax: row.pax, effective_action: 'active' },
      'the effective columns are the row itself: the writer already applied the overlay'
    );
  }
  assert.equal(
    await scalar(
      `select count(*)::integer as count from reporting.get_operational_candidate_slice_v1($1::date, $2::date) slice
        where slice.scheduled_local_at is distinct from (slice.scheduled_date || ' ' || slice.scheduled_time)::timestamp`,
      WINDOW
    ).then((row) => row.count),
    0,
    'scheduled_local_at composes the local timestamp of the leg'
  );

  // --- Fixture facts the mapping must not lose ----------------------------
  const overlayLeg = byKey.get('A\u001f2026-10-25\u001fJX\u001fJX703');
  assert.ok(overlayLeg, 'the overlay-retimed arrival is in the window');
  assert.equal(overlayLeg.scheduled_time, '18:45', 'the overlay-baked schedule flows through the seam unchanged');
  assert.equal(overlayLeg.scheduled_date, '2026-10-25', 'the retimed leg keeps its scheduled date');
  const manual = byKey.get('D\u001f2026-10-25\u001fVN\u001fVN555');
  assert.ok(manual, 'the operator manual leg is a candidate');
  assert.equal(manual.season_id, null, 'a manual leg carries no lineage season');
  const nullPax = byKey.get('A\u001f2026-12-15\u001fJX\u001fJX801');
  assert.ok(nullPax, 'the cross-season duplicate is in the window');
  assert.equal(nullPax.pax, null, 'unknown pax stays NULL instead of collapsing to 0');

  // --- Cross-seam agreement with the canonical candidate slice -------------
  const canonical = (
    await request(`select * from reporting.get_public_traffic_candidate_slice_v1($1::date, $2::date)`, WINDOW)
  ).rows;
  const canonicalByKey = new Map();
  for (const row of canonical) {
    canonicalByKey.set(row.business_leg_key, [...(canonicalByKey.get(row.business_leg_key) ?? []), row]);
  }
  const FIELDS = [
    'type', 'airline', 'flight_number', 'route', 'aircraft', 'pax',
    'scheduled_date', 'scheduled_time', 'local_minutes', 'ops_date', 'business_leg_key',
  ];
  const sourceKind = new Map(legs.map((leg) => [leg.leg_key, leg.source_type]));
  let compared = 0;
  for (const row of rows) {
    const candidates = canonicalByKey.get(row.business_leg_key) ?? [];
    if (candidates.length !== 1) continue;
    if (sourceKind.get(row.business_leg_key) === 'published_seasonal') {
      assert.equal(candidates[0].season_id, row.season_id, `the canonical candidate of ${row.business_leg_key} belongs to the same lineage season`);
    }
    assert.deepEqual(pick(row, FIELDS), pick(candidates[0], FIELDS), `both seams describe ${row.business_leg_key} identically`);
    compared += 1;
  }
  assert.equal(compared, 6, `the fixture resolves six shadow keys to a single canonical candidate (${JSON.stringify(rows.map((row) => row.business_leg_key))})`);
  assert.equal(
    rows.every((row) => canonicalByKey.has(row.business_leg_key)),
    true,
    'the seam never invents a business key the canonical candidate set does not hold'
  );
  const multiCandidate = rows
    .filter((row) => (canonicalByKey.get(row.business_leg_key) ?? []).length > 1)
    .map((row) => row.business_leg_key);
  assert.equal(
    multiCandidate.length,
    2,
    `duplicate business keys stay multi-candidate in the canonical seam; their recency resolution belongs to the projection parity (${JSON.stringify(multiCandidate)})`
  );

  // --- Native entity recency takes precedence over day authority ----------
  // The entity event is written first, so its sequence is older than the day
  // event: entity precedence is proven by identity, not by magnitude.
  const dayLegs = rows.filter((row) => DATE(row.ops_date) === '2026-10-25');
  assert.ok(dayLegs.length > 1, 'the fixture has several legs on the event day');
  const entityTarget = dayLegs[0];
  const entityEvent = await scalar(
    `insert into public.season_change_events (event_id, season_id, client_id, op_id, target_type, target_id, changed_fields)
     values ('m3-entity-event', $2, 'm4-resource-mutation', 'm3-1', 'operationalLeg', $1, array['gate'])
     returning server_seq`,
    [entityTarget.record_id, M0_FIXTURE.seasonW26]
  );
  const dayEvent = await scalar(
    `insert into public.season_change_events (event_id, season_id, client_id, op_id, target_type, target_id, changed_fields)
     values ('m3-day-authority', $1, 'm5-daily-commit', 'm3-2', 'dailyAuthority', '2026-10-25', array['canonicalFlightLegs'])
     returning server_seq`,
    [M0_FIXTURE.seasonW26]
  );
  assert.ok(Number(dayEvent.server_seq) > Number(entityEvent.server_seq), 'the day event is the newer event');

  const afterEvents = await slice(WINDOW);
  const entityRow = afterEvents.find((row) => row.record_id === entityTarget.record_id);
  assert.equal(
    Number(entityRow.authoritative_server_seq),
    Number(entityEvent.server_seq),
    'an entity event outranks the newer day fallback for its own leg'
  );
  for (const row of afterEvents.filter((other) => DATE(other.ops_date) === '2026-10-25' && other.record_id !== entityTarget.record_id)) {
    assert.equal(
      Number(row.authoritative_server_seq),
      Number(dayEvent.server_seq),
      'a day authority event dates every other leg of that day'
    );
  }
  for (const row of afterEvents.filter((other) => DATE(other.ops_date) !== '2026-10-25')) {
    assert.equal(
      row.authoritative_server_seq,
      rows.find((before) => before.record_id === row.record_id).authoritative_server_seq,
      'the day event never changes recency on other days'
    );
  }

  // --- Internal seam -------------------------------------------------------
  await asWriter();
  await assert.rejects(
    () => request(`select * from reporting.get_operational_candidate_slice_v1($1::date, $2::date)`, WINDOW),
    (error) => {
      const actual = error?.code ?? error?.cause?.code;
      assert.equal(actual, INSECURE, `authenticated must not execute the internal seam (got ${actual}: ${error.message})`);
      return true;
    },
    'the shadow seam is executable only by the definer RPCs'
  );
  await asAdmin();

  console.log('M3.1 shadow seam holds: the operational store re-projects the canonical candidate contract, keeps NULL pax and lineage, mirrors the canonical values per business key, and derives recency from entity then day events.');
} finally {
  await ctx.close();
}
