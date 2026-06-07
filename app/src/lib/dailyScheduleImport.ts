import * as XLSX from 'xlsx';
import { assertNoDuplicateFlightNumbers, linkFlightRecordPairs } from './atomicSchedule';
import { buildOperationalFlightMetadata, getOperationalDate } from './iataSeason';
import type { FlightCounter, FlightModification, FlightRecord, ModHistoryEntry } from './types';

export type DailyImportRawRow = Record<string, unknown>;

export interface DailyScheduleImportStats {
  importedRows: number;
  updated: number;
  inserted: number;
  deleted: number;
  skipped: number;
}

export interface DailyScheduleImportUpdate {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  historyEntry: ModHistoryEntry | null;
  stats: DailyScheduleImportStats;
}

export interface DailyImportSeasonBatch {
  seasonCode: string;
  rows: DailyImportRawRow[];
  operationalDates: string[];
  legCount: number;
}

interface ImportedLeg {
  side: 'ARR' | 'DEP';
  type: 'A' | 'D';
  rowNumber: number;
  sourceRowIndex: number;
  flightNumber: string;
  rawFlightNumber: string;
  airline: string;
  date: string;
  scheduledDate: string;
  scheduledTime: string;
  operationalDate: string;
  iataSeasonCode: string;
  flightSeriesId: string;
  schedule: string;
  aircraft: string;
  category: string;
  flightType: string;
  requestStatusCode: string | null;
  updates: Partial<Pick<FlightModification,
    'schedule' | 'route' | 'codeShares' | 'pax' | 'mct' | 'fb' | 'lb' | 'carousel' | 'stand' | 'gate' | 'counter'
  >>;
}

interface ParsedDateTime {
  date: string | null;
  time: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAILY_IMPORT_HEADER_SCAN_ROWS = 10;

const DAILY_IMPORT_CANONICAL_COLUMNS: Record<number, string> = {
  1: 'AIRCRAFT_SERIES',
  3: 'ARR-AIRLINE_FLIGHT_SUFFIX',
  6: 'ARR-Scheduled',
  7: 'ARR-FlightType',
  8: 'ARR-ORIG_DEST_AIRPORT_CODE',
  9: 'ARR-FlightCategory',
  10: 'ARR-STATUS_CODE',
  12: 'ARR-MCT',
  15: 'ARR-BagFirst',
  16: 'ARR-BagLast',
  17: 'ARR-PAX_TOTAL',
  18: 'ARRReclaimBelt',
  20: 'ARRStand',
  21: 'ARR-CODESHARES',
  23: 'DEP-AIRLINE_FLIGHT_SUFFIX',
  26: 'DEP-Scheduled',
  27: 'DEP-FlightType',
  28: 'DEP-ORIG_DEST_AIRPORT_CODE',
  29: 'DEP-FlightCategory',
  30: 'DEP-STATUS_CODE',
  32: 'DEP-MCT',
  36: 'DEP-PAX_TOTAL',
  37: 'DEPGate',
  38: 'CheckInDesk',
  40: 'DEPStand',
  41: 'DEP-CODESHARES',
};

const DAILY_IMPORT_HEADER_ALIASES: Record<number, string[]> = {
  1: ['AIRCRAFT_SERIES', 'A/C Type'],
  3: ['ARR-AIRLINE_FLIGHT_SUFFIX', 'Arr Flight'],
  6: ['ARR-Scheduled', 'STA'],
  7: ['ARR-FlightType', 'Type'],
  8: ['ARR-ORIG_DEST_AIRPORT_CODE', 'From'],
  9: ['ARR-FlightCategory', 'Qual'],
  12: ['ARR-MCT', 'MCAT'],
  17: ['ARR-PAX_TOTAL', 'ARR-PAX', 'Ttl ARR PAX'],
  18: ['ARRReclaimBelt', 'Carousel'],
  20: ['ARRStand', 'Arr Stand'],
  21: ['ARR-CODESHARES', 'Arr Code Shar'],
  23: ['DEP-AIRLINE_FLIGHT_SUFFIX', 'Dep Flight'],
  26: ['DEP-Scheduled', 'STD'],
  27: ['DEP-FlightType', 'Type'],
  28: ['DEP-ORIG_DEST_AIRPORT_CODE', 'To'],
  29: ['DEP-FlightCategory', 'Qual'],
  32: ['DEP-MCT', 'MCDT'],
  36: ['DEP-PAX_TOTAL', 'DEP-PAX', 'DEP PAX'],
  37: ['DEPGate', 'Gate'],
  38: ['CheckInDesk', 'Counters'],
  40: ['DEPStand', 'Dep Stand'],
  41: ['DEP-CODESHARES', 'Dep Code Sha'],
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function headerMatches(value: unknown, aliases: string[] | undefined): boolean {
  if (!aliases) return false;
  const normalized = normalizeHeader(value);
  return aliases.some((alias) => normalizeHeader(alias) === normalized);
}

function dailyImportHeaderScore(row: unknown[], offset: number): number {
  return Object.entries(DAILY_IMPORT_HEADER_ALIASES).reduce((score, [indexText, aliases]) => {
    const oldIndex = Number(indexText);
    return score + (headerMatches(row[oldIndex + offset], aliases) ? 1 : 0);
  }, 0);
}

function detectDailyImportLayout(rows: unknown[][]): { headerIndex: number; columnOffset: number } | null {
  let best: { headerIndex: number; columnOffset: number; score: number } | null = null;
  const scanRows = rows.slice(0, DAILY_IMPORT_HEADER_SCAN_ROWS);
  for (let headerIndex = 0; headerIndex < scanRows.length; headerIndex++) {
    const row = scanRows[headerIndex];
    for (const columnOffset of [0, 1]) {
      const score = dailyImportHeaderScore(row, columnOffset);
      if (!best || score > best.score) best = { headerIndex, columnOffset, score };
    }
  }
  return best && best.score >= 4
    ? { headerIndex: best.headerIndex, columnOffset: best.columnOffset }
    : null;
}

function rowHasValue(row: unknown[]): boolean {
  return row.some((value) => textValue(value) != null);
}

export function parseDailyImportWorksheet(sheet: XLSX.WorkSheet): DailyImportRawRow[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: false,
  });
  const layout = detectDailyImportLayout(rows);
  if (!layout) {
    return XLSX.utils.sheet_to_json<DailyImportRawRow>(sheet, {
      defval: null,
      raw: false,
    });
  }

  return rows
    .slice(layout.headerIndex + 1)
    .filter(rowHasValue)
    .map((row) => {
      const normalized: DailyImportRawRow = {};
      for (const [oldIndexText, key] of Object.entries(DAILY_IMPORT_CANONICAL_COLUMNS)) {
        const value = row[Number(oldIndexText) + layout.columnOffset];
        normalized[key] = value ?? null;
      }
      return normalized;
    });
}

function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function safeIdPart(value: string | number | null | undefined): string {
  return String(value ?? 'none').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'none';
}

function textValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function readColumn(row: DailyImportRawRow, names: string[]): { present: boolean; value: unknown } {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      return { present: true, value: row[name] };
    }
  }
  return { present: false, value: null };
}

function normalizeUpperText(value: unknown): string {
  return textValue(value)?.toUpperCase() ?? '';
}

function normalizeNullableUpperText(value: unknown): string | null {
  return textValue(value)?.toUpperCase() ?? null;
}

function nullableInteger(value: unknown): number | null {
  const text = textValue(value);
  if (text == null) return null;
  const parsed = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Expected integer value, got ${text}`);
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown): number | null {
  const parsed = nullableInteger(value);
  if (parsed == null) return null;
  if (parsed <= 0) throw new Error(`Expected positive integer value, got ${parsed}`);
  return parsed;
}

function nullableGateResource(value: unknown): number | null {
  const text = textValue(value);
  if (text == null) return null;
  const gateMatch = /^G\s*0*(\d+)$/i.exec(text);
  return nullablePositiveInteger(gateMatch ? gateMatch[1] : text);
}

function normalizeCounterTokenText(value: string): string {
  const counterMatch = /^C\s*0*(\d+)$/i.exec(value.trim());
  return counterMatch ? counterMatch[1] : value.trim().toUpperCase();
}

function normalizeCounter(value: unknown): FlightCounter {
  const text = textValue(value);
  if (text == null) return null;
  return text
    .split(/[,\s;]+/)
    .map((part) => normalizeCounterTokenText(part))
    .filter(Boolean)
    .join(',');
}

function parseExcelSerialDateTime(value: number): ParsedDateTime | null {
  if (!Number.isFinite(value)) return null;
  const wholeDays = Math.floor(value);
  const fractionalDay = value - wholeDays;
  const date = new Date(EXCEL_EPOCH_UTC + wholeDays * MS_PER_DAY);
  const totalMinutes = Math.round(fractionalDay * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return {
    date: isoFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
    time: `${pad2(hours)}:${pad2(minutes)}`,
  };
}

export function parseDailyImportDateTime(value: unknown): ParsedDateTime | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return parseExcelSerialDateTime(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      date: isoFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate()),
      time: `${pad2(value.getHours())}:${pad2(value.getMinutes())}`,
    };
  }

  const text = String(value).trim();
  if (text === '') return null;

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (isoMatch) {
    return {
      date: isoFromParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])),
      time: `${pad2(Number(isoMatch[4] ?? 0))}:${isoMatch[5] ?? '00'}`,
    };
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (slashMatch) {
    const rawYear = Number(slashMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return {
      date: isoFromParts(year, Number(slashMatch[2]), Number(slashMatch[1])),
      time: `${pad2(Number(slashMatch[4] ?? 0))}:${slashMatch[5] ?? '00'}`,
    };
  }

  const timeMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (timeMatch) {
    return {
      date: null,
      time: `${pad2(Number(timeMatch[1]))}:${timeMatch[2]}`,
    };
  }

  return null;
}

function parseScheduled(value: unknown): { date: string; schedule: string } | null {
  const parsed = parseDailyImportDateTime(value);
  if (!parsed?.date) return null;
  return { date: parsed.date, schedule: parsed.time };
}

function parseOperationalTime(value: unknown): string | null {
  return parseDailyImportDateTime(value)?.time ?? null;
}

function normalizeFlightIdentity(value: unknown): { flightNumber: string; airline: string; rawFlightNumber: string } | null {
  const compact = textValue(value)?.toUpperCase().replace(/\s+/g, '') ?? '';
  if (!compact) return null;
  const iataMatch = /^([A-Z0-9]{2})([0-9].*)$/.exec(compact);
  const match = iataMatch && /[A-Z]/.test(iataMatch[1])
    ? iataMatch
    : /^([A-Z]+)([0-9].*)$/.exec(compact);
  if (!match) return null;
  const airline = match[1];
  const rawFlightNumber = match[2];
  const suffixMatch = /^(\d+)(.*)$/.exec(rawFlightNumber);
  const normalizedSuffix = suffixMatch
    ? `${suffixMatch[1].padStart(3, '0')}${suffixMatch[2] ?? ''}`
    : rawFlightNumber;
  return {
    airline,
    rawFlightNumber,
    flightNumber: `${airline}${normalizedSuffix}`,
  };
}

function updateIfPresent<T extends keyof ImportedLeg['updates']>(
  updates: ImportedLeg['updates'],
  row: DailyImportRawRow,
  names: string[],
  key: T,
  normalize: (value: unknown) => ImportedLeg['updates'][T]
): void {
  const column = readColumn(row, names);
  if (!column.present) return;
  updates[key] = normalize(column.value);
}

function parseImportedLeg(row: DailyImportRawRow, side: 'ARR' | 'DEP', rowNumber: number, sourceRowIndex: number): ImportedLeg | null {
  const prefix = side;
  const type = side === 'ARR' ? 'A' : 'D';
  const flight = normalizeFlightIdentity(readColumn(row, [`${prefix}-AIRLINE_FLIGHT_SUFFIX`]).value);
  const scheduled = parseScheduled(readColumn(row, [`${prefix}-Scheduled`]).value);
  if (!flight || !scheduled) return null;

  const updates: ImportedLeg['updates'] = {
    schedule: scheduled.schedule,
  };
  updateIfPresent(updates, row, [`${prefix}-ORIG_DEST_AIRPORT_CODE`], 'route', normalizeUpperText);
  updateIfPresent(updates, row, [`${prefix}-CODESHARES`], 'codeShares', normalizeNullableUpperText);
  updateIfPresent(updates, row, [`${prefix}-PAX`, `${prefix}_PAX`, `${prefix}-PAX_TOTAL`, `${prefix}_PAX_TOTAL`], 'pax', nullableInteger);
  updateIfPresent(updates, row, [`${prefix}-MCT`], 'mct', parseOperationalTime);
  updateIfPresent(updates, row, [`${prefix}Stand`], 'stand', nullablePositiveInteger);

  if (side === 'ARR') {
    updateIfPresent(updates, row, ['ARR-BagFirst'], 'fb', parseOperationalTime);
    updateIfPresent(updates, row, ['ARR-BagLast'], 'lb', parseOperationalTime);
    updateIfPresent(updates, row, ['ARRReclaimBelt'], 'carousel', nullablePositiveInteger);
  } else {
    updateIfPresent(updates, row, ['DEPGate'], 'gate', nullableGateResource);
    updateIfPresent(updates, row, ['CheckInDesk'], 'counter', normalizeCounter);
  }
  const route = updates.route ?? '';
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: scheduled.date,
    scheduledTime: scheduled.schedule,
    type,
    airline: flight.airline,
    flightNumber: flight.flightNumber,
    route,
  });

  return {
    side,
    type,
    rowNumber,
    sourceRowIndex,
    ...flight,
    date: metadata.scheduledDate,
    scheduledDate: metadata.scheduledDate,
    scheduledTime: metadata.scheduledTime,
    operationalDate: metadata.operationalDate,
    iataSeasonCode: metadata.iataSeasonCode,
    flightSeriesId: metadata.flightSeriesId,
    schedule: scheduled.schedule,
    aircraft: normalizeUpperText(readColumn(row, ['AIRCRAFT_SERIES', `${prefix}-AidxAircraftType`]).value),
    category: normalizeUpperText(readColumn(row, [`${prefix}-FlightCategory`]).value) || 'J',
    flightType: normalizeUpperText(readColumn(row, [`${prefix}-FlightType`]).value) || 'PAX',
    requestStatusCode: normalizeNullableUpperText(readColumn(row, [`${prefix}-STATUS_CODE`]).value),
    updates,
  };
}

function isDailyImportSideKey(key: string, side: 'ARR' | 'DEP'): boolean {
  if (side === 'ARR') return key.startsWith('ARR');
  return key.startsWith('DEP') || key === 'DEPGate' || key === 'DEPStand' || key === 'CheckInDesk';
}

function onlyDailyImportSide(row: DailyImportRawRow, side: 'ARR' | 'DEP'): DailyImportRawRow {
  const opposite = side === 'ARR' ? 'DEP' : 'ARR';
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !isDailyImportSideKey(key, opposite))
  );
}

export function partitionDailyImportRowsByIataSeason(importRows: DailyImportRawRow[]): DailyImportSeasonBatch[] {
  const batches = new Map<string, DailyImportSeasonBatch>();
  const ensureBatch = (seasonCode: string): DailyImportSeasonBatch => {
    const existing = batches.get(seasonCode);
    if (existing) return existing;
    const next: DailyImportSeasonBatch = {
      seasonCode,
      rows: [],
      operationalDates: [],
      legCount: 0,
    };
    batches.set(seasonCode, next);
    return next;
  };

  importRows.forEach((row, index) => {
    const arrLeg = parseImportedLeg(row, 'ARR', index + 1, index + 1);
    const depLeg = parseImportedLeg(row, 'DEP', index + 1, index + 1);
    const legs = [arrLeg, depLeg].filter((leg): leg is ImportedLeg => leg != null);
    if (legs.length === 0) return;
    const seasonCodes = new Set(legs.map((leg) => leg.iataSeasonCode));
    if (seasonCodes.size === 1) {
      const batch = ensureBatch(legs[0].iataSeasonCode);
      batch.rows.push(row);
      for (const leg of legs) {
        batch.operationalDates.push(leg.operationalDate);
        batch.legCount += 1;
      }
      return;
    }

    for (const leg of legs) {
      const batch = ensureBatch(leg.iataSeasonCode);
      batch.rows.push(onlyDailyImportSide(row, leg.side));
      batch.operationalDates.push(leg.operationalDate);
      batch.legCount += 1;
    }
  });

  return Array.from(batches.values());
}

function recordOperationalDate(record: Pick<FlightRecord, 'date' | 'schedule'> & Partial<Pick<FlightRecord, 'scheduledDate' | 'scheduledTime' | 'operationalDate'>>): string {
  return record.operationalDate ?? getOperationalDate(record.scheduledDate ?? record.date, record.scheduledTime ?? record.schedule);
}

function recordKey(record: Pick<FlightRecord, 'type' | 'airline' | 'flightNumber' | 'route' | 'schedule' | 'date'> & Partial<Pick<FlightRecord, 'scheduledDate' | 'scheduledTime' | 'operationalDate'>>): string {
  return [
    recordOperationalDate(record),
    record.type,
    record.airline,
    record.flightNumber,
    record.route,
    record.schedule,
  ].join('|');
}

function recordLooseKey(record: Pick<FlightRecord, 'type' | 'airline' | 'flightNumber' | 'date' | 'schedule'> & Partial<Pick<FlightRecord, 'scheduledDate' | 'scheduledTime' | 'operationalDate'>>): string {
  return [
    recordOperationalDate(record),
    record.type,
    record.airline,
    record.flightNumber,
  ].join('|');
}

function importedKey(leg: Pick<ImportedLeg, 'type' | 'airline' | 'flightNumber' | 'schedule' | 'date' | 'scheduledDate' | 'scheduledTime' | 'operationalDate' | 'updates'>): string {
  return [
    leg.operationalDate,
    leg.type,
    leg.airline,
    leg.flightNumber,
    leg.updates.route ?? '',
    leg.schedule,
  ].join('|');
}

function importedLooseKey(leg: Pick<ImportedLeg, 'type' | 'airline' | 'flightNumber' | 'operationalDate'>): string {
  return [
    leg.operationalDate,
    leg.type,
    leg.airline,
    leg.flightNumber,
  ].join('|');
}

function buildNewRecord(leg: ImportedLeg): FlightRecord {
  const id = [
    'DAILY_IMPORT',
    leg.type,
    safeIdPart(leg.operationalDate),
    safeIdPart(leg.flightNumber),
    safeIdPart(leg.updates.route ?? ''),
    safeIdPart(leg.schedule),
    safeIdPart(leg.aircraft),
  ].join('_');

  return {
    id,
    linkId: id,
    type: leg.type,
    airline: leg.airline,
    flightNumber: leg.flightNumber,
    rawFlightNumber: leg.rawFlightNumber,
    requestStatusCode: leg.requestStatusCode,
    route: leg.updates.route ?? '',
    schedule: leg.schedule,
    scheduledDate: leg.scheduledDate,
    scheduledTime: leg.scheduledTime,
    operationalDate: leg.operationalDate,
    iataSeasonCode: leg.iataSeasonCode,
    flightSeriesId: leg.flightSeriesId,
    aircraft: leg.aircraft,
    category: leg.category,
    flightType: leg.flightType,
    codeShares: leg.updates.codeShares ?? null,
    intDomInd: null,
    pax: leg.updates.pax ?? null,
    gate: leg.updates.gate ?? null,
    stand: leg.updates.stand ?? null,
    counter: leg.updates.counter ?? null,
    carousel: leg.updates.carousel ?? null,
    mct: leg.updates.mct ?? null,
    fb: leg.updates.fb ?? null,
    lb: leg.updates.lb ?? null,
    bhs: null,
    ghs: null,
    date: leg.scheduledDate,
    dayOfWeek: dayOfWeek(leg.scheduledDate),
    action: null,
    sourceRowIndex: leg.sourceRowIndex,
    sourceKind: 'added',
    sourceSide: leg.side,
    status: 'active',
  };
}

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function effectiveValue(record: FlightRecord, mod: FlightModification | null, key: keyof ImportedLeg['updates']): unknown {
  if (mod && key in mod) return mod[key as keyof FlightModification];
  return record[key as keyof FlightRecord];
}

function mergeImportedFields(
  record: FlightRecord,
  previousMod: FlightModification | null,
  leg: ImportedLeg
): FlightModification | null {
  const changed: FlightModification = {
    ...(previousMod ?? { legId: record.id, action: 'modified' as const }),
    legId: record.id,
    action: 'modified',
  };
  let hasChange = false;

  for (const [key, value] of Object.entries(leg.updates) as Array<[keyof ImportedLeg['updates'], unknown]>) {
    if (isSameValue(effectiveValue(record, previousMod, key), value)) continue;
    (changed as unknown as Record<string, unknown>)[key] = value;
    hasChange = true;
  }

  return hasChange ? changed : null;
}

function inferPairLinkType(arr: FlightRecord, dep: FlightRecord): 'overnight' | 'sameday' {
  return dep.date > arr.date ? 'overnight' : 'sameday';
}

function shouldLinkPair(arr: FlightRecord, dep: FlightRecord, linkType: 'overnight' | 'sameday'): boolean {
  return arr.linkedRecordId !== dep.id ||
    dep.linkedRecordId !== arr.id ||
    arr.linkType !== linkType ||
    dep.linkType !== linkType;
}

export function buildDailyScheduleImportUpdate(input: {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  importRows: DailyImportRawRow[];
  timestamp: number;
  historyId: string;
  nextSourceRowIndex?: number;
}): DailyScheduleImportUpdate {
  let nextRecords = input.records.map((record) => ({ ...record }));
  const nextMods = new Map(input.modifications);
  const originalRecordsById = new Map(input.records.map((record) => [record.id, record]));
  const recordsByKey = new Map<string, FlightRecord>();
  const recordsByLooseKey = new Map<string, FlightRecord>();
  const operationalChanges: ModHistoryEntry['changes'] = [];
  const modChangedIds = new Set<string>();
  const linkedPairRequests: Array<{ arrId: string; depId: string }> = [];
  const stats: DailyScheduleImportStats = {
    importedRows: input.importRows.length,
    updated: 0,
    inserted: 0,
    deleted: 0,
    skipped: 0,
  };

  for (const record of nextRecords) {
    if (record.status !== 'deleted') {
      recordsByKey.set(recordKey(record), record);
      recordsByLooseKey.set(recordLooseKey(record), record);
    }
  }

  const baseSourceRowIndex = input.nextSourceRowIndex ?? Math.max(0, ...input.records.map((record) => record.sourceRowIndex ?? 0)) + 1;
  const importedKeys = new Set<string>();
  const importedLooseKeys = new Set<string>();
  const importedOperationalDates: string[] = [];

  input.importRows.forEach((row, index) => {
    const sourceRowIndex = baseSourceRowIndex + index;
    const arrLeg = parseImportedLeg(row, 'ARR', index + 1, sourceRowIndex);
    const depLeg = parseImportedLeg(row, 'DEP', index + 1, sourceRowIndex);
    if (!arrLeg && !depLeg) {
      stats.skipped += 1;
      return;
    }

    const upserted: Partial<Record<'ARR' | 'DEP', FlightRecord>> = {};
    for (const leg of [arrLeg, depLeg].filter((item): item is ImportedLeg => item != null)) {
      importedKeys.add(importedKey(leg));
      importedLooseKeys.add(importedLooseKey(leg));
      importedOperationalDates.push(leg.operationalDate);
      const existing = recordsByKey.get(importedKey(leg)) ?? recordsByLooseKey.get(importedLooseKey(leg));
      if (existing) {
        const previousMod = nextMods.get(existing.id) ?? null;
        const nextMod = mergeImportedFields(existing, previousMod, leg);
        if (nextMod) {
          nextMods.set(existing.id, nextMod);
          if (!modChangedIds.has(existing.id)) {
            operationalChanges.push({
              legId: existing.id,
              previousMod,
              newMod: nextMod,
            });
            modChangedIds.add(existing.id);
            stats.updated += 1;
          } else {
            const change = operationalChanges.find((entry) => entry.legId === existing.id);
            if (change) change.newMod = nextMod;
          }
        }
        upserted[leg.side] = existing;
      } else {
        const record = buildNewRecord(leg);
        nextRecords = [...nextRecords, record];
        recordsByKey.set(recordKey(record), record);
        recordsByLooseKey.set(recordLooseKey(record), record);
        upserted[leg.side] = record;
        stats.inserted += 1;
      }
    }

    if (upserted.ARR && upserted.DEP) {
      linkedPairRequests.push({ arrId: upserted.ARR.id, depId: upserted.DEP.id });
    }
  });

  if (importedOperationalDates.length > 0) {
    const sortedImportDates = [...importedOperationalDates].sort();
    const rangeStart = sortedImportDates[0];
    const rangeEnd = sortedImportDates[sortedImportDates.length - 1];
    nextRecords = nextRecords.map((record) => {
      const operationalDate = recordOperationalDate(record);
      if (
        record.status === 'deleted' ||
        operationalDate < rangeStart ||
        operationalDate > rangeEnd ||
        importedKeys.has(recordKey(record)) ||
        importedLooseKeys.has(recordLooseKey(record))
      ) {
        return record;
      }
      stats.deleted += 1;
      return {
        ...record,
        status: 'deleted',
        action: 'deleted',
      };
    });
  }

  for (const pair of linkedPairRequests) {
    const byId = new Map(nextRecords.map((record) => [record.id, record]));
    const arr = byId.get(pair.arrId);
    const dep = byId.get(pair.depId);
    if (!arr || !dep) continue;
    const linkType = inferPairLinkType(arr, dep);
    if (!shouldLinkPair(arr, dep, linkType)) continue;
    nextRecords = linkFlightRecordPairs(nextRecords, [arr.id], [dep.id], linkType).records;
  }

  assertNoDuplicateFlightNumbers(nextRecords);

  const recordChanges = nextRecords.flatMap((record) => {
    const previousRecord = originalRecordsById.get(record.id) ?? null;
    if (previousRecord && isSameValue(previousRecord, record)) return [];
    return [{
      recordId: record.id,
      previousRecord,
      newRecord: record,
    }];
  });

  const hasChanges = operationalChanges.length > 0 || recordChanges.length > 0;
  return {
    records: nextRecords,
    modifications: nextMods,
    historyEntry: hasChanges
      ? {
          id: input.historyId,
          timestamp: input.timestamp,
          description: `Daily import: updated ${stats.updated}, inserted ${stats.inserted}, deleted ${stats.deleted}`,
          changes: operationalChanges,
          recordChanges,
        }
      : null,
    stats,
  };
}
