import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const tempDir = mkdtempSync(path.join(tmpdir(), 'operational-commit-test-'));
const moduleNames = ['operationalScheduleContract', 'operatorSessionCacheRegistry', 'operationalScheduleAdapter'];
const originalNodePath = process.env.NODE_PATH;
const originalWindow = globalThis.window;
const originalBoundary = (globalThis as Record<string, unknown>).__operationalRecoveryRpc;

process.env.NODE_PATH = path.join(appRoot, 'node_modules');
require('node:module').Module._initPaths();
writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');

for (const name of moduleNames) {
  const source = readFileSync(path.join(appRoot, 'src/lib', `${name}.ts`), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: `${name}.ts`,
  });
  writeFileSync(path.join(tempDir, `${name}.js`), output.outputText);
}
writeFileSync(
  path.join(tempDir, 'remoteStore.js'),
  'module.exports = new Proxy({}, { get: (_target, prop) => globalThis.__operationalRecoveryRpc?.[prop] });\n'
);

const loadAdapter = () => {
  for (const name of [...moduleNames, 'remoteStore']) {
    delete require.cache[path.join(tempDir, `${name}.js`)];
  }
  return require(path.join(tempDir, 'operationalScheduleAdapter.js'));
};

const storage = (data: Map<string, string>) => ({
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, String(value)); },
  removeItem: (key: string) => { data.delete(key); },
  clear: () => { data.clear(); },
});

const authKey = 'seasonal-management-supabase-auth-token';
const testOperatorId = '00000000-0000-4000-8000-000000000001';
const ownerSession = JSON.stringify({ user: { id: testOperatorId } });

test.after(() => {
  if (originalNodePath !== undefined) {
    process.env.NODE_PATH = originalNodePath;
  } else {
    delete process.env.NODE_PATH;
  }
  require('node:module').Module._initPaths();

  if (originalWindow !== undefined) {
    globalThis.window = originalWindow;
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }

  if (originalBoundary !== undefined) {
    (globalThis as Record<string, unknown>).__operationalRecoveryRpc = originalBoundary;
  } else {
    delete (globalThis as Record<string, unknown>).__operationalRecoveryRpc;
  }

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

function setupTestEnvironment() {
  const localJournal = new Map<string, string>();
  localJournal.set(authKey, ownerSession);
  const sessionJournal = new Map<string, string>();

  globalThis.window = {
    localStorage: storage(localJournal) as unknown as Storage,
    sessionStorage: storage(sessionJournal) as unknown as Storage,
  } as unknown as Window & typeof globalThis;

  const adapter = loadAdapter();
  adapter.useOperationalScheduleStore.getState().reset();
  return adapter;
}

test('commitOperationalResourceBatch: transport error triggers bounded retry (at most 1) and releases mutating while preserving journal', async () => {
  let callCount = 0;
  const calls: unknown[] = [];

  (globalThis as Record<string, unknown>).__operationalRecoveryRpc = {
    applyOperationalResourceChangesV1: async (input: unknown) => {
      callCount += 1;
      calls.push(structuredClone(input));
      throw new TypeError('Failed to fetch: network disconnected');
    },
    getOperationalScheduleAllocationWindowV1: async () => {
      throw new Error('Unused');
    },
  };

  const adapter = setupTestEnvironment();

  const changes = [
    { legId: 'leg-1', expected: { counter: null }, patch: { counter: '10' } },
  ];
  const expectedRevision = '5';
  const requestId = 'req-test-bounded-1';

  await assert.rejects(
    adapter.commitOperationalResourceBatch({ changes, expectedRevision, requestId }),
    /Failed to fetch/,
    'Should propagate transport error without looping indefinitely'
  );

  // Verification 1: Exactly 2 calls (initial + 1 automatic retry), NO while(true) loop!
  assert.equal(callCount, 2, 'Must perform at most 1 automatic retry on transport failure (2 calls total)');

  // Verification 2: Active mutating is released
  const state = adapter.useOperationalScheduleStore.getState();
  assert.equal(state.mutating, false, 'Active mutating must be released after retry failure');

  // Verification 3: unresolvedAttempt is preserved in journal with exact parameters
  assert.ok(state.unresolvedAttempt, 'Journal must preserve unconfirmed attempt');
  assert.equal(state.unresolvedAttempt?.requestId, requestId);
  assert.equal(state.unresolvedAttempt?.expectedRevision, expectedRevision);
  assert.equal(state.unresolvedAttempt?.serializedPayload, JSON.stringify(changes));
});

test('commitOperationalResourceBatch: rejects overlapping writes while unresolvedAttempt exists', async () => {
  (globalThis as Record<string, unknown>).__operationalRecoveryRpc = {
    applyOperationalResourceChangesV1: async () => {
      throw new Error('Connection refused');
    },
  };

  const adapter = setupTestEnvironment();

  const changes = [
    { legId: 'leg-1', expected: { counter: null }, patch: { counter: '10' } },
  ];

  await assert.rejects(
    adapter.commitOperationalResourceBatch({ changes, expectedRevision: '5', requestId: 'req-first' }),
    /Connection refused/
  );

  // A second different commit while the previous is unresolved MUST be rejected
  const overlappingChanges = [
    { legId: 'leg-2', expected: { counter: null }, patch: { counter: '20' } },
  ];

  await assert.rejects(
    adapter.commitOperationalResourceBatch({ changes: overlappingChanges, expectedRevision: '5', requestId: 'req-second' }),
    /Thao tác vận hành trước đó chưa được xác nhận/,
    'Overlapping write must be rejected while unresolvedAttempt exists'
  );
});

test('retryPendingMutation: recovers unconfirmed write with identical requestId', async () => {
  let callCount = 0;
  let succeedOnRetry = false;

  (globalThis as Record<string, unknown>).__operationalRecoveryRpc = {
    applyOperationalResourceChangesV1: async () => {
      callCount += 1;
      if (!succeedOnRetry) {
        throw new Error('Network timeout');
      }
      return {
        status: 'committed',
        revision: '6',
        processedLegs: 1,
      };
    },
    getOperationalScheduleAllocationWindowV1: async () => ({
      status: 'ok',
      snapshot: { revision: '6', token: 'tok-6' },
      records: [],
      resources: {},
      page: { returnedCount: 0, hasMore: false, nextCursor: null },
    }),
  };

  const adapter = setupTestEnvironment();

  const changes = [
    { legId: 'leg-1', expected: { counter: null }, patch: { counter: '10' } },
  ];
  const requestId = 'req-banner-retry-1';

  await assert.rejects(
    adapter.commitOperationalResourceBatch({ changes, expectedRevision: '5', requestId }),
    /Network timeout/
  );
  assert.equal(callCount, 2);

  // User clicks "Thử lại" on existing warning banner
  succeedOnRetry = true;
  const outcome = await adapter.useOperationalScheduleStore.getState().retryPendingMutation();

  assert.ok(outcome && 'receipt' in outcome, 'Outcome with receipt should be returned');
  assert.equal(outcome.receipt.status, 'committed');
  assert.equal(outcome.receipt.revision, '6');

  // Total calls: 2 initial + 1 banner retry = 3 calls
  assert.equal(callCount, 3);
  assert.equal(adapter.useOperationalScheduleStore.getState().unresolvedAttempt, null, 'Journal cleared after recovery');
  assert.equal(adapter.useOperationalScheduleStore.getState().mutating, false, 'Mutating released after recovery');
  assert.equal(adapter.useOperationalScheduleStore.getState().snapshot.revision, '6', 'Snapshot updated to recovered revision');
});

test('commitOperationalResourceBatch: SQL authoritative rejection clears journal immediately without retrying', async () => {
  let callCount = 0;

  const sqlError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });

  (globalThis as Record<string, unknown>).__operationalRecoveryRpc = {
    applyOperationalResourceChangesV1: async () => {
      callCount += 1;
      throw sqlError;
    },
    getOperationalScheduleAllocationWindowV1: async () => ({
      status: 'ok',
      snapshot: { revision: '5', token: 'tok-5' },
      records: [],
      resources: {},
      page: { returnedCount: 0, hasMore: false, nextCursor: null },
    }),
  };

  const adapter = setupTestEnvironment();

  const changes = [
    { legId: 'leg-1', expected: { counter: null }, patch: { counter: '10' } },
  ];

  await assert.rejects(
    adapter.commitOperationalResourceBatch({ changes, expectedRevision: '5', requestId: 'req-sql-rej' }),
    (err: unknown) => adapter.isAuthoritativeSqlRejection(err) === true
  );

  // Authoritative SQL rejection must NOT retry (only 1 call)
  assert.equal(callCount, 1, 'Authoritative SQL rejection must not retry');
  assert.equal(adapter.useOperationalScheduleStore.getState().unresolvedAttempt, null, 'Journal must be cleared on SQL rejection');
  assert.equal(adapter.useOperationalScheduleStore.getState().mutating, false, 'Mutating must be released');
});
