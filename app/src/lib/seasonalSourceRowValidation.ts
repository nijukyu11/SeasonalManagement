import * as XLSX from 'xlsx';
import type { ParsedRow, SeasonalSourceRowIssue } from './types';

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export const REQUIRED_SEASONAL_HEADERS = [
  'Effective', 'Discontinue', 'Airline', 'Aircraft',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'STA', 'ARRFlight', 'ARRRoute', 'STD', 'DEPFlight', 'DEPRoute',
] as const;

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeSeasonalDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ssf = XLSX.SSF ?? (XLSX as typeof XLSX & { default?: typeof XLSX }).default?.SSF;
    const parsed = ssf?.parse_date_code(value);
    return parsed ? isoDate(parsed.y, parsed.m, parsed.d) : null;
  }
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(text);
  if (!named) return null;
  const month = MONTHS[named[2].toUpperCase()];
  if (!month) return null;
  const rawYear = Number(named[3]);
  return isoDate(rawYear < 100 ? 2000 + rawYear : rawYear, month, Number(named[1]));
}

export function normalizeSeasonalTime(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    if (totalMinutes >= 24 * 60) return null;
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function normalizeSeasonalDay(value: unknown): { value: boolean; valid: boolean } {
  if (value === true || value === 1) return { value: true, valid: true };
  if (value === false || value === 0 || value === '') return { value: false, valid: true };
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'TRUE' || normalized === '1') return { value: true, valid: true };
    if (normalized === 'FALSE' || normalized === '0' || normalized === '') return { value: false, valid: true };
  }
  return { value: false, valid: false };
}

export function validateSeasonalSourceRow(row: ParsedRow): SeasonalSourceRowIssue[] {
  const issues: SeasonalSourceRowIssue[] = [];
  const add = (code: SeasonalSourceRowIssue['code'], column: string | null, message: string) => {
    issues.push({ code, rowIndex: row.rowIndex, column, message });
  };
  if (!row.effective) add('invalid-effective-date', 'Effective', 'Effective date is invalid.');
  if (!row.discontinue) add('invalid-discontinue-date', 'Discontinue', 'Discontinue date is invalid.');
  if (row.effective && row.discontinue && row.effective > row.discontinue) {
    add('reversed-date-range', 'Discontinue', 'Discontinue date is before Effective date.');
  }
  if (!row.airline) add('missing-airline', 'Airline', 'Airline is required.');
  if (!row.aircraft) add('missing-aircraft', 'Aircraft', 'Aircraft is required.');
  if (!row.daysOfWeek.some(Boolean)) add('no-operating-days', null, 'At least one operating day is required.');
  const arrivalStarted = Boolean(row.arrFlight || row.sta || row.arrRoute);
  const departureStarted = Boolean(row.depFlight || row.std || row.depRoute);
  const arrivalComplete = Boolean(row.arrFlight && row.sta && row.arrRoute);
  const departureComplete = Boolean(row.depFlight && row.std && row.depRoute);
  if (arrivalStarted && !arrivalComplete) add('incomplete-flight-side', 'ARRFlight', 'Arrival requires STA, ARRFlight, and ARRRoute.');
  if (departureStarted && !departureComplete) add('incomplete-flight-side', 'DEPFlight', 'Departure requires STD, DEPFlight, and DEPRoute.');
  if (!arrivalComplete && !departureComplete) add('no-flight-side', null, 'At least one complete arrival or departure is required.');
  return issues;
}
