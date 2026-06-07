import * as XLSX from 'xlsx';
import { saveExportBlob, type ExportSaveResult } from './exportSave.ts';
import type { FlightLeg, PatternGroup } from './types';
import { isValidLinkedFlightPair } from './flightPairIntegrity.ts';

// ─── Pattern Grouping ──────────────────────────────────────────

interface LegPair {
  arrival: FlightLeg | null;
  departure: FlightLeg | null;
}

interface GroupedPattern {
  key: string;             // patternKey for arr + dep combined
  airline: string;
  aircraft: string;
  pair: LegPair;           // representative pair
  dates: string[];         // sorted ISO dates where this pattern operates
  arrSourceRowIndex: number | null;
  depSourceRowIndex: number | null;
  linkType: 'overnight' | 'sameday' | null;
}

export type SeasonalExportValidationIssueCode = 'date-metadata-mismatch' | 'invalid-linked-pair';

export interface SeasonalExportValidationIssue {
  code: SeasonalExportValidationIssueCode;
  legId: string;
  flightNumber: string;
  date: string;
  message: string;
}

export interface SeasonalExportValidationResult {
  valid: boolean;
  issues: SeasonalExportValidationIssue[];
}

function expectedUtcDayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function validateFlightLegsForSeasonalExport(legs: FlightLeg[]): SeasonalExportValidationResult {
  const activeLegs = legs.filter((leg) => leg.action !== 'deleted');
  const byId = new Map(activeLegs.map((leg) => [leg.id, leg]));
  const issues: SeasonalExportValidationIssue[] = [];

  for (const leg of activeLegs) {
    if ((leg.scheduledDate && leg.scheduledDate !== leg.date) || leg.dayOfWeek !== expectedUtcDayOfWeek(leg.date)) {
      issues.push({
        code: 'date-metadata-mismatch',
        legId: leg.id,
        flightNumber: leg.flightNumber,
        date: leg.date,
        message: `${leg.flightNumber} on ${leg.date} has stale scheduled date or weekday metadata.`,
      });
    }

    if (!leg.linkedRecordId && !leg.linkType && !leg.pairAnchorDate) continue;

    const linked = leg.linkedRecordId ? byId.get(leg.linkedRecordId) : null;
    if (!linked || !isValidLinkedFlightPair(leg, linked)) {
      issues.push({
        code: 'invalid-linked-pair',
        legId: leg.id,
        flightNumber: leg.flightNumber,
        date: leg.date,
        message: `${leg.flightNumber} on ${leg.date} has invalid linked flight metadata.`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Group flight legs into pattern groups for Excel export.
 *
 * Rule 4.1: Strict matching on flightNumber + route + aircraft + schedule
 * Rule 4.2: Exclude action='deleted'
 * Rule 4.3: Strict Pattern Splitting — break date ranges at gaps
 */
export function groupFlightLegs(legs: FlightLeg[]): PatternGroup[] {
  // Step 1: Filter out deleted (Rule 4.2)
  const activeLegs = legs.filter((l) => l.action !== 'deleted');

  // Step 2: Build link-based pairs (group by linkId + date)
  const pairMap = new Map<string, LegPair>();

  for (const leg of activeLegs) {
    const pairKey = `${leg.linkId}|${leg.date}`;
    if (!pairMap.has(pairKey)) {
      pairMap.set(pairKey, { arrival: null, departure: null });
    }
    const pair = pairMap.get(pairKey)!;
    if (leg.type === 'A') pair.arrival = leg;
    else pair.departure = leg;
  }

  // Step 3: Group pairs by combined pattern key
  const patternMap = new Map<string, GroupedPattern>();

  for (const pair of pairMap.values()) {
    const arrKey = pair.arrival
      ? `A:${pair.arrival.flightNumber}|${pair.arrival.route}|${pair.arrival.schedule}`
      : 'A:null';
    const depKey = pair.departure
      ? `D:${pair.departure.flightNumber}|${pair.departure.route}|${pair.departure.schedule}`
      : 'D:null';

    const airline = pair.arrival?.airline ?? pair.departure?.airline ?? '';
    const aircraft = pair.arrival?.aircraft ?? pair.departure?.aircraft ?? '';
    const arrSourceRowIndex = pair.arrival?.sourceRowIndex ?? pair.departure?.linkedSourceRowIndex ?? null;
    const depSourceRowIndex = pair.departure?.sourceRowIndex ?? pair.arrival?.linkedSourceRowIndex ?? null;
    const linkType = pair.arrival?.linkType ?? pair.departure?.linkType ?? null;
    const needsSourceBoundary =
      linkType === 'overnight' &&
      (!pair.arrival || !pair.departure) &&
      arrSourceRowIndex != null &&
      depSourceRowIndex != null;
    const sourceKey = needsSourceBoundary
      ? `SRC:${arrSourceRowIndex}|${depSourceRowIndex}|${linkType}`
      : `LINK:${linkType ?? 'none'}`;
    const combinedKey = `${airline}|${aircraft}|${arrKey}|${depKey}|${sourceKey}`;

    if (!patternMap.has(combinedKey)) {
      patternMap.set(combinedKey, {
        key: combinedKey,
        airline,
        aircraft,
        pair,
        dates: [],
        arrSourceRowIndex: needsSourceBoundary ? arrSourceRowIndex : null,
        depSourceRowIndex: needsSourceBoundary ? depSourceRowIndex : null,
        linkType,
      });
    }
    const date = pair.arrival?.date ?? pair.departure?.date ?? '';
    if (date) {
      patternMap.get(combinedKey)!.dates.push(date);
    }
  }

  // Step 4: For each pattern, split into contiguous date ranges (Rule 4.3)
  const result: PatternGroup[] = [];

  for (const group of patternMap.values()) {
    const sortedDates = [...new Set(group.dates)].sort();
    if (sortedDates.length === 0) continue;

    // Split into recurrence-complete date ranges.
    const runs = splitIntoContiguousRuns(sortedDates);

    for (const run of runs) {
      const daysOfWeek = computeDaysOfWeek(run);
      const pg: PatternGroup = {
        airline: group.airline,
        aircraft: group.aircraft,
        effective: run[0],
        discontinue: run[run.length - 1],
        daysOfWeek,
        arrFlightNumber: null,
        arrRoute: null,
        arrSchedule: null,
        arrCategory: null,
        arrFlightType: null,
        arrCodeShares: null,
        arrIntDomInd: null,
        arrRequestStatusCode: null,
        depFlightNumber: null,
        depRoute: null,
        depSchedule: null,
        depCategory: null,
        depFlightType: null,
        depCodeShares: null,
        depIntDomInd: null,
        depRequestStatusCode: null,
        arrSourceRowIndex: group.arrSourceRowIndex,
        depSourceRowIndex: group.depSourceRowIndex,
        linkType: group.linkType,
      };

      // Fill from representative pair
      const arr = group.pair.arrival;
      const dep = group.pair.departure;

      if (arr) {
        pg.arrFlightNumber = arr.rawFlightNumber;
        pg.arrRoute = arr.route;
        pg.arrSchedule = arr.schedule;
        pg.arrCategory = arr.category;
        pg.arrFlightType = arr.flightType;
        pg.arrCodeShares = arr.codeShares;
        pg.arrIntDomInd = arr.intDomInd;
        pg.arrRequestStatusCode = arr.requestStatusCode;
      }

      if (dep) {
        pg.depFlightNumber = dep.rawFlightNumber;
        pg.depRoute = dep.route;
        pg.depSchedule = dep.schedule;
        pg.depCategory = dep.category;
        pg.depFlightType = dep.flightType;
        pg.depCodeShares = dep.codeShares;
        pg.depIntDomInd = dep.intDomInd;
        pg.depRequestStatusCode = dep.requestStatusCode;
      }

      result.push(pg);
    }
  }

  // Step 5: Explicit overnight turnaround alignment
  // Only manually linked overnight pairs may project DEP export patterns from ARR +1.
  alignExplicitOvernightPairs(result);

  return result;
}

// ─── Overnight Turnaround Alignment ────────────────────────────

/** Shift an ISO date string by +1 day */
function shiftDatePlusOne(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

/** Shift daysOfWeek bitmask by +1 (Mon→Tue, ..., Sun→Mon) */
function shiftDaysOfWeek(days: boolean[]): boolean[] {
  // Input: [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
  // Shift right: Sun wraps to Mon
  return [days[6], days[0], days[1], days[2], days[3], days[4], days[5]];
}

/**
 * Post-process explicit overnight PatternGroups.
 * The +1 projection is an export-only pattern mapping for manually linked
 * overnight rows. Raw source rows and expanded leg dates remain absolute.
 */
function alignExplicitOvernightPairs(groups: PatternGroup[]): void {
  const pairKey = (g: PatternGroup) => `${g.arrSourceRowIndex ?? 'null'}|${g.depSourceRowIndex ?? 'null'}`;
  const arrGroups = groups.filter(g =>
    g.linkType === 'overnight' &&
    g.arrSchedule &&
    !g.depSchedule &&
    g.arrSourceRowIndex != null &&
    g.depSourceRowIndex != null
  );
  const depGroups = groups.filter(g =>
    g.linkType === 'overnight' &&
    g.depSchedule &&
    !g.arrSchedule &&
    g.arrSourceRowIndex != null &&
    g.depSourceRowIndex != null
  );

  const depByPair = new Map<string, PatternGroup[]>();
  for (const dep of depGroups) {
    const key = pairKey(dep);
    if (!depByPair.has(key)) depByPair.set(key, []);
    depByPair.get(key)!.push(dep);
  }

  const depTemplates = new Map<string, PatternGroup>();
  for (const arr of arrGroups) {
    const deps = depByPair.get(pairKey(arr));
    if (deps?.[0]) depTemplates.set(pairKey(arr), deps[0]);
  }

  if (depTemplates.size === 0) return;

  const depToRemove = new Set<PatternGroup>();
  for (const [key, deps] of depByPair) {
    if (!depTemplates.has(key)) continue;
    for (const dep of deps) depToRemove.add(dep);
  }

  // Remove from the groups array (in-place, iterate backwards)
  for (let i = groups.length - 1; i >= 0; i--) {
    if (depToRemove.has(groups[i])) {
      groups.splice(i, 1);
    }
  }

  // Rebuild DEP groups from ARR groups with +1 day shift
  for (const arr of arrGroups) {
    const key = pairKey(arr);
    const template = depTemplates.get(key)!;
    if (!template) continue;

    // Create a new DEP group derived from this ARR group
    const newDep: PatternGroup = {
      airline: arr.airline,
      aircraft: arr.aircraft,
      effective: shiftDatePlusOne(arr.effective),
      discontinue: shiftDatePlusOne(arr.discontinue),
      daysOfWeek: shiftDaysOfWeek(arr.daysOfWeek),

      // No ARR side
      arrFlightNumber: null,
      arrRoute: null,
      arrSchedule: null,
      arrCategory: null,
      arrFlightType: null,
      arrCodeShares: null,
      arrIntDomInd: null,
      arrRequestStatusCode: null,

      // Copy DEP side from template
      depFlightNumber: template.depFlightNumber,
      depRoute: template.depRoute,
      depSchedule: template.depSchedule,
      depCategory: template.depCategory,
      depFlightType: template.depFlightType,
      depCodeShares: template.depCodeShares,
      depIntDomInd: template.depIntDomInd,
      depRequestStatusCode: template.depRequestStatusCode,
      arrSourceRowIndex: arr.arrSourceRowIndex,
      depSourceRowIndex: arr.depSourceRowIndex,
      linkType: 'overnight',
    };

    groups.push(newDep);
  }
}

// ─── Strict Pattern Splitting ──────────────────────────────────

function isoDateFromUtcMs(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

function isCompletePatternRun(dates: string[]): boolean {
  const presentDates = new Set(dates);
  const activeDays = new Set(dates.map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()));
  const startMs = new Date(`${dates[0]}T00:00:00Z`).getTime();
  const endMs = new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime();

  for (let ms = startMs; ms <= endMs; ms += 86400000) {
    const current = new Date(ms);
    if (activeDays.has(current.getUTCDay()) && !presentDates.has(isoDateFromUtcMs(ms))) {
      return false;
    }
  }

  return true;
}

/**
 * Split sorted dates into exportable recurrence runs.
 *
 * A run can be represented by one Excel row only when every date between its
 * effective/discontinue bounds that matches the union day pattern is present.
 */
function splitIntoContiguousRuns(sortedDates: string[]): string[][] {
  if (sortedDates.length === 0) return [];
  if (sortedDates.length === 1) return [sortedDates];

  const uniqueDates = [...new Set(sortedDates)].sort();
  const runs: string[][] = [];
  let run = [uniqueDates[0]];

  for (let i = 1; i < uniqueDates.length; i++) {
    const candidate = [...run, uniqueDates[i]];
    if (isCompletePatternRun(candidate)) {
      run = candidate;
    } else {
      runs.push(run);
      run = [uniqueDates[i]];
    }
  }
  runs.push(run);

  return runs;
}

function computeDaysOfWeek(dates: string[]): boolean[] {
  // [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
  const result = [false, false, false, false, false, false, false];
  for (const d of dates) {
    const jsDay = new Date(d + 'T00:00:00Z').getUTCDay(); // 0=Sun
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    result[idx] = true;
  }
  return result;
}

// ─── Excel Writer ──────────────────────────────────────────────

/**
 * Convert pattern groups back to Excel format matching original column structure.
 * Rule 4.4: Output must match original format exactly.
 */
export function exportToExcel(groups: PatternGroup[], seasonCode: string = 'S26'): Blob {
  const rows = groups.map((g) => {
    const effective = formatExcelDate(g.effective);
    const discontinue = formatExcelDate(g.discontinue);
    const arrFlightType = g.arrFlightNumber ? 'PAX' : '';
    const depFlightType = g.depFlightNumber ? 'PAX' : '';

    return {
      Effective: effective,
      Discontinue: discontinue,
      Airline: g.airline,
      Aircraft: g.aircraft,
      Mon: g.daysOfWeek[0] ? 1 : 0,
      Tue: g.daysOfWeek[1] ? 1 : 0,
      Wed: g.daysOfWeek[2] ? 1 : 0,
      Thu: g.daysOfWeek[3] ? 1 : 0,
      Fri: g.daysOfWeek[4] ? 1 : 0,
      Sat: g.daysOfWeek[5] ? 1 : 0,
      Sun: g.daysOfWeek[6] ? 1 : 0,
      STA: g.arrSchedule ?? '',
      ARRFlight: g.arrFlightNumber ?? '',
      ARRFlightType: arrFlightType,
      ARRRoute: g.arrRoute ?? '',
      ARRCodeShares: g.arrCodeShares ?? '',
      ARRIntDomInd: g.arrIntDomInd ?? '',
      STD: g.depSchedule ?? '',
      DEPFlight: g.depFlightNumber ?? '',
      DEPFlightType: depFlightType,
      DEPRoute: g.depRoute ?? '',
      ARRFlightCategory: g.arrCategory ?? '',
      DEPFlightCategory: g.depCategory ?? '',
      DEPCodeShares: g.depCodeShares ?? '',
      DEPIntDomInd: g.depIntDomInd ?? '',
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, seasonCode);

  const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Save the seasonal Excel file through the shared export pipeline. */
export function downloadSeasonalExcel(groups: PatternGroup[], seasonCode: string): Promise<ExportSaveResult> {
  const blob = exportToExcel(groups, seasonCode);
  return saveExportBlob({
    blob,
    fileName: `${seasonCode}_Updated_${Date.now()}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Convert ISO date "2026-03-29" to Excel format "29-Mar-26"
 */
function formatExcelDate(isoDate: string): string {
  const d = new Date(isoDate);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = String(d.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}
