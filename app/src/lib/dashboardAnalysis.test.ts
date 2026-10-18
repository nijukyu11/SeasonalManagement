import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDashboardComparison,
  formatPct,
  formatPointPct,
  getDashboardOperationalDate,
} from './dashboardAnalysis.ts';
import {
  buildDashboardReportRows,
  buildSanLuongSummaryWorkbook,
} from './dashboardReportExport.ts';
import type { FlightRecord } from './types.ts';

function createFlightRecord(
  overrides: Partial<FlightRecord> & Pick<FlightRecord, 'id' | 'type' | 'date' | 'schedule'>
): FlightRecord {
  return {
    linkId: overrides.id,
    airline: 'VJ',
    flightNumber: overrides.id,
    rawFlightNumber: overrides.id,
    requestStatusCode: null,
    route: 'HAN',
    aircraft: '321',
    category: 'PAX',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: null,
    pax: 100,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    scheduledDate: overrides.date,
    scheduledTime: overrides.schedule,
    dayOfWeek: new Date(`${overrides.date}T00:00:00Z`).getUTCDay(),
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'imported',
    sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
    status: 'active',
    ...overrides,
  };
}

test('formatPct and formatPointPct multiply ratio 0..1 by 100 and format correctly', () => {
  assert.equal(formatPct(0.15), '+15.0%');
  assert.equal(formatPct(-0.15), '-15.0%');
  assert.equal(formatPct(0), '0.0%');
  assert.equal(formatPct(null), '-');
  assert.equal(formatPct(undefined), '-');
  assert.equal(formatPct(Number.NaN), '-');
  assert.equal(formatPct(Number.POSITIVE_INFINITY), '-');
  assert.equal(formatPct(Number.NEGATIVE_INFINITY), '-');

  // showSign option
  assert.equal(formatPct(0.333, { showSign: false }), '33.3%');
  assert.equal(formatPct(1, { showSign: false }), '100.0%');

  // formatPointPct
  assert.equal(formatPointPct(0.05), '+5.00 pts');
  assert.equal(formatPointPct(-0.05), '-5.00 pts');
  assert.equal(formatPointPct(0), '0.00 pts');
  assert.equal(formatPointPct(null), '-');
  assert.equal(formatPointPct(undefined), '-');
  assert.equal(formatPointPct(Number.NaN), '-');
});

test('pax fixture prev 10x100, current 10 records with 5 pax=null: comparison is NOT -50% and missing count = 5', () => {
  const prevRecords = Array.from({ length: 10 }, (_, i) =>
    createFlightRecord({
      id: `FL-${i + 1}`,
      flightNumber: `VJ${i + 1}`,
      type: 'A',
      date: '2026-05-15',
      schedule: '10:00',
      pax: 100,
    })
  );

  const currentRecords = Array.from({ length: 10 }, (_, i) =>
    createFlightRecord({
      id: `FL-${i + 1}`,
      flightNumber: `VJ${i + 1}`,
      type: 'A',
      date: '2026-06-15',
      schedule: '10:00',
      pax: i < 5 ? 100 : null,
    })
  );

  const allRecords = [...prevRecords, ...currentRecords];

  const paxComparison = buildDashboardComparison({
    records: allRecords,
    mode: 'mom',
    metric: 'pax',
    currentPeriod: '2026-06',
    previousPeriod: '2026-05',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });

  assert.equal(paxComparison.current.missingPaxCount, 5, 'Current period missing count must be 5');
  assert.equal(paxComparison.previous.missingPaxCount, 0, 'Previous period missing count must be 0');
  assert.notEqual(paxComparison.deltaPct, -0.5, 'Pax comparison deltaPct must NOT be -50%');

  // Flights metric comparison should remain unchanged (10 vs 10)
  const flightsComparison = buildDashboardComparison({
    records: allRecords,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-06',
    previousPeriod: '2026-05',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });

  assert.equal(flightsComparison.current.total, 10);
  assert.equal(flightsComparison.previous.total, 10);
  assert.equal(flightsComparison.delta, 0);
  assert.equal(flightsComparison.deltaPct, 0);
});

test('detect incomplete periods: distinct operational days mismatch exposes counts and day average delta', () => {
  // Period A: 3 distinct days
  const currentRecords = [
    createFlightRecord({ id: 'c1', type: 'A', date: '2026-06-01', schedule: '10:00' }),
    createFlightRecord({ id: 'c2', type: 'A', date: '2026-06-02', schedule: '10:00' }),
    createFlightRecord({ id: 'c3', type: 'A', date: '2026-06-03', schedule: '10:00' }),
  ];

  // Period B: 5 distinct days
  const previousRecords = [
    createFlightRecord({ id: 'p1', type: 'A', date: '2026-05-01', schedule: '10:00' }),
    createFlightRecord({ id: 'p2', type: 'A', date: '2026-05-02', schedule: '10:00' }),
    createFlightRecord({ id: 'p3', type: 'A', date: '2026-05-03', schedule: '10:00' }),
    createFlightRecord({ id: 'p4', type: 'A', date: '2026-05-04', schedule: '10:00' }),
    createFlightRecord({ id: 'p5', type: 'A', date: '2026-05-05', schedule: '10:00' }),
  ];

  const comparison = buildDashboardComparison({
    records: [...currentRecords, ...previousRecords],
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-06',
    previousPeriod: '2026-05',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });

  assert.equal(comparison.current.distinctDays, 3);
  assert.equal(comparison.previous.distinctDays, 5);
  assert.notEqual(comparison.current.distinctDays, comparison.previous.distinctDays);

  // Daily average: current = 3/3 = 1 flight/day, previous = 5/5 = 1 flight/day -> delta = 0
  assert.equal(comparison.dayAverageDelta, 0);
});

test('Excel SanLuong row for date=2026-05-01 schedule 02:30 yields Ops Date in April (2026-04-30)', () => {
  const earlyRecord = createFlightRecord({
    id: 'early-1',
    type: 'A',
    date: '2026-05-01',
    schedule: '02:30',
  });

  const opsDate = getDashboardOperationalDate(earlyRecord);
  assert.equal(opsDate, '2026-04-30', 'Operational date must be shifted to 2026-04-30');

  const rows = buildDashboardReportRows({
    records: [earlyRecord],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Ops Date'], '2026-04-30 00:00:00');
  assert.equal(rows[0].DayIndex, 30);
  assert.equal(rows[0].IsoWeek, '2026-W18');

  // Verify month grouping in SanLuong workbook groups it under Apr 2026
  const workbook = buildSanLuongSummaryWorkbook({
    records: [earlyRecord],
  });
  const monthSheet = workbook.Sheets['Month'];
  assert.ok(monthSheet, 'Workbook must contain Month summary sheet');
  // Check that cell A2 is "Apr 2026"
  assert.equal(monthSheet['A2']?.v, 'Apr 2026');
});
