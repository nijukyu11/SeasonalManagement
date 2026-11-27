import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateNativeCloseSafety,
} from './nativeClosePolicy.ts';
import {
  setSeasonalDraftImportCommitting,
  setSeasonalDraftImportUnknownCommit,
  setSeasonalDraftImportUploading,
  setSeasonalPublishActive,
} from './seasonalMutationFences.ts';

test('evaluateNativeCloseSafety confirms ordinary close for idle state or ordinary unsent drafts', () => {
  const decision = evaluateNativeCloseSafety({
    planningGuards: [
      {
        status: 'idle',
        hasUnconfirmedChanges: false,
        canonicalReloadError: null,
        pendingRequest: null,
      },
    ],
    seasonalPublishActive: false,
    seasonalRestoreExecuting: false,
    seasonalRestorePersistedStatus: null,
    operationalMutating: false,
    operationalImporting: false,
    hasOperationalUnresolvedAttempt: false,
    dailyUploadJournalStatus: null,
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'ordinary');
  assert.equal(decision.confirmLabel, 'Đóng ứng dụng');
});

test('evaluateNativeCloseSafety hard blocks close when seasonal publish is in flight', () => {
  setSeasonalPublishActive(true);
  try {
    const decision = evaluateNativeCloseSafety();
    assert.equal(decision.action, 'block');
  } finally {
    setSeasonalPublishActive(false);
  }
});

test('evaluateNativeCloseSafety hard blocks close when seasonal draft import upload or commit is in flight', () => {
  setSeasonalDraftImportUploading(true);
  let decision = evaluateNativeCloseSafety();
  assert.equal(decision.action, 'block');
  setSeasonalDraftImportUploading(false);

  setSeasonalDraftImportCommitting(true);
  decision = evaluateNativeCloseSafety();
  assert.equal(decision.action, 'block');
  setSeasonalDraftImportCommitting(false);
});

test('evaluateNativeCloseSafety hard blocks close when seasonal planning draft save is in flight', () => {
  const decision = evaluateNativeCloseSafety({
    planningGuards: [
      {
        status: 'saving',
        hasUnconfirmedChanges: false,
        canonicalReloadError: null,
      },
    ],
  });

  assert.equal(decision.action, 'block');
});

test('evaluateNativeCloseSafety hard blocks close when seasonal version restore is in-memory executing', () => {
  const decision = evaluateNativeCloseSafety({
    seasonalRestoreExecuting: true,
  });

  assert.equal(decision.action, 'block');
});

test('evaluateNativeCloseSafety hard blocks close when operational store is mutating or importing', () => {
  let decision = evaluateNativeCloseSafety({ operationalMutating: true });
  assert.equal(decision.action, 'block');

  decision = evaluateNativeCloseSafety({ operationalImporting: true });
  assert.equal(decision.action, 'block');
});

test('evaluateNativeCloseSafety allows explicit close confirmation for unconfirmed planning changes with a pending request', () => {
  const decision = evaluateNativeCloseSafety({
    planningGuards: [
      {
        status: 'error',
        hasUnconfirmedChanges: true,
        canonicalReloadError: null,
        pendingRequest: {
          requestId: 'test-req',
          seasonId: 's1',
          expectedRevision: 'r1',
          changes: [],
          applyFn: async () => { throw new Error('Close inspection must not execute a mutation'); },
          currentRecords: [],
          baseRecords: [],
        },
      },
    ],
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'unconfirmed-warning');
  assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');
});

test('evaluateNativeCloseSafety warns and confirms unknown seasonal draft import commit', () => {
  setSeasonalDraftImportUnknownCommit('op-1', true);
  try {
    const decision = evaluateNativeCloseSafety({
      hasSeasonalDraftImportUnknownCommit: true,
    });
    assert.equal(decision.action, 'confirm');
    assert.equal(decision.kind, 'unconfirmed-warning');
    assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');
  } finally {
    setSeasonalDraftImportUnknownCommit('op-1', false);
  }
});

test('evaluateNativeCloseSafety warns and confirms persisted restore journal after restart', () => {
  let decision = evaluateNativeCloseSafety({
    seasonalRestoreExecuting: false,
    seasonalRestorePersistedStatus: 'unresolved',
  });
  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'unconfirmed-warning');
  assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');

  decision = evaluateNativeCloseSafety({
    seasonalRestoreExecuting: false,
    seasonalRestorePersistedStatus: 'executing',
  });
  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'unconfirmed-warning');
  assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');
});

test('evaluateNativeCloseSafety warns and confirms operational unresolved attempts', () => {
  const decision = evaluateNativeCloseSafety({
    hasOperationalUnresolvedAttempt: true,
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'unconfirmed-warning');
  assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');
});

test('evaluateNativeCloseSafety warns and confirms stale daily upload journal after restart', () => {
  const decision = evaluateNativeCloseSafety({
    dailyUploadJournalStatus: 'uploading',
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'unconfirmed-warning');
  assert.equal(decision.confirmLabel, 'Đóng dù chưa xác nhận');
});

test('evaluateNativeCloseSafety allows ordinary close when commit succeeded and only canonical reload failed', () => {
  const decision = evaluateNativeCloseSafety({
    planningGuards: [
      {
        status: 'saved',
        hasUnconfirmedChanges: false,
        canonicalReloadError: 'Network error during reload',
      },
    ],
    seasonalPublishActive: false,
    seasonalRestoreExecuting: false,
    seasonalRestorePersistedStatus: null,
    operationalMutating: false,
    operationalImporting: false,
    hasOperationalUnresolvedAttempt: false,
    dailyUploadJournalStatus: null,
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'ordinary');
  assert.equal(decision.confirmLabel, 'Đóng ứng dụng');
});

test('evaluateNativeCloseSafety allows ordinary close for staged preview or committed states', () => {
  const decision = evaluateNativeCloseSafety({
    planningGuards: [],
    seasonalPublishActive: false,
    seasonalRestoreExecuting: false,
    seasonalRestorePersistedStatus: 'committed',
    operationalMutating: false,
    operationalImporting: false,
    hasOperationalUnresolvedAttempt: false,
    dailyUploadJournalStatus: 'staged',
  });

  assert.equal(decision.action, 'confirm');
  assert.equal(decision.kind, 'ordinary');
  assert.equal(decision.confirmLabel, 'Đóng ứng dụng');
});
