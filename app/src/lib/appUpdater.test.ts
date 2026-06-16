import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkForAppUpdate,
  createAppUpdaterClient,
  formatUpdateDate,
  getCurrentAppVersion,
  toDownloadProgress,
  type AppUpdateDownloadState,
  type AppUpdaterCheckResult,
  type TauriUpdateEvent,
} from './appUpdater.ts';

test('checkForAppUpdate reports unavailable outside native runtime', async () => {
  const result = await checkForAppUpdate({
    isNativeRuntime: () => false,
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /Tauri desktop app/);
});

test('checkForAppUpdate maps no-update result to up-to-date state', async () => {
  const result = await checkForAppUpdate({
    isNativeRuntime: () => true,
    check: async () => null,
  });

  assert.deepEqual(result, {
    status: 'upToDate',
    message: 'Seasonal Management is up to date.',
  } satisfies AppUpdaterCheckResult);
});

test('checkForAppUpdate returns update metadata when a release is available', async () => {
  const update = {
    version: '0.2.0',
    currentVersion: '0.1.0',
    date: '2026-06-07T03:30:00.000Z',
    body: 'Fix schedule refresh and updater flow.',
    downloadAndInstall: async () => undefined,
  };
  const result = await checkForAppUpdate({
    isNativeRuntime: () => true,
    check: async () => update,
  });

  assert.equal(result.status, 'available');
  assert.equal(result.update.version, '0.2.0');
  assert.equal(result.update.currentVersion, '0.1.0');
  assert.equal(result.update.notes, 'Fix schedule refresh and updater flow.');
  assert.equal(result.update.publishedAt, '2026-06-07T03:30:00.000Z');
});

test('toDownloadProgress accumulates bytes and calculates percent after content length arrives', () => {
  const first = toDownloadProgress(
    { downloadedBytes: 0, contentLength: null, percent: null } satisfies AppUpdateDownloadState,
    { event: 'Started', data: { contentLength: 100 } }
  );
  const second = toDownloadProgress(first, { event: 'Progress', data: { chunkLength: 40 } });
  const third = toDownloadProgress(second, { event: 'Progress', data: { chunkLength: 15 } });

  assert.deepEqual(third, {
    downloadedBytes: 55,
    contentLength: 100,
    percent: 55,
  });
});

test('createAppUpdaterClient downloads, marks install complete, and relaunches', async () => {
  const events: string[] = [];
  const update = {
    version: '0.2.0',
    currentVersion: '0.1.0',
    downloadAndInstall: async (onEvent?: (event: TauriUpdateEvent) => void) => {
      events.push('download');
      onEvent?.({ event: 'Started', data: { contentLength: 5 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 5 } });
      onEvent?.({ event: 'Finished' });
    },
  };
  const client = createAppUpdaterClient({
    isNativeRuntime: () => true,
    check: async () => update,
    relaunch: async () => {
      events.push('relaunch');
    },
  });

  const checkResult = await client.check();
  assert.equal(checkResult.status, 'available');
  if (checkResult.status !== 'available') throw new Error('expected update result');

  const progress: number[] = [];
  const installResult = await client.downloadAndInstall(checkResult.update, (state) => {
    progress.push(state.percent ?? 0);
  });
  await client.relaunch();

  assert.equal(installResult.status, 'installed');
  assert.deepEqual(progress, [0, 100, 100]);
  assert.deepEqual(events, ['download', 'relaunch']);
});

test('formatUpdateDate uses a stable local readable date when input is valid', () => {
  assert.equal(formatUpdateDate('2026-06-07T03:30:00.000Z'), '07 Jun 2026, 10:30');
});

test('getCurrentAppVersion returns null outside native runtime', async () => {
  const version = await getCurrentAppVersion({
    isNativeRuntime: () => false,
  });

  assert.equal(version, null);
});

test('getCurrentAppVersion reads native app version when available', async () => {
  const version = await getCurrentAppVersion({
    isNativeRuntime: () => true,
    getVersion: async () => '0.1.0',
  });

  assert.equal(version, '0.1.0');
});
