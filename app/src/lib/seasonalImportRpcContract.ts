import type { RemoteSeasonalImportResult } from './remoteStore.ts';
import type { ParsedRow } from './types.ts';

const COMMITTED_RESULT_FIELDS = [
  'batchId',
  'seasonId',
  'seasonCode',
  'status',
  'sourceRowCount',
  'flightRecordCount',
  'preservedOperationalCount',
  'removedImportedCount',
  'dataVersion',
  'serverHighWater',
  'checksum',
] as const;

const STAGE_RESULT_FIELDS = [
  'batchId',
  'status',
  'sourceRowCount',
  'generatedRecordCount',
  'diagnostics',
  'valid',
] as const;

export interface SeasonalImportV2StageResult {
  batchId: string;
  status: 'validated';
  sourceRowCount: number;
  generatedRecordCount: number;
  diagnostics: [];
  valid: true;
}

export interface SeasonalImportCommittedRefreshFailure {
  title: 'Import committed, refresh failed';
  message: string;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new Error(`${label}.${field} is required.`);
    }
  }
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) {
      throw new Error(`${label} contains unexpected field ${field}.`);
    }
  }
  return record;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string.`);
  }
  return value;
}

function requireCount(record: Record<string, unknown>, field: string, label: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.${field} must be a finite safe non-negative integer.`);
  }
  return value;
}

function diagnosticMessage(diagnostics: unknown[]): string {
  return diagnostics.map((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      return String(diagnostic);
    }
    const record = diagnostic as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : 'unknown-diagnostic';
    const message = typeof record.message === 'string' ? record.message : JSON.stringify(record);
    return `${code}: ${message}`;
  }).join('; ');
}

export function parseSeasonalImportV2Result(value: unknown): RemoteSeasonalImportResult {
  const record = requireExactRecord(value, COMMITTED_RESULT_FIELDS, 'Seasonal import commit response');
  const status = requireNonEmptyString(record, 'status', 'Seasonal import commit response');
  if (status !== 'committed') {
    throw new Error('Seasonal import commit response.status must be committed.');
  }

  return {
    batchId: requireNonEmptyString(record, 'batchId', 'Seasonal import commit response'),
    seasonId: requireNonEmptyString(record, 'seasonId', 'Seasonal import commit response'),
    seasonCode: requireNonEmptyString(record, 'seasonCode', 'Seasonal import commit response'),
    status,
    sourceRowCount: requireCount(record, 'sourceRowCount', 'Seasonal import commit response'),
    flightRecordCount: requireCount(record, 'flightRecordCount', 'Seasonal import commit response'),
    preservedOperationalCount: requireCount(record, 'preservedOperationalCount', 'Seasonal import commit response'),
    removedImportedCount: requireCount(record, 'removedImportedCount', 'Seasonal import commit response'),
    dataVersion: requireCount(record, 'dataVersion', 'Seasonal import commit response'),
    serverHighWater: requireCount(record, 'serverHighWater', 'Seasonal import commit response'),
    checksum: requireNonEmptyString(record, 'checksum', 'Seasonal import commit response'),
  };
}

export function parseSeasonalImportV2StageResult(value: unknown): SeasonalImportV2StageResult {
  const record = requireExactRecord(value, STAGE_RESULT_FIELDS, 'Seasonal import stage response');
  const batchId = requireNonEmptyString(record, 'batchId', 'Seasonal import stage response');
  const status = requireNonEmptyString(record, 'status', 'Seasonal import stage response');
  const sourceRowCount = requireCount(record, 'sourceRowCount', 'Seasonal import stage response');
  const generatedRecordCount = requireCount(record, 'generatedRecordCount', 'Seasonal import stage response');
  if (!Array.isArray(record.diagnostics)) {
    throw new Error('Seasonal import stage response.diagnostics must be an array.');
  }
  if (record.diagnostics.length > 0) {
    throw new Error(`Seasonal import stage diagnostics: ${diagnosticMessage(record.diagnostics)}`);
  }
  if (status !== 'validated') {
    throw new Error('Seasonal import stage response.status must be validated.');
  }
  if (record.valid !== true) {
    throw new Error('Seasonal import stage response.valid must be true.');
  }

  return {
    batchId,
    status,
    sourceRowCount,
    generatedRecordCount,
    diagnostics: [],
    valid: true,
  };
}

function normalizeSeasonCode(seasonCode: string): string {
  const normalized = seasonCode.trim().toUpperCase();
  if (!normalized) throw new Error('seasonCode must be a non-empty string.');
  return normalized;
}

function canonicalSourceRow(row: ParsedRow): Record<string, unknown> {
  return {
    rowIndex: row.rowIndex,
    effective: row.effective,
    discontinue: row.discontinue,
    airline: row.airline,
    aircraft: row.aircraft,
    daysOfWeek: row.daysOfWeek,
    sta: row.sta,
    arrFlight: row.arrFlight,
    arrFlightType: row.arrFlightType,
    arrRoute: row.arrRoute,
    arrFlightCategory: row.arrFlightCategory,
    arrCodeShares: row.arrCodeShares,
    arrIntDomInd: row.arrIntDomInd,
    std: row.std,
    depFlight: row.depFlight,
    depFlightType: row.depFlightType,
    depRoute: row.depRoute,
    depFlightCategory: row.depFlightCategory,
    depCodeShares: row.depCodeShares,
    depIntDomInd: row.depIntDomInd,
    overnightLinkRowIndex: row.overnightLinkRowIndex,
    linkType: row.linkType,
  };
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical seasonal import data contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Canonical seasonal import data contains unsupported ${typeof value} value.`);
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildSeasonalImportV2Checksum(
  seasonCode: string,
  sourceRows: readonly ParsedRow[],
): Promise<string> {
  const canonicalPayload = stableJson({
    seasonCode: normalizeSeasonCode(seasonCode),
    sourceRows: sourceRows.map(canonicalSourceRow),
  });
  return bytesToHex(await sha256Bytes(canonicalPayload));
}

export function normalizeSeasonalImportExpectedDataVersion(
  seasonId: string | null | undefined,
  expectedDataVersion: number | null,
): number {
  const normalizedSeasonId = seasonId?.trim() ?? '';
  if (seasonId != null && !normalizedSeasonId) {
    throw new Error('seasonId must be a non-empty string when provided.');
  }
  if (expectedDataVersion === null && !normalizedSeasonId) return 0;
  if (!Number.isSafeInteger(expectedDataVersion) || (expectedDataVersion ?? -1) < 0) {
    throw new Error('expectedDataVersion must be a finite safe non-negative integer.');
  }
  return expectedDataVersion as number;
}

export async function deriveSeasonalImportV2RequestId(input: {
  seasonId?: string | null;
  seasonCode: string;
  expectedDataVersion: number | null;
  checksum: string;
}): Promise<string> {
  const seasonId = input.seasonId?.trim() ?? '';
  const expectedDataVersion = normalizeSeasonalImportExpectedDataVersion(
    input.seasonId,
    input.expectedDataVersion,
  );
  const checksum = input.checksum.trim().toLowerCase();
  if (!checksum) throw new Error('checksum must be a non-empty string.');
  const seasonIdentity = seasonId || `new:${normalizeSeasonCode(input.seasonCode)}`;
  const bytes = await sha256Bytes(stableJson({ checksum, expectedDataVersion, seasonIdentity }));
  const uuidBytes = bytes.slice(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(uuidBytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildSeasonalImportCommittedRefreshFailure(
  result: RemoteSeasonalImportResult,
  cause: unknown,
): SeasonalImportCommittedRefreshFailure {
  const causeMessage = cause instanceof Error && cause.message
    ? cause.message
    : typeof cause === 'string' && cause.trim()
      ? cause
      : 'The authoritative server window could not be loaded.';
  return {
    title: 'Import committed, refresh failed',
    message:
      `Import committed, refresh failed. Season ID: ${result.seasonId}. Batch ID: ${result.batchId}. ` +
      `${causeMessage} Use Refresh to load the committed schedule.`,
  };
}
