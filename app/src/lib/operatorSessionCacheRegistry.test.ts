import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperatorSessionCacheRegistry,
  getOperatorSessionEpoch,
  runOperatorSessionResourceOperation,
  advanceOperatorSessionEpochAndClearRegisteredCaches,
} from './operatorSessionCacheRegistry.ts';

test('registry replaces stable keys, unregisters safely, and advances before clearing', () => {
  const registry = createOperatorSessionCacheRegistry();
  const calls: Array<[string, number]> = [];
  const staleUnregister = registry.register('cache', () => calls.push(['old', registry.getEpoch()]));
  registry.register('cache', () => calls.push(['new', registry.getEpoch()]));
  registry.register('throws', () => { throw new Error('cleanup'); });
  registry.register('other', () => calls.push(['other', registry.getEpoch()]));
  staleUnregister();
  const oldEpoch = registry.getEpoch();
  assert.equal(registry.advanceAndClear(), 1);
  assert.equal(registry.isCurrent(oldEpoch), false);
  assert.deepEqual(calls, [['new', 1], ['other', 1]]);
});

test('resource operation stops at async session boundaries', async () => {
  const epoch = getOperatorSessionEpoch();
  let resolveAcquire: ((value: string) => void) | null = null;
  let executed = false;
  const operation = runOperatorSessionResourceOperation({
    operatorSessionEpoch: epoch,
    acquire: () => new Promise<string>((resolve) => { resolveAcquire = resolve; }),
    execute: async () => { executed = true; return 'ok'; },
  });
  advanceOperatorSessionEpochAndClearRegisteredCaches();
  (resolveAcquire as unknown as (value: string) => void)('resource');
  await assert.rejects(operation, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(executed, false);
});

test('resource checkpoint prevents later requests and stale errors are normalized', async () => {
  const epoch = getOperatorSessionEpoch();
  let continueExecution: (() => void) | null = null;
  let secondStep = false;
  const operation = runOperatorSessionResourceOperation({
    operatorSessionEpoch: epoch,
    acquire: async () => 'resource',
    execute: async (_resource, assertCurrent) => {
      await new Promise<void>((resolve) => { continueExecution = resolve; });
      assertCurrent();
      secondStep = true;
      throw new Error('old operator network failure');
    },
  });
  await Promise.resolve();
  advanceOperatorSessionEpochAndClearRegisteredCaches();
  (continueExecution as unknown as () => void)();
  await assert.rejects(operation, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(secondStep, false);
});
