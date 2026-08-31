import { parseDailyImportRowsStrict, type DailyImportRawRow, type ImportedDailyLeg } from './dailyScheduleImport.ts';
import type { DailyWorkbookSheetCandidate } from './dailyScheduleWorkbook.ts';
import type { Season } from './types.ts';
export { confirmDailyImportZeroFlightDatesV1 } from './dailyImportScope.ts';

export const DAILY_IMPORT_CONTRACT_VERSION = 1;
export const DAILY_RESOURCE_POLICY_VERSION = 'stand-text_gate-int_counter-token_status-filter_v2';

export interface CanonicalDailyImportLegV1 {
  sourceRowNumber: number;
  sheetName: string;
  side: 'ARR' | 'DEP';
  seasonCode: string;
  operationalDate: string;
  scheduledDate: string;
  scheduledTime: string;
  airline: string;
  flightNumber: string;
  rawFlightNumber: string;
  route: string;
  aircraft: string;
  category: string;
  flightType: string;
  requestStatusCode: string | null;
  resources: ImportedDailyLeg['updates'];
  rawResourceTokens: Record<string, string | null>;
  occurrenceKey: string;
  looseOccurrenceKey: string;
}

export interface DailyImportDiagnosticV1 {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  sheetName: string;
  rowNumber: number | null;
  cellAddress: string | null;
  seasonCode: string | null;
  operationalDate: string | null;
}

export interface DailyImportSeasonTargetV1 {
  seasonId: string;
  seasonCode: string;
  expectedDataVersion: number;
  rangeStart: string;
  rangeEnd: string;
  affectedDates: string[];
  confirmedZeroFlightDates: string[];
  legCount: number;
}

export interface DailyImportStagePayloadV1 {
  contractVersion: 1;
  requestId: string;
  fileName: string;
  workbookProfile: string;
  rawChecksum: string;
  canonicalChecksum: string;
  resourcePolicyHash: string;
  legs: CanonicalDailyImportLegV1[];
  seasons: DailyImportSeasonTargetV1[];
  diagnostics: DailyImportDiagnosticV1[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestUuidFromHash(hash: string): string {
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const compact = chars.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function rawToken(row: DailyImportRawRow, key: string): string | null {
  const value = row[key];
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

function canonicalLeg(leg: ImportedDailyLeg, sheet: DailyWorkbookSheetCandidate, rows: DailyImportRawRow[]): CanonicalDailyImportLegV1 {
  const row = rows[leg.rowNumber - 1] ?? {};
  const route = String(leg.updates.route ?? '');
  return {
    sourceRowNumber: leg.rowNumber,
    sheetName: sheet.sheetName,
    side: leg.side,
    seasonCode: leg.iataSeasonCode,
    operationalDate: leg.operationalDate,
    scheduledDate: leg.scheduledDate,
    scheduledTime: leg.scheduledTime,
    airline: leg.airline,
    flightNumber: leg.flightNumber,
    rawFlightNumber: leg.rawFlightNumber,
    route,
    aircraft: leg.aircraft,
    category: leg.category,
    flightType: leg.flightType,
    requestStatusCode: leg.requestStatusCode,
    resources: leg.updates,
    rawResourceTokens: {
      stand: rawToken(row, `${leg.side}Stand`),
      gate: leg.side === 'DEP' ? rawToken(row, 'DEPGate') : null,
      carousel: leg.side === 'ARR' ? rawToken(row, 'ARRReclaimBelt') : null,
      counter: leg.side === 'DEP' ? rawToken(row, 'CheckInDesk') : null,
    },
    occurrenceKey: [leg.iataSeasonCode, leg.operationalDate, leg.side, leg.airline, leg.flightNumber, route, leg.scheduledTime].join('|'),
    looseOccurrenceKey: [leg.iataSeasonCode, leg.operationalDate, leg.side, leg.airline, leg.flightNumber].join('|'),
  };
}

function allIsoDates(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export async function buildDailyImportStagePayloadV1(input: {
  fileName: string;
  rawBuffer: ArrayBuffer;
  sheet: DailyWorkbookSheetCandidate;
  seasons: Season[];
}): Promise<DailyImportStagePayloadV1> {
  const strict = parseDailyImportRowsStrict(input.sheet.rows, { workbookProfile: input.sheet.profile });
  const diagnostics: DailyImportDiagnosticV1[] = strict.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    sheetName: input.sheet.sheetName,
    cellAddress: null,
    seasonCode: null,
    operationalDate: null,
  }));
  const legs = strict.legs.map((leg) => canonicalLeg(leg, input.sheet, input.sheet.rows));
  const seasonByCode = new Map(input.seasons.map((season) => [season.seasonCode.toUpperCase(), season]));
  const targets: DailyImportSeasonTargetV1[] = [];
  for (const seasonCode of [...new Set(legs.map((leg) => leg.seasonCode))].sort()) {
    const season = seasonByCode.get(seasonCode);
    if (!season) {
      diagnostics.push({ severity: 'blocking', code: 'DAILY_SEASON_NOT_FOUND', message: `Season ${seasonCode} chưa tồn tại; Daily import V1 không tự tạo season khi stage.`, sheetName: input.sheet.sheetName, rowNumber: null, cellAddress: null, seasonCode, operationalDate: null });
      continue;
    }
    const seasonLegs = legs.filter((leg) => leg.seasonCode === seasonCode);
    const affectedDates = [...new Set(seasonLegs.map((leg) => leg.operationalDate))].sort();
    const rangeStart = affectedDates[0];
    const rangeEnd = affectedDates.at(-1)!;
    const gaps = allIsoDates(rangeStart, rangeEnd).filter((date) => !affectedDates.includes(date));
    if (gaps.length > 0) {
      diagnostics.push({ severity: 'blocking', code: 'DAILY_COVERAGE_GAP', message: `Khoảng ${rangeStart}..${rangeEnd} thiếu ${gaps.length} Ops Date: ${gaps.join(', ')}.`, sheetName: input.sheet.sheetName, rowNumber: null, cellAddress: null, seasonCode, operationalDate: null });
    }
    targets.push({ seasonId: season.id, seasonCode, expectedDataVersion: season.dataVersion ?? 0, rangeStart, rangeEnd, affectedDates, confirmedZeroFlightDates: [], legCount: seasonLegs.length });
  }

  const resourcePolicyHash = await sha256Hex(DAILY_RESOURCE_POLICY_VERSION);
  const canonicalChecksum = await sha256Hex(stableJson({ contractVersion: DAILY_IMPORT_CONTRACT_VERSION, legs, targets, resourcePolicyHash }));
  const rawChecksum = await sha256Hex(input.rawBuffer);
  const requestId = requestUuidFromHash(await sha256Hex(stableJson({ canonicalChecksum, rawChecksum, resourcePolicyHash, targets })));
  return {
    contractVersion: DAILY_IMPORT_CONTRACT_VERSION,
    requestId,
    fileName: input.fileName,
    workbookProfile: input.sheet.profile,
    rawChecksum,
    canonicalChecksum,
    resourcePolicyHash,
    legs,
    seasons: targets,
    diagnostics,
  };
}
