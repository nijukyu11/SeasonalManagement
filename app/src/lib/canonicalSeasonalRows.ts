import * as XLSX from 'xlsx';
import {
  canonicalizeSeasonalFlightIdentity,
  flattenRowsToFlightRecords,
  flightRecordsToLegs,
} from './atomicSchedule';
import { materializeEffectiveSeasonalLegs } from './effectiveSeasonalLegs.ts';
import {
  closeSeasonalSelectionOverPairs,
  resolveSeasonalPairs,
  type SeasonalPairIssue,
} from './seasonalPairing.ts';
import { saveExportBlob, type ExportSaveResult } from './exportSave.ts';
import type { FlightLeg, FlightModification, FlightRecord, ParsedRow } from './types';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MS_PER_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type CanonicalSeasonalRow = ParsedRow & {
  /** Export-only references; the schedule template remains 25 columns. */
  pairReferences?: FlightLeg[];
};

export interface CanonicalSeasonalRowsInput {
  records: FlightRecord[];
  modifications?: Map<string, FlightModification>;
  selectedRecordIds?: string[];
}

export interface CanonicalSeasonalValidationIssue {
  code: 'missing-occurrence' | 'extra-occurrence' | SeasonalPairIssue['code'];
  message: string;
  signature: string;
  count: number;
  legId?: string;
}

export interface CanonicalSeasonalValidationResult {
  valid: boolean;
  expectedCount: number;
  actualCount: number;
  issues: CanonicalSeasonalValidationIssue[];
}

export interface CanonicalSeasonalRowsResult {
  rows: CanonicalSeasonalRow[];
  effectiveLegs: FlightLeg[];
  validation: CanonicalSeasonalValidationResult;
  diagnostics: string[];
  stats: {
    inputRecords: number;
    effectiveLegs: number;
    outputRows: number;
    unpairedLinkedLegs: number;
  };
}

export interface SourceRowRebuildDiffSummary {
  existingRows: number;
  rebuiltRows: number;
  unchangedRows: number;
  addedRows: number;
  removedRows: number;
}

export interface SourceRowRebuildPlanInput extends CanonicalSeasonalRowsInput {
  currentRows: ParsedRow[];
  syncMeta?: { pendingCount?: number; syncStatus?: string; conflicts?: unknown[] };
  pendingOps?: unknown[];
}

export interface SourceRowRebuildPlan {
  rows: CanonicalSeasonalRow[];
  validation: CanonicalSeasonalValidationResult;
  diffSummary: SourceRowRebuildDiffSummary;
  canApply: boolean;
  blockReason: string | null;
  diagnostics: string[];
}

export interface SourceRowRebuildBackup {
  seasonId: string;
  createdAt: number;
  currentRows: ParsedRow[];
  rebuiltRows: CanonicalSeasonalRow[];
  diffSummary: SourceRowRebuildDiffSummary;
  validation: CanonicalSeasonalValidationResult;
}

interface RowCandidate {
  date: string;
  airline: string;
  aircraft: string;
  arrival: FlightLeg | null;
  departure: FlightLeg | null;
  overnight?: boolean;
}

interface SourceRowRebuildApplyOptions {
  backup?: SourceRowRebuildBackup;
  syncMeta?: { pendingCount?: number; syncStatus?: string; conflicts?: unknown[] };
  pendingOps?: unknown[];
  replaceSourceRows: (seasonId: string, rows: CanonicalSeasonalRow[]) => Promise<void>;
}

function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function formatExcelDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)}`;
}

function dayIndex(isoDate: string): number {
  const jsDay = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function computeDaysOfWeek(dates: string[]): boolean[] {
  const days = [false, false, false, false, false, false, false];
  for (const date of dates) days[dayIndex(date)] = true;
  return days;
}

function splitIntoCompleteRuns(dates: string[]): string[][] {
  const uniqueDates = [...new Set(dates)].sort();
  const count = uniqueDates.length;
  if (count === 0) return [];
  if (count === 1) return [uniqueDates];

  const calendarDays = uniqueDates.map((date) => new Date(`${date}T00:00:00Z`).getTime() / MS_PER_DAY);
  const weekdays = uniqueDates.map(dayIndex);
  const lastComplete = new Int32Array(count);
  const weekdayCounts = new Int32Array(7);

  // A missing active weekday inside an interval cannot be repaired by
  // extending its end. Cache the longest valid endpoint for every start.
  for (let start = 0; start < count; start++) {
    weekdayCounts.fill(0);
    lastComplete[start] = start;
    for (let end = start; end < count; end++) {
      weekdayCounts[weekdays[end]]++;
      const span = calendarDays[end] - calendarDays[start];
      let complete = true;
      for (let weekday = 0; weekday < 7; weekday++) {
        if (weekdayCounts[weekday] === 0) continue;
        const firstOffset = (weekday - weekdays[start] + 7) % 7;
        const expectedCount = Math.floor((span - firstOffset) / 7) + 1;
        if (weekdayCounts[weekday] !== expectedCount) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      lastComplete[start] = end;
    }
  }

  const pending: Array<[number, number]> = [[0, count - 1]];
  const phases: Array<[number, number]> = [];
  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    let bestStart = left;
    let bestEnd = left;
    let bestSpan = 0;
    for (let start = left; start <= right; start++) {
      const end = Math.min(lastComplete[start], right);
      const span = calendarDays[end] - calendarDays[start];
      if (span > bestSpan || (span === bestSpan && end - start > bestEnd - bestStart)) {
        bestStart = start;
        bestEnd = end;
        bestSpan = span;
      }
    }
    // Ascending starts retain the earliest phase when span and count tie.
    phases.push([bestStart, bestEnd]);
    if (left < bestStart) pending.push([left, bestStart - 1]);
    if (bestEnd < right) pending.push([bestEnd + 1, right]);
  }

  return phases.sort((left, right) => left[0] - right[0])
    .map(([start, end]) => uniqueDates.slice(start, end + 1));
}

function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function inferredSameRowLinkType(arrival: FlightLeg, departure: FlightLeg): 'overnight' | 'sameday' | null {
  const arrMinutes = timeToMinutes(arrival.schedule);
  const depMinutes = timeToMinutes(departure.schedule);
  if (arrMinutes == null || depMinutes == null) return null;
  return depMinutes < arrMinutes ? 'overnight' : 'sameday';
}

function pairLinkType(arrival: FlightLeg, departure: FlightLeg): 'overnight' | 'sameday' | null {
  if (arrival.linkType && departure.linkType && arrival.linkType !== departure.linkType) return null;
  if (arrival.linkType) return arrival.linkType;
  if (departure.linkType) return departure.linkType;
  if (departure.date === arrival.date) return 'sameday';
  if (departure.date === shiftIsoDate(arrival.date, 1)) return 'overnight';
  return null;
}

function canRepresentAsSingleImportRow(arrival: FlightLeg, departure: FlightLeg): boolean {
  if (arrival.date !== departure.date) return false;
  if (arrival.airline !== departure.airline || arrival.aircraft !== departure.aircraft) return false;
  const linkType = pairLinkType(arrival, departure);
  const inferred = inferredSameRowLinkType(arrival, departure);
  return linkType === 'sameday' && inferred === 'sameday';
}

function legSort(left: FlightLeg, right: FlightLeg): number {
  return (
    left.date.localeCompare(right.date) ||
    (left.type === right.type ? 0 : left.type === 'A' ? -1 : 1) ||
    left.flightNumber.localeCompare(right.flightNumber) ||
    left.id.localeCompare(right.id)
  );
}

function buildEffectiveLegs(input: CanonicalSeasonalRowsInput): FlightLeg[] {
  const modifications = input.modifications ?? new Map<string, FlightModification>();
  const effectiveLegs = materializeEffectiveSeasonalLegs(input.records, modifications);
  if (!input.selectedRecordIds || input.selectedRecordIds.length === 0) return effectiveLegs.sort(legSort);
  const selected = new Set(closeSeasonalSelectionOverPairs(
    input.selectedRecordIds,
    resolveSeasonalPairs(effectiveLegs),
  ));
  return effectiveLegs.filter((leg) => selected.has(leg.id)).sort(legSort);
}

function candidateFromLeg(leg: FlightLeg): RowCandidate {
  return {
    date: leg.date,
    airline: leg.airline,
    aircraft: leg.aircraft,
    arrival: leg.type === 'A' ? leg : null,
    departure: leg.type === 'D' ? leg : null,
  };
}

function buildCandidates(legs: FlightLeg[]): {
  candidates: RowCandidate[];
  unpairedLinkedLegs: number;
} {
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const resolution = resolveSeasonalPairs(legs);
  const processed = new Set<string>();
  const candidates: RowCandidate[] = [];
  const issueLegIds = new Set(resolution.issues.map((issue) => issue.legId));

  for (const leg of legs) {
    if (processed.has(leg.id)) continue;

    const counterpartId = resolution.byLegId.get(leg.id);
    const counterpart = counterpartId ? byId.get(counterpartId) ?? null : null;
    if (counterpart) {
      const arrival = leg.type === 'A' ? leg : counterpart;
      const departure = leg.type === 'D' ? leg : counterpart;
      if (arrival.type === 'A' && departure.type === 'D') {
        if (canRepresentAsSingleImportRow(arrival, departure)) {
          candidates.push({
            date: arrival.date,
            airline: arrival.airline,
            aircraft: arrival.aircraft,
            arrival,
            departure,
          });
          processed.add(arrival.id);
          processed.add(departure.id);
          continue;
        }
        if (pairLinkType(arrival, departure) === 'overnight') {
          candidates.push({
            date: arrival.date,
            airline: arrival.airline,
            aircraft: arrival.aircraft,
            arrival,
            departure,
            overnight: true,
          });
          processed.add(arrival.id);
          processed.add(departure.id);
          continue;
        }
      }
    }

    candidates.push(candidateFromLeg(leg));
    processed.add(leg.id);
  }

  return {
    candidates,
    unpairedLinkedLegs: issueLegIds.size,
  };
}

function legIdentity(leg: FlightLeg | null): unknown[] {
  if (!leg) return [];
  const identity = canonicalizeSeasonalFlightIdentity(leg);
  return [
    identity.flightNumber,
    leg.route,
    leg.schedule,
    leg.category,
    leg.codeShares ?? '',
    leg.intDomInd ?? '',
  ];
}

function candidateKey(candidate: RowCandidate): string {
  return JSON.stringify([
    candidate.airline,
    candidate.aircraft,
    legIdentity(candidate.arrival),
    legIdentity(candidate.departure),
    candidate.overnight ?? false,
    candidate.departure?.airline ?? '',
    candidate.departure?.aircraft ?? '',
  ]);
}

function rowFromCandidate(candidate: RowCandidate, dates: string[], rowIndex: number, occurrences: RowCandidate[]): CanonicalSeasonalRow {
  const arrival = candidate.arrival;
  const departure = candidate.departure;
  return {
    rowIndex,
    effective: formatExcelDate(dates[0]),
    discontinue: formatExcelDate(dates[dates.length - 1]),
    airline: candidate.airline,
    aircraft: candidate.aircraft,
    daysOfWeek: computeDaysOfWeek(dates),
    sta: arrival?.schedule ?? null,
    arrFlight: arrival?.rawFlightNumber ?? null,
    arrFlightType: arrival ? 'PAX' : null,
    arrRoute: arrival?.route ?? null,
    arrFlightCategory: arrival?.category ?? null,
    arrCodeShares: arrival?.codeShares ?? null,
    arrIntDomInd: arrival?.intDomInd ?? null,
    std: departure?.schedule ?? null,
    depFlight: departure?.rawFlightNumber ?? null,
    depFlightType: departure ? 'PAX' : null,
    depRoute: departure?.route ?? null,
    depFlightCategory: departure?.category ?? null,
    depCodeShares: departure?.codeShares ?? null,
    depIntDomInd: departure?.intDomInd ?? null,
    pairReferences: occurrences
      .filter((occurrence) => dates.includes(occurrence.date))
      .flatMap((occurrence) => [occurrence.arrival, occurrence.departure])
      .filter((leg): leg is FlightLeg => leg !== null),
  };
}

function occurrenceSignature(leg: Pick<FlightLeg, 'type' | 'date' | 'airline' | 'flightNumber' | 'route' | 'schedule' | 'aircraft' | 'category' | 'codeShares' | 'intDomInd'>): string {
  const identity = canonicalizeSeasonalFlightIdentity(leg);
  return [
    leg.type,
    leg.date,
    identity.airline,
    identity.flightNumber,
    leg.route,
    leg.schedule,
    leg.aircraft,
    leg.category,
    leg.codeShares ?? '',
    leg.intDomInd ?? '',
  ].join('|');
}

function countSignatures(legs: FlightLeg[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const leg of legs.filter((entry) => entry.action !== 'deleted')) {
    const signature = occurrenceSignature(leg);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function validationIssue(
  code: 'missing-occurrence' | 'extra-occurrence',
  signature: string,
  count: number,
): CanonicalSeasonalValidationIssue {
  return {
    code,
    signature,
    count,
    message: `${code === 'missing-occurrence' ? 'Missing' : 'Extra'} ${count} occurrence(s): ${signature}`,
  };
}

function pairValidationIssue(issue: SeasonalPairIssue): CanonicalSeasonalValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    signature: `pair:${issue.legId}`,
    count: 1,
    legId: issue.legId,
  };
}

function expectedLegsFromInput(
  expectedRecordsOrLegs: FlightRecord[] | FlightLeg[],
  modifications?: Map<string, FlightModification>,
  selectedRecordIds?: string[]
): FlightLeg[] {
  const first = expectedRecordsOrLegs[0] as Partial<FlightRecord> | undefined;
  if (first && 'status' in first && 'sourceKind' in first) {
    return buildEffectiveLegs({
      records: expectedRecordsOrLegs as FlightRecord[],
      modifications,
      selectedRecordIds,
    });
  }
  const activeLegs = (expectedRecordsOrLegs as FlightLeg[]).filter((leg) => leg.action !== 'deleted');
  if (!selectedRecordIds || selectedRecordIds.length === 0) return activeLegs;
  const selected = new Set(closeSeasonalSelectionOverPairs(selectedRecordIds, resolveSeasonalPairs(activeLegs)));
  return activeLegs.filter((leg) => selected.has(leg.id));
}

export function validateCanonicalSeasonalRoundTrip(
  rows: CanonicalSeasonalRow[],
  expectedRecordsOrLegs: FlightRecord[] | FlightLeg[],
  modifications?: Map<string, FlightModification>,
  selectedRecordIds?: string[]
): CanonicalSeasonalValidationResult {
  const expectedLegs = expectedLegsFromInput(expectedRecordsOrLegs, modifications, selectedRecordIds);
  const actualLegs = flightRecordsToLegs(flattenRowsToFlightRecords(rows));
  const expectedCounts = countSignatures(expectedLegs);
  const actualCounts = countSignatures(actualLegs);
  const issues = resolveSeasonalPairs(expectedLegs).issues.map(pairValidationIssue);

  for (const [signature, count] of expectedCounts) {
    const actual = actualCounts.get(signature) ?? 0;
    if (actual < count) issues.push(validationIssue('missing-occurrence', signature, count - actual));
  }
  for (const [signature, count] of actualCounts) {
    const expected = expectedCounts.get(signature) ?? 0;
    if (expected < count) issues.push(validationIssue('extra-occurrence', signature, count - expected));
  }

  return {
    valid: issues.length === 0,
    expectedCount: expectedLegs.length,
    actualCount: actualLegs.length,
    issues,
  };
}
export function buildCanonicalSeasonalRows(input: CanonicalSeasonalRowsInput): CanonicalSeasonalRowsResult {
  const effectiveLegs = buildEffectiveLegs(input);
  const { candidates, unpairedLinkedLegs } = buildCandidates(effectiveLegs);
  const groups = new Map<string, { sample: RowCandidate; dates: string[]; occurrences: RowCandidate[] }>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const group = groups.get(key) ?? { sample: candidate, dates: [], occurrences: [] };
    group.dates.push(candidate.date);
    group.occurrences.push(candidate);
    groups.set(key, group);
  }

  const rows: CanonicalSeasonalRow[] = [];
  let rowIndex = 1;
  for (const group of Array.from(groups.values()).sort((left, right) =>
    left.sample.airline.localeCompare(right.sample.airline) ||
    left.sample.date.localeCompare(right.sample.date) ||
    candidateKey(left.sample).localeCompare(candidateKey(right.sample))
  )) {
    for (const run of splitIntoCompleteRuns(group.dates)) {
      if (group.sample.overnight) {
        const arrivalOccurrences = group.occurrences.map((occurrence) => candidateFromLeg(occurrence.arrival!));
        const departureOccurrences = group.occurrences.map((occurrence) => candidateFromLeg(occurrence.departure!));
        const arrivalRow = rowFromCandidate(candidateFromLeg(group.sample.arrival!), run, rowIndex++, arrivalOccurrences);
        const departureRow = rowFromCandidate(
          candidateFromLeg(group.sample.departure!), run.map((date) => shiftIsoDate(date, 1)), rowIndex++, departureOccurrences,
        );
        arrivalRow.overnightLinkRowIndex = departureRow.rowIndex;
        departureRow.overnightLinkRowIndex = arrivalRow.rowIndex;
        arrivalRow.linkType = departureRow.linkType = 'overnight';
        rows.push(arrivalRow, departureRow);
      } else {
        rows.push(rowFromCandidate(group.sample, run, rowIndex++, group.occurrences));
      }
    }
  }


  const validation = validateCanonicalSeasonalRoundTrip(rows, effectiveLegs);
  return {
    rows,
    effectiveLegs,
    validation,
    diagnostics: validation.issues.map((issue) => issue.message),
    stats: {
      inputRecords: input.records.length,
      effectiveLegs: effectiveLegs.length,
      outputRows: rows.length,
      unpairedLinkedLegs,
    },
  };
}

export function exportCanonicalSeasonalRowsToExcel(rows: CanonicalSeasonalRow[], seasonCode = 'S26'): Blob {
  const sheetRows = rows.map((row) => ({
    Effective: row.effective,
    Discontinue: row.discontinue,
    Airline: row.airline,
    Aircraft: row.aircraft,
    Mon: row.daysOfWeek[0] ? 1 : 0,
    Tue: row.daysOfWeek[1] ? 1 : 0,
    Wed: row.daysOfWeek[2] ? 1 : 0,
    Thu: row.daysOfWeek[3] ? 1 : 0,
    Fri: row.daysOfWeek[4] ? 1 : 0,
    Sat: row.daysOfWeek[5] ? 1 : 0,
    Sun: row.daysOfWeek[6] ? 1 : 0,
    STA: row.sta ?? '',
    ARRFlight: row.arrFlight ?? '',
    ARRFlightType: row.arrFlight ? 'PAX' : '',
    ARRRoute: row.arrRoute ?? '',
    ARRCodeShares: row.arrCodeShares ?? '',
    ARRIntDomInd: row.arrIntDomInd ?? '',
    STD: row.std ?? '',
    DEPFlight: row.depFlight ?? '',
    DEPFlightType: row.depFlight ? 'PAX' : '',
    DEPRoute: row.depRoute ?? '',
    ARRFlightCategory: row.arrFlightCategory ?? '',
    DEPFlightCategory: row.depFlightCategory ?? '',
    DEPCodeShares: row.depCodeShares ?? '',
    DEPIntDomInd: row.depIntDomInd ?? '',
  }));

  const worksheet = XLSX.utils.json_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, seasonCode);
  const references = rows.flatMap((row, index) => (row.pairReferences ?? []).map((leg) => ({
    'Schedule Row': index + 2,
    'Pair Key': leg.turnaroundId ?? (leg.linkedRecordId || leg.linkType || leg.pairAnchorDate ? leg.linkId : ''),
    'Record ID': leg.id,
    'Linked Record ID': leg.linkedRecordId ?? '',
    'Link Type': leg.linkType ?? '',
    'Pair Anchor Date': leg.pairAnchorDate ? formatExcelDate(leg.pairAnchorDate) : '',
    Type: leg.type,
    'Scheduled Date': formatExcelDate(leg.scheduledDate ?? leg.date),
    'Scheduled Time': leg.scheduledTime ?? leg.schedule,
    'Operational Date': formatExcelDate(leg.operationalDate ?? leg.date),
    Airline: leg.airline,
    Aircraft: leg.aircraft,
    Flight: leg.rawFlightNumber,
    Route: leg.route,
  })));
  if (references.length > 0) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(references), 'Pair References');
  }
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([bytes], { type: XLSX_MIME_TYPE });
}

export function downloadCanonicalSeasonalExcel(rows: CanonicalSeasonalRow[], seasonCode: string): Promise<ExportSaveResult> {
  return saveExportBlob({
    blob: exportCanonicalSeasonalRowsToExcel(rows, seasonCode),
    fileName: `${seasonCode}_Updated_${Date.now()}.xlsx`,
    mimeType: XLSX_MIME_TYPE,
  });
}

function rowSignature(row: ParsedRow): string {
  return JSON.stringify({
    airline: row.airline,
    aircraft: row.aircraft,
    effective: row.effective,
    discontinue: row.discontinue,
    daysOfWeek: row.daysOfWeek,
    sta: row.sta ?? null,
    arrFlight: row.arrFlight ?? null,
    arrRoute: row.arrRoute ?? null,
    arrFlightCategory: row.arrFlightCategory ?? null,
    arrCodeShares: row.arrCodeShares ?? null,
    arrIntDomInd: row.arrIntDomInd ?? null,
    std: row.std ?? null,
    depFlight: row.depFlight ?? null,
    depRoute: row.depRoute ?? null,
    depFlightCategory: row.depFlightCategory ?? null,
    depCodeShares: row.depCodeShares ?? null,
    depIntDomInd: row.depIntDomInd ?? null,
  });
}

function diffRows(currentRows: ParsedRow[], rebuiltRows: CanonicalSeasonalRow[]): SourceRowRebuildDiffSummary {
  const currentCounts = new Map<string, number>();
  const rebuiltCounts = new Map<string, number>();
  for (const row of currentRows) currentCounts.set(rowSignature(row), (currentCounts.get(rowSignature(row)) ?? 0) + 1);
  for (const row of rebuiltRows) rebuiltCounts.set(rowSignature(row), (rebuiltCounts.get(rowSignature(row)) ?? 0) + 1);

  let unchangedRows = 0;
  for (const [signature, count] of currentCounts) {
    unchangedRows += Math.min(count, rebuiltCounts.get(signature) ?? 0);
  }

  return {
    existingRows: currentRows.length,
    rebuiltRows: rebuiltRows.length,
    unchangedRows,
    addedRows: Math.max(0, rebuiltRows.length - unchangedRows),
    removedRows: Math.max(0, currentRows.length - unchangedRows),
  };
}

function rebuildBlockReason(input: {
  validation: CanonicalSeasonalValidationResult;
  syncMeta?: { pendingCount?: number; syncStatus?: string; conflicts?: unknown[] };
  pendingOps?: unknown[];
}): string | null {
  if (!input.validation.valid) return input.validation.issues[0]?.message ?? 'Canonical source rows do not round-trip.';
  if ((input.pendingOps?.length ?? 0) > 0 || (input.syncMeta?.pendingCount ?? 0) > 0) {
    return 'Source-row rebuild requires a synced workspace with no pending changes.';
  }
  if (input.syncMeta?.syncStatus && input.syncMeta.syncStatus !== 'synced') {
    return `Source-row rebuild requires syncStatus=synced, got ${input.syncMeta.syncStatus}.`;
  }
  if ((input.syncMeta?.conflicts?.length ?? 0) > 0) {
    return 'Source-row rebuild is blocked while conflicts need review.';
  }
  return null;
}

export function buildSourceRowRebuildPlan(input: SourceRowRebuildPlanInput): SourceRowRebuildPlan {
  const canonical = buildCanonicalSeasonalRows(input);
  const rebuildRows = canonical.rows.map(({ pairReferences, ...row }) => {
    void pairReferences;
    return row;
  });
  const diffSummary = diffRows(input.currentRows, rebuildRows);
  const blockReason = rebuildBlockReason({
    validation: canonical.validation,
    syncMeta: input.syncMeta,
    pendingOps: input.pendingOps,
  });

  return {
    rows: rebuildRows,
    validation: canonical.validation,
    diffSummary,
    canApply: blockReason == null,
    blockReason,
    diagnostics: canonical.diagnostics,
  };
}

export function buildSourceRowRebuildBackup(input: {
  seasonId: string;
  currentRows: ParsedRow[];
  plan: SourceRowRebuildPlan;
  createdAt?: number;
}): SourceRowRebuildBackup {
  return {
    seasonId: input.seasonId,
    createdAt: input.createdAt ?? Date.now(),
    currentRows: input.currentRows.map((row) => ({ ...row, daysOfWeek: [...row.daysOfWeek] })),
    rebuiltRows: input.plan.rows.map((row) => ({ ...row, daysOfWeek: [...row.daysOfWeek] })),
    diffSummary: input.plan.diffSummary,
    validation: input.plan.validation,
  };
}

export async function applySourceRowRebuildPlan(
  seasonId: string,
  plan: SourceRowRebuildPlan,
  options: SourceRowRebuildApplyOptions
): Promise<{ writtenRows: number }> {
  const blockReason = rebuildBlockReason({
    validation: plan.validation,
    syncMeta: options.syncMeta,
    pendingOps: options.pendingOps,
  }) ?? plan.blockReason;

  if (blockReason) throw new Error(blockReason);
  if (!plan.canApply) throw new Error(plan.blockReason ?? 'Source-row rebuild plan is not applicable.');
  if (!options.backup || options.backup.seasonId !== seasonId) {
    throw new Error('Source-row rebuild requires a matching backup before write.');
  }
  if (options.backup.rebuiltRows.length !== plan.rows.length) {
    throw new Error('Source-row rebuild backup does not match the rebuild plan.');
  }

  await options.replaceSourceRows(seasonId, plan.rows);
  return { writtenRows: plan.rows.length };
}
