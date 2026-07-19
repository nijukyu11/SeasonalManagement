import type {
  SeasonalImportV2Mode,
  SeasonalImportV2RpcAttempt,
  SeasonalImportV2CommittedResult,
} from './seasonalImportRpcContract.ts';

export const SEASONAL_IMPORT_RECOVERY_STORAGE_KEY = 'settings:seasonRepairRecoveryReceipt:v1';

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
