import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperationalDashboard,
  buildOperationalTimeline,
  buildPeakDayHeatmap,
  buildPeakHourHeatmap,
  computePaxCoverage,
} from './operationalDashboardAnalysis.ts';
import { DEFAULT_DASHBOARD_ALERT_SETTINGS, validateOperationalSettings } from './settingsRules.ts';
import type { DashboardAlertSettings, FlightRecord } from './types.ts';

function record(overrides: Partial<FlightRecord> & Pick<FlightRecord, 'id' | 'type' | 'date' | 'schedule'>): FlightRecord {
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

function emptyAlerts(patch: Partial<DashboardAlertSettings> = {}): DashboardAlertSettings {
  return { ...DEFAULT_DASHBOARD_ALERT_SETTINGS, ...patch };
}

test('operational timeline uses 05:00 day start and assigns early morning to previous ops date', () => {
  const records = [
    record({ id: 'arr-0500', type: 'A', date: '2026-06-03', schedule: '05:00' }),
    record({ id: 'arr-0430', type: 'A', date: '2026-06-04', schedule: '04:30' }),
  ];

  const timeline = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });
  const nextDayTimeline = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-04',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });

  assert.equal(timeline.totals.flights, 2);
  assert.equal(timeline.buckets[0].label, '05:00');
  assert.equal(timeline.buckets[0].flights, 1);
  assert.equal(timeline.buckets.at(-1)?.label, '04:00');
  assert.equal(timeline.buckets.at(-1)?.flights, 1);
  assert.equal(nextDayTimeline.totals.flights, 0);
});

test('operational dashboard keeps ARR and DEP timelines separated', () => {
  const dashboard = buildOperationalDashboard({
    records: [
      record({ id: 'arr-1', type: 'A', date: '2026-06-03', schedule: '08:00' }),
      record({ id: 'arr-2', type: 'A', date: '2026-06-03', schedule: '09:00' }),
      record({ id: 'dep-1', type: 'D', date: '2026-06-03', schedule: '10:00' }),
    ],
    operationalDate: '2026-06-03',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    settings: emptyAlerts(),
    nowLocal: new Date('2026-06-03T12:00:00+07:00'),
  });

  assert.equal(dashboard.arrivals.totals.flights, 2);
  assert.equal(dashboard.departures.totals.flights, 1);
  assert.equal(dashboard.kpis.arrivalFlights, 2);
  assert.equal(dashboard.kpis.departureFlights, 1);
});

test('UTC basis shifts labels but keeps the same operational date and bucket counts', () => {
  const records = [
    record({ id: 'arr-0530', type: 'A', date: '2026-06-03', schedule: '05:30' }),
  ];
  const local = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });
  const utc = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'utc',
  });

  assert.equal(local.operationalDate, '2026-06-03');
  assert.equal(utc.operationalDate, '2026-06-03');
  assert.equal(local.buckets[0].label, '05:00');
  assert.equal(utc.buckets[0].label, '22:00');
  assert.equal(local.buckets[0].flights, utc.buckets[0].flights);
  assert.equal(local.totals.flights, utc.totals.flights);
});

test('30-minute timeline includes 04:59 next-calendar-day boundary and shifts UTC labels', () => {
  const records = [
    record({ id: 'arr-0500', type: 'A', date: '2026-06-03', schedule: '05:00' }),
    record({ id: 'arr-0459', type: 'A', date: '2026-06-04', schedule: '04:59' }),
    record({ id: 'dep-0530', type: 'D', date: '2026-06-03', schedule: '05:30' }),
    record({ id: 'dep-0459', type: 'D', date: '2026-06-04', schedule: '04:59' }),
  ];

  const arrivalsLocal = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'A',
    bucketSizeMinutes: 30,
    timeBasis: 'local',
  });
  const departuresUtc = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'D',
    bucketSizeMinutes: 30,
    timeBasis: 'utc',
  });

  assert.equal(arrivalsLocal.buckets.length, 48);
  assert.equal(arrivalsLocal.buckets[0].label, '05:00');
  assert.equal(arrivalsLocal.buckets[0].flights, 1);
  assert.equal(arrivalsLocal.buckets.at(-1)?.label, '04:30');
  assert.equal(arrivalsLocal.buckets.at(-1)?.flights, 1);
  assert.equal(arrivalsLocal.totals.flights, 2);

  assert.equal(departuresUtc.buckets.length, 48);
  assert.equal(departuresUtc.buckets[0].label, '22:00');
  assert.equal(departuresUtc.buckets[1].label, '22:30');
  assert.equal(departuresUtc.buckets[1].flights, 1);
  assert.equal(departuresUtc.buckets.at(-1)?.label, '21:30');
  assert.equal(departuresUtc.buckets.at(-1)?.flights, 1);
  assert.equal(departuresUtc.totals.flights, 2);
});

test('baseline averages same weekday in same month and excludes selected date', () => {
  const records = [
    ...Array.from({ length: 4 }, (_, index) => record({ id: `selected-${index}`, type: 'A', date: '2026-06-03', schedule: '06:00' })),
    ...Array.from({ length: 2 }, (_, index) => record({ id: `baseline-10-${index}`, type: 'A', date: '2026-06-10', schedule: '06:00' })),
    ...Array.from({ length: 4 }, (_, index) => record({ id: `baseline-17-${index}`, type: 'A', date: '2026-06-17', schedule: '06:00' })),
    ...Array.from({ length: 20 }, (_, index) => record({ id: `selected-noise-${index}`, type: 'A', date: '2026-06-03', schedule: '07:00' })),
  ];

  const timeline = buildOperationalTimeline({
    records,
    operationalDate: '2026-06-03',
    type: 'A',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
  });
  const sixAm = timeline.buckets.find((bucket) => bucket.label === '06:00');

  assert.equal(sixAm?.flights, 4);
  assert.equal(sixAm?.baselineSampleSize, 2);
  assert.equal(sixAm?.baselineFlights, 3);
  assert.equal(sixAm?.deltaFlights, 1);
});

test('pax coverage treats positive Pax as available, old zero/null as missing, and future zero as planned', () => {
  const coverage = computePaxCoverage([
    record({ id: 'available', type: 'A', date: '2026-06-01', schedule: '09:00', pax: 5 }),
    record({ id: 'old-zero', type: 'A', date: '2026-06-01', schedule: '10:00', pax: 0 }),
    record({ id: 'old-null', type: 'A', date: '2026-06-01', schedule: '11:00', pax: null }),
    record({ id: 'future-zero', type: 'A', date: '2026-06-04', schedule: '10:00', pax: 0 }),
  ], new Date('2026-06-03T12:00:00+07:00'));

  assert.equal(coverage.available, 1);
  assert.equal(coverage.missingAfterOneDay, 2);
  assert.equal(coverage.plannedZero, 1);
  assert.equal(coverage.coveragePct, 1 / 3);
});

test('peak day heatmap builds wide-range cells with totals, pax, and threshold alert kinds', () => {
  const records = [
    record({ id: 'jun03-arr-1', type: 'A', date: '2026-06-03', schedule: '06:00', pax: 10 }),
    record({ id: 'jun03-arr-2', type: 'A', date: '2026-06-03', schedule: '06:30', pax: 20 }),
    record({ id: 'jun03-dep-1', type: 'D', date: '2026-06-03', schedule: '07:00', pax: null }),
    record({ id: 'jun04-arr-1', type: 'A', date: '2026-06-04', schedule: '04:59', pax: 30 }),
    record({ id: 'jun04-dep-1', type: 'D', date: '2026-06-04', schedule: '08:00', pax: 40 }),
  ];

  const heatmap = buildPeakDayHeatmap({
    records,
    dateFrom: '2026-06-03',
    dateTo: '2026-06-04',
    settings: emptyAlerts({
      adGapFlights: 1,
      paxCoverageMinPct: 0.9,
    }),
    nowLocal: new Date('2026-06-05T12:00:00+07:00'),
  });

  assert.deepEqual(heatmap.map((cell) => cell.operationalDate), ['2026-06-03', '2026-06-04']);
  assert.deepEqual(
    heatmap.map((cell) => ({
      date: cell.operationalDate,
      month: cell.month,
      weekday: cell.weekday,
      arrivals: cell.arrivals,
      departures: cell.departures,
      totalFlights: cell.totalFlights,
      pax: cell.pax,
      paxMissingAfterOneDay: cell.paxMissingAfterOneDay,
      alerts: cell.alerts,
    })),
    [
      {
        date: '2026-06-03',
        month: '2026-06',
        weekday: 3,
        arrivals: 3,
        departures: 1,
        totalFlights: 4,
        pax: 60,
        paxMissingAfterOneDay: 1,
        alerts: ['adGapFlights', 'paxCoverageMinPct'],
      },
      {
        date: '2026-06-04',
        month: '2026-06',
        weekday: 4,
        arrivals: 0,
        departures: 1,
        totalFlights: 1,
        pax: 40,
        paxMissingAfterOneDay: 0,
        alerts: ['adGapFlights'],
      },
    ]
  );
});

test('peak hour heatmap builds wide-range bucket cells with ARR DEP totals pax and A-D gap', () => {
  const records = [
    record({ id: 'jun03-arr-1', type: 'A', date: '2026-06-03', schedule: '05:10', pax: 10 }),
    record({ id: 'jun03-arr-2', type: 'A', date: '2026-06-03', schedule: '05:20', pax: 20 }),
    record({ id: 'jun03-dep-1', type: 'D', date: '2026-06-03', schedule: '05:40', pax: 30 }),
    record({ id: 'jun04-boundary-arr', type: 'A', date: '2026-06-04', schedule: '04:59', pax: 40 }),
    record({ id: 'jun04-dep-1', type: 'D', date: '2026-06-04', schedule: '08:00', pax: 50 }),
  ];

  const heatmap = buildPeakHourHeatmap({
    records,
    bucketSizeMinutes: 30,
    timeBasis: 'utc',
    dateFrom: '2026-06-03',
    dateTo: '2026-06-04',
  });
  const jun03Bucket0 = heatmap.cells.find((cell) => cell.operationalDate === '2026-06-03' && cell.bucketIndex === 0);
  const jun03Bucket1 = heatmap.cells.find((cell) => cell.operationalDate === '2026-06-03' && cell.bucketIndex === 1);
  const jun03LastBucket = heatmap.cells.find((cell) => cell.operationalDate === '2026-06-03' && cell.bucketIndex === 47);
  const jun04SixthBucket = heatmap.cells.find((cell) => cell.operationalDate === '2026-06-04' && cell.bucketIndex === 6);

  assert.deepEqual(heatmap.dates, ['2026-06-03', '2026-06-04']);
  assert.equal(heatmap.buckets.length, 48);
  assert.deepEqual(heatmap.buckets.slice(0, 2), [
    { index: 0, label: '22:00' },
    { index: 1, label: '22:30' },
  ]);
  assert.equal(heatmap.buckets.at(-1)?.label, '21:30');
  assert.equal(heatmap.cells.length, 96);
  assert.deepEqual(jun03Bucket0, {
    operationalDate: '2026-06-03',
    bucketIndex: 0,
    bucketLabel: '22:00',
    arrivals: 2,
    departures: 0,
    totalFlights: 2,
    pax: 30,
    adGapFlights: 2,
  });
  assert.deepEqual(jun03Bucket1, {
    operationalDate: '2026-06-03',
    bucketIndex: 1,
    bucketLabel: '22:30',
    arrivals: 0,
    departures: 1,
    totalFlights: 1,
    pax: 30,
    adGapFlights: 1,
  });
  assert.deepEqual(jun03LastBucket, {
    operationalDate: '2026-06-03',
    bucketIndex: 47,
    bucketLabel: '21:30',
    arrivals: 1,
    departures: 0,
    totalFlights: 1,
    pax: 40,
    adGapFlights: 1,
  });
  assert.deepEqual(jun04SixthBucket, {
    operationalDate: '2026-06-04',
    bucketIndex: 6,
    bucketLabel: '01:00',
    arrivals: 0,
    departures: 1,
    totalFlights: 1,
    pax: 50,
    adGapFlights: 1,
  });
});

test('peak hour heatmap filters arrivals and departures before aggregating cells', () => {
  const records = [
    record({ id: 'arr-1', type: 'A', date: '2026-06-03', schedule: '05:10', pax: 10 }),
    record({ id: 'arr-2', type: 'A', date: '2026-06-03', schedule: '05:20', pax: 20 }),
    record({ id: 'dep-1', type: 'D', date: '2026-06-03', schedule: '05:40', pax: 30 }),
  ];

  const arrivalsOnly = buildPeakHourHeatmap({
    records,
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    typeFilter: 'A',
    dateFrom: '2026-06-03',
    dateTo: '2026-06-03',
  });
  const departuresOnly = buildPeakHourHeatmap({
    records,
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    typeFilter: 'D',
    dateFrom: '2026-06-03',
    dateTo: '2026-06-03',
  });

  const arrivalsBucket = arrivalsOnly.cells.find((cell) => cell.operationalDate === '2026-06-03' && cell.bucketIndex === 0);
  const departuresBucket = departuresOnly.cells.find((cell) => cell.operationalDate === '2026-06-03' && cell.bucketIndex === 0);

  assert.equal(arrivalsBucket?.totalFlights, 2);
  assert.equal(arrivalsBucket?.arrivals, 2);
  assert.equal(arrivalsBucket?.departures, 0);
  assert.equal(departuresBucket?.totalFlights, 1);
  assert.equal(departuresBucket?.arrivals, 0);
  assert.equal(departuresBucket?.departures, 1);
});

test('settings thresholds produce alerts only when configured', () => {
  const records = [
    record({ id: 'arr-1', type: 'A', date: '2026-06-03', schedule: '06:00', pax: null }),
    record({ id: 'arr-2', type: 'A', date: '2026-06-03', schedule: '06:10', pax: null }),
    record({ id: 'arr-3', type: 'A', date: '2026-06-03', schedule: '06:20', pax: null }),
    record({ id: 'dep-1', type: 'D', date: '2026-06-03', schedule: '07:00', pax: 50 }),
    record({ id: 'baseline-1', type: 'A', date: '2026-06-10', schedule: '06:00', pax: 100 }),
  ];

  const unconfigured = buildOperationalDashboard({
    records,
    operationalDate: '2026-06-03',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    settings: emptyAlerts(),
    nowLocal: new Date('2026-06-05T12:00:00+07:00'),
  });
  const configured = buildOperationalDashboard({
    records,
    operationalDate: '2026-06-03',
    bucketSizeMinutes: 60,
    timeBasis: 'local',
    settings: emptyAlerts({
      arrivalBucketFlights: 2,
      adGapFlights: 2,
      ctgAbsPct: 1,
      paxCoverageMinPct: 0.9,
    }),
    nowLocal: new Date('2026-06-05T12:00:00+07:00'),
  });

  assert.deepEqual(unconfigured.alerts, []);
  assert.deepEqual(
    configured.alerts.map((alert) => alert.kind).sort(),
    ['adGapFlights', 'arrivalBucketFlights', 'ctgAbsPct', 'paxCoverageMinPct']
  );
});

test('dashboard alert settings normalize empty values and clamp configured bounds', () => {
  const normalized = validateOperationalSettings({
    dashboardAlerts: {
      arrivalBucketFlights: '12' as unknown as number,
      departureBucketFlights: '' as unknown as number,
      adGapFlights: 2000,
      ctgAbsPct: -2,
      paxCoverageMinPct: 2,
    },
  });

  assert.deepEqual(normalized.dashboardAlerts, {
    arrivalBucketFlights: 12,
    departureBucketFlights: null,
    adGapFlights: 999,
    ctgAbsPct: 0,
    paxCoverageMinPct: 1,
  });
});
