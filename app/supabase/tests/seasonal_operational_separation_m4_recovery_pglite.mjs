import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const tempDir = mkdtempSync(path.join(tmpdir(), 'operational-recovery-'));
const moduleNames = ['operationalScheduleContract', 'operatorSessionCacheRegistry', 'operationalScheduleAdapter'];
const originalNodePath = process.env.NODE_PATH;
const originalWindow = globalThis.window;
const originalBoundary = globalThis.__operationalRecoveryRpc;
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
writeFileSync(path.join(tempDir, 'remoteStore.js'), 'module.exports = globalThis.__operationalRecoveryRpc;\n');
const loadAdapter = () => {
  for (const name of [...moduleNames, 'remoteStore']) delete require.cache[path.join(tempDir, `${name}.js`)];
  return require(path.join(tempDir, 'operationalScheduleAdapter.js'));
};
const storage = (data) => ({
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, String(value)),
  removeItem: (key) => data.delete(key),
});
const authKey = 'seasonal-management-supabase-auth-token';

try {
  for (const recoveryMode of ['reload', 'auth-reset']) {
    const ctx = await buildM0Fixture();
    try {
      await ctx.asAdmin();
      const legId = '20000000-0000-4000-8000-000000000901';
      const requestId = '20000000-0000-4000-8000-000000000902';
      await ctx.db.query(`
        insert into public.operational_flight_legs (
          leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
          side, airline, flight_number, source_type
        ) values (
          $1, 'A'||chr(31)||'2030-03-31'||chr(31)||'VN'||chr(31)||'VN900',
          '2030-03-31', '2030-03-31', '06:00', 'ARR', 'VN', 'VN900', 'operational_manual'
        )
      `, [legId]);
      await ctx.asWriter();
      const journal = new Map();
      const ownerSession = JSON.stringify({ user: { id: M0_FIXTURE.writerId } });
      journal.set(authKey, ownerSession);
      globalThis.window = { localStorage: storage(journal), sessionStorage: storage(new Map()) };
      const calls = [];
      let loseAck = true;
      let ackGate = null;
      let ackEntered;
      globalThis.__operationalRecoveryRpc = {
        getOperationalScheduleAllocationWindowV1: async ({ startDate, endDate }) => (
          await ctx.db.query(`select public.get_operational_schedule_allocation_window_v1($1::date,$2::date) as r`, [startDate, endDate])
        ).rows[0].r,
        applyOperationalResourceChangesV1: async (args) => {
          calls.push(structuredClone(args));
          const receipt = (await ctx.db.query(`
            select public.apply_operational_resource_changes_v1($1::uuid,$2::bigint,$3::jsonb) as r
          `, [args.requestId, args.expectedRevision, JSON.stringify(args.changes)])).rows[0].r;
          // The actual SQL commit succeeded; lose the response, including the automatic retry ACK.
          if (loseAck) throw new Error('Committed response lost');
          if (ackGate) {
            ackEntered();
            await ackGate;
          }
          return receipt;
        },
      };
      let adapter = loadAdapter();
      adapter.useOperationalScheduleStore.setState({ startDate: '2030-03-31', endDate: '2030-03-31' });
      await adapter.useOperationalScheduleStore.getState().loadWindow({ force: true });
      const originalRevision = adapter.useOperationalScheduleStore.getState().snapshot.revision;
      const changes = [{ legId, expected: { gate: null }, patch: { gate: 7 } }];
      await assert.rejects(
        adapter.useOperationalScheduleStore.getState().applyMutations(changes, { requestId }),
        /Committed response lost/,
      );
      await adapter.useOperationalScheduleStore.getState().loadWindow({ force: true });
      const committedRevision = adapter.useOperationalScheduleStore.getState().snapshot.revision;
      assert.notEqual(committedRevision, originalRevision);
      assert.equal((await ctx.db.query(`select gate from public.operational_flight_legs where leg_id=$1`, [legId])).rows[0].gate, 7);
      await assert.rejects(
        adapter.useOperationalScheduleStore.getState().applyMutations(
          [{ legId, expected: { gate: 7 }, patch: { gate: 8 } }],
          { requestId: '20000000-0000-4000-8000-000000000903' },
        ),
        /previous operational write is unconfirmed/,
      );
      if (recoveryMode === 'reload') {
        globalThis.window.sessionStorage = storage(new Map());
        adapter = loadAdapter();
      } else {
        globalThis.window.localStorage.removeItem(authKey);
        adapter.useOperationalScheduleStore.getState().reset();
        assert.equal(adapter.getPendingOperationalMutation(), null);
        globalThis.window.localStorage.setItem(authKey, ownerSession);
      }
      adapter.useOperationalScheduleStore.setState({
        startDate: '2030-03-31', endDate: '2030-03-31',
        snapshot: { revision: committedRevision, token: '' },
      });
      loseAck = false;
      let releaseAck;
      ackGate = new Promise((resolve) => { releaseAck = resolve; });
      const entered = new Promise((resolve) => { ackEntered = resolve; });
      const pendingRetry = adapter.useOperationalScheduleStore.getState().retryPendingMutation();
      try {
        await Promise.race([entered, pendingRetry.then(() => { throw new Error('Receipt bypassed the ACK gate'); })]);
        assert.equal(adapter.useOperationalScheduleStore.getState().mutating, true);
        await assert.rejects(
          adapter.useOperationalScheduleStore.getState().retryPendingMutation(),
          /already in progress/,
        );
      } finally {
        releaseAck();
      }
      const recovered = await pendingRetry;
      assert.equal(recovered.receipt.status, 'committed');
      assert.equal(recovered.receipt.revision, committedRevision);
      assert.equal(calls.length, 3);
      for (const args of calls) assert.deepEqual(args, { requestId, expectedRevision: originalRevision, changes });
      assert.equal(adapter.getPendingOperationalMutation(), null);
      assert.equal(adapter.useOperationalScheduleStore.getState().mutating, false);
      await ctx.asAdmin();
      assert.equal(Number((await ctx.db.query(`select revision from public.operational_workspace_revision where singleton`)).rows[0].revision), Number(committedRevision));
      assert.equal((await ctx.db.query(`select gate from public.operational_flight_legs where leg_id=$1`, [legId])).rows[0].gate, 7);
      console.log(`M4 recovery ${recoveryMode} PASS: committed lost ACK, original revision retry, no duplicate mutation`);
    } finally {
      globalThis.window = originalWindow;
      await ctx.close();
    }
  }
} finally {
  globalThis.window = originalWindow;
  if (originalBoundary === undefined) delete globalThis.__operationalRecoveryRpc;
  else globalThis.__operationalRecoveryRpc = originalBoundary;
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
  require('node:module').Module._initPaths();
  for (const name of [...moduleNames, 'remoteStore']) delete require.cache[path.join(tempDir, `${name}.js`)];
  rmSync(tempDir, { recursive: true, force: true });
}
