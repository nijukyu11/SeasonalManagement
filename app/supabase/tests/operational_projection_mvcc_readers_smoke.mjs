/**
 * Reproducible multi-connection real PostgreSQL smoke test for MVCC Projection Refresh.
 *
 * Guarantees and Proves:
 * 1. Database safety: fails closed via parseDisposableDatabaseConfig and verifyDatabaseIdentityOrClose.
 * 2. Gate ON authority: tests reader on reporting.canonical_flight_legs comparing full row datasets.
 * 3. MVCC non-blocking reader: await refresh query directly inside open transaction, then reader
 *    queries before COMMIT. Zero sleeps, zero advisory lock barriers.
 * 4. Reader sees complete old generation row data while writer is uncommitted.
 * 5. Concurrent writer attempting FOR UPDATE on operational_workspace_revision rejects with
 *    SQLSTATE 55P03 (lock_timeout) while refresh holds FOR SHARE.
 * 6. After COMMIT, reader sees complete new generation row data.
 * 7. After COMMIT, second writer acquires FOR UPDATE successfully.
 *
 * Usage:
 *   SEASONAL_TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/seasonal_task11_test" \
 *   SEASONAL_TEST_TEMP_DB=1 \
 *   node app/supabase/tests/operational_projection_mvcc_readers_smoke.mjs
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import {
  parseDisposableDatabaseConfig,
  verifyDatabaseIdentityOrClose,
} from '../../scripts/seasonal-test-database-guard.mjs';
import {
  ensureDisposableDatabase,
  bootstrapDatabaseIfNeeded,
  waitForObservedLock,
} from './disposable_postgres_harness.mjs';

const { Client } = pg;

// Enforce disposable database safety
const databaseConfig = parseDisposableDatabaseConfig(process.env);
const connectionString = databaseConfig.connectionString;
const expectedDatabaseName = databaseConfig.databaseName;

const clientOptions = {
  connectionString,
  statement_timeout: 30_000,
};

async function fetchCanonicalFlightLegs(client) {
  const result = await client.query(`
    select
      business_leg_key,
      ops_date::text,
      type,
      airline,
      flight_number,
      route,
      aircraft_type,
      flight_category,
      pax,
      local_minutes,
      scheduled_local_at::text
    from reporting.canonical_flight_legs
    order by business_leg_key;
  `);
  return result.rows;
}

async function runSmoke() {
  await ensureDisposableDatabase(process.env);

  const adminClient = new Client(clientOptions);
  await adminClient.connect();
  await verifyDatabaseIdentityOrClose(adminClient, expectedDatabaseName);
  await bootstrapDatabaseIfNeeded(adminClient);

  const writerClient = new Client(clientOptions);
  const readerClient = new Client(clientOptions);
  const secondWriterClient = new Client(clientOptions);

  await writerClient.connect();
  await readerClient.connect();
  await secondWriterClient.connect();

  await verifyDatabaseIdentityOrClose(writerClient, expectedDatabaseName);
  await verifyDatabaseIdentityOrClose(readerClient, expectedDatabaseName);
  await verifyDatabaseIdentityOrClose(secondWriterClient, expectedDatabaseName);

  console.log(`Connected & verified 4 clients on disposable database: ${expectedDatabaseName}`);

  const testBatchTag = randomUUID().slice(0, 8);
  const opsDate1 = '2026-11-10';
  const opsDate2 = '2026-11-11';

  try {
    // 1. Activate reader cutover gate so canonical_flight_legs is the shared reader surface
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');
    await adminClient.query(`select reporting.cutover_operational_readers_v1('smoke-operator-${testBatchTag}');`);
    const isCutover = (await adminClient.query('select reporting.is_operational_reader_cutover_active_v1() as active;')).rows[0].active;
    assert.equal(isCutover, true, 'Reader cutover gate is active');

    // 2. Seed initial isolated Generation 1 legs in operational_flight_legs
    const gen1LegId = randomUUID();
    await adminClient.query(`
      insert into public.operational_flight_legs (
        leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
        side, airline, flight_number, route, aircraft_type, source_type, status, pax, flight_category
      ) values
        ($1, 'A\x1f2026-11-10\x1fVN\x1fVN701', $2, $2, '10:00:00', 'ARR', 'VN', 'VN701', 'HAN-SGN', 'A321', 'operational_manual', 'active', 150, 'C')
      on conflict (leg_id) do nothing;
    `, [gen1LegId, opsDate1]);

    // Initial full refresh to establish Generation 1 baseline
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');
    const initialCanonicalRows = await fetchCanonicalFlightLegs(adminClient);
    assert.ok(initialCanonicalRows.length >= 1, 'Initial canonical rows present');
    const gen1Target = initialCanonicalRows.find((r) => r.flight_number === 'VN701' && r.ops_date === opsDate1);
    assert.ok(gen1Target, 'VN701 present in initial canonical store');
    console.log(`✓ Initial Generation 1 established (${initialCanonicalRows.length} canonical rows)`);

    // 3. Mutate source table with Generation 2 data (add VN702 on opsDate2)
    const gen2LegId = randomUUID();
    await adminClient.query(`
      insert into public.operational_flight_legs (
        leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
        side, airline, flight_number, route, aircraft_type, source_type, status, pax, flight_category
      ) values
        ($1, 'A\x1f2026-11-11\x1fVN\x1fVN702', $2, $2, '14:00:00', 'ARR', 'VN', 'VN702', 'SGN-HAN', 'A350', 'operational_manual', 'active', 280, 'C');
    `, [gen2LegId, opsDate2]);

    // 4. Writer begins transaction and runs full refresh
    // The refresh executes DELETE + INSERT inside the transaction, but DOES NOT COMMIT YET.
    await writerClient.query('begin;');
    await writerClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');
    const expectedNewGeneration = await fetchCanonicalFlightLegs(writerClient);
    const writerPid = (await writerClient.query('select pg_backend_pid() as pid;')).rows[0].pid;
    await waitForObservedLock(adminClient, writerPid, 'operational_workspace_revision', 10_000);
    console.log('✓ Writer executed full refresh; observed RowShareLock active in pg_locks');
    // 5. Concurrent Reader queries while writer transaction is open
    // Proves:
    // a) Reader query completes immediately (not blocked by AccessExclusiveLock).
    // b) Reader sees complete Generation 1 rows (not empty, not Generation 2).
    await readerClient.query("set statement_timeout = '2s'");
    const midFlightCanonicalRows = await fetchCanonicalFlightLegs(readerClient);
    assert.deepEqual(
      midFlightCanonicalRows,
      initialCanonicalRows,
      'Concurrent reader sees complete old generation row data while writer is uncommitted'
    );
    console.log('✓ Concurrent reader verified: complete old generation rows observed without blocking');

    // 6. Concurrent Writer contention on operational_workspace_revision
    // While refresh holds FOR SHARE, a second writer attempting FOR UPDATE must wait and reject on lock_timeout
    await secondWriterClient.query('begin;');
    await secondWriterClient.query("set local lock_timeout = '200ms';");
    await assert.rejects(
      async () => {
        await secondWriterClient.query(
          'select revision from public.operational_workspace_revision where singleton for update;'
        );
      },
      (err) => err.code === '55P03',
      'Concurrent writer rejected with 55P03 lock_timeout while refresh holds FOR SHARE'
    );
    await secondWriterClient.query('rollback;');
    console.log('✓ Concurrent writer bounded contention verified: rejected with SQLSTATE 55P03');

    // 7. Writer commits
    await writerClient.query('commit;');
    console.log('✓ Writer transaction committed');

    // 8. Concurrent Reader queries after commit
    // Proves reader sees complete Generation 2 rows immediately after commit
    const postCommitCanonicalRows = await fetchCanonicalFlightLegs(readerClient);
    assert.deepEqual(postCommitCanonicalRows, expectedNewGeneration, 'Reader sees the complete committed generation');
    const gen2Target = postCommitCanonicalRows.find((r) => r.flight_number === 'VN702' && r.ops_date === opsDate2);
    assert.ok(gen2Target, 'VN702 present in canonical store after commit');
    assert.equal(gen2Target.pax, 280, 'VN702 pax matches Generation 2 payload');
    console.log('✓ Reader post-commit verified: complete new generation rows observed');

    // 9. Second writer succeeds now that the share lock is released
    await secondWriterClient.query('begin;');
    await secondWriterClient.query("set local lock_timeout = '5s';");
    const writerLockAcquired = await secondWriterClient.query(
      'select revision from public.operational_workspace_revision where singleton for update;'
    );
    assert.equal(writerLockAcquired.rows.length, 1, 'Second writer acquired revision lock after commit');
    await secondWriterClient.query('rollback;');
    console.log('✓ Second writer verified: acquired FOR UPDATE successfully after refresh commit');

    console.log('\nAll Multi-Connection Real PostgreSQL Smoke Assertions PASSED.');
  } finally {
    await Promise.all([adminClient, writerClient, secondWriterClient].map(client => client.query('rollback').catch(() => {})));
    await adminClient.end();
    await writerClient.end();
    await readerClient.end();
    await secondWriterClient.end();
  }
}

runSmoke().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
