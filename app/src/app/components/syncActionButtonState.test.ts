import assert from 'node:assert/strict';
import test from 'node:test';

import { getSyncActionButtonState } from './syncActionButtonState.ts';

test('enables draft-only save when there are draft changes without pending changes', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 0,
    draftCount: 2,
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, false);
  assert.equal(state.label, 'Save draft');
  assert.equal(state.title, 'Save draft changes to server');
});

test('enables pending-only save and uses progress for the title', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 3,
    draftCount: 0,
    progress: 'Submitting 3 pending submit',
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, false);
  assert.equal(state.label, 'Save pending');
  assert.equal(state.title, 'Submitting 3 pending submit');
});

test('keeps busy draft submit disabled while preserving submit availability', () => {
  const state = getSyncActionButtonState({
    syncing: true,
    pendingCount: 0,
    draftCount: 1,
    progress: 'Submitting draft',
  });

  assert.equal(state.canSubmit, true);
  assert.equal(state.disabled, true);
  assert.equal(state.label, 'Submitting...');
  assert.equal(state.title, 'Submitting draft');
});

test('disables idle state when there are no pending or draft changes', () => {
  const state = getSyncActionButtonState({
    syncing: false,
    pendingCount: 0,
    draftCount: 0,
  });

  assert.equal(state.canSubmit, false);
  assert.equal(state.disabled, true);
  assert.equal(state.label, 'No pending');
  assert.equal(state.title, 'No pending changes to submit');
});
