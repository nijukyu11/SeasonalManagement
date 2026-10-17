import assert from 'node:assert/strict';
import test from 'node:test';
import type { SeasonalDraftRecord } from './seasonalPlanningContract.ts';
import {
  resolveAircraftAerodromeCode,
  resolveFlightSlotWeight,
  buildSlotOccupancyDataset,
  filterSlotDayIndices,
  computeSlotSelectionStats,
  computeSlotKpiCards,
  buildSlotFlightGroups,
  buildSlotStdTable30Min,
  buildSlotMonthWeekdayMatrix,
  DEFAULT_SLOT_OCCUPANCY_PARAMS,
} from './slotOccupancyAnalysis.ts';

function createMockDraft(overrides: Partial<SeasonalDraftRecord> = {}): SeasonalDraftRecord {
  return {
    draft_id: 'draft-1',
    season_id: 'season-w26',
    link_id: 'link-1',
    type: 'D',
    airline: 'VN',
    flight_number: '110',
    raw_flight_number: '110',
    date: '2026-10-26',
    schedule: '10:00',
    scheduled_date: '2026-10-26',
    scheduled_time: '10:00',
    operational_date: '2026-10-26',
    iata_season_code: 'W26',
    flight_series_id: 'series-1',
    day_of_week: 1,
    route: 'HAN',
    aircraft: 'A321',
    category: 'J',
    pax: 180,
    code_shares: null,
    int_dom_ind: 'D',
    stand: null,
    gate: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    check_in_start: null,
    check_in_end: null,
    check_in_allocation_mode: null,
    action: 'added',
    status: 'active',
    source_row_index: 1,
    linked_source_row_index: null,
    link_type: null,
    pair_anchor_date: null,
    linked_draft_id: null,
    turnaround_id: null,
    source_kind: 'manual',
    source_side: 'DEP',
    ...overrides,
  };
}

test('resolveAircraftAerodromeCode and resolveFlightSlotWeight classify Code C vs Code D/E/F accurately', () => {
  assert.equal(resolveAircraftAerodromeCode('A321'), '');
  assert.equal(resolveAircraftAerodromeCode('B738'), '');
  assert.equal(resolveAircraftAerodromeCode('B763'), 'D');
  assert.equal(resolveAircraftAerodromeCode('A359'), 'E');
  assert.equal(resolveAircraftAerodromeCode('789'), 'E');
  assert.equal(resolveAircraftAerodromeCode('A388'), 'F');

  assert.equal(resolveFlightSlotWeight('A321', 'aircraft_code'), 1);
  assert.equal(resolveFlightSlotWeight('A359', 'aircraft_code'), 2);
  assert.equal(resolveFlightSlotWeight('A359', 'uniform'), 1);
});

test('buildSlotOccupancyDataset computes 2-slot widebody weight, feas/dem matrices, and cross-day spillover at 05:00 boundary', () => {
  const flights: SeasonalDraftRecord[] = [
    // Day 1 (2026-10-26, Mon):
    // 6 widebody flights (A359, 2 slots each = 12 slots) at 10:00 -> occupies [07:00, 09:10)
    ...Array.from({ length: 6 }, (_, i) =>
      createMockDraft({
        draft_id: `wb-${i}`,
        flight_number: `30${i}`,
        date: '2026-10-26',
        scheduled_date: '2026-10-26',
        operational_date: '2026-10-26',
        schedule: '10:00',
        scheduled_time: '10:00',
        aircraft: 'A359',
      })
    ),
    // 1 narrowbody flight (A321, 1 slot) at 10:00 -> total demand in [07:00, 09:10) = 13 slots (reaches threshold=13)
    createMockDraft({
      draft_id: 'nb-1',
      flight_number: '110',
      date: '2026-10-26',
      scheduled_date: '2026-10-26',
      operational_date: '2026-10-26',
      schedule: '10:00',
      scheduled_time: '10:00',
      aircraft: 'A321',
    }),
    // Day 2 (2026-10-27, Tue): early morning departure at 06:00 on OpsDate 2026-10-27
    // Its window is [03:00, 05:10) on 2026-10-27, which spills into Day 1's ops window (03:00..05:00 on 2026-10-27 belongs to OpsDate 2026-10-26)
    createMockDraft({
      draft_id: 'spill-next-day',
      airline: 'KE',
      flight_number: '462',
      date: '2026-10-27',
      scheduled_date: '2026-10-27',
      operational_date: '2026-10-27',
      schedule: '06:00',
      scheduled_time: '06:00',
      aircraft: 'B789', // 2 slots
    }),
  ];

  const dataset = buildSlotOccupancyDataset(flights, DEFAULT_SLOT_OCCUPANCY_PARAMS);
  assert.deepEqual(dataset.days, ['2026-10-26', '2026-10-27']);
  assert.deepEqual(dataset.twoSlotAircraftTypes, ['A359', 'B789']);
  assert.deepEqual(dataset.oneSlotAircraftTypes, ['A321']);

  // On Day 1 (index 0), candidate STD 10:00 corresponds to offset (10*60 - 300)/5 = 60
  const k1000 = (600 - 300) / 5;
  assert.equal(dataset.feas[0][k1000], 13);

  // At 10:00 on Day 1, feas == 13 (threshold): neither Code C (needs <13) nor Code D/E (needs <12) can be accepted on Day 1
  const day1Stats = computeSlotSelectionStats(dataset, [0]);
  assert.equal(day1Stats.pctC[k1000], 0);
  assert.equal(day1Stats.pctDE[k1000], 0);

  // If switched to uniform mode (1 flight = 1 slot), demand at 10:00 is only 7 slots (< 12), so both C and D/E are accepted!
  const uniformDataset = buildSlotOccupancyDataset(flights, {
    ...DEFAULT_SLOT_OCCUPANCY_PARAMS,
    slotWeightMode: 'uniform',
  });
  assert.equal(uniformDataset.feas[0][k1000], 7);
  const uniformDay1Stats = computeSlotSelectionStats(uniformDataset, [0]);
  assert.equal(uniformDay1Stats.pctC[k1000], 100);
  assert.equal(uniformDay1Stats.pctDE[k1000], 100);

  // Check cross-day spillover: KE462 at 06:00 on 2026-10-27 occupies [03:00, 05:10) on calendar 2026-10-27.
  // Clock 04:00 on 2026-10-27 is 23h after 2026-10-26 05:00 -> offset 23*60 = 1380 min -> k = 1380/5 = 276 on Day 1 (index 0)
  const k0400NextMorning = (23 * 60) / 5;
  assert.equal(dataset.dem[0][k0400NextMorning], 2);

  // Check buildSlotFlightGroups with ext=false vs ext=true for Day 1 (index 0):
  const ganttDay1 = buildSlotFlightGroups(dataset, [0], false);
  const tableGroupsDay1 = buildSlotFlightGroups(dataset, [0], true);
  assert.equal(
    ganttDay1.some((f) => f.name === 'KE462'),
    false,
    'Gantt (ext=false) only lists flights whose own OpsDate is in idx'
  );
  assert.equal(
    tableGroupsDay1.some((f) => f.name === 'KE462'),
    true,
    '30-min table (ext=true) includes next-day early morning flights whose slot window spills into Day 1'
  );
});

test('filterSlotDayIndices, computeSlotKpiCards, buildSlotStdTable30Min, and buildSlotMonthWeekdayMatrix match template.html aggregation rules', () => {
  const flights: SeasonalDraftRecord[] = [
    createMockDraft({
      draft_id: 'f-oct-mon',
      flight_number: '201',
      date: '2026-10-26',
      scheduled_date: '2026-10-26', // Monday, Oct 2026
      operational_date: '2026-10-26',
      schedule: '14:10',
      scheduled_time: '14:10',
      aircraft: 'A359',
    }),
    createMockDraft({
      draft_id: 'f-nov-sun',
      flight_number: '202',
      date: '2026-11-01',
      scheduled_date: '2026-11-01', // Sunday, Nov 2026
      operational_date: '2026-11-01',
      schedule: '14:10',
      scheduled_time: '14:10',
      aircraft: 'A321',
    }),
  ];
  const dataset = buildSlotOccupancyDataset(flights, DEFAULT_SLOT_OCCUPANCY_PARAMS);
  assert.deepEqual(dataset.months, [202610, 202611]);

  const octIndices = filterSlotDayIndices(dataset, 202610, null);
  assert.equal(octIndices.length, 6); // 2026-10-26 .. 2026-10-31

  const monOctIndices = filterSlotDayIndices(dataset, 202610, 0);
  assert.equal(monOctIndices.length, 1);
  assert.equal(dataset.days[monOctIndices[0]], '2026-10-26');

  const allIndices = filterSlotDayIndices(dataset, null, null);
  const allStats = computeSlotSelectionStats(dataset, allIndices);
  const kpis = computeSlotKpiCards(dataset, allIndices, allStats);
  assert.equal(kpis.daysCount, 7); // 2026-10-26 .. 2026-11-01
  assert.equal(kpis.pct15MinCodeC, 100);
  assert.equal(kpis.pct15MinCodeDE, 100);

  const table30 = buildSlotStdTable30Min(dataset, monOctIndices, computeSlotSelectionStats(dataset, monOctIndices));
  assert.equal(table30.length, 48);
  const row1400 = table30.find((r) => r.rangeLabel === '14:00 – 14:25');
  assert.ok(row1400);
  assert.match(row1400.overlappingFlightsText, /VN201 14:10 ×2 \(1\/1\)/);

  const matrix = buildSlotMonthWeekdayMatrix(dataset);
  assert.equal(matrix.get('202610|0'), 1);
  assert.equal(matrix.get('null|null'), 1);
});
