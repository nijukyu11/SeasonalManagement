// M0 baseline: pins the pre-cutover semantics of the seasonal/operational seam.
//
// The suite builds one multi-season fixture (see
// seasonal_operational_separation_fixture.mjs), asserts the invariants the
// migration plan must preserve, and freezes the normalized read surfaces that
// M10 re-reads for shadow parity:
//   - reporting.canonical_effective_flight_legs (per-season overlay merge)
//   - reporting.canonical_flight_legs + quarantine (cross-season resolution)
//   - get_seasonal_export_snapshot_v2 for both seasons
//   - get_season_schedule_allocation_window_v2 (the Daily/Check-in/Gate read)
//   - get_public_traffic_report_v2 (the report/dashboard aggregate)
//
// Refresh the committed baseline only when a milestone intentionally changes a
// surface:
//   SEASONAL_OPERATIONAL_M0_UPDATE_BASELINE=1 node supabase/tests/seasonal_operational_separation_m0_baseline_pglite.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { buildM0Fixture, captureM0ReadSurfaces, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const BASELINE_URL = new URL('./fixtures/seasonal_operational_separation_m0_baseline.json', import.meta.url);
const UPDATE_BASELINE = process.env.SEASONAL_OPERATIONAL_M0_UPDATE_BASELINE === '1';

const byDate = (legs, date) => legs.filter((leg) => leg.date === date);
const activeOn = (legs, date) => byDate(legs, date).filter((leg) => leg.status === 'active');
const summarize = (legs) =>
  legs.map((leg) => `${leg.date} ${leg.flight_number} ${leg.type} ${leg.scheduled_time ?? ''} ${leg.status}`.trim());

function diffPaths(left, right, pointer = '', out = []) {
  if (out.length >= 20) return out;
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftArray = Array.isArray(left) ? left : [];
    const rightArray = Array.isArray(right) ? right : [];
    if (leftArray.length !== rightArray.length) out.push(`${pointer}: length ${leftArray.length} -> ${rightArray.length}`);
    for (let index = 0; index < Math.max(leftArray.length, rightArray.length); index += 1) {
      diffPaths(leftArray[index], rightArray[index], `${pointer}/${index}`, out);
      if (out.length >= 20) break;
    }
    return out;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      diffPaths(left[key], right[key], `${pointer}/${key}`, out);
      if (out.length >= 20) break;
    }
    return out;
  }
  if (left !== right) out.push(`${pointer}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
  return out;
}

const fixture = await buildM0Fixture();
try {
  const { w26, m26, overlays, manual, daily, legsAfterDaily, scopes, versions } = fixture.evidence;

  // --- Seasonal import: identity collapse and the derived turnaround side ---
  assert.equal(w26.stage.status, 'validated', 'W26 seasonal stage must validate');
  assert.equal(w26.commit.status, 'committed', 'W26 seasonal commit must succeed');
  assert.equal(w26.commit.dataVersion, 1, 'W26 data version after the first import');
  assert.equal(w26.commit.counts.insertCount, 7, 'W26 replace must commit seven legs');
  assert.equal(m26.commit.counts.insertCount, 2, 'M26 replace must commit its two source legs');

  const october25 = activeOn(legsAfterDaily, '2026-10-25');
  assert.deepEqual(summarize(october25).sort(), [
    '2026-10-25 JX701 A 10:00 active',
    '2026-10-25 JX703 A 18:00 active',
    '2026-10-25 VN555 D 09:00 active',
  ], 'October 25 holds the two seasonal legs plus the manual leg');
  assert.equal(
    byDate(legsAfterDaily, '2026-10-25').filter((leg) => leg.flight_number === 'JX701').length,
    1,
    'the duplicate same-side JX701 row (22:00/KIX) must not produce a second leg'
  );
  assert.equal(
    legsAfterDaily.filter((leg) => leg.flight_number === 'JX703' && leg.type === 'D').length,
    0,
    'the departure side of a same-flight-number turnaround is dropped by the current identity rule'
  );

  // --- Overlays: effective values move, canonical base rows stay untouched ---
  assert.deepEqual(
    manual,
    { action: 'added', recordId: M0_FIXTURE.manualLegId, seasonId: M0_FIXTURE.seasonW26, sourceKind: 'manual' },
    'the manual leg is a canonical base row created through the overlay RPC'
  );
  assert.ok(overlays.pickupLegId && overlays.turnaroundLegId, 'overlay targets resolved from the seasonal import');

  // --- Daily authority: replace a day, then re-import it, then refuse zero legs ---
  assert.equal(daily.firstStage.status, 'validated', 'first Daily stage must validate');
  assert.equal(daily.firstCommit.seasons[0].deletedCount, 2, 'Daily import replaces the two seasonal legs of the day');
  assert.equal(daily.firstCommit.seasons[0].insertedCount, 3, 'Daily import inserts three legs');
  assert.equal(daily.firstCommit.seasons[0].dataVersion, 2, 'Daily import bumps the season data version');
  assert.deepEqual(
    daily.firstEffectiveLegs.map((leg) => [leg.flight, leg.pax, leg.scheduled_time]),
    [['VN101', 123, '06:00'], ['VN102', null, '07:00'], ['VN103', 0, '08:00']],
    'Daily legs keep pax 123 / NULL / 0 apart'
  );
  assert.equal(daily.reimportCommit.seasons[0].deletedCount, 3, 'the re-import deletes the previous daily legs');
  assert.equal(daily.reimportCommit.seasons[0].insertedCount, 2, 'the re-import inserts its own leg set');
  assert.equal(daily.reimportCommit.seasons[0].dataVersion, 3, 'the re-import bumps the season data version again');
  assert.deepEqual(
    daily.reimportEffectiveLegs.map((leg) => [leg.flight, leg.pax, leg.scheduled_time]),
    [['VN101', 123, '06:30'], ['VN201', 45, '12:00']],
    'the day ends up holding only the re-imported legs'
  );
  assert.equal(
    activeOn(legsAfterDaily, '2026-10-26').filter((leg) => leg.source_kind === 'seasonal').length,
    0,
    'a Daily-authoritative day never resurrects its seasonal legs'
  );
  assert.deepEqual(
    byDate(legsAfterDaily, '2026-10-26').filter((leg) => leg.status === 'deleted').map((leg) => leg.deletion_reason),
    ['daily_replacement', 'daily_replacement', 'daily_replacement', 'daily_replacement', 'daily_replacement'],
    'every replaced leg is soft-deleted with the daily replacement reason'
  );
  assert.deepEqual(
    scopes.map((scope) => ({ authority: scope.authority_source, expected: scope.expected_leg_count })),
    [{ authority: 'daily', expected: 2 }],
    'the Daily authority scope tracks the re-imported leg count'
  );
  // M5 replaces this contract: an empty leg set plus an affected date must then
  // clear the day instead of failing the stage.
  assert.equal(daily.zeroFlightStage.status, 'failed', 'the v1 Daily contract cannot import zero legs');
  assert.deepEqual(
    daily.zeroFlightStage.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity]),
    [['DAILY_RANGE_MISMATCH', 'blocking']],
    'zero-leg Daily stage reports the affected-date mismatch'
  );

  assert.deepEqual(versions.map((row) => [row.id, row.data_version]).sort(), [
    [M0_FIXTURE.seasonLegacy, 0],
    [M0_FIXTURE.seasonM26, 1],
    [M0_FIXTURE.seasonW26, 3],
  ], 'season data versions after the fixture');

  // --- Read surfaces -------------------------------------------------------
  const surfaces = await captureM0ReadSurfaces(fixture);

  assert.deepEqual(
    surfaces.effectiveLegs
      .filter((leg) => leg.season_id === M0_FIXTURE.seasonW26 && leg.ops_date.startsWith('2026-10-25'))
      .map((leg) => [leg.flight, leg.scheduled_time, leg.pax, leg.gate, leg.stand, leg.carousel]),
    [['VN555', '09:00', 88, 1, '20A', null], ['JX701', '10:00', 180, 20, '31', 4], ['JX703', '18:45', 0, null, null, null]],
    'the effective view merges overlays in place (schedule shift, pax 0, resources)'
  );
  assert.deepEqual(
    surfaces.canonicalStore.map((row) => row.business_leg_key.replace(/\u001f/g, '|')),
    [
      'A|2026-10-25|JX|JX701',
      'A|2026-10-25|JX|JX703',
      'D|2026-10-25|VN|VN555',
      'D|2026-10-26|VN|VN101',
      'D|2026-10-26|VN|VN201',
      'A|2026-12-15|JX|JX801',
      'A|2026-12-16|JX|JX901',
      'A|2026-12-17|JX|JX902',
    ],
    'the canonical store keeps one row per business leg and drops nothing else'
  );
  assert.deepEqual(
    surfaces.canonicalStore.map((row) => row.pax),
    [180, 0, 88, 123, 45, null, null, null],
    'the canonical store carries the operational overlay values'
  );
  assert.deepEqual(
    surfaces.quarantine.map((row) => [row.ops_date.slice(0, 10), row.candidate_count]),
    [['2026-12-18', 2]],
    'a business leg whose candidate season has no change events is quarantined instead of picked'
  );

  const october = surfaces.report.october;
  assert.deepEqual(october.current, {
    status: 'partial', flights: 5, due_legs: 5, arrivals: 2, departures: 3,
    reported_pax: 436, reported_legs: 5, missing_due_legs: 0,
    arrival_reported_pax: 180, departure_reported_pax: 256, true_zero_reported_legs: 1,
  }, 'October report totals include manual, overlay and daily legs');
  assert.deepEqual(
    october.timeline.map((row) => [row.ops_date, row.flights, row.reported_pax, row.status]),
    [
      ['2026-10-24', null, null, 'missing'],
      ['2026-10-25', 3, 268, 'partial'],
      ['2026-10-26', 2, 168, 'complete'],
      ['2026-10-27', null, null, 'missing'],
      ['2026-10-28', null, null, 'missing'],
    ],
    'October timeline separates covered, empty and missing days'
  );
  assert.deepEqual(
    october.dimensions.airline.map((row) => [row.label, row.flights, row.reported_pax]),
    [['VN', 3, 256], ['JX', 2, 180]],
    'airline dimension totals'
  );
  assert.deepEqual(
    october.coverage,
    { selected_day_count: 5, covered_day_count: 1, partial_day_count: 1, missing_day_count: 3 },
    'October coverage counters'
  );
  const december = surfaces.report.december;
  assert.deepEqual(
    december.timeline.map((row) => [row.ops_date, row.flights, row.status]),
    [
      ['2026-12-14', null, 'missing'],
      ['2026-12-15', 1, 'partial'],
      ['2026-12-16', 1, 'partial'],
      ['2026-12-17', 1, 'partial'],
      ['2026-12-18', null, 'missing'],
    ],
    'an overlapping-season winner keeps one leg per day and the quarantined day disappears'
  );
  assert.equal(december.current.flights, 3, 'December report totals count the resolved overlaps');

  const window = surfaces.operationalWindow;
  assert.deepEqual(
    window.flightRecords.map((row) => [row.identity, row.schedule, row.status]),
    [
      ['A|2026-10-25|JX|JX701', '10:00', 'active'],
      ['A|2026-10-25|JX|JX703', '18:00', 'active'],
      ['D|2026-10-25|VN|VN555', '09:00', 'active'],
      ['D|2026-10-26|VN|VN101', '06:30', 'active'],
      ['D|2026-10-26|VN|VN201', '12:00', 'active'],
    ],
    'the operational window pages the raw canonical rows for the requested range'
  );
  assert.deepEqual(
    window.modifications.map((row) => [row.target, row.action, row.schedule, row.pax]),
    [
      ['A|2026-10-25|JX|JX701', 'modified', null, 180],
      ['A|2026-10-25|JX|JX703', 'modified', '18:45', 0],
      ['D|2026-10-25|VN|VN555', 'added', null, null],
    ],
    'the window ships overlays separately, so clients merge them onto the raw rows'
  );
  assert.deepEqual(
    window.flightRecordCounters.map((row) => [row.leg, row.counter_value]),
    [['D|2026-10-26|VN|VN101', '30'], ['D|2026-10-26|VN|VN101', 'M1']],
    'check-in counters travel with the window payload'
  );
  assert.equal(window.page.returnedCount, 5, 'the window returns every leg in the requested range');
  assert.equal(window.page.hasMore, false, 'the window does not paginate past the last leg');

  const w26ExportRows = surfaces.seasonalExports.W26.flightRecords;
  assert.equal(surfaces.seasonalExports.W26.totalCount, 8, 'W26 export covers every active leg of the season');
  assert.equal(surfaces.seasonalExports.W26.sourceRowCount, 6, 'W26 export keeps the source row count');
  assert.equal(surfaces.seasonalExports.W26.truncated, false, 'W26 export is complete');
  assert.equal(surfaces.seasonalExports.M26.totalCount, 3, 'M26 export covers its three legs');
  assert.deepEqual(
    surfaces.seasonalExports.W26.modifications.map((row) => [row.target, row.action, row.changed_fields.join(',')]),
    [
      ['A|2026-10-25|JX|JX701', 'modified', 'pax,gate,stand,carousel'],
      ['A|2026-10-25|JX|JX703', 'modified', 'pax,schedule'],
      ['D|2026-10-25|VN|VN555', 'added', 'addedLeg'],
    ],
    'the export carries the overlay rows and their changed field lists'
  );
  assert.deepEqual(
    surfaces.seasonalExports.W26.flightRecordCounters.map((row) => [row.leg, row.counter_value]),
    [['D|2026-10-26|VN|VN101', '30'], ['D|2026-10-26|VN|VN101', 'M1']],
    'exported counters belong to the re-imported daily leg'
  );
  const exportedJx703 = w26ExportRows.find((row) => row.flight_number === 'JX703');
  assert.equal(exportedJx703.schedule, '18:00', 'the export reads canonical base rows, not merged overlays');
  assert.equal(exportedJx703.link_type, 'sameday', 'the arrival keeps the same-day turnaround link type');
  assert.equal(exportedJx703.pair_anchor_date, '2026-10-25', 'the pair anchor stays on the arrival date');
  assert.equal(
    w26ExportRows.filter((row) => row.type === 'D' && row.flight_number === 'JX703').length,
    0,
    'a same-flight-number turnaround survives as the arrival leg only'
  );
  assert.equal(
    w26ExportRows.filter((row) => row.flight_number === 'VN101').map((row) => row.schedule).join(),
    '06:30',
    'the export only exposes the surviving daily leg of the day'
  );

  // --- Baseline freeze -----------------------------------------------------
  const baseline = {
    milestone: 'M0',
    generated_by: 'supabase/tests/seasonal_operational_separation_m0_baseline_pglite.mjs',
    volatility: 'keys matching watermark|data_as_of|data_version|*_at|changed_by|server_seq|*high*water|requestId|batchId|previewHash|checksum are removed',
    fixture: { ...M0_FIXTURE },
    surfaces,
  };
  if (UPDATE_BASELINE) {
    await writeFile(BASELINE_URL, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log('M0 baseline rewritten:', BASELINE_URL.pathname);
  } else {
    const recorded = JSON.parse(await readFile(BASELINE_URL, 'utf8'));
    const differences = diffPaths(recorded.surfaces, surfaces);
    if (differences.length > 0) {
      console.error('M0 read surface drifted from the committed baseline:');
      for (const difference of differences) console.error(' -', difference);
      throw new assert.AssertionError({ message: `M0 baseline drift (${differences.length} differences)` });
    }
    console.log('M0 baseline matches.', JSON.stringify({
      effective_legs: surfaces.effectiveLegs.length,
      canonical_legs: surfaces.canonicalStore.length,
      quarantine: surfaces.quarantine.length,
      export_rows: {
        W26: surfaces.seasonalExports.W26.flightRecords.length,
        M26: surfaces.seasonalExports.M26.flightRecords.length,
      },
      window_rows: window.flightRecords.length,
    }));
  }
} finally {
  await fixture.close();
}
