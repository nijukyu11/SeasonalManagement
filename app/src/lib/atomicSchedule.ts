import * as XLSX from 'xlsx';
import { cleanFlightNumber } from './parser';
import { buildOperationalFlightMetadata, getOperationalDate } from './iataSeason';
import type { FlightLeg, FlightModification, FlightRecord, ParsedRow } from './types';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseSourceDate(raw: string | number | undefined): Date | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }

  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00Z`);
  }

  const parts = str.split('-');
  if (parts.length < 3) return null;
  const day = Number(parts[0]);
  const month = MONTHS[parts[1]];
  const yearNum = Number(parts[2]);
  if (!Number.isFinite(day) || month == null || !Number.isFinite(yearNum)) return null;
  const year = yearNum < 100 ? 2000 + yearNum : yearNum;
  return new Date(Date.UTC(year, month, day));
}

function isoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatSourceDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${date.getUTCDate()}-${MONTH_NAMES[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)}`;
}

function shiftIsoDate(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDate(date);
}

function dowIndex(iso: string): number {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function timeToMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const [h, m] = raw.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function operatingDates(row: ParsedRow): string[] {
  const start = parseSourceDate(row.effective);
  const end = parseSourceDate(row.discontinue);
  if (!start || !end) return [];

  const dates: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    const iso = isoDate(current);
    if (row.daysOfWeek[dowIndex(iso)]) dates.push(iso);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function safeIdPart(value: string | number | null | undefined): string {
  return String(value ?? 'none').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'none';
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function rowsForExactDateSet(row: ParsedRow, firstRowIndex: number, dates: string[], allocateRowIndex: () => number): ParsedRow[] {
  const remaining = sortedUnique(dates);
  const rows: ParsedRow[] = [];

  while (remaining.length > 0) {
    let bestEnd = 0;
    let bestDays = [false, false, false, false, false, false, false];
    let bestCovered = new Set([remaining[0]]);

    for (let end = 0; end < remaining.length; end++) {
      const candidateDates = remaining.slice(0, end + 1);
      const daysOfWeek = [false, false, false, false, false, false, false];
      candidateDates.forEach((date) => {
        daysOfWeek[dowIndex(date)] = true;
      });

      const candidate: ParsedRow = {
        ...row,
        rowIndex: firstRowIndex,
        effective: formatSourceDate(candidateDates[0]),
        discontinue: formatSourceDate(candidateDates[candidateDates.length - 1]),
        daysOfWeek,
      };
      const generated = operatingDates(candidate);
      const generatedSet = new Set(generated);
      const exact =
        generated.length === candidateDates.length &&
        candidateDates.every((date) => generatedSet.has(date));

      if (exact) {
        bestEnd = end;
        bestDays = daysOfWeek;
        bestCovered = generatedSet;
      }
    }

    const coveredDates = remaining.slice(0, bestEnd + 1);
    rows.push({
      ...row,
      rowIndex: rows.length === 0 ? firstRowIndex : allocateRowIndex(),
      effective: formatSourceDate(coveredDates[0]),
      discontinue: formatSourceDate(coveredDates[coveredDates.length - 1]),
      daysOfWeek: bestDays,
    });

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (bestCovered.has(remaining[i])) remaining.splice(i, 1);
    }
  }

  return rows;
}

function importMergeSignature(row: ParsedRow): string {
  if (row.overnightLinkRowIndex != null) return `linked:${row.rowIndex}`;

  return JSON.stringify([
    row.airline,
    row.aircraft,
    row.sta ?? null,
    row.arrFlight ?? null,
    row.arrRoute ?? null,
    row.arrFlightCategory ?? null,
    row.arrCodeShares ?? null,
    row.arrIntDomInd ?? null,
    row.std ?? null,
    row.depFlight ?? null,
    row.depRoute ?? null,
    row.depFlightCategory ?? null,
    row.depCodeShares ?? null,
    row.depIntDomInd ?? null,
    row.linkType ?? null,
  ]);
}

function displayFlightNumber(airline: string, raw: string | null): string | null {
  if (!raw) return null;
  return cleanFlightNumber(airline, raw)?.flightNumber ?? `${airline}${raw}`;
}

function duplicateSide(row: ParsedRow): 'ARR' | 'DEP' | 'TURNAROUND' {
  if (row.arrFlight && row.depFlight) return 'TURNAROUND';
  return row.arrFlight ? 'ARR' : 'DEP';
}

function duplicateFlightNumber(row: ParsedRow): string {
  const arr = displayFlightNumber(row.airline, row.arrFlight);
  const dep = displayFlightNumber(row.airline, row.depFlight);
  return [arr, dep].filter(Boolean).join('/') || row.airline;
}

export interface DuplicateImportPeriod {
  flightNumber: string;
  side: 'ARR' | 'DEP' | 'TURNAROUND';
  effective: string;
  discontinue: string;
  rowIndexes: number[];
  duplicateDates: number;
}

export interface DuplicateImportMergeResult {
  rows: ParsedRow[];
  duplicatePeriods: DuplicateImportPeriod[];
}

export interface DuplicateImportRecordMergeResult {
  records: FlightRecord[];
  duplicatePeriods: DuplicateImportPeriod[];
  changed: boolean;
}

interface SourceFlightSpec {
  side: 'ARR' | 'DEP';
  flightNumber: string;
}

function singleUnlinkedSourceFlight(row: ParsedRow): SourceFlightSpec | null {
  if (row.overnightLinkRowIndex != null) return null;

  const hasArrival = !!row.arrFlight && !!row.sta;
  const hasDeparture = !!row.depFlight && !!row.std;
  if (hasArrival === hasDeparture) return null;

  const side = hasArrival ? 'ARR' : 'DEP';
  const rawFlight = side === 'ARR' ? row.arrFlight : row.depFlight;
  const cleaned = cleanFlightNumber(row.airline, rawFlight ?? undefined);
  if (!cleaned) return null;
  return {
    side,
    flightNumber: cleaned.flightNumber,
  };
}

function reportKey(flightNumber: string, side: 'ARR' | 'DEP' | 'TURNAROUND'): string {
  return `${flightNumber}|${side}`;
}

function addDuplicatePeriodDate(
  reports: Map<string, { flightNumber: string; side: 'ARR' | 'DEP' | 'TURNAROUND'; dates: Set<string>; rowIndexes: Set<number> }>,
  flightNumber: string,
  side: 'ARR' | 'DEP' | 'TURNAROUND',
  date: string,
  rowIndexes: number[]
): void {
  const key = reportKey(flightNumber, side);
  const report = reports.get(key) ?? {
    flightNumber,
    side,
    dates: new Set<string>(),
    rowIndexes: new Set<number>(),
  };
  report.dates.add(date);
  rowIndexes.forEach((rowIndex) => report.rowIndexes.add(rowIndex));
  reports.set(key, report);
}

function duplicateReportsFromMap(
  reports: Map<string, { flightNumber: string; side: 'ARR' | 'DEP' | 'TURNAROUND'; dates: Set<string>; rowIndexes: Set<number> }>
): DuplicateImportPeriod[] {
  return Array.from(reports.values()).map((report) => {
    const dates = Array.from(report.dates).sort();
    return {
      flightNumber: report.flightNumber,
      side: report.side,
      effective: dates[0],
      discontinue: dates[dates.length - 1],
      rowIndexes: Array.from(report.rowIndexes).sort((a, b) => a - b),
      duplicateDates: dates.length,
    };
  });
}

function trimOverlappingImportRows(rows: ParsedRow[], allocateRowIndex: () => number): DuplicateImportMergeResult {
  const claimed = new Map<string, { rowIndex: number; side: 'ARR' | 'DEP'; flightNumber: string }>();
  const reports = new Map<string, { flightNumber: string; side: 'ARR' | 'DEP' | 'TURNAROUND'; dates: Set<string>; rowIndexes: Set<number> }>();
  const trimmedRows: ParsedRow[] = [];

  for (const row of rows) {
    const spec = singleUnlinkedSourceFlight(row);
    if (!spec) {
      trimmedRows.push(row);
      continue;
    }

    const keptDates: string[] = [];
    for (const date of operatingDates(row)) {
      const key = `${date}|${row.airline}|${spec.flightNumber}`;
      const existing = claimed.get(key);
      if (existing) {
        const side = existing.side === spec.side ? spec.side : 'TURNAROUND';
        addDuplicatePeriodDate(reports, spec.flightNumber, side, date, [existing.rowIndex, row.rowIndex]);
        continue;
      }

      claimed.set(key, {
        rowIndex: row.rowIndex,
        side: spec.side,
        flightNumber: spec.flightNumber,
      });
      keptDates.push(date);
    }

    const originalDateCount = operatingDates(row).length;
    if (keptDates.length === originalDateCount) {
      trimmedRows.push(row);
    } else if (keptDates.length > 0) {
      trimmedRows.push(...rowsForExactDateSet(row, row.rowIndex, keptDates, allocateRowIndex));
    }
  }

  return {
    rows: trimmedRows,
    duplicatePeriods: duplicateReportsFromMap(reports),
  };
}

export function mergeDuplicateImportPeriods(rows: ParsedRow[]): DuplicateImportMergeResult {
  const groups = new Map<string, ParsedRow[]>();
  const orderedKeys: string[] = [];

  for (const row of rows) {
    const key = importMergeSignature(row);
    if (!groups.has(key)) {
      groups.set(key, []);
      orderedKeys.push(key);
    }
    groups.get(key)!.push(row);
  }

  let nextRowIndex = Math.max(0, ...rows.map((row) => row.rowIndex)) + 1;
  const allocateRowIndex = () => nextRowIndex++;
  const mergedRows: ParsedRow[] = [];
  const duplicatePeriods: DuplicateImportPeriod[] = [];

  for (const key of orderedKeys) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      mergedRows.push(group[0]);
      continue;
    }

    const dateCounts = new Map<string, number>();
    const allDates: string[] = [];
    for (const row of group) {
      for (const date of operatingDates(row)) {
        allDates.push(date);
        dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
      }
    }

    const duplicateDates = Array.from(dateCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([date]) => date)
      .sort();

    if (duplicateDates.length === 0) {
      mergedRows.push(...group);
      continue;
    }

    const template = group[0];
    const rowsForUnion = rowsForExactDateSet(template, template.rowIndex, allDates, allocateRowIndex);
    mergedRows.push(...rowsForUnion);
    duplicatePeriods.push({
      flightNumber: duplicateFlightNumber(template),
      side: duplicateSide(template),
      effective: duplicateDates[0],
      discontinue: duplicateDates[duplicateDates.length - 1],
      rowIndexes: group.map((row) => row.rowIndex).sort((a, b) => a - b),
      duplicateDates: duplicateDates.length,
    });
  }

  const trimmed = trimOverlappingImportRows(mergedRows, allocateRowIndex);
  return {
    rows: trimmed.rows,
    duplicatePeriods: [...duplicatePeriods, ...trimmed.duplicatePeriods],
  };
}

function recordDuplicateKey(record: FlightRecord): string {
  return `${record.date}|${record.airline}|${record.flightNumber}`;
}

function sideFromRecordTypes(types: Set<FlightRecord['type']>): 'ARR' | 'DEP' | 'TURNAROUND' {
  if (types.has('A') && types.has('D')) return 'TURNAROUND';
  return types.has('A') ? 'ARR' : 'DEP';
}

function repairBrokenTurnaroundLinks(records: FlightRecord[]): { records: FlightRecord[]; changed: boolean } {
  const ids = new Set(records.map((record) => record.id));
  const turnaroundCounts = new Map<string, number>();
  for (const record of records) {
    if (!record.turnaroundId) continue;
    turnaroundCounts.set(record.turnaroundId, (turnaroundCounts.get(record.turnaroundId) ?? 0) + 1);
  }

  let changed = false;
  const repaired = records.map((record) => {
    if (!record.turnaroundId) return record;
    const missingLinkedRecord = record.linkedRecordId != null && !ids.has(record.linkedRecordId);
    const incompleteTurnaround = (turnaroundCounts.get(record.turnaroundId) ?? 0) < 2;
    if (!missingLinkedRecord && !incompleteTurnaround) return record;
    changed = true;
    return clearTurnaroundLink(record);
  });

  return { records: repaired, changed };
}

export function mergeDuplicateImportRecords(records: FlightRecord[]): DuplicateImportRecordMergeResult {
  const seen = new Map<string, FlightRecord>();
  const kept: FlightRecord[] = [];
  const reports = new Map<string, { flightNumber: string; side: 'ARR' | 'DEP' | 'TURNAROUND'; dates: Set<string>; rowIndexes: Set<number> }>();

  for (const record of records) {
    if (record.status === 'deleted' || record.action === 'deleted') {
      kept.push(record);
      continue;
    }

    const key = recordDuplicateKey(record);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, record);
      kept.push(record);
      continue;
    }

    addDuplicatePeriodDate(
      reports,
      record.flightNumber,
      sideFromRecordTypes(new Set([existing.type, record.type])),
      record.date,
      [existing.sourceRowIndex, record.sourceRowIndex]
    );
  }

  const repaired = repairBrokenTurnaroundLinks(kept);
  const duplicatePeriods = duplicateReportsFromMap(reports);

  return {
    records: repaired.records,
    duplicatePeriods,
    changed: duplicatePeriods.length > 0 || repaired.changed,
  };
}

function recordId(row: ParsedRow, side: 'ARR' | 'DEP', date: string): string {
  const rawFlight = side === 'ARR' ? row.arrFlight : row.depFlight;
  const route = side === 'ARR' ? row.arrRoute : row.depRoute;
  const schedule = side === 'ARR' ? row.sta : row.std;
  const cleaned = cleanFlightNumber(row.airline, rawFlight ?? undefined);
  const type = side === 'ARR' ? 'A' : 'D';
  const operationalDate = getOperationalDate(date, schedule);
  return [
    'LEG',
    type,
    operationalDate,
    row.rowIndex,
    safeIdPart(row.airline),
    safeIdPart(cleaned?.flightNumber ?? rawFlight),
    safeIdPart(route),
    safeIdPart(schedule),
    safeIdPart(row.aircraft),
  ].join('_');
}

function turnaroundId(row: ParsedRow, anchorDate: string): string {
  const operationalDate = getOperationalDate(anchorDate, row.sta ?? row.std);
  return [
    'TRN',
    operationalDate,
    row.rowIndex,
    safeIdPart(row.airline),
    safeIdPart(row.arrFlight),
    safeIdPart(row.depFlight),
  ].join('_');
}

function inferSameRowLinkType(row: ParsedRow): 'overnight' | 'sameday' {
  const arrMinutes = timeToMinutes(row.sta);
  const depMinutes = timeToMinutes(row.std);
  if (arrMinutes != null && depMinutes != null && depMinutes < arrMinutes) return 'overnight';
  return 'sameday';
}

function buildRecord(
  row: ParsedRow,
  side: 'ARR' | 'DEP',
  date: string,
  options: {
    linkId?: string;
    turnaroundId?: string;
    linkType?: 'overnight' | 'sameday';
    pairAnchorDate?: string;
    linkedSourceRowIndex?: number;
  } = {}
): FlightRecord | null {
  const rawFlight = side === 'ARR' ? row.arrFlight : row.depFlight;
  const schedule = side === 'ARR' ? row.sta : row.std;
  if (!rawFlight || !schedule) return null;

  const cleaned = cleanFlightNumber(row.airline, rawFlight);
  const type = side === 'ARR' ? 'A' : 'D';
  const route = side === 'ARR' ? row.arrRoute ?? '' : row.depRoute ?? '';
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: date,
    scheduledTime: schedule,
    type,
    airline: row.airline,
    flightNumber: cleaned?.flightNumber ?? `${row.airline}${rawFlight}`,
    route,
  });
  const id = recordId(row, side, date);
  const base: FlightRecord = {
    id,
    linkId: options.linkId ?? id,
    type,
    airline: row.airline,
    flightNumber: cleaned?.flightNumber ?? `${row.airline}${rawFlight}`,
    rawFlightNumber: cleaned?.rawFlightNumber ?? String(rawFlight),
    requestStatusCode: cleaned?.requestStatusCode ?? null,
    route,
    schedule,
    scheduledDate: metadata.scheduledDate,
    scheduledTime: metadata.scheduledTime,
    operationalDate: metadata.operationalDate,
    iataSeasonCode: metadata.iataSeasonCode,
    flightSeriesId: metadata.flightSeriesId,
    aircraft: row.aircraft,
    category: side === 'ARR' ? row.arrFlightCategory ?? '' : row.depFlightCategory ?? '',
    flightType: 'PAX',
    codeShares: side === 'ARR' ? row.arrCodeShares ?? null : row.depCodeShares ?? null,
    intDomInd: side === 'ARR' ? row.arrIntDomInd ?? null : row.depIntDomInd ?? null,
    pax: null,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date,
    dayOfWeek: dayOfWeek(date),
    action: null,
    sourceRowIndex: row.rowIndex,
    sourceKind: 'imported',
    sourceSide: side,
    status: 'active',
  };

  if (options.turnaroundId) base.turnaroundId = options.turnaroundId;
  if (options.linkType) base.linkType = options.linkType;
  if (options.pairAnchorDate) base.pairAnchorDate = options.pairAnchorDate;
  if (options.linkedSourceRowIndex != null) base.linkedSourceRowIndex = options.linkedSourceRowIndex;
  return base;
}

export function flattenRowsToFlightRecords(rows: ParsedRow[]): FlightRecord[] {
  const records: FlightRecord[] = [];
  const rowsByIndex = new Map(rows.map((row) => [row.rowIndex, row]));
  const processedRows = new Set<number>();

  for (const row of rows) {
    if (processedRows.has(row.rowIndex)) continue;

    if (row.overnightLinkRowIndex != null) {
      const partner = rowsByIndex.get(row.overnightLinkRowIndex);
      const arrRow = row.arrFlight && !row.depFlight ? row : partner?.arrFlight && !partner.depFlight ? partner : null;
      const depRow = row.depFlight && !row.arrFlight ? row : partner?.depFlight && !partner.arrFlight ? partner : null;

      if (partner && arrRow && depRow) {
        processedRows.add(arrRow.rowIndex);
        processedRows.add(depRow.rowIndex);

        const linkType = arrRow.linkType ?? depRow.linkType ?? inferSameRowLinkType({ ...arrRow, std: depRow.std });
        const arrDates = operatingDates(arrRow);
        const depDates = operatingDates(depRow);
        const depDateSet = new Set(depDates);
        const matchedDepDates = new Set<string>();

        for (const anchorDate of arrDates) {
          const depDate = linkType === 'overnight' ? shiftIsoDate(anchorDate, 1) : anchorDate;
          if (!depDateSet.has(depDate)) {
            const arr = buildRecord(arrRow, 'ARR', anchorDate);
            if (arr) records.push(arr);
            continue;
          }

          const linkId = turnaroundId({ ...arrRow, depFlight: depRow.depFlight }, anchorDate);
          const arr = buildRecord(arrRow, 'ARR', anchorDate, {
            linkId,
            turnaroundId: linkId,
            linkType,
            pairAnchorDate: anchorDate,
            linkedSourceRowIndex: depRow.rowIndex,
          });
          const dep = buildRecord(depRow, 'DEP', depDate, {
            linkId,
            turnaroundId: linkId,
            linkType,
            pairAnchorDate: anchorDate,
            linkedSourceRowIndex: arrRow.rowIndex,
          });
          if (arr && dep) {
            arr.linkedRecordId = dep.id;
            dep.linkedRecordId = arr.id;
            records.push(arr, dep);
            matchedDepDates.add(depDate);
          }
        }

        for (const depDate of depDates) {
          if (matchedDepDates.has(depDate)) continue;
          const dep = buildRecord(depRow, 'DEP', depDate);
          if (dep) records.push(dep);
        }
        continue;
      }
    }

    const dates = operatingDates(row);
    const hasArrival = !!row.arrFlight && !!row.sta;
    const hasDeparture = !!row.depFlight && !!row.std;

    for (const anchorDate of dates) {
      if (hasArrival && hasDeparture) {
        const linkType = inferSameRowLinkType(row);
        const depDate = linkType === 'overnight' ? shiftIsoDate(anchorDate, 1) : anchorDate;
        const linkId = turnaroundId(row, anchorDate);
        const arr = buildRecord(row, 'ARR', anchorDate, {
          linkId,
          turnaroundId: linkId,
          linkType,
          pairAnchorDate: anchorDate,
          linkedSourceRowIndex: row.rowIndex,
        });
        const dep = buildRecord(row, 'DEP', depDate, {
          linkId,
          turnaroundId: linkId,
          linkType,
          pairAnchorDate: anchorDate,
          linkedSourceRowIndex: row.rowIndex,
        });
        if (arr && dep) {
          arr.linkedRecordId = dep.id;
          dep.linkedRecordId = arr.id;
          records.push(arr, dep);
        }
        continue;
      }

      if (hasArrival) {
        const record = buildRecord(row, 'ARR', anchorDate);
        if (record) records.push(record);
      }
      if (hasDeparture) {
        const record = buildRecord(row, 'DEP', anchorDate);
        if (record) records.push(record);
      }
    }
  }

  return records;
}

export function flightRecordsToLegs(records: FlightRecord[]): FlightLeg[] {
  return records
    .filter((record) => record.status !== 'deleted')
    .map((record) => ({
      id: record.id,
      linkId: record.linkId,
      type: record.type,
      airline: record.airline,
      flightNumber: record.flightNumber,
      rawFlightNumber: record.rawFlightNumber,
      requestStatusCode: record.requestStatusCode,
      route: record.route,
      schedule: record.schedule,
      aircraft: record.aircraft,
      category: record.category,
      flightType: record.flightType ?? 'PAX',
      codeShares: record.codeShares,
      intDomInd: record.intDomInd,
        pax: record.pax ?? null,
        gate: record.gate ?? null,
        stand: record.stand ?? null,
        counter: record.counter ?? null,
        carousel: record.carousel ?? null,
        mct: record.mct ?? null,
        fb: record.fb ?? null,
        lb: record.lb ?? null,
        bhs: record.bhs ?? null,
      ghs: record.ghs ?? null,
      date: record.date,
      scheduledDate: record.scheduledDate,
      scheduledTime: record.scheduledTime,
      operationalDate: record.operationalDate,
      iataSeasonCode: record.iataSeasonCode,
      flightSeriesId: record.flightSeriesId,
      dayOfWeek: record.dayOfWeek,
      action: record.action,
      sourceRowIndex: record.sourceRowIndex,
      linkedSourceRowIndex: record.linkedSourceRowIndex,
      turnaroundId: record.turnaroundId,
      linkType: record.linkType,
      pairAnchorDate: record.pairAnchorDate,
      linkedRecordId: record.linkedRecordId,
    }));
}

export function includeLinkedPairsForExport(records: FlightRecord[], selectedIds?: string[]): FlightRecord[] {
  if (!selectedIds || selectedIds.length === 0) return records.filter((record) => record.status !== 'deleted');

  const selected = new Set(selectedIds);
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const id of selectedIds) {
    const record = byId.get(id);
    if (!record) continue;
    if (record.linkedRecordId) selected.add(record.linkedRecordId);
    if (record.turnaroundId) {
      for (const candidate of records) {
        if (candidate.turnaroundId === record.turnaroundId) selected.add(candidate.id);
      }
    }
  }

  return records.filter((record) => record.status !== 'deleted' && selected.has(record.id));
}

export function includeLinkedLegsForExport(legs: FlightLeg[], selectedIds?: string[]): FlightLeg[] {
  const activeLegs = legs.filter((leg) => leg.action !== 'deleted');
  if (!selectedIds || selectedIds.length === 0) return activeLegs;

  const selected = new Set(selectedIds);
  const byId = new Map(activeLegs.map((leg) => [leg.id, leg]));
  const pairKeys = new Set<string>();
  const pairKey = (leg: FlightLeg) => `${leg.linkId}|${leg.pairAnchorDate ?? leg.date}`;

  for (const id of selectedIds) {
    const leg = byId.get(id);
    if (!leg) continue;
    if (leg.linkedRecordId) selected.add(leg.linkedRecordId);
    if (leg.linkId) pairKeys.add(pairKey(leg));
  }

  for (const leg of activeLegs) {
    if (selected.has(leg.id)) continue;
    if (leg.linkedRecordId && selected.has(leg.linkedRecordId)) {
      selected.add(leg.id);
      continue;
    }
    if (leg.linkId && pairKeys.has(pairKey(leg))) selected.add(leg.id);
  }

  return activeLegs.filter((leg) => selected.has(leg.id));
}

export interface FlightRecordHydrationResult {
  records: FlightRecord[];
  needsFullPersist: boolean;
}

export function mergePersistedFlightRecords(
  rows: ParsedRow[],
  persistedRecords: FlightRecord[]
): FlightRecordHydrationResult {
  const sourceBackedRecords = rows.length > 0
    ? mergeDuplicateImportRecords(flattenRowsToFlightRecords(rows)).records
    : [];
  if (sourceBackedRecords.length === 0) {
    return { records: persistedRecords, needsFullPersist: false };
  }

  const persistedById = new Map(persistedRecords.map((record) => [record.id, record]));
  const sourceIds = new Set(sourceBackedRecords.map((record) => record.id));
  const missingSourceRecord = sourceBackedRecords.some((record) => !persistedById.has(record.id));

  const hydratedRecords = sourceBackedRecords.map((record) => persistedById.get(record.id) ?? record);
  for (const persisted of persistedRecords) {
    if (!sourceIds.has(persisted.id)) hydratedRecords.push(persisted);
  }
  const deduped = mergeDuplicateImportRecords(hydratedRecords);

  return {
    records: deduped.records,
    needsFullPersist: persistedRecords.length === 0 || missingSourceRecord || deduped.changed,
  };
}

export interface DuplicateFlightNumberViolation {
  date: string;
  airline: string;
  flightNumber: string;
  recordIds: string[];
}

type FlightIdentity = Pick<FlightLeg, 'id' | 'date' | 'airline' | 'flightNumber' | 'action'> & {
  status?: FlightRecord['status'];
};

export function findDuplicateFlightNumberViolations(records: FlightIdentity[]): DuplicateFlightNumberViolation[] {
  const seen = new Map<string, FlightIdentity[]>();

  for (const record of records) {
    if (record.status === 'deleted' || record.action === 'deleted') continue;
    const key = `${record.date}|${record.airline}|${record.flightNumber}`;
    const bucket = seen.get(key) ?? [];
    bucket.push(record);
    seen.set(key, bucket);
  }

  return Array.from(seen.entries())
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => {
      const [date, airline, flightNumber] = key.split('|');
      return {
        date,
        airline,
        flightNumber,
        recordIds: bucket.map((record) => record.id),
      };
    });
}

export function assertNoDuplicateFlightNumbers(records: FlightIdentity[]): void {
  const violations = findDuplicateFlightNumberViolations(records);
  if (violations.length === 0) return;

  const first = violations[0];
  throw new Error(
    `Duplicate flight number ${first.flightNumber} on ${first.date}. ` +
    `Each flight number may appear only once within a calendar day.`
  );
}

type FlightDuplicateModification = Pick<FlightModification, 'legId' | 'action'>;

function flightIdentityKey(record: FlightIdentity): string {
  return `${record.date}|${record.airline}|${record.flightNumber}`;
}

export function assertNoDuplicateFlightNumbersForEffectiveRecords(
  records: FlightIdentity[],
  modifications: Map<string, FlightDuplicateModification>,
  addedRecords: FlightIdentity[],
  pendingModifications: FlightDuplicateModification[] = []
): void {
  const addedKeys = new Set(
    addedRecords
      .filter((record) => record.status !== 'deleted' && record.action !== 'deleted')
      .map(flightIdentityKey)
  );
  if (addedKeys.size === 0) return;

  const effectiveModifications = new Map(modifications);
  for (const mod of pendingModifications) {
    effectiveModifications.set(mod.legId, mod);
  }

  const potentiallyConflictingRecords = records.filter((record) => {
    if (record.status === 'deleted' || record.action === 'deleted') return false;
    if (!addedKeys.has(flightIdentityKey(record))) return false;
    return effectiveModifications.get(record.id)?.action !== 'deleted';
  });

  assertNoDuplicateFlightNumbers([...potentiallyConflictingRecords, ...addedRecords]);
}

export interface FlightRecordMutationResult {
  records: FlightRecord[];
  updatedRecords: FlightRecord[];
  updatedIds: string[];
  preview: string[];
}

function clearTurnaroundLink(record: FlightRecord): FlightRecord {
  const next: FlightRecord = {
    ...record,
    linkId: record.id,
  };
  delete next.turnaroundId;
  delete next.pairAnchorDate;
  delete next.linkedRecordId;
  delete next.linkedSourceRowIndex;
  delete next.linkType;
  return next;
}

function mutationResult(records: FlightRecord[], updatedIds: Set<string>, preview: string[]): FlightRecordMutationResult {
  const updatedRecords = records.filter((record) => updatedIds.has(record.id));
  return {
    records,
    updatedRecords,
    updatedIds: Array.from(updatedIds),
    preview,
  };
}

export function unlinkFlightRecords(records: FlightRecord[], selectedIds: string[]): FlightRecordMutationResult {
  const selected = new Set(selectedIds);
  const byId = new Map(records.map((record) => [record.id, record]));
  const affected = new Set<string>();

  for (const id of selected) {
    const record = byId.get(id);
    if (!record || record.status === 'deleted') continue;
    affected.add(record.id);
    if (record.linkedRecordId) affected.add(record.linkedRecordId);
    if (record.turnaroundId) {
      for (const candidate of records) {
        if (candidate.turnaroundId === record.turnaroundId) affected.add(candidate.id);
      }
    }
  }

  const nextRecords = records.map((record) => (
    affected.has(record.id) ? clearTurnaroundLink(record) : { ...record }
  ));

  return mutationResult(nextRecords, affected, [`Unlinked ${affected.size} flight record(s)`]);
}

function requireFlightRecord(byId: Map<string, FlightRecord>, id: string): FlightRecord {
  const record = byId.get(id);
  if (!record) throw new Error(`Flight record ${id} not found`);
  if (record.status === 'deleted') throw new Error(`Flight record ${id} is deleted`);
  return record;
}

function pairDateForDeparture(arrDate: string, linkType: 'overnight' | 'sameday'): string {
  return linkType === 'overnight' ? shiftIsoDate(arrDate, 1) : arrDate;
}

export function linkFlightRecordPairs(
  records: FlightRecord[],
  arrIds: string[],
  depIds: string[],
  linkType: 'overnight' | 'sameday'
): FlightRecordMutationResult {
  if (arrIds.length === 0 || depIds.length === 0) {
    throw new Error('Linking requires at least one ARR record and one DEP record');
  }

  const byId = new Map(records.map((record) => [record.id, { ...record }]));
  const arrivals = arrIds.map((id) => requireFlightRecord(byId, id));
  const departures = depIds.map((id) => requireFlightRecord(byId, id));

  if (arrivals.some((record) => record.type !== 'A')) throw new Error('ARR selection contains non-arrival records');
  if (departures.some((record) => record.type !== 'D')) throw new Error('DEP selection contains non-departure records');

  const depByDate = new Map<string, FlightRecord[]>();
  for (const dep of departures) {
    const bucket = depByDate.get(dep.date) ?? [];
    bucket.push(dep);
    depByDate.set(dep.date, bucket);
  }

  const pairs: Array<{ arr: FlightRecord; dep: FlightRecord }> = [];
  for (const arr of arrivals) {
    const depDate = pairDateForDeparture(arr.date, linkType);
    const candidates = depByDate.get(depDate) ?? [];
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one DEP candidate on ${depDate} for ${arr.flightNumber}`);
    }
    pairs.push({ arr, dep: candidates[0] });
  }

  if (pairs.length !== departures.length) {
    throw new Error('ARR and DEP selections do not form one-to-one turnaround pairs');
  }

  const affected = new Set<string>();
  for (const { arr, dep } of pairs) {
    for (const record of [arr, dep]) {
      affected.add(record.id);
      if (record.linkedRecordId) affected.add(record.linkedRecordId);
      if (record.turnaroundId) {
        for (const candidate of records) {
          if (candidate.turnaroundId === record.turnaroundId) affected.add(candidate.id);
        }
      }
    }
  }

  for (const id of affected) {
    const current = byId.get(id);
    if (current) byId.set(id, clearTurnaroundLink(current));
  }

  for (const { arr, dep } of pairs) {
    const arrRecord = byId.get(arr.id)!;
    const depRecord = byId.get(dep.id)!;
    const linkId = [
      'TRN_MANUAL',
      safeIdPart(arrRecord.airline),
      safeIdPart(arrRecord.rawFlightNumber),
      safeIdPart(depRecord.rawFlightNumber),
      safeIdPart(arrRecord.date),
      safeIdPart(arrRecord.id),
      safeIdPart(depRecord.id),
    ].join('_');

    byId.set(arr.id, {
      ...arrRecord,
      linkId,
      turnaroundId: linkId,
      linkType,
      pairAnchorDate: arrRecord.date,
      linkedRecordId: depRecord.id,
      linkedSourceRowIndex: depRecord.sourceRowIndex,
    });
    byId.set(dep.id, {
      ...depRecord,
      linkId,
      turnaroundId: linkId,
      linkType,
      pairAnchorDate: arrRecord.date,
      linkedRecordId: arrRecord.id,
      linkedSourceRowIndex: arrRecord.sourceRowIndex,
    });
  }

  const nextRecords = records.map((record) => byId.get(record.id) ?? record);
  return mutationResult(nextRecords, affected, [`Linked ${pairs.length} ${linkType} turnaround pair(s)`]);
}
