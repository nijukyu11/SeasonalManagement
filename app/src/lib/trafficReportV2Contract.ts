import type {
  NormalizedTrafficReportFilter,
  TrafficComparison,
  TrafficDimension,
  TrafficTimeBasis,
  TrafficType,
} from './trafficReportContract';

export const TRAFFIC_REPORT_V2_CONTRACT_VERSION = 'traffic-report-v2' as const;
export const TRAFFIC_REPORT_V2_API_BASE = '/api/report/v2' as const;

export interface TrafficVersionEnvelope {
  contractVersion: typeof TRAFFIC_REPORT_V2_CONTRACT_VERSION;
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
}

export interface TrafficV2ApiEnvelope {
  contract_version: typeof TRAFFIC_REPORT_V2_CONTRACT_VERSION;
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
}

export interface TrafficV2ApiMetricSet {
  flights: number;
  arrivals: number;
  departures: number;
  reported_pax: number | null;
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
    return value.status === 'missing'
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

export function isTrafficV2ApiEnvelope(value: unknown): value is TrafficV2ApiEnvelope {
  if (!isObject(value)
    || value.contract_version !== TRAFFIC_REPORT_V2_CONTRACT_VERSION
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
    || !isObject(value.dimensions)) return false;

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
  };
}
