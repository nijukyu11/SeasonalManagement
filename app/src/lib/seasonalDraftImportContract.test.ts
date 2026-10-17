import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_KEY,
  LEGACY_SEASONAL_IMPORT_V3_STORAGE_KEY,
  buildSeasonalDraftImportRecoveryReceipt,
  clearLegacySeasonalImportReceipts,
  clearSeasonalDraftImportRecoveryReceipt,
  committedSeasonalDraftImportFromRecoveryReceipt,
  deriveSeasonalDraftImportRequestId,
  draftImportResponseToPreview,
  hasLegacySeasonalImportPendingReceipt,
  isSeasonalDraftImportRecoveryReceipt,
  loadSeasonalDraftImportRecoveryReceipt,
  markSeasonalDraftImportRecoveryCommitted,
  persistSeasonalDraftImportRecoveryReceipt,
  type SeasonalDraftImportCommittedResult,
  type SeasonalDraftImportPreviewResult,
  type SeasonalDraftImportResponse,
} from './seasonalDraftImportContract.ts';

class TestStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const sampleCounts = {
  sourceRowCount: 2,
  generatedOccurrenceCount: 4,
  insertCount: 2,
  baselineUpdateCount: 0,
  unchangedCount: 0,
  removeImportedCount: 1,
  supersedeManualCount: 1,
  unlinkCount: 0,
  preservedOutsideScopeCount: 0,
};

const samplePreview: SeasonalDraftImportPreviewResult = {
  batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  status: 'validated',
  valid: true,
  previewHash: 'hash-1234',
  expectedEpoch: 'epoch-1',
  expectedRevision: '5',
  counts: sampleCounts,
  diagnosticCount: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
  warningCount: 0,
  warningsTruncated: false,
  warnings: [],
  expiresAt: '2026-10-16T12:00:00.000Z',
};

test('deriveSeasonalDraftImportRequestId produces valid uuid v4 format deterministically', async () => {
  const req1 = await deriveSeasonalDraftImportRequestId({
    seasonId: 'season-w26',
    seasonCode: 'W26',
    expectedEpoch: 'epoch-1',
    expectedRevision: '5',
    checksum: 'abc123checksum',
    uploadedAt: 10000,
  });

  const req2 = await deriveSeasonalDraftImportRequestId({
    seasonId: 'season-w26',
    seasonCode: 'W26',
    expectedEpoch: 'epoch-1',
    expectedRevision: '5',
    checksum: 'abc123checksum',
    uploadedAt: 10000,
  });

  assert.equal(req1, req2);
  assert.match(req1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});


test('draftImportResponseToPreview maps server response into UI preview result', () => {
  const response: SeasonalDraftImportResponse = {
    contractVersion: 1,
    batchId: 'batch-1',
    requestId: 'req-1',
    seasonId: 'season-1',
    status: 'validated',
    previewHash: 'preview-hash-1',
    preview: {
      valid: true,
      seasonId: 'season-1',
      seasonCode: 'W26',
      draftEpoch: 'epoch-1',
      draftRevision: '5',
      counts: sampleCounts,
      diagnostics: [],
      warnings: [],
      diagnosticCount: 0,
      diagnosticsTruncated: false,
    },
  };

  const preview = draftImportResponseToPreview(response, {
    requestId: 'req-1',
    seasonId: 'season-1',
    seasonCode: 'W26',
    expectedEpoch: 'epoch-1',
    expectedRevision: '5',
    sourceRowCount: 2,
  });

  assert.equal(preview.batchId, 'batch-1');
  assert.equal(preview.valid, true);
  assert.equal(preview.status, 'validated');
  assert.equal(preview.counts.sourceRowCount, 2);
  assert.equal(preview.counts.removeImportedCount, 1);
});

test('native draft recovery receipt persists, loads with scope, and survives committed refresh failure', () => {
  const storage = new TestStorage();

  const receipt = buildSeasonalDraftImportRecoveryReceipt(samplePreview, 'user-planner');
  assert.equal(receipt.contractVersion, 4);
  assert.equal(receipt.pipeline, 'seasonal_draft_v1');
  assert.equal(receipt.status, 'validated');
  assert.equal(receipt.loadedCount, 2);
  assert.equal(isSeasonalDraftImportRecoveryReceipt(receipt), true);

  persistSeasonalDraftImportRecoveryReceipt(storage, receipt);

  const loaded = loadSeasonalDraftImportRecoveryReceipt(storage, {
    expectedSeasonId: 'season-w26',
    ownerUserId: 'user-planner',
  });
  assert.deepEqual(loaded, receipt);

  // Different season clears receipt
  const loadedWrongSeason = loadSeasonalDraftImportRecoveryReceipt(storage, {
    expectedSeasonId: 'season-other',
  });
  assert.equal(loadedWrongSeason, null);
  assert.equal(storage.getItem(SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_KEY), null);

  // Re-persist and mark committed
  persistSeasonalDraftImportRecoveryReceipt(storage, receipt);
  const committedResult: SeasonalDraftImportCommittedResult = {
    batchId: samplePreview.batchId,
    requestId: samplePreview.requestId,
    seasonId: samplePreview.seasonId,
    seasonCode: samplePreview.seasonCode,
    draftEpoch: 'epoch-2',
    draftRevision: '6',
    counts: sampleCounts,
  };

  const committedReceipt = markSeasonalDraftImportRecoveryCommitted(receipt, committedResult);
  assert.equal(committedReceipt.status, 'committed');
  assert.deepEqual(committedReceipt.committedResult, committedResult);

  // When committed, receipt survives and committed result is recoverable
  persistSeasonalDraftImportRecoveryReceipt(storage, committedReceipt);
  const loadedCommitted = loadSeasonalDraftImportRecoveryReceipt(storage);
  assert.ok(loadedCommitted);
  assert.equal(loadedCommitted.status, 'committed');

  const recoveredCommitted = committedSeasonalDraftImportFromRecoveryReceipt(loadedCommitted);
  assert.equal(recoveredCommitted.draftRevision, '6');

  // Authoritative clear
  assert.equal(clearSeasonalDraftImportRecoveryReceipt(storage), true);
  assert.equal(loadSeasonalDraftImportRecoveryReceipt(storage), null);
});

test('native recovery never hydrates another operator or an ownerless receipt', () => {
  for (const ownerUserId of ['another-planner', '']) {
    const storage = new TestStorage();
    const receipt = buildSeasonalDraftImportRecoveryReceipt(samplePreview, ownerUserId);
    persistSeasonalDraftImportRecoveryReceipt(storage, receipt);
    assert.equal(loadSeasonalDraftImportRecoveryReceipt(storage, { ownerUserId: 'user-planner' }), null);
    assert.equal(storage.getItem(SEASONAL_DRAFT_IMPORT_RECOVERY_STORAGE_KEY), null);
  }
});

test('legacy pending receipt detection does not interpret legacy receipt as native', () => {
  const storage = new TestStorage();

  assert.equal(hasLegacySeasonalImportPendingReceipt(storage), false);

  storage.setItem(LEGACY_SEASONAL_IMPORT_V3_STORAGE_KEY, JSON.stringify({ old: true }));
  assert.equal(hasLegacySeasonalImportPendingReceipt(storage), true);

  // Native loader ignores legacy keys
  assert.equal(loadSeasonalDraftImportRecoveryReceipt(storage), null);

  // Clear legacy clears without touching native
  clearLegacySeasonalImportReceipts(storage);
  assert.equal(hasLegacySeasonalImportPendingReceipt(storage), false);
});
