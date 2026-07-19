import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupTestPrincipals,
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
