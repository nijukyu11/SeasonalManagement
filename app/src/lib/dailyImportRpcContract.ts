import type { DailyImportStagePayloadV1 } from './dailyImportV1Contract.ts';

export interface DailyImportV1RpcErrorDetail {
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

export class DailyImportV1RpcRejectedError extends Error {
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(message: string, error: DailyImportV1RpcErrorDetail = {}) {
    super(message);
    this.name = 'DailyImportV1RpcRejectedError';
    this.code = typeof error.code === 'string' && error.code.trim() ? error.code.trim() : null;
    this.details = typeof error.details === 'string' && error.details.trim() ? error.details.trim() : null;
    this.hint = typeof error.hint === 'string' && error.hint.trim() ? error.hint.trim() : null;
  }
}

export function isDailyImportStaleVersionConflictV1(error: unknown): boolean {
  return error instanceof DailyImportV1RpcRejectedError
    && error.code === 'PT409'
    && /Stale Daily import stage/i.test(error.message);
}

export function createDailyImportRetryPayloadV1(
  payload: DailyImportStagePayloadV1,
  requestId: string = globalThis.crypto.randomUUID(),
): DailyImportStagePayloadV1 {
  return { ...payload, requestId };
}

export async function stageDailyImportWithTerminalRetryV1(
  payload: DailyImportStagePayloadV1,
  stage: (input: DailyImportStagePayloadV1) => Promise<DailyImportStageResultV1>,
  options: {
    getStatus?: (requestId: string) => Promise<DailyImportStageResultV1>;
    createRequestId?: () => string;
  } = {},
): Promise<{ payload: DailyImportStagePayloadV1; result: DailyImportStageResultV1 }> {
  const stageOrRecover = async (input: DailyImportStagePayloadV1): Promise<DailyImportStageResultV1> => {
    try {
      return await stage(input);
    } catch (stageError) {
      if (!options.getStatus) throw stageError;
      try {
        return await options.getStatus(input.requestId);
      } catch {
        throw stageError;
      }
    }
  };

  const firstResult = await stageOrRecover(payload);
  if (firstResult.status !== 'cancelled' && firstResult.status !== 'expired') {
    return { payload, result: firstResult };
  }
  const retryPayload = createDailyImportRetryPayloadV1(
    payload,
    (options.createRequestId ?? (() => globalThis.crypto.randomUUID()))(),
  );
  return { payload: retryPayload, result: await stageOrRecover(retryPayload) };
}

export interface DailyImportPreviewSeasonV1 {
  seasonId: string;
  seasonCode: string;
  expectedDataVersion: number;
  rangeStart: string;
  rangeEnd: string;
  affectedDates: string[];
  confirmedZeroFlightDates?: string[];
  counts: {
    beforeCount: number;
    afterCount: number;
    insertedCount: number;
    beforePax?: number;
    afterPax?: number;
    beforePaxKnownCount?: number;
    afterPaxKnownCount?: number;
    seasonalBeforeCount?: number;
    dailyBeforeCount?: number;
    manualBeforeCount?: number;
    matchedCount?: number;
    overlayRebaseCount?: number;
    hiddenBaselineCount?: number;
  };
}

export interface DailyImportStageResultV1 {
  batchId: string;
  requestId: string;
  status: 'validated' | 'failed' | 'cancelled' | 'expired' | 'committed';
  previewHash: string;
  preview: {
    valid: boolean;
    fileName: string;
    workbookProfile: string;
    sourceRowCount: number;
    legCount: number;
    seasons: DailyImportPreviewSeasonV1[];
  };
  diagnostics: Array<Record<string, unknown>>;
  expiresAt: string;
  result: DailyImportCommittedResultV1 | null;
}

export interface DailyImportCommittedResultV1 {
  batchId: string;
  requestId: string;
  status: 'committed';
  previewHash: string;
  serverHighWater: number;
  seasons: Array<{
    seasonId: string;
    seasonCode: string;
    dataVersion: number;
    serverHighWater: number;
    beforeCount?: number;
    deletedCount?: number;
    insertedCount?: number;
    activeAfterCount?: number;
    beforePax?: number;
    afterPax?: number;
    overlayRebasedCount?: number;
  }>;
  rawChecksum: string;
  canonicalChecksum: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function parseDailyImportStageResultV1(value: unknown): DailyImportStageResultV1 {
  const result = object(value, 'Daily import stage result');
  const preview = object(result.preview, 'Daily import preview');
  if (typeof result.batchId !== 'string' || typeof result.requestId !== 'string' || typeof result.previewHash !== 'string') {
    throw new Error('Daily import stage result is missing identity fields.');
  }
  if (!Array.isArray(preview.seasons) || !Array.isArray(result.diagnostics)) {
    throw new Error('Daily import stage result is missing preview arrays.');
  }
  return result as unknown as DailyImportStageResultV1;
}

export function parseDailyImportCommittedResultV1(value: unknown): DailyImportCommittedResultV1 {
  const result = object(value, 'Daily import commit result');
  if (result.status !== 'committed' || typeof result.batchId !== 'string' || !Array.isArray(result.seasons)) {
    throw new Error('Daily import commit receipt is invalid.');
  }
  return result as unknown as DailyImportCommittedResultV1;
}

export type { DailyImportStagePayloadV1 };
