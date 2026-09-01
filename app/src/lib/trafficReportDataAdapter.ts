import {
  TRAFFIC_REPORT_V2_API_BASE,
  decodeTrafficV2ApiEnvelope,
  type TrafficV2ApiDimensionRow,
  type TrafficV2ApiTimelinePoint,
  type TrafficV2Bundle,
} from './trafficReportV2Contract.ts';
import {
  isTrafficDimensionResponse,
  isTrafficReportBundle,
  toTrafficReportSearchParams,
  type TrafficBreakdownRow,
  type TrafficDimension,
  type TrafficDimensionResponse,
  type TrafficDimensionSort,
  type TrafficReportFilter,
  type TrafficReportBundle,
  type TrafficTimelinePoint,
  type TrafficType,
} from './trafficReportContract.ts';

export interface TrafficReportFetchOptions {
  signal?: AbortSignal;
  expectedWatermark?: number;
  fetchImpl?: typeof fetch;
  /** A 409 means the caller must replace, not merge, its current bundle. */
  reloadOnVersionChange?: boolean;
}

export class TrafficReportVersionChangedError extends Error {
  readonly expectedWatermark: number | null;
  readonly actualWatermark: number | null;

  constructor(expectedWatermark: number | null, actualWatermark: number | null) {
    super('Dữ liệu báo cáo đã thay đổi. Cần tải lại toàn bộ báo cáo.');
    this.name = 'TrafficReportVersionChangedError';
    this.expectedWatermark = expectedWatermark;
    this.actualWatermark = actualWatermark;
  }
}

export class TrafficReportRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TrafficReportRequestError';
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

interface TrafficErrorPayload {
  error?: unknown;
  error_code?: unknown;
  expected_watermark?: unknown;
  actual_watermark?: unknown;
}

function asSafeWatermark(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function errorPayload(value: unknown): TrafficErrorPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TrafficErrorPayload
    : {};
}

export function buildTrafficReportV2OverviewUrl(
  filter: TrafficReportFilter,
  expectedWatermark?: number,
): string {
  const query = toTrafficReportSearchParams(filter);
  if (expectedWatermark !== undefined) {
    if (!Number.isSafeInteger(expectedWatermark) || expectedWatermark < 0) {
      throw new Error('Watermark kỳ vọng không hợp lệ.');
    }
    query.set('expected_watermark', String(expectedWatermark));
  }
  const serialized = query.toString();
  return `${TRAFFIC_REPORT_V2_API_BASE}/overview${serialized ? `?${serialized}` : ''}`;
}

function appendExpectedWatermark(query: URLSearchParams, expectedWatermark: number): void {
  if (!Number.isSafeInteger(expectedWatermark) || expectedWatermark < 0) {
    throw new Error('Watermark kỳ vọng không hợp lệ.');
  }
  query.set('expected_watermark', String(expectedWatermark));
}

function appendReadVersion(query: URLSearchParams, readVersionToken: string): void {
  if (!/^rv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(readVersionToken)) {
    throw new Error('Report Read Version không hợp lệ.');
  }
  query.set('read_version', readVersionToken);
}

export function buildTrafficReportV2TimelineUrl(
  filter: TrafficReportFilter,
  scope: TrafficType,
  after: string | null,
  expectedWatermark: number,
  readVersionToken: string,
): string {
  const query = toTrafficReportSearchParams({ ...filter, type: scope });
  query.set('page_size', '366');
  if (after) query.set('after', after);
  appendExpectedWatermark(query, expectedWatermark);
  appendReadVersion(query, readVersionToken);
  return `${TRAFFIC_REPORT_V2_API_BASE}/timeline?${query.toString()}`;
}

export function buildTrafficReportV2DimensionUrl(
  filter: TrafficReportFilter,
  dimension: TrafficDimension,
  scope: TrafficType,
  sort: TrafficDimensionSort,
  page: number,
  pageSize: number,
  expectedWatermark: number,
  readVersionToken: string,
  exportAll = false,
): string {
  const query = toTrafficReportSearchParams({ ...filter, type: scope });
  query.set('dimension', dimension);
  query.set('sort', sort);
  query.set('page', String(page));
  query.set('page_size', String(pageSize));
  appendExpectedWatermark(query, expectedWatermark);
  appendReadVersion(query, readVersionToken);
  return `${TRAFFIC_REPORT_V2_API_BASE}/${exportAll ? 'dimension-export' : 'dimension'}?${query.toString()}`;
}

export function buildTrafficReportV2ExportUrl(
  filter: TrafficReportFilter,
  expectedWatermark: number,
  readVersionToken: string,
): string {
  const query = toTrafficReportSearchParams(filter);
  appendExpectedWatermark(query, expectedWatermark);
  appendReadVersion(query, readVersionToken);
  return `${TRAFFIC_REPORT_V2_API_BASE}/export?${query.toString()}`;
}

async function requestBundle(
  filter: TrafficReportFilter,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  expectedWatermark: number | undefined,
): Promise<TrafficV2Bundle> {
  const response = await fetchImpl(buildTrafficReportV2OverviewUrl(filter, expectedWatermark), {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 409) {
    const details = errorPayload(payload);
    throw new TrafficReportVersionChangedError(
      asSafeWatermark(details.expected_watermark) ?? expectedWatermark ?? null,
      asSafeWatermark(details.actual_watermark),
    );
  }
  if (!response.ok) {
    const details = errorPayload(payload);
    const message = typeof details.error === 'string'
      ? details.error
      : 'Báo cáo tạm thời chưa thể cập nhật.';
    throw new TrafficReportRequestError(message, response.status);
  }
  return decodeTrafficV2ApiEnvelope(payload);
}

/**
 * Shared read adapter for Report and Dashboard Report Mode.
 * It never derives KPI values from row-level data. If a pinned request races a
 * data change, the optional retry deliberately fetches an unpinned full bundle.
 */
export async function fetchTrafficReportV2Bundle(
  filter: TrafficReportFilter,
  options: TrafficReportFetchOptions = {},
): Promise<TrafficV2Bundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await requestBundle(filter, fetchImpl, options.signal, options.expectedWatermark);
  } catch (error) {
    if (error instanceof TrafficReportVersionChangedError
      && options.expectedWatermark !== undefined
      && options.reloadOnVersionChange !== false) {
      return requestBundle(filter, fetchImpl, options.signal, undefined);
    }
    throw error;
  }
}

function presentationBreakdowns(
  rows: TrafficV2Bundle['dimensions'][keyof TrafficV2Bundle['dimensions']],
): TrafficBreakdownRow[] {
  return (rows ?? []).map((row) => ({
    key: row.key,
    label: row.label,
    flights: row.flights,
    arrivals: row.arrivals,
    departures: row.departures,
    reported_pax: row.reportedPax,
    share: row.flightShare,
    suppressed: false,
    status: row.status,
  }));
}

function presentationTimeline(bundle: TrafficV2Bundle): TrafficTimelinePoint[] {
  return bundle.timeline.map((row) => ({
    ops_date: row.opsDate,
    flights: row.flights,
    arrivals: row.arrivals,
    departures: row.departures,
    reported_pax: row.reportedPax,
    reported_legs: row.reportedLegs,
    due_legs: row.dueLegs,
    pax_coverage_pct: row.dueLegs != null && row.dueLegs > 0 && row.reportedLegs != null
      ? Math.round((row.reportedLegs * 1000) / row.dueLegs) / 10
      : null,
    pax_status: row.status === 'future'
      ? 'not_due'
      : row.dueLegs != null && row.dueLegs > 0 ? 'available' : 'unavailable',
    completeness: row.status === 'missing' ? 'missing' : row.status === 'partial' ? 'partial' : 'complete',
    suppressed: false,
    status: row.status,
  }));
}

function apiTimelinePoint(row: TrafficV2ApiTimelinePoint): TrafficTimelinePoint {
  const dueLegs = row.due_legs;
  const reportedLegs = row.reported_legs;
  return {
    ops_date: row.ops_date,
    flights: row.flights,
    arrivals: row.arrivals,
    departures: row.departures,
    reported_pax: row.reported_pax,
    reported_legs: reportedLegs,
    due_legs: dueLegs,
    pax_coverage_pct: dueLegs != null && dueLegs > 0 && reportedLegs != null
      ? Math.round((reportedLegs * 1000) / dueLegs) / 10
      : null,
    pax_status: row.status === 'future'
      ? 'not_due'
      : dueLegs != null && dueLegs > 0 ? 'available' : 'unavailable',
    completeness: row.status === 'missing' ? 'missing' : row.status === 'partial' ? 'partial' : 'complete',
    suppressed: false,
    status: row.status,
  };
}

async function v2ResourcePayload(
  response: Response,
  expectedWatermark: number,
  readVersionToken: string,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 409) {
    const details = errorPayload(payload);
    throw new TrafficReportVersionChangedError(
      asSafeWatermark(details.expected_watermark) ?? expectedWatermark,
      asSafeWatermark(details.actual_watermark),
    );
  }
  if (!response.ok) {
    const details = errorPayload(payload);
    throw new TrafficReportRequestError(
      typeof details.error === 'string' ? details.error : 'Báo cáo tạm thời chưa thể cập nhật.',
      response.status,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload traffic-report-v2 không hợp lệ.');
  }
  const resource = payload as Record<string, unknown>;
  if (resource.read_version_token !== readVersionToken) {
    throw new Error('Tài nguyên báo cáo không cùng Report Read Version.');
  }
  return resource;
}

export async function fetchTrafficReportV2TimelinePage(
  filter: TrafficReportFilter,
  scope: TrafficType,
  after: string | null,
  expectedWatermark: number,
  readVersionToken: string,
  options: Pick<TrafficReportFetchOptions, 'signal' | 'fetchImpl'> = {},
): Promise<{ timeline: TrafficTimelinePoint[]; hasMore: boolean; nextCursor: string | null }> {
  const response = await (options.fetchImpl ?? fetch)(
    buildTrafficReportV2TimelineUrl(filter, scope, after, expectedWatermark, readVersionToken),
    { credentials: 'omit', headers: { Accept: 'application/json' }, signal: options.signal },
  );
  const payload = await v2ResourcePayload(response, expectedWatermark, readVersionToken);
  if (payload.source_watermark !== expectedWatermark || !Array.isArray(payload.timeline)) {
    throw new TrafficReportVersionChangedError(expectedWatermark, asSafeWatermark(payload.source_watermark));
  }
  return {
    timeline: (payload.timeline as TrafficV2ApiTimelinePoint[]).map(apiTimelinePoint),
    hasMore: Boolean(payload.has_more),
    nextCursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : null,
  };
}

function apiDimensionRow(row: TrafficV2ApiDimensionRow) {
  return {
    key: row.key,
    label: row.label,
    flights: row.flights,
    arrivals: row.arrivals,
    departures: row.departures,
    reported_pax: row.reported_pax,
    flight_share: row.flight_share,
    pax_share: row.pax_share,
    reported_legs: row.reported_legs,
    due_legs: row.due_legs,
    pax_coverage_pct: row.due_legs > 0 ? Math.round((row.reported_legs * 1000) / row.due_legs) / 10 : null,
    pax_status: row.status === 'future' ? 'not_due' as const
      : row.due_legs > 0 ? 'available' as const : 'unavailable' as const,
    suppressed: false,
    status: row.status,
  };
}

export async function fetchTrafficReportV2DimensionPage(
  filter: TrafficReportFilter,
  dimension: TrafficDimension,
  scope: TrafficType,
  sort: TrafficDimensionSort,
  page: number,
  pageSize: number,
  expectedWatermark: number,
  readVersionToken: string,
  options: Pick<TrafficReportFetchOptions, 'signal' | 'fetchImpl'> = {},
): Promise<TrafficDimensionResponse> {
  const response = await (options.fetchImpl ?? fetch)(
    buildTrafficReportV2DimensionUrl(filter, dimension, scope, sort, page, pageSize, expectedWatermark, readVersionToken),
    { credentials: 'omit', headers: { Accept: 'application/json' }, signal: options.signal },
  );
  const payload = await v2ResourcePayload(response, expectedWatermark, readVersionToken);
  if (payload.source_watermark !== expectedWatermark || !Array.isArray(payload.rows)) {
    throw new TrafficReportVersionChangedError(expectedWatermark, asSafeWatermark(payload.source_watermark));
  }
  const result: TrafficDimensionResponse = {
    contract_version: 'traffic-report-v2',
    request_hash: typeof payload.filter_hash === 'string' ? payload.filter_hash : '',
    data_as_of: String(payload.data_as_of ?? ''),
    dimension,
    type: scope,
    page: Number(payload.page),
    page_size: Number(payload.page_size),
    total_rows: Number(payload.total_rows),
    has_more: Boolean(payload.has_more),
    rows: (payload.rows as TrafficV2ApiDimensionRow[]).map(apiDimensionRow),
  };
  if (!isTrafficDimensionResponse(result)) throw new Error('Dimension traffic-report-v2 không hợp lệ.');
  return result;
}

/**
 * Converts the strict live v2 contract into the existing Report presentation
 * model. Values are renamed only; KPI, Pax and breakdown totals are never
 * recomputed from browser-visible flight rows.
 */
export function toTrafficReportPresentationBundle(bundle: TrafficV2Bundle): TrafficReportBundle {
  const current = bundle.current;
  const comparison = bundle.comparison;
  const report = bundle.report;
  const result: TrafficReportBundle = {
    contract_version: 'traffic-report-v2',
    request_hash: bundle.version.filterHash,
    data_as_of: bundle.version.dataAsOf,
    source_watermark: bundle.version.sourceWatermark,
    read_version_token: bundle.version.readVersionToken,
    metadata: {
      min_ops_date: report.minOpsDate,
      max_ops_date: report.maxOpsDate,
      latest_completed_ops_date: report.latestCompletedOpsDate,
      normalized_filter: bundle.filter,
      day_count: report.dayCount,
      timeline_granularity: 'day',
      timeline_has_more: false,
      timeline_next_cursor: null,
      filter_options: report.filterOptions,
      available_dimensions: ['route', 'country', 'airline'],
      projection: {
        status: 'fresh',
        source_data_version: bundle.version.dataVersion,
        current_data_version: bundle.version.dataVersion,
        source_watermark: bundle.version.sourceWatermark,
        current_watermark: bundle.version.sourceWatermark,
        refreshed_at: bundle.version.dataAsOf,
        snapshot_rows: null,
      },
      selected_day_count: report.coverage.selectedDayCount,
      covered_day_count: report.coverage.coveredDayCount,
      partial_day_count: report.coverage.partialDayCount,
      missing_day_count: report.coverage.missingDayCount,
      filter_options_limit: 250,
    },
    kpis: {
      current: {
        flights: current.flights,
        arrivals: current.arrivals,
        departures: current.departures,
        reported_pax: current.reportedPax,
        arrival_reported_pax: current.arrivalReportedPax ?? null,
        departure_reported_pax: current.departureReportedPax ?? null,
        status: current.status,
      },
      comparison: {
        from: comparison.from,
        to: comparison.to,
        mode: bundle.comparisonMode,
        flights: comparison.flights,
        arrivals: comparison.arrivals,
        departures: comparison.departures,
        reported_pax: comparison.reportedPax,
        arrival_reported_pax: comparison.arrivalReportedPax ?? null,
        departure_reported_pax: comparison.departureReportedPax ?? null,
        status: comparison.status,
      },
      peak_day: report.peakDay,
      pax_coverage: report.paxCoverage,
    },
    timeline: presentationTimeline(bundle),
    breakdowns: {
      airline: presentationBreakdowns(bundle.dimensions.airline),
      route: presentationBreakdowns(bundle.dimensions.route),
      country: presentationBreakdowns(bundle.dimensions.country),
      aircraft_group: report.breakdowns.aircraft_group,
      aircraft_type: report.breakdowns.aircraft_type,
      peak_hour: report.breakdowns.peak_hour,
      peak_hour_monthly: report.breakdowns.peak_hour_monthly,
      day_of_week: report.breakdowns.day_of_week,
    },
    quality: {
      ...report.quality,
      notes: [
        'Pax NULL là chưa có dữ liệu; Pax 0 là giá trị đã báo cáo.',
        'Dữ liệu live được khóa bằng watermark cho toàn bộ phiên bản báo cáo.',
        'Country chưa được ánh xạ thuộc nhóm Unknown.',
      ],
    },
  };
  if (!isTrafficReportBundle(result)) throw new Error('Không thể dựng mô hình hiển thị traffic-report-v2.');
  return result;
}
