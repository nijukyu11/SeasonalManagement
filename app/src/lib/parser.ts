import * as XLSX from 'xlsx';
import type { ParsedRow, CleanedFlight, FlightLeg, ParseResult, DisplayRow } from './types';
import { normalizeSeasonSheetName } from './importSeasonRules';

// ─── Excel Column Mapping ──────────────────────────────────────
// Columns from DAD_SeasonalS26.xlsx:
// Effective, Discontinue, Airline, Aircraft,
// Mon, Tue, Wed, Thu, Fri, Sat, Sun,
// STA, ARRFlight, ARRFlightType, ARRRoute, ARRCodeShares, ARRIntDomInd,
// STD, DEPFlight, DEPFlightType, DEPRoute,
// ARRFlightCategory, DEPFlightCategory, DEPCodeShares, DEPIntDomInd

// ─── Date Parsing ──────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse date strings like "29-Mar-26", "29-Mar", or Excel serial numbers.
 * Assumes 2-digit years map to 2000s. Missing year defaults to seasonYear.
 */
function parseDate(raw: string | number | undefined, seasonYear: number): Date | null {
  if (raw == null || raw === '') return null;

  // Handle Excel serial number
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    return new Date(d.y, d.m - 1, d.d);
  }

  const str = String(raw).trim();

  // "29-Mar-26" or "29-Mar"
  const parts = str.split('-');
  if (parts.length < 2) return null;

  const day = parseInt(parts[0], 10);
  const month = MONTHS[parts[1]];
  if (month === undefined || isNaN(day)) return null;

  let year: number;
  if (parts.length >= 3) {
    const rawYear = parseInt(parts[2], 10);
    year = rawYear < 100 ? 2000 + rawYear : rawYear;
  } else {
    year = seasonYear;
  }

  return new Date(year, month, day);
}

/**
 * Parse time string like "14:30" or Excel fraction (0.604...) to "HH:MM".
 */
function parseTime(raw: string | number | undefined): string | null {
  if (raw == null || raw === '') return null;

  if (typeof raw === 'number') {
    // Excel time fraction: 0.5 = 12:00
    const totalMinutes = Math.round(raw * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const str = String(raw).trim();
  // Already "H:MM" or "HH:MM"
  const match = str.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  return str;
}

// ─── Flight Number Cleaning ────────────────────────────────────

/**
 * Clean a raw flight number by preserving every source character as part of
 * the flight number, padding only purely numeric values to 3 digits.
 *
 * Examples:
 *   ("TW", "8")    -> { flightNumber: "TW008", rawFlightNumber: "8", requestStatusCode: null }
 *   ("ZE", "593A") -> { flightNumber: "ZE593A", rawFlightNumber: "593A", requestStatusCode: null }
 *   ("NX", "978")  -> { flightNumber: "NX978", rawFlightNumber: "978", requestStatusCode: null }
 */
export function cleanFlightNumber(airline: string, raw: string | number | undefined): CleanedFlight | null {
  if (raw == null || raw === '') return null;

  const normalizedAirline = airline.trim().toUpperCase();
  const rawStr = String(raw).trim().toUpperCase();
  if (!rawStr) return null;

  const normalizedFlight = /^\d+$/.test(rawStr) ? rawStr.padStart(3, '0') : rawStr;

  return {
    flightNumber: `${normalizedAirline}${normalizedFlight}`,
    rawFlightNumber: rawStr,
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

  // Read as JSON with header row
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });

  const rows: ParsedRow[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];

    // Skip empty rows
    const airline = normalizeRequiredUpperText(r['Airline']);
    if (!airline) continue;

    const row: ParsedRow = {
      rowIndex: i + 1, // 1-indexed (header is row 0)
      effective: r['Effective'] as string,
      discontinue: r['Discontinue'] as string,
      airline,
      aircraft: normalizeRequiredUpperText(r['Aircraft']),
      daysOfWeek: [
        numToBool(r['Mon']),
        numToBool(r['Tue']),
        numToBool(r['Wed']),
        numToBool(r['Thu']),
        numToBool(r['Fri']),
        numToBool(r['Sat']),
        numToBool(r['Sun']),
      ],
      sta: parseTime(r['STA'] as string | number | undefined),
      arrFlight: upperOrNull(r['ARRFlight']),
      arrFlightType: upperOrNull(r['ARRFlightType']),
      arrRoute: upperOrNull(r['ARRRoute']),
      arrFlightCategory: upperOrNull(r['ARRFlightCategory']),
      arrCodeShares: upperOrNull(r['ARRCodeShares']),
      arrIntDomInd: upperOrNull(r['ARRIntDomInd']),
      std: parseTime(r['STD'] as string | number | undefined),
      depFlight: upperOrNull(r['DEPFlight']),
      depFlightType: upperOrNull(r['DEPFlightType']),
      depRoute: upperOrNull(r['DEPRoute']),
      depFlightCategory: upperOrNull(r['DEPFlightCategory']),
      depCodeShares: upperOrNull(r['DEPCodeShares']),
      depIntDomInd: upperOrNull(r['DEPIntDomInd']),
    };

    rows.push(row);
  }

  return { seasonCode, rows };
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

        if (hasArrival) {
          const cleaned = cleanFlightNumber(row.airline, row.arrFlight!);
          legs.push({
            id: `${row.airline}_${arrRaw}_${dateStr}_A`,
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
          });
        }

        if (hasDeparture) {
          const cleaned = cleanFlightNumber(row.airline, row.depFlight!);
          legs.push({
            id: `${row.airline}_${depRaw}_${dateStr}_D`,
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

function numToBool(val: unknown): boolean {
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') return val.trim() === '1';
  return false;
}

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

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function guessSeasonYear(effective: string | number | undefined): number {
  if (effective == null || effective === '') return new Date().getFullYear();

  if (typeof effective === 'number') {
    const d = XLSX.SSF.parse_date_code(effective);
    return d.y;
  }

  const parts = String(effective).split('-');
  if (parts.length >= 3) {
    const yr = parseInt(parts[2], 10);
    return yr < 100 ? 2000 + yr : yr;
  }

  return new Date().getFullYear();
}
