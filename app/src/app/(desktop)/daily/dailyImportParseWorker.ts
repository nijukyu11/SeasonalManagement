import { parseDailyScheduleWorkbookToV2Payload, type DailyImportParseResult } from '../../../lib/dailyImportV2Parser.ts';

export interface DailyImportWorkerRequest {
  type: 'parse';
  requestId: number;
  buffer: ArrayBuffer;
  fileName: string;
  options?: {
    requestId?: string;
    fallbackDate?: string;
    confirmedZeroFlightDates?: string[];
  };
}

export type DailyImportWorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: DailyImportParseResult;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };

const workerScope = self as unknown as {
  postMessage(message: DailyImportWorkerResponse): void;
  onmessage: ((event: MessageEvent<DailyImportWorkerRequest>) => void) | null;
};

workerScope.onmessage = async (event: MessageEvent<DailyImportWorkerRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'parse') return;

  try {
    const result = await parseDailyScheduleWorkbookToV2Payload(data.buffer, data.fileName, data.options);
    workerScope.postMessage({
      requestId: data.requestId,
      ok: true,
      result,
    });
  } catch (err) {
    workerScope.postMessage({
      requestId: data.requestId,
      ok: false,
      error: (err as Error).message || 'Không thể đọc tệp lịch bay.',
    });
  }
};
