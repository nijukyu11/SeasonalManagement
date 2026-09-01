export const TRAFFIC_REPORT_CONTRACT_VERSION = 'traffic-report-v1' as const;
export const TRAFFIC_REPORT_API_BASE = '/api/report/v1' as const;
export type TrafficReportContractVersion = typeof TRAFFIC_REPORT_CONTRACT_VERSION | 'traffic-report-v2';

export type TrafficType = 'all' | 'A' | 'D';
export type TrafficComparison = 'previous' | 'year_ago' | 'none';
export type TrafficTimeBasis = 'local' | 'utc';
export type TrafficDatePreset = '7d' | '30d' | 'ytd';
export type TrafficMarketDimension = 'route' | 'country';
export type TrafficDimension = TrafficMarketDimension | 'airline';
export type TrafficDimensionSort = 'flights' | 'reported_pax' | 'flight_share' | 'pax_share' | 'label';

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

export interface TrafficReportPageState {
  filter: TrafficReportFilter;
  trendType: TrafficType;
  marketDimension: TrafficMarketDimension;
  marketType: TrafficType;
  airlineType: TrafficType;
}

export interface TrafficMetricSet {
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reported_pax: number | null;
  status?: 'complete' | 'partial' | 'missing' | 'future' | 'zero' | 'unavailable' | 'suppressed';
}

export interface TrafficKpiMetricSet extends TrafficMetricSet {
  arrival_reported_pax?: number | null;
  departure_reported_pax?: number | null;
}

export interface TrafficTimelinePoint extends TrafficMetricSet {
  ops_date: string;
  completeness: 'complete' | 'missing' | 'partial';
  reported_legs?: number | null;
  due_legs?: number | null;
  pax_coverage_pct?: number | null;
  pax_status?: 'available' | 'not_due' | 'unavailable' | 'suppressed';
  suppressed?: boolean;
}

export interface TrafficBreakdownRow extends TrafficMetricSet {
  key: string;
  label: string;
  share: number | null;
  suppressed: boolean;
}

export interface TrafficAircraftTypeBreakdownRow extends TrafficBreakdownRow {
  aircraft_group_key: string;
  aircraft_group: string;
}

export interface TrafficDimensionRow extends TrafficMetricSet {
  key: string;
  label: string;
  flight_share: number | null;
  pax_share: number | null;
  reported_legs: number | null;
  due_legs: number | null;
  pax_coverage_pct: number | null;
  pax_status: 'available' | 'not_due' | 'unavailable' | 'suppressed';
  suppressed: boolean;
}

export interface TrafficDimensionResponse {
  contract_version: TrafficReportContractVersion;
  request_hash: string;
  data_as_of: string;
  dimension: TrafficDimension;
  type: TrafficType;
  page: number;
  page_size: number;
  total_rows: number;
  has_more: boolean;
  rows: TrafficDimensionRow[];
}

export interface TrafficPeakHourRow {
  hour_bucket: string;
  bucket_minutes: 60;
  time_basis: TrafficTimeBasis;
  arrivals: number | null;
  departures: number | null;
  regular_flights?: {
    arrivals: TrafficRegularFlight[];
    departures: TrafficRegularFlight[];
  };
  suppressed: boolean;
}

export interface TrafficRegularFlight {
  airline: string;
  flight_number: string;
  route: string;
  typical_time: string;
  operating_days: Array<1 | 2 | 3 | 4 | 5 | 6 | 7>;
  occurrence_days: number;
  eligible_days: number;
  consistency_percent: number;
}

export interface TrafficMonthlyPeakRow {
  month: string;
  time_basis: TrafficTimeBasis;
  arrival_hour: string | null;
  arrival_flights: number | null;
  departure_hour: string | null;
  departure_flights: number | null;
  arrival_suppressed: boolean;
  departure_suppressed: boolean;
}

export interface TrafficDayOfWeekRow {
  day_index: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  calendar_days: number | null;
  total_flights: number | null;
  average_flights: number | null;
  min_flights: number | null;
  max_flights: number | null;
  arrivals: number | null;
  departures: number | null;
  suppressed: boolean;
}

export interface TrafficReportBundle {
  contract_version: TrafficReportContractVersion;
  request_hash: string;
  data_as_of: string;
  source_watermark: number | 'unknown';
  metadata: {
    min_ops_date: string;
    max_ops_date: string;
    latest_completed_ops_date?: string;
    normalized_filter: NormalizedTrafficReportFilter;
    day_count: number;
    timeline_granularity: 'day';
    timeline_has_more: boolean;
    timeline_next_cursor: string | null;
    filter_options: {
      airline: string[];
      route: string[];
      country?: string[];
    };
    available_dimensions?: TrafficDimension[];
    projection?: {
      status: 'fresh' | 'stale' | 'failed' | 'empty';
      source_data_version: number | null;
      current_data_version: number | null;
      source_watermark: number | null;
      current_watermark: number | null;
      refreshed_at: string | null;
      snapshot_rows: number | null;
    };
    selected_day_count?: number;
    covered_day_count?: number;
    partial_day_count?: number;
    missing_day_count?: number;
    filter_options_limit: 250;
  };
  kpis: {
    current: TrafficKpiMetricSet;
    comparison: TrafficKpiMetricSet & {
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
    aircraft_type?: TrafficAircraftTypeBreakdownRow[];
    peak_hour: TrafficPeakHourRow[];
    peak_hour_monthly?: TrafficMonthlyPeakRow[];
    day_of_week: TrafficDayOfWeekRow[];
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
const PAGE_ONLY_PARAMS = ['trend_type', 'market_dimension', 'market_type', 'airline_type'] as const;
const PAGE_ALLOWED_PARAMS = new Set([...ALLOWED_PARAMS, ...PAGE_ONLY_PARAMS]);

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

function parseTrafficType(value: string | null, fallback: TrafficType): TrafficType {
  const resolved = value ?? fallback;
  if (!['all', 'A', 'D'].includes(resolved)) throw new Error('Phạm vi chuyến bay không hợp lệ.');
  return resolved as TrafficType;
}

export function parseTrafficReportPageState(input: URLSearchParams): TrafficReportPageState {
  for (const key of input.keys()) {
    if (!PAGE_ALLOWED_PARAMS.has(key)) throw new Error(`Tham số không được hỗ trợ: ${key}`);
  }
  const apiParams = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    for (const value of input.getAll(key)) apiParams.append(key, value);
  }
  const legacyType = parseTrafficType(input.get('type'), 'all');
  apiParams.delete('type');
  const filter = parseTrafficReportSearchParams(apiParams);
  const marketDimension = input.get('market_dimension') ?? 'route';
  if (!['route', 'country'].includes(marketDimension)) throw new Error('Chiều phân tích thị trường không hợp lệ.');
  return {
    filter: { ...filter, type: 'all' },
    trendType: parseTrafficType(input.get('trend_type'), legacyType),
    marketDimension: marketDimension as TrafficMarketDimension,
    marketType: parseTrafficType(input.get('market_type'), legacyType),
    airlineType: parseTrafficType(input.get('airline_type'), legacyType),
  };
}

export function toTrafficReportPageSearchParams(state: TrafficReportPageState): URLSearchParams {
  const output = toTrafficReportSearchParams({ ...state.filter, type: 'all' });
  if (state.trendType !== 'all') output.set('trend_type', state.trendType);
  if (state.marketDimension !== 'route') output.set('market_dimension', state.marketDimension);
  if (state.marketType !== 'all') output.set('market_type', state.marketType);
  if (state.airlineType !== 'all') output.set('airline_type', state.airlineType);
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

export function buildTimelineUrl(filter: TrafficReportFilter, type: TrafficType, after?: string | null, pageSize = 732): string {
  const query = toTrafficReportSearchParams({ ...filter, type });
  if (after) query.set('after', after);
  query.set('page_size', String(pageSize));
  return `${TRAFFIC_REPORT_API_BASE}/timeline?${query.toString()}`;
}

export function buildDimensionUrl(
  filter: TrafficReportFilter,
  dimension: TrafficDimension,
  type: TrafficType,
  sort: TrafficDimensionSort,
  page = 1,
  pageSize = 50,
  exportCsv = false,
): string {
  if (!filter.from || !filter.to) throw new Error('Phạm vi ngày chưa sẵn sàng.');
  const query = toTrafficReportSearchParams({ ...filter, type });
  query.set('dimension', dimension);
  if (sort !== 'flights') query.set('sort', sort);
  if (page !== 1) query.set('page', String(page));
  query.set('page_size', String(pageSize));
  return `${TRAFFIC_REPORT_API_BASE}/${exportCsv ? 'dimension-export' : 'dimension'}?${query.toString()}`;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isTrafficAircraftTypeBreakdownRow(value: unknown): value is TrafficAircraftTypeBreakdownRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.key === 'string'
    && typeof row.aircraft_group_key === 'string'
    && typeof row.aircraft_group === 'string'
    && typeof row.label === 'string'
    && isNullableNumber(row.flights)
    && isNullableNumber(row.arrivals)
    && isNullableNumber(row.departures)
    && isNullableNumber(row.reported_pax)
    && isNullableNumber(row.share)
    && typeof row.suppressed === 'boolean';
}

function isTrafficRegularFlight(value: unknown): value is TrafficRegularFlight {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.airline === 'string'
    && typeof row.flight_number === 'string'
    && typeof row.route === 'string'
    && /^\d{2}:\d{2}$/.test(String(row.typical_time))
    && Array.isArray(row.operating_days)
    && row.operating_days.every((day) => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7)
    && typeof row.occurrence_days === 'number'
    && typeof row.eligible_days === 'number'
    && typeof row.consistency_percent === 'number';
}

function isTrafficPeakHourRow(value: unknown): value is TrafficPeakHourRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const regularFlights = row.regular_flights;
  const regularFlightsAreValid = regularFlights === undefined || (
    !!regularFlights
    && typeof regularFlights === 'object'
    && !Array.isArray(regularFlights)
    && Array.isArray((regularFlights as Record<string, unknown>).arrivals)
    && ((regularFlights as Record<string, unknown>).arrivals as unknown[]).every(isTrafficRegularFlight)
    && Array.isArray((regularFlights as Record<string, unknown>).departures)
    && ((regularFlights as Record<string, unknown>).departures as unknown[]).every(isTrafficRegularFlight)
  );
  return /^\d{2}:\d{2}$/.test(String(row.hour_bucket))
    && row.bucket_minutes === 60
    && ['local', 'utc'].includes(String(row.time_basis))
    && isNullableNumber(row.arrivals)
    && isNullableNumber(row.departures)
    && regularFlightsAreValid
    && typeof row.suppressed === 'boolean';
}

export function isTrafficReportBundle(value: unknown): value is TrafficReportBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  const metadata = root.metadata && typeof root.metadata === 'object' && !Array.isArray(root.metadata)
    ? root.metadata as Record<string, unknown>
    : null;
  const projection = metadata?.projection;
  const breakdowns = root.breakdowns && typeof root.breakdowns === 'object' && !Array.isArray(root.breakdowns)
    ? root.breakdowns as Record<string, unknown>
    : null;
  const projectionIsValid = projection === undefined || (
    !!projection
    && typeof projection === 'object'
    && !Array.isArray(projection)
    && ['fresh', 'stale', 'failed', 'empty'].includes(String((projection as Record<string, unknown>).status))
  );
  return [TRAFFIC_REPORT_CONTRACT_VERSION, 'traffic-report-v2'].includes(String(root.contract_version))
    && typeof root.request_hash === 'string'
    && typeof root.data_as_of === 'string'
    && !!metadata
    && projectionIsValid
    && !!root.kpis
    && Array.isArray(root.timeline)
    && !!breakdowns
    && Array.isArray(breakdowns.peak_hour)
    && breakdowns.peak_hour.every(isTrafficPeakHourRow)
    && (breakdowns.aircraft_type === undefined || (
      Array.isArray(breakdowns.aircraft_type)
      && breakdowns.aircraft_type.every(isTrafficAircraftTypeBreakdownRow)
    ));
}

export function isTrafficDimensionResponse(value: unknown): value is TrafficDimensionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return [TRAFFIC_REPORT_CONTRACT_VERSION, 'traffic-report-v2'].includes(String(root.contract_version))
    && ['route', 'country', 'airline'].includes(String(root.dimension))
    && ['all', 'A', 'D'].includes(String(root.type))
    && typeof root.page === 'number'
    && typeof root.total_rows === 'number'
    && Array.isArray(root.rows);
}
