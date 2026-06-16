import * as XLSX from 'xlsx';
import { flattenRowsToFlightRecords, flightRecordsToLegs, includeLinkedLegsForExport } from './atomicSchedule';
import { applyModificationsToFlightLegs } from './detailedScheduleState';
import { saveExportBlob, type ExportSaveResult } from './exportSave.ts';
import type { FlightLeg, FlightModification, FlightRecord, ParsedRow } from './types';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MS_PER_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type CanonicalSeasonalRow = ParsedRow;

export interface CanonicalSeasonalRowsInput {
  records: FlightRecord[];
  modifications?: Map<string, FlightModification>;
  selectedRecordIds?: string[];
}

export interface CanonicalSeasonalValidationIssue {
  code: 'missing-occurrence' | 'extra-occurrence';
  message: string;
  signature: string;
  count: number;
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
}

interface SourceRowRebuildApplyOptions {
  backup?: SourceRowRebuildBackup;
  syncMeta?: { pendingCount?: number; syncStatus?: string; conflicts?: unknown[] };
  pendingOps?: unknown[];
  replaceSourceRows: (seasonId: string, rows: CanonicalSeasonalRow[]) => Promise<void>;
}

function isoDateFromMs(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
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

function isCompletePatternRun(dates: string[]): boolean {
  const present = new Set(dates);
  const activeDays = new Set(dates.map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()));
  const startMs = new Date(`${dates[0]}T00:00:00Z`).getTime();
  const endMs = new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime();

  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    const current = new Date(ms);
    if (activeDays.has(current.getUTCDay()) && !present.has(isoDateFromMs(ms))) return false;
  }

  return true;
}

function splitIntoCompleteRuns(dates: string[]): string[][] {
  const uniqueDates = [...new Set(dates)].sort();
  if (uniqueDates.length === 0) return [];
  if (uniqueDates.length === 1) return [uniqueDates];

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
  if (arrival.airline !== departure.airline || arrival.aircraft !== departure.aircraft) return false;
  const linkType = pairLinkType(arrival, departure);
  const inferred = inferredSameRowLinkType(arrival, departure);
  if (!linkType || !inferred || linkType !== inferred) return false;
  if (linkType !== 'sameday') return false;
  return departure.date === arrival.date;
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
  const baseLegs = flightRecordsToLegs(input.records);
  const effectiveLegs = applyModificationsToFlightLegs(baseLegs, modifications);
  return includeLinkedLegsForExport(effectiveLegs, input.selectedRecordIds).sort(legSort);
}

function pairingKeys(leg: FlightLeg): string[] {
  const keys: string[] = [];
  if (leg.turnaroundId) keys.push(`turnaround:${leg.turnaroundId}`);
  if (leg.linkId && leg.pairAnchorDate && leg.linkType) {
    keys.push(`anchor:${leg.linkId}|${leg.pairAnchorDate}|${leg.linkType}`);
  }
  return keys;
}

function buildPairingIndex(legs: FlightLeg[]): Map<string, FlightLeg[]> {
  const index = new Map<string, FlightLeg[]>();
  for (const leg of legs) {
    for (const key of pairingKeys(leg)) {
      const bucket = index.get(key) ?? [];
      bucket.push(leg);
      index.set(key, bucket);
    }
  }
  return index;
}

function findLinkedCounterpart(
  leg: FlightLeg,
  byId: Map<string, FlightLeg>,
  byPairingKey: Map<string, FlightLeg[]>,
  processed: Set<string>
): FlightLeg | null {
  if (leg.linkedRecordId) {
    const direct = byId.get(leg.linkedRecordId);
    if (direct && direct.type !== leg.type && !processed.has(direct.id)) return direct;
  }

  for (const key of pairingKeys(leg)) {
    for (const candidate of byPairingKey.get(key) ?? []) {
      if (candidate.id !== leg.id && candidate.type !== leg.type && !processed.has(candidate.id)) return candidate;
    }
  }

  return null;
}

function hasPairingMetadata(leg: FlightLeg): boolean {
  return !!leg.linkedRecordId || pairingKeys(leg).length > 0;
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

function buildCandidates(legs: FlightLeg[]): { candidates: RowCandidate[]; unpairedLinkedLegs: number } {
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const byPairingKey = buildPairingIndex(legs);
  const processed = new Set<string>();
  const candidates: RowCandidate[] = [];
  let unpairedLinkedLegs = 0;

  for (const leg of legs) {
    if (processed.has(leg.id)) continue;

    const counterpart = findLinkedCounterpart(leg, byId, byPairingKey, processed);
    if (counterpart) {
      const arrival = leg.type === 'A' ? leg : counterpart;
      const departure = leg.type === 'D' ? leg : counterpart;
      if (arrival.type === 'A' && departure.type === 'D') {
        if (pairLinkType(arrival, departure) === 'overnight') {
          candidates.push(candidateFromLeg(arrival), candidateFromLeg(departure));
          processed.add(arrival.id);
          processed.add(departure.id);
          continue;
        }
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
        unpairedLinkedLegs += 2;
      }
    } else if (hasPairingMetadata(leg)) {
      unpairedLinkedLegs += 1;
    }

    candidates.push(candidateFromLeg(leg));
    processed.add(leg.id);
  }

  return { candidates, unpairedLinkedLegs };
}

function legIdentity(leg: FlightLeg | null): unknown[] {
  if (!leg) return [];
  return [
    leg.rawFlightNumber,
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
  ]);
}

function rowFromCandidate(candidate: RowCandidate, dates: string[], rowIndex: number): CanonicalSeasonalRow {
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
  };
}

function occurrenceSignature(leg: Pick<FlightLeg, 'type' | 'date' | 'airline' | 'rawFlightNumber' | 'route' | 'schedule' | 'aircraft' | 'category' | 'codeShares' | 'intDomInd'>): string {
  return [
    leg.type,
    leg.date,
    leg.airline,
    leg.rawFlightNumber,
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

function validationIssue(code: CanonicalSeasonalValidationIssue['code'], signature: string, count: number): CanonicalSeasonalValidationIssue {
  return {
    code,
    signature,
    count,
    message: `${code === 'missing-occurrence' ? 'Missing' : 'Extra'} ${count} occurrence(s): ${signature}`,
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
  return includeLinkedLegsForExport(expectedRecordsOrLegs as FlightLeg[], selectedRecordIds);
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
  const issues: CanonicalSeasonalValidationIssue[] = [];

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
  const groups = new Map<string, { sample: RowCandidate; dates: string[] }>();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const group = groups.get(key) ?? { sample: candidate, dates: [] };
    group.dates.push(candidate.date);
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
      rows.push(rowFromCandidate(group.sample, run, rowIndex++));
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
  const diffSummary = diffRows(input.currentRows, canonical.rows);
  const blockReason = rebuildBlockReason({
    validation: canonical.validation,
    syncMeta: input.syncMeta,
    pendingOps: input.pendingOps,
  });

  return {
    rows: canonical.rows,
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
