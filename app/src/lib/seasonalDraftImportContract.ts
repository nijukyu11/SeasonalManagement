import {
  buildSeasonalImportV2Checksum,
  canonicalizeSeasonalImportSourceRows,
} from './seasonalImportRpcContract.ts';
import type { ParsedRow } from './types.ts';
import { getSynchronousOperatorUserId } from './seasonalRestoreJournal.ts';

export class SeasonalDraftImportStorageError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SeasonalDraftImportStorageError';
    this.cause = cause;
  }
}

export const SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_PREFIX = 'planning:seasonalDraftImportRecoveryReceipt:v4';
export const SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_KEY = 'planning:seasonalDraftImportRecoveryReceipt:v4';
export const LEGACY_SEASONAL_IMPORT_V3_STORAGE_KEY = 'settings:seasonalImportRecoveryReceipt:v3';
export const LEGACY_SEASONAL_IMPORT_V1_STORAGE_KEY = 'settings:seasonRepairRecoveryReceipt:v1';

export function getSeasonalDraftImportRecoveryStorageKey(operatorId: string): string {
  const op = operatorId.trim();
  if (!op) {
    throw new SeasonalDraftImportStorageError('An authorized operator session is required for seasonal draft import storage key.');
  }
  return `${SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_PREFIX}:${op}`;
}

function getSafeStorage(storageInput?: Storage | null): Storage | null {
  if (storageInput) return storageInput;
  if (typeof window !== 'undefined') {
    try {
      return window.localStorage ?? null;
    } catch {
      return null;
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveSeasonalDraftImportOperator(
  scopeOwner?: string | null,
  receiptOwner?: string | null,
): string | null {
  if (typeof window !== 'undefined') {
    const current = getSynchronousOperatorUserId();
    if (!current || !current.trim()) {
      return null;
    }
    const currentTrimmed = current.trim();
    if (scopeOwner && scopeOwner.trim() && scopeOwner.trim() !== currentTrimmed) {
      return null;
    }
    if (receiptOwner && receiptOwner.trim() && receiptOwner.trim() !== currentTrimmed) {
      return null;
    }
    return currentTrimmed;
  }
  if (scopeOwner && scopeOwner.trim()) return scopeOwner.trim();
  if (receiptOwner && receiptOwner.trim()) return receiptOwner.trim();
  const synchronous = getSynchronousOperatorUserId();
  if (synchronous && synchronous.trim()) return synchronous.trim();
  return null;
}
export interface SeasonalDraftImportCounts {
  sourceRowCount: number;
  generatedOccurrenceCount: number;
  insertCount: number;
  baselineUpdateCount: number;
  unchangedCount: number;
  removeImportedCount: number;
  supersedeManualCount?: number;
  unlinkCount?: number;
  preservedOutsideScopeCount: number;
}

export interface SeasonalDraftImportDiagnostic {
  code: string;
  message: string;
  sourceRowIndexes?: number[];
  occurrenceKey?: string | null;
}

export interface SeasonalDraftImportWarning {
  code: string;
  message: string;
  sourceRowIndexes: number[];
  occurrenceKey: string | null;
  affectedDateCount: number;
  sampleDates: string[];
}

export interface SeasonalDraftImportStageInput {
  requestId: string;
  checksum: string;
  seasonId: string | null;
  seasonCode: string;
  expectedEpoch: string | null;
  expectedRevision: string | null;
  fileName: string;
  sourceRows: ParsedRow[];
}

export interface SeasonalDraftImportResponse {
  contractVersion: number;
  batchId: string;
  requestId: string;
  seasonId: string;
  status: 'validated' | 'failed' | 'committed' | 'cancelled' | 'expired';
  previewHash: string;
  preview?: {
    importGuardVersion?: number;
    valid: boolean;
    strategy?: string;
    seasonId: string;
    seasonCode?: string;
    draftEpoch: string | null;
    draftRevision: string;
    draftChecksum?: string;
    manifestChecksum?: string;
    counts: SeasonalDraftImportCounts;
    diagnostics: SeasonalDraftImportDiagnostic[];
    warnings: SeasonalDraftImportWarning[];
    diagnosticCount: number;
    diagnosticsTruncated: boolean;
  };
  counts?: SeasonalDraftImportCounts;
  diagnostics?: SeasonalDraftImportDiagnostic[];
  warnings?: SeasonalDraftImportWarning[];
  expiresAt?: string;
  result?: {
    status: 'committed';
    batchId: string;
    seasonId: string;
    draftEpoch: string;
    draftRevision: string;
    counts?: SeasonalDraftImportCounts;
    serverHighWater?: string;
  } | null;
}

export interface SeasonalDraftImportPreviewResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  status: 'validated' | 'failed' | 'committed' | 'cancelled' | 'expired';
  valid: boolean;
  previewHash: string;
  expectedEpoch: string | null;
  expectedRevision: string | null;
  counts: SeasonalDraftImportCounts;
  diagnosticCount: number;
  diagnosticsTruncated: boolean;
  diagnostics: SeasonalDraftImportDiagnostic[];
  warningCount: number;
  warningsTruncated: boolean;
  warnings: SeasonalDraftImportWarning[];
  expiresAt: string;
}

export interface SeasonalDraftImportCommittedResult {
  batchId: string;
  requestId: string;
  seasonId: string;
  seasonCode: string;
  draftEpoch: string;
  draftRevision: string;
  counts: SeasonalDraftImportCounts;
  serverHighWater?: string;
}

export interface SeasonalDraftImportEntry {
  batch_id: string;
  draft_id: string;
  operation: 'upsert' | 'delete' | 'unlink';
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface SeasonalDraftImportPreviewPage {
  entries: SeasonalDraftImportEntry[];
  hasMore: boolean;
  nextDraftId: string | null;
  stale: boolean;
}

export interface SeasonalDraftImportRecoveryReceipt {
  contractVersion: 4;
  pipeline: 'seasonal_draft_v1';
  ownerUserId: string;
  requestId: string;
  batchId: string;
  seasonId: string;
  seasonCode: string;
  expectedEpoch: string | null;
  expectedRevision: string | null;
  previewHash: string;
  status: 'validated' | 'failed' | 'committed' | 'cancelled' | 'expired';
  counts: SeasonalDraftImportCounts;
  loadedCount: number | null;
  committedResult: SeasonalDraftImportCommittedResult | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime.');
  }
  const encoded = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveSeasonalDraftImportRequestId(input: {
  seasonId?: string | null;
  seasonCode: string;
  expectedEpoch?: string | null;
  expectedRevision?: string | null;
  checksum: string;
  uploadedAt: number;
}): Promise<string> {
  const seasonIdentity = input.seasonId || input.seasonCode.trim().toUpperCase();
  const checksum = input.checksum.trim().toLowerCase();
  const bytes = await sha256Bytes(stableJson({
    contractVersion: 4,
    seasonIdentity,
    expectedEpoch: input.expectedEpoch ?? null,
    expectedRevision: input.expectedRevision ?? '0',
    checksum,
    uploadedAt: input.uploadedAt,
  }));
  const uuidBytes = bytes.slice(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(uuidBytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function prepareSeasonalDraftImportStageInput(input: {
  seasonId: string | null;
  seasonCode: string;
  expectedEpoch: string | null;
  expectedRevision: string | null;
  fileName: string;
  uploadedAt: number;
  sourceRows: readonly unknown[];
}): Promise<SeasonalDraftImportStageInput> {
  const sourceRows = canonicalizeSeasonalImportSourceRows(input.sourceRows);
  const seasonCode = input.seasonCode.trim().toUpperCase();
  if (!seasonCode) throw new Error('seasonCode must be a non-empty string.');
  const checksum = await buildSeasonalImportV2Checksum(seasonCode, sourceRows);
  const requestId = await deriveSeasonalDraftImportRequestId({
    seasonId: input.seasonId,
    seasonCode,
    expectedEpoch: input.expectedEpoch,
    expectedRevision: input.expectedRevision,
    checksum,
    uploadedAt: input.uploadedAt,
  });
  return {
    requestId,
    checksum,
    seasonId: input.seasonId,
    seasonCode,
    expectedEpoch: input.expectedEpoch,
    expectedRevision: input.expectedRevision,
    fileName: input.fileName,
    sourceRows: sourceRows as unknown as ParsedRow[],
  };
}

export function draftImportResponseToPreview(
  response: SeasonalDraftImportResponse,
  fallback: {
    requestId: string;
    seasonId: string | null;
    seasonCode: string;
    expectedEpoch: string | null;
    expectedRevision: string | null;
    sourceRowCount?: number;
  },
): SeasonalDraftImportPreviewResult {
  const counts: SeasonalDraftImportCounts = {
    sourceRowCount: fallback.sourceRowCount ?? 0,
    generatedOccurrenceCount: 0,
    insertCount: 0,
    baselineUpdateCount: 0,
    unchangedCount: 0,
    removeImportedCount: 0,
    preservedOutsideScopeCount: 0,
    ...(response.counts || response.preview?.counts || {}),
  };
  const rawDiagnostics = response.diagnostics || response.preview?.diagnostics || [];
  const diagnostics: SeasonalDraftImportDiagnostic[] = rawDiagnostics.map((item) => {
    const entry = item;
    return {
      code: typeof entry.code === 'string' ? entry.code : 'unknown',
      message: typeof entry.message === 'string' ? entry.message : '',
      sourceRowIndexes: Array.isArray(entry.sourceRowIndexes)
        ? entry.sourceRowIndexes.filter((idx): idx is number => typeof idx === 'number')
        : undefined,
      occurrenceKey: typeof entry.occurrenceKey === 'string' ? entry.occurrenceKey : null,
    };
  });
  const rawWarnings = response.warnings || response.preview?.warnings || [];
  const warnings: SeasonalDraftImportWarning[] = rawWarnings.map((item) => {
    const entry = item;
    return {
      code: typeof entry.code === 'string' ? entry.code : 'warning',
      message: typeof entry.message === 'string' ? entry.message : '',
      sourceRowIndexes: Array.isArray(entry.sourceRowIndexes)
        ? entry.sourceRowIndexes.filter((idx): idx is number => typeof idx === 'number')
        : [],
      occurrenceKey: typeof entry.occurrenceKey === 'string' ? entry.occurrenceKey : null,
      affectedDateCount: typeof entry.affectedDateCount === 'number' ? entry.affectedDateCount : 0,
      sampleDates: Array.isArray(entry.sampleDates)
        ? entry.sampleDates.filter((date): date is string => typeof date === 'string')
        : [],
    };
  });
  const status = (response.status || 'validated') as SeasonalDraftImportPreviewResult['status'];
  return {
    batchId: response.batchId,
    requestId: response.requestId || fallback.requestId,
    seasonId: response.seasonId,
    seasonCode: response.preview?.seasonCode || fallback.seasonCode,
    status,
    valid: Boolean(response.preview?.valid ?? (status === 'validated' && diagnostics.length === 0)),
    previewHash: response.previewHash,
    expectedEpoch: response.preview?.draftEpoch ?? fallback.expectedEpoch,
    expectedRevision: response.preview?.draftRevision ?? fallback.expectedRevision,
    counts,
    diagnosticCount: response.preview?.diagnosticCount ?? diagnostics.length,
    diagnosticsTruncated: Boolean(response.preview?.diagnosticsTruncated),
    diagnostics,
    warningCount: warnings.length,
    warningsTruncated: false,
    warnings,
    expiresAt: response.expiresAt || new Date(Date.now() + 7200000).toISOString(),
  };
}

export function buildSeasonalDraftImportRecoveryReceipt(
  preview: SeasonalDraftImportPreviewResult,
  ownerUserId = '',
): SeasonalDraftImportRecoveryReceipt {
  const resolvedOwner = ownerUserId.trim() || getSynchronousOperatorUserId() || '';
  return {
    contractVersion: 4,
    pipeline: 'seasonal_draft_v1',
    ownerUserId: resolvedOwner,
    requestId: preview.requestId,
    batchId: preview.batchId,
    seasonId: preview.seasonId,
    seasonCode: preview.seasonCode,
    expectedEpoch: preview.expectedEpoch,
    expectedRevision: preview.expectedRevision,
    previewHash: preview.previewHash,
    status: preview.status,
    counts: preview.counts,
    loadedCount: preview.counts.sourceRowCount,
    committedResult: null,
  };
}

export function markSeasonalDraftImportRecoveryCommitted(
  receipt: SeasonalDraftImportRecoveryReceipt,
  committed: SeasonalDraftImportCommittedResult,
): SeasonalDraftImportRecoveryReceipt {
  if (
    receipt.requestId !== committed.requestId
    || receipt.batchId !== committed.batchId
    || receipt.seasonId !== committed.seasonId
    || receipt.seasonCode !== committed.seasonCode
  ) {
    throw new Error('Committed result does not match the stored draft import recovery receipt.');
  }
  return {
    ...receipt,
    status: 'committed',
    committedResult: committed,
  };
}

export function committedSeasonalDraftImportFromRecoveryReceipt(
  receipt: SeasonalDraftImportRecoveryReceipt,
): SeasonalDraftImportCommittedResult {
  if (receipt.status !== 'committed' || !receipt.committedResult) {
    throw new Error('Seasonal draft import recovery receipt is not a complete committed receipt.');
  }
  return receipt.committedResult;
}

const NATIVE_RECEIPT_FIELDS = [
  'contractVersion',
  'pipeline',
  'ownerUserId',
  'requestId',
  'batchId',
  'seasonId',
  'seasonCode',
  'expectedEpoch',
  'expectedRevision',
  'previewHash',
  'status',
  'counts',
  'loadedCount',
  'committedResult',
] as const;

export function isSeasonalDraftImportRecoveryReceipt(
  value: unknown,
): value is SeasonalDraftImportRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (
    keys.length !== NATIVE_RECEIPT_FIELDS.length
    || keys.some((key) => !NATIVE_RECEIPT_FIELDS.includes(key as never))
  ) {
    return false;
  }
  return (
    receipt.contractVersion === 4
    && receipt.pipeline === 'seasonal_draft_v1'
    && typeof receipt.ownerUserId === 'string'
    && receipt.ownerUserId.trim().length > 0
    && typeof receipt.requestId === 'string'
    && typeof receipt.batchId === 'string'
    && typeof receipt.seasonId === 'string'
    && typeof receipt.seasonCode === 'string'
    && typeof receipt.previewHash === 'string'
    && ['validated', 'failed', 'committed', 'cancelled', 'expired'].includes(
      receipt.status as string,
    )
    && typeof receipt.counts === 'object'
    && receipt.counts !== null
  );
}

export function persistSeasonalDraftImportRecoveryReceipt(
  storageInput: Storage | { setItem(key: string, value: string): void } | null | undefined,
  receipt: SeasonalDraftImportRecoveryReceipt,
  scope?: { ownerUserId?: string | null },
): void {
  if (!isSeasonalDraftImportRecoveryReceipt(receipt)) {
    throw new SeasonalDraftImportStorageError('Seasonal draft import recovery receipt is malformed.');
  }
  const ownerUserId = resolveSeasonalDraftImportOperator(scope?.ownerUserId, receipt.ownerUserId);
  if (!ownerUserId) {
    throw new SeasonalDraftImportStorageError('An authenticated operator is required to persist seasonal draft import recovery receipt.');
  }
  if (receipt.ownerUserId.trim() !== ownerUserId) {
    throw new SeasonalDraftImportStorageError('Receipt owner does not match the active authenticated operator.');
  }
  const storage = getSafeStorage(storageInput as Storage | null);
  if (!storage) {
    throw new SeasonalDraftImportStorageError('Storage is unavailable. Cannot persist seasonal draft import recovery receipt.');
  }
  const key = getSeasonalDraftImportRecoveryStorageKey(ownerUserId);
  try {
    storage.setItem(key, JSON.stringify(receipt));
  } catch (err) {
    throw new SeasonalDraftImportStorageError('Failed to persist seasonal draft import recovery receipt.', err);
  }
}

export function clearSeasonalDraftImportRecoveryReceipt(
  storageInput?: Storage | { removeItem(key: string): void } | null,
  scope: { ownerUserId?: string | null } = {},
): boolean {
  const ownerUserId = resolveSeasonalDraftImportOperator(scope.ownerUserId);
  if (!ownerUserId) return false;

  const storage = getSafeStorage(storageInput as Storage | null);
  if (!storage) return false;
  const key = getSeasonalDraftImportRecoveryStorageKey(ownerUserId);
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function loadSeasonalDraftImportRecoveryReceipt(
  storageInput?: Storage | { getItem(key: string): string | null; removeItem?(key: string): void } | null,
  scope: { expectedSeasonId?: string | null; ownerUserId?: string | null } = {},
): SeasonalDraftImportRecoveryReceipt | null {
  const ownerUserId = resolveSeasonalDraftImportOperator(scope.ownerUserId);
  if (!ownerUserId) {
    return null;
  }

  const storage = getSafeStorage(storageInput as Storage | null);
  if (!storage) return null;

  const key = getSeasonalDraftImportRecoveryStorageKey(ownerUserId);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const receipt = JSON.parse(raw) as unknown;
    if (!isSeasonalDraftImportRecoveryReceipt(receipt)) {
      if (typeof (storage as Storage).removeItem === 'function') {
        try {
          (storage as Storage).removeItem(key);
        } catch {
          // ignore
        }
      }
      return null;
    }
    // Strict ownership verification: cannot hydrate another operator's journal, never delete another operator's key
    if (receipt.ownerUserId !== ownerUserId) {
      return null;
    }
    // Scope season check: if expectedSeasonId provided and doesn't match, return null without deleting
    if (scope.expectedSeasonId && receipt.seasonId !== scope.expectedSeasonId) {
      return null;
    }
    return receipt;
  } catch {
    if (typeof (storage as Storage).removeItem === 'function') {
      try {
        (storage as Storage).removeItem(key);
      } catch {
        // ignore
      }
    }
    return null;
  }
}

export function hasLegacySeasonalImportPendingReceipt(
  storage: { getItem(key: string): string | null },
): boolean {
  try {
    return Boolean(
      storage.getItem(LEGACY_SEASONAL_IMPORT_V3_STORAGE_KEY)
      || storage.getItem(LEGACY_SEASONAL_IMPORT_V1_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

export function clearLegacySeasonalImportReceipts(
  storage: { removeItem(key: string): void },
): void {
  try {
    storage.removeItem(LEGACY_SEASONAL_IMPORT_V3_STORAGE_KEY);
    storage.removeItem(LEGACY_SEASONAL_IMPORT_V1_STORAGE_KEY);
  } catch {
    // Ignore storage deletion errors
  }
}
