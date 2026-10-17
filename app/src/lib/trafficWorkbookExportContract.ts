import type { NormalizedTrafficReportFilter, TrafficTimeBasis } from './trafficReportContract';

export const TRAFFIC_WORKBOOK_EXPORT_API = '/api/report/v1/workbook-export' as const;

export type TrafficWorkbookReportType = 'MASTER_OPERATIONS' | 'MONTHLY_OVERVIEW_L2' | 'WEEKLY_DETAIL' | 'PERIOD_ANALYSIS' | 'BAO_CAO_SAN_LUONG';
export type TrafficWorkbookPeriodMode = 'season' | 'custom' | 'month' | 'month_range' | 'year';
export type TrafficWorkbookComparison = 'previous' | 'year_ago';

export interface TrafficSeasonOption {
  code: string;
  from: string;
  to: string;
}

export interface TrafficWorkbookExportDraft {
  reportType: TrafficWorkbookReportType;
  periodMode: TrafficWorkbookPeriodMode;
  seasonCode: string;
  month: string;
  monthFrom: string;
  monthTo: string;
  year: string;
  from: string;
  to: string;
  comparisons: TrafficWorkbookComparison[];
  comparisonYears: number[];
  timeBasis: TrafficTimeBasis;
}

export interface TrafficWorkbookExportRequest {
  reportType: TrafficWorkbookReportType;
  templateVersion: 'master-v1' | 'monthly-l2-v1' | 'weekly-detail-v1' | 'period-analysis-v1' | 'bao-cao-san-luong-v1';
  period: {
    mode: TrafficWorkbookPeriodMode;
    seasonCode?: string;
    month?: string;
    monthFrom?: string;
    monthTo?: string;
    year?: number;
    from: string;
    to: string;
  };
  comparisons: TrafficWorkbookComparison[];
  comparisonYears: number[];
  timeBasis: TrafficTimeBasis;
  filters: Pick<NormalizedTrafficReportFilter, 'airline' | 'route' | 'country'>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^\d{4}-\d{2}$/u;
const SEASON = /^[SW]\d{2}$/u;

function isoDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getTrafficWeeklyContextRange(from: string, to: string): {
  previous: { from: string; to: string };
  selected: { from: string; to: string };
  next: { from: string; to: string };
  full: { from: string; to: string };
} {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw new Error('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  return {
    previous: { from: shiftIsoDate(from, -7), to: shiftIsoDate(from, -1) },
    selected: { from, to },
    next: { from: shiftIsoDate(to, 1), to: shiftIsoDate(to, 7) },
    full: { from: shiftIsoDate(from, -7), to: shiftIsoDate(to, 7) },
  };
}

function lastSunday(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

export function getTrafficSeasonRange(code: string): TrafficSeasonOption {
  if (!SEASON.test(code)) throw new Error('Mã mùa phải có dạng S26 hoặc W26.');
  const year = 2000 + Number(code.slice(1));
  if (code.startsWith('S')) {
    const from = lastSunday(year, 2);
    return { code, from, to: shiftIsoDate(lastSunday(year, 9), -1) };
  }
  const from = lastSunday(year, 9);
  return { code, from, to: shiftIsoDate(lastSunday(year + 1, 2), -1) };
}

export function getTrafficSeasonOptions(minOpsDate: string, maxOpsDate: string): TrafficSeasonOption[] {
  const minYear = Number(minOpsDate.slice(0, 4)) - 1;
  const maxYear = Number(maxOpsDate.slice(0, 4));
  const options: TrafficSeasonOption[] = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    for (const prefix of ['S', 'W'] as const) {
      const option = getTrafficSeasonRange(`${prefix}${String(year).slice(-2)}`);
      if (option.to >= minOpsDate && option.from <= maxOpsDate) options.push(option);
    }
  }
  return options.sort((left, right) => left.from.localeCompare(right.from));
}

export function getTrafficMonthRange(month: string): { from: string; to: string } {
  if (!MONTH.test(month)) throw new Error('Tháng báo cáo phải có dạng YYYY-MM.');
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error('Tháng báo cáo chưa hợp lệ.');
  return {
    from: isoDate(year, monthIndex, 1),
    to: isoDate(year, monthIndex + 1, 0),
  };
}

export function getTrafficMonthRangeRange(monthFrom: string, monthTo: string): { from: string; to: string } {
  if (!MONTH.test(monthFrom) || !MONTH.test(monthTo) || monthFrom > monthTo) throw new Error('Khoảng tháng chưa hợp lệ.');
  return { from: getTrafficMonthRange(monthFrom).from, to: getTrafficMonthRange(monthTo).to };
}

export function getTrafficYearRange(yearValue: string | number): { from: string; to: string } {
  const year = Number(yearValue);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('Năm báo cáo chưa hợp lệ.');
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function shiftDateToYear(value: string, targetYear: number): string {
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const lastDay = Number(isoDate(targetYear, month, 0).slice(8, 10));
  return isoDate(targetYear, month - 1, Math.min(day, lastDay));
}

export function getTrafficComparisonYearRange(input: {
  periodMode: TrafficWorkbookPeriodMode;
  from: string;
  to: string;
  seasonCode?: string;
  comparisonYear: number;
}): { from: string; to: string; label: string } {
  const { periodMode, from, to, comparisonYear } = input;
  if (!Number.isInteger(comparisonYear) || comparisonYear < 2000 || comparisonYear > 9999) throw new Error('Năm so sánh chưa hợp lệ.');
  if (periodMode === 'season') {
    if (!input.seasonCode || !SEASON.test(input.seasonCode)) throw new Error('Mùa so sánh chưa hợp lệ.');
    const code = `${input.seasonCode[0]}${String(comparisonYear).slice(-2)}`;
    const range = getTrafficSeasonRange(code);
    return { from: range.from, to: range.to, label: code };
  }
  if (periodMode === 'year') return { ...getTrafficYearRange(comparisonYear), label: String(comparisonYear) };
  const baseYear = Number(from.slice(0, 4));
  const yearOffset = comparisonYear - baseYear;
  const comparisonFrom = shiftDateToYear(from, comparisonYear);
  const comparisonTo = shiftDateToYear(to, Number(to.slice(0, 4)) + yearOffset);
  const label = comparisonFrom.slice(0, 4) === comparisonTo.slice(0, 4)
    ? String(comparisonYear)
    : `${comparisonFrom.slice(0, 4)}–${comparisonTo.slice(0, 4)}`;
  return { from: comparisonFrom, to: comparisonTo, label };
}

export function normalizeTrafficWorkbookExportDraft(
  draft: TrafficWorkbookExportDraft,
  filter: NormalizedTrafficReportFilter,
  minOpsDate: string,
  maxOpsDate: string,
): TrafficWorkbookExportRequest {
  let from = draft.from;
  let to = draft.to;
  let seasonCode: string | undefined;
  let month: string | undefined;
  let monthFrom: string | undefined;
  let monthTo: string | undefined;
  let year: number | undefined;

  if (draft.reportType === 'MONTHLY_OVERVIEW_L2') {
    if (draft.periodMode !== 'month') throw new Error('Báo cáo tháng chỉ chấp nhận phạm vi theo tháng.');
    ({ from, to } = getTrafficMonthRange(draft.month));
    month = draft.month;
  } else if (draft.reportType === 'WEEKLY_DETAIL') {
    if (draft.periodMode !== 'custom') throw new Error('Báo cáo tuần chi tiết chỉ chấp nhận khoảng ngày tùy chỉnh.');
  } else if (draft.reportType === 'BAO_CAO_SAN_LUONG') {
    if (draft.periodMode !== 'season') throw new Error('Báo cáo sản lượng chỉ chấp nhận phạm vi theo mùa.');
    const range = getTrafficSeasonRange(draft.seasonCode);
    ({ from, to } = range);
    seasonCode = range.code;
  } else if (draft.reportType === 'PERIOD_ANALYSIS') {
    if (draft.periodMode === 'season') {
      const range = getTrafficSeasonRange(draft.seasonCode);
      ({ from, to } = range);
      seasonCode = range.code;
    } else if (draft.periodMode === 'month') {
      ({ from, to } = getTrafficMonthRange(draft.month));
      month = draft.month;
    } else if (draft.periodMode === 'month_range') {
      ({ from, to } = getTrafficMonthRangeRange(draft.monthFrom, draft.monthTo));
      monthFrom = draft.monthFrom;
      monthTo = draft.monthTo;
    } else if (draft.periodMode === 'year') {
      year = Number(draft.year);
      ({ from, to } = getTrafficYearRange(year));
    } else if (draft.periodMode !== 'custom') {
      throw new Error('Phạm vi phân tích chưa hợp lệ.');
    }
  } else if (draft.periodMode === 'season') {
    const range = getTrafficSeasonRange(draft.seasonCode);
    ({ from, to } = range);
    seasonCode = range.code;
  } else if (draft.periodMode !== 'custom') {
    throw new Error('Workbook tổng hợp chỉ chấp nhận cả mùa hoặc khoảng ngày tùy chỉnh.');
  }

  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new Error('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  }
  if (from < minOpsDate || to > maxOpsDate) {
    throw new Error(`Phạm vi export phải nằm trong dữ liệu ${minOpsDate}–${maxOpsDate}.`);
  }
  if (draft.reportType === 'WEEKLY_DETAIL') {
    const context = getTrafficWeeklyContextRange(from, to);
    if (context.full.from < minOpsDate || context.full.to > maxOpsDate) {
      throw new Error(`Báo cáo tuần cần đủ dữ liệu 7 ngày trước và 7 ngày sau trong phạm vi ${minOpsDate}–${maxOpsDate}.`);
    }
  }

  const templateVersion = draft.reportType === 'MASTER_OPERATIONS'
    ? 'master-v1'
    : draft.reportType === 'MONTHLY_OVERVIEW_L2'
      ? 'monthly-l2-v1'
      : draft.reportType === 'WEEKLY_DETAIL'
        ? 'weekly-detail-v1'
        : draft.reportType === 'PERIOD_ANALYSIS'
          ? 'period-analysis-v1'
          : 'bao-cao-san-luong-v1';

  const comparisonYears = draft.reportType === 'PERIOD_ANALYSIS'
    ? [...new Set(draft.comparisonYears)].filter((value) => Number.isInteger(value)).sort((left, right) => right - left)
    : [];
  if (comparisonYears.some((comparisonYear) => {
    const range = getTrafficComparisonYearRange({ periodMode: draft.periodMode, from, to, seasonCode, comparisonYear });
    return range.from === from && range.to === to;
  })) throw new Error('Năm so sánh không được trùng với kỳ hiện tại.');

  const period: TrafficWorkbookExportRequest['period'] = { mode: draft.periodMode, seasonCode, from, to };
  if (seasonCode) period.seasonCode = seasonCode;
  if (month) period.month = month;
  if (monthFrom) period.monthFrom = monthFrom;
  if (monthTo) period.monthTo = monthTo;
  if (year != null) period.year = year;
  return {
    reportType: draft.reportType,
    templateVersion,
    period,
    comparisons: draft.reportType === 'WEEKLY_DETAIL' || draft.reportType === 'PERIOD_ANALYSIS' || draft.reportType === 'BAO_CAO_SAN_LUONG'
      ? []
      : [...new Set(draft.comparisons)].sort() as TrafficWorkbookComparison[],
    comparisonYears,
    timeBasis: draft.timeBasis,
    filters: {
      airline: [...filter.airline],
      route: [...filter.route],
      country: [...filter.country],
    },
  };
}

export function buildTrafficWorkbookExportUrl(request: TrafficWorkbookExportRequest): string {
  const params = new URLSearchParams({
    report_type: request.reportType,
    template_version: request.templateVersion,
    period_mode: request.period.mode,
    from: request.period.from,
    to: request.period.to,
    tz: request.timeBasis,
  });
  if (request.period.seasonCode) params.set('season_code', request.period.seasonCode);
  if (request.period.month) params.set('month', request.period.month);
  if (request.period.monthFrom) params.set('month_from', request.period.monthFrom);
  if (request.period.monthTo) params.set('month_to', request.period.monthTo);
  if (request.period.year) params.set('year', String(request.period.year));
  for (const comparison of request.comparisons) params.append('comparison', comparison);
  for (const comparisonYear of request.comparisonYears) params.append('comparison_year', String(comparisonYear));
  for (const airline of request.filters.airline) params.append('airline', airline);
  for (const route of request.filters.route) params.append('route', route);
  for (const country of request.filters.country) params.append('country', country);
  return `${TRAFFIC_WORKBOOK_EXPORT_API}?${params.toString()}`;
}

export function getTrafficWorkbookDownloadName(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([A-Za-z0-9._-]+)"/u);
  return match?.[1] ?? fallback;
}
