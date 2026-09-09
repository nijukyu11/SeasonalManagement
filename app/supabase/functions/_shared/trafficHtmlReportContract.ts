import { normalizeWorkbookRequest, type WorkbookReportType } from './trafficWorkbookCore.ts';

export const HTML_DATA_VERSION = 'traffic-html-data-v2';
export const HTML_MAX_ROWS = 250_000;
export const HTML_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_TEMPLATES: Record<WorkbookReportType, string> = {
  MASTER_OPERATIONS: 'period-analysis-v1', MONTHLY_OVERVIEW_L2: 'period-analysis-v1',
  PERIOD_ANALYSIS: 'period-analysis-v1', WEEKLY_DETAIL: 'weekly-detail-v1', BAO_CAO_SAN_LUONG: 'bao-cao-san-luong-v1',
};

export function normalizeHtmlRequest(url: URL) {
  const copy = new URL(url);
  const type = copy.searchParams.get('report_type') as WorkbookReportType;
  if (!Object.hasOwn(HTML_TEMPLATES, type) || copy.searchParams.getAll('html_template').length !== 1
    || copy.searchParams.get('html_template') !== HTML_TEMPLATES[type]
    || copy.searchParams.has('template_version')) throw new Error('invalid HTML template');
  copy.searchParams.delete('html_template');
  // Reuse the validated calendar rules, not an Excel manifest or renderer.
  copy.searchParams.set('template_version', type === 'MASTER_OPERATIONS' ? 'master-v1'
    : type === 'MONTHLY_OVERVIEW_L2' ? 'monthly-l2-v1' : HTML_TEMPLATES[type]);
  const normalized = normalizeWorkbookRequest(copy);
  for (const value of [normalized.from, normalized.to]) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('invalid HTML date');
  }
  if (normalized.comparisonYears.some((year) => year >= Number(normalized.from.slice(0, 4)))) throw new Error('comparison year must be in the past');
  return {
    contract_version: HTML_DATA_VERSION, html_template: HTML_TEMPLATES[type], report_type: type,
    period_mode: normalized.periodMode, from: normalized.from, to: normalized.to,
    season_code: normalized.seasonCode, month: normalized.month, month_from: normalized.monthFrom,
    month_to: normalized.monthTo, year: normalized.year, comparison_years: normalized.comparisonYears,
    comparisons: normalized.comparisons, airlines: normalized.airlines, routes: normalized.routes,
    countries: normalized.countries, time_basis: normalized.timeBasis,
  };
}
export type HtmlRequest = ReturnType<typeof normalizeHtmlRequest>;
export type Direction = 'A' | 'D' | 'all';
export type Dataset = 'kpi' | 'timeline' | 'market' | 'market_daily' | 'aircraft' | 'hours' | 'frequency';
export type HtmlMetric = {
  flights: number | null; reported_pax: number | null;
  reported_legs: number; due_legs: number; missing_due_legs: number;
  true_zero_reported_legs: number; unreported_legs: number | null;
  flight_coverage: 'complete' | 'partial' | 'missing';
  pax_status: 'complete' | 'partial' | 'missing';
};
export type HtmlRow = HtmlMetric & {
  direction: Direction; grain: Record<string, string | number | null>;
  operating_days?: number[]; occurrence_days?: number; eligible_days?: number;
  consistency_percent?: number; typical_time?: string;
};
export type HtmlPeriod = {
  id: string; role: 'current' | 'previous' | 'next' | 'comparison' | 'analysis-week';
  from: string; to: string; calendar_days: number; label: string; contains_future: boolean;
};
export type HtmlPair = { id: string; minuend_period: string; baseline_period: string };
export type HtmlCalendarDay = { period_id: string; date: string; month: string; iso_week: string; business_week: string };
export type HtmlResource = {
  dataset: Dataset; period_id: string; filter_hash: string; normalized_filter: Record<string, unknown>;
  complete: boolean; row_count: number; totals: HtmlRow[]; rows: HtmlRow[];
};
export type HtmlEnvelope = {
  contract_version: typeof HTML_DATA_VERSION; source_mode: 'live'; source_watermark: string;
  data_version: number; data_as_of: string; snapshot_scope: 'single-statement';
  normalized_request: HtmlRequest; request_hash: string; periods: HtmlPeriod[];
  comparison_pairs: HtmlPair[]; calendar: HtmlCalendarDay[]; resources: HtmlResource[];
};

// These pure functions are also embedded in the offline runtime. No hidden row totals.
export function sumHtmlMetrics(rows: HtmlMetric[], emptyCoverage: HtmlMetric['flight_coverage'] = 'missing'): HtmlMetric {
  const sum = (key: 'flights' | 'reported_pax') => {
    const values = rows.map((row) => row[key]).filter((n): n is number => n !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : rows.length === 0 && key === 'flights' && emptyCoverage === 'complete' ? 0 : null;
  };
  const count = (key: 'reported_legs' | 'due_legs' | 'missing_due_legs' | 'true_zero_reported_legs') => rows.reduce((a, row) => a + row[key], 0);
  const flights = sum('flights');
  return { flights, reported_pax: sum('reported_pax'), reported_legs: count('reported_legs'), due_legs: count('due_legs'),
    missing_due_legs: count('missing_due_legs'), true_zero_reported_legs: count('true_zero_reported_legs'),
    unreported_legs: flights == null ? null : flights - count('reported_legs'),
    pax_status: count('reported_legs')===0?'missing':flights===count('reported_legs')?'complete':'partial',
    flight_coverage: !rows.length ? emptyCoverage : rows.some((r) => r.flight_coverage === 'missing') ? 'missing'
      : rows.some((r) => r.flight_coverage === 'partial') ? 'partial' : 'complete' };
}
export function compareHtmlMetrics(current: HtmlMetric, baseline: HtmlMetric, key: 'flights' | 'reported_pax') {
  const a = current[key], b = baseline[key];
  const valid = a !== null && b !== null && current.flight_coverage === 'complete' && baseline.flight_coverage === 'complete'
    && (key === 'flights' || (current.unreported_legs === 0 && baseline.unreported_legs === 0));
  return { delta: valid ? a! - b! : null, percent: valid && b !== 0 ? (a! - b!) / b! : null };
}
