import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canCommitSeasonalImportPreview,
  type SeasonalImportPreviewState,
} from './seasonalImportPreview.ts';
import type { SeasonalDraftImportPreviewResult } from './seasonalDraftImportContract.ts';

const counts = {
  sourceRowCount: 3,
  generatedOccurrenceCount: 12,
  insertCount: 4,
  baselineUpdateCount: 3,
  unchangedCount: 5,
  removeImportedCount: 9,
  supersedeManualCount: 2,
  unlinkCount: 1,
  preservedOutsideScopeCount: 0,
};

const nativePreview: SeasonalDraftImportPreviewResult = {
  batchId: '55555555-5555-4555-8555-555555555556',
  requestId: '44444444-4444-5444-8444-444444444445',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  status: 'validated',
  valid: true,
  expectedEpoch: 'epoch-1',
  expectedRevision: '12',
  previewHash: 'preview-hash',
  counts,
  diagnosticCount: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
  warningCount: 0,
  warningsTruncated: false,
  warnings: [],
  expiresAt: '2026-07-24T12:00:00.000Z',
};

function state(
  result: SeasonalDraftImportPreviewResult = nativePreview,
  confirmation = '',
): SeasonalImportPreviewState {
  return { kind: 'preview', result, confirmation };
}

test('native draft preview requires exact season-code confirmation to commit', () => {
  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W27'),
    hasDraftChanges: false,
    busy: false,
  }), false);

  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W26'),
    hasDraftChanges: false,
    busy: false,
  }), true);

  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, ''),
    hasDraftChanges: false,
    busy: false,
  }), false);
});

test('native draft preview blocks commit when draft changes exist or busy', () => {
  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W26'),
    hasDraftChanges: true,
    busy: false,
  }), false);

  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W26'),
    hasDraftChanges: false,
    busy: true,
  }), false);
});

test('invalid, terminal, and non-preview states never enable commit', () => {
  for (const candidate of [
    { kind: 'idle' },
    { kind: 'staging' },
    { kind: 'committing', result: nativePreview },
    state({ ...nativePreview, valid: false }, 'W26'),
    state({ ...nativePreview, status: 'expired', valid: false }, 'W26'),
    state({ ...nativePreview, status: 'failed', valid: false }, 'W26'),
  ] satisfies SeasonalImportPreviewState[]) {
    assert.equal(canCommitSeasonalImportPreview({
      state: candidate,
      hasDraftChanges: false,
      busy: false,
    }), false);
  }
});

test('resolved duplicate warnings keep native draft import commit enabled', () => {
  const result: SeasonalDraftImportPreviewResult = {
    ...nativePreview,
    status: 'validated',
    valid: true,
    diagnosticCount: 0,
    warningCount: 1,
    warnings: [
      {
        code: 'duplicate-occurrence-resolved',
        message: 'Rows 1, 2 generate duplicate occurrence KE2093 on 2026-09-24; kept row 1.',
        sourceRowIndexes: [1, 2],
        occurrenceKey: null,
        affectedDateCount: 6,
        sampleDates: [
          '2026-09-24',
          '2026-10-01',
          '2026-10-08',
        ],
      },
    ],
  };

  assert.equal(canCommitSeasonalImportPreview({
    state: state(result, 'W26'),
    hasDraftChanges: false,
    busy: false,
  }), true, 'resolved duplicate warnings allow commit with valid confirmation');
});

test('previewError or isStale disables commit even with valid confirmation', () => {
  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W26'),
    hasDraftChanges: false,
    busy: false,
    previewError: true,
  }), false, 'preview error blocks commit');

  assert.equal(canCommitSeasonalImportPreview({
    state: state(nativePreview, 'W26'),
    hasDraftChanges: false,
    busy: false,
    isStale: true,
  }), false, 'stale preview blocks commit');
});
