import assert from 'node:assert/strict';
import test from 'node:test';
import { getSeasonalFileActionBlock, reconcileSeasonalSelection } from './seasonalFileActionGuard.ts';

test('import and export are blocked while a Seasonal draft exists', () => {
  assert.equal(getSeasonalFileActionBlock({ action: 'import', hasDraftChanges: true, busy: false })?.code, 'draft');
  assert.equal(getSeasonalFileActionBlock({ action: 'export', hasDraftChanges: true, busy: false })?.code, 'draft');
});

test('busy and no-selection blocks are explicit', () => {
  assert.equal(getSeasonalFileActionBlock({ action: 'import', hasDraftChanges: false, busy: true })?.code, 'busy');
  assert.equal(getSeasonalFileActionBlock({ action: 'export', hasDraftChanges: false, busy: false, selectedCount: 0 })?.code, 'no-selection');
});

test('selection reconciliation reports unknown ids', () => {
  assert.deepEqual(reconcileSeasonalSelection(['S26-old'], new Set(['W26-current'])), {
    matchedIds: [],
    unknownIds: ['S26-old'],
  });
});
