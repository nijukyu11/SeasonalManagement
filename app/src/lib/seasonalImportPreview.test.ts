import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canCommitSeasonalImportPreview,
  type SeasonalImportPreviewState,
} from './seasonalImportPreview.ts';
import type { SeasonalImportV3StageResult } from './seasonalImportV3Contract.ts';

const counts = {
  sourceRowCount: 3,
  generatedOccurrenceCount: 12,
  insertCount: 4,
  baselineUpdateCount: 3,
  unchangedCount: 5,
  preservedOutsideScopeCount: 20,
  preservedOverlayCount: 2,
  preservedDeletedOverlayCount: 1,
  removeImportedCount: 0,
  clearStructuralOverlayCount: 0,
  clearDeletedOverlayCount: 0,
  manualCollisionCount: 0,
};

const mergePreview = {
  batchId: '55555555-5555-4555-8555-555555555556',
  requestId: '44444444-4444-5444-8444-444444444445',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  strategy: 'merge',
  status: 'validated',
  valid: true,
  expectedDataVersion: 7,
  previewHash: 'preview-hash',
  counts,
  diagnosticCount: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
  expiresAt: '2026-07-24T12:00:00.000Z',
} satisfies SeasonalImportV3StageResult;

function state(
  result: SeasonalImportV3StageResult = mergePreview,
  confirmation = '',
): SeasonalImportPreviewState {
  return { kind: 'preview', result, confirmation };
}

test('merge preview can commit only when validated, clean, and idle', () => {
  assert.equal(canCommitSeasonalImportPreview({
    state: state(),
    hasDraftChanges: false,
    busy: false,
  }), true);
  assert.equal(canCommitSeasonalImportPreview({
    state: state(),
    hasDraftChanges: true,
    busy: false,
  }), false);
  assert.equal(canCommitSeasonalImportPreview({
    state: state(),
    hasDraftChanges: false,
    busy: true,
  }), false);
});

test('replace preview requires an exact season-code confirmation', () => {
  const result = {
    ...mergePreview,
    strategy: 'replace',
    counts: { ...counts, removeImportedCount: 9 },
  } satisfies SeasonalImportV3StageResult;
  assert.equal(canCommitSeasonalImportPreview({
    state: state(result, 'w26'),
    hasDraftChanges: false,
    busy: false,
  }), false);
  assert.equal(canCommitSeasonalImportPreview({
    state: state(result, 'W26'),
    hasDraftChanges: false,
    busy: false,
  }), true);
});

test('invalid, terminal, and non-preview states never enable commit', () => {
  for (const candidate of [
    { kind: 'idle' },
    { kind: 'staging', strategy: 'merge' },
    { kind: 'committing', result: mergePreview },
    state({ ...mergePreview, valid: false }),
    state({ ...mergePreview, status: 'expired', valid: false }),
  ] satisfies SeasonalImportPreviewState[]) {
    assert.equal(canCommitSeasonalImportPreview({
      state: candidate,
      hasDraftChanges: false,
      busy: false,
    }), false);
  }
});
