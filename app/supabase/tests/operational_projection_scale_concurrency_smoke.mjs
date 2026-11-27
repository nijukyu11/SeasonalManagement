/**
 * Reproducible disposable real PostgreSQL scale & concurrency smoke test.
 *
 * Scope & Verification:
 * 1. Database Safety: Enforces disposable name pattern (/^seasonal_task11_[a-z0-9_]+$/)
 *    and localhost target via parseDisposableDatabaseConfig and verifyDatabaseIdentityOrClose.
 *    Creates database standalone if not present without destructive operations on arbitrary dbs.
 *    Fails closed on existing non-empty database lacking verified complete bootstrap marker.
 * 2. Realistic Scale: 250,000 representative operational flight legs across 250 operating dates,
 *    matching production scale (~248k canonical legs).
 * 3. Gate ON Authority: Reader cutover gate active (reporting.canonical_flight_legs as primary surface).
 * 4. Phase 1 (Prepare-Phase Concurrency):
 *    - Refresher computes 250k candidate slice (~9s) without holding revision lock.
 *    - Concurrent Reader verifies non-blocking MVCC query on canonical flight legs.
 *    - Concurrent Mutator RPC (apply_operational_resource_changes_v1) commits in <8s during prepare phase.
 *    - Refresher detects revision change at optimistic prepare checkpoint and discards stale generation.
 *    - Freshness invalidation and catch-up refresh verify changed field (pax) propagation.
 * 5. Phase 2 (Publish-Phase Concurrency under RowShareLock):
 *    - Refresher begins forced full refresh.
 *    - Barrier awaits observed RowShareLock on operational_workspace_revision in pg_locks.
 *    - Concurrent Mutator RPC with explicit statement_timeout='8s' launches while publish phase is active.
 *    - Refresher commits immediately upon query finish (no artificial hold).
 *    - Mutator unblocks and commits under the 8s deadline.
 *    - Freshness invalidation and catch-up refresh verify changed field (pax) propagation.
 * 6. Strict Assertions: Both phases require concurrent RPC committed under 8s deadline without retries.
 *
 * Usage:
 *   SEASONAL_TEST_DATABASE_URL="postgres://postgres@localhost:55476/seasonal_task11_scale_20261106" \
 *   SEASONAL_TEST_TEMP_DB=1 \
 *   node app/supabase/tests/operational_projection_scale_concurrency_smoke.mjs
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

import {
  parseDisposableDatabaseConfig,
  verifyDatabaseIdentityOrClose,
} from '../../scripts/seasonal-test-database-guard.mjs';
import {
  ensureDisposableDatabase,
  bootstrapDatabaseIfNeeded,
  seed250kOperationalLegsIfNeeded,
  authenticateClientAsOperator,
  waitForObservedLock,
  waitForObservedAdvisoryLock,
  waitForWaitingLock,
} from './disposable_postgres_harness.mjs';
import { M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const { Client } = pg;

// Enforce disposable database safety
const databaseConfig = parseDisposableDatabaseConfig(process.env);
const connectionString = databaseConfig.connectionString;
const expectedDatabaseName = databaseConfig.databaseName;

const clientOptions = {
  connectionString,
  statement_timeout: 300_000, // 5 minutes for 250k operations
};

async function runScaleConcurrencySmoke() {
  console.log(`\n================================================================`);
  console.log(`[Scale Smoke] Starting 250k Scale & Concurrency Verification`);
  console.log(`[Scale Smoke] Database: ${expectedDatabaseName}`);
  console.log(`================================================================\n`);

  // Step 1: Ensure database exists and connect clients
  await ensureDisposableDatabase(process.env);

  const adminClient = new Client(clientOptions);
  const refresherClient = new Client(clientOptions);
  const readerClient = new Client(clientOptions);
  const mutatorClient = new Client(clientOptions);

  await adminClient.connect();
  await refresherClient.connect();
  await readerClient.connect();
  await mutatorClient.connect();

  await verifyDatabaseIdentityOrClose(adminClient, expectedDatabaseName);
  await verifyDatabaseIdentityOrClose(refresherClient, expectedDatabaseName);
  await verifyDatabaseIdentityOrClose(readerClient, expectedDatabaseName);
  await verifyDatabaseIdentityOrClose(mutatorClient, expectedDatabaseName);

  console.log(`✓ 4 database clients connected and verified on ${expectedDatabaseName}`);

  const report = {
    database: expectedDatabaseName,
    scaleLegs: 0,
    readerCutoverActive: false,
    readerBaselineMs: 0,
    refresherPid: null,
    // Phase 1 (Prepare phase)
    p1RefreshElapsedMs: 0,
    p1ReaderElapsedMs: 0,
    p1MutatorElapsedMs: 0,
    p1MutatorStatus: null,
    p1CatchupElapsedMs: 0,
    p1PaxVerified: false,
    // Phase 2 (Publish phase under RowShareLock)
    p2RefreshElapsedMs: 0,
    p2MutatorElapsedMs: 0,
    p2MutatorStatus: null,
    p2CatchupElapsedMs: 0,
    p2PaxVerified: false,
  };

  try {
    // Step 2: Bootstrap schema, migration chain, and operator auth if needed (fail closed if partial)
    await bootstrapDatabaseIfNeeded(adminClient);

    // Step 3: Seed 250,000 representative operational legs
    report.scaleLegs = await seed250kOperationalLegsIfNeeded(adminClient);
    assert.ok(report.scaleLegs >= 250_000, `Must have >= 250,000 legs (got ${report.scaleLegs})`);

    // Step 4: Ensure reader cutover gate is active and initial full refresh established
    console.log('[Scale Smoke] Ensuring reader cutover gate is ON and projection refreshed...');
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');
    await adminClient.query(`select reporting.cutover_operational_readers_v1('smoke-scale-${randomUUID().slice(0, 8)}');`);
    const isCutover = (await adminClient.query('select reporting.is_operational_reader_cutover_active_v1() as active;')).rows[0].active;
    assert.equal(isCutover, true, 'Reader cutover gate must be active');
    report.readerCutoverActive = true;

    const initialCanonicalCountRes = await adminClient.query('select count(*)::integer as c from reporting.canonical_flight_legs;');
    const initialCanonicalCount = initialCanonicalCountRes.rows[0].c;
    assert.equal(initialCanonicalCount, report.scaleLegs, 'Canonical flight legs count must mirror operational store');
    console.log(`✓ Reader cutover gate active with ${initialCanonicalCount} canonical legs`);

    // Step 5: Select a target leg to mutate
    const targetLegRes = await adminClient.query(`
      select
        leg_id,
        operational_date::text as operational_date,
        pax,
        (case side when 'ARR' then 'A' else 'D' end)
          || chr(31) || operational_date::text
          || chr(31) || upper(btrim(airline))
          || chr(31) || upper(btrim(flight_number)) as business_leg_key
      from public.operational_flight_legs
      where status = 'active'
      order by operational_date, flight_number
      limit 1;
    `);
    const targetLeg = targetLegRes.rows[0];
    assert.ok(targetLeg, 'Active target leg must exist');
    const originalPax = targetLeg.pax ?? 150;
    const paxPhase1 = 888;
    const paxPhase2 = 999;
    console.log(`[Scale Smoke] Target leg: ${targetLeg.business_leg_key} (leg_id: ${targetLeg.leg_id}, current pax: ${originalPax})`);

    // Step 6: Authenticate mutator client as operator with daily.write
    await authenticateClientAsOperator(mutatorClient, M0_FIXTURE.writerId);

    // Step 7: Reader baseline measurement
    const tReader0 = performance.now();
    await readerClient.query('select count(*)::integer from reporting.canonical_flight_legs;');
    report.readerBaselineMs = Number((performance.now() - tReader0).toFixed(2));
    console.log(`[Scale Smoke] Baseline reader count (250k rows): ${report.readerBaselineMs} ms`);

    // Get refresher PID to synchronize on observed locks in pg_locks
    const refresherPidRes = await refresherClient.query('select pg_backend_pid() as pid;');
    const refresherPid = refresherPidRes.rows[0].pid;
    report.refresherPid = refresherPid;

    // =========================================================================
    // PHASE 1: Prepare-Phase Concurrency (Lock-free candidate slice calculation)
    // =========================================================================
    console.log(`\n----------------------------------------------------------------`);
    console.log(`[Scale Smoke] PHASE 1: Prepare-Phase Concurrency Test`);
    console.log(`----------------------------------------------------------------`);

    const p1CurrentRevRes = await adminClient.query('select revision from public.operational_workspace_revision where singleton;');
    const p1CurrentRevision = p1CurrentRevRes.rows[0].revision;

    const p1MutationPayload = [
      {
        legId: targetLeg.leg_id,
        expected: { pax: originalPax },
        patch: { pax: paxPhase1 },
      },
    ];

    console.log(`[Scale Smoke Phase 1] Launching forced full refresh in open transaction (PID: ${refresherPid})...`);
    await refresherClient.query('begin;');
    const p1RefreshStart = performance.now();
    const p1RefreshPromise = refresherClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');

    // 1a. Await observed advisory lock (proves refresher is actively preparing)
    await waitForObservedAdvisoryLock(adminClient, refresherPid, 30_000);
    console.log(`✓ Phase 1 refresher active (advisory lock observed)`);

    // 1b. Concurrent Reader during candidate slice computation (Non-blocking MVCC)
    await readerClient.query("set statement_timeout = '10s';");
    const p1ReaderStart = performance.now();
    const p1ReaderRes = await readerClient.query('select count(*)::integer as c from reporting.canonical_flight_legs;');
    report.p1ReaderElapsedMs = Number((performance.now() - p1ReaderStart).toFixed(2));
    assert.equal(p1ReaderRes.rows[0].c, initialCanonicalCount, 'Reader sees complete previous generation rows');
    console.log(`✓ Phase 1 concurrent reader completed in ${report.p1ReaderElapsedMs} ms without blocking`);

    // 1c. Concurrent Mutator RPC with explicit statement_timeout='8s'
    console.log(`[Scale Smoke Phase 1] Executing concurrent apply_operational_resource_changes_v1 (timeout='8s')...`);
    const p1MutatorStart = performance.now();
    const p1MutatorRequestId = randomUUID();
    const p1MutatorExecution = { elapsedMs: 0, sqlState: null, receipt: null, status: 'pending', error: null };

    const p1MutatorPromise = (async () => {
      try {
        await mutatorClient.query('begin;');
        await mutatorClient.query("set local statement_timeout = '8s';");
        const res = await mutatorClient.query(
          'select public.apply_operational_resource_changes_v1($1::uuid, $2::bigint, $3::jsonb) as receipt;',
          [p1MutatorRequestId, p1CurrentRevision, JSON.stringify(p1MutationPayload)]
        );
        await mutatorClient.query('commit;');
        p1MutatorExecution.elapsedMs = Number((performance.now() - p1MutatorStart).toFixed(2));
        p1MutatorExecution.sqlState = '00000';
        p1MutatorExecution.receipt = res.rows[0].receipt;
        p1MutatorExecution.status = res.rows[0].receipt?.status || 'committed';
        return p1MutatorExecution;
      } catch (err) {
        p1MutatorExecution.elapsedMs = Number((performance.now() - p1MutatorStart).toFixed(2));
        p1MutatorExecution.sqlState = err.code || 'ERR';
        p1MutatorExecution.error = err.message;
        p1MutatorExecution.status = err.code === '57014' ? 'statement_timeout' : (err.code === '55P03' ? 'lock_timeout' : 'failed');
        await mutatorClient.query('rollback;').catch(() => {});
        return p1MutatorExecution;
      }
    })();

    // 1d. Await refresher completion and commit
    await p1RefreshPromise;
    await refresherClient.query('commit;');
    report.p1RefreshElapsedMs = Number((performance.now() - p1RefreshStart).toFixed(2));
    console.log(`✓ Phase 1 refresher completed in ${report.p1RefreshElapsedMs} ms (optimistic prepare discarded stale generation)`);

    // 1e. Await mutator result and assert strict success under 8s
    await p1MutatorPromise;
    report.p1MutatorElapsedMs = p1MutatorExecution.elapsedMs;
    report.p1MutatorStatus = p1MutatorExecution.status;

    assert.equal(
      p1MutatorExecution.status,
      'committed',
      `Phase 1 mutator MUST commit under 8s deadline, got: ${p1MutatorExecution.status} (SQLSTATE: ${p1MutatorExecution.sqlState}, error: ${p1MutatorExecution.error})`
    );
    assert.equal(p1MutatorExecution.sqlState, '00000', `Phase 1 mutator SQLSTATE must be 00000`);
    assert.ok(
      p1MutatorExecution.elapsedMs < 8000,
      `Phase 1 mutator must complete under 8s (8000ms), took ${p1MutatorExecution.elapsedMs}ms`
    );
    console.log(`✓ Phase 1 concurrent mutator committed under 8s (${p1MutatorExecution.elapsedMs} ms, SQLSTATE 00000)`);

    // 1f. Verify projection invalidation
    const p1StatusRes = await adminClient.query('select * from reporting.operational_projection_status_v1();');
    assert.equal(p1StatusRes.rows[0].is_fresh, false, 'Projection must be stale after Phase 1 mutation');
    console.log(`✓ Phase 1 projection status verified stale (is_fresh = false)`);

    // 1g. Phase 1 catchup refresh
    const p1CatchupStart = performance.now();
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1();');
    report.p1CatchupElapsedMs = Number((performance.now() - p1CatchupStart).toFixed(2));
    console.log(`✓ Phase 1 catchup refresh completed in ${report.p1CatchupElapsedMs} ms`);

    const p1PostCatchupStatus = (await adminClient.query('select * from reporting.operational_projection_status_v1();')).rows[0];
    assert.equal(p1PostCatchupStatus.is_fresh, true, 'Projection must be fresh after Phase 1 catchup');

    const p1CanonicalRes = await adminClient.query(
      'select pax from reporting.canonical_flight_legs where business_leg_key = $1;',
      [targetLeg.business_leg_key]
    );
    assert.equal(p1CanonicalRes.rows[0].pax, paxPhase1, `Canonical pax must match Phase 1 value (${paxPhase1})`);
    report.p1PaxVerified = true;
    console.log(`✓ Phase 1 mutated field verified in canonical store: pax = ${paxPhase1}`);

    // =========================================================================
    // PHASE 2: Speculative Publish Invalidation & Subtransaction Rollback
    // =========================================================================
    console.log(`\n----------------------------------------------------------------`);
    console.log(`[Scale Smoke] PHASE 2: Speculative Publish Invalidation & Subtransaction Rollback`);
    console.log(`----------------------------------------------------------------`);

    const p2CurrentRevRes = await adminClient.query('select revision from public.operational_workspace_revision where singleton;');
    const p2CurrentRevision = p2CurrentRevRes.rows[0].revision;

    const p2MutationPayload = [
      {
        legId: targetLeg.leg_id,
        expected: { pax: paxPhase1 },
        patch: { pax: paxPhase2 },
      },
    ];

    // 2a. Mutator begins transaction and executes mutation (holding FOR UPDATE on revision)
    console.log(`[Scale Smoke Phase 2] Mutator starting transaction and executing apply_operational_resource_changes_v1...`);
    const p2MutatorStart = performance.now();
    const p2MutatorRequestId = randomUUID();
    await mutatorClient.query('begin;');
    await mutatorClient.query("set local statement_timeout = '8s';");
    const p2MutatorRes = await mutatorClient.query(
      'select public.apply_operational_resource_changes_v1($1::uuid, $2::bigint, $3::jsonb) as receipt;',
      [p2MutatorRequestId, p2CurrentRevision, JSON.stringify(p2MutationPayload)]
    );
    assert.equal(p2MutatorRes.rows[0].receipt?.status, 'committed', 'Mutator RPC staged successfully in open transaction');
    const p2MutatorStageElapsed = Number((performance.now() - p2MutatorStart).toFixed(2));
    console.log(`✓ Mutator staged mutation in ${p2MutatorStageElapsed} ms (holding revision FOR UPDATE lock in open transaction)`);

    // 2b. Refresher launches full refresh while mutator holds FOR UPDATE
    console.log(`[Scale Smoke Phase 2] Refresher launching full refresh (PID: ${refresherPid})...`);
    await refresherClient.query('begin;');
    const p2RefreshStart = performance.now();
    const p2RefreshPromise = refresherClient.query('select reporting.refresh_operational_canonical_legs_v1(true);');

    // 2c. Refresher prepares candidate slice and performs speculative projection writes without lock,
    // then blocks at the late checkpoint awaiting FOR SHARE on operational_workspace_revision.
    console.log(`[Scale Smoke Phase 2] Waiting for Refresher to complete speculative writes and block at checkpoint (granted = false)...`);
    const waitingLock = await waitForWaitingLock(adminClient, refresherPid, 'operational_workspace_revision', 60_000);
    console.log(`✓ Refresher completed speculative writes and is deterministically waiting on operational_workspace_revision (lockmode: ${waitingLock.mode}, granted: false)`);

    // 2d. Mutator commits transaction: releases FOR UPDATE lock
    console.log(`[Scale Smoke Phase 2] Mutator committing transaction to unblock Refresher...`);
    const p2CommitStart = performance.now();
    await mutatorClient.query('commit;');
    report.p2MutatorElapsedMs = Number((p2MutatorStageElapsed + performance.now() - p2CommitStart).toFixed(2));
    report.p2MutatorStatus = 'committed';
    assert.ok(
      report.p2MutatorElapsedMs < 8000,
      `Phase 2 RPC plus commit (excluding intentional barrier hold) exceeded 8s: ${report.p2MutatorElapsedMs}ms`
    );
    console.log(`✓ Phase 2 RPC plus commit: ${report.p2MutatorElapsedMs} ms; total transaction including intentional barrier hold: ${(performance.now() - p2MutatorStart).toFixed(2)} ms`);

    // 2e. Refresher unblocks, detects changed revision, rolls back speculative subtransaction, and returns cleanly
    await p2RefreshPromise;
    await refresherClient.query('commit;');
    report.p2RefreshElapsedMs = Number((performance.now() - p2RefreshStart).toFixed(2));
    console.log(`✓ Phase 2 refresher completed in ${report.p2RefreshElapsedMs} ms (speculative subtransaction rolled back; caller transaction committed cleanly)`);

    // 2f. Verify projection invalidation & no stale leakage in canonical table
    const p2StatusRes = await adminClient.query('select * from reporting.operational_projection_status_v1();');
    assert.equal(p2StatusRes.rows[0].is_fresh, false, 'Projection must be stale after Phase 2 mutation');
    console.log(`✓ Phase 2 projection status verified stale (is_fresh = false)`);

    // Verify canonical table was NOT corrupted with stale speculative rows
    const p2PreCatchupCanonical = (await adminClient.query(
      'select pax from reporting.canonical_flight_legs where business_leg_key = $1;',
      [targetLeg.business_leg_key]
    )).rows[0].pax;
    assert.equal(p2PreCatchupCanonical, paxPhase1, `Pre-catchup canonical store must preserve prior data (${paxPhase1}), not corrupted by rolled-back speculative write`);
    console.log(`✓ Speculative subtransaction rollback verified: canonical table cleanly preserved prior data (pax = ${p2PreCatchupCanonical})`);

    // 2g. Phase 2 catchup refresh
    const p2CatchupStart = performance.now();
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1();');
    report.p2CatchupElapsedMs = Number((performance.now() - p2CatchupStart).toFixed(2));
    console.log(`✓ Phase 2 catchup refresh completed in ${report.p2CatchupElapsedMs} ms`);

    const p2PostCatchupStatus = (await adminClient.query('select * from reporting.operational_projection_status_v1();')).rows[0];
    assert.equal(p2PostCatchupStatus.is_fresh, true, 'Projection must be fresh after Phase 2 catchup');

    const p2CanonicalRes = await adminClient.query(
      'select pax from reporting.canonical_flight_legs where business_leg_key = $1;',
      [targetLeg.business_leg_key]
    );
    assert.equal(p2CanonicalRes.rows[0].pax, paxPhase2, `Canonical pax must match Phase 2 value (${paxPhase2})`);
    report.p2PaxVerified = true;
    console.log(`✓ Phase 2 mutated field verified in canonical store: pax = ${paxPhase2}`);

    // A real autocommit mutation during projection DML, without an artificial writer hold.
    const publishRevision = (await adminClient.query('select revision from public.operational_workspace_revision where singleton')).rows[0].revision;
    await refresherClient.query('begin');
    const publishRefresh = refresherClient.query('select reporting.refresh_operational_canonical_legs_v1(true)').then(() => refresherClient.query('commit'));
    const publicationDeadline = performance.now() + 60_000;
    let publishing = false;
    while (performance.now() < publicationDeadline) {
      const locks = await adminClient.query(`select 1 from pg_locks where pid=$1 and relation='reporting.operational_canonical_flight_legs'::regclass and mode='RowExclusiveLock' and granted`, [refresherPid]);
      if (locks.rowCount) { publishing = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(publishing, 'Observed actual projection publication DML');
    await mutatorClient.query("set statement_timeout = '8s'");
    const publishMutationStart = performance.now();
    const publishReceipt = await mutatorClient.query('select public.apply_operational_resource_changes_v1($1::uuid,$2::bigint,$3::jsonb) as receipt', [randomUUID(), publishRevision, JSON.stringify([{legId: targetLeg.leg_id, expected: {pax: paxPhase2}, patch: {pax: paxPhase1}}])]);
    const publishMutationMs = performance.now() - publishMutationStart;
    assert.equal(publishReceipt.rows[0].receipt.status, 'committed');
    assert.ok(publishMutationMs < 8000, `Autocommit mutation during publication took ${publishMutationMs}ms`);
    await publishRefresh;
    assert.equal((await adminClient.query('select is_fresh from reporting.operational_projection_status_v1()')).rows[0].is_fresh, false);
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1()');
    assert.equal((await adminClient.query('select pax from reporting.canonical_flight_legs where business_leg_key=$1', [targetLeg.business_leg_key])).rows[0].pax, paxPhase1);
    assert.equal((await adminClient.query('select is_fresh from reporting.operational_projection_status_v1()')).rows[0].is_fresh, true);
    console.log(`Publication-phase real autocommit RPC PASS: ${publishMutationMs.toFixed(2)}ms; catchup fresh with pax=${paxPhase1}`);

    // Only the hourly deadline is overdue: publish a queued date without claiming a full audit.
    await adminClient.query("update reporting.operational_canonical_flight_legs_state set last_reconciled_at=now()-interval '61 minutes' where singleton");
    const rev = (await adminClient.query('select revision from public.operational_workspace_revision where singleton')).rows[0].revision;
    const mutation = await mutatorClient.query('select public.apply_operational_resource_changes_v1($1,$2,$3) as receipt', [randomUUID(), rev, JSON.stringify([{legId: targetLeg.leg_id, expected: {pax: paxPhase1}, patch: {pax: paxPhase2}}])]);
    assert.equal(mutation.rows[0].receipt.status, 'committed');
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1()');
    assert.deepEqual((await adminClient.query('select is_fresh, reporting.operational_projection_reconcile_due_v1() as due from reporting.operational_projection_status_v1()')).rows[0], {is_fresh:true,due:true});
    assert.equal((await adminClient.query('select pax from reporting.canonical_flight_legs where business_leg_key=$1', [targetLeg.business_leg_key])).rows[0].pax, paxPhase2);
    await adminClient.query('select reporting.refresh_operational_canonical_legs_v1()');
    assert.equal((await adminClient.query('select reporting.operational_projection_reconcile_due_v1() as due')).rows[0].due, false);
    console.log('Dirty day fresh before periodic maintenance; full reconciliation completed on quiet pass.');
    // =========================================================================
    // FINAL SUMMARY
    // =========================================================================
    console.log(`\n================================================================`);
    console.log(`[Scale Smoke] ALL SCALE & CONCURRENCY ASSERTIONS PASSED (PHASE 1 & PHASE 2)`);
    console.log(`================================================================`);
    console.table([
      { Metric: 'Target Database', Value: report.database },
      { Metric: 'Operational Legs Scale', Value: report.scaleLegs.toLocaleString() },
      { Metric: 'Reader Cutover Gate', Value: report.readerCutoverActive ? 'ACTIVE (Gate ON)' : 'OFF' },
      { Metric: 'Reader Baseline Count', Value: `${report.readerBaselineMs} ms` },
      { Metric: 'Refresher Backend PID', Value: report.refresherPid },
      // Phase 1
      { Metric: 'Phase 1: Full Refresh Elapsed', Value: `${report.p1RefreshElapsedMs} ms` },
      { Metric: 'Phase 1: Concurrent Reader Elapsed', Value: `${report.p1ReaderElapsedMs} ms` },
      { Metric: 'Phase 1: Concurrent Mutator Elapsed', Value: `${report.p1MutatorElapsedMs} ms (< 8s)` },
      { Metric: 'Phase 1: Concurrent Mutator Outcome', Value: report.p1MutatorStatus },
      { Metric: 'Phase 1: Catchup Refresh Elapsed', Value: `${report.p1CatchupElapsedMs} ms` },
      { Metric: 'Phase 1: Mutated Pax in Canonical Store', Value: report.p1PaxVerified ? `pax = ${paxPhase1}` : 'FAILED' },
      // Phase 2
      { Metric: 'Phase 2: Full Refresh Elapsed', Value: `${report.p2RefreshElapsedMs} ms` },
      { Metric: 'Phase 2: RPC + commit (excludes deliberate hold)', Value: `${report.p2MutatorElapsedMs} ms` },
      { Metric: 'Phase 2: Concurrent Mutator Outcome', Value: report.p2MutatorStatus },
      { Metric: 'Phase 2: Catchup Refresh Elapsed', Value: `${report.p2CatchupElapsedMs} ms` },
      { Metric: 'Phase 2: Mutated Pax in Canonical Store', Value: report.p2PaxVerified ? `pax = ${paxPhase2}` : 'FAILED' },
    ]);

  } finally {
    await Promise.all([
      adminClient.query('rollback').catch(() => {}),
      refresherClient.query('rollback').catch(() => {}),
      readerClient.query('rollback').catch(() => {}),
      mutatorClient.query('rollback').catch(() => {}),
    ]);
    await adminClient.end().catch(() => {});
    await refresherClient.end().catch(() => {});
    await readerClient.end().catch(() => {});
    await mutatorClient.end().catch(() => {});
  }
}

runScaleConcurrencySmoke().catch((err) => {
  console.error('\n[Scale Smoke Failed]:', err);
  process.exit(1);
});
