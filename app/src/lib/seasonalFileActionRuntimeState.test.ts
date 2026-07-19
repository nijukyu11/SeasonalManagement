import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearSeasonalFileActionRuntimeState,
  getSeasonalFileActionRuntimeState,
  setSeasonalFileActionRuntimeState,
} from './seasonalFileActionRuntimeState.ts';

test('Seasonal draft state remains available to a cross-route repair guard', () => {
  setSeasonalFileActionRuntimeState('season-w26', { hasDraftChanges: true, draftRevision: 9 });
  assert.deepEqual(getSeasonalFileActionRuntimeState('season-w26'), {
    hasDraftChanges: true,
    draftRevision: 9,
  });
  clearSeasonalFileActionRuntimeState('season-w26');
  assert.deepEqual(getSeasonalFileActionRuntimeState('season-w26'), {
    hasDraftChanges: false,
    draftRevision: 0,
  });
});
