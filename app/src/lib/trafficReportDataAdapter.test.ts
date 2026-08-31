import assert from 'node:assert/strict';
import test from 'node:test';
import type { TrafficReportFilter } from './trafficReportContract.ts';
import {
  TrafficReportRequestError,
  TrafficReportVersionChangedError,
  buildTrafficReportV2OverviewUrl,
  fetchTrafficReportV2Bundle,
} from './trafficReportDataAdapter.ts';
import type { TrafficV2ApiEnvelope, TrafficV2ApiMetricSet } from './trafficReportV2Contract.ts';

const filter: TrafficReportFilter = {
  from: '2026-08-01',
  to: '2026-08-31',
  type: 'all',
  airline: ['VN'],
  route: [],
  country: [],
  comp: 'previous',
  tz: 'local',
};

function metric(): TrafficV2ApiMetricSet {
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
  };
}

function payload(watermark = 51): TrafficV2ApiEnvelope {
  return {
    contract_version: 'traffic-report-v2',
    data_as_of: '2026-08-31T05:00:00.000Z',
    source_watermark: watermark,
    data_version: 7,
    filter_hash: 'b'.repeat(64),
    source_mode: 'live',
    normalized_filter: {
      from: '2026-08-01',
      to: '2026-08-31',
      type: 'all',
      airline: ['VN'],
      route: [],
      country: [],
      comp: 'previous',
      tz: 'local',
    },
    current: metric(),
    comparison: { ...metric(), from: '2026-07-01', to: '2026-07-31' },
    timeline: Array.from({ length: 31 }, (_, index) => ({
      ...metric(),
      ops_date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    })),
    dimensions: {},
  };
}

test('adapter builds one canonical v2 URL without credentials', () => {
  assert.equal(
    buildTrafficReportV2OverviewUrl(filter, 50),
    '/api/report/v2/overview?from=2026-08-01&to=2026-08-31&airline=VN&expected_watermark=50',
  );
});

test('adapter decodes the aggregate bundle and omits browser credentials', async () => {
  let capturedInit: RequestInit | undefined;
  const bundle = await fetchTrafficReportV2Bundle(filter, {
    fetchImpl: (async (_input, init) => {
      capturedInit = init;
      return Response.json(payload());
    }) as typeof fetch,
  });
  assert.equal(bundle.version.sourceWatermark, 51);
  assert.equal(bundle.current.reportedPax, null);
  assert.equal(capturedInit?.credentials, 'omit');
  assert.deepEqual(capturedInit?.headers, { Accept: 'application/json' });
});

test('adapter replaces the full bundle once after a pinned watermark changes', async () => {
  const urls: string[] = [];
  const bundle = await fetchTrafficReportV2Bundle(filter, {
    expectedWatermark: 50,
    fetchImpl: (async (input) => {
      urls.push(String(input));
      if (urls.length === 1) return Response.json({
        error_code: 'DATA_VERSION_CHANGED',
        expected_watermark: 50,
        actual_watermark: 51,
      }, { status: 409 });
      return Response.json(payload(51));
    }) as typeof fetch,
  });
  assert.equal(bundle.version.sourceWatermark, 51);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /expected_watermark=50/u);
  assert.doesNotMatch(urls[1], /expected_watermark/u);
});

test('adapter exposes version changes when automatic reload is disabled', async () => {
  await assert.rejects(
    fetchTrafficReportV2Bundle(filter, {
      expectedWatermark: 50,
      reloadOnVersionChange: false,
      fetchImpl: (async () => Response.json({
        error_code: 'DATA_VERSION_CHANGED',
        expected_watermark: 50,
        actual_watermark: 52,
      }, { status: 409 })) as typeof fetch,
    }),
    (error: unknown) => error instanceof TrafficReportVersionChangedError
      && error.expectedWatermark === 50
      && error.actualWatermark === 52,
  );
});

test('adapter classifies transient API failures as retryable', async () => {
  await assert.rejects(
    fetchTrafficReportV2Bundle(filter, {
      fetchImpl: (async () => Response.json({ error: 'Tạm thời lỗi.' }, { status: 503 })) as typeof fetch,
    }),
    (error: unknown) => error instanceof TrafficReportRequestError && error.retryable,
  );
});
