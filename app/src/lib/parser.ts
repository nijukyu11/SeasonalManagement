import * as XLSX from 'xlsx';
import type {
  ParsedRow,
  CleanedFlight,
  FlightLeg,
  ParseResult,
  DisplayRow,
  SeasonalSourceRowCandidate,
  SeasonalSourceRowIssue,
} from './types';
import { normalizeSeasonSheetName } from './importSeasonRules.ts';
import {
  normalizeSeasonalDate,
  normalizeSeasonalDay,
  normalizeSeasonalTime,
  REQUIRED_SEASONAL_HEADERS,
  validateSeasonalSourceRow,
} from './seasonalSourceRowValidation.ts';

// ─── Excel Column Mapping ──────────────────────────────────────
// Columns from DAD_SeasonalS26.xlsx:
// Effective, Discontinue, Airline, Aircraft,
// Mon, Tue, Wed, Thu, Fri, Sat, Sun,
// STA, ARRFlight, ARRFlightType, ARRRoute, ARRCodeShares, ARRIntDomInd,
// STD, DEPFlight, DEPFlightType, DEPRoute,
// ARRFlightCategory, DEPFlightCategory, DEPCodeShares, DEPIntDomInd

// ─── Date Parsing ──────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Read canonical dates while retaining support for legacy values without a year.
 */
function parseDate(raw: string | number | undefined, seasonYear: number): Date | null {
  if (raw == null || raw === '') return null;

  const normalized = normalizeSeasonalDate(raw);
  if (normalized) {
    const [year, month, day] = normalized.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  if (typeof raw !== 'string') return null;

  const match = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2].toUpperCase()];
  if (month == null) return null;

  const date = new Date(seasonYear, month, day);
  if (
    date.getFullYear() !== seasonYear
    || date.getMonth() !== month
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

// ─── Flight Number Cleaning ────────────────────────────────────

/**
 * Clean a raw flight number by removing an already-present airline prefix,
 * then padding purely numeric flight parts to 3 digits.
 *
 * Examples:
 *   ("TW", "8")    -> { flightNumber: "TW008", rawFlightNumber: "008", requestStatusCode: null }
 *   ("TG", "TG559")-> { flightNumber: "TG559", rawFlightNumber: "559", requestStatusCode: null }
 *   ("ZE", "593A") -> { flightNumber: "ZE593A", rawFlightNumber: "593A", requestStatusCode: null }
 *   ("NX", "978")  -> { flightNumber: "NX978", rawFlightNumber: "978", requestStatusCode: null }
 */
export function cleanFlightNumber(airline: string, raw: string | number | undefined): CleanedFlight | null {
  if (raw == null || raw === '') return null;

  const normalizedAirline = airline.trim().toUpperCase();
  const rawStr = String(raw).trim().toUpperCase();
  if (!rawStr) return null;

  const rawWithoutAirline =
    normalizedAirline &&
    rawStr.length > normalizedAirline.length &&
    rawStr.startsWith(normalizedAirline)
      ? rawStr.slice(normalizedAirline.length)
      : rawStr;
  if (!rawWithoutAirline) return null;

  const normalizedFlight = /^\d+$/.test(rawWithoutAirline)
    ? rawWithoutAirline.padStart(3, '0')
    : rawWithoutAirline;

  return {
    flightNumber: `${normalizedAirline}${normalizedFlight}`,
    rawFlightNumber: normalizedFlight,
    requestStatusCode: null,
  };
}

// ─── Excel Parsing ─────────────────────────────────────────────

/**
 * Parse an uploaded Excel file into structured rows.
 */
export function parseSeasonalSchedule(workbook: XLSX.WorkBook): ParseResult {
  const sheetName = workbook.SheetNames[0];
  const seasonCode = normalizeSeasonSheetName(sheetName);
  const sheet = workbook.Sheets[sheetName];
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;

  const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false,
  });
  const sourceHeaders = new Set(
    (headerRows[0] ?? []).map((header) => String(header ?? '').trim()),
  );
  const missingHeaderIssues: SeasonalSourceRowIssue[] = REQUIRED_SEASONAL_HEADERS
    .filter((header) => !sourceHeaders.has(header))
    .map((header) => ({
      code: 'missing-header',
      rowIndex: null,
      column: header,
      message: `Missing required seasonal header: ${header}.`,
    }));
  if (missingHeaderIssues.length > 0) {
    return { seasonCode, rows: [], issues: missingHeaderIssues };
  }

  // Read as JSON with header row
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });

  const rows: ParsedRow[] = [];
  const issues: SeasonalSourceRowIssue[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!sourceRowHasContent(r)) continue;

    // Preserve raw date, time, and day values until validation can diagnose them.
    const candidate: SeasonalSourceRowCandidate = {
      rowIndex: i + 1, // 1-indexed (header is row 0)
      effective: r['Effective'],
      discontinue: r['Discontinue'],
      airline: r['Airline'],
      aircraft: r['Aircraft'],
      daysOfWeek: [
        r['Mon'],
        r['Tue'],
        r['Wed'],
        r['Thu'],
        r['Fri'],
        r['Sat'],
        r['Sun'],
      ],
      sta: r['STA'],
      arrFlight: r['ARRFlight'],
      arrFlightType: r['ARRFlightType'],
      arrRoute: r['ARRRoute'],
      arrFlightCategory: r['ARRFlightCategory'],
      arrCodeShares: r['ARRCodeShares'],
      arrIntDomInd: r['ARRIntDomInd'],
      std: r['STD'],
      depFlight: r['DEPFlight'],
      depFlightType: r['DEPFlightType'],
      depRoute: r['DEPRoute'],
      depFlightCategory: r['DEPFlightCategory'],
      depCodeShares: r['DEPCodeShares'],
      depIntDomInd: r['DEPIntDomInd'],
    };

    const rowIssues = validateSeasonalSourceRow(candidate, date1904);
    issues.push(...rowIssues);
    if (rowIssues.length > 0) continue;

    const effective = normalizeSeasonalDate(candidate.effective, date1904);
    const discontinue = normalizeSeasonalDate(candidate.discontinue, date1904);
    if (!effective || !discontinue) continue;

    const row: ParsedRow = {
      rowIndex: candidate.rowIndex,
      effective,
      discontinue,
      airline: normalizeRequiredUpperText(candidate.airline),
      aircraft: normalizeRequiredUpperText(candidate.aircraft),
      daysOfWeek: candidate.daysOfWeek.map((day) => normalizeSeasonalDay(day).value),
      sta: normalizeSeasonalTime(candidate.sta),
      arrFlight: upperOrNull(candidate.arrFlight),
      arrFlightType: upperOrNull(candidate.arrFlightType),
      arrRoute: upperOrNull(candidate.arrRoute),
      arrFlightCategory: upperOrNull(candidate.arrFlightCategory),
      arrCodeShares: upperOrNull(candidate.arrCodeShares),
      arrIntDomInd: upperOrNull(candidate.arrIntDomInd),
      std: normalizeSeasonalTime(candidate.std),
      depFlight: upperOrNull(candidate.depFlight),
      depFlightType: upperOrNull(candidate.depFlightType),
      depRoute: upperOrNull(candidate.depRoute),
      depFlightCategory: upperOrNull(candidate.depFlightCategory),
      depCodeShares: upperOrNull(candidate.depCodeShares),
      depIntDomInd: upperOrNull(candidate.depIntDomInd),
    };
    rows.push(row);
  }

  return { seasonCode, rows, issues };
}

/**
 * Enrich source rows with cleaned flight numbers for table display.
 */
export function enrichRows(rows: ParsedRow[]): DisplayRow[] {
  return rows.map((row) => {
    const arrCleaned = row.arrFlight ? cleanFlightNumber(row.airline, row.arrFlight) : null;
    const depCleaned = row.depFlight ? cleanFlightNumber(row.airline, row.depFlight) : null;
    return {
      ...row,
      arrCleanFlight: arrCleaned?.flightNumber ?? null,
      depCleanFlight: depCleaned?.flightNumber ?? null,
      arrRequestStatusCode: arrCleaned?.requestStatusCode ?? null,
      depRequestStatusCode: depCleaned?.requestStatusCode ?? null,
    };
  });
}

// ─── Data Expansion Engine ─────────────────────────────────────

/**
 * Expand parsed rows into individual FlightLeg documents.
 * Each row produces 0..N legs depending on date range and frequency.
 *
 * Rule 1.1: Only generate legs for dates matching days-of-operation within Effective..Discontinue
 * Rule 1.2: Keep absolute time (no +1 day adjustment)
 * Rule 1.3: Clean flight numbers with 3-digit padding
 * Rule 2.1: Each leg gets a unique ID
 * Rule 2.2: Arrival+Departure on same row share a linkId
 * Rule 2.3: Single-leg flights still get an ID (UI handles dashed border)
 */
export function expandToFlightLegs(rows: ParsedRow[]): FlightLeg[] {
  const legs: FlightLeg[] = [];
  type ExpandedPairMetadata = Partial<Pick<
    FlightLeg,
    'turnaroundId' | 'linkType' | 'pairAnchorDate' | 'linkedRecordId'
  >>;

  // Determine season year from the first row's effective date
  const firstRow = rows[0];
  const seasonYear = guessSeasonYear(firstRow?.effective);

  // Build linked-pair maps: depRowIndex → {arrRow, linkType}, arrRowIndex → {depRow, linkType}
  const linkedDepToArr = new Map<number, { row: ParsedRow; linkType: 'overnight' | 'sameday' }>();
  const linkedArrToDep = new Map<number, { row: ParsedRow; linkType: 'overnight' | 'sameday' }>();
  for (const row of rows) {
    if (row.overnightLinkRowIndex != null) {
      const linked = rows.find(r => r.rowIndex === row.overnightLinkRowIndex);
      const lt = row.linkType ?? 'overnight'; // backward compat
      if (linked && row.depFlight && !row.arrFlight && linked.arrFlight) {
        linkedDepToArr.set(row.rowIndex, { row: linked, linkType: lt });
        linkedArrToDep.set(linked.rowIndex, { row, linkType: lt });
      }
    }
  }

  for (const row of rows) {
    const startDate = parseDate(row.effective, seasonYear);
    const endDate = parseDate(row.discontinue, seasonYear);

    if (!startDate || !endDate) continue;

    // Iterate each day in the range
    const current = new Date(startDate);
    while (current <= endDate) {
      // Map JS day (0=Sun) to our daysOfWeek array index [Mon=0..Sun=6]
      const jsDay = current.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const dowIndex = jsDay === 0 ? 6 : jsDay - 1; // Mon=0, Tue=1, ..., Sun=6

      if (row.daysOfWeek[dowIndex]) {
        const dateStr = formatDate(current);
        const dayOfWeek = jsDay;

        const hasArrival = row.arrFlight != null && row.sta != null;
        const hasDeparture = row.depFlight != null && row.std != null;
        // Content-based stable IDs (independent of row order / filtering)
        const arrRaw = String(row.arrFlight ?? '');
        const depRaw = String(row.depFlight ?? '');
        const arrId = `${row.airline}_${arrRaw}_${dateStr}_A`;
        const depId = `${row.airline}_${depRaw}_${dateStr}_D`;

        // Compute linkId based on link type:
        // - overnight ARR: includes paired DEP flight, uses own date
        // - overnight DEP: includes paired ARR flight, uses date-1 (ARR's date)
        // - sameday ARR: includes paired DEP flight, uses own date
        // - sameday DEP: includes paired ARR flight, uses own date (no shift)
        // - unlinked: standard linkId
        const linkedDep = linkedArrToDep.get(row.rowIndex); // this is an ARR row linked to a DEP row
        const linkedArr = linkedDepToArr.get(row.rowIndex); // this is a DEP row linked to an ARR row
        const arrLinkMeta = linkedDep
          ? { linkedSourceRowIndex: linkedDep.row.rowIndex, linkType: linkedDep.linkType }
          : {};
        const depLinkMeta = linkedArr
          ? { linkedSourceRowIndex: linkedArr.row.rowIndex, linkType: linkedArr.linkType }
          : {};
        let linkId: string;
        if (linkedDep && hasArrival && !hasDeparture) {
          // ARR-only row linked to a DEP row: include paired DEP flight in linkId
          linkId = `${row.airline}_${arrRaw}_${String(linkedDep.row.depFlight ?? '')}_${dateStr}`;
        } else if (linkedArr && hasDeparture && !hasArrival) {
          // DEP-only row linked to an ARR row
          if (linkedArr.linkType === 'overnight') {
            // Overnight: use date-1 (ARR leg's date) for shared linkId
            const arrDate = new Date(current);
            arrDate.setDate(arrDate.getDate() - 1);
            linkId = `${row.airline}_${String(linkedArr.row.arrFlight ?? '')}_${depRaw}_${formatDate(arrDate)}`;
          } else {
            // Same-day: use own date (both legs on same day)
            linkId = `${row.airline}_${String(linkedArr.row.arrFlight ?? '')}_${depRaw}_${dateStr}`;
          }
        } else {
          linkId = `${row.airline}_${arrRaw}_${depRaw}_${dateStr}`;
        }

        let arrPairMeta: ExpandedPairMetadata = {};
        let depPairMeta: ExpandedPairMetadata = {};
        if (hasArrival && hasDeparture) {
          arrPairMeta = {
            turnaroundId: linkId,
            linkType: 'sameday',
            pairAnchorDate: dateStr,
            linkedRecordId: depId,
          };
          depPairMeta = {
            turnaroundId: linkId,
            linkType: 'sameday',
            pairAnchorDate: dateStr,
            linkedRecordId: arrId,
          };
        } else if (linkedDep && hasArrival) {
          const linkedDepDate = new Date(current);
          if (linkedDep.linkType === 'overnight') linkedDepDate.setDate(linkedDepDate.getDate() + 1);
          arrPairMeta = {
            turnaroundId: linkId,
            linkType: linkedDep.linkType,
            pairAnchorDate: dateStr,
            linkedRecordId: `${row.airline}_${String(linkedDep.row.depFlight ?? '')}_${formatDate(linkedDepDate)}_D`,
          };
        } else if (linkedArr && hasDeparture) {
          const pairAnchorDate = new Date(current);
          if (linkedArr.linkType === 'overnight') pairAnchorDate.setDate(pairAnchorDate.getDate() - 1);
          const anchorDateStr = formatDate(pairAnchorDate);
          depPairMeta = {
            turnaroundId: linkId,
            linkType: linkedArr.linkType,
            pairAnchorDate: anchorDateStr,
            linkedRecordId: `${row.airline}_${String(linkedArr.row.arrFlight ?? '')}_${anchorDateStr}_A`,
          };
        }

        if (hasArrival) {
          const cleaned = cleanFlightNumber(row.airline, row.arrFlight!);
          legs.push({
            id: arrId,
            linkId,
            type: 'A',
            airline: row.airline,
            flightNumber: cleaned?.flightNumber ?? `${row.airline}${row.arrFlight}`,
            rawFlightNumber: cleaned?.rawFlightNumber ?? String(row.arrFlight),
            requestStatusCode: cleaned?.requestStatusCode ?? null,
            route: row.arrRoute ?? '',
            schedule: row.sta!,
            aircraft: row.aircraft,
            category: row.arrFlightCategory ?? '',
            flightType: 'PAX',
            codeShares: row.arrCodeShares ?? null,
            intDomInd: row.arrIntDomInd ?? null,
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
            date: dateStr,
            dayOfWeek,
            action: null,
            sourceRowIndex: row.rowIndex,
            ...arrLinkMeta,
            ...arrPairMeta,
          });
        }

        if (hasDeparture) {
          const cleaned = cleanFlightNumber(row.airline, row.depFlight!);
          legs.push({
            id: depId,
            linkId,
            type: 'D',
            airline: row.airline,
            flightNumber: cleaned?.flightNumber ?? `${row.airline}${row.depFlight}`,
            rawFlightNumber: cleaned?.rawFlightNumber ?? String(row.depFlight),
            requestStatusCode: cleaned?.requestStatusCode ?? null,
            route: row.depRoute ?? '',
            schedule: row.std!,
            aircraft: row.aircraft,
            category: row.depFlightCategory ?? '',
            flightType: 'PAX',
            codeShares: row.depCodeShares ?? null,
            intDomInd: row.depIntDomInd ?? null,
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
            date: dateStr,
            dayOfWeek,
            action: null,
            sourceRowIndex: row.rowIndex,
            ...depLinkMeta,
            ...depPairMeta,
          });


        }

        if (!hasArrival && !hasDeparture) {
          // Row with no flight data — skip
          continue;
        }
      }

      current.setDate(current.getDate() + 1);
    }
  }

  return legs;
}

// ─── Overnight Pair Detection ──────────────────────────────────

export interface OvernightPair {
  arrRowIndex: number;
  depRowIndex: number;
  arrFlight: string;
  depFlight: string;
  airline: string;
}

/** Parse "HH:MM" to minutes since midnight */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Check if DOW pattern B is exactly DOW pattern A shifted +1 (Mon→Tue, ..., Sun→Mon) */
function isDowShiftedPlusOne(a: boolean[], b: boolean[]): boolean {
  // a[Mon=0] should match b[Tue=1], a[Tue=1] → b[Wed=2], ..., a[Sun=6] → b[Mon=0]
  for (let i = 0; i < 7; i++) {
    if (a[i] !== b[(i + 1) % 7]) return false;
  }
  return true;
}

/**
 * Detect overnight turnaround pairs from parsed source rows.
 *
 * Matching rules (ALL must match):
 * 1. Same airline + aircraft + route
 * 2. DEP time < ARR time (crossed midnight)
 * 3. DEP effective = ARR effective + 1 day
 * 4. DOW pattern: DEP DOW = ARR DOW shifted +1
 *
 * Returns 1:1 matches only. Each row can be in at most one pair.
 */
export function detectOvernightPairs(rows: ParsedRow[]): OvernightPair[] {
  const arrOnly = rows.filter(r => r.arrFlight && r.sta && !r.depFlight);
  const depOnly = rows.filter(r => r.depFlight && r.std && !r.arrFlight);

  const pairs: OvernightPair[] = [];
  const usedArr = new Set<number>();
  const usedDep = new Set<number>();

  const seasonYear = guessSeasonYear(rows[0]?.effective);

  for (const arr of arrOnly) {
    if (usedArr.has(arr.rowIndex)) continue;

    for (const dep of depOnly) {
      if (usedDep.has(dep.rowIndex)) continue;

      // Rule 1: Same airline, aircraft, route
      if (arr.airline !== dep.airline) continue;
      if (arr.aircraft !== dep.aircraft) continue;
      if (arr.arrRoute !== dep.depRoute) continue;

      // Rule 2: DEP time < ARR time (overnight)
      const arrMin = timeToMinutes(arr.sta!);
      const depMin = timeToMinutes(dep.std!);
      if (depMin >= arrMin) continue;

      // Rule 3: DEP effective = ARR effective + 1 day
      const arrStart = parseDate(arr.effective, seasonYear);
      const depStart = parseDate(dep.effective, seasonYear);
      if (!arrStart || !depStart) continue;

      const arrStartPlus1 = new Date(arrStart);
      arrStartPlus1.setDate(arrStartPlus1.getDate() + 1);
      if (arrStartPlus1.getTime() !== depStart.getTime()) continue;

      // Rule 4: DOW shifted +1
      if (!isDowShiftedPlusOne(arr.daysOfWeek, dep.daysOfWeek)) continue;

      // Match found!
      pairs.push({
        arrRowIndex: arr.rowIndex,
        depRowIndex: dep.rowIndex,
        arrFlight: String(arr.arrFlight),
        depFlight: String(dep.depFlight),
        airline: arr.airline,
      });
      usedArr.add(arr.rowIndex);
      usedDep.add(dep.rowIndex);
      break; // 1:1 match, move to next ARR
    }
  }

  return pairs;
}

// ─── Helpers ───────────────────────────────────────────────────

function emptyToNull(val: unknown): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function upperOrNull(val: unknown): string | null {
  return emptyToNull(val)?.toUpperCase() ?? null;
}

function normalizeRequiredUpperText(val: unknown): string {
  return String(val ?? '').trim().toUpperCase();
}

function sourceRowHasContent(row: Record<string, unknown>): boolean {
  return Object.values(row).some((value) => (
    value != null && (typeof value !== 'string' || value.trim() !== '')
  ));
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function guessSeasonYear(effective: string | number | undefined): number {
  const normalized = normalizeSeasonalDate(effective);
  if (normalized) return Number(normalized.slice(0, 4));

  return new Date().getFullYear();
}
