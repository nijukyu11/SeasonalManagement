import assert from 'node:assert/strict';
import test from 'node:test';
import type { TrafficReportFilter } from './trafficReportContract.ts';
import {
  TrafficReportRequestError,
  TrafficReportSyncingError,
  TrafficReportVersionChangedError,
  buildTrafficReportV2DimensionUrl,
  buildTrafficReportV2DimensionShareUrl,
  buildTrafficReportV2ExportUrl,
  buildTrafficReportV2MonthDetailUrl,
  buildTrafficReportV2MonthlyTimelineUrl,
  buildTrafficReportV2OverviewUrl,
  fetchTrafficReportV2Bundle,
  fetchTrafficReportV2DimensionPage,
  fetchTrafficReportV2DimensionShare,
  fetchTrafficReportV2MonthDetail,
  fetchTrafficReportV2MonthlyTimeline,
  fetchTrafficReportV2TimelinePage,
  toTrafficReportPresentationBundle,
} from './trafficReportDataAdapter.ts';
import {
  decodeTrafficV2ApiEnvelope,
  type TrafficV2ApiEnvelope,
  type TrafficV2ApiMetricSet,
} from './trafficReportV2Contract.ts';

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
    day_count: 31,
    filter_options: { airline: ['VN'], route: ['HAN'], country: ['Vietnam'] },
    coverage: { selected_day_count: 31, covered_day_count: 31, partial_day_count: 0, missing_day_count: 0 },
    coverage_counts: { routes: 1, airlines: 1, countries: 1 },
    peak_day: { ops_date: null, flights: null, status: 'unavailable' },
    pax_coverage: { reported_legs: 0, due_legs: 0, percent: null, status: 'unavailable' },
    quality: { unknown_country_legs: 0, pax_due_missing_legs: 0, quarantined_duplicate_candidates: 0 },
    breakdowns: {
      aircraft_group: [],
      aircraft_type: [],
      peak_hour: Array.from({ length: 24 }, (_, hour) => ({
        hour_bucket: `${String(hour).padStart(2, '0')}:00`, bucket_minutes: 60 as const,
        time_basis: 'local' as const, arrivals: 0, departures: 0,
        regular_flights: { arrivals: [], departures: [] }, suppressed: false,
      })),
      peak_hour_monthly: [],
      day_of_week: Array.from({ length: 7 }, (_, index) => ({
        day_index: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        calendar_days: 0, complete_day_count: 0, total_flights: null, average_flights: null, min_flights: null,
        max_flights: null, arrivals: null, average_arrivals: null, min_arrivals: null, max_arrivals: null,
        departures: null, average_departures: null, min_departures: null, max_departures: null,
        status: 'missing' as const, suppressed: false,
      })),
      day_of_week_monthly: [],
    },
  };
}

function payload(watermark = 51): TrafficV2ApiEnvelope {
  return {
    contract_version: 'traffic-report-v2',
    read_version_token: 'rv1.dGVzdA.c2ln',
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
    current: metric({
      flights: 2,
      arrivals: 1,
      departures: 1,
      reported_pax: 0,
      arrival_reported_pax: 0,
      departure_reported_pax: null,
      reported_legs: 1,
      due_legs: 2,
      missing_due_legs: 1,
      true_zero_reported_legs: 1,
      status: 'partial',
    }),
    comparison: { ...metric(), from: '2026-07-01', to: '2026-07-31' },
    timeline: Array.from({ length: 31 }, (_, index) => ({
      ...metric(),
      ops_date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    })),
    dimensions: {},
    report: report(),
  };
}

test('adapter builds one canonical v2 URL without credentials', () => {
  assert.equal(
    buildTrafficReportV2OverviewUrl(filter, 50),
    '/api/report/v2/overview?from=2026-08-01&to=2026-08-31&airline=VN&expected_watermark=50',
  );
  assert.match(buildTrafficReportV2ExportUrl(filter, 51, 'rv1.dGVzdA.c2ln'), /\/v2\/export\?.*expected_watermark=51.*read_version=rv1/u);
  assert.match(
    buildTrafficReportV2DimensionUrl(filter, 'route', 'A', 'reported_pax', 2, 50, 51, 'rv1.dGVzdA.c2ln', true),
    /\/v2\/dimension-export\?.*type=A.*dimension=route.*sort=reported_pax.*page=2.*page_size=50.*expected_watermark=51.*read_version=rv1/u,
  );
  assert.match(buildTrafficReportV2MonthlyTimelineUrl(filter, 'all', 51, 'rv1.dGVzdA.c2ln'), /granularity=month.*page_size=732.*expected_watermark=51/u);
  assert.match(buildTrafficReportV2MonthDetailUrl(filter, 'all', '2026-08', 51, 'rv1.dGVzdA.c2ln'), /month=2026-08.*page_size=62.*expected_watermark=51/u);
  assert.match(buildTrafficReportV2DimensionShareUrl(filter, 'country', 'all', 'reported_pax', 51, 'rv1.dGVzdA.c2ln'), /dimension=country.*metric=reported_pax.*limit=10.*expected_watermark=51/u);
  assert.match(buildTrafficReportV2DimensionShareUrl(filter, 'airline', 'all', 'flights', 51, 'rv1.dGVzdA.c2ln'), /dimension=airline.*metric=flights.*limit=10.*expected_watermark=51/u);
});

test('adapter reads monthly timeline, month detail, and independent dimension share resources', async () => {
  const fetchImpl = (async (input) => {
    const url = String(input);
    const version = { contract_version: 'traffic-report-v2', source_watermark: 51, read_version_token: 'rv1.dGVzdA.c2ln' };
    if (url.includes('dimension-share')) return Response.json({
      ...version, dimension: 'route', metric: 'reported_pax', type: 'all', limit: 10, total_value: 100,
      top_rows: [{ key: 'HAN', label: 'HAN', value: 80, share: 0.8 }],
      other: { label: 'Khác', value: 20, share: 0.2 },
    });
    if (url.includes('granularity=month')) return Response.json({ ...version, timeline: [{
      month: '2026-08', from: '2026-08-01', to: '2026-08-31', selected_day_count: 31,
      complete_day_count: 31, partial_day_count: 0, missing_day_count: 0,
      flights: 10, arrivals: 5, departures: 5, reported_pax: null, reported_legs: 0,
      due_legs: 10, missing_due_legs: 10, true_zero_reported_legs: 0,
      period_status: 'complete', status: 'complete',
    }] });
    return Response.json({ ...version, timeline: [{
      ops_date: '2026-08-01', flights: 1, arrivals: 1, departures: 0,
      reported_pax: null, reported_legs: 0, due_legs: 1, missing_due_legs: 1,
      true_zero_reported_legs: 0, status: 'complete',
    }] });
  }) as typeof fetch;
  const months = await fetchTrafficReportV2MonthlyTimeline(filter, 'all', 51, 'rv1.dGVzdA.c2ln', { fetchImpl });
  const days = await fetchTrafficReportV2MonthDetail(filter, 'all', '2026-08', 51, 'rv1.dGVzdA.c2ln', { fetchImpl });
  const share = await fetchTrafficReportV2DimensionShare(filter, 'route', 'all', 'reported_pax', 51, 'rv1.dGVzdA.c2ln', { fetchImpl });
  assert.equal(months[0].reported_pax, null);
  assert.equal(months[0].period_status, 'complete');
  assert.equal(days[0].reported_pax, null);
  assert.equal(share.other?.label, 'Khác');
});

test('versioned timeline and dimension reads preserve null Pax and require the pinned watermark', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/timeline')) return Response.json({
      source_watermark: 51,
      read_version_token: 'rv1.dGVzdA.c2ln',
      has_more: false,
      next_cursor: null,
      timeline: [{
        ops_date: '2026-08-01', flights: 1, arrivals: 1, departures: 0,
        reported_pax: null, reported_legs: 0, due_legs: 1, missing_due_legs: 1,
        true_zero_reported_legs: 0, status: 'missing',
      }],
    });
    return Response.json({
      contract_version: 'traffic-report-v2', read_version_token: 'rv1.dGVzdA.c2ln', data_as_of: '2026-08-31T05:00:00.000Z',
      source_watermark: 51, filter_hash: 'b'.repeat(64), dimension: 'route', type: 'all',
      page: 1, page_size: 50, total_rows: 1, has_more: false,
      rows: [{
        key: 'HAN', label: 'HAN', flights: 1, arrivals: 1, departures: 0,
        reported_pax: null, flight_share: 1, pax_share: null, reported_legs: 0,
        due_legs: 1, missing_due_legs: 1, true_zero_reported_legs: 0, status: 'missing',
      }],
    });
  }) as typeof fetch;
  const timeline = await fetchTrafficReportV2TimelinePage(filter, 'all', null, 51, 'rv1.dGVzdA.c2ln', { fetchImpl });
  const dimension = await fetchTrafficReportV2DimensionPage(filter, 'route', 'all', 'flights', 1, 50, 51, 'rv1.dGVzdA.c2ln', { fetchImpl });
  assert.equal(timeline.timeline[0].reported_pax, null);
  assert.equal(dimension.rows[0].reported_pax, null);
  assert.ok(seen.every((url) => url.includes('expected_watermark=51') && url.includes('read_version=rv1')));
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
  assert.equal(bundle.current.reportedPax, 0);
  assert.equal(capturedInit?.credentials, 'omit');
  assert.deepEqual(capturedInit?.headers, { Accept: 'application/json' });
});

test('adapter maps live v2 to the existing Report presentation without losing true zero', () => {
  const live = decodeTrafficV2ApiEnvelope(payload());
  const reportBundle = toTrafficReportPresentationBundle(live);
  assert.equal(reportBundle.contract_version, 'traffic-report-v2');
  assert.equal(reportBundle.kpis.current.reported_pax, 0);
  assert.equal(reportBundle.kpis.current.arrival_reported_pax, 0);
  assert.equal(reportBundle.kpis.current.departure_reported_pax, null);
  assert.equal(reportBundle.metadata.projection?.source_watermark, 51);
  assert.equal(reportBundle.breakdowns.peak_hour.length, 24);
  assert.deepEqual(reportBundle.kpis.coverage_counts, { routes: 1, airlines: 1, countries: 1 });
  assert.deepEqual(reportBundle.breakdowns.day_of_week_monthly, []);
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

test('adapter classifies REPORT_SYNCING (503) as TrafficReportSyncingError', async () => {
  await assert.rejects(
    fetchTrafficReportV2Bundle(filter, {
      fetchImpl: (async () => Response.json({
        error_code: 'REPORT_SYNCING',
        error: 'Đang đồng bộ dữ liệu vận hành. Vui lòng đợi trong giây lát.',
      }, { status: 503 })) as typeof fetch,
    }),
    (error: unknown) => error instanceof TrafficReportSyncingError
      && error.status === 503
      && error.errorCode === 'REPORT_SYNCING'
      && error.retryable,
  );
});

test('adapter retries bounded sync failures when maxSyncRetries is configured and succeeds', async () => {
  let calls = 0;
  const syncStatuses: boolean[] = [];
  const bundle = await fetchTrafficReportV2Bundle(filter, {
    maxSyncRetries: 2,
    syncRetryDelayMs: 5,
    onSyncStatus: (syncing) => { syncStatuses.push(syncing); },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          error_code: 'REPORT_SYNCING',
          error: 'Đang đồng bộ dữ liệu vận hành. Vui lòng đợi trong giây lát.',
        }, { status: 503 });
      }
      return Response.json(payload(60));
    }) as typeof fetch,
  });
  assert.equal(calls, 2);
  assert.equal(bundle.version.sourceWatermark, 60);
  assert.deepEqual(syncStatuses, [true, false]);
});

test('adapter exhausts bounded sync retries and retains failure after bound', async () => {
  let calls = 0;
  const syncStatuses: boolean[] = [];
  await assert.rejects(
    fetchTrafficReportV2Bundle(filter, {
      maxSyncRetries: 2,
      syncRetryDelayMs: 5,
      onSyncStatus: (syncing) => { syncStatuses.push(syncing); },
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({
          error_code: 'REPORT_SYNCING',
          error: 'Đang đồng bộ dữ liệu vận hành. Vui lòng đợi trong giây lát.',
        }, { status: 503 });
      }) as typeof fetch,
    }),
    (error: unknown) => error instanceof TrafficReportSyncingError && error.errorCode === 'REPORT_SYNCING',
  );
  assert.equal(calls, 3);
  assert.deepEqual(syncStatuses, [true, true, false]);
});

test('toTrafficReportPresentationBundle preserves flight_category breakdown', () => {
  const input = payload();
  input.report.breakdowns.flight_category = [
    { key: 'scheduled', code: 'J', label: 'Thường lệ', flights: 10, arrivals: 5, departures: 5, reported_pax: 1500, share: 0.8, suppressed: false },
    { key: 'charter', code: 'C', label: 'Không thường lệ', flights: 2, arrivals: 1, departures: 1, reported_pax: 300, share: 0.2, suppressed: false },
  ];
  const live = decodeTrafficV2ApiEnvelope(input);
  const bundle = toTrafficReportPresentationBundle(live);
  assert.equal(bundle.breakdowns.flight_category?.length, 2);
  assert.equal(bundle.breakdowns.flight_category?.[0].code, 'J');
  assert.equal(bundle.breakdowns.flight_category?.[1].code, 'C');
});

test('adapter maps future null flight rows to completeness: missing', () => {
  const input = payload();
  input.normalized_filter.to = '2026-09-01';
  input.timeline.push({
    ops_date: '2026-09-01', flights: null, arrivals: null, departures: null,
    reported_pax: null, reported_legs: null, due_legs: null,
    missing_due_legs: null, true_zero_reported_legs: null, status: 'future',
  });
  const live = decodeTrafficV2ApiEnvelope(input);
  const bundle = toTrafficReportPresentationBundle(live);
  const futurePoint = bundle.timeline.find((p) => p.ops_date === '2026-09-01');
  assert.equal(futurePoint?.completeness, 'missing');
  assert.equal(futurePoint?.flights, null);
  assert.equal(futurePoint?.status, 'future');
});
