import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditLogEntry, AuditSession } from './auditLog.ts';
import { createAuditReadModel } from './auditReadModel.ts';

const actor = { uid: 'user-1', email: 'one@example.test', displayName: 'One', isAnonymous: false };
const session = (id: string): AuditSession => ({ id, actor, startedAt: 1, lastSeenAt: 2, userAgent: null });
const entry = (id: string, sessionId = 'session-1'): AuditLogEntry => ({
  id,
  sessionId,
  timestamp: 2,
  actor,
  seasonId: null,
  seasonCode: null,
  module: 'seasonal',
  category: 'import',
  operation: 'test',
  targetFlightIds: [],
  targetFlightLabels: [],
  deltas: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('same-key reads are single-flight while limits and sessions stay isolated', async () => {
  let calls = 0;
  const pending = deferred<AuditSession[]>();
  const model = createAuditReadModel({
    loadSessions: () => { calls += 1; return pending.promise; },
    loadEntries: async (sessionId) => [entry(`entry-${sessionId}`, sessionId)],
    loadDeltas: async () => [],
    getOperatorSessionEpoch: () => 0,
    isOperatorSessionEpochCurrent: () => true,
    now: () => 100,
  });
  const first = model.revalidateSessions(50);
  const second = model.revalidateSessions(50);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  pending.resolve([session('session-1')]);
  await first;
  assert.equal(model.readSessions(50).snapshot?.length, 1);
  assert.equal(model.readSessions(200).snapshot, null);
  await model.revalidateEntries('session-1');
  await model.revalidateEntries('session-2');
  assert.equal(model.readEntries('session-1').snapshot?.[0]?.sessionId, 'session-1');
  assert.equal(model.readEntries('session-2').snapshot?.[0]?.sessionId, 'session-2');
});

test('stale snapshots remain readable and force joins the active refresh', async () => {
  let now = 1;
  const pending = deferred<AuditSession[]>();
  let calls = 0;
  const model = createAuditReadModel({
    loadSessions: () => { calls += 1; return calls === 1 ? Promise.resolve([session('old')]) : pending.promise; },
    loadEntries: async () => [],
    loadDeltas: async () => [],
    getOperatorSessionEpoch: () => 0,
    isOperatorSessionEpochCurrent: () => true,
    now: () => now,
  });
  await model.revalidateSessions(50);
  now += 5 * 60_000 + 1;
  assert.equal(model.readSessions(50).freshness, 'stale');
  assert.equal(model.readSessions(50).snapshot?.[0]?.id, 'old');
  const background = model.revalidateSessions(50);
  const forced = model.revalidateSessions(50, true);
  assert.strictEqual(background, forced);
  pending.resolve([session('new')]);
  await forced;
});

test('delta fallback is exact and cache patch de-duplicates sessions and entries', async () => {
  const fallback = [{ targetType: 'flight' as const, targetId: 'f1', targetLabel: 'F1', field: 'gate', before: 1, after: 2 }];
  const withFallback = { ...entry('entry-1'), deltas: fallback };
  const model = createAuditReadModel({
    loadSessions: async () => [session('session-1')],
    loadEntries: async () => [withFallback],
    loadDeltas: async () => [],
    getOperatorSessionEpoch: () => 3,
    isOperatorSessionEpochCurrent: (epoch) => epoch === 3,
    now: () => 100,
  });
  await model.revalidateSessions(50);
  await model.revalidateEntries('session-1');
  assert.deepEqual(await model.revalidateDeltas('session-1', withFallback), fallback);
  assert.equal(model.patchAfterAppend(session('session-1'), entry('entry-2'), 2), false);
  assert.equal(model.patchAfterAppend(session('session-1'), entry('entry-2'), 3), true);
  assert.deepEqual(model.readEntries('session-1').snapshot?.map((value) => value.id), ['entry-2', 'entry-1']);
  assert.equal(model.readSessions(50).snapshot?.filter((value) => value.id === 'session-1').length, 1);
});

test('clear and operator advance fence late success and rejection', async () => {
  let epoch = 7;
  const success = deferred<AuditSession[]>();
  const model = createAuditReadModel({
    loadSessions: () => success.promise,
    loadEntries: async () => [],
    loadDeltas: async () => [],
    getOperatorSessionEpoch: () => epoch,
    isOperatorSessionEpochCurrent: (candidate) => candidate === epoch,
    now: () => 100,
  });
  const oldLoad = model.revalidateSessions(50);
  epoch = 8;
  model.clear();
  success.resolve([session('old-user')]);
  await assert.rejects(oldLoad, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(model.readSessions(50).snapshot, null);
  assert.equal(model.readSessions(50).lastError, null);

  const failed = deferred<AuditSession[]>();
  const second = createAuditReadModel({
    loadSessions: () => failed.promise,
    loadEntries: async () => [],
    loadDeltas: async () => [],
    getOperatorSessionEpoch: () => epoch,
    isOperatorSessionEpochCurrent: (candidate) => candidate === epoch,
    now: () => 100,
  });
  const oldFailure = second.revalidateSessions(50);
  epoch = 9;
  failed.reject(new Error('old operator details'));
  await assert.rejects(oldFailure, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(second.readSessions(50).lastError, null);
});
