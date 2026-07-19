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

export interface CanonicalSeasonalSourceRow {
  rowIndex: number;
  effective: string;
  discontinue: string;
  airline: string;
  aircraft: string;
  daysOfWeek: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  sta: string | null;
  arrFlight: string | null;
  arrFlightType: string | null;
  arrRoute: string | null;
  arrFlightCategory: string | null;
  arrCodeShares: string | null;
  arrIntDomInd: string | null;
  std: string | null;
  depFlight: string | null;
  depFlightType: string | null;
  depRoute: string | null;
  depFlightCategory: string | null;
  depCodeShares: string | null;
  depIntDomInd: string | null;
  overnightLinkRowIndex: number | null;
  linkType: 'overnight' | 'sameday' | null;
}

export interface SeasonalImportV2RpcAttempt {
  requestId: string;
  checksum: string;
  seasonId?: string | null;
  seasonCode: string;
  expectedDataVersion: number;
  fileName: string;
  uploadedAt: number;
  sourceRows: CanonicalSeasonalSourceRow[];
}

export interface SeasonalImportV2CommittedResult {
  batchId: string;
  seasonId: string;
  seasonCode: string;
  status: 'committed';
  sourceRowCount: number;
  flightRecordCount: number;
  preservedOperationalCount: number;
  removedImportedCount: number;
  dataVersion: number;
  serverHighWater: number;
  checksum: string;
}

export interface SeasonalImportV2StageResult {
  batchId: string;
  status: 'validated' | 'committed';
  sourceRowCount: number;
  generatedRecordCount: number;
  diagnostics: [];
  valid: true;
}

export interface SeasonalImportV2RpcTransport {
  stage(payload: SeasonalImportV2RpcAttempt): Promise<unknown>;
  commit(batchId: string, expectedDataVersion: number): Promise<unknown>;
}

export interface SeasonalImportCommittedRefreshFailure {
  title: 'Import committed, refresh failed';
  message: string;
}

export class SeasonalImportV2StageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonalImportV2StageRejectedError';
  }
}

export class SeasonalImportV2StatusUnknownError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SeasonalImportV2StatusUnknownError';
    this.cause = cause;
  }
}

export class SeasonalImportV2RpcRejectedError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SeasonalImportV2RpcRejectedError';
    this.cause = cause;
  }
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

export function parseSeasonalImportV2Result(value: unknown): SeasonalImportV2CommittedResult {
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
    throw new SeasonalImportV2StageRejectedError(
      `Seasonal import stage diagnostics: ${diagnosticMessage(record.diagnostics)}`,
    );
  }
  if (status !== 'validated' && status !== 'committed') {
    throw new Error('Seasonal import stage response.status must be validated or committed.');
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
  const normalized = seasonCode.trim().normalize('NFC').toUpperCase();
  if (!normalized) throw new Error('seasonCode must be a non-empty string.');
  return normalized;
}

function requireCanonicalString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Canonical seasonal source row.${field} must be a non-empty string.`);
  }
  return value.normalize('NFC');
}

function optionalCanonicalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Canonical seasonal source row.${field} must be a string, null, or absent.`);
  }
  return value.normalize('NFC');
}

function canonicalizeSourceRow(value: unknown, sourceIndex: number): CanonicalSeasonalSourceRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Canonical seasonal source row ${sourceIndex} must be an object.`);
  }
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.rowIndex) || (row.rowIndex as number) < 0) {
    throw new Error(`Canonical seasonal source row ${sourceIndex}.rowIndex must be a safe non-negative integer.`);
  }
  if (
    !Array.isArray(row.daysOfWeek)
    || row.daysOfWeek.length !== 7
    || row.daysOfWeek.some((day) => typeof day !== 'boolean')
  ) {
    throw new Error(`Canonical seasonal source row ${sourceIndex}.daysOfWeek must contain exactly seven booleans.`);
  }
  const overnightLinkRowIndex = row.overnightLinkRowIndex;
  if (
    overnightLinkRowIndex !== undefined
    && overnightLinkRowIndex !== null
    && (!Number.isSafeInteger(overnightLinkRowIndex) || (overnightLinkRowIndex as number) < 0)
  ) {
    throw new Error(
      `Canonical seasonal source row ${sourceIndex}.overnightLinkRowIndex must be a safe non-negative integer, null, or absent.`,
    );
  }
  const rawLinkType = row.linkType;
  const linkType = rawLinkType === undefined || rawLinkType === null
    ? null
    : typeof rawLinkType === 'string'
      ? rawLinkType.normalize('NFC')
      : rawLinkType;
  if (linkType !== null && linkType !== 'overnight' && linkType !== 'sameday') {
    throw new Error(
      `Canonical seasonal source row ${sourceIndex}.linkType must be overnight, sameday, null, or absent.`,
    );
  }

  return {
    rowIndex: row.rowIndex as number,
    effective: requireCanonicalString(row, 'effective'),
    discontinue: requireCanonicalString(row, 'discontinue'),
    airline: requireCanonicalString(row, 'airline'),
    aircraft: requireCanonicalString(row, 'aircraft'),
    daysOfWeek: [...row.daysOfWeek] as CanonicalSeasonalSourceRow['daysOfWeek'],
    sta: optionalCanonicalString(row, 'sta'),
    arrFlight: optionalCanonicalString(row, 'arrFlight'),
    arrFlightType: optionalCanonicalString(row, 'arrFlightType'),
    arrRoute: optionalCanonicalString(row, 'arrRoute'),
    arrFlightCategory: optionalCanonicalString(row, 'arrFlightCategory'),
    arrCodeShares: optionalCanonicalString(row, 'arrCodeShares'),
    arrIntDomInd: optionalCanonicalString(row, 'arrIntDomInd'),
    std: optionalCanonicalString(row, 'std'),
    depFlight: optionalCanonicalString(row, 'depFlight'),
    depFlightType: optionalCanonicalString(row, 'depFlightType'),
    depRoute: optionalCanonicalString(row, 'depRoute'),
    depFlightCategory: optionalCanonicalString(row, 'depFlightCategory'),
    depCodeShares: optionalCanonicalString(row, 'depCodeShares'),
    depIntDomInd: optionalCanonicalString(row, 'depIntDomInd'),
    overnightLinkRowIndex: overnightLinkRowIndex == null ? null : overnightLinkRowIndex as number,
    linkType,
  };
}

export function canonicalizeSeasonalImportSourceRows(
  sourceRows: readonly unknown[],
): CanonicalSeasonalSourceRow[] {
  return sourceRows.map((row, index) => canonicalizeSourceRow(row, index));
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
  sourceRows: readonly CanonicalSeasonalSourceRow[],
): Promise<string> {
  const canonicalPayload = stableJson({
    seasonCode: normalizeSeasonCode(seasonCode),
    sourceRows,
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
  if (!normalizedSeasonId) {
    if (expectedDataVersion === null || expectedDataVersion === 0) return 0;
    throw new Error('A new seasonal import must use expectedDataVersion zero.');
  }
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

function statusUnknown(stage: 'stage' | 'commit' | 'response', cause: unknown): SeasonalImportV2StatusUnknownError {
  const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : '';
  return new SeasonalImportV2StatusUnknownError(
    `Seasonal import ${stage} status is unknown.${detail}`,
    cause,
  );
}

export async function runSeasonalImportV2RpcFlow(
  attempt: SeasonalImportV2RpcAttempt,
  transport: SeasonalImportV2RpcTransport,
): Promise<SeasonalImportV2CommittedResult> {
  let stagePayload: unknown;
  try {
    stagePayload = await transport.stage(attempt);
  } catch (error) {
    if (error instanceof SeasonalImportV2RpcRejectedError) throw error;
    throw statusUnknown('stage', error);
  }

  let staged: SeasonalImportV2StageResult;
  try {
    staged = parseSeasonalImportV2StageResult(stagePayload);
  } catch (error) {
    if (error instanceof SeasonalImportV2StageRejectedError) throw error;
    throw statusUnknown('response', error);
  }

  let commitPayload: unknown;
  try {
    commitPayload = await transport.commit(staged.batchId, attempt.expectedDataVersion);
  } catch (error) {
    if (error instanceof SeasonalImportV2RpcRejectedError) throw error;
    throw statusUnknown('commit', error);
  }

  try {
    const committed = parseSeasonalImportV2Result(commitPayload);
    if (committed.batchId !== staged.batchId) {
      throw new Error('Seasonal import commit response.batchId does not match the staged batch.');
    }
    if (committed.checksum !== attempt.checksum) {
      throw new Error('Seasonal import commit response.checksum does not match the request checksum.');
    }
    if (committed.seasonCode !== normalizeSeasonCode(attempt.seasonCode)) {
      throw new Error('Seasonal import commit response.seasonCode does not match the request seasonCode.');
    }
    if (attempt.seasonId && committed.seasonId !== attempt.seasonId) {
      throw new Error('Seasonal import commit response.seasonId does not match the requested seasonId.');
    }
    return committed;
  } catch (error) {
    throw statusUnknown('response', error);
  }
}

export function buildSeasonalImportCommittedRefreshFailure(
  result: SeasonalImportV2CommittedResult,
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
