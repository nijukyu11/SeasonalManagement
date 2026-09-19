export const TRAFFIC_WORKBOOK_RENDERER_VERSION = 'traffic-workbook-renderer-v1' as const;
export const TRAFFIC_WORKBOOK_METRICS_CONTRACT_VERSION = 'traffic-report-v1' as const;

export type WorkbookReportType = 'MASTER_OPERATIONS' | 'MONTHLY_OVERVIEW_L2' | 'WEEKLY_DETAIL' | 'PERIOD_ANALYSIS' | 'BAO_CAO_SAN_LUONG';
export type WorkbookComparison = 'previous' | 'year_ago';
export type WorkbookPeriodMode = 'season' | 'custom' | 'month' | 'month_range' | 'year';
export type WorkbookTemplateVersion = 'master-v1' | 'monthly-l2-v1' | 'weekly-detail-v1' | 'period-analysis-v1' | 'bao-cao-san-luong-v1';

export interface WorkbookComparisonPeriod {
  id: string;
  comparisonYear: number;
  label: string;
  from: string;
  to: string;
  calendarDays: number;
}

export interface NormalizedWorkbookRequest {
  reportType: WorkbookReportType;
  templateVersion: WorkbookTemplateVersion;
  periodMode: WorkbookPeriodMode;
  seasonCode: string | null;
  month: string | null;
  monthFrom: string | null;
  monthTo: string | null;
  year: number | null;
  from: string;
  to: string;
  comparisons: WorkbookComparison[];
  comparisonYears: number[];
  timeBasis: 'local' | 'utc';
  airlines: string[];
  routes: string[];
  countries: string[];
  canonicalQuery: string;
}

export interface WorkbookMetricSet {
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reportedPax: number | null;
  arrivalReportedPax?: number | null;
  departureReportedPax?: number | null;
  status?: string | null;
}

export interface WorkbookDimensionRow extends WorkbookMetricSet {
  key: string;
  label: string;
  flightShare: number | null;
  paxShare: number | null;
  reportedLegs: number | null;
  dueLegs: number | null;
  paxCoverage: number | null;
  paxStatus: string | null;
  suppressed: boolean;
  previous?: WorkbookMetricSet | null;
  yearAgo?: WorkbookMetricSet | null;
  next?: WorkbookMetricSet | null;
}

export interface WorkbookTimelineRow extends WorkbookMetricSet {
  opsDate: string;
  contextPeriod?: 'previous' | 'selected' | 'next';
  completeness: string;
  reportedLegs: number | null;
  dueLegs: number | null;
  paxCoverage: number | null;
  paxStatus: string | null;
}

export interface WorkbookPeriodRow extends WorkbookMetricSet {
  key: string;
  from: string;
  to: string;
  calendarDays: number;
  averageFlights: number | null;
  completeness: string;
}

export interface WorkbookPeriodSnapshot {
  id: string;
  role: 'current' | 'comparison';
  label: string;
  comparisonYear: number | null;
  from: string;
  to: string;
  calendarDays: number;
  metrics: WorkbookMetricSet;
  timelineDaily: WorkbookTimelineRow[];
  airlines: WorkbookDimensionRow[];
  countries: WorkbookDimensionRow[];
  routes: WorkbookDimensionRow[];
  aircraftGroups: Array<Record<string, string | number | boolean | null>>;
  aircraftTypes: Array<Record<string, string | number | boolean | null>>;
  paxCoverage: { reportedLegs: number | null; dueLegs: number | null; percent: number | null; status: string | null };
}

export interface WorkbookBusinessWeekDimensions {
  id: string;
  label: string;
  from: string;
  to: string;
  partial: boolean;
  airlines: WorkbookDimensionRow[];
  countries: WorkbookDimensionRow[];
}

export interface WorkbookReportModel {
  metadata: {
    reportType: WorkbookReportType;
    templateVersion: string;
    rendererVersion: typeof TRAFFIC_WORKBOOK_RENDERER_VERSION;
    metricsContractVersion: string;
    generatedAt: string;
    dataAsOf: string;
    sourceWatermark: number | string;
    requestHash: string;
    requestId: string;
    normalizedFilterHash: string;
    artifactChecksumPolicy: string;
    periodMode: WorkbookPeriodMode;
    seasonCode: string | null;
    month: string | null;
    monthFrom: string | null;
    monthTo: string | null;
    year: number | null;
    from: string;
    to: string;
    comparisonPeriods: Array<{ mode: WorkbookComparison; from: string; to: string }>;
    contextPeriods: Array<{ mode: 'previous' | 'selected' | 'next'; from: string; to: string }>;
    timeBasis: 'local' | 'utc';
    publishStatus: 'FINAL' | 'DRAFT/PARTIAL';
    latestCompletedOpsDate: string | null;
    warnings: string[];
  };
  kpis: {
    current: WorkbookMetricSet;
    previous: WorkbookMetricSet | null;
    yearAgo: WorkbookMetricSet | null;
    next: WorkbookMetricSet | null;
    peakDay: { opsDate: string | null; flights: number | null };
    paxCoverage: { reportedLegs: number | null; dueLegs: number | null; percent: number | null; status: string | null };
  };
  periods: WorkbookPeriodSnapshot[];
  businessWeekDimensions: WorkbookBusinessWeekDimensions[];
  timelineDaily: WorkbookTimelineRow[];
  timelineMonthly: WorkbookPeriodRow[];
  timelineIsoWeek: WorkbookPeriodRow[];
  timelineBusinessWeek: WorkbookPeriodRow[];
  airlines: WorkbookDimensionRow[];
  countries: WorkbookDimensionRow[];
  routes: WorkbookDimensionRow[];
  peakHours: Array<{ hour: string; arrivals: number | null; departures: number | null; averageArrivals: number | null; averageDepartures: number | null; suppressed: boolean }>;
  monthlyPeaks: Array<Record<string, string | number | boolean | null>>;
  dayOfWeek: Array<Record<string, string | number | boolean | null>>;
  aircraft: Array<Record<string, string | number | boolean | null>>;
  frequency: Array<Record<string, string | number | boolean | null>>;
  annotations: Array<Record<string, string | null>>;
  quality: {
    allEqualsArrivalsPlusDepartures: boolean | null;
    airlineTotalFlights: number | null;
    countryTotalFlights: number | null;
    routeTotalFlights: number | null;
    unknownCountryLegs: number | null;
    paxDueMissingLegs: number | null;
    quarantinedDuplicateCandidates: number | null;
    projectionStatus: string | null;
    notes: string[];
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^\d{4}-\d{2}$/u;
const SEASON = /^[SW]\d{2}$/u;
const WORKBOOK_QUERY_KEYS = new Set([
  'report_type', 'template_version', 'period_mode', 'season_code', 'month', 'month_from', 'month_to', 'year', 'from', 'to',
  'comparison', 'comparison_year', 'tz', 'airline', 'route', 'country',
]);

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastSunday(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

export function workbookSeasonRange(code: string): { from: string; to: string } {
  if (!SEASON.test(code)) throw new Error('invalid season code');
  const year = 2000 + Number(code.slice(1));
  if (code.startsWith('S')) return { from: lastSunday(year, 2), to: shiftIsoDate(lastSunday(year, 9), -1) };
  return { from: lastSunday(year, 9), to: shiftIsoDate(lastSunday(year + 1, 2), -1) };
}

export function workbookMonthRange(month: string): { from: string; to: string } {
  if (!MONTH.test(month)) throw new Error('invalid month');
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error('invalid month');
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10),
  };
}

export function workbookMonthRangeRange(monthFrom: string, monthTo: string): { from: string; to: string } {
  if (!MONTH.test(monthFrom) || !MONTH.test(monthTo) || monthFrom > monthTo) throw new Error('invalid month range');
  return { from: workbookMonthRange(monthFrom).from, to: workbookMonthRange(monthTo).to };
}

export function workbookYearRange(year: number): { from: string; to: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('invalid year');
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function shiftDateToYear(value: string, targetYear: number): string {
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function workbookComparisonYearRanges(request: Pick<NormalizedWorkbookRequest, 'periodMode' | 'seasonCode' | 'from' | 'to' | 'comparisonYears'>): WorkbookComparisonPeriod[] {
  const baseYear = Number(request.from.slice(0, 4));
  return request.comparisonYears.map((comparisonYear) => {
    let from: string;
    let to: string;
    let label: string;
    if (request.periodMode === 'season') {
      if (!request.seasonCode) throw new Error('season comparison requires season code');
      const code = `${request.seasonCode[0]}${String(comparisonYear).slice(-2)}`;
      ({ from, to } = workbookSeasonRange(code));
      label = code;
    } else if (request.periodMode === 'year') {
      ({ from, to } = workbookYearRange(comparisonYear));
      label = String(comparisonYear);
    } else {
      const offset = comparisonYear - baseYear;
      from = shiftDateToYear(request.from, comparisonYear);
      to = shiftDateToYear(request.to, Number(request.to.slice(0, 4)) + offset);
      label = from.slice(0, 4) === to.slice(0, 4) ? String(comparisonYear) : `${from.slice(0, 4)}–${to.slice(0, 4)}`;
    }
    return {
      id: `comparison-${comparisonYear}`,
      comparisonYear,
      label,
      from,
      to,
      calendarDays: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1,
    };
  });
}

export function workbookWeeklyContextRanges(request: Pick<NormalizedWorkbookRequest, 'from' | 'to'>): Array<{
  mode: 'previous' | 'selected' | 'next';
  from: string;
  to: string;
}> {
  return [
    { mode: 'previous', from: shiftIsoDate(request.from, -7), to: shiftIsoDate(request.from, -1) },
    { mode: 'selected', from: request.from, to: request.to },
    { mode: 'next', from: shiftIsoDate(request.to, 1), to: shiftIsoDate(request.to, 7) },
  ];
}

function canonicalList(values: string[], uppercase: boolean): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean).map((value) => uppercase ? value.toUpperCase() : value))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function normalizeWorkbookRequest(url: URL): NormalizedWorkbookRequest {
  for (const key of url.searchParams.keys()) if (!WORKBOOK_QUERY_KEYS.has(key)) throw new Error(`unsupported workbook parameter: ${key}`);
  for (const key of ['report_type', 'template_version', 'period_mode', 'season_code', 'month', 'month_from', 'month_to', 'year', 'from', 'to', 'tz']) {
    if (url.searchParams.getAll(key).length > 1) throw new Error(`duplicate workbook parameter: ${key}`);
  }
  const reportType = url.searchParams.get('report_type');
  if (!['MASTER_OPERATIONS', 'MONTHLY_OVERVIEW_L2', 'WEEKLY_DETAIL', 'PERIOD_ANALYSIS', 'BAO_CAO_SAN_LUONG'].includes(String(reportType))) throw new Error('invalid workbook report type');
  const templateVersion = url.searchParams.get('template_version');
  const expectedTemplate: WorkbookTemplateVersion = reportType === 'MASTER_OPERATIONS'
    ? 'master-v1'
    : reportType === 'MONTHLY_OVERVIEW_L2'
      ? 'monthly-l2-v1'
      : reportType === 'WEEKLY_DETAIL'
        ? 'weekly-detail-v1'
        : reportType === 'PERIOD_ANALYSIS'
          ? 'period-analysis-v1'
          : 'bao-cao-san-luong-v1';
  if (templateVersion !== expectedTemplate) throw new Error('invalid workbook template version');
  const rawPeriodMode = url.searchParams.get('period_mode');
  if (reportType === 'MASTER_OPERATIONS' && rawPeriodMode !== 'season' && rawPeriodMode !== 'custom') throw new Error('invalid master period mode');
  if (reportType === 'MONTHLY_OVERVIEW_L2' && rawPeriodMode !== 'month') throw new Error('invalid monthly period mode');
  if (reportType === 'WEEKLY_DETAIL' && rawPeriodMode !== 'custom') throw new Error('invalid weekly detail period mode');
  if (reportType === 'BAO_CAO_SAN_LUONG' && rawPeriodMode !== 'season') throw new Error('invalid BaoCaoSanLuong period mode');
  if (reportType === 'PERIOD_ANALYSIS' && !['season', 'custom', 'month', 'month_range', 'year'].includes(String(rawPeriodMode))) throw new Error('invalid period analysis mode');
  const periodMode = rawPeriodMode as WorkbookPeriodMode;
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw new Error('invalid workbook date range');
  const seasonCode = url.searchParams.get('season_code');
  const month = url.searchParams.get('month');
  const monthFrom = url.searchParams.get('month_from');
  const monthTo = url.searchParams.get('month_to');
  const rawYear = url.searchParams.get('year');
  const year = rawYear == null ? null : Number(rawYear);
  if (periodMode === 'season') {
    if (!seasonCode || month || monthFrom || monthTo || year != null) throw new Error('season preset requires season_code only');
    const expected = workbookSeasonRange(seasonCode);
    if (from !== expected.from || to !== expected.to) throw new Error('season preset does not match from/to');
  } else if (periodMode === 'month') {
    if (!month || seasonCode || monthFrom || monthTo || year != null) throw new Error('month preset requires month only');
    const expected = workbookMonthRange(month);
    if (from !== expected.from || to !== expected.to) throw new Error('month preset does not match from/to');
  } else if (periodMode === 'month_range') {
    if (!monthFrom || !monthTo || seasonCode || month || year != null) throw new Error('month range preset requires month_from and month_to only');
    const expected = workbookMonthRangeRange(monthFrom, monthTo);
    if (from !== expected.from || to !== expected.to) throw new Error('month range preset does not match from/to');
  } else if (periodMode === 'year') {
    if (year == null || seasonCode || month || monthFrom || monthTo) throw new Error('year preset requires year only');
    const expected = workbookYearRange(year);
    if (from !== expected.from || to !== expected.to) throw new Error('year preset does not match from/to');
  } else if (seasonCode || month || monthFrom || monthTo || year != null) throw new Error('custom period cannot include preset identifiers');
  const comparisons = canonicalList(url.searchParams.getAll('comparison'), false);
  if (comparisons.some((value) => value !== 'previous' && value !== 'year_ago')) throw new Error('invalid workbook comparison');
  if (reportType === 'WEEKLY_DETAIL' && comparisons.length) throw new Error('weekly detail comparisons are automatic');
  if ((reportType === 'PERIOD_ANALYSIS' || reportType === 'BAO_CAO_SAN_LUONG') && comparisons.length) throw new Error('report does not accept legacy comparisons');
  const comparisonYears = canonicalList(url.searchParams.getAll('comparison_year'), false).map(Number).sort((left, right) => right - left);
  if (comparisonYears.some((value) => !Number.isInteger(value) || value < 2000 || value > 9999)) throw new Error('invalid workbook comparison year');
  if (reportType !== 'PERIOD_ANALYSIS' && comparisonYears.length) throw new Error('comparison years require period analysis');
  if (workbookComparisonYearRanges({ periodMode, seasonCode, from, to, comparisonYears }).some((range) => range.from === from && range.to === to)) throw new Error('comparison period duplicates current period');
  const timeBasis = url.searchParams.get('tz') ?? 'local';
  if (timeBasis !== 'local' && timeBasis !== 'utc') throw new Error('invalid workbook time basis');
  const airlines = canonicalList(url.searchParams.getAll('airline'), true);
  const routes = canonicalList(url.searchParams.getAll('route'), true);
  const countries = canonicalList(url.searchParams.getAll('country'), false);
  if ([airlines, routes, countries].some((values) => values.length > 24)) throw new Error('workbook filter cardinality exceeds 24');

  const canonical = new URLSearchParams({
    report_type: String(reportType),
    template_version: expectedTemplate,
    period_mode: periodMode,
    from,
    to,
  });
  if (seasonCode) canonical.set('season_code', seasonCode);
  if (month) canonical.set('month', month);
  if (monthFrom) canonical.set('month_from', monthFrom);
  if (monthTo) canonical.set('month_to', monthTo);
  if (year != null) canonical.set('year', String(year));
  for (const comparison of comparisons) canonical.append('comparison', comparison);
  for (const comparisonYear of comparisonYears) canonical.append('comparison_year', String(comparisonYear));
  if (timeBasis !== 'local') canonical.set('tz', timeBasis);
  for (const value of airlines) canonical.append('airline', value);
  for (const value of routes) canonical.append('route', value);
  for (const value of countries) canonical.append('country', value);
  return {
    reportType: reportType as WorkbookReportType,
    templateVersion: expectedTemplate,
    periodMode,
    seasonCode,
    month,
    monthFrom,
    monthTo,
    year,
    from,
    to,
    comparisons: comparisons as WorkbookComparison[],
    comparisonYears,
    timeBasis,
    airlines,
    routes,
    countries,
    canonicalQuery: canonical.toString(),
  };
}

export function workbookComparisonRanges(request: NormalizedWorkbookRequest): Array<{ mode: WorkbookComparison; from: string; to: string }> {
  const result: Array<{ mode: WorkbookComparison; from: string; to: string }> = [];
  if (request.comparisons.includes('previous')) {
    if (request.periodMode === 'month' && request.month) {
      const start = new Date(`${request.from}T00:00:00Z`);
      start.setUTCMonth(start.getUTCMonth() - 1);
      const month = start.toISOString().slice(0, 7);
      result.push({ mode: 'previous', ...workbookMonthRange(month) });
    } else {
      const days = Math.round((Date.parse(request.to) - Date.parse(request.from)) / 86_400_000) + 1;
      result.push({ mode: 'previous', from: shiftIsoDate(request.from, -days), to: shiftIsoDate(request.from, -1) });
    }
  }
  if (request.comparisons.includes('year_ago')) {
    const shiftYear = (value: string) => {
      const date = new Date(`${value}T00:00:00Z`);
      const month = date.getUTCMonth();
      date.setUTCFullYear(date.getUTCFullYear() - 1);
      if (date.getUTCMonth() !== month) date.setUTCDate(0);
      return date.toISOString().slice(0, 10);
    };
    result.push({ mode: 'year_ago', from: shiftYear(request.from), to: shiftYear(request.to) });
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function metric(value: unknown): WorkbookMetricSet {
  const raw = record(value);
  return {
    flights: numberOrNull(raw.flights),
    arrivals: numberOrNull(raw.arrivals),
    departures: numberOrNull(raw.departures),
    reportedPax: numberOrNull(raw.reported_pax),
    arrivalReportedPax: numberOrNull(raw.arrival_reported_pax),
    departureReportedPax: numberOrNull(raw.departure_reported_pax),
    status: stringOrNull(raw.status),
  };
}

function aggregateRows(rows: WorkbookTimelineRow[], key: string, from: string, to: string): WorkbookPeriodRow {
  const numeric = (field: 'flights' | 'arrivals' | 'departures' | 'reportedPax' | 'arrivalReportedPax' | 'departureReportedPax') => {
    const values = rows.map((row) => row[field]).filter((value): value is number => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const flights = numeric('flights');
  const calendarDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return {
    key,
    from,
    to,
    calendarDays,
    flights,
    arrivals: numeric('arrivals'),
    departures: numeric('departures'),
    reportedPax: numeric('reportedPax'),
    arrivalReportedPax: numeric('arrivalReportedPax'),
    departureReportedPax: numeric('departureReportedPax'),
    averageFlights: flights == null ? null : flights / calendarDays,
    completeness: new Set(rows.map((row) => row.opsDate)).size < calendarDays || rows.some((row) => row.completeness === 'missing')
      ? 'missing' : rows.some((row) => row.completeness === 'partial') ? 'partial' : 'complete',
  };
}

function groupTimeline(rows: WorkbookTimelineRow[], kind: 'month' | 'iso' | 'business', selected: { from: string; to: string }): WorkbookPeriodRow[] {
  const groups = new Map<string, { from: string; to: string; rows: WorkbookTimelineRow[] }>();
  for (const row of rows) {
    if (row.opsDate < selected.from || row.opsDate > selected.to) continue;
    const date = new Date(`${row.opsDate}T00:00:00Z`);
    let from = row.opsDate;
    let to = row.opsDate;
    let key = row.opsDate;
    if (kind === 'month') {
      key = row.opsDate.slice(0, 7);
      ({ from, to } = workbookMonthRange(key));
    } else {
      const day = date.getUTCDay() || 7;
      const offset = kind === 'iso' ? day - 1 : (day + 2) % 7;
      from = shiftIsoDate(row.opsDate, -offset);
      to = shiftIsoDate(from, 6);
      key = `${kind === 'iso' ? 'ISO' : 'FRI-THU'} ${from}`;
    }
    const existing = groups.get(key) ?? {
      from: from < selected.from ? selected.from : from,
      to: to > selected.to ? selected.to : to,
      rows: [],
    };
    existing.rows.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => aggregateRows(value.rows, key, value.from, value.to));
}

function dimensionRows(current: unknown, previous: unknown, yearAgo: unknown, next?: unknown): WorkbookDimensionRow[] {
  const currentRows = array(current);
  const currentMap = new Map(currentRows.map((row) => [String(row.key ?? row.label ?? ''), row]));
  const previousMap = new Map(array(previous).map((row) => [String(row.key ?? row.label ?? ''), metric(row)]));
  const yearAgoMap = new Map(array(yearAgo).map((row) => [String(row.key ?? row.label ?? ''), metric(row)]));
  const nextRows = array(next);
  const nextMap = new Map(nextRows.map((row) => [String(row.key ?? row.label ?? ''), metric(row)]));
  const sourceRows = [...new Map([...array(previous), ...array(yearAgo), ...nextRows, ...currentRows]
    .map((row) => [String(row.key ?? row.label ?? ''), row])).values()];
  // Keep the current ranking, then append entities found only in other periods.
  const orderedRows = [...currentRows, ...sourceRows.filter((row) => !currentMap.has(String(row.key ?? row.label ?? '')))];
  return orderedRows.map((sourceRow) => {
    const sourceKey = String(sourceRow.key ?? sourceRow.label ?? 'unknown');
    const row = currentMap.get(sourceKey) ?? {};
    const key = sourceKey;
    return {
      key,
      label: String(row.label ?? sourceRow.label ?? 'Unknown'),
      ...metric(row),
      flightShare: numberOrNull(row.flight_share ?? row.share),
      paxShare: numberOrNull(row.pax_share),
      reportedLegs: numberOrNull(row.reported_legs),
      dueLegs: numberOrNull(row.due_legs),
      paxCoverage: numberOrNull(row.pax_coverage_pct),
      paxStatus: stringOrNull(row.pax_status),
      suppressed: Boolean(row.suppressed),
      previous: previousMap.get(key) ?? null,
      yearAgo: yearAgoMap.get(key) ?? null,
      next: nextMap.get(key) ?? null,
    };
  });
}

function dimensionTotal(rows: WorkbookDimensionRow[]): number | null {
  const values = rows.map((row) => row.flights).filter((value): value is number => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function aircraftRows(
  level: 'Nhóm tàu bay' | 'Loại tàu bay',
  current: unknown,
  previous: unknown,
  next: unknown,
  includeContextOnly: boolean,
): Array<Record<string, string | number | boolean | null>> {
  const keyOf = (row: Record<string, unknown>) => level === 'Nhóm tàu bay'
    ? String(row.label ?? 'Unknown')
    : `${String(row.aircraft_group ?? 'Unknown')}|${String(row.label ?? 'Unknown')}`;
  const currentRows = array(current);
  const currentMap = new Map(currentRows.map((row) => [keyOf(row), row]));
  const previousMap = new Map(array(previous).map((row) => [keyOf(row), row]));
  const nextMap = new Map(array(next).map((row) => [keyOf(row), row]));
  const keys = includeContextOnly
    ? [...new Set([...currentMap.keys(), ...previousMap.keys(), ...nextMap.keys()])]
    : [...currentMap.keys()];
  return keys.sort((left, right) => left.localeCompare(right, 'vi')).map((key) => {
    const row = currentMap.get(key) ?? previousMap.get(key) ?? nextMap.get(key) ?? {};
    const previousFlights = numberOrNull(previousMap.get(key)?.flights);
    const flights = numberOrNull(currentMap.get(key)?.flights);
    const nextFlights = numberOrNull(nextMap.get(key)?.flights);
    return {
      level,
      group: level === 'Nhóm tàu bay' ? String(row.label ?? 'Unknown') : String(row.aircraft_group ?? 'Unknown'),
      type: level === 'Loại tàu bay' ? String(row.label ?? 'Unknown') : '',
      flights,
      arrivals: numberOrNull(currentMap.get(key)?.arrivals),
      departures: numberOrNull(currentMap.get(key)?.departures),
      reportedPax: numberOrNull(currentMap.get(key)?.reported_pax),
      arrivalReportedPax: numberOrNull(currentMap.get(key)?.arrival_reported_pax),
      departureReportedPax: numberOrNull(currentMap.get(key)?.departure_reported_pax),
      share: numberOrNull(currentMap.get(key)?.share),
      previousFlights,
      previousDelta: flights == null || previousFlights == null ? null : flights - previousFlights,
      nextFlights,
      nextDelta: nextFlights == null || flights == null ? null : nextFlights - flights,
    };
  });
}

function deterministicHighlights(rows: WorkbookDimensionRow[], comparison: 'previous' | 'yearAgo'): string[] {
  const ranked = rows.map((row) => {
    const baseline = row[comparison]?.flights ?? null;
    return { label: row.label, delta: row.flights != null && baseline != null ? row.flights - baseline : null };
  }).filter((row): row is { label: string; delta: number } => row.delta != null).sort((left, right) => right.delta - left.delta);
  if (!ranked.length) return [];
  const result = [`Tăng nhiều nhất: ${ranked[0].label} (${ranked[0].delta >= 0 ? '+' : ''}${ranked[0].delta} chuyến).`];
  const lowest = ranked.at(-1)!;
  if (lowest.delta < 0) result.push(`Giảm nhiều nhất: ${lowest.label} (${lowest.delta} chuyến).`);
  return result;
}

export function buildWorkbookReportModel(input: {
  request: NormalizedWorkbookRequest;
  requestHash: string;
  requestId: string;
  generatedAt: string;
  currentBundle: unknown;
  previousBundle?: unknown;
  yearAgoBundle?: unknown;
  nextBundle?: unknown;
  currentDimensions: { airline: unknown; country: unknown; route: unknown };
  previousDimensions?: { airline: unknown; country: unknown; route: unknown };
  yearAgoDimensions?: { airline: unknown; country: unknown; route: unknown };
  nextDimensions?: { airline: unknown; country: unknown; route: unknown };
  comparisonSnapshots?: Array<{
    period: WorkbookComparisonPeriod;
    bundle: unknown;
    dimensions: { airline: unknown; country: unknown; route: unknown };
  }>;
  businessWeekDimensionSnapshots?: Array<{
    id: string;
    label: string;
    from: string;
    to: string;
    partial: boolean;
    dimensions: { airline: unknown; country: unknown };
  }>;
}): WorkbookReportModel {
  const currentBundle = record(input.currentBundle);
  const currentMetadata = record(currentBundle.metadata);
  const currentKpis = record(currentBundle.kpis);
  const currentBreakdowns = record(currentBundle.breakdowns);
  const previousBundle = record(input.previousBundle);
  const yearAgoBundle = record(input.yearAgoBundle);
  const nextBundle = record(input.nextBundle);
  const previousBreakdowns = record(previousBundle.breakdowns);
  const nextBreakdowns = record(nextBundle.breakdowns);
  const timelineFromBundle = (bundle: Record<string, unknown>, contextPeriod?: WorkbookTimelineRow['contextPeriod']): WorkbookTimelineRow[] => array(bundle.timeline).map((row) => ({
    opsDate: String(row.ops_date ?? ''),
    contextPeriod,
    ...metric(row),
    completeness: String(row.completeness ?? 'missing'),
    reportedLegs: numberOrNull(row.reported_legs),
    dueLegs: numberOrNull(row.due_legs),
    paxCoverage: numberOrNull(row.pax_coverage_pct),
    paxStatus: stringOrNull(row.pax_status),
  })).filter((row) => ISO_DATE.test(row.opsDate));
  const timelineDaily: WorkbookTimelineRow[] = (input.request.reportType === 'WEEKLY_DETAIL'
    ? [
        ...timelineFromBundle(previousBundle, 'previous'),
        ...timelineFromBundle(currentBundle, 'selected'),
        ...timelineFromBundle(nextBundle, 'next'),
      ]
    : timelineFromBundle(currentBundle)
  ).sort((left, right) => left.opsDate.localeCompare(right.opsDate));
  const airlines = dimensionRows(input.currentDimensions.airline, input.previousDimensions?.airline, input.yearAgoDimensions?.airline, input.nextDimensions?.airline);
  const countries = dimensionRows(input.currentDimensions.country, input.previousDimensions?.country, input.yearAgoDimensions?.country, input.nextDimensions?.country);
  const routes = dimensionRows(input.currentDimensions.route, input.previousDimensions?.route, input.yearAgoDimensions?.route, input.nextDimensions?.route);
  const current = metric(currentKpis.current);
  const previous = input.previousBundle ? metric(record(previousBundle.kpis).current) : null;
  const yearAgo = input.yearAgoBundle ? metric(record(yearAgoBundle.kpis).current) : null;
  const next = input.nextBundle ? metric(record(nextBundle.kpis).current) : null;
  const comparisonPeriods = workbookComparisonRanges(input.request);
  const contextPeriods = input.request.reportType === 'WEEKLY_DETAIL' ? workbookWeeklyContextRanges(input.request) : [];
  const timelineRange = {
    from: contextPeriods.find((period) => period.mode === 'previous')?.from ?? input.request.from,
    to: contextPeriods.find((period) => period.mode === 'next')?.to ?? input.request.to,
  };
  const paxCoverage = record(currentKpis.pax_coverage);
  const latestCompletedOpsDate = stringOrNull(currentMetadata.latest_completed_ops_date);
  const coveragePercent = numberOrNull(paxCoverage.percent);
  const final = input.request.periodMode === 'month'
    && Boolean(latestCompletedOpsDate && input.request.to <= latestCompletedOpsDate)
    && current.status === 'complete'
    && coveragePercent === 100;
  const warnings: string[] = [];
  if (!final && input.request.periodMode === 'month') warnings.push('Tháng chưa hoàn tất hoặc coverage chưa đạt 100%; artifact được gắn DRAFT/PARTIAL.');
  if (current.reportedPax == null) warnings.push('Pax chưa có dữ liệu; ô Pax được để trống, không thay bằng 0.');
  if (input.request.reportType === 'MONTHLY_OVERVIEW_L2') {
    warnings.push(...deterministicHighlights(airlines, 'previous'));
    warnings.push('Lifecycle hãng/chặng và nguyên nhân biến động chưa có nguồn sự kiện được xác nhận.');
  }
  if (input.request.reportType === 'WEEKLY_DETAIL') {
    warnings.push('Workbook gồm kỳ đã chọn, 7 ngày liền trước và 7 ngày liền sau; dữ liệu tương lai có thể chưa có Pax và được để trống.');
  }
  const qualityRaw = record(currentBundle.quality);
  const projection = record(currentMetadata.projection);
  const peakDay = record(currentKpis.peak_day);
  const selectedDayCount = numberOrNull(currentMetadata.day_count) ?? timelineDaily.length;
  const frequencyMap = new Map<string, Record<string, string | number | boolean | null>>();
  for (const bucket of array(currentBreakdowns.peak_hour)) {
    const regular = record(bucket.regular_flights);
    for (const direction of ['arrivals', 'departures'] as const) {
      for (const flight of array(regular[direction])) {
        const key = `${direction}|${flight.airline}|${flight.flight_number}|${flight.route}|${flight.typical_time}`;
        frequencyMap.set(key, {
          direction: direction === 'arrivals' ? 'A' : 'D', airline: String(flight.airline ?? ''), flightNumber: String(flight.flight_number ?? ''),
          route: String(flight.route ?? ''), typicalTime: String(flight.typical_time ?? ''), operatingDays: Array.isArray(flight.operating_days) ? flight.operating_days.join(', ') : '',
          occurrenceDays: numberOrNull(flight.occurrence_days), eligibleDays: numberOrNull(flight.eligible_days), consistency: numberOrNull(flight.consistency_percent),
        });
      }
    }
  }
  const notes = Array.isArray(qualityRaw.notes) ? qualityRaw.notes.map(String) : [];
  const periodSnapshot = (
    id: string,
    role: WorkbookPeriodSnapshot['role'],
    label: string,
    comparisonYear: number | null,
    from: string,
    to: string,
    bundleValue: unknown,
    dimensions: { airline: unknown; country: unknown; route: unknown },
  ): WorkbookPeriodSnapshot => {
    const bundle = record(bundleValue);
    const kpis = record(bundle.kpis);
    const breakdowns = record(bundle.breakdowns);
    const coverage = record(kpis.pax_coverage);
    return {
      id,
      role,
      label,
      comparisonYear,
      from,
      to,
      calendarDays: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1,
      metrics: metric(kpis.current),
      timelineDaily: timelineFromBundle(bundle).sort((left, right) => left.opsDate.localeCompare(right.opsDate)),
      airlines: dimensionRows(dimensions.airline, undefined, undefined),
      countries: dimensionRows(dimensions.country, undefined, undefined),
      routes: dimensionRows(dimensions.route, undefined, undefined),
      aircraftGroups: aircraftRows('Nhóm tàu bay', breakdowns.aircraft_group, undefined, undefined, false),
      aircraftTypes: aircraftRows('Loại tàu bay', breakdowns.aircraft_type, undefined, undefined, false),
      paxCoverage: {
        reportedLegs: numberOrNull(coverage.reported_legs),
        dueLegs: numberOrNull(coverage.due_legs),
        percent: numberOrNull(coverage.percent),
        status: stringOrNull(coverage.status),
      },
    };
  };
  const currentLabel = input.request.seasonCode
    ?? input.request.month
    ?? (input.request.year == null ? null : String(input.request.year))
    ?? `${input.request.from} – ${input.request.to}`;
  const periods = [
    periodSnapshot('current', 'current', currentLabel, null, input.request.from, input.request.to, input.currentBundle, input.currentDimensions),
    ...(input.comparisonSnapshots ?? []).map(({ period, bundle, dimensions }) => periodSnapshot(
      period.id,
      'comparison',
      period.label,
      period.comparisonYear,
      period.from,
      period.to,
      bundle,
      dimensions,
    )),
  ];
  return {
    metadata: {
      reportType: input.request.reportType,
      templateVersion: input.request.templateVersion,
      rendererVersion: TRAFFIC_WORKBOOK_RENDERER_VERSION,
      metricsContractVersion: String(currentBundle.contract_version ?? TRAFFIC_WORKBOOK_METRICS_CONTRACT_VERSION),
      generatedAt: input.generatedAt,
      dataAsOf: String(currentBundle.data_as_of ?? input.generatedAt),
      sourceWatermark: typeof currentBundle.source_watermark === 'number' ? currentBundle.source_watermark : String(currentBundle.source_watermark ?? 'unknown'),
      requestHash: input.requestHash,
      requestId: input.requestId,
      normalizedFilterHash: input.requestHash,
      artifactChecksumPolicy: 'SHA-256 được trả trong response header X-Artifact-SHA256.',
      periodMode: input.request.periodMode,
      seasonCode: input.request.seasonCode,
      month: input.request.month,
      monthFrom: input.request.monthFrom,
      monthTo: input.request.monthTo,
      year: input.request.year,
      from: input.request.from,
      to: input.request.to,
      comparisonPeriods,
      contextPeriods,
      timeBasis: input.request.timeBasis,
      publishStatus: final ? 'FINAL' : 'DRAFT/PARTIAL',
      latestCompletedOpsDate,
      warnings,
    },
    kpis: {
      current,
      previous,
      yearAgo,
      next,
      peakDay: { opsDate: stringOrNull(peakDay.ops_date), flights: numberOrNull(peakDay.flights) },
      paxCoverage: {
        reportedLegs: numberOrNull(paxCoverage.reported_legs),
        dueLegs: numberOrNull(paxCoverage.due_legs),
        percent: coveragePercent,
        status: stringOrNull(paxCoverage.status),
      },
    },
    periods,
    businessWeekDimensions: (input.businessWeekDimensionSnapshots ?? []).map((period) => ({
      id: period.id,
      label: period.label,
      from: period.from,
      to: period.to,
      partial: period.partial,
      airlines: dimensionRows(period.dimensions.airline, undefined, undefined),
      countries: dimensionRows(period.dimensions.country, undefined, undefined),
    })),
    timelineDaily,
    timelineMonthly: groupTimeline(timelineDaily, 'month', timelineRange),
    timelineIsoWeek: groupTimeline(timelineDaily, 'iso', timelineRange),
    timelineBusinessWeek: groupTimeline(timelineDaily, 'business', timelineRange),
    airlines,
    countries,
    routes,
    peakHours: array(currentBreakdowns.peak_hour).map((row) => ({
      hour: String(row.hour_bucket ?? ''),
      arrivals: numberOrNull(row.arrivals),
      departures: numberOrNull(row.departures),
      averageArrivals: numberOrNull(row.arrivals) == null || !selectedDayCount ? null : numberOrNull(row.arrivals)! / selectedDayCount,
      averageDepartures: numberOrNull(row.departures) == null || !selectedDayCount ? null : numberOrNull(row.departures)! / selectedDayCount,
      suppressed: Boolean(row.suppressed),
    })),
    monthlyPeaks: array(currentBreakdowns.peak_hour_monthly).map((row) => ({
      month: String(row.month ?? ''), timeBasis: String(row.time_basis ?? input.request.timeBasis),
      arrivalHour: stringOrNull(row.arrival_hour), arrivalFlights: numberOrNull(row.arrival_flights),
      departureHour: stringOrNull(row.departure_hour), departureFlights: numberOrNull(row.departure_flights),
      arrivalSuppressed: Boolean(row.arrival_suppressed), departureSuppressed: Boolean(row.departure_suppressed),
    })),
    dayOfWeek: array(currentBreakdowns.day_of_week).map((row) => ({
      dayIndex: numberOrNull(row.day_index), calendarDays: numberOrNull(row.calendar_days), totalFlights: numberOrNull(row.total_flights),
      averageFlights: numberOrNull(row.average_flights), minFlights: numberOrNull(row.min_flights), maxFlights: numberOrNull(row.max_flights),
      arrivals: numberOrNull(row.arrivals), departures: numberOrNull(row.departures), suppressed: Boolean(row.suppressed),
    })),
    aircraft: [
      ...aircraftRows('Nhóm tàu bay', currentBreakdowns.aircraft_group, previousBreakdowns.aircraft_group, nextBreakdowns.aircraft_group, input.request.reportType === 'WEEKLY_DETAIL'),
      ...aircraftRows('Loại tàu bay', currentBreakdowns.aircraft_type, previousBreakdowns.aircraft_type, nextBreakdowns.aircraft_type, input.request.reportType === 'WEEKLY_DETAIL'),
    ],
    frequency: [...frequencyMap.values()],
    annotations: [{ eventType: null, airline: null, route: null, period: null, frequency: null, confirmedSource: null, reviewer: null, status: 'Chưa có dữ liệu nghiệp vụ được xác nhận' }],
    quality: {
      allEqualsArrivalsPlusDepartures: current.flights == null || current.arrivals == null || current.departures == null ? null : current.flights === current.arrivals + current.departures,
      airlineTotalFlights: dimensionTotal(airlines),
      countryTotalFlights: dimensionTotal(countries),
      routeTotalFlights: dimensionTotal(routes),
      unknownCountryLegs: numberOrNull(qualityRaw.unknown_country_legs),
      paxDueMissingLegs: numberOrNull(qualityRaw.pax_due_missing_legs),
      quarantinedDuplicateCandidates: numberOrNull(qualityRaw.quarantined_duplicate_candidates),
      projectionStatus: stringOrNull(projection.status),
      notes,
    },
  };
}
