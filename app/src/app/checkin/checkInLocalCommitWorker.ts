import {
  applyLocalModificationBatchDelta,
  type LocalSyncMeta,
} from '../../lib/localSeasonStore';
import type { FlightModification } from '../../lib/types';

interface CheckInLocalCommitWorkerCommitRequest {
  type: 'commit';
  requestId: number;
  seasonId: string;
  mods: FlightModification[];
  description: string;
}

interface CheckInLocalCommitWorkerWarmupRequest {
  type: 'warmup';
  requestId: number;
  seasonId: string;
}

type CheckInLocalCommitWorkerRequest = CheckInLocalCommitWorkerCommitRequest | CheckInLocalCommitWorkerWarmupRequest;

type CheckInLocalCommitWorkerResponse =
  | {
      requestId: number;
      ok: true;
      syncMeta?: LocalSyncMeta;
      affectedIds?: string[];
    }
  | {
      requestId: number;
      ok: false;
      message: string;
    };

const workerScope = self as unknown as {
  postMessage(message: CheckInLocalCommitWorkerResponse): void;
  onmessage: ((event: MessageEvent<CheckInLocalCommitWorkerRequest>) => void) | null;
};

let historySequence = 0;
let commitChain = Promise.resolve() as Promise<unknown>;

async function commitCheckInModifications(request: CheckInLocalCommitWorkerCommitRequest): Promise<CheckInLocalCommitWorkerResponse> {
  try {
    const timestamp = Date.now();
    const syncMeta = await applyLocalModificationBatchDelta(request.seasonId, request.mods, {
      id: `LOCAL_CHECKIN_${timestamp}_${++historySequence}_${request.requestId}`,
      timestamp,
      description: request.description,
    });
    return {
      requestId: request.requestId,
      ok: true,
      syncMeta,
      affectedIds: Array.from(new Set(request.mods.map((mod) => mod.legId))),
    };
  } catch (err) {
    return {
      requestId: request.requestId,
      ok: false,
      message: (err as Error).message,
    };
  }
}

async function warmupCheckInCommitWorker(request: CheckInLocalCommitWorkerWarmupRequest): Promise<CheckInLocalCommitWorkerResponse> {
  void request.seasonId;
  return {
    requestId: request.requestId,
    ok: true,
  };
}

function enqueueCheckInCommit(request: CheckInLocalCommitWorkerCommitRequest): Promise<CheckInLocalCommitWorkerResponse> {
  const runCommit = () => commitCheckInModifications(request);
  commitChain = commitChain.then(runCommit, runCommit);
  const response = commitChain as Promise<CheckInLocalCommitWorkerResponse>;
  commitChain = commitChain.then(() => undefined, () => undefined);
  return response;
}

workerScope.onmessage = (event) => {
  if (event.data.type === 'warmup') {
    void warmupCheckInCommitWorker(event.data).then((response) => {
      workerScope.postMessage(response);
    });
    return;
  }
  void enqueueCheckInCommit(event.data).then((response) => {
    workerScope.postMessage(response);
  });
};

export {};
