import {
  applyLocalModificationBatchDelta,
  type LocalSyncMeta,
} from '../../lib/localSeasonStore';
import type { FlightModification } from '../../lib/types';

interface GateLocalCommitWorkerRequest {
  type: 'commit';
  requestId: number;
  seasonId: string;
  mods: FlightModification[];
  description: string;
}

type GateLocalCommitWorkerResponse =
  | {
      requestId: number;
      ok: true;
      syncMeta: LocalSyncMeta;
      affectedIds: string[];
    }
  | {
      requestId: number;
      ok: false;
      message: string;
    };

const workerScope = self as unknown as {
  postMessage(message: GateLocalCommitWorkerResponse): void;
  onmessage: ((event: MessageEvent<GateLocalCommitWorkerRequest>) => void) | null;
};

let historySequence = 0;

async function commitGateModifications(request: GateLocalCommitWorkerRequest): Promise<GateLocalCommitWorkerResponse> {
  try {
    const timestamp = Date.now();
    const syncMeta = await applyLocalModificationBatchDelta(request.seasonId, request.mods, {
      id: `LOCAL_GATE_${timestamp}_${++historySequence}_${request.requestId}`,
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

workerScope.onmessage = (event) => {
  if (event.data.type !== 'commit') return;
  void commitGateModifications(event.data).then((response) => {
    workerScope.postMessage(response);
  });
};

export {};
