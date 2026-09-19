import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildV2DimensionShare,
  buildV2MonthlyTimeline,
  buildV2WeekdayBreakdowns,
  enrichV2OverviewBreakdowns,
} from './trafficReportPresentationAggregates.ts';

const timeline = [
  { ops_date: '2026-01-05', flights: 10, arrivals: 6, departures: 4, reported_pax: null, reported_legs: 0, due_legs: 10, missing_due_legs: 10, true_zero_reported_legs: 0, status: 'complete' },
  { ops_date: '2026-01-12', flights: 14, arrivals: 8, departures: 6, reported_pax: 0, reported_legs: 1, due_legs: 14, missing_due_legs: 13, true_zero_reported_legs: 1, status: 'complete' },
  { ops_date: '2026-02-02', flights: 20, arrivals: 9, departures: 11, reported_pax: 200, reported_legs: 2, due_legs: 20, missing_due_legs: 18, true_zero_reported_legs: 0, status: 'complete' },
  { ops_date: '2026-02-03', flights: null, arrivals: null, departures: null, reported_pax: null, reported_legs: null, due_legs: null, missing_due_legs: null, true_zero_reported_legs: null, status: 'missing' },
];

test('weekday parity keeps missing distinct from zero and calculates A/D independently', () => {
  const result = buildV2WeekdayBreakdowns(timeline);
  assert.equal(result.summary.length, 7);
  assert.deepEqual(result.summary.map((row) => row.day_index), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.summary[0].average_flights, 15);
  assert.equal(result.summary[0].average_arrivals, 8);
  assert.equal(result.summary[0].average_departures, 7);
  assert.equal(result.summary[1].average_flights, null);
  assert.equal(result.summary[1].status, 'missing');
  assert.equal(result.monthly.length, 14);
});

test('monthly timeline preserves Pax NULL and true zero', () => {
  const result = buildV2MonthlyTimeline(timeline);
  assert.equal(result.length, 2);
  assert.equal(result[0].flights, 24);
  assert.equal(result[0].reported_pax, 0);
  assert.equal(result[1].reported_pax, 200);
  assert.equal(result[1].status, 'partial');
  const missingOnly = buildV2MonthlyTimeline([timeline[0]]);
  assert.equal(missingOnly[0].reported_pax, null);
});

test('monthly period status follows calendar coverage instead of Pax completeness', () => {
  const fullJanuary = Array.from({ length: 31 }, (_, index) => ({
    ops_date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    flights: 10,
    arrivals: 5,
    departures: 5,
    reported_pax: 100,
    reported_legs: index === 10 ? 9 : 10,
    due_legs: 10,
    missing_due_legs: index === 10 ? 1 : 0,
    true_zero_reported_legs: 0,
    status: index === 10 ? 'partial' : 'complete',
  }));
  const clippedSeptember = Array.from({ length: 4 }, (_, index) => ({
    ops_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    flights: 10,
    arrivals: 5,
    departures: 5,
    reported_pax: 100,
    reported_legs: 10,
    due_legs: 10,
    missing_due_legs: 0,
    true_zero_reported_legs: 0,
    status: 'complete',
  }));

  const [january, september] = buildV2MonthlyTimeline([...fullJanuary, ...clippedSeptember]);
  assert.equal(january.status, 'partial');
  assert.equal(january.period_status, 'complete');
  assert.equal(september.status, 'complete');
  assert.equal(september.period_status, 'partial');
});

test('dimension share ranks each metric independently and returns Khác', () => {
  const rows = [
    { key: 'A', label: 'A', flights: 100, reported_pax: 5 },
    { key: 'B', label: 'B', flights: 20, reported_pax: 500 },
    { key: 'C', label: 'C', flights: 10, reported_pax: null },
  ];
  const flights = buildV2DimensionShare(rows, 'route', 'flights', 1);
  const pax = buildV2DimensionShare(rows, 'route', 'reported_pax', 1);
  assert.equal((flights.top_rows as Array<Record<string, unknown>>)[0].label, 'A');
  assert.equal((pax.top_rows as Array<Record<string, unknown>>)[0].label, 'B');
  assert.equal((flights.other as Record<string, unknown>).value, 30);
  assert.equal((pax.other as Record<string, unknown>).value, 5);
});

test('dimension share supports airline with Top 10 and Khác', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    key: `AL${index + 1}`,
    label: `AL${index + 1}`,
    flights: 120 - index,
    reported_pax: 1_000 + index * 100,
  }));
  const flights = buildV2DimensionShare(rows, 'airline', 'flights', 10);
  const pax = buildV2DimensionShare(rows, 'airline', 'reported_pax', 10);
  assert.equal(flights.dimension, 'airline');
  assert.equal((flights.top_rows as unknown[]).length, 10);
  assert.equal((pax.top_rows as unknown[]).length, 10);
  assert.equal((flights.other as Record<string, unknown>).label, 'Khác');
  assert.equal((pax.other as Record<string, unknown>).label, 'Khác');
  assert.notEqual(
    (flights.top_rows as Array<Record<string, unknown>>)[0].label,
    (pax.top_rows as Array<Record<string, unknown>>)[0].label,
  );
});

test('overview enrichment replaces incomplete weekday fields without changing the bundle envelope', () => {
  const bundle = { source_watermark: 51, timeline, report: { breakdowns: { aircraft_group: [] } } };
  const enriched = enrichV2OverviewBreakdowns(bundle);
  assert.equal(enriched.source_watermark, 51);
  const breakdowns = (enriched.report as Record<string, unknown>).breakdowns as Record<string, unknown>;
  assert.equal((breakdowns.day_of_week as unknown[]).length, 7);
  assert.equal((breakdowns.day_of_week_monthly as unknown[]).length, 14);
});
