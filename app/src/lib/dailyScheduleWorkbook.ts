import * as XLSX from 'xlsx';

export type DailyImportRawRow = Record<string, unknown>;

export type DailyWorkbookProfile = 'legacy-operationalturns' | 'compact-lb' | 'position-compatible-unknown';

export interface DailyWorkbookDiagnostic {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  sheetName: string | null;
  rowNumber: number | null;
  cellAddress: string | null;
}

export interface DailyWorkbookSheetCandidate {
  sheetName: string;
  headerRowIndex: number;
  firstLogicalColumnIndex: number;
  profile: DailyWorkbookProfile;
  score: number;
  rows: DailyImportRawRow[];
}

export interface DailyWorkbookAnalysis {
  selected: DailyWorkbookSheetCandidate | null;
  candidates: DailyWorkbookSheetCandidate[];
  diagnostics: DailyWorkbookDiagnostic[];
  date1904: boolean;
}

const HEADER_SCAN_ROWS = 10;
const LOGICAL_COLUMN_COUNT = 43;
const SHEET_JS = ((XLSX as typeof XLSX & { default?: typeof XLSX }).default ?? XLSX);
const CANONICAL_COLUMNS: Record<number, string> = {
  1: 'AIRCRAFT_SERIES', 3: 'ARR-AIRLINE_FLIGHT_SUFFIX', 6: 'ARR-Scheduled',
  7: 'ARR-FlightType', 8: 'ARR-ORIG_DEST_AIRPORT_CODE', 9: 'ARR-FlightCategory',
  10: 'ARR-STATUS_CODE', 12: 'ARR-MCT', 15: 'ARR-BagFirst', 16: 'ARR-BagLast',
  17: 'ARR-PAX_TOTAL', 18: 'ARRReclaimBelt', 20: 'ARRStand', 21: 'ARR-CODESHARES',
  23: 'DEP-AIRLINE_FLIGHT_SUFFIX', 26: 'DEP-Scheduled', 27: 'DEP-FlightType',
  28: 'DEP-ORIG_DEST_AIRPORT_CODE', 29: 'DEP-FlightCategory', 30: 'DEP-STATUS_CODE',
  32: 'DEP-MCT', 36: 'DEP-PAX_TOTAL', 37: 'DEPGate', 38: 'CheckInDesk',
  40: 'DEPStand', 41: 'DEP-CODESHARES',
};
const DATE_TIME_COLUMNS = new Set(['ARR-Scheduled', 'ARR-MCT', 'ARR-BagFirst', 'ARR-BagLast', 'DEP-Scheduled', 'DEP-MCT']);
const ANCHORS: Array<{ index: number; aliases: string[] }> = [
  { index: 1, aliases: ['AIRCRAFT_SERIES', 'A/C Type'] },
  { index: 3, aliases: ['ARR-AIRLINE_FLIGHT_SUFFIX', 'Arr Flight', 'Arrival Flight Number'] },
  { index: 6, aliases: ['ARR-Scheduled', 'STA', 'Arrival Scheduled'] },
  { index: 8, aliases: ['ARR-ORIG_DEST_AIRPORT_CODE', 'From'] },
  { index: 20, aliases: ['ARRStand', 'Arr Stand'] },
  { index: 23, aliases: ['DEP-AIRLINE_FLIGHT_SUFFIX', 'Dep Flight', 'Departure Flight Number'] },
  { index: 26, aliases: ['DEP-Scheduled', 'STD', 'Departure Scheduled'] },
  { index: 28, aliases: ['DEP-ORIG_DEST_AIRPORT_CODE', 'To'] },
  { index: 37, aliases: ['DEPGate', 'Gate'] },
  { index: 38, aliases: ['CheckInDesk', 'Counters'] },
  { index: 40, aliases: ['DEPStand', 'Dep Stand'] },
];

function normalizedHeader(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function matches(value: unknown, aliases: string[]): boolean {
  const normalized = normalizedHeader(value);
  return aliases.some((alias) => normalizedHeader(alias) === normalized);
}

function profileForHeader(row: unknown[], firstColumn: number): DailyWorkbookProfile {
  if (matches(row[firstColumn + 3], ['ARR-AIRLINE_FLIGHT_SUFFIX'])) return 'legacy-operationalturns';
  if (matches(row[firstColumn + 3], ['Arr Flight'])) return 'compact-lb';
  const legacy = ANCHORS.filter(anchor => matches(row[firstColumn + anchor.index], [anchor.aliases[0]])).length;
  const compact = ANCHORS.filter(anchor => matches(row[firstColumn + anchor.index], [anchor.aliases[1]])).length;
  if (legacy >= 2 && legacy > compact) return 'legacy-operationalturns';
  if (compact >= 2 && compact > legacy) return 'compact-lb';
  return 'position-compatible-unknown';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function canonicalCellValue(value: unknown, key: string, date1904: boolean): unknown {
  if (typeof value !== 'number' || !DATE_TIME_COLUMNS.has(key)) return value ?? null;
  const parsed = SHEET_JS.SSF.parse_date_code(value, { date1904 });
  if (!parsed) return value;
  return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)} ${pad2(parsed.H)}:${pad2(parsed.M)}:00`;
}

function parseCandidateRows(
  matrix: unknown[][],
  headerRowIndex: number,
  firstLogicalColumnIndex: number,
  date1904: boolean,
): DailyImportRawRow[] {
  return matrix.slice(headerRowIndex + 1)
    .filter((row) => row.some((value) => value != null && String(value).trim() !== ''))
    .map((row) => Object.fromEntries(Object.entries(CANONICAL_COLUMNS).map(([index, key]) => [
      key,
      canonicalCellValue(row[firstLogicalColumnIndex + Number(index)], key, date1904),
    ])));
}

function findSheetCandidate(
  sheetName: string,
  sheet: XLSX.WorkSheet,
  date1904: boolean,
): DailyWorkbookSheetCandidate | null {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: true,
  });
  const sheetRange = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  let best: Omit<DailyWorkbookSheetCandidate, 'sheetName' | 'profile' | 'rows'> | null = null;
  for (let headerRowIndex = 0; headerRowIndex < Math.min(HEADER_SCAN_ROWS, matrix.length); headerRowIndex += 1) {
    const row = matrix[headerRowIndex] ?? [];
    const maxStart = Math.max(0, row.length - LOGICAL_COLUMN_COUNT);
    for (let firstLogicalColumnIndex = 0; firstLogicalColumnIndex <= maxStart; firstLogicalColumnIndex += 1) {
      const score = ANCHORS.reduce(
        (total, anchor) => total + (matches(row[firstLogicalColumnIndex + anchor.index], anchor.aliases) ? 1 : 0),
        0,
      );
      if (!best || score > best.score) best = { headerRowIndex, firstLogicalColumnIndex, score };
    }
  }
  if (!best || best.score < 4) return null;

  const header = matrix[best.headerRowIndex] ?? [];
  const identityAnchorsValid = (
    matches(header[best.firstLogicalColumnIndex + 3], ANCHORS[1].aliases) &&
    matches(header[best.firstLogicalColumnIndex + 6], ANCHORS[2].aliases) &&
    matches(header[best.firstLogicalColumnIndex + 23], ANCHORS[5].aliases) &&
    matches(header[best.firstLogicalColumnIndex + 26], ANCHORS[6].aliases)
  );
  if (!identityAnchorsValid) {
    // Unknown titles may vary. Known titles in the wrong identity slots are
    // never accepted; otherwise require strong remaining anchors AND data.
    const identityAnchors = [ANCHORS[1], ANCHORS[2], ANCHORS[5], ANCHORS[6]];
    const swapped = identityAnchors.some(anchor => identityAnchors.some(other => other.index !== anchor.index
      && matches(header[best.firstLogicalColumnIndex + anchor.index], other.aliases)));
    if (swapped || best.score < 6) return null;
    const sample = matrix.slice(best.headerRowIndex + 1, best.headerRowIndex + 9);
    let validSides = 0;
    for (const row of sample) {
      for (const [flightIndex, timeIndex] of [[3, 6], [23, 26]]) {
        const flight = String(row[best.firstLogicalColumnIndex + flightIndex] ?? '').trim();
        const time = row[best.firstLogicalColumnIndex + timeIndex];
        if (!flight && (time == null || time === '')) continue;
        if (!/^(?:[A-Z0-9]{2}|[A-Z]{3})\s*\d+[A-Z]?$/i.test(flight)
          || !(typeof time === 'number' || /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}/.test(String(time)))) return null;
        validSides++;
      }
    }
    if (validSides === 0 || profileForHeader(header, best.firstLogicalColumnIndex) === 'position-compatible-unknown') return null;
  }

  const profile = profileForHeader(header, best.firstLogicalColumnIndex);
  if (profile === 'position-compatible-unknown') return null;
  return {
    sheetName,
    headerRowIndex: sheetRange.s.r + best.headerRowIndex,
    firstLogicalColumnIndex: sheetRange.s.c + best.firstLogicalColumnIndex,
    score: best.score,
    profile,
    rows: parseCandidateRows(matrix, best.headerRowIndex, best.firstLogicalColumnIndex, date1904),
  };
}

export function analyzeDailyScheduleWorkbook(workbook: XLSX.WorkBook): DailyWorkbookAnalysis {
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  const candidates = workbook.SheetNames
    .map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return sheet ? findSheetCandidate(sheetName, sheet, date1904) : null;
    })
    .filter((candidate): candidate is DailyWorkbookSheetCandidate => candidate != null);

  if (candidates.length === 0) {
    return {
      selected: null,
      candidates,
      date1904,
      diagnostics: [{
        severity: 'blocking',
        code: 'DAILY_WORKBOOK_LAYOUT_NOT_FOUND',
        message: 'Không tìm thấy bảng Daily Schedule có đúng vị trí 43 trường nghiệp vụ.',
        sheetName: null,
        rowNumber: null,
        cellAddress: null,
      }],
    };
  }
  if (candidates.length > 1) {
    return {
      selected: null,
      candidates,
      date1904,
      diagnostics: [{
        severity: 'blocking',
        code: 'DAILY_WORKBOOK_MULTIPLE_SHEETS',
        message: `Có nhiều sheet Daily Schedule hợp lệ: ${candidates.map((candidate) => candidate.sheetName).join(', ')}.`,
        sheetName: null,
        rowNumber: null,
        cellAddress: null,
      }],
    };
  }
  return { selected: candidates[0], candidates, diagnostics: [], date1904 };
}
