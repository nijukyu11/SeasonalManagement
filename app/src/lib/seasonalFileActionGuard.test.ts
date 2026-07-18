import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSeasonalFileActionBlock,
  reconcileSeasonalSelection,
} from './seasonalFileActionGuard.ts';

test('import and export are blocked while another seasonal operation is busy', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: false,
    busy: true,
  })?.code, 'busy');
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: true,
    selectedCount: 1,
  })?.code, 'busy');
});

test('import and export are blocked while a Seasonal draft exists', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: true,
    busy: false,
  })?.code, 'draft');
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: true,
    busy: false,
    selectedCount: 1,
  })?.code, 'draft');
});

test('export requires a selection while import does not', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: false,
    selectedCount: 0,
  })?.code, 'no-selection');
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: false,
    busy: false,
  }), null);
});

test('selection reconciliation reports matched and unknown ids', () => {
  assert.deepEqual(
    reconcileSeasonalSelection(['W26-current', 'S26-old'], new Set(['W26-current'])),
    {
      matchedIds: ['W26-current'],
      unknownIds: ['S26-old'],
    },
  );
});

test('a stale-only selection is blocked as stale instead of a valid empty export', () => {
  const selection = reconcileSeasonalSelection(['S26-old'], new Set(['W26-current']));

  assert.deepEqual(selection, {
    matchedIds: [],
    unknownIds: ['S26-old'],
  });
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: false,
    selectedCount: selection.matchedIds.length,
    staleSelectionCount: selection.unknownIds.length,
  })?.code, 'stale-selection');
});
