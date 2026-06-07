import * as XLSX from 'xlsx';
import type { FlightLeg, ParsedRow } from './types';

export interface SourceRowOperationScope {
  fromDate: string;
  toDate: string;
  opDays: boolean[];
}

export interface SourceRowWrite {
  type: 'delete' | 'set';
  rowIndex: number;
  row?: ParsedRow;
}

export interface SourceRowOperationPlan {
  kind: 'granular-unlink';
  preview: string[];
  writes: SourceRowWrite[];
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseSourceDate(raw: string | number): Date | null {
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

function dowIndex(iso: string): number {
  const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function shiftIsoDate(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDate(date);
}

function operatingDates(row: ParsedRow): string[] {
  const start = parseSourceDate(row.effective);
  const end = parseSourceDate(row.discontinue);
  if (!start || !end) return [];

  const result: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    const iso = isoDate(current);
    if (row.daysOfWeek[dowIndex(iso)]) result.push(iso);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return result;
}

function inScope(iso: string, scope: SourceRowOperationScope): boolean {
  return iso >= scope.fromDate && iso <= scope.toDate && scope.opDays[dowIndex(iso)];
}

function rowForDateSet(row: ParsedRow, rowIndex: number, dates: string[]): ParsedRow[] {
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
        rowIndex,
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
    const next: ParsedRow = {
      ...row,
      rowIndex: rowIndex + rows.length,
      effective: formatSourceDate(coveredDates[0]),
      discontinue: formatSourceDate(coveredDates[coveredDates.length - 1]),
      daysOfWeek: bestDays,
    };
    delete next.overnightLinkRowIndex;
    delete next.linkType;
    rows.push(next);

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (bestCovered.has(remaining[i])) remaining.splice(i, 1);
    }
  }

  return rows;
}

function arrivalOnly(row: ParsedRow): ParsedRow {
  return {
    ...row,
    std: null,
    depFlight: null,
    depFlightType: null,
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
  };
}

function departureOnly(row: ParsedRow): ParsedRow {
  return {
    ...row,
    sta: null,
    arrFlight: null,
    arrFlightType: null,
    arrRoute: null,
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function planGranularUnlink(
  rows: ParsedRow[],
  targetLegs: Array<Pick<FlightLeg, 'sourceRowIndex' | 'date'>>,
  scope: SourceRowOperationScope,
  nextRowIndex = Math.max(0, ...rows.map((row) => row.rowIndex)) + 1
): SourceRowOperationPlan {
  const rowsByIndex = new Map(rows.map((row) => [row.rowIndex, row]));
  const touched = new Map<number, string[]>();

  for (const leg of targetLegs) {
    if (!inScope(leg.date, scope)) continue;
    const row = rowsByIndex.get(leg.sourceRowIndex);
    if (!row) continue;
    if (!operatingDates(row).includes(leg.date)) continue;
    const dates = touched.get(row.rowIndex) ?? [];
    dates.push(leg.date);
    touched.set(row.rowIndex, dates);
  }

  const writes: SourceRowWrite[] = [];
  const preview: string[] = [];
  const processed = new Set<number>();
  let nextIndex = nextRowIndex;

  const addSet = (row: ParsedRow) => {
    writes.push({ type: 'set', rowIndex: row.rowIndex, row });
  };

  for (const [rowIndex, rawSelectedDates] of touched) {
    if (processed.has(rowIndex)) continue;
    const row = rowsByIndex.get(rowIndex);
    if (!row) continue;

    const partner = row.overnightLinkRowIndex != null ? rowsByIndex.get(row.overnightLinkRowIndex) : null;
    if (partner && touched.has(partner.rowIndex)) processed.add(partner.rowIndex);
    processed.add(rowIndex);

    const selectedDates = sortedUnique(rawSelectedDates);
    const rowDates = operatingDates(row);
    const remainingDates = rowDates.filter((date) => !selectedDates.includes(date));

    writes.push({ type: 'delete', rowIndex: row.rowIndex });

    if (row.arrFlight && row.depFlight) {
      const remainingRows = rowForDateSet(row, nextIndex, remainingDates);
      nextIndex += remainingRows.length;
      for (const remainingRow of remainingRows) {
        addSet(remainingRow);
      }
      const selectedRows = rowForDateSet(row, nextIndex, selectedDates);
      nextIndex += selectedRows.length;
      for (const selectedRow of selectedRows) {
        addSet(arrivalOnly(selectedRow));
        addSet(departureOnly({ ...selectedRow, rowIndex: nextIndex++ }));
      }
      preview.push(`Split ${row.airline}${row.arrFlight}/${row.airline}${row.depFlight}: ${selectedDates.length} date(s) unlinked`);
      continue;
    }

    if (partner) {
      const linkType = row.linkType ?? partner.linkType ?? 'overnight';
      const rowIsArr = !!row.arrFlight && !row.depFlight;
      const dateOffset =
        linkType === 'overnight'
          ? rowIsArr ? 1 : -1
          : 0;
      const partnerDates = operatingDates(partner);
      const partnerDateSet = new Set(partnerDates);
      const partnerSelectedDates = sortedUnique(
        selectedDates
          .map((date) => shiftIsoDate(date, dateOffset))
          .filter((date) => partnerDateSet.has(date))
      );
      const partnerSelectedSet = new Set(partnerSelectedDates);
      const partnerRemainingDates = partnerDates.filter((date) => !partnerSelectedSet.has(date));

      writes.push({ type: 'delete', rowIndex: partner.rowIndex });

      const remainingRows = rowForDateSet(row, nextIndex, remainingDates);
      nextIndex += remainingRows.length;
      const partnerRemainingRows = rowForDateSet(partner, nextIndex, partnerRemainingDates);
      nextIndex += partnerRemainingRows.length;

      if (remainingRows.length === partnerRemainingRows.length) {
        for (let i = 0; i < remainingRows.length; i++) {
          const rowPiece = remainingRows[i];
          const partnerPiece = partnerRemainingRows[i];
          rowPiece.overnightLinkRowIndex = partnerPiece.rowIndex;
          partnerPiece.overnightLinkRowIndex = rowPiece.rowIndex;
          rowPiece.linkType = linkType;
          partnerPiece.linkType = linkType;
          addSet(rowPiece);
          addSet(partnerPiece);
        }
      } else {
        for (const rowPiece of remainingRows) addSet(rowPiece);
        for (const partnerPiece of partnerRemainingRows) addSet(partnerPiece);
      }

      const selectedRows = rowForDateSet(row, nextIndex, selectedDates);
      nextIndex += selectedRows.length;
      for (const selectedRow of selectedRows) addSet(selectedRow);

      const partnerSelectedRows = rowForDateSet(partner, nextIndex, partnerSelectedDates);
      nextIndex += partnerSelectedRows.length;
      for (const partnerSelectedRow of partnerSelectedRows) addSet(partnerSelectedRow);

      preview.push(`Unlinked ${selectedDates.length} date(s) for linked source rows ${row.rowIndex}/${partner.rowIndex}`);
    }
  }

  return { kind: 'granular-unlink', preview, writes };
}
