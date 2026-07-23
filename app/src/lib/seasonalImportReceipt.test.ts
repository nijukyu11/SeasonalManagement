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
  buildSeasonalImportV3RecoveryReceipt,
  clearSeasonalImportV3RecoveryReceipt,
  committedSeasonalImportV3FromRecoveryReceipt,
  loadSeasonalImportV3RecoveryReceipt,
  markSeasonalImportV3RecoveryCommitted,
  persistSeasonalImportV3RecoveryReceipt,
} from './seasonalImportReceipt.ts';
import type {
  SeasonalImportV2CommittedResult,
  SeasonalImportV2RpcAttempt,
} from './seasonalImportRpcContract.ts';
import type {
  SeasonalImportV3CommittedResult,
  SeasonalImportV3StageResult,
} from './seasonalImportV3Contract.ts';

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

const v3Counts = {
  sourceRowCount: 1,
  generatedOccurrenceCount: 1,
  insertCount: 0,
  baselineUpdateCount: 1,
  unchangedCount: 0,
  preservedOutsideScopeCount: 10,
  preservedOverlayCount: 2,
  preservedDeletedOverlayCount: 1,
  removeImportedCount: 0,
  clearStructuralOverlayCount: 0,
  clearDeletedOverlayCount: 0,
  manualCollisionCount: 0,
};

const v3Stage = {
  batchId: '55555555-5555-4555-8555-555555555556',
  requestId: '44444444-4444-5444-8444-444444444445',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  strategy: 'merge',
  status: 'validated',
  valid: true,
  expectedDataVersion: 7,
  previewHash: 'preview-hash',
  counts: v3Counts,
  diagnosticCount: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
  expiresAt: '2026-07-24T12:00:00.000Z',
} satisfies SeasonalImportV3StageResult;

const v3Committed = {
  batchId: v3Stage.batchId,
  requestId: v3Stage.requestId,
  seasonId: v3Stage.seasonId,
  seasonCode: v3Stage.seasonCode,
  strategy: v3Stage.strategy,
  status: 'committed',
  previewHash: v3Stage.previewHash,
  counts: v3Counts,
  importedRecordCount: 24,
  totalEffectiveRecordCount: 26,
  dataVersion: 8,
  serverHighWater: 82,
  checksum: 'checksum-v3',
} satisfies SeasonalImportV3CommittedResult;

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

test('V3 recovery receipt persists only status metadata and no import payload', () => {
  const storage = new TestStorage();
  const receipt = buildSeasonalImportV3RecoveryReceipt(v3Stage);
  persistSeasonalImportV3RecoveryReceipt(storage, receipt);

  const persisted = JSON.parse(storage.value ?? '{}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), [
    'batchId',
    'committedResult',
    'contractVersion',
    'expectedDataVersion',
    'previewHash',
    'requestId',
    'seasonCode',
    'seasonId',
    'status',
    'strategy',
  ]);
  assert.doesNotMatch(storage.value ?? '', /sourceRows|atomicRecords|fileName|uploadedAt/);
  assert.deepEqual(
    loadSeasonalImportV3RecoveryReceipt(storage, { expectedSeasonId: 'season-w26' }),
    receipt,
  );
});

test('V3 committed receipt round-trips the strict committed result', () => {
  const storage = new TestStorage();
  const pending = buildSeasonalImportV3RecoveryReceipt(v3Stage);
  const committedReceipt = markSeasonalImportV3RecoveryCommitted(pending, v3Committed);
  persistSeasonalImportV3RecoveryReceipt(storage, committedReceipt);

  const loaded = loadSeasonalImportV3RecoveryReceipt(storage, {
    expectedSeasonId: 'season-w26',
  });
  assert.ok(loaded);
  assert.equal(loaded.status, 'committed');
  assert.deepEqual(committedSeasonalImportV3FromRecoveryReceipt(loaded), v3Committed);
  assert.equal(clearSeasonalImportV3RecoveryReceipt(storage), true);
  assert.equal(storage.value, null);
});

test('V3 malformed or stale-season receipts are rejected and cleared', () => {
  for (const value of [
    { ...buildSeasonalImportV3RecoveryReceipt(v3Stage), sourceRows: [] },
    { ...buildSeasonalImportV3RecoveryReceipt(v3Stage), contractVersion: 2 },
  ]) {
    const storage = new TestStorage();
    storage.value = JSON.stringify(value);
    assert.equal(
      loadSeasonalImportV3RecoveryReceipt(storage, { expectedSeasonId: 'season-w26' }),
      null,
    );
    assert.equal(storage.removed, true);
  }

  const storage = new TestStorage();
  persistSeasonalImportV3RecoveryReceipt(
    storage,
    buildSeasonalImportV3RecoveryReceipt(v3Stage),
  );
  assert.equal(
    loadSeasonalImportV3RecoveryReceipt(storage, { expectedSeasonId: 'season-s26' }),
    null,
  );
  assert.equal(storage.removed, true);
});
