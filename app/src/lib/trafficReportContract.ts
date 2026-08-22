export const TRAFFIC_REPORT_CONTRACT_VERSION = 'traffic-report-v1' as const;
export const TRAFFIC_REPORT_API_BASE = '/api/report/v1' as const;

export type TrafficType = 'all' | 'A' | 'D';
export type TrafficComparison = 'previous' | 'year_ago' | 'none';
export type TrafficTimeBasis = 'local' | 'utc';
export type TrafficDatePreset = '7d' | '30d' | 'ytd';

export interface TrafficReportFilter {
  from: string | null;
  to: string | null;
  type: TrafficType;
  airline: string[];
  route: string[];
  country: string[];
  comp: TrafficComparison;
  tz: TrafficTimeBasis;
}

export interface NormalizedTrafficReportFilter extends Omit<TrafficReportFilter, 'from' | 'to'> {
  from: string;
  to: string;
}

export interface TrafficMetricSet {
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reported_pax: number | null;
  status?: 'complete' | 'partial' | 'unavailable' | 'suppressed';
}

export interface TrafficTimelinePoint extends TrafficMetricSet {
  ops_date: string;
  completeness: 'complete' | 'missing' | 'partial';
}

export interface TrafficBreakdownRow extends TrafficMetricSet {
  key: string;
  label: string;
  share: number | null;
  suppressed: boolean;
}

export interface TrafficPeakHourRow {
  hour_bucket: string;
  bucket_minutes: 60;
  time_basis: TrafficTimeBasis;
  arrivals: number | null;
  departures: number | null;
  suppressed: boolean;
}

export interface TrafficReportBundle {
  contract_version: typeof TRAFFIC_REPORT_CONTRACT_VERSION;
  request_hash: string;
  data_as_of: string;
  source_watermark: number | 'unknown';
  metadata: {
    min_ops_date: string;
    max_ops_date: string;
    normalized_filter: NormalizedTrafficReportFilter;
    day_count: number;
    timeline_granularity: 'day';
    timeline_has_more: boolean;
    timeline_next_cursor: string | null;
  };
  kpis: {
    current: TrafficMetricSet;
    comparison: TrafficMetricSet & {
      from: string | null;
      to: string | null;
      mode: TrafficComparison;
    };
    peak_day: { ops_date: string | null; flights: number | null; status: string };
    pax_coverage: {
      reported_legs: number | null;
      due_legs: number | null;
      percent: number | null;
      status: 'available' | 'unavailable' | 'suppressed';
    };
  };
  timeline: TrafficTimelinePoint[];
  breakdowns: {
    airline: TrafficBreakdownRow[];
    route: TrafficBreakdownRow[];
    country: TrafficBreakdownRow[];
    aircraft_group: TrafficBreakdownRow[];
    peak_hour: TrafficPeakHourRow[];
  };
  quality: {
    unknown_country_legs: number | null;
    pax_due_missing_legs: number | null;
    quarantined_duplicate_candidates: number | null;
    notes: string[];
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_PARAMS = ['airline', 'route', 'country'] as const;
const ALLOWED_PARAMS = new Set(['from', 'to', 'type', ...LIST_PARAMS, 'comp', 'tz']);

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getLatestCompletedOpsDate(dataAsOf: string, maxOpsDate: string): string {
  if (!ISO_DATE.test(maxOpsDate)) throw new Error('Ngày Ops Date tối đa không hợp lệ.');
  const instant = new Date(dataAsOf);
  if (Number.isNaN(instant.getTime())) throw new Error('Mốc cập nhật dữ liệu không hợp lệ.');
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const latestCompleted = shiftIsoDate(`${dateParts.year}-${dateParts.month}-${dateParts.day}`, -1);
  return latestCompleted < maxOpsDate ? latestCompleted : maxOpsDate;
}

export function getTrafficReportPresetRange(
  preset: TrafficDatePreset,
  minOpsDate: string,
  maxOpsDate: string,
): Pick<NormalizedTrafficReportFilter, 'from' | 'to'> {
  if (!ISO_DATE.test(minOpsDate) || !ISO_DATE.test(maxOpsDate) || minOpsDate > maxOpsDate) {
    throw new Error('Phạm vi Ops Date hiện có không hợp lệ.');
  }
  const candidate = preset === 'ytd'
    ? `${maxOpsDate.slice(0, 4)}-01-01`
    : shiftIsoDate(maxOpsDate, preset === '7d' ? -6 : -29);
  return { from: candidate < minOpsDate ? minOpsDate : candidate, to: maxOpsDate };
}

export function detectTrafficReportDatePreset(
  from: string,
  to: string,
  minOpsDate: string,
  maxOpsDate: string,
): TrafficDatePreset | null {
  for (const preset of ['7d', '30d', 'ytd'] as const) {
    const range = getTrafficReportPresetRange(preset, minOpsDate, maxOpsDate);
    if (range.from === from && range.to === to) return preset;
  }
  return null;
}

function canonicalList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function parseTrafficReportSearchParams(input: URLSearchParams): TrafficReportFilter {
  for (const key of input.keys()) {
    if (!ALLOWED_PARAMS.has(key)) throw new Error(`Tham số không được hỗ trợ: ${key}`);
  }
  const from = input.get('from');
  const to = input.get('to');
  if ((from === null) !== (to === null)) throw new Error('Phải chọn cả ngày bắt đầu và ngày kết thúc.');
  if (from && (!ISO_DATE.test(from) || !ISO_DATE.test(to ?? ''))) throw new Error('Ngày phải có định dạng YYYY-MM-DD.');
  if (from && to && from > to) throw new Error('Ngày bắt đầu không được sau ngày kết thúc.');

  const type = input.get('type') ?? 'all';
  const comp = input.get('comp') ?? 'previous';
  const tz = input.get('tz') ?? 'local';
  if (!['all', 'A', 'D'].includes(type)) throw new Error('Bộ lọc loại chuyến không hợp lệ.');
  if (!['previous', 'year_ago', 'none'].includes(comp)) throw new Error('Kiểu so sánh không hợp lệ.');
  if (!['local', 'utc'].includes(tz)) throw new Error('Múi giờ không hợp lệ.');

  const lists = Object.fromEntries(LIST_PARAMS.map((key) => [key, canonicalList(input.getAll(key))]));
  return {
    from,
    to,
    type: type as TrafficType,
    airline: lists.airline,
    route: lists.route,
    country: lists.country,
    comp: comp as TrafficComparison,
    tz: tz as TrafficTimeBasis,
  };
}

export function toTrafficReportSearchParams(filter: TrafficReportFilter): URLSearchParams {
  const output = new URLSearchParams();
  if (filter.from && filter.to) {
    output.set('from', filter.from);
    output.set('to', filter.to);
  }
  if (filter.type !== 'all') output.set('type', filter.type);
  for (const key of LIST_PARAMS) {
    for (const value of canonicalList(filter[key])) output.append(key, value);
  }
  if (filter.comp !== 'previous') output.set('comp', filter.comp);
  if (filter.tz !== 'local') output.set('tz', filter.tz);
  return output;
}

export function withNormalizedDates(
  filter: TrafficReportFilter,
  normalized: Pick<NormalizedTrafficReportFilter, 'from' | 'to'>,
): NormalizedTrafficReportFilter {
  return { ...filter, from: normalized.from, to: normalized.to };
}

export function buildOverviewUrl(filter: TrafficReportFilter): string {
  const query = toTrafficReportSearchParams(filter).toString();
  return `${TRAFFIC_REPORT_API_BASE}/overview${query ? `?${query}` : ''}`;
}

export function isTrafficReportBundle(value: unknown): value is TrafficReportBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return root.contract_version === TRAFFIC_REPORT_CONTRACT_VERSION
    && typeof root.request_hash === 'string'
    && typeof root.data_as_of === 'string'
    && !!root.metadata
    && !!root.kpis
    && Array.isArray(root.timeline)
    && !!root.breakdowns;
}
