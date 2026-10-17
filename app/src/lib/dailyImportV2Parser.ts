import * as XLSX from 'xlsx';
import { analyzeDailyScheduleWorkbook } from './dailyScheduleWorkbook.ts';
import { parseDailyImportRowsStrict } from './dailyScheduleImport.ts';
import { sha256Hex, DAILY_RESOURCE_POLICY_VERSION } from './dailyImportV1Contract.ts';
import type { DailyImportLegInputV2, DailyImportStagePayloadV2 } from './operationalScheduleContract.ts';
export interface DailyImportParseResult {
  payload: DailyImportStagePayloadV2;
  sheetName: string;
  workbookProfile: string;
  rowCount: number;
  legCount: number;
  affectedDates: string[];
}

export interface ParseDailyScheduleWorkbookOptions {
  requestId?: string;
  fallbackDate?: string;
  confirmedZeroFlightDates?: string[];
}

/**
 * Pure parsing of daily schedule workbook buffer into canonical DailyImportStagePayloadV2.
 * Can execute in worker or main thread.
 * Preserves exact original route and resource mapping from strict row parsing.
 */
export async function parseDailyScheduleWorkbookToV2Payload(
  buffer: ArrayBuffer,
  fileName: string,
  options?: ParseDailyScheduleWorkbookOptions,
): Promise<DailyImportParseResult> {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const analysis = analyzeDailyScheduleWorkbook(workbook);
  if (!analysis.selected) {
    const errorDetails = analysis.diagnostics.length > 0
      ? analysis.diagnostics.map((d) => d.message).join('\n')
      : 'Không tìm thấy trang tính lịch bay hợp lệ trong tệp Excel.';
    throw new Error(`Không nhận diện được trang tính dữ liệu trong tệp: ${errorDetails}`);
  }

  const selectedSheet = analysis.selected;
  const strict = parseDailyImportRowsStrict(selectedSheet.rows, { workbookProfile: selectedSheet.profile });
  const blocking = strict.diagnostics.filter((item) => item.severity === 'blocking');
  if (blocking.length > 0) {
    const summary = blocking.slice(0, 10).map((item) => item.message).join('\n');
    const extra = blocking.length > 10 ? `\n... và ${blocking.length - 10} lỗi khác.` : '';
    throw new Error(`Dữ liệu trong tệp không hợp lệ:\n${summary}${extra}`);
  }

  const v2Legs: DailyImportLegInputV2[] = strict.legs.map((leg) => {
    const row = selectedSheet.rows[leg.rowNumber - 1] ?? {};
    return {
      operationalDate: leg.operationalDate,
      scheduledDate: leg.scheduledDate,
      scheduledTime: leg.scheduledTime,
      side: leg.side,
      airline: leg.airline,
      flightNumber: leg.flightNumber,
      rawFlightNumber: leg.rawFlightNumber,
      route: String(leg.updates.route ?? ''),
      aircraft: leg.aircraft,
      category: leg.category,
      flightType: leg.flightType,
      requestStatusCode: leg.requestStatusCode,
      sheetName: selectedSheet.sheetName,
      sourceRowNumber: leg.rowNumber,
      resources: leg.updates,
      rawResourceTokens: {
        stand: row[`${leg.side}Stand`] ? String(row[`${leg.side}Stand`]).trim() : null,
        gate: leg.side === 'DEP' && row.DEPGate ? String(row.DEPGate).trim() : null,
        carousel: leg.side === 'ARR' && row.ARRReclaimBelt ? String(row.ARRReclaimBelt).trim() : null,
        counter: leg.side === 'DEP' && row.CheckInDesk ? String(row.CheckInDesk).trim() : null,
      },
    };
  });

  const affectedDates = [...new Set(strict.coverage.map((entry) => entry.operationalDate))].sort();
  if (affectedDates.length === 0 && options?.fallbackDate) {
    affectedDates.push(options.fallbackDate);
  }

  const canonicalChecksum = await sha256Hex(JSON.stringify(v2Legs));
  const rawChecksum = await sha256Hex(buffer);
  const resourcePolicyHash = await sha256Hex(DAILY_RESOURCE_POLICY_VERSION);

  const payload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: options?.requestId ?? (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    fileName,
    workbookProfile: selectedSheet.profile,
    rawChecksum,
    canonicalChecksum,
    resourcePolicyHash,
    affectedDates,
    confirmedZeroFlightDates: options?.confirmedZeroFlightDates ?? [],
    legs: v2Legs,
    diagnostics: strict.diagnostics.map((item) => ({ ...item, sheetName: selectedSheet.sheetName })),
  };

  return {
    payload,
    sheetName: selectedSheet.sheetName,
    workbookProfile: selectedSheet.profile,
    rowCount: selectedSheet.rows.length,
    legCount: v2Legs.length,
    affectedDates,
  };
}
