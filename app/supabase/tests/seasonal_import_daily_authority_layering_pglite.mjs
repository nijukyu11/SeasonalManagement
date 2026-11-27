// Seasonal Repair/Replace over Ops Dates already owned by a Daily import.
//
// Commit keeps Seasonal occurrences on Daily-owned Ops Dates inactive, so the
// stage must not block them as daily-occurrence-collision; those rows must take
// the bottom place of the Daily reset chain so a later reset restores the new
// file instead of the replaced one. A collision commit would activate (an
// early-morning leg whose Ops Date has no Daily authority) still blocks.
import assert from 'node:assert/strict';
import {
  M0_FIXTURE,
  commitDailyImport,
  openM0FixtureDb,
  seasonalRow,
  seasonalStagePayload,
  seedM0OperatorsAndSeasons,
  stageAndCommitSeasonalImport,
  stageDailyImport,
} from './seasonal_operational_separation_fixture.mjs';

const seasonId = M0_FIXTURE.seasonW26;
const ctx = await openM0FixtureDb();
const { db, asWriter, asAdmin } = ctx;

const version = async () =>
  (await db.query('select data_version from public.seasons where id=$1', [seasonId])).rows[0].data_version;

const seasonalImport = async (requestId, strategy, sourceRows) => {
  const expectedDataVersion = await version();
  return stageAndCommitSeasonalImport(ctx, seasonalStagePayload({
    requestId, strategy, expectedDataVersion, seasonId, seasonCode: 'W26', sourceRows,
  }));
};

const dailyImport = async (requestId, legs) => {
  const dates = [...new Set(legs.map((leg) => leg.date))].sort();
  const expectedDataVersion = await version();
  const stage = await stageDailyImport(ctx, {
    contractVersion: 1, requestId, fileName: `daily-${requestId.slice(-2)}.xlsx`, workbookProfile: 'compact-lb',
    rawChecksum: `raw-${requestId}`, canonicalChecksum: `canonical-${requestId}`, resourcePolicyHash: 'policy-v1',
    legs: legs.map((leg, index) => ({
      sourceRowNumber: index + 1, sheetName: 'Daily', side: 'DEP', seasonCode: 'W26', operationalDate: leg.date,
      scheduledDate: leg.date, scheduledTime: leg.time, airline: 'VN', flightNumber: `VN${leg.flight}`,
      rawFlightNumber: leg.flight, route: 'SGN', aircraft: '321', category: 'J', flightType: 'PAX',
      requestStatusCode: null, resources: { route: 'SGN', schedule: leg.time, pax: 100 }, rawResourceTokens: {},
      occurrenceKey: `W26|${leg.date}|DEP|VN|VN${leg.flight}|SGN|${leg.time}`,
      looseOccurrenceKey: `W26|${leg.date}|DEP|VN|VN${leg.flight}`,
    })),
    diagnostics: [],
    seasons: [{
      seasonId, seasonCode: 'W26', expectedDataVersion, rangeStart: dates[0], rangeEnd: dates.at(-1),
      affectedDates: dates, legCount: legs.length,
    }],
  });
  assert.equal(stage.status, 'validated', JSON.stringify(stage));
  const commit = await commitDailyImport(ctx, stage, expectedDataVersion);
  assert.equal(commit.status, 'committed', JSON.stringify(commit));
  return stage.batchId;
};

const rowsOf = async (batchId) => (await db.query(
  `select date, flight_number, status, deletion_reason, superseded_by_batch_id
   from public.season_flight_records where season_id=$1 and source_import_batch_id=$2
   order by date, flight_number`,
  [seasonId, batchId],
)).rows;

const activeOn = async (date) => (await db.query(
  `select flight_number, source_kind, aircraft
   from public.canonical_active_flight_records_v1 where season_id=$1 and date=$2
   order by flight_number`,
  [seasonId, date],
)).rows;

const dep = (rowIndex, flight, std, extra = {}) =>
  seasonalRow({ rowIndex, effective: '2026-10-25', discontinue: '2026-10-27', airline: 'VN',
    arrFlightType: null, arrFlightCategory: null, arrIntDomInd: null,
    depFlight: flight, depRoute: 'SGN', std, depFlightType: 'PAX', depFlightCategory: 'J', depIntDomInd: 'D', ...extra });
const arr = (rowIndex, flight, sta, extra = {}) =>
  seasonalRow({ rowIndex, effective: '2026-10-25', discontinue: '2026-10-27', airline: 'VN',
    arrFlight: flight, arrRoute: 'TPE', sta, ...extra });

try {
  await seedM0OperatorsAndSeasons(ctx);

  const original = await seasonalImport('10000000-0000-4000-8000-0000000000c1', 'replace', [
    dep(1, '101', '06:00'), arr(2, '701', '10:00'), arr(3, '901', '12:00'),
  ]);
  assert.equal(original.commit?.status, 'committed', JSON.stringify(original.stage));

  // 10-26 gets two Daily layers (A then B), 10-27 only A.
  const dailyA = await dailyImport('20000000-0000-4000-8000-0000000000c1', [
    { date: '2026-10-26', flight: '101', time: '06:00' },
    { date: '2026-10-26', flight: '777', time: '20:00' },
    { date: '2026-10-27', flight: '101', time: '06:00' },
  ]);
  await dailyImport('20000000-0000-4000-8000-0000000000c2', [
    { date: '2026-10-26', flight: '101', time: '06:30' },
    { date: '2026-10-26', flight: '777', time: '20:00' },
  ]);

  // VN777 03:00 on 10-26 belongs to Ops Date 10-25, which has no Daily
  // authority: commit would activate it next to the Daily VN777, so it blocks.
  await asWriter();
  const earlyProbe = (await db.query('select public.stage_seasonal_import_v3($1::jsonb) as result', [JSON.stringify(
    seasonalStagePayload({
      requestId: '10000000-0000-4000-8000-0000000000c2', strategy: 'replace', expectedDataVersion: await version(),
      seasonId, seasonCode: 'W26',
      sourceRows: [arr(1, '777', '03:00', { effective: '2026-10-26', discontinue: '2026-10-26' })],
    }),
  )])).rows[0].result;
  await asAdmin();
  assert.equal(earlyProbe.status, 'failed');
  assert.deepEqual(earlyProbe.diagnostics.map((item) => item.code), ['daily-occurrence-collision']);

  const repair = await seasonalImport('10000000-0000-4000-8000-0000000000c3', 'replace', [
    dep(1, '101', '06:00', { aircraft: '333' }), arr(2, '701', '10:00'), arr(4, '555', '11:00'),
  ]);
  assert.equal(repair.stage.status, 'validated', JSON.stringify(repair.stage.diagnostics));
  assert.ok(!repair.stage.diagnostics.some((item) => item.code === 'daily-occurrence-collision'));
  assert.equal(repair.commit?.status, 'committed');

  assert.deepEqual((await db.query(
    `select date, flight_number from public.canonical_active_flight_records_v1 where season_id=$1
     group by date, flight_number having count(*) > 1`, [seasonId],
  )).rows, [], 'Repair must not create a second active leg for a flight/day');

  const repairRows = await rowsOf(repair.stage.batchId);
  const layerOf = (date) => repairRows.filter((row) => row.date === date)
    .map(({ status, deletion_reason, superseded_by_batch_id }) => ({ status, deletion_reason, superseded_by_batch_id }));
  const bottom = { status: 'deleted', deletion_reason: 'daily_replacement', superseded_by_batch_id: dailyA };
  assert.deepEqual(layerOf('2026-10-25').map((row) => row.status), ['active', 'active', 'active']);
  assert.deepEqual(layerOf('2026-10-26'), [bottom, bottom, bottom], 'two-layer day: new Seasonal sits under the oldest Daily batch');
  assert.deepEqual(layerOf('2026-10-27'), [bottom, bottom, bottom]);
  assert.deepEqual(
    [...new Set((await rowsOf(original.stage.batchId)).map((row) => `${row.status}/${row.deletion_reason}`))],
    ['deleted/seasonal_rebuild'],
    'the replaced generation must leave the reset chain',
  );
  assert.deepEqual((await activeOn('2026-10-26')).map((row) => [row.flight_number, row.source_kind]),
    [['VN101', 'daily'], ['VN777', 'daily']]);

  // Reset of the single-layer day restores the Repair file, not the old one.
  const resetVersion = await version();
  await asWriter();
  const preview = (await db.query(
    `select public.preview_daily_authority_reset_v1($1,array['2026-10-27']::date[],$2) as result`,
    [seasonId, resetVersion],
  )).rows[0].result;
  assert.equal(preview.preimageCount, 3);
  await db.query(
    `select public.reset_daily_authority_v1($1,$2,array['2026-10-27']::date[],$3,$4,'Layering regression probe')`,
    ['40000000-0000-4000-8000-0000000000c1', seasonId, resetVersion, preview.confirmationText],
  );
  await asAdmin();
  assert.deepEqual(await activeOn('2026-10-27'), [
    { flight_number: 'VN101', source_kind: 'seasonal', aircraft: '333' },
    { flight_number: 'VN555', source_kind: 'seasonal', aircraft: '321' },
    { flight_number: 'VN701', source_kind: 'seasonal', aircraft: '321' },
  ]);

  // Merge replaces only the matching bottom-layer occurrence.
  const merge = await seasonalImport('10000000-0000-4000-8000-0000000000c4', 'merge', [
    arr(1, '555', '11:30', { effective: '2026-10-26', discontinue: '2026-10-26' }),
  ]);
  assert.equal(merge.commit?.status, 'committed', JSON.stringify(merge.stage.diagnostics));
  assert.deepEqual(await rowsOf(merge.stage.batchId), [
    { date: '2026-10-26', flight_number: 'VN555', ...bottom },
  ]);
  assert.deepEqual(
    (await rowsOf(repair.stage.batchId)).filter((row) => row.date === '2026-10-26')
      .map((row) => [row.flight_number, row.deletion_reason]),
    [['VN101', 'daily_replacement'], ['VN555', 'seasonal_rebuild'], ['VN701', 'daily_replacement']],
  );

  console.log(JSON.stringify({ suite: 'seasonal-import-daily-authority-layering', status: 'passed' }));
} finally {
  await db.close();
}
