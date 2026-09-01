import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeTrafficV2ApiEnvelope,
  isTrafficV2ApiEnvelope,
  type TrafficV2ApiEnvelope,
  type TrafficV2ApiMetricSet,
} from './trafficReportV2Contract.ts';

function metric(overrides: Partial<TrafficV2ApiMetricSet> = {}): TrafficV2ApiMetricSet {
  return {
    flights: 0,
    arrivals: 0,
    departures: 0,
    reported_pax: null,
    reported_legs: 0,
    due_legs: 0,
    missing_due_legs: 0,
    true_zero_reported_legs: 0,
    status: 'zero',
    ...overrides,
  };
}

function report(): TrafficV2ApiEnvelope['report'] {
  return {
    min_ops_date: '2025-10-25',
    max_ops_date: '2027-03-28',
    latest_completed_ops_date: '2026-08-30',
    day_count: 3,
    filter_options: { airline: ['VN'], route: ['HAN'], country: ['Vietnam'] },
    coverage: { selected_day_count: 3, covered_day_count: 1, partial_day_count: 1, missing_day_count: 1 },
    peak_day: { ops_date: '2026-08-30', flights: 1, status: 'available' },
    pax_coverage: { reported_legs: 2, due_legs: 3, percent: 66.7, status: 'available' },
    quality: { unknown_country_legs: 0, pax_due_missing_legs: 1, quarantined_duplicate_candidates: 0 },
    breakdowns: {
      aircraft_group: [],
      aircraft_type: [],
      peak_hour: Array.from({ length: 24 }, (_, hour) => ({
        hour_bucket: `${String(hour).padStart(2, '0')}:00`,
        bucket_minutes: 60 as const,
        time_basis: 'local' as const,
        arrivals: 0,
        departures: 0,
        regular_flights: { arrivals: [], departures: [] },
        suppressed: false,
      })),
      peak_hour_monthly: [],
      day_of_week: Array.from({ length: 7 }, (_, index) => ({
        day_index: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        calendar_days: 0,
        total_flights: 0,
        average_flights: 0,
        min_flights: 0,
        max_flights: 0,
        arrivals: 0,
        departures: 0,
        suppressed: false,
      })),
    },
  };
}

function payload(): TrafficV2ApiEnvelope {
  return {
    contract_version: 'traffic-report-v2',
    read_version_token: 'rv1.dGVzdA.c2ln',
    data_as_of: '2026-08-31T04:00:00.000Z',
    source_watermark: 50_000,
    data_version: 42,
    filter_hash: 'a'.repeat(64),
    source_mode: 'live',
    normalized_filter: {
      from: '2026-08-29',
      to: '2026-08-31',
      type: 'all',
      airline: [],
      route: [],
      country: [],
      comp: 'previous',
      tz: 'local',
    },
    current: metric({
      flights: 3,
      arrivals: 2,
      departures: 1,
      reported_pax: 120,
      reported_legs: 2,
      due_legs: 3,
      missing_due_legs: 1,
      true_zero_reported_legs: 1,
      status: 'partial',
    }),
    comparison: { ...metric(), from: '2026-08-26', to: '2026-08-28' },
    timeline: [
      {
        ops_date: '2026-08-29', flights: null, arrivals: null, departures: null,
        reported_pax: null, reported_legs: null, due_legs: null,
        missing_due_legs: null, true_zero_reported_legs: null, status: 'missing',
      },
      { ...metric({ flights: 1, arrivals: 1, reported_pax: 0, reported_legs: 1, due_legs: 1, true_zero_reported_legs: 1, status: 'complete' }), ops_date: '2026-08-30' },
      { ...metric({ status: 'future' }), ops_date: '2026-08-31' },
    ],
    dimensions: {},
    report: report(),
  };
}

test('traffic-report-v2 preserves NULL, true zero, and future as different states', () => {
  const input = payload();
  assert.equal(isTrafficV2ApiEnvelope(input), true);
  const decoded = decodeTrafficV2ApiEnvelope(input);
  assert.equal(decoded.timeline[0].reportedPax, null);
  assert.equal(decoded.timeline[0].reportedLegs, null);
  assert.equal(decoded.timeline[0].flights, null);
  assert.equal(decoded.timeline[1].reportedPax, 0);
  assert.equal(decoded.timeline[1].reportedLegs, 1);
  assert.equal(decoded.timeline[1].trueZeroReportedLegs, 1);
  assert.equal(decoded.timeline[2].status, 'future');
});

test('traffic-report-v2 rejects a fake zero when no Pax leg was reported', () => {
  const input = payload();
  input.timeline[1].reported_pax = 0;
  input.timeline[1].reported_legs = 0;
  assert.equal(isTrafficV2ApiEnvelope(input), false);
});

test('traffic-report-v2 rejects NULL when at least one Pax leg was reported', () => {
  const input = payload();
  input.timeline[1].reported_pax = null;
  assert.equal(isTrafficV2ApiEnvelope(input), false);
});

test('traffic-report-v2 requires a continuous date spine and A + D = all flights', () => {
  const missingDay = payload();
  missingDay.timeline.splice(1, 1);
  assert.equal(isTrafficV2ApiEnvelope(missingDay), false);

  const inconsistentDirection = payload();
  inconsistentDirection.current.departures = 2;
  assert.equal(isTrafficV2ApiEnvelope(inconsistentDirection), false);
});

test('traffic-report-v2 rejects a fake zero-flight value for an uncovered missing day', () => {
  const input = payload();
  input.timeline[0].flights = 0;
  input.timeline[0].arrivals = 0;
  input.timeline[0].departures = 0;
  assert.equal(isTrafficV2ApiEnvelope(input), false);
});

test('traffic-report-v2 exposes one immutable version envelope to every consumer', () => {
  const decoded = decodeTrafficV2ApiEnvelope(payload());
  assert.deepEqual(decoded.version, {
    contractVersion: 'traffic-report-v2',
    readVersionToken: 'rv1.dGVzdA.c2ln',
    dataAsOf: '2026-08-31T04:00:00.000Z',
    sourceWatermark: 50_000,
    dataVersion: 42,
    filterHash: 'a'.repeat(64),
    sourceMode: 'live',
  });
});
