import {
  beginDailyScheduleImportUploadV2,
  appendDailyScheduleImportUploadV2,
  finalizeDailyScheduleImportUploadV2,
  getDailyScheduleImportV2Status,
} from './remoteStore.ts';
import type {
  DailyImportLegInputV2,
  DailyImportStagePayloadV2,
  DailyImportStageResultV2,
  DailyImportCommittedResultV2,
  DailyImportUploadBeginResultV2,
  DailyImportUploadAppendResultV2,
} from './operationalScheduleContract.ts';
import {
  parseDailyScheduleWorkbookToV2Payload,
  type DailyImportParseResult,
  type ParseDailyScheduleWorkbookOptions,
} from './dailyImportV2Parser.ts';
import type {
  DailyImportWorkerRequest,
  DailyImportWorkerResponse,
} from '../app/(desktop)/daily/dailyImportParseWorker.ts';
import { getSynchronousOperatorUserId } from './seasonalRestoreJournal.ts';

export const DAILY_IMPORT_DEFAULT_CHUNK_SIZE = 5000;

export interface DailyImportUploadProgress {
  phase: 'reading' | 'parsing' | 'preparing' | 'uploading' | 'finalizing' | 'completed' | 'error';
  currentChunk: number;
  totalChunks: number;
  uploadedLegs: number;
  totalLegs: number;
  percent: number;
  message: string;
  detail?: string;
}

export interface DailyImportUploadJournalEntry {
  operatorId: string;
  rawChecksum?: string;
  requestId: string;
  uploadId?: string;
  batchId?: string;
  fileName?: string;
  totalChunks: number;
  legCount: number;
  nextChunkIndex: number;
  status: 'uploading' | 'staged' | 'committed';
  payloadFingerprint?: string;
  previewHash?: string;
  stagedResult?: DailyImportStageResultV2 | null;
  committedResult?: DailyImportCommittedResultV2 | null;
  savedAt: number;
}
export class DailyImportStorageError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DailyImportStorageError';
    this.cause = cause;
  }
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

export function resolveOperatorId(explicit?: string | null): string | null {
  if (typeof window !== 'undefined') {
    const current = getSynchronousOperatorUserId();
    if (!current || !current.trim()) {
      return null;
    }
    const currentTrimmed = current.trim();
    if (explicit && explicit.trim() && explicit.trim() !== currentTrimmed) {
      return null;
    }
    return currentTrimmed;
  }
  if (explicit && explicit.trim()) return explicit.trim();
  const synchronous = getSynchronousOperatorUserId();
  if (synchronous && synchronous.trim()) return synchronous.trim();
  return null;
}

export function requireOperatorId(explicit?: string | null): string {
  const op = resolveOperatorId(explicit);
  if (!op) {
    throw new DailyImportStorageError('An authenticated operator is required for daily import operations.');
  }
  return op;
}

export function getDailyJournalStorageKey(operatorId: string, rawChecksum?: string): string {
  const op = resolveOperatorId(operatorId);
  if (!op || op === 'default-operator') {
    throw new DailyImportStorageError('An authenticated operator is required for daily import storage key.');
  }
  return rawChecksum
    ? `daily:chunked-upload:op:${op}:fp:${rawChecksum}`
    : `daily:chunked-upload:op:${op}:active`;
}

export function saveDailyUploadJournal(
  entry: DailyImportUploadJournalEntry,
  storageInput?: Storage | null,
): void {
  const op = resolveOperatorId(entry.operatorId);
  if (!op) {
    throw new DailyImportStorageError('An authenticated operator is required to persist daily import upload journal.');
  }
  const storage = getSafeStorage(storageInput);
  if (!storage) {
    throw new DailyImportStorageError('Storage is unavailable. Cannot persist daily import upload journal.');
  }

  const activeKey = getDailyJournalStorageKey(op);
  const fpKey = entry.rawChecksum ? getDailyJournalStorageKey(op, entry.rawChecksum) : null;
  const serialized = JSON.stringify({ ...entry, operatorId: op });

  try {
    if (fpKey) {
      storage.setItem(fpKey, serialized);
    }
    storage.setItem(activeKey, serialized);
  } catch (err) {
    throw new DailyImportStorageError('Failed to persist daily import upload journal.', err);
  }
}

export function getDailyUploadJournalByFingerprint(
  operatorId: string,
  rawChecksum: string,
  storageInput?: Storage | null,
): DailyImportUploadJournalEntry | null {
  const op = resolveOperatorId(operatorId);
  if (!op || !rawChecksum) return null;

  const storage = getSafeStorage(storageInput);
  if (!storage) return null;

  try {
    const raw = storage.getItem(getDailyJournalStorageKey(op, rawChecksum));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DailyImportUploadJournalEntry;
    if (parsed && typeof parsed === 'object' && parsed.operatorId === op && parsed.rawChecksum === rawChecksum) {
      return parsed;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

export function getActiveDailyUploadJournal(
  operatorId: string,
  storageInput?: Storage | null,
): DailyImportUploadJournalEntry | null {
  const op = resolveOperatorId(operatorId);
  if (!op) return null;

  const storage = getSafeStorage(storageInput);
  if (!storage) return null;

  try {
    const raw = storage.getItem(getDailyJournalStorageKey(op));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DailyImportUploadJournalEntry;
    if (parsed && typeof parsed === 'object' && parsed.operatorId === op && parsed.requestId) {
      return parsed;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

export function clearDailyUploadJournal(
  operatorId: string,
  rawChecksum?: string,
  storageInput?: Storage | null,
): void {
  const op = resolveOperatorId(operatorId);
  if (!op) return;

  const storage = getSafeStorage(storageInput);
  if (!storage) return;

  try {
    const active = getActiveDailyUploadJournal(op, storage);
    const fingerprint = rawChecksum ?? active?.rawChecksum;
    if (fingerprint) {
      storage.removeItem(getDailyJournalStorageKey(op, fingerprint));
    }
    if (!rawChecksum || active?.rawChecksum === rawChecksum) {
      storage.removeItem(getDailyJournalStorageKey(op));
    }
  } catch {
    // Ignore
  }
}


export function isTransportError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('timeout') ||
    msg.includes('failed to fetch') ||
    msg.includes('connection') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    (!msg.includes('abort') && (msg.includes('load failed') || msg.includes('offline')))
  );
}

let workerRequestSeq = 0;

/**
 * Parses an Excel file using a Web Worker if available.
 * If worker fails or signal aborts, it rejects without swallowing errors.
 */
export async function parseDailyWorkbookWithWorker(
  file: File,
  options?: {
    onProgress?: (progress: DailyImportUploadProgress) => void;
    signal?: AbortSignal;
    requestId?: string;
    fallbackDate?: string;
    confirmedZeroFlightDates?: string[];
  }
): Promise<DailyImportParseResult> {
  if (options?.signal?.aborted) {
    throw new Error('Thao tác nhập đã bị hủy.');
  }

  options?.onProgress?.({
    phase: 'reading',
    currentChunk: 0,
    totalChunks: 0,
    uploadedLegs: 0,
    totalLegs: 0,
    percent: 5,
    message: 'Đang đọc tệp Excel...',
    detail: file.name,
  });

  const buffer = await file.arrayBuffer();
  if (options?.signal?.aborted) {
    throw new Error('Thao tác nhập đã bị hủy.');
  }

  options?.onProgress?.({
    phase: 'parsing',
    currentChunk: 0,
    totalChunks: 0,
    uploadedLegs: 0,
    totalLegs: 0,
    percent: 15,
    message: 'Đang phân tích cấu trúc và chuẩn hóa dữ liệu chuyến bay...',
    detail: file.name,
  });

  const parseOptions: ParseDailyScheduleWorkbookOptions = {
    requestId: options?.requestId,
    fallbackDate: options?.fallbackDate,
    confirmedZeroFlightDates: options?.confirmedZeroFlightDates,
  };

  // If in browser with Worker support:
  if (typeof Worker !== 'undefined') {
    let worker: Worker | null = null;
    const currentReqId = ++workerRequestSeq;
    const cleanup = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    return new Promise<DailyImportParseResult>((resolve, reject) => {
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          cleanup();
          reject(new Error('Thao tác nhập đã bị hủy.'));
        }, { once: true });
      }

      try {
        worker = new Worker(new URL('../app/(desktop)/daily/dailyImportParseWorker.ts', import.meta.url), {
          type: 'module',
        });
      } catch (workerInitErr) {
        // Only if Worker constructor failed before transfer can we safely run on main thread
        cleanup();
        parseDailyScheduleWorkbookToV2Payload(buffer, file.name, parseOptions).then(resolve, reject);
        return;
      }

      worker.onmessage = (event: MessageEvent<DailyImportWorkerResponse>) => {
        if (event.data.requestId !== currentReqId) return;
        cleanup();
        if (event.data.ok) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error));
        }
      };

      worker.onerror = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error('Lỗi trong worker giải mã tệp.'));
      };

      const request: DailyImportWorkerRequest = {
        type: 'parse',
        requestId: currentReqId,
        buffer,
        fileName: file.name,
        options: parseOptions,
      };

      worker.postMessage(request, [buffer]);
    });
  }

  // Non-worker environment (Node.js test runner)
  return parseDailyScheduleWorkbookToV2Payload(buffer, file.name, parseOptions);
}

/**
 * Uploads a Daily import payload in chunks, tracking progress, allowing retry/resume,
 * and maintaining upload identity.
 */
export interface ChunkedUploadClient {
  beginDailyScheduleImportUploadV2: (
    input: { importPayload: Omit<DailyImportStagePayloadV2, 'legs'>; legCount: number; chunkCount: number },
  ) => Promise<DailyImportUploadBeginResultV2>;
  appendDailyScheduleImportUploadV2: (
    input: { uploadId: string; chunkIndex: number; legs: DailyImportLegInputV2[] },
  ) => Promise<DailyImportUploadAppendResultV2>;
  finalizeDailyScheduleImportUploadV2: (
    uploadId: string,
  ) => Promise<DailyImportStageResultV2>;
}

export async function uploadDailyImportInChunksV2(
  payload: DailyImportStagePayloadV2,
  options?: {
    chunkSize?: number;
    onProgress?: (progress: DailyImportUploadProgress) => void;
    signal?: AbortSignal;
    maxRetriesPerChunk?: number;
    operatorId?: string;
    client?: ChunkedUploadClient;
  }
): Promise<DailyImportStageResultV2> {
  const { legs, ...metadata } = payload;
  const totalLegs = legs.length;
  const chunkSize = options?.chunkSize ?? DAILY_IMPORT_DEFAULT_CHUNK_SIZE;
  const totalChunks = totalLegs === 0 ? 0 : Math.ceil(totalLegs / chunkSize);
  const maxRetries = options?.maxRetriesPerChunk ?? 3;
  const operatorId = resolveOperatorId(options?.operatorId);
  if (!operatorId) {
    throw new DailyImportStorageError('An authenticated operator is required to upload daily schedule import.');
  }
  const beginUploadRpc = options?.client?.beginDailyScheduleImportUploadV2 ?? beginDailyScheduleImportUploadV2;
  const appendUploadRpc = options?.client?.appendDailyScheduleImportUploadV2 ?? appendDailyScheduleImportUploadV2;
  const finalizeUploadRpc = options?.client?.finalizeDailyScheduleImportUploadV2 ?? finalizeDailyScheduleImportUploadV2;

  const payloadFingerprintInput = { ...payload, requestId: undefined };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadFingerprintInput));
  const payloadDigest = await globalThis.crypto.subtle.digest('SHA-256', payloadBytes);
  const payloadFingerprint = Array.from(new Uint8Array(payloadDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');

  // Raw file checksums omit user confirmations and fallback scope; resume only
  // when the exact staged request payload matches.
  const fingerprintJournal = payload.rawChecksum
    ? getDailyUploadJournalByFingerprint(operatorId, payload.rawChecksum)
    : null;
  const existingJournal = fingerprintJournal?.payloadFingerprint === payloadFingerprint
    ? fingerprintJournal
    : null;
  const requestId = existingJournal?.requestId || payload.requestId;
  payload.requestId = requestId;
  const importPayload = { ...metadata, requestId };

  // Persist journal BEFORE first RPC call so storage refusal causes zero server calls
  // and lost begin ACK/restart retains the recoverable request
  saveDailyUploadJournal({
    operatorId,
    rawChecksum: payload.rawChecksum,
    requestId,
    uploadId: existingJournal?.uploadId,
    batchId: existingJournal?.batchId,
    fileName: payload.fileName,
    totalChunks,
    legCount: totalLegs,
    nextChunkIndex: existingJournal?.nextChunkIndex ?? 0,
    status: 'uploading',
    payloadFingerprint,
    savedAt: Date.now(),
  });

  options?.onProgress?.({
    phase: 'preparing',
    currentChunk: 0,
    totalChunks,
    uploadedLegs: 0,
    totalLegs,
    percent: 20,
    message: 'Đang khởi tạo đợt nhập trên máy chủ...',
  });

  if (options?.signal?.aborted) throw new Error('Thao tác nhập đã bị hủy.');

  // Initialize or resume upload session on backend
  const beginResult = await beginUploadRpc({
    importPayload,
    legCount: totalLegs,
    chunkCount: totalChunks,
  });

  if (['expired', 'cancelled', 'failed'].includes(beginResult.status)) {
    clearDailyUploadJournal(operatorId, payload.rawChecksum);
    throw new Error('Đợt nhập trước đã hết hạn, bị hủy hoặc không hợp lệ. Vui lòng chọn lại tệp để tạo đợt nhập mới.');
  }

  const uploadId = beginResult.uploadId;
  const startingChunkIndex = Math.max(0, beginResult.nextChunkIndex);

  saveDailyUploadJournal({
    operatorId,
    rawChecksum: payload.rawChecksum,
    requestId,
    uploadId,
    batchId: beginResult.batchId,
    fileName: payload.fileName,
    totalChunks,
    legCount: totalLegs,
    nextChunkIndex: startingChunkIndex,
    status: 'uploading',
    payloadFingerprint,
    savedAt: Date.now(),
  });

  // Upload chunks sequentially
  for (let chunkIdx = startingChunkIndex; chunkIdx < totalChunks; chunkIdx++) {
    if (options?.signal?.aborted) throw new Error('Thao tác nhập đã bị hủy.');

    const startIdx = chunkIdx * chunkSize;
    const endIdx = Math.min(startIdx + chunkSize, totalLegs);
    const chunkLegs: DailyImportLegInputV2[] = legs.slice(startIdx, endIdx);

    let attempt = 0;
    let appendSuccess = false;
    let lastError: unknown = null;

    while (attempt <= maxRetries) {
      if (options?.signal?.aborted) throw new Error('Thao tác nhập đã bị hủy.');

      try {
        const appendResult = await appendUploadRpc({
          uploadId,
          chunkIndex: chunkIdx,
          legs: chunkLegs,
        });

        appendSuccess = true;
        saveDailyUploadJournal({
          operatorId,
          rawChecksum: payload.rawChecksum,
          requestId,
          uploadId,
          batchId: beginResult.batchId,
          fileName: payload.fileName,
          totalChunks,
          legCount: totalLegs,
          nextChunkIndex: appendResult.nextChunkIndex,
          status: 'uploading',
          payloadFingerprint,
          savedAt: Date.now(),
        });
        break;
      } catch (err) {
        lastError = err;
        if (!isTransportError(err)) {
          // Broad / client / validation errors must fail immediately without retry
          throw err;
        }
        attempt++;
        if (attempt <= maxRetries) {
          // Exponential backoff
          const { promise: delayPromise, resolve: delayResolve } = (
            typeof Promise.withResolvers === 'function'
              ? Promise.withResolvers<void>()
              : (() => {
                  let res!: () => void;
                  const p = new Promise<void>((r) => { res = r; });
                  return { promise: p, resolve: res };
                })()
          );
          setTimeout(delayResolve, 400 * Math.pow(2, attempt - 1));
          await delayPromise;
        }
      }
    }

    if (!appendSuccess) {
      const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Tải lên phần ${chunkIdx + 1}/${totalChunks} gặp sự cố truyền tải sau ${maxRetries} lần thử: ${errorMsg}`);
    }

    const currentUploaded = endIdx;
    const percent = totalChunks > 0
      ? Math.round(20 + ((chunkIdx + 1) / totalChunks) * 65)
      : 85;

    options?.onProgress?.({
      phase: 'uploading',
      currentChunk: chunkIdx + 1,
      totalChunks,
      uploadedLegs: currentUploaded,
      totalLegs,
      percent,
      message: `Đang tải lên dữ liệu (phần ${chunkIdx + 1}/${totalChunks}, ${currentUploaded.toLocaleString('vi-VN')}/${totalLegs.toLocaleString('vi-VN')} chặng bay)...`,
    });
  }

  // Finalize upload
  options?.onProgress?.({
    phase: 'finalizing',
    currentChunk: totalChunks,
    totalChunks,
    uploadedLegs: totalLegs,
    totalLegs,
    percent: 90,
    message: 'Đang tổng hợp dữ liệu và chuẩn bị bản xem trước trên máy chủ...',
  });

  if (options?.signal?.aborted) throw new Error('Thao tác nhập đã bị hủy.');

  let stageResult: DailyImportStageResultV2;
  try {
    stageResult = await finalizeUploadRpc(uploadId);
  } catch (finalizeErr) {
    // If transport interrupted during finalize, probe getDailyScheduleImportV2Status
    if (isTransportError(finalizeErr)) {
      try {
        const recovered = await getDailyScheduleImportV2Status(requestId);
        if (recovered && (recovered.status === 'validated' || recovered.status === 'committed')) {
          stageResult = recovered;
        } else {
          throw finalizeErr;
        }
      } catch {
        throw finalizeErr;
      }
    } else {
      throw finalizeErr;
    }
  }

  saveDailyUploadJournal({
    operatorId,
    rawChecksum: payload.rawChecksum,
    requestId,
    uploadId,
    batchId: stageResult.batchId,
    fileName: payload.fileName,
    totalChunks,
    legCount: totalLegs,
    nextChunkIndex: totalChunks,
    status: 'staged',
    payloadFingerprint,
    previewHash: stageResult.previewHash,
    stagedResult: stageResult,
    savedAt: Date.now(),
  });

  options?.onProgress?.({
    phase: 'completed',
    currentChunk: totalChunks,
    totalChunks,
    uploadedLegs: totalLegs,
    totalLegs,
    percent: 100,
    message: 'Hoàn tất chuẩn bị đợt nhập.',
  });

  return stageResult;
}
