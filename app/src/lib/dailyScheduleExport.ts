import * as XLSX from 'xlsx';
import { resolveCountryForRoute } from './routeCountry';
import type { DailyScheduleRow } from './dailySchedule';
import type { FlightCounter, FlightLeg, RouteCountryMapping } from './types';

export const DAILY_SCHEDULE_EXPORT_HEADERS = [
  'Type',
  'Flight',
  'Config',
  'STA/STD',
  'Routes',
  'TTL Pax',
  'Load Factor',
  'Airlines',
  'Ops Date',
  'Country',
  'A/C Type',
  'Stand',
  'Carousel',
  'Gate',
  'Counters',
  'MCAT',
  'FB',
  'LB',
  'GHS',
] as const;

const DAILY_SCHEDULE_EXPORT_COLUMN_WIDTHS = [
  4.27,
  7,
  5.82,
  14.64,
  6.18,
  6.45,
  10,
  6.73,
  9.64,
  9.64,
  7.73,
  5.27,
  7.82,
  4.27,
  8,
  14.64,
  2.45,
  2.36,
  5.27,
];

interface DailyScheduleSummaryWorkbookInput {
  rows: DailyScheduleRow[];
  routeCountries?: RouteCountryMapping[];
}

function parseDateTimeSerial(date: string | undefined, time: string | null | undefined): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!dateMatch) return null;
  const timeMatch = /^(\d{2}):(\d{2})/.exec(String(time ?? '00:00').trim());
  const hours = timeMatch ? Number(timeMatch[1]) : 0;
  const minutes = timeMatch ? Number(timeMatch[2]) : 0;
  if (hours > 23 || minutes > 59) return null;
  const utcMs = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes);
  return utcMs / 86_400_000 + 25569;
}

function parseIsoDateTimeSerial(value: string | null | undefined): number | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}))?/.exec(trimmed);
  if (!match) return null;
  return parseDateTimeSerial(match[1], match[2] ?? '00:00');
}

function formatCounter(counter: FlightCounter): string {
  if (counter == null) return '';
  if (Array.isArray(counter)) return counter.map((item) => String(item).trim()).filter(Boolean).join(',');
  if (typeof counter === 'object') {
    const values: string[] = [];
    for (const entry of Object.values(counter)) {
      if (Array.isArray(entry)) values.push(...entry.map((item) => String(item).trim()).filter(Boolean));
      else if (entry !== null && entry !== undefined) values.push(String(entry).trim());
    }
    return values.filter(Boolean).join(',');
  }
  return String(counter).trim();
}

function exportLegToRow(leg: FlightLeg, routeCountries?: RouteCountryMapping[]): unknown[] {
  const scheduledSerial = parseDateTimeSerial(leg.scheduledDate ?? leg.date, leg.scheduledTime ?? leg.schedule);
  const opsDateSerial = parseDateTimeSerial(leg.operationalDate ?? leg.date, '00:00');
  const mcatSerial = leg.type === 'A'
    ? parseIsoDateTimeSerial(leg.mct) ?? parseDateTimeSerial(leg.date, leg.mct)
    : null;

  return [
    leg.type,
    leg.flightNumber,
    '',
    scheduledSerial ?? '',
    leg.route,
    leg.pax ?? 0,
    0,
    leg.airline,
    opsDateSerial ?? '',
    resolveCountryForRoute(leg.route, routeCountries),
    leg.aircraft,
    leg.stand ?? '',
    leg.type === 'A' ? leg.carousel ?? '' : '',
    leg.type === 'D' ? leg.gate ?? '' : '',
    leg.type === 'D' ? formatCounter(leg.counter) : '',
    mcatSerial ?? '',
    leg.fb ?? '',
    leg.lb ?? '',
    leg.ghs ?? leg.bhs ?? '',
  ];
}

function appendLegRows(output: unknown[][], row: DailyScheduleRow, routeCountries?: RouteCountryMapping[]): void {
  for (const leg of [row.arr, row.dep]) {
    if (!leg || leg.action === 'deleted') continue;
    output.push(exportLegToRow(leg, routeCountries));
  }
}

function applyDateFormats(worksheet: XLSX.WorkSheet, rowCount: number): void {
  for (let rowIndex = 2; rowIndex <= rowCount; rowIndex += 1) {
    for (const column of ['D', 'P']) {
      const cell = worksheet[`${column}${rowIndex}`] as XLSX.CellObject | undefined;
      if (cell && cell.v !== '') cell.z = 'm/d/yy h:mm';
    }
    const cell = worksheet[`I${rowIndex}`] as XLSX.CellObject | undefined;
    if (cell && cell.v !== '') cell.z = 'm/d/yy';
  }
}

export function buildDailyScheduleSummaryWorkbook(input: DailyScheduleSummaryWorkbookInput): XLSX.WorkBook {
  const data: unknown[][] = [Array.from(DAILY_SCHEDULE_EXPORT_HEADERS)];
  for (const row of input.rows) appendLegRows(data, row, input.routeCountries);

  const worksheet = XLSX.utils.aoa_to_sheet(data);
  worksheet['!cols'] = DAILY_SCHEDULE_EXPORT_COLUMN_WIDTHS.map((wch) => ({ wch }));
  applyDateFormats(worksheet, data.length);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Summary');
  return workbook;
}

function compactDateTimeForFileName(value: string): string {
  return String(value || '')
    .slice(0, 10)
    .replace(/-/g, '') || 'range';
}

function buildExportTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function buildDailyScheduleExportFileName(
  seasonCode: string | null | undefined,
  fromDateTime: string,
  toDateTime: string,
  now = new Date()
): string {
  const seasonPart = String(seasonCode || 'Season').replace(/[^A-Za-z0-9_-]/g, '_');
  return `Daily_Schedule_${seasonPart}_${compactDateTimeForFileName(fromDateTime)}_${compactDateTimeForFileName(toDateTime)}_${buildExportTimestamp(now)}.xlsx`;
}
