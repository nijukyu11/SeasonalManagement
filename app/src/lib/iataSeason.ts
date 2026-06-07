import type { FlightRecord } from './types';

const OPERATIONAL_DAY_START_MINUTES = 5 * 60;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftIsoDate(iso: string, offsetDays: number): string {
  const date = parseIsoDate(iso);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDate(date);
}

function parseTimeMinutes(time: string | null | undefined): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ''));
  if (!match) return OPERATIONAL_DAY_START_MINUTES;
  return Number(match[1]) * 60 + Number(match[2]);
}

function lastSunday(year: number, utcMonth: number): string {
  const date = new Date(Date.UTC(year, utcMonth + 1, 0));
  while (date.getUTCDay() !== 0) date.setUTCDate(date.getUTCDate() - 1);
  return isoDate(date);
}

function seasonCode(prefix: 'S' | 'W', year: number): string {
  return `${prefix}${String(year).slice(-2)}`;
}

export interface IataSeasonDateRange {
  code: string;
  start: string;
  end: string;
}

export interface OperationalFlightMetadata {
  scheduledDate: string;
  scheduledTime: string;
  operationalDate: string;
  iataSeasonCode: string;
  flightSeriesId: string;
}

export function getOperationalDate(scheduledDate: string, scheduledTime: string | null | undefined): string {
  if (!scheduledDate) return scheduledDate;
  return parseTimeMinutes(scheduledTime) < OPERATIONAL_DAY_START_MINUTES
    ? shiftIsoDate(scheduledDate, -1)
    : scheduledDate;
}

export function getSeasonDateRange(code: string): IataSeasonDateRange {
  const normalized = String(code ?? '').trim().toUpperCase();
  const match = /^([SW])(\d{2})$/.exec(normalized);
  if (!match) throw new Error(`Invalid IATA season code: ${code}`);
  const year = 2000 + Number(match[2]);
  const summerStart = lastSunday(year, 2);
  const winterStart = lastSunday(year, 9);

  if (match[1] === 'S') {
    return {
      code: normalized,
      start: summerStart,
      end: shiftIsoDate(winterStart, -1),
    };
  }

  const nextSummerStart = lastSunday(year + 1, 2);
  return {
    code: normalized,
    start: winterStart,
    end: shiftIsoDate(nextSummerStart, -1),
  };
}

export function getIataSeasonForOperationalDate(operationalDate: string): IataSeasonDateRange {
  const date = parseIsoDate(operationalDate);
  const year = date.getUTCFullYear();
  const currentSummer = getSeasonDateRange(seasonCode('S', year));
  if (operationalDate >= currentSummer.start && operationalDate <= currentSummer.end) return currentSummer;

  const currentWinter = getSeasonDateRange(seasonCode('W', year));
  if (operationalDate >= currentWinter.start && operationalDate <= currentWinter.end) return currentWinter;

  return getSeasonDateRange(seasonCode('W', year - 1));
}

function safeIdPart(value: string | number | null | undefined): string {
  return String(value ?? 'none')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'NONE';
}

export function buildFlightSeriesId(input: Pick<FlightRecord, 'type' | 'airline' | 'flightNumber' | 'route'>): string {
  return [
    'SER',
    safeIdPart(input.type),
    safeIdPart(input.airline),
    safeIdPart(input.flightNumber),
    safeIdPart(input.route),
  ].join('_');
}

export function buildOperationalFlightMetadata(input: {
  scheduledDate: string;
  scheduledTime: string;
  type: FlightRecord['type'];
  airline: string;
  flightNumber: string;
  route: string;
}): OperationalFlightMetadata {
  const operationalDate = getOperationalDate(input.scheduledDate, input.scheduledTime);
  return {
    scheduledDate: input.scheduledDate,
    scheduledTime: input.scheduledTime,
    operationalDate,
    iataSeasonCode: getIataSeasonForOperationalDate(operationalDate).code,
    flightSeriesId: buildFlightSeriesId(input),
  };
}

export function withOperationalFlightMetadata<T extends FlightRecord>(record: T): T {
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: record.scheduledDate ?? record.date,
    scheduledTime: record.scheduledTime ?? record.schedule,
    type: record.type,
    airline: record.airline,
    flightNumber: record.flightNumber,
    route: record.route,
  });
  return {
    ...record,
    ...metadata,
    date: metadata.scheduledDate,
    dayOfWeek: new Date(`${metadata.scheduledDate}T00:00:00Z`).getUTCDay(),
  };
}
