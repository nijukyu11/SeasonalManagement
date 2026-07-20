export function createOperatorSessionAbortError(): DOMException {
  return new DOMException('Operator session changed.', 'AbortError');
}

export interface OperatorSessionRemoteOptions {
  operatorSessionEpoch: number;
}

export interface OperatorSessionCheckpointOptions {
  assertOperatorSessionCurrent: () => void;
}

export function createOperatorSessionCacheRegistry() {
  let epoch = 0;
  const clearers = new Map<string, () => void>();
  return {
    register(key: string, clear: () => void): () => void {
      clearers.set(key, clear);
      return () => {
        if (clearers.get(key) === clear) clearers.delete(key);
      };
    },
    getEpoch(): number {
      return epoch;
    },
    isCurrent(candidate: number): boolean {
      return candidate === epoch;
    },
    advanceAndClear(): number {
      epoch += 1;
      for (const clear of [...clearers.values()]) {
        try { clear(); } catch { /* One cache cannot prevent the remaining cleanup. */ }
      }
      return epoch;
    },
  };
}

const operatorSessionCaches = createOperatorSessionCacheRegistry();

export function registerOperatorSessionCacheClearer(key: string, clear: () => void): () => void {
  return operatorSessionCaches.register(key, clear);
}

export function getOperatorSessionEpoch(): number {
  return operatorSessionCaches.getEpoch();
}

export function isOperatorSessionEpochCurrent(epoch: number): boolean {
  return operatorSessionCaches.isCurrent(epoch);
}

export function advanceOperatorSessionEpochAndClearRegisteredCaches(): number {
  return operatorSessionCaches.advanceAndClear();
}

export async function runOperatorSessionResourceOperation<Resource, Result>(input: {
  operatorSessionEpoch: number;
  acquire: () => Promise<Resource>;
  execute: (
    resource: Resource,
    assertOperatorSessionCurrent: () => void,
  ) => Promise<Result>;
}): Promise<Result> {
  const assertOperatorSessionCurrent = () => {
    if (!isOperatorSessionEpochCurrent(input.operatorSessionEpoch)) {
      throw createOperatorSessionAbortError();
    }
  };
  try {
    assertOperatorSessionCurrent();
    const resource = await input.acquire();
    assertOperatorSessionCurrent();
    const result = await input.execute(resource, assertOperatorSessionCurrent);
    assertOperatorSessionCurrent();
    return result;
  } catch (error) {
    if (!isOperatorSessionEpochCurrent(input.operatorSessionEpoch)) {
      throw createOperatorSessionAbortError();
    }
    throw error;
  }
}
