import type { CanonicalSeasonalSourceRow } from './seasonalImportRpcContract.ts';

export type SeasonalImportV3Strategy = 'merge' | 'replace';

export type SeasonalImportV3BatchStatus =
  | 'validated'
  | 'failed'
  | 'committed'
  | 'cancelled'
  | 'expired';

export interface SeasonalImportV3Attempt {
  contractVersion: 3;
  requestId: string;
  checksum: string;
  strategy: SeasonalImportV3Strategy;
  seasonId: string | null;
  seasonCode: string;
  expectedDataVersion: number;
  fileName: string;
  uploadedAt: number;
  sourceRows: CanonicalSeasonalSourceRow[];
}

export interface SeasonalImportV3PreviewCounts {
  sourceRowCount: number;
  generatedOccurrenceCount: number;
  insertCount: number;
  baselineUpdateCount: number;
  unchangedCount: number;
  preservedOutsideScopeCount: number;
  preservedOverlayCount: number;
  preservedDeletedOverlayCount: number;
  removeImportedCount: number;
  clearStructuralOverlayCount: number;
  clearDeletedOverlayCount: number;
  manualCollisionCount: number;
}

export interface SeasonalImportV3Diagnostic {
  code: string;
  message: string;
  sourceRowIndexes: number[];
  occurrenceKey: string | null;
  affectedDateCount: number;
  sampleDates: string[];
}

export interface SeasonalImportV3StageResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  strategy: SeasonalImportV3Strategy;
  status: Exclude<SeasonalImportV3BatchStatus, 'committed'>;
  valid: boolean;
  expectedDataVersion: number;
  previewHash: string;
  counts: SeasonalImportV3PreviewCounts;
  diagnosticCount: number;
  diagnosticsTruncated: boolean;
  diagnostics: SeasonalImportV3Diagnostic[];
  expiresAt: string;
}

export interface SeasonalImportV3CommittedResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  strategy: SeasonalImportV3Strategy;
  status: 'committed';
  previewHash: string;
  counts: SeasonalImportV3PreviewCounts;
  importedRecordCount: number;
  totalEffectiveRecordCount: number;
  dataVersion: number;
  serverHighWater: number;
  checksum: string;
}

const PREVIEW_COUNT_FIELDS = [
  'sourceRowCount',
  'generatedOccurrenceCount',
  'insertCount',
  'baselineUpdateCount',
  'unchangedCount',
  'preservedOutsideScopeCount',
  'preservedOverlayCount',
  'preservedDeletedOverlayCount',
  'removeImportedCount',
  'clearStructuralOverlayCount',
  'clearDeletedOverlayCount',
  'manualCollisionCount',
] as const satisfies readonly (keyof SeasonalImportV3PreviewCounts)[];

const DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'sourceRowIndexes',
  'occurrenceKey',
  'affectedDateCount',
  'sampleDates',
] as const;

const STAGE_RESULT_FIELDS = [
  'batchId',
  'requestId',
  'seasonId',
  'seasonCode',
  'strategy',
  'status',
  'valid',
  'expectedDataVersion',
  'previewHash',
  'counts',
  'diagnosticCount',
  'diagnosticsTruncated',
  'diagnostics',
  'expiresAt',
] as const;

const COMMITTED_RESULT_FIELDS = [
  'batchId',
  'requestId',
  'seasonId',
  'seasonCode',
  'strategy',
  'status',
  'previewHash',
  'counts',
  'importedRecordCount',
  'totalEffectiveRecordCount',
  'dataVersion',
  'serverHighWater',
  'checksum',
] as const;

const CANCEL_RESULT_FIELDS = ['batchId', 'status'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string.`);
  }
  return value;
}

function requireUuid(record: Record<string, unknown>, field: string, label: string): string {
  const value = requireString(record, field, label);
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label}.${field} must be a UUID.`);
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

function requireBoolean(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new Error(`${label}.${field} must be a boolean.`);
  }
  return value;
}

function parseStrategy(value: unknown, label: string): SeasonalImportV3Strategy {
  if (value !== 'merge' && value !== 'replace') {
    throw new Error(`${label}.strategy must be merge or replace.`);
  }
  return value;
}

function parsePreviewCounts(
  value: unknown,
  strategy: SeasonalImportV3Strategy,
): SeasonalImportV3PreviewCounts {
  const label = 'Seasonal import V3 response.counts';
  const record = requireExactRecord(value, PREVIEW_COUNT_FIELDS, label);
  const counts = Object.fromEntries(
    PREVIEW_COUNT_FIELDS.map((field) => [field, requireCount(record, field, label)]),
  ) as unknown as SeasonalImportV3PreviewCounts;

  if (
    counts.insertCount + counts.baselineUpdateCount + counts.unchangedCount
    !== counts.generatedOccurrenceCount
  ) {
    throw new Error(
      `${label}.generatedOccurrenceCount must equal insertCount + baselineUpdateCount + unchangedCount.`,
    );
  }
  if (strategy === 'merge') {
    for (const field of [
      'removeImportedCount',
      'clearStructuralOverlayCount',
      'clearDeletedOverlayCount',
    ] as const) {
      if (counts[field] !== 0) {
        throw new Error(`${label}.${field} must be zero for merge strategy.`);
      }
    }
  }
  return counts;
}

function parseDiagnostic(value: unknown, index: number): SeasonalImportV3Diagnostic {
  const label = `Seasonal import V3 response.diagnostics[${index}]`;
  const record = requireExactRecord(value, DIAGNOSTIC_FIELDS, label);
  const sourceRowIndexes = record.sourceRowIndexes;
  if (
    !Array.isArray(sourceRowIndexes)
    || sourceRowIndexes.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
  ) {
    throw new Error(`${label}.sourceRowIndexes must contain non-negative safe integers.`);
  }
  const occurrenceKey = record.occurrenceKey;
  if (
    occurrenceKey !== null
    && (typeof occurrenceKey !== 'string' || occurrenceKey.trim().length === 0)
  ) {
    throw new Error(`${label}.occurrenceKey must be null or a non-empty string.`);
  }
  const sampleDates = record.sampleDates;
  if (
    !Array.isArray(sampleDates)
    || sampleDates.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error(`${label}.sampleDates must contain non-empty strings.`);
  }
  const affectedDateCount = requireCount(record, 'affectedDateCount', label);
  if (sampleDates.length > affectedDateCount) {
    throw new Error(`${label}.sampleDates cannot exceed affectedDateCount.`);
  }
  return {
    code: requireString(record, 'code', label),
    message: requireString(record, 'message', label),
    sourceRowIndexes: [...sourceRowIndexes] as number[],
    occurrenceKey,
    affectedDateCount,
    sampleDates: [...sampleDates] as string[],
  };
}

function parseStageStatus(value: unknown): SeasonalImportV3StageResult['status'] {
  if (value === 'validated' || value === 'failed' || value === 'cancelled' || value === 'expired') {
    return value;
  }
  throw new Error(
    'Seasonal import V3 stage response.status must be validated, failed, cancelled, or expired.',
  );
}

function assertPreviewValidity(
  result: Pick<
    SeasonalImportV3StageResult,
    'valid' | 'counts' | 'diagnosticCount' | 'diagnosticsTruncated' | 'diagnostics'
  >,
): void {
  if (result.counts.manualCollisionCount > 0 && result.valid) {
    throw new Error(
      'Seasonal import V3 stage response.valid must be false when manualCollisionCount is positive.',
    );
  }
  if (result.diagnosticCount > 0 && result.valid) {
    throw new Error(
      'Seasonal import V3 stage response.valid must be false when diagnosticCount is positive.',
    );
  }
  if (result.diagnostics.length > result.diagnosticCount) {
    throw new Error(
      'Seasonal import V3 stage response.diagnosticCount cannot be smaller than diagnostics.length.',
    );
  }
  if (!result.diagnosticsTruncated && result.diagnostics.length !== result.diagnosticCount) {
    throw new Error(
      'Seasonal import V3 stage response.diagnosticCount must equal diagnostics.length when diagnostics are not truncated.',
    );
  }
}

export function parseSeasonalImportV3StageResult(value: unknown): SeasonalImportV3StageResult {
  const label = 'Seasonal import V3 stage response';
  const record = requireExactRecord(value, STAGE_RESULT_FIELDS, label);
  const strategy = parseStrategy(record.strategy, label);
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics.map(parseDiagnostic)
    : (() => {
        throw new Error(`${label}.diagnostics must be an array.`);
      })();
  const expiresAt = requireString(record, 'expiresAt', label);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`${label}.expiresAt must be an ISO date-time string.`);
  }
  const result: SeasonalImportV3StageResult = {
    batchId: requireUuid(record, 'batchId', label),
    requestId: requireUuid(record, 'requestId', label),
    seasonId: requireString(record, 'seasonId', label),
    seasonCode: requireString(record, 'seasonCode', label),
    strategy,
    status: parseStageStatus(record.status),
    valid: requireBoolean(record, 'valid', label),
    expectedDataVersion: requireCount(record, 'expectedDataVersion', label),
    previewHash: requireString(record, 'previewHash', label),
    counts: parsePreviewCounts(record.counts, strategy),
    diagnosticCount: requireCount(record, 'diagnosticCount', label),
    diagnosticsTruncated: requireBoolean(record, 'diagnosticsTruncated', label),
    diagnostics,
    expiresAt,
  };
  assertPreviewValidity(result);
  return result;
}

export function parseSeasonalImportV3CommittedResult(
  value: unknown,
): SeasonalImportV3CommittedResult {
  const label = 'Seasonal import V3 commit response';
  const record = requireExactRecord(value, COMMITTED_RESULT_FIELDS, label);
  if (record.status !== 'committed') {
    throw new Error(`${label}.status must be committed.`);
  }
  const strategy = parseStrategy(record.strategy, label);
  return {
    batchId: requireUuid(record, 'batchId', label),
    requestId: requireUuid(record, 'requestId', label),
    seasonId: requireString(record, 'seasonId', label),
    seasonCode: requireString(record, 'seasonCode', label),
    strategy,
    status: 'committed',
    previewHash: requireString(record, 'previewHash', label),
    counts: parsePreviewCounts(record.counts, strategy),
    importedRecordCount: requireCount(record, 'importedRecordCount', label),
    totalEffectiveRecordCount: requireCount(record, 'totalEffectiveRecordCount', label),
    dataVersion: requireCount(record, 'dataVersion', label),
    serverHighWater: requireCount(record, 'serverHighWater', label),
    checksum: requireString(record, 'checksum', label),
  };
}

export function parseSeasonalImportV3StatusResult(
  value: unknown,
): SeasonalImportV3StageResult | SeasonalImportV3CommittedResult {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).status === 'committed'
  ) {
    return parseSeasonalImportV3CommittedResult(value);
  }
  return parseSeasonalImportV3StageResult(value);
}

export function parseSeasonalImportV3CancelResult(
  value: unknown,
): { batchId: string; status: 'cancelled' } {
  const label = 'Seasonal import V3 cancel response';
  const record = requireExactRecord(value, CANCEL_RESULT_FIELDS, label);
  if (record.status !== 'cancelled') {
    throw new Error(`${label}.status must be cancelled.`);
  }
  return {
    batchId: requireUuid(record, 'batchId', label),
    status: 'cancelled',
  };
}

function normalizeSeasonCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized) throw new Error('seasonCode must be a non-empty string.');
  return normalized;
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Request identity contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Request identity contains unsupported ${typeof value} value.`);
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

export async function deriveSeasonalImportV3RequestId(input: {
  seasonId: string | null;
  seasonCode: string;
  expectedDataVersion: number;
  strategy: SeasonalImportV3Strategy;
  checksum: string;
}): Promise<string> {
  const seasonId = input.seasonId?.trim() ?? '';
  if (input.seasonId !== null && !seasonId) {
    throw new Error('seasonId must be a non-empty string when provided.');
  }
  if (
    !Number.isSafeInteger(input.expectedDataVersion)
    || input.expectedDataVersion < 0
    || (!seasonId && input.expectedDataVersion !== 0)
  ) {
    throw new Error(
      'expectedDataVersion must be a non-negative safe integer and zero for a new season.',
    );
  }
  const strategy = parseStrategy(input.strategy, 'Seasonal import V3 request');
  const checksum = input.checksum.trim().toLowerCase();
  if (!checksum) throw new Error('checksum must be a non-empty string.');
  const seasonIdentity = seasonId || normalizeSeasonCode(input.seasonCode);
  const bytes = await sha256Bytes(stableJson({
    contractVersion: 3,
    seasonIdentity,
    expectedDataVersion: input.expectedDataVersion,
    strategy,
    checksum,
  }));
  const uuidBytes = bytes.slice(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(uuidBytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
