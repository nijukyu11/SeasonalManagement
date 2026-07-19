import assert from 'node:assert/strict';
import test from 'node:test';

import { runSeasonalImportV2DbTest } from './run-seasonal-import-v2-db-test.mjs';
import {
  parseDisposableDatabaseConfig,
  verifyDatabaseIdentityOrClose,
} from './seasonal-test-database-guard.mjs';

const validEnvironment = {
  SEASONAL_TEST_DATABASE_URL:
    'postgresql://task11_user:test-only@127.0.0.1:5432/seasonal_task11_fake_identity',
  SEASONAL_TEST_TEMP_DB: '1',
};

function fakePsql(identityOutput) {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) {
      return { status: 0, stdout: identityOutput, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawnSyncImpl };
}

function invokedSqlFile(calls) {
  return calls.some(({ args }) => args.includes('--file'));
}

for (const identityOutput of [
  'f\n',
  'seasonal_task11_wrong_database\n',
  '',
  'seasonal_task11_fake_identity\nextra-output\n',
]) {
  test(`identity output ${JSON.stringify(identityOutput)} stops before schema`, () => {
    const fake = fakePsql(identityOutput);
    assert.throws(
      () => runSeasonalImportV2DbTest({
        env: validEnvironment,
        spawnSyncImpl: fake.spawnSyncImpl,
      }),
      /database identity/i,
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(invokedSqlFile(fake.calls), false);
  });
}

test('exact database identity allows schema, migration, SQL, and concurrency invocations', () => {
  const fake = fakePsql('seasonal_task11_fake_identity\r\n');
  runSeasonalImportV2DbTest({ env: validEnvironment, spawnSyncImpl: fake.spawnSyncImpl });

  assert.deepEqual(fake.calls[0].args.slice(-4), [
    '--tuples-only',
    '--no-align',
    '--command',
    'select current_database()',
  ]);
  assert.equal(invokedSqlFile(fake.calls), true);
  assert.equal(fake.calls.filter(({ args }) => args.includes('--file')).length, 3);
});

test('unsafe database namespace is rejected before psql starts', () => {
  const fake = fakePsql('postgres\n');
  assert.throws(
    () => runSeasonalImportV2DbTest({
      env: {
        ...validEnvironment,
        SEASONAL_TEST_DATABASE_URL: 'postgresql://task11_user:test-only@127.0.0.1/postgres',
      },
      spawnSyncImpl: fake.spawnSyncImpl,
    }),
    /database name/i,
  );
  assert.equal(fake.calls.length, 0);
});

test('concurrency guard rejects missing marker, non-local host, and bad namespace', () => {
  assert.throws(
    () => parseDisposableDatabaseConfig({
      SEASONAL_TEST_DATABASE_URL: validEnvironment.SEASONAL_TEST_DATABASE_URL,
    }),
    /SEASONAL_TEST_TEMP_DB=1/,
  );
  assert.throws(
    () => parseDisposableDatabaseConfig({
      ...validEnvironment,
      SEASONAL_TEST_DATABASE_URL:
        'postgresql://task11_user:test-only@database.internal/seasonal_task11_fake_identity',
    }),
    /localhost/i,
  );
  assert.throws(
    () => parseDisposableDatabaseConfig({
      ...validEnvironment,
      SEASONAL_TEST_DATABASE_URL: 'postgresql://task11_user:test-only@localhost/supabase',
    }),
    /database name/i,
  );
});

test('concurrency identity mismatch closes the client before aborting', async () => {
  let closed = false;
  const client = {
    async query() {
      return { rows: [{ database_name: 'seasonal_task11_wrong_database' }] };
    },
    async end() {
      closed = true;
    },
  };

  await assert.rejects(
    verifyDatabaseIdentityOrClose(client, 'seasonal_task11_fake_identity'),
    /identity mismatch/i,
  );
  assert.equal(closed, true);
});

test('concurrency exact identity succeeds without closing the client', async () => {
  let closed = false;
  const client = {
    async query() {
      return { rows: [{ database_name: 'seasonal_task11_fake_identity' }] };
    },
    async end() {
      closed = true;
    },
  };

  const identity = await verifyDatabaseIdentityOrClose(
    client,
    'seasonal_task11_fake_identity',
  );
  assert.equal(identity, 'seasonal_task11_fake_identity');
  assert.equal(closed, false);
});
