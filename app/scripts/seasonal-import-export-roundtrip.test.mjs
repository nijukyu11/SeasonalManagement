import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEmptyPairDiagnostics } from './seasonal-import-export-roundtrip.mjs';

const EMPTY_DIAGNOSTICS = Object.freeze({
  unresolvedPairCount: 0,
  ambiguousPairCount: 0,
  nonReciprocalPairCount: 0,
  missingCounterpartCount: 0,
});

test('identical nonzero baseline and reimport pair diagnostics are rejected field by field', () => {
  for (const field of Object.keys(EMPTY_DIAGNOSTICS)) {
    const baseline = { ...EMPTY_DIAGNOSTICS, [field]: 1 };
    const reimport = { ...EMPTY_DIAGNOSTICS, [field]: 1 };
    assert.deepEqual(reimport, baseline, `${field} fixture must demonstrate equality alone passes`);
    assert.throws(
      () => assertEmptyPairDiagnostics(baseline, 'baseline'),
      new RegExp(`baseline ${field} must be zero`),
    );
    assert.throws(
      () => assertEmptyPairDiagnostics(reimport, 're-import'),
      new RegExp(`re-import ${field} must be zero`),
    );
  }
});
