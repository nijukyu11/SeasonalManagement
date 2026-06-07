import { findDuplicateFlightNumberViolations, flightRecordsToLegs } from './atomicSchedule';
import { applyModificationsToFlightLegs } from './detailedScheduleState';
import type { FlightCounter, FlightLeg, FlightModification, FlightRecord } from './types';

export type DailyCellField =
  | 'sta'
  | 'std'
  | 'mcat'
  | 'mcdt'
  | 'mct'
  | 'aircraft'
  | 'route'
  | 'from'
  | 'to'
  | 'category'
  | 'codeShares'
  | 'arrCodeShare'
  | 'pax'
  | 'arrPax'
  | 'depPax'
  | 'gate'
  | 'stand'
  | 'arrStand'
  | 'counter'
  | 'counters'
  | 'carousel'
  | 'bhs'
  | 'ghs'
  | 'arrFlight'
  | 'depFlight';

export type DailyGridField =
  | 'aircraft'
  | 'arrFlight'
  | 'sta'
  | 'mcat'
  | 'from'
  | 'arrPax'
  | 'carousel'
  | 'arrStand'
  | 'arrCodeShare'
  | 'depFlight'
  | 'std'
  | 'mcdt'
  | 'to'
  | 'depPax'
  | 'gate'
  | 'counters';

export interface DailyFilterState {
  query?: string;
  type?: 'all' | 'arrivals' | 'departures';
  aircraft?: string;
  route?: string;
  arrFlight?: string;
  sta?: string;
  mcat?: string;
  from?: string;
  arrPax?: number | null;
  carousel?: number | null;
  arrStand?: number | null;
  arrCodeShare?: string;
  depFlight?: string;
  std?: string;
  mcdt?: string;
  to?: string;
  depPax?: number | null;
  gate?: number | null;
  counters?: string;
}

export interface DailySortState {
  field: 'time' | 'route' | DailyGridField;
  direction: 'asc' | 'desc';
}

export interface DailyScheduleRow {
  id: string;
  pairKey: string;
  dateTime: string;
  arr?: FlightLeg;
  dep?: FlightLeg;
}

export interface DailySummary {
  arr: number;
  dep: number;
  total: number;
}

export interface DailyDateRange {
  from: string;
  to: string;
}

export interface DailyScheduleBuildInput {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  from: string;
  to: string;
}

export interface DailyCellValidationInput {
  records: FlightRecord[];
  record: FlightRecord;
  field: DailyCellField;
  value: string;
}

export interface DailyCellValidationResult {
  valid: boolean;
  message?: string;
}

function addUtcDays(isoDate: string, offsetDays: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeDailyDateTimeParam(value: string | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;

  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (!isValidIsoDate(match[1]) || hours > 23 || minutes > 59) return null;
  return `${match[1]}T${match[2]}:${match[3]}`;
}

export function readDailyDateRangeQuery(searchParams: Pick<URLSearchParams, 'get'>): DailyDateRange | null {
  const from = normalizeDailyDateTimeParam(searchParams.get('from'));
  const to = normalizeDailyDateTimeParam(searchParams.get('to'));
  if (!from || !to || from >= to) return null;
  return { from, to };
}

function legDateTime(leg: Pick<FlightLeg, 'date' | 'schedule'>): string {
  return `${leg.date}T${leg.schedule}`;
}

export function formatDailyScheduleDateTime(leg: Pick<FlightLeg, 'date' | 'schedule'> | null | undefined): string {
  if (!leg?.date || !leg.schedule) return '';
  return `${leg.date} ${leg.schedule}`;
}

function isFlightLeg(leg: FlightLeg | undefined): leg is FlightLeg {
  return leg != null;
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error('Daily schedule numeric fields require a valid number');
  return parsed;
}

function nullablePositiveInteger(value: string, fieldName: string): number | null {
  const parsed = nullableNumber(value);
  if (parsed == null) return null;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${fieldName} must be a positive integer`);
  return parsed;
}

function normalizeCounter(value: string): FlightCounter {
  return normalizeText(value);
}

function counterText(counter: FlightCounter): string {
  if (counter == null) return '';
  if (typeof counter === 'string') return counter;
  return JSON.stringify(counter);
}

function textMatches(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return (actual ?? '').toLowerCase().includes(expected.toLowerCase());
}

function numberMatches(actual: number | null | undefined, expected: number | null | undefined): boolean {
  if (expected == null) return true;
  return actual === expected;
}

function rowDateTime(row: Pick<DailyScheduleRow, 'arr' | 'dep'>): string {
  const values = [row.arr, row.dep].filter(isFlightLeg).map((leg) => legDateTime(leg));
  return values.sort()[0] ?? '';
}

function rowFlightLabel(row: DailyScheduleRow, side: 'A' | 'D'): string {
  const leg = side === 'A' ? row.arr : row.dep;
  return leg?.flightNumber ?? '';
}

function rowFieldValue(row: DailyScheduleRow, field: DailySortState['field']): string | number {
  if (field === 'time') return row.dateTime;
  if (field === 'arrFlight') return rowFlightLabel(row, 'A');
  if (field === 'depFlight') return rowFlightLabel(row, 'D');
  if (field === 'sta') return row.arr ? legDateTime(row.arr) : row.dateTime;
  if (field === 'std') return row.dep ? legDateTime(row.dep) : row.dateTime;
  if (field === 'mcat') return row.arr?.mct ?? '';
  if (field === 'mcdt') return row.dep?.mct ?? '';
  if (field === 'from') return row.arr?.route ?? '';
  if (field === 'to') return row.dep?.route ?? '';
  if (field === 'arrPax') return row.arr?.pax ?? Number.MAX_SAFE_INTEGER;
  if (field === 'depPax') return row.dep?.pax ?? Number.MAX_SAFE_INTEGER;
  if (field === 'carousel') return row.arr?.carousel ?? Number.MAX_SAFE_INTEGER;
  if (field === 'arrStand') return row.arr?.stand ?? Number.MAX_SAFE_INTEGER;
  if (field === 'arrCodeShare') return row.arr?.codeShares ?? '';
  if (field === 'counters') return counterText(row.dep?.counter ?? null);
  if (field === 'gate') return row.dep?.gate ?? Number.MAX_SAFE_INTEGER;
  const leg = row.arr ?? row.dep;
  if (!leg) return '';
  return leg[field] ?? '';
}

function pairKeyForLeg(leg: FlightLeg): string {
  return `${leg.linkId}|${leg.pairAnchorDate ?? leg.date}`;
}

function buildRow(pairKey: string, arr?: FlightLeg, dep?: FlightLeg): DailyScheduleRow {
  const id = [arr?.id, dep?.id].filter(Boolean).join('__') || pairKey;
  const row = { id, pairKey, arr, dep, dateTime: '' };
  return { ...row, dateTime: rowDateTime(row) };
}

function normalizeEditedFlightNumber(record: FlightRecord, value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (trimmed === '') return '';
  if (trimmed.startsWith(record.airline)) return trimmed;
  return `${record.airline}${trimmed.padStart(3, '0')}`;
}

export function buildDefaultDailyDateRange(baseIsoDate: string): DailyDateRange {
  return {
    from: `${baseIsoDate}T05:00`,
    to: `${addUtcDays(baseIsoDate, 1)}T05:00`,
  };
}

export function buildDailyScheduleRows(input: DailyScheduleBuildInput): DailyScheduleRow[] {
  const baseLegs = flightRecordsToLegs(input.records);
  const legs = applyModificationsToFlightLegs(baseLegs, input.modifications)
    .filter((leg) => {
      const dateTime = legDateTime(leg);
      return dateTime >= input.from && dateTime < input.to;
    })
    .sort((a, b) => legDateTime(a).localeCompare(legDateTime(b)) || a.flightNumber.localeCompare(b.flightNumber));

  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const rows: DailyScheduleRow[] = [];
  const consumed = new Set<string>();

  for (const leg of legs) {
    if (consumed.has(leg.id)) continue;
    const linked = leg.linkedRecordId ? byId.get(leg.linkedRecordId) : undefined;
    if (linked && linked.type !== leg.type && !consumed.has(linked.id)) {
      const arr = leg.type === 'A' ? leg : linked;
      const dep = leg.type === 'D' ? leg : linked;
      rows.push(buildRow(`linked:${arr.id}:${dep.id}`, arr, dep));
      consumed.add(arr.id);
      consumed.add(dep.id);
    }
  }

  const byPairKey = new Map<string, FlightLeg[]>();
  for (const leg of legs) {
    if (consumed.has(leg.id)) continue;
    const key = pairKeyForLeg(leg);
    byPairKey.set(key, [...(byPairKey.get(key) ?? []), leg]);
  }

  for (const [pairKey, pairLegs] of byPairKey) {
    const arr = pairLegs.find((leg) => leg.type === 'A');
    const dep = pairLegs.find((leg) => leg.type === 'D');
    if (arr && dep) {
      rows.push(buildRow(pairKey, arr, dep));
      consumed.add(arr.id);
      consumed.add(dep.id);
    }
  }

  for (const leg of legs) {
    if (consumed.has(leg.id)) continue;
    rows.push(leg.type === 'A'
      ? buildRow(`single:${leg.id}`, leg, undefined)
      : buildRow(`single:${leg.id}`, undefined, leg));
    consumed.add(leg.id);
  }

  return rows.sort((a, b) => a.dateTime.localeCompare(b.dateTime) || a.id.localeCompare(b.id));
}

export function buildDailySummary(rows: DailyScheduleRow[]): DailySummary {
  const arr = rows.filter((row) => row.arr).length;
  const dep = rows.filter((row) => row.dep).length;
  return {
    arr,
    dep,
    total: arr + dep,
  };
}

export function getDailyRowRecordIds(row: Pick<DailyScheduleRow, 'arr' | 'dep'>): string[] {
  return [row.arr?.id, row.dep?.id].filter((id): id is string => Boolean(id));
}

export function buildDailyCellModification(
  record: Pick<FlightRecord, 'id'>,
  field: DailyCellField,
  value: string
): FlightModification {
  const mod: FlightModification = {
    legId: record.id,
    action: 'modified',
  };

  switch (field) {
    case 'sta':
    case 'std':
      mod.schedule = value.trim();
      return mod;
    case 'mcat':
    case 'mcdt':
    case 'mct':
      mod.mct = normalizeText(value);
      return mod;
    case 'aircraft':
      mod.aircraft = value.trim();
      return mod;
    case 'route':
    case 'from':
    case 'to':
      mod.route = value.trim().toUpperCase();
      return mod;
    case 'codeShares':
    case 'arrCodeShare':
      mod.codeShares = normalizeText(value);
      return mod;
    case 'pax':
    case 'arrPax':
    case 'depPax':
      mod.pax = nullableNumber(value);
      return mod;
    case 'gate':
      mod.gate = nullablePositiveInteger(value, 'gate');
      return mod;
    case 'stand':
    case 'arrStand':
      mod.stand = nullablePositiveInteger(value, 'stand');
      return mod;
    case 'counter':
    case 'counters':
      mod.counter = normalizeCounter(value);
      return mod;
    case 'bhs':
      mod.bhs = normalizeText(value);
      return mod;
    case 'carousel':
      mod.carousel = nullablePositiveInteger(value, 'carousel');
      return mod;
    case 'ghs':
      mod.ghs = normalizeText(value);
      return mod;
    default:
      throw new Error(`Unsupported daily schedule field: ${field}`);
  }
}

export function validateDailyCellEdit(input: DailyCellValidationInput): DailyCellValidationResult {
  const timeValue = input.value.trim();
  if ((input.field === 'sta' || input.field === 'std') && !isValidTime(timeValue)) {
    return { valid: false, message: 'Time must use HH:mm format' };
  }
  if (
    (input.field === 'mcat' || input.field === 'mcdt' || input.field === 'mct') &&
    timeValue !== '' &&
    !isValidTime(timeValue)
  ) {
    return { valid: false, message: 'Time must use HH:mm format' };
  }

  if (
    input.field === 'pax' ||
    input.field === 'arrPax' ||
    input.field === 'depPax' ||
    input.field === 'gate' ||
    input.field === 'stand' ||
    input.field === 'arrStand' ||
    input.field === 'carousel'
  ) {
    const value = input.value.trim();
    if (value !== '' && !Number.isFinite(Number(value))) {
      return { valid: false, message: 'Value must be numeric' };
    }
    if (
      value !== '' &&
      (input.field === 'gate' || input.field === 'stand' || input.field === 'arrStand' || input.field === 'carousel') &&
      (!Number.isInteger(Number(value)) || Number(value) <= 0)
    ) {
      return { valid: false, message: 'Value must be a positive integer' };
    }
  }

  if (input.field === 'arrFlight' || input.field === 'depFlight') {
    const edited = normalizeEditedFlightNumber(input.record, input.value);
    const nextRecords = input.records.map((record) => (
      record.id === input.record.id
        ? { ...record, flightNumber: edited, rawFlightNumber: input.value.trim() }
        : record
    ));
    const violations = findDuplicateFlightNumberViolations(nextRecords);
    if (violations.length > 0) {
      return {
        valid: false,
        message: `Duplicate flight number ${violations[0].flightNumber} on ${violations[0].date}`,
      };
    }
  }

  return { valid: true };
}

export function filterDailyRows(rows: DailyScheduleRow[], filters: DailyFilterState): DailyScheduleRow[] {
  const query = filters.query?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.type === 'arrivals' && !row.arr) return false;
    if (filters.type === 'departures' && !row.dep) return false;
    const legs = [row.arr, row.dep].filter(isFlightLeg);
    if (filters.aircraft && !legs.some((leg) => leg.aircraft === filters.aircraft)) return false;
    if (filters.route && !legs.some((leg) => leg.route.includes(filters.route ?? ''))) return false;
    if (!textMatches(row.arr?.flightNumber, filters.arrFlight)) return false;
    if (!textMatches(formatDailyScheduleDateTime(row.arr), filters.sta)) return false;
    if (!textMatches(row.arr?.mct, filters.mcat)) return false;
    if (!textMatches(row.arr?.route, filters.from)) return false;
    if (!numberMatches(row.arr?.pax, filters.arrPax)) return false;
    if (!numberMatches(row.arr?.carousel, filters.carousel)) return false;
    if (!numberMatches(row.arr?.stand, filters.arrStand)) return false;
    if (!textMatches(row.arr?.codeShares, filters.arrCodeShare)) return false;
    if (!textMatches(row.dep?.flightNumber, filters.depFlight)) return false;
    if (!textMatches(formatDailyScheduleDateTime(row.dep), filters.std)) return false;
    if (!textMatches(row.dep?.mct, filters.mcdt)) return false;
    if (!textMatches(row.dep?.route, filters.to)) return false;
    if (!numberMatches(row.dep?.pax, filters.depPax)) return false;
    if (filters.gate != null && row.dep?.gate !== filters.gate) return false;
    if (filters.counters && !textMatches(counterText(row.dep?.counter ?? null), filters.counters)) return false;
    if (!query) return true;
    return legs.some((leg) => [
      leg.flightNumber,
      leg.rawFlightNumber,
      formatDailyScheduleDateTime(leg),
      leg.mct ?? '',
      leg.fb ?? '',
      leg.lb ?? '',
      leg.route,
      leg.aircraft,
      leg.category,
      leg.codeShares ?? '',
      leg.bhs ?? '',
      leg.ghs ?? '',
    ].join(' ').toLowerCase().includes(query));
  });
}

export function sortDailyRows(rows: DailyScheduleRow[], sort: DailySortState): DailyScheduleRow[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = rowFieldValue(left, sort.field);
    const rightValue = rowFieldValue(right, sort.field);
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction;
    }
    return String(leftValue).localeCompare(String(rightValue)) * direction || left.id.localeCompare(right.id);
  });
}
