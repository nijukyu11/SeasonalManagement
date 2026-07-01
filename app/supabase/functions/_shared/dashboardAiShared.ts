export type DashboardAiToolName =
  | 'query_dashboard_data'
  | 'request_dashboard_data_slice'
  | 'suggest_template_report'
  | 'suggest_custom_workbook'
  | 'suggest_visual_report'
  | 'compose_dashboard_ai_board';

export type DashboardAiReportingView =
  | 'flight_operations'
  | 'summary_airline'
  | 'summary_country'
  | 'summary_route'
  | 'summary_month'
  | 'summary_week'
  | 'summary_peak_hour'
  | 'summary_aircraft'
  | 'summary_arr_dep_mix';

export type DashboardAiQueryMetric = 'flights' | 'pax' | 'arrivals' | 'departures';
export type DashboardAiQueryCell = string | number | boolean | null;
export const DASHBOARD_AI_PAX_STATUSES = ['reported', 'planned_zero', 'missing_after_1_day'] as const;
export type DashboardAiPaxStatus = (typeof DASHBOARD_AI_PAX_STATUSES)[number];

export interface DashboardAiDataQuery {
  queryId: string;
  view: DashboardAiReportingView;
  filters: {
    seasonIds?: string[];
    iataSeasonCodes?: string[];
    dateFrom?: string;
    dateTo?: string;
    months?: string[];
    weeks?: string[];
    isoweeks?: string[];
    weeknums?: number[];
    typeFilter?: 'all' | 'A' | 'D';
    airlines?: string[];
    routes?: string[];
    countries?: string[];
    aircraft?: string[];
    acGroups?: string[];
    paxStatuses?: DashboardAiPaxStatus[];
    localBuckets30?: string[];
    localBuckets60?: string[];
    utcBuckets30?: string[];
    utcBuckets60?: string[];
    localHourFrom?: number;
    localHourTo?: number;
  };
  groupBy: string[];
  metrics: DashboardAiQueryMetric[];
  orderBy?: string;
  limit: number;
}

export type DashboardAiQueryScopeSourcePreset = 'selected-season' | 'user-date-range' | 'user-filter' | 'follow-up';

export interface DashboardAiQueryScope {
  dateFrom?: string;
  dateTo?: string;
  presetSeasonIds?: string[];
  iataSeasonCodes?: string[];
  flightNumbers?: string[];
  airports?: string[];
  routes?: string[];
  statuses?: string[];
  allocations?: string[];
  airlines?: string[];
  countries?: string[];
  aircraft?: string[];
  paxStatuses?: DashboardAiPaxStatus[];
  localHourFrom?: number;
  localHourTo?: number;
  sourcePreset: 'selected-season' | 'user-date-range' | 'user-filter' | 'follow-up';
}

export interface DashboardAiQueryResult {
  queryId: string;
  view: DashboardAiReportingView;
  columns: string[];
  rows: Record<string, DashboardAiQueryCell>[];
  rowCount: number;
  truncated: boolean;
  dataQualityNotes: string[];
}

export const DASHBOARD_AI_TOOL_NAMES: DashboardAiToolName[] = [
  'query_dashboard_data',
  'request_dashboard_data_slice',
  'suggest_template_report',
  'suggest_custom_workbook',
  'suggest_visual_report',
  'compose_dashboard_ai_board',
];

export const DASHBOARD_AI_REPORTING_VIEWS: DashboardAiReportingView[] = [
  'flight_operations',
  'summary_airline',
  'summary_country',
  'summary_route',
  'summary_month',
  'summary_week',
  'summary_peak_hour',
  'summary_aircraft',
  'summary_arr_dep_mix',
];

export const DASHBOARD_AI_QUERY_METRICS: DashboardAiQueryMetric[] = ['flights', 'pax', 'arrivals', 'departures'];
export const DASHBOARD_AI_QUERY_LIMIT_CAP = 500;
export const DASHBOARD_AI_QUERY_SCOPE_MAX_DAYS = 370;
export const DASHBOARD_AI_QUERY_GROUP_BY_COLUMNS = [
  'airline',
  'route',
  'country',
  'aircraft',
  'ac_group',
  'month',
  'iso_week',
  'isoweek',
  'weeknum',
  'local_hour',
  'utc_hour',
  'local_bucket_30',
  'local_bucket_30_index',
  'local_bucket_60',
  'local_bucket_60_index',
  'utc_bucket_30',
  'utc_bucket_30_index',
  'utc_bucket_60',
  'utc_bucket_60_index',
  'ops_date',
  'season',
  'gate',
  'type',
  'weekday',
  'pax_status',
];
export const DASHBOARD_AI_QUERY_ORDER_COLUMNS = ['flights', 'pax', 'arrivals', 'departures'];

export function applyDashboardAiQueryScopeToDataQuery(
  query: DashboardAiDataQuery,
  scope?: DashboardAiQueryScope | null
): DashboardAiDataQuery {
  if (!scope) return query;
  const filters = { ...query.filters };
  const queryHasExplicitPeriod = Boolean(filters.dateFrom || filters.dateTo || filters.months?.length || filters.weeks?.length || filters.isoweeks?.length || filters.weeknums?.length);
  const queryHasExplicitSeason = Boolean(filters.seasonIds?.length || filters.iataSeasonCodes?.length);
  if (!queryHasExplicitPeriod) {
    if (!filters.dateFrom && scope.dateFrom) filters.dateFrom = scope.dateFrom;
    if (!filters.dateTo && scope.dateTo) filters.dateTo = scope.dateTo;
  }
  const shouldApplySelectedSeasonPreset = scope.sourcePreset === 'selected-season' && !queryHasExplicitPeriod && !queryHasExplicitSeason;
  if (shouldApplySelectedSeasonPreset && !filters.seasonIds?.length && scope.presetSeasonIds?.length) filters.seasonIds = uniqueDashboardAiScopeValues(scope.presetSeasonIds, false);
  if (shouldApplySelectedSeasonPreset && !filters.iataSeasonCodes?.length && scope.iataSeasonCodes?.length) filters.iataSeasonCodes = uniqueDashboardAiScopeValues(scope.iataSeasonCodes, true);
  if (!filters.routes?.length && scope.routes?.length) filters.routes = uniqueDashboardAiScopeValues(scope.routes, true);
  if (!filters.airlines?.length && scope.airlines?.length) filters.airlines = uniqueDashboardAiScopeValues(scope.airlines, true);
  if (!filters.countries?.length && scope.countries?.length) filters.countries = uniqueDashboardAiScopeValues(scope.countries, false);
  if (!filters.aircraft?.length && scope.aircraft?.length) filters.aircraft = uniqueDashboardAiScopeValues(scope.aircraft, true);
  if (!filters.paxStatuses?.length && scope.paxStatuses?.length) filters.paxStatuses = scope.paxStatuses.filter((value, index, values) => DASHBOARD_AI_PAX_STATUSES.includes(value) && values.indexOf(value) === index);
  if (filters.localHourFrom == null && scope.localHourFrom != null && scope.localHourFrom >= 0 && scope.localHourFrom <= 23) filters.localHourFrom = scope.localHourFrom;
  if (filters.localHourTo == null && scope.localHourTo != null && scope.localHourTo >= 1 && scope.localHourTo <= 24) filters.localHourTo = scope.localHourTo;
  return { ...query, filters };
}

export function dashboardAiQueryScopeNeedsConfirmation(scope?: DashboardAiQueryScope | null): boolean {
  if (!scope?.dateFrom || !scope.dateTo) return false;
  const days = dashboardAiScopeDateSpanDays(scope.dateFrom, scope.dateTo);
  return days != null && days > DASHBOARD_AI_QUERY_SCOPE_MAX_DAYS;
}

function dashboardAiScopeDateSpanDays(dateFrom: string, dateTo: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) return null;
  const fromMs = Date.parse(`${dateFrom}T00:00:00Z`);
  const toMs = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
  return Math.floor((toMs - fromMs) / 86400000) + 1;
}

function uniqueDashboardAiScopeValues(values: string[], uppercase: boolean): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized) continue;
    const next = uppercase ? normalized.toUpperCase() : normalized;
    if (seen.has(next)) continue;
    seen.add(next);
    output.push(next);
    if (output.length >= 24) break;
  }
  return output;
}

function repairDashboardAiMojibakePrompt(prompt: string): string {
  if (!/[\u00c3\u00c2]/.test(prompt) || typeof TextDecoder === 'undefined') return prompt;
  try {
    const bytes = Uint8Array.from(Array.from(prompt, (char) => char.charCodeAt(0) & 0xff));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return prompt;
  }
}

export function normalizeDashboardAiPromptForToolRouting(prompt: unknown): string {
  const raw = String(prompt ?? '');
  const repaired = repairDashboardAiMojibakePrompt(raw);
  return `${raw} ${repaired}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bb[a\W_]*ng\b/g, 'bang')
    .replace(/\bkh[a\W_]*c\b/g, 'khac')
    .replace(/\bm[a\W_]*y\b/g, 'may')
    .replace(/\bqu[a\W_]*c\b/g, 'quoc')
    .replace(/\bs[a\W_]*nh\b/g, 'sanh')
    .replace(/\bth[a\W_]*ng\b/g, 'thang')
    .replace(/\bng[a\W_]*y\b/g, 'ngay')
    .replace(/\bv[o\W_]*i\b/g, 'voi')
    .replace(/\bdi[a\W_]*m\b/g, 'diem');
}

export function isDashboardAiQueryIntentPrompt(prompt: unknown): boolean {
  const normalized = normalizeDashboardAiPromptForToolRouting(prompt);
  return /\b(top|trend|thong ke|pax|khach|tan suat|frequency|cross-season|multi-season|all data|full data|whole db|whole database|entire db|entire database|toan bo du lieu|toan bo db|toan bo database|toan bo co so du lieu|tat ca du lieu|tat ca db|tat ca database|tat ca co so du lieu|mua lien tiep|selected seasons|s\d{2}|w\d{2}|thang|month|tuan|week|route|duong bay|airline|hang bay|country|quoc gia|aircraft|may bay|arr\/dep|arr dep|gate|peak hour|heatmap|waterfall|khoang ngay|tu ngay|so sanh|compare|comparison|tong|total|nhieu nhat|cao nhat|thap nhat|lon nhat)\b/.test(normalized) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(normalized) ||
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(normalized);
}

export function inferDashboardAiDataQueryFromPrompt(input: {
  userPrompt?: string;
  context?: unknown;
}): DashboardAiDataQuery | null {
  const rawPrompt = String(input.userPrompt ?? '');
  const prompt = normalizeDashboardAiPromptForToolRouting(rawPrompt);
  if (!isDashboardAiQueryIntentPrompt(rawPrompt)) return null;
  const year = inferDashboardAiContextYear(input.context);
  const dateRange = inferDashboardAiPromptDateRange(rawPrompt, String(year));
  const months = inferDashboardAiPromptMonths(rawPrompt, year);
  const iataSeasonCodes = Array.from(new Set(Array.from(rawPrompt.matchAll(/\b[SW]\d{2}\b/gi)).map((match) => match[0].toUpperCase())));
  const wantsSelectedSeasonSet = /\b(mua lien tiep|mua da chon|selected seasons|consecutive seasons|so sanh cac mua|so sanh mua)\b/.test(prompt);
  const selectedSeasonIds = selectedDashboardAiSeasonSetFromContext(input.context, {
    expandAdjacent: wantsSelectedSeasonSet,
  });
  const airlines = /\b(vn|vietnam airlines)\b/i.test(rawPrompt) ? ['VN'] : [];
  const hasPax = /\b(pax|khach)\b/.test(prompt);
  const wantsRoute = /\b(route|duong bay)\b/.test(prompt);
  const wantsCountry = /\b(country|quoc gia)\b/.test(prompt);
  const wantsAircraft = /\b(aircraft|may bay|tau bay)\b/.test(prompt);
  const wantsTypeMix = /\b(arr\/dep|arr dep|arrival|departure|arrivals|departures|mix|co cau arr|co cau dep)\b/.test(prompt);
  const wantsGate = /\b(gate|cong)\b/.test(prompt);
  const wantsWeek = /\b(weekly|hang tuan|tuan|week)\b/.test(prompt);
  const wantsPeak = /\b(peak hour|cao diem|7-8|7am|8am)\b/.test(prompt);
  const wantsDailyPeak = /\b(ngay|daily|theo ngay|phan bo theo ngay|cao diem|bat thuong|anomaly)\b/.test(prompt) &&
    /\b(cao diem|nhieu nhat|cao nhat|peak|bat thuong|anomaly)\b/.test(prompt);
  const wantsSeasonComparison = iataSeasonCodes.length > 1 || wantsSelectedSeasonSet;
  const hours = inferDashboardAiPromptHours(prompt);
  const groupBy = wantsGate
    ? ['gate']
    : wantsWeek
      ? ['iso_week']
      : wantsRoute
        ? ['route']
        : wantsCountry
          ? ['country']
          : wantsAircraft
            ? ['aircraft']
            : wantsTypeMix
              ? ['type']
            : wantsSeasonComparison
              ? ['season']
              : dateRange || (months.length > 0 && wantsDailyPeak)
                  ? ['ops_date']
                  : ['airline'];

  return {
    queryId: 'auto-query-1',
    view: 'flight_operations',
    filters: {
      ...(wantsSelectedSeasonSet && selectedSeasonIds.length ? { seasonIds: selectedSeasonIds } : {}),
      ...(!wantsSelectedSeasonSet && iataSeasonCodes.length ? { iataSeasonCodes } : {}),
      ...(dateRange?.dateFrom ? { dateFrom: dateRange.dateFrom } : {}),
      ...(dateRange?.dateTo ? { dateTo: dateRange.dateTo } : {}),
      ...(!dateRange && months.length ? { months } : {}),
      ...(airlines.length ? { airlines } : {}),
      ...(wantsPeak && hours ? { localHourFrom: hours.from, localHourTo: hours.to } : {}),
    },
    groupBy,
    metrics: hasPax ? ['pax', 'flights'] : ['flights', 'pax'],
    orderBy: hasPax ? 'pax' : 'flights',
    limit: /\btop\s+10\b/.test(prompt) ? 10 : 24,
  };
}

function inferDashboardAiContextYear(context: unknown): number {
  const text = JSON.stringify(context ?? {});
  const match = /\b20\d{2}\b/.exec(text);
  return match ? Number(match[0]) : new Date().getFullYear();
}

function inferDashboardAiPromptMonths(prompt: string, fallbackYear: number): string[] {
  const normalized = normalizeDashboardAiPromptForToolRouting(prompt);
  const months = new Set<string>();
  for (const match of normalized.matchAll(/\b(?:thang|month)\s*(1[0-2]|0?[1-9])(?:\/(20\d{2}))?\b/g)) {
    months.add(`${match[2] ?? fallbackYear}-${String(Number(match[1])).padStart(2, '0')}`);
  }
  for (const match of normalized.matchAll(/\b(20\d{2})-(1[0-2]|0[1-9])\b/g)) {
    months.add(`${match[1]}-${match[2]}`);
  }
  return Array.from(months).slice(0, 12);
}

function inferDashboardAiPromptDateRange(prompt: string, fallbackYear: string): { dateFrom: string; dateTo: string } | null {
  const normalized = normalizeDashboardAiPromptForToolRouting(prompt);
  const isoDates = Array.from(normalized.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((match) => match[1]);
  if (isoDates.length >= 2) return orderedDashboardAiDateRange(isoDates[0], isoDates[1]);
  const slashDates = Array.from(normalized.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)).map((match) => toDashboardAiIsoDate(Number(match[1]), Number(match[2]), match[3]));
  const validSlashDates = slashDates.filter((value): value is string => Boolean(value));
  if (validSlashDates.length >= 2) return orderedDashboardAiDateRange(validSlashDates[0], validSlashDates[1]);
  const vietnameseRange = /\btu ngay\s*(\d{1,2})(?:\/(\d{1,2}))?\s*(?:den|toi)\s*(?:ngay\s*)?(\d{1,2})(?:\/(\d{1,2}))?(?:\/(20\d{2})|\s*thang\s*(\d{1,2})(?:\/(20\d{2}))?)?/.exec(normalized);
  if (vietnameseRange) {
    const fromDay = Number(vietnameseRange[1]);
    const inferredMonth = vietnameseRange[2] || vietnameseRange[4] || vietnameseRange[6];
    const toDay = Number(vietnameseRange[3]);
    const fromMonth = Number(vietnameseRange[2] || inferredMonth);
    const toMonth = Number(vietnameseRange[4] || inferredMonth);
    const year = vietnameseRange[5] || vietnameseRange[7] || fallbackYear;
    const left = toDashboardAiIsoDate(fromDay, fromMonth, year);
    const right = toDashboardAiIsoDate(toDay, toMonth, year);
    if (left && right) return orderedDashboardAiDateRange(left, right);
  }
  return null;
}

function selectedDashboardAiSeasonSetFromContext(context: unknown, options: { expandAdjacent?: boolean } = {}): string[] {
  const root = context && typeof context === 'object' && !Array.isArray(context) ? context as Record<string, unknown> : {};
  const catalog = root.multiSeasonCatalog && typeof root.multiSeasonCatalog === 'object' ? root.multiSeasonCatalog as Record<string, unknown> : {};
  const seasonIds = Array.isArray(catalog.seasonIds) ? catalog.seasonIds : Array.isArray(root.seasonIds) ? root.seasonIds : [];
  const selected = seasonIds
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  if (!options.expandAdjacent || selected.length !== 1) return selected;
  const available = Array.isArray(root.availableSeasonCatalog)
    ? root.availableSeasonCatalog
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        seasonId: typeof entry.seasonId === 'string' ? entry.seasonId : '',
        seasonCode: typeof entry.seasonCode === 'string' ? entry.seasonCode : '',
        dateFrom: typeof (entry.dateRange as Record<string, unknown> | undefined)?.from === 'string' ? String((entry.dateRange as Record<string, unknown>).from) : '',
      }))
      .filter((entry) => entry.seasonId)
      .sort((left, right) => (left.dateFrom || left.seasonCode).localeCompare(right.dateFrom || right.seasonCode))
    : [];
  const index = available.findIndex((entry) => entry.seasonId === selected[0]);
  if (index < 0) return selected;
  const previous = available[index - 1]?.seasonId;
  const next = available[index + 1]?.seasonId;
  return previous ? [previous, selected[0]] : next ? [selected[0], next] : selected;
}

function toDashboardAiIsoDate(day: number, month: number, year: string): string | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31 || !/^20\d{2}$/.test(year)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function orderedDashboardAiDateRange(left: string, right: string): { dateFrom: string; dateTo: string } {
  return left <= right ? { dateFrom: left, dateTo: right } : { dateFrom: right, dateTo: left };
}

function inferDashboardAiPromptHours(prompt: string): { from: number; to: number } | null {
  const range = /\b(\d{1,2})\s*(?:h|:00|am|pm)?\s*[-–]\s*(\d{1,2})\s*(?:h|:00|am|pm)?\b/.exec(prompt);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from >= 0 && from <= 23 && to > from && to <= 24) return { from, to };
  }
  const single = /\b(\d{1,2})\s*(?:am|pm)\b/.exec(prompt);
  if (single) {
    const from = Number(single[1]);
    if (from >= 0 && from <= 23) return { from, to: from + 1 };
  }
  return null;
}
