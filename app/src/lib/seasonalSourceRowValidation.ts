import * as XLSX from 'xlsx';
import type { SeasonalSourceRowCandidate, SeasonalSourceRowIssue } from './types.ts';

type ExcelSsf = typeof XLSX.SSF;

function isExcelSsf(value: unknown): value is ExcelSsf {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { parse_date_code?: unknown }).parse_date_code === 'function';
}

function resolveExcelSsf(): ExcelSsf {
  const moduleNamespace = XLSX as unknown as Record<string, unknown>;
  const namespaceSsf = moduleNamespace['SSF'];
  if (isExcelSsf(namespaceSsf)) return namespaceSsf;

  const commonJsModule = moduleNamespace['default'];
  if (typeof commonJsModule === 'object' && commonJsModule !== null) {
    const commonJsSsf = (commonJsModule as Record<string, unknown>)['SSF'];
    if (isExcelSsf(commonJsSsf)) return commonJsSsf;
  }

  throw new Error('XLSX SSF date parser is unavailable.');
}

const EXCEL_SSF = resolveExcelSsf();

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const REQUIRED_SEASONAL_HEADERS = [
  'Effective',
  'Discontinue',
  'Airline',
  'Aircraft',
  ...DAY_HEADERS,
  'STA',
  'ARRFlight',
  'ARRRoute',
  'STD',
  'DEPFlight',
  'DEPRoute',
] as const;

function buildUtcIsoDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || year < 1
    || year > 9999
  ) {
    return null;
  }

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

export function normalizeSeasonalDate(value: unknown, date1904 = false): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (value <= 0 || (!date1904 && value === 60)) return null;

    const parsed = EXCEL_SSF.parse_date_code(value, { date1904 });
    if (!parsed) return null;

    return buildUtcIsoDate(parsed.y, parsed.m, parsed.d);
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return buildUtcIsoDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  const seasonalMatch = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (!seasonalMatch) return null;

  const month = MONTHS[seasonalMatch[2].toUpperCase()];
  if (month == null) return null;
  const rawYear = Number(seasonalMatch[3]);
  const year = seasonalMatch[3].length === 2 ? 2000 + rawYear : rawYear;
  return buildUtcIsoDate(year, month, Number(seasonalMatch[1]));
}

export function normalizeSeasonalTime(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 1) return null;
    const totalMinutes = Math.min(1439, Math.round(value * 24 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function normalizeSeasonalDay(value: unknown): { value: boolean; valid: boolean } {
  if (value == null) return { value: false, valid: true };
  if (typeof value === 'boolean') return { value, valid: true };
  if (typeof value === 'number') {
    if (value === 1) return { value: true, valid: true };
    if (value === 0) return { value: false, valid: true };
    return { value: false, valid: false };
  }
  if (typeof value !== 'string') return { value: false, valid: false };

  const text = value.trim().toUpperCase();
  if (!text) return { value: false, valid: true };
  if (text === 'TRUE' || text === '1') return { value: true, valid: true };
  if (text === 'FALSE' || text === '0') return { value: false, valid: true };
  return { value: false, valid: false };
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function hasText(value: unknown): boolean {
  return !isBlank(value);
}

function rowIssue(
  row: SeasonalSourceRowCandidate,
  code: SeasonalSourceRowIssue['code'],
  column: string | null,
  message: string,
): SeasonalSourceRowIssue {
  return {
    code,
    rowIndex: row.rowIndex,
    column,
    message: `Row ${row.rowIndex}: ${message}`,
  };
}

export function validateSeasonalSourceRow(
  row: SeasonalSourceRowCandidate,
  date1904 = false,
): SeasonalSourceRowIssue[] {
  const issues: SeasonalSourceRowIssue[] = [];
  const effective = normalizeSeasonalDate(row.effective, date1904);
  const discontinue = normalizeSeasonalDate(row.discontinue, date1904);

  if (!effective) {
    issues.push(rowIssue(
      row,
      'invalid-effective-date',
      'Effective',
      'Effective is not a valid seasonal date.',
    ));
  }
  if (!discontinue) {
    issues.push(rowIssue(
      row,
      'invalid-discontinue-date',
      'Discontinue',
      'Discontinue is not a valid seasonal date.',
    ));
  }
  if (effective && discontinue && effective > discontinue) {
    issues.push(rowIssue(
      row,
      'reversed-date-range',
      null,
      'Effective must be on or before Discontinue.',
    ));
  }

  const sta = normalizeSeasonalTime(row.sta);
  const std = normalizeSeasonalTime(row.std);
  if (!isBlank(row.sta) && !sta) {
    issues.push(rowIssue(
      row,
      'invalid-time',
      'STA',
      'STA must be a valid time from 00:00 through 23:59.',
    ));
  }
  if (!isBlank(row.std) && !std) {
    issues.push(rowIssue(
      row,
      'invalid-time',
      'STD',
      'STD must be a valid time from 00:00 through 23:59.',
    ));
  }

  const sourceDays = Array.isArray(row.daysOfWeek) ? row.daysOfWeek : [];
  const days = DAY_HEADERS.map((column, index) => {
    const normalized = normalizeSeasonalDay(sourceDays[index]);
    if (!normalized.valid) {
      issues.push(rowIssue(
        row,
        'invalid-day-value',
        column,
        `${column} must be TRUE, FALSE, 1, 0, or blank.`,
      ));
    }
    return normalized;
  });
  if (!days.some((day) => day.value)) {
    issues.push(rowIssue(
      row,
      'no-operating-days',
      null,
      'At least one operating day from Mon through Sun is required.',
    ));
  }

  if (!hasText(row.airline)) {
    issues.push(rowIssue(row, 'missing-airline', 'Airline', 'Airline is required.'));
  }
  if (!hasText(row.aircraft)) {
    issues.push(rowIssue(row, 'missing-aircraft', 'Aircraft', 'Aircraft is required.'));
  }

  const hasArrFlight = hasText(row.arrFlight);
  const hasArrRoute = hasText(row.arrRoute);
  const hasSta = hasText(row.sta);
  const hasAnyArrival = hasSta || hasArrFlight || hasArrRoute;
  const hasStructurallyCompleteArrival = hasSta && hasArrFlight && hasArrRoute;
  if (hasAnyArrival && !hasStructurallyCompleteArrival) {
    issues.push(rowIssue(
      row,
      'incomplete-flight-side',
      'ARR',
      'ARR must include STA, ARRFlight, and ARRRoute together.',
    ));
  }

  const hasDepFlight = hasText(row.depFlight);
  const hasDepRoute = hasText(row.depRoute);
  const hasStd = hasText(row.std);
  const hasAnyDeparture = hasStd || hasDepFlight || hasDepRoute;
  const hasStructurallyCompleteDeparture = hasStd && hasDepFlight && hasDepRoute;
  if (hasAnyDeparture && !hasStructurallyCompleteDeparture) {
    issues.push(rowIssue(
      row,
      'incomplete-flight-side',
      'DEP',
      'DEP must include STD, DEPFlight, and DEPRoute together.',
    ));
  }

  if (!hasStructurallyCompleteArrival && !hasStructurallyCompleteDeparture) {
    issues.push(rowIssue(
      row,
      'no-flight-side',
      null,
      'At least one complete ARR or DEP flight side is required.',
    ));
  }

  return issues;
}
