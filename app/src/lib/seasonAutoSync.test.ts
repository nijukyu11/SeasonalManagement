import assert from 'node:assert/strict';
import test from 'node:test';
import { SeasonAutoSyncScheduler } from './seasonAutoSync.ts';

test('dispose cancels scheduled work and makes future mutations no-ops', async () => {
  let scheduled: (() => void) | null = null;
  let cancelled = 0;
  let runs = 0;
  let statePublications = 0;
  const scheduler = new SeasonAutoSyncScheduler({
    setTimeout: (callback) => { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { cancelled += 1; },
    isOnline: () => true,
    getPendingCount: async () => 1,
    run: async () => { runs += 1; return { status: 'synced' }; },
    onState: () => { statePublications += 1; },
  });
  scheduler.notifyLocalChange('S1', { pendingCount: 1, source: 'daily-edit' });
  assert.ok(scheduled);
  const beforeDisposePublications = statePublications;
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(cancelled, 1);
  (scheduled as unknown as () => void)();
  scheduler.notifyLocalChange('S1', { pendingCount: 1, source: 'daily-edit' });
  scheduler.notifyGuardChanged('S1');
  scheduler.notifyOnline();
  scheduler.setProgress('S1', 'late');
  assert.equal(runs, 0);
  assert.equal(statePublications, beforeDisposePublications);
  assert.deepEqual(await scheduler.syncNow('S1'), { status: 'failed', message: 'Sync coordinator has been disposed.' });
});

test('in-flight completion after dispose publishes nothing and starts no queued pass', async () => {
  let resolveRun: (() => void) | null = null;
  let pendingReads = 0;
  let runs = 0;
  let publications = 0;
  const scheduler = new SeasonAutoSyncScheduler({
    setTimeout,
    clearTimeout,
    isOnline: () => true,
    getPendingCount: async () => { pendingReads += 1; return 1; },
    run: async () => {
      runs += 1;
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      return { status: 'synced' };
    },
    onState: () => { publications += 1; },
  });
  const running = scheduler.syncNow('S1', 'daily-save');
  while (!resolveRun) await Promise.resolve();
  scheduler.notifyLocalChange('S1', { pendingCount: 1, source: 'daily-edit' });
  scheduler.dispose();
  const readsAtDispose = pendingReads;
  const publicationsAtDispose = publications;
  (resolveRun as unknown as () => void)();
  await running;
  assert.equal(runs, 1);
  assert.equal(pendingReads, readsAtDispose);
  assert.equal(publications, publicationsAtDispose);
});
