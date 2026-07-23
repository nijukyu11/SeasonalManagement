import type {
  SeasonalImportV2Mode,
  SeasonalImportV2RpcAttempt,
  SeasonalImportV2CommittedResult,
} from './seasonalImportRpcContract.ts';
import {
  parseSeasonalImportV3CommittedResult,
  type SeasonalImportV3BatchStatus,
  type SeasonalImportV3CommittedResult,
  type SeasonalImportV3StageResult,
  type SeasonalImportV3Strategy,
} from './seasonalImportV3Contract.ts';

export const SEASONAL_IMPORT_RECOVERY_STORAGE_KEY = 'settings:seasonRepairRecoveryReceipt:v1';
export const SEASONAL_IMPORT_V3_RECOVERY_STORAGE_KEY = 'settings:seasonalImportRecoveryReceipt:v3';

export interface SeasonalImportRecoveryReceipt {
  version: 1;
  ownerUserId: string;
  requestId: string;
  batchId: string | null;
  seasonId: string | null;
  seasonCode: string;
  mode: SeasonalImportV2Mode;
  checksum: string;
  expectedDataVersion: number;
  sourceRowCount: number;
  status: 'pending' | 'committed';
  flightRecordCount: number | null;
  preservedOperationalCount: number | null;
  removedImportedCount: number | null;
  dataVersion: number | null;
  serverHighWater: number | null;
  savedAt: number;
}

export interface SeasonalImportV3RecoveryReceipt {
  contractVersion: 3;
  requestId: string;
  batchId: string;
  seasonId: string;
  seasonCode: string;
  strategy: SeasonalImportV3Strategy;
  expectedDataVersion: number;
  previewHash: string;
  status: SeasonalImportV3BatchStatus;
  committedResult: SeasonalImportV3CommittedResult | null;
}

interface SeasonalImportReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SeasonalImportRecoveryStorageError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Seasonal import recovery receipt could not be stored. Free browser storage before importing.');
    this.name = 'SeasonalImportRecoveryStorageError';
    this.cause = cause;
  }
}

export function buildSeasonalImportRecoveryReceipt(
  attempt: SeasonalImportV2RpcAttempt,
  ownerUserId: string,
): SeasonalImportRecoveryReceipt {
  const owner = ownerUserId.trim();
  if (!owner) throw new Error('A signed-in operator is required for Seasonal import recovery.');
  return {
    version: 1,
    ownerUserId: owner,
    requestId: attempt.requestId,
    batchId: null,
    seasonId: attempt.seasonId ?? null,
    seasonCode: attempt.seasonCode,
    mode: attempt.mode ?? 'standard',
    checksum: attempt.checksum,
    expectedDataVersion: attempt.expectedDataVersion,
    sourceRowCount: attempt.sourceRows.length,
    status: 'pending',
    flightRecordCount: null,
    preservedOperationalCount: null,
    removedImportedCount: null,
    dataVersion: null,
    serverHighWater: null,
    savedAt: Date.now(),
  };
}

export function markSeasonalImportRecoveryCommitted(
  receipt: SeasonalImportRecoveryReceipt,
  committed: SeasonalImportV2CommittedResult,
): SeasonalImportRecoveryReceipt {
  if (receipt.batchId && receipt.batchId !== committed.batchId) {
    throw new Error('Committed Seasonal import does not match the stored recovery batch.');
  }
  if (receipt.seasonCode !== committed.seasonCode || receipt.checksum !== committed.checksum) {
    throw new Error('Committed Seasonal import does not match the stored recovery receipt.');
  }
  if (receipt.seasonId && receipt.seasonId !== committed.seasonId) {
    throw new Error('Committed Seasonal import season does not match the stored recovery receipt.');
  }
  return {
    ...receipt,
    batchId: committed.batchId,
    seasonId: committed.seasonId,
    status: 'committed',
    flightRecordCount: committed.flightRecordCount,
    preservedOperationalCount: committed.preservedOperationalCount,
    removedImportedCount: committed.removedImportedCount,
    dataVersion: committed.dataVersion,
    serverHighWater: committed.serverHighWater,
    savedAt: Date.now(),
  };
}

export function committedSeasonalImportFromRecoveryReceipt(
  receipt: SeasonalImportRecoveryReceipt,
): SeasonalImportV2CommittedResult {
  if (
    receipt.status !== 'committed'
    || !receipt.batchId
    || !receipt.seasonId
    || receipt.flightRecordCount === null
    || receipt.preservedOperationalCount === null
    || receipt.removedImportedCount === null
    || receipt.dataVersion === null
    || receipt.serverHighWater === null
  ) {
    throw new Error('Seasonal import recovery receipt is not a complete committed receipt.');
  }
  return {
    batchId: receipt.batchId,
    seasonId: receipt.seasonId,
    seasonCode: receipt.seasonCode,
    status: 'committed',
    sourceRowCount: receipt.sourceRowCount,
    flightRecordCount: receipt.flightRecordCount,
    preservedOperationalCount: receipt.preservedOperationalCount,
    removedImportedCount: receipt.removedImportedCount,
    dataVersion: receipt.dataVersion,
    serverHighWater: receipt.serverHighWater,
    checksum: receipt.checksum,
  };
}

function isReceipt(value: unknown): value is SeasonalImportRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.version === 1
    && typeof receipt.ownerUserId === 'string'
    && typeof receipt.requestId === 'string'
    && (receipt.batchId === null || typeof receipt.batchId === 'string')
    && (receipt.seasonId === null || typeof receipt.seasonId === 'string')
    && typeof receipt.seasonCode === 'string'
    && (receipt.mode === 'standard' || receipt.mode === 'repair')
    && typeof receipt.checksum === 'string'
    && Number.isSafeInteger(receipt.expectedDataVersion)
    && Number.isSafeInteger(receipt.sourceRowCount)
    && (receipt.status === 'pending' || receipt.status === 'committed')
    && (receipt.flightRecordCount === null || Number.isSafeInteger(receipt.flightRecordCount))
    && (receipt.preservedOperationalCount === null || Number.isSafeInteger(receipt.preservedOperationalCount))
    && (receipt.removedImportedCount === null || Number.isSafeInteger(receipt.removedImportedCount))
    && (receipt.dataVersion === null || Number.isSafeInteger(receipt.dataVersion))
    && (receipt.serverHighWater === null || Number.isSafeInteger(receipt.serverHighWater))
    && Number.isSafeInteger(receipt.savedAt);
}

export function persistSeasonalImportRecoveryReceipt(
  storage: SeasonalImportReceiptStorage,
  receipt: SeasonalImportRecoveryReceipt,
): void {
  try {
    storage.setItem(SEASONAL_IMPORT_RECOVERY_STORAGE_KEY, JSON.stringify(receipt));
  } catch (error) {
    throw new SeasonalImportRecoveryStorageError(error);
  }
}

export function clearSeasonalImportRecoveryReceipt(storage: SeasonalImportReceiptStorage): boolean {
  try {
    storage.removeItem(SEASONAL_IMPORT_RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadSeasonalImportRecoveryReceipt(
  storage: SeasonalImportReceiptStorage,
  scope: { ownerUserId: string; expectedSeasonId?: string | null },
): SeasonalImportRecoveryReceipt | null {
  const raw = storage.getItem(SEASONAL_IMPORT_RECOVERY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw) as unknown;
    if (
      !isReceipt(receipt)
      || receipt.ownerUserId !== scope.ownerUserId
      || (scope.expectedSeasonId !== undefined && receipt.seasonId !== scope.expectedSeasonId)
    ) {
      clearSeasonalImportRecoveryReceipt(storage);
      return null;
    }
    return receipt;
  } catch {
    clearSeasonalImportRecoveryReceipt(storage);
    return null;
  }
}

export function buildSeasonalImportV3RecoveryReceipt(
  staged: SeasonalImportV3StageResult,
): SeasonalImportV3RecoveryReceipt {
  return {
    contractVersion: 3,
    requestId: staged.requestId,
    batchId: staged.batchId,
    seasonId: staged.seasonId,
    seasonCode: staged.seasonCode,
    strategy: staged.strategy,
    expectedDataVersion: staged.expectedDataVersion,
    previewHash: staged.previewHash,
    status: staged.status,
    committedResult: null,
  };
}

export function markSeasonalImportV3RecoveryCommitted(
  receipt: SeasonalImportV3RecoveryReceipt,
  committed: SeasonalImportV3CommittedResult,
): SeasonalImportV3RecoveryReceipt {
  if (
    receipt.requestId !== committed.requestId
    || receipt.batchId !== committed.batchId
    || receipt.seasonId !== committed.seasonId
    || receipt.seasonCode !== committed.seasonCode
    || receipt.strategy !== committed.strategy
    || receipt.previewHash !== committed.previewHash
  ) {
    throw new Error('Committed Seasonal import V3 result does not match the stored recovery receipt.');
  }
  return {
    ...receipt,
    status: 'committed',
    committedResult: committed,
  };
}

export function committedSeasonalImportV3FromRecoveryReceipt(
  receipt: SeasonalImportV3RecoveryReceipt,
): SeasonalImportV3CommittedResult {
  if (receipt.status !== 'committed' || receipt.committedResult === null) {
    throw new Error('Seasonal import V3 recovery receipt is not a complete committed receipt.');
  }
  const committed = parseSeasonalImportV3CommittedResult(receipt.committedResult);
  markSeasonalImportV3RecoveryCommitted(receipt, committed);
  return committed;
}

const V3_RECEIPT_FIELDS = [
  'contractVersion',
  'requestId',
  'batchId',
  'seasonId',
  'seasonCode',
  'strategy',
  'expectedDataVersion',
  'previewHash',
  'status',
  'committedResult',
] as const;

function isSeasonalImportV3RecoveryReceipt(
  value: unknown,
): value is SeasonalImportV3RecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (
    keys.length !== V3_RECEIPT_FIELDS.length
    || keys.some((key) => !V3_RECEIPT_FIELDS.includes(key as never))
  ) {
    return false;
  }
  if (
    receipt.contractVersion !== 3
    || typeof receipt.requestId !== 'string'
    || typeof receipt.batchId !== 'string'
    || typeof receipt.seasonId !== 'string'
    || typeof receipt.seasonCode !== 'string'
    || (receipt.strategy !== 'merge' && receipt.strategy !== 'replace')
    || !Number.isSafeInteger(receipt.expectedDataVersion)
    || (receipt.expectedDataVersion as number) < 0
    || typeof receipt.previewHash !== 'string'
    || !['validated', 'failed', 'committed', 'cancelled', 'expired'].includes(
      receipt.status as string,
    )
  ) {
    return false;
  }
  if (receipt.status === 'committed') {
    if (receipt.committedResult === null) return false;
    try {
      const committed = parseSeasonalImportV3CommittedResult(receipt.committedResult);
      markSeasonalImportV3RecoveryCommitted(
        receipt as unknown as SeasonalImportV3RecoveryReceipt,
        committed,
      );
      return true;
    } catch {
      return false;
    }
  }
  return receipt.committedResult === null;
}

export function persistSeasonalImportV3RecoveryReceipt(
  storage: SeasonalImportReceiptStorage,
  receipt: SeasonalImportV3RecoveryReceipt,
): void {
  if (!isSeasonalImportV3RecoveryReceipt(receipt)) {
    throw new Error('Seasonal import V3 recovery receipt is malformed.');
  }
  try {
    storage.setItem(SEASONAL_IMPORT_V3_RECOVERY_STORAGE_KEY, JSON.stringify(receipt));
  } catch (error) {
    throw new SeasonalImportRecoveryStorageError(error);
  }
}

export function clearSeasonalImportV3RecoveryReceipt(
  storage: SeasonalImportReceiptStorage,
): boolean {
  try {
    storage.removeItem(SEASONAL_IMPORT_V3_RECOVERY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadSeasonalImportV3RecoveryReceipt(
  storage: SeasonalImportReceiptStorage,
  scope: { expectedSeasonId?: string | null } = {},
): SeasonalImportV3RecoveryReceipt | null {
  const raw = storage.getItem(SEASONAL_IMPORT_V3_RECOVERY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw) as unknown;
    if (
      !isSeasonalImportV3RecoveryReceipt(receipt)
      || (
        scope.expectedSeasonId !== undefined
        && receipt.seasonId !== scope.expectedSeasonId
      )
    ) {
      clearSeasonalImportV3RecoveryReceipt(storage);
      return null;
    }
    return receipt;
  } catch {
    clearSeasonalImportV3RecoveryReceipt(storage);
    return null;
  }
}
