import type {
  NormalizedTrafficReportFilter,
  TrafficAircraftTypeBreakdownRow,
  TrafficBreakdownRow,
  TrafficComparison,
  TrafficDayOfWeekRow,
  TrafficDimension,
  TrafficMonthlyDayOfWeekRow,
  TrafficMonthlyPeakRow,
  TrafficPeakHourRow,
  TrafficTimeBasis,
  TrafficFlightCategoryRow,
  TrafficType,
} from './trafficReportContract.ts';
import { isTrafficFlightCategoryRow } from './trafficReportContract.ts';

export const TRAFFIC_REPORT_V2_CONTRACT_VERSION = 'traffic-report-v2' as const;
export const TRAFFIC_REPORT_V2_API_BASE = '/api/report/v2' as const;

export interface TrafficVersionEnvelope {
  contractVersion: typeof TRAFFIC_REPORT_V2_CONTRACT_VERSION;
  readVersionToken: string;
  dataAsOf: string;
  sourceWatermark: number;
  dataVersion: number;
  filterHash: string;
  sourceMode: 'live' | 'snapshot-fallback';
}

export interface TrafficPaxMetrics {
  /** NULL means no Pax value was reported in this aggregate scope. */
  reportedPax: number | null;
  /** Includes true-zero Pax rows because Pax 0 is reported data. */
  reportedLegs: number;
  dueLegs: number;
  missingDueLegs: number;
  trueZeroReportedLegs: number;
}

export interface TrafficV2MetricSet extends TrafficPaxMetrics {
  flights: number;
  arrivals: number;
  departures: number;
  arrivalReportedPax?: number | null;
  departureReportedPax?: number | null;
  status: 'complete' | 'partial' | 'missing' | 'future' | 'zero';
}

export interface TrafficV2TimelinePoint {
  opsDate: string;
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reportedPax: number | null;
  reportedLegs: number | null;
  dueLegs: number | null;
  missingDueLegs: number | null;
  trueZeroReportedLegs: number | null;
  status: TrafficV2MetricSet['status'];
}

export interface TrafficV2DimensionRow extends TrafficV2MetricSet {
  dimension: TrafficDimension;
  key: string;
  label: string;
  flightShare: number | null;
  paxShare: number | null;
}

export interface TrafficV2Bundle {
  version: TrafficVersionEnvelope;
  filter: NormalizedTrafficReportFilter;
  comparisonMode: TrafficComparison;
  timeBasis: TrafficTimeBasis;
  current: TrafficV2MetricSet;
  comparison: TrafficV2MetricSet & {
    from: string | null;
    to: string | null;
  };
  timeline: TrafficV2TimelinePoint[];
  dimensions: Partial<Record<TrafficDimension, TrafficV2DimensionRow[]>>;
  report: TrafficV2ReportParity;
}

export interface TrafficV2ReportParity {
  minOpsDate: string;
  maxOpsDate: string;
  latestCompletedOpsDate: string;
  dayCount: number;
  filterOptions: { airline: string[]; route: string[]; country: string[] };
  coverage: {
    selectedDayCount: number;
    coveredDayCount: number;
    partialDayCount: number;
    missingDayCount: number;
  };
  /** Present once the live v2 RPC publishes network scope counts. */
  coverageCounts?: { routes: number; airlines: number; countries: number };
  peakDay: { ops_date: string | null; flights: number | null; status: string };
  paxCoverage: {
    reported_legs: number;
    due_legs: number;
    percent: number | null;
    status: 'available' | 'unavailable';
  };
  quality: {
    unknown_country_legs: number;
    pax_due_missing_legs: number;
    quarantined_duplicate_candidates: number;
  };
  breakdowns: {
    aircraft_group: TrafficBreakdownRow[];
    aircraft_type: TrafficAircraftTypeBreakdownRow[];
    peak_hour: TrafficPeakHourRow[];
    peak_hour_monthly: TrafficMonthlyPeakRow[];
    day_of_week: TrafficDayOfWeekRow[];
    day_of_week_monthly: TrafficMonthlyDayOfWeekRow[];
    flight_category?: TrafficFlightCategoryRow[];
  };
}

export interface TrafficV2ApiEnvelope {
  contract_version: typeof TRAFFIC_REPORT_V2_CONTRACT_VERSION;
  read_version_token: string;
  data_as_of: string;
  source_watermark: number;
  data_version: number;
  filter_hash: string;
  source_mode: 'live' | 'snapshot-fallback';
  normalized_filter: {
    from: string;
    to: string;
    type: TrafficType;
    airline: string[];
    route: string[];
    country: string[];
    comp: TrafficComparison;
    tz: TrafficTimeBasis;
  };
  current: TrafficV2ApiMetricSet;
  comparison: TrafficV2ApiMetricSet & {
    from: string | null;
    to: string | null;
  };
  timeline: TrafficV2ApiTimelinePoint[];
  dimensions: Partial<Record<TrafficDimension, TrafficV2ApiDimensionRow[]>>;
  report: TrafficV2ApiReportParity;
}

export interface TrafficV2ApiReportParity {
  min_ops_date: string;
  max_ops_date: string;
  latest_completed_ops_date: string;
  day_count: number;
  filter_options: { airline: string[]; route: string[]; country: string[] };
  coverage: {
    selected_day_count: number;
    covered_day_count: number;
    partial_day_count: number;
    missing_day_count: number;
  };
  coverage_counts?: { routes: number; airlines: number; countries: number };
  peak_day: TrafficV2ReportParity['peakDay'];
  pax_coverage: TrafficV2ReportParity['paxCoverage'];
  quality: TrafficV2ReportParity['quality'];
  breakdowns: TrafficV2ReportParity['breakdowns'];
}

export interface TrafficV2ApiMetricSet {
  flights: number;
  arrivals: number;
  departures: number;
  reported_pax: number | null;
  arrival_reported_pax?: number | null;
  departure_reported_pax?: number | null;
  reported_legs: number;
  due_legs: number;
  missing_due_legs: number;
  true_zero_reported_legs: number;
  status: TrafficV2MetricSet['status'];
}

export interface TrafficV2ApiTimelinePoint {
  ops_date: string;
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reported_pax: number | null;
  reported_legs: number | null;
  due_legs: number | null;
  missing_due_legs: number | null;
  true_zero_reported_legs: number | null;
  status: TrafficV2MetricSet['status'];
}

export interface TrafficV2ApiDimensionRow extends TrafficV2ApiMetricSet {
  dimension: TrafficDimension;
  key: string;
  label: string;
  flight_share: number | null;
  pax_share: number | null;
}

export interface TrafficV2ApiMonthlyTimelinePoint {
  month: string;
  from: string;
  to: string;
  selected_day_count: number;
  complete_day_count: number;
  partial_day_count: number;
  missing_day_count: number;
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reported_pax: number | null;
  reported_legs: number;
  due_legs: number;
  missing_due_legs: number;
  true_zero_reported_legs: number;
  period_status?: 'complete' | 'partial';
  status: TrafficV2MetricSet['status'];
}

export interface TrafficDimensionShareRow {
  key?: string;
  label: string;
  value: number;
  share: number;
}

export interface TrafficDimensionShareResponse {
  contract_version: typeof TRAFFIC_REPORT_V2_CONTRACT_VERSION;
  dimension: TrafficDimension;
  metric: 'flights' | 'reported_pax';
  type: TrafficType;
  limit: 10;
  total_value: number | null;
  top_rows: TrafficDimensionShareRow[];
  other: TrafficDimensionShareRow | null;
  source_watermark: number;
  read_version_token: string;
}

export type TrafficV2LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; bundle: TrafficV2Bundle }
  | { status: 'empty'; version: TrafficVersionEnvelope; filter: NormalizedTrafficReportFilter }
  | { status: 'version-changed'; expectedWatermark: number; actualWatermark: number }
  | { status: 'error'; message: string; retryable: boolean };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isMetricStatus(value: unknown): value is TrafficV2MetricSet['status'] {
  return ['complete', 'partial', 'missing', 'future', 'zero'].includes(String(value));
}

function isApiMetric(value: unknown): value is TrafficV2ApiMetricSet {
  if (!isObject(value)) return false;
  if (!isNonNegativeInteger(value.flights)
    || !isNonNegativeInteger(value.arrivals)
    || !isNonNegativeInteger(value.departures)
    || !isNullableFiniteNumber(value.reported_pax)
    || (value.arrival_reported_pax !== undefined && !isNullableFiniteNumber(value.arrival_reported_pax))
    || (value.departure_reported_pax !== undefined && !isNullableFiniteNumber(value.departure_reported_pax))
    || !isNonNegativeInteger(value.reported_legs)
    || !isNonNegativeInteger(value.due_legs)
    || !isNonNegativeInteger(value.missing_due_legs)
    || !isNonNegativeInteger(value.true_zero_reported_legs)
    || !isMetricStatus(value.status)) return false;

  if (value.arrivals + value.departures !== value.flights) return false;
  if (value.reported_legs === 0 && value.reported_pax !== null) return false;
  if (value.reported_legs > 0 && value.reported_pax === null) return false;
  if (value.true_zero_reported_legs > value.reported_legs) return false;
  if (value.missing_due_legs > value.due_legs) return false;
  return true;
}

function isApiTimelinePoint(value: unknown): value is TrafficV2ApiTimelinePoint {
  if (!isObject(value) || !ISO_DATE.test(String(value.ops_date)) || !isMetricStatus(value.status)) return false;
  if (value.flights === null) {
    return (value.status === 'missing' || value.status === 'future')
      && value.arrivals === null
      && value.departures === null
      && value.reported_pax === null
      && value.reported_legs === null
      && value.due_legs === null
      && value.missing_due_legs === null
      && value.true_zero_reported_legs === null;
  }
  return isApiMetric(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableNonNegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isWeekdayRow(value: unknown): boolean {
  if (!isObject(value)
    || !Number.isInteger(value.day_index)
    || Number(value.day_index) < 1
    || Number(value.day_index) > 7
    || !isNonNegativeInteger(value.calendar_days)
    || !isNonNegativeInteger(value.complete_day_count)
    || Number(value.complete_day_count) > Number(value.calendar_days)
    || !['complete', 'partial', 'missing'].includes(String(value.status))) return false;
  return [
    'total_flights', 'average_flights', 'min_flights', 'max_flights',
    'arrivals', 'average_arrivals', 'min_arrivals', 'max_arrivals',
    'departures', 'average_departures', 'min_departures', 'max_departures',
  ].every((field) => isNullableNonNegativeNumber(value[field]));
}

function isMonthlyWeekdayRow(value: unknown): boolean {
  return isObject(value)
    && /^\d{4}-\d{2}$/u.test(String(value.month))
    && Number.isInteger(value.day_index)
    && Number(value.day_index) >= 1
    && Number(value.day_index) <= 7
    && isNonNegativeInteger(value.selected_day_count)
    && isNonNegativeInteger(value.complete_day_count)
    && Number(value.complete_day_count) <= Number(value.selected_day_count)
    && isNullableNonNegativeNumber(value.average_flights)
    && isNullableNonNegativeNumber(value.average_arrivals)
    && isNullableNonNegativeNumber(value.average_departures)
    && ['complete', 'partial', 'missing'].includes(String(value.status))
    && typeof value.is_peak_all === 'boolean'
    && typeof value.is_peak_arrivals === 'boolean'
    && typeof value.is_peak_departures === 'boolean';
}

function isNormalizedFilter(value: unknown): value is TrafficV2ApiEnvelope['normalized_filter'] {
  if (!isObject(value)) return false;
  return ISO_DATE.test(String(value.from))
    && ISO_DATE.test(String(value.to))
    && String(value.from) <= String(value.to)
    && ['all', 'A', 'D'].includes(String(value.type))
    && isStringArray(value.airline)
    && isStringArray(value.route)
    && isStringArray(value.country)
    && ['previous', 'year_ago', 'none'].includes(String(value.comp))
    && ['local', 'utc'].includes(String(value.tz));
}

function isApiReportParity(value: unknown): value is TrafficV2ApiReportParity {
  if (!isObject(value)
    || !ISO_DATE.test(String(value.min_ops_date))
    || !ISO_DATE.test(String(value.max_ops_date))
    || !ISO_DATE.test(String(value.latest_completed_ops_date))
    || String(value.min_ops_date) > String(value.max_ops_date)
    || !isNonNegativeInteger(value.day_count)
    || !isObject(value.filter_options)
    || !isStringArray(value.filter_options.airline)
    || !isStringArray(value.filter_options.route)
    || !isStringArray(value.filter_options.country)
    || !isObject(value.coverage)
    || !isNonNegativeInteger(value.coverage.selected_day_count)
    || !isNonNegativeInteger(value.coverage.covered_day_count)
    || !isNonNegativeInteger(value.coverage.partial_day_count)
    || !isNonNegativeInteger(value.coverage.missing_day_count)
    || (value.coverage_counts !== undefined && (
      !isObject(value.coverage_counts)
      || !isNonNegativeInteger(value.coverage_counts.routes)
      || !isNonNegativeInteger(value.coverage_counts.airlines)
      || !isNonNegativeInteger(value.coverage_counts.countries)
    ))
    || !isObject(value.peak_day)
    || !isObject(value.pax_coverage)
    || !isObject(value.quality)
    || !isObject(value.breakdowns)) return false;
  return Array.isArray(value.breakdowns.aircraft_group)
    && Array.isArray(value.breakdowns.aircraft_type)
    && Array.isArray(value.breakdowns.peak_hour)
    && value.breakdowns.peak_hour.length === 24
    && Array.isArray(value.breakdowns.peak_hour_monthly)
    && Array.isArray(value.breakdowns.day_of_week)
    && value.breakdowns.day_of_week.length === 7
    && value.breakdowns.day_of_week.every(isWeekdayRow)
    && new Set(value.breakdowns.day_of_week.map((row) => String((row as Record<string, unknown>).day_index))).size === 7
    && Array.isArray(value.breakdowns.day_of_week_monthly)
    && value.breakdowns.day_of_week_monthly.every(isMonthlyWeekdayRow)
    && (value.breakdowns.flight_category === undefined || (
      Array.isArray(value.breakdowns.flight_category)
      && value.breakdowns.flight_category.every(isTrafficFlightCategoryRow)
    ));
}

export function isTrafficV2ApiMonthlyTimelinePoint(value: unknown): value is TrafficV2ApiMonthlyTimelinePoint {
  if (!isObject(value)
    || !/^\d{4}-\d{2}$/u.test(String(value.month))
    || !ISO_DATE.test(String(value.from))
    || !ISO_DATE.test(String(value.to))
    || String(value.from) > String(value.to)
    || !isNonNegativeInteger(value.selected_day_count)
    || !isNonNegativeInteger(value.complete_day_count)
    || !isNonNegativeInteger(value.partial_day_count)
    || !isNonNegativeInteger(value.missing_day_count)
    || !isNullableNonNegativeNumber(value.flights)
    || !isNullableNonNegativeNumber(value.arrivals)
    || !isNullableNonNegativeNumber(value.departures)
    || !isNullableNonNegativeNumber(value.reported_pax)
    || !isNonNegativeInteger(value.reported_legs)
    || !isNonNegativeInteger(value.due_legs)
    || !isNonNegativeInteger(value.missing_due_legs)
    || !isNonNegativeInteger(value.true_zero_reported_legs)
    || (value.period_status !== undefined && !['complete', 'partial'].includes(String(value.period_status)))
    || !isMetricStatus(value.status)) return false;
  return Number(value.complete_day_count) + Number(value.partial_day_count) + Number(value.missing_day_count)
    <= Number(value.selected_day_count);
}

export function isTrafficDimensionShareResponse(value: unknown): value is TrafficDimensionShareResponse {
  if (!isObject(value)
    || value.contract_version !== TRAFFIC_REPORT_V2_CONTRACT_VERSION
    || !['route', 'country', 'airline'].includes(String(value.dimension))
    || !['flights', 'reported_pax'].includes(String(value.metric))
    || !['all', 'A', 'D'].includes(String(value.type))
    || value.limit !== 10
    || !isNullableNonNegativeNumber(value.total_value)
    || !Array.isArray(value.top_rows)
    || value.top_rows.length > 10
    || !isNonNegativeInteger(value.source_watermark)
    || typeof value.read_version_token !== 'string') return false;
  const rowValid = (row: unknown) => isObject(row)
    && typeof row.label === 'string'
    && typeof row.value === 'number'
    && Number.isFinite(row.value)
    && row.value >= 0
    && typeof row.share === 'number'
    && Number.isFinite(row.share)
    && row.share >= 0
    && row.share <= 1;
  if (!value.top_rows.every(rowValid) || (value.other !== null && !rowValid(value.other))) return false;
  if (value.total_value === null || value.total_value === 0) return value.top_rows.length === 0 && value.other === null;
  const rows = [...value.top_rows, ...(value.other === null ? [] : [value.other])];
  const share = rows.reduce((sum, row) => sum + Number((row as Record<string, unknown>).share), 0);
  return Math.abs(share - 1) < 0.000001;
}

export function isTrafficV2ApiEnvelope(value: unknown): value is TrafficV2ApiEnvelope {
  if (!isObject(value)
    || value.contract_version !== TRAFFIC_REPORT_V2_CONTRACT_VERSION
    || typeof value.read_version_token !== 'string'
    || !/^rv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.read_version_token)
    || typeof value.data_as_of !== 'string'
    || Number.isNaN(Date.parse(value.data_as_of))
    || !isNonNegativeInteger(value.source_watermark)
    || !isNonNegativeInteger(value.data_version)
    || typeof value.filter_hash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.filter_hash)
    || !['live', 'snapshot-fallback'].includes(String(value.source_mode))
    || !isNormalizedFilter(value.normalized_filter)
    || !isApiMetric(value.current)
    || !isApiMetric(value.comparison)
    || !Array.isArray(value.timeline)
    || !value.timeline.every(isApiTimelinePoint)
    || !isObject(value.dimensions)
    || !isApiReportParity(value.report)) return false;

  const dayCount = Math.round((Date.parse(`${value.normalized_filter.to}T00:00:00Z`)
    - Date.parse(`${value.normalized_filter.from}T00:00:00Z`)) / 86_400_000) + 1;
  if (value.timeline.length !== dayCount) return false;

  for (const [dimension, rows] of Object.entries(value.dimensions)) {
    if (!['airline', 'route', 'country'].includes(dimension) || !Array.isArray(rows)) return false;
    if (!rows.every((row) => isApiMetric(row)
      && isObject(row)
      && row.dimension === dimension
      && typeof row.key === 'string'
      && typeof row.label === 'string'
      && isNullableFiniteNumber(row.flight_share)
      && isNullableFiniteNumber(row.pax_share))) return false;
  }
  return true;
}

function mapMetric(metric: TrafficV2ApiMetricSet): TrafficV2MetricSet {
  return {
    flights: metric.flights,
    arrivals: metric.arrivals,
    departures: metric.departures,
    reportedPax: metric.reported_pax,
    arrivalReportedPax: metric.arrival_reported_pax,
    departureReportedPax: metric.departure_reported_pax,
    reportedLegs: metric.reported_legs,
    dueLegs: metric.due_legs,
    missingDueLegs: metric.missing_due_legs,
    trueZeroReportedLegs: metric.true_zero_reported_legs,
    status: metric.status,
  };
}

function mapTimelinePoint(metric: TrafficV2ApiTimelinePoint): TrafficV2TimelinePoint {
  return {
    opsDate: metric.ops_date,
    flights: metric.flights,
    arrivals: metric.arrivals,
    departures: metric.departures,
    reportedPax: metric.reported_pax,
    reportedLegs: metric.reported_legs,
    dueLegs: metric.due_legs,
    missingDueLegs: metric.missing_due_legs,
    trueZeroReportedLegs: metric.true_zero_reported_legs,
    status: metric.status,
  };
}

export function decodeTrafficV2ApiEnvelope(value: unknown): TrafficV2Bundle {
  if (!isTrafficV2ApiEnvelope(value)) throw new Error('Payload traffic-report-v2 không hợp lệ.');
  const dimensions = Object.fromEntries(Object.entries(value.dimensions).map(([dimension, rows]) => [
    dimension,
    rows?.map((row) => ({
      ...mapMetric(row),
      dimension: row.dimension,
      key: row.key,
      label: row.label,
      flightShare: row.flight_share,
      paxShare: row.pax_share,
    })),
  ])) as TrafficV2Bundle['dimensions'];
  return {
    version: {
      contractVersion: value.contract_version,
      readVersionToken: value.read_version_token,
      dataAsOf: value.data_as_of,
      sourceWatermark: value.source_watermark,
      dataVersion: value.data_version,
      filterHash: value.filter_hash,
      sourceMode: value.source_mode,
    },
    filter: value.normalized_filter,
    comparisonMode: value.normalized_filter.comp,
    timeBasis: value.normalized_filter.tz,
    current: mapMetric(value.current),
    comparison: {
      ...mapMetric(value.comparison),
      from: value.comparison.from,
      to: value.comparison.to,
    },
    timeline: value.timeline.map(mapTimelinePoint),
    dimensions,
    report: {
      minOpsDate: value.report.min_ops_date,
      maxOpsDate: value.report.max_ops_date,
      latestCompletedOpsDate: value.report.latest_completed_ops_date,
      dayCount: value.report.day_count,
      filterOptions: value.report.filter_options,
      coverage: {
        selectedDayCount: value.report.coverage.selected_day_count,
        coveredDayCount: value.report.coverage.covered_day_count,
        partialDayCount: value.report.coverage.partial_day_count,
        missingDayCount: value.report.coverage.missing_day_count,
      },
      coverageCounts: value.report.coverage_counts,
      peakDay: value.report.peak_day,
      paxCoverage: value.report.pax_coverage,
      quality: value.report.quality,
      breakdowns: value.report.breakdowns,
    },
  };
}
