import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupTestPrincipals,
  createTestPrincipals,
  removeBatchAndSeason,
  runWithCleanupAndClose,
} from './seasonal-import-v2-load-test.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SEASON_ID = 'season-task11-cleanup';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

function operationName(sql) {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized === 'begin') return 'begin';
  if (normalized === 'commit') return 'commit';
  if (normalized === 'rollback') return 'rollback';
  if (normalized === 'reset role') return 'reset-role';
  if (normalized.startsWith('set local role')) return 'set-role';
  if (normalized.includes("set_config('request.jwt.claim.sub'")) return 'set-user';
  if (normalized.startsWith('select distinct season_id')) return 'select-seasons';
  if (normalized.includes('manage_season_metadata_v2')) return 'delete-season';
  if (normalized.startsWith('delete from public.season_import_batches')) return 'delete-batches';
  if (normalized.startsWith('delete from public.app_operator_permission_overrides')) return 'delete-permissions';
  if (normalized.startsWith('delete from public.app_operators')) return 'delete-operators';
  if (normalized.startsWith('delete from auth.users')) return 'delete-users';
  return normalized;
}

function createMockClient({ failSeasonDelete = false, failEnd = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      const name = operationName(sql);
      calls.push(name);
      if (name === 'select-seasons') return { rows: [{ season_id: SEASON_ID }] };
      if (name === 'delete-season' && failSeasonDelete) {
        throw new Error('mock season delete failed');
      }
      return { rows: [] };
    },
    async end() {
      calls.push('end');
      if (failEnd) throw new Error('mock client end failed');
    },
  };
}

function createPrincipalMockClient({ failOnInsert = null } = {}) {
  const calls = [];
  const persistedRows = [];
  let pendingRows = [];
  let transactionOpen = false;
  let insertCount = 0;

  return {
    calls,
    persistedRows,
    async query(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized === 'begin') {
        calls.push('begin');
        transactionOpen = true;
        return { rows: [] };
      }
      if (normalized === 'commit') {
        calls.push('commit');
        persistedRows.push(...pendingRows);
        pendingRows = [];
        transactionOpen = false;
        return { rows: [] };
      }
      if (normalized === 'rollback') {
        calls.push('rollback');
        pendingRows = [];
        transactionOpen = false;
        return { rows: [] };
      }

      let insertKind;
      if (normalized.startsWith('insert into auth.users')) insertKind = 'insert-auth';
      if (normalized.startsWith('insert into public.app_operators')) insertKind = 'insert-operator';
      if (normalized.startsWith('insert into public.app_operator_permission_overrides')) {
        insertKind = 'insert-permission';
      }
      if (!insertKind) throw new Error(`Unexpected principal query: ${normalized}`);

      calls.push(insertKind);
      insertCount += 1;
      if (insertCount === failOnInsert) throw new Error('mock principal creation failed');
      if (transactionOpen) pendingRows.push(insertKind);
      else persistedRows.push(insertKind);
      return { rows: [] };
    },
    async end() {
      calls.push('end');
    },
  };
}

test('mid-creation failure rolls back partial principals and still closes', async () => {
  const client = createPrincipalMockClient({ failOnInsert: 7 });
  let principals;
  let cleanupCalls = 0;

  await assert.rejects(
    runWithCleanupAndClose({
      run: async () => {
        principals = await createTestPrincipals(client);
      },
      cleanup: async () => {
        if (principals) cleanupCalls += 1;
      },
      close: () => client.end(),
    }),
    /mock principal creation failed/,
  );

  assert.equal(principals, undefined, 'principal IDs must not escape a failed transaction');
  assert.equal(cleanupCalls, 0, 'cleanup cannot identify principals before a successful commit');
  assert.equal(client.persistedRows.length, 0, 'rollback must leave no partial principal row');
  assert.deepEqual(client.calls, [
    'begin',
    'insert-auth',
    'insert-operator',
    'insert-permission',
    'insert-permission',
    'insert-permission',
    'insert-auth',
    'insert-operator',
    'rollback',
    'end',
  ]);
});

test('successful principal creation commits before IDs escape and client closes', async () => {
  const client = createPrincipalMockClient();
  let principals;
  await runWithCleanupAndClose({
    run: async () => {
      principals = await createTestPrincipals(client);
    },
    cleanup: async () => {
      assert.equal(client.calls.at(-1), 'commit');
      client.calls.push('cleanup');
    },
    close: () => client.end(),
  });

  assert.match(principals.primaryUserId, /^[0-9a-f-]{36}$/);
  assert.match(principals.secondaryUserId, /^[0-9a-f-]{36}$/);
  assert.notEqual(principals.primaryUserId, principals.secondaryUserId);
  assert.equal(client.persistedRows.length, 10);
  assert.deepEqual(client.calls, [
    'begin',
    'insert-auth',
    'insert-operator',
    'insert-permission',
    'insert-permission',
    'insert-permission',
    'insert-auth',
    'insert-operator',
    'insert-permission',
    'insert-permission',
    'insert-permission',
    'commit',
    'cleanup',
    'end',
  ]);
});

test('principal cleanup rolls back and closes when season deletion fails', async () => {
  const client = createMockClient({ failSeasonDelete: true });
  await assert.rejects(
    runWithCleanupAndClose({
      run: async () => 'completed',
      cleanup: () => cleanupTestPrincipals(client, [USER_ID]),
      close: () => client.end(),
    }),
    /mock season delete failed/,
  );

  assert.deepEqual(client.calls, [
    'begin',
    'select-seasons',
    'delete-batches',
    'set-role',
    'set-user',
    'delete-season',
    'rollback',
    'end',
  ]);
});

test('successful principal cleanup commits before closing the client', async () => {
  const client = createMockClient();
  await runWithCleanupAndClose({
    run: async () => 'completed',
    cleanup: () => cleanupTestPrincipals(client, [USER_ID]),
    close: () => client.end(),
  });

  assert.deepEqual(client.calls, [
    'begin',
    'select-seasons',
    'delete-batches',
    'set-role',
    'set-user',
    'delete-season',
    'reset-role',
    'delete-permissions',
    'delete-operators',
    'delete-users',
    'commit',
    'end',
  ]);
});

test('batch deletion rolls back when season deletion fails', async () => {
  const client = createMockClient({ failSeasonDelete: true });
  await assert.rejects(
    removeBatchAndSeason(client, USER_ID, BATCH_ID, SEASON_ID),
    /mock season delete failed/,
  );
  assert.deepEqual(client.calls, [
    'begin',
    'delete-batches',
    'set-role',
    'set-user',
    'delete-season',
    'rollback',
  ]);
});

test('primary, cleanup, and close failures are all preserved', async () => {
  const primary = new Error('primary failed');
  const cleanup = new Error('cleanup failed');
  const close = new Error('close failed');

  await assert.rejects(
    runWithCleanupAndClose({
      run: async () => { throw primary; },
      cleanup: async () => { throw cleanup; },
      close: async () => { throw close; },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup, close]);
      return true;
    },
  );
});
