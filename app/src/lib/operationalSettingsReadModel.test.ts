import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateOperationalSettings } from './settingsRules.ts';
import { createOperationalSettingsReadModel } from './operationalSettingsReadModel.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('missing and stale settings remain readable with correct freshness', async () => {
  let now = 10;
  const settings = hydrateOperationalSettings(null);
  const model = createOperationalSettingsReadModel({
    load: async () => settings,
    getEpoch: () => 1,
    isCurrent: (epoch) => epoch === 1,
    commitShared: () => true,
    now: () => now,
  });
  assert.equal(model.read().freshness, 'missing');
  await model.revalidate();
  assert.equal(model.read().freshness, 'fresh');
  now += 10 * 60_000 + 1;
  assert.equal(model.read().freshness, 'stale');
  assert.strictEqual(model.read().snapshot, settings);
});

test('three revalidations and force join one loader', async () => {
  const pending = deferred<ReturnType<typeof hydrateOperationalSettings>>();
  let calls = 0;
  const model = createOperationalSettingsReadModel({
    load: () => { calls += 1; return pending.promise; },
    getEpoch: () => 1,
    isCurrent: () => true,
    commitShared: () => true,
    now: () => 10,
  });
  const first = model.revalidate();
  const second = model.revalidate();
  const forced = model.revalidate(true);
  assert.strictEqual(first, second);
  assert.strictEqual(first, forced);
  assert.equal(calls, 1);
  pending.resolve(hydrateOperationalSettings(null));
  await first;
});

test('current errors preserve snapshot while clear fences late old-operator work', async () => {
  let epoch = 4;
  const initial = hydrateOperationalSettings(null);
  const failed = deferred<ReturnType<typeof hydrateOperationalSettings>>();
  const model = createOperationalSettingsReadModel({
    load: () => failed.promise,
    getEpoch: () => epoch,
    isCurrent: (candidate) => candidate === epoch,
    commitShared: () => true,
    now: () => 10,
    initialSnapshot: initial,
  });
  const currentFailure = model.revalidate(true);
  failed.reject(new Error('network'));
  await assert.rejects(currentFailure, /network/);
  assert.strictEqual(model.read().snapshot, initial);
  assert.equal(model.read().lastError, 'network');

  const oldPending = deferred<ReturnType<typeof hydrateOperationalSettings>>();
  const fenced = createOperationalSettingsReadModel({
    load: () => oldPending.promise,
    getEpoch: () => epoch,
    isCurrent: (candidate) => candidate === epoch,
    commitShared: () => true,
    now: () => 10,
  });
  const oldLoad = fenced.revalidate();
  epoch = 5;
  fenced.clear();
  oldPending.resolve(initial);
  await assert.rejects(oldLoad, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(fenced.read().snapshot, null);
  assert.equal(fenced.read().lastError, null);
});

test('commit writes shared state only for the originating epoch', () => {
  const writes: number[] = [];
  const settings = hydrateOperationalSettings(null);
  const model = createOperationalSettingsReadModel({
    load: async () => settings,
    getEpoch: () => 12,
    isCurrent: (epoch) => epoch === 12,
    commitShared: (_settings, epoch) => { writes.push(epoch); return true; },
    now: () => 10,
  });
  assert.equal(model.commit(settings, 11), false);
  assert.equal(model.commit(settings, 12), true);
  assert.deepEqual(writes, [12]);
});
