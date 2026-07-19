import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SeasonalImportRecoveryStorageError,
  buildSeasonalImportRecoveryReceipt,
  clearSeasonalImportRecoveryReceipt,
  committedSeasonalImportFromRecoveryReceipt,
  loadSeasonalImportRecoveryReceipt,
  markSeasonalImportRecoveryCommitted,
  persistSeasonalImportRecoveryReceipt,
} from './seasonalImportReceipt.ts';
import type {
  SeasonalImportV2CommittedResult,
  SeasonalImportV2RpcAttempt,
} from './seasonalImportRpcContract.ts';

class TestStorage {
  value: string | null = null;
  removed = false;
  failWrites = false;
  failRemovals = false;

  getItem(): string | null {
    return this.value;
  }

  setItem(_key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.value = value;
  }

  removeItem(): void {
    if (this.failRemovals) throw new Error('SecurityError');
    this.value = null;
    this.removed = true;
  }
}

const attempt = {
  requestId: '44444444-4444-5444-8444-444444444444',
  checksum: 'checksum',
  mode: 'repair',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  expectedDataVersion: 7,
  fileName: 'W26.xlsx',
  uploadedAt: 123,
  sourceRows: [{ rowIndex: 1 } as never],
} satisfies SeasonalImportV2RpcAttempt;

const committed = {
  batchId: '55555555-5555-4555-8555-555555555555',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  status: 'committed',
  sourceRowCount: 1,
  flightRecordCount: 24,
  preservedOperationalCount: 2,
  removedImportedCount: 3,
  dataVersion: 8,
  serverHighWater: 81,
  checksum: attempt.checksum,
} satisfies SeasonalImportV2CommittedResult;

test('recovery persistence stores a minimal owner-scoped receipt without source rows', () => {
  const storage = new TestStorage();
  const receipt = buildSeasonalImportRecoveryReceipt(attempt, 'operator-1');
  persistSeasonalImportRecoveryReceipt(storage, receipt);

  assert.doesNotMatch(storage.value ?? '', /sourceRows|fileName|uploadedAt/);
  const reloaded = loadSeasonalImportRecoveryReceipt(storage, {
    ownerUserId: 'operator-1',
    expectedSeasonId: 'season-w26',
  });
  assert.deepEqual(reloaded, receipt);
});

test('committed receipt survives reload and materializes the exact retryable commit result', () => {
  const storage = new TestStorage();
  const pending = buildSeasonalImportRecoveryReceipt(attempt, 'operator-1');
  persistSeasonalImportRecoveryReceipt(storage, pending);
  const committedReceipt = markSeasonalImportRecoveryCommitted(pending, committed);
  persistSeasonalImportRecoveryReceipt(storage, committedReceipt);

  const reloaded = loadSeasonalImportRecoveryReceipt(storage, {
    ownerUserId: 'operator-1',
    expectedSeasonId: 'season-w26',
  });
  assert.ok(reloaded);
  assert.equal(reloaded.status, 'committed');
  assert.deepEqual(committedSeasonalImportFromRecoveryReceipt(reloaded), committed);
  assert.doesNotMatch(storage.value ?? '', /sourceRows|fileName|uploadedAt/);
});

test('storage removal failure does not convert a committed success into ambiguity', () => {
  const storage = new TestStorage();
  storage.failRemovals = true;
  assert.equal(clearSeasonalImportRecoveryReceipt(storage), false);
});

test('quota/storage write failure is surfaced before import starts', () => {
  const storage = new TestStorage();
  storage.failWrites = true;
  const receipt = buildSeasonalImportRecoveryReceipt(attempt, 'operator-1');
  assert.throws(
    () => persistSeasonalImportRecoveryReceipt(storage, receipt),
    SeasonalImportRecoveryStorageError,
  );
});

test('owner mismatch and stale season receipts are rejected and cleared', () => {
  for (const scope of [
    { ownerUserId: 'operator-2', expectedSeasonId: 'season-w26' },
    { ownerUserId: 'operator-1', expectedSeasonId: 'season-s26' },
  ]) {
    const storage = new TestStorage();
    persistSeasonalImportRecoveryReceipt(
      storage,
      buildSeasonalImportRecoveryReceipt(attempt, 'operator-1'),
    );
    assert.equal(loadSeasonalImportRecoveryReceipt(storage, scope), null);
    assert.equal(storage.removed, true);
  }
});
