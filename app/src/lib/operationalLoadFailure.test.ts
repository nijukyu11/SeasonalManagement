import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReportOperationalLoadFailure } from './operationalLoadFailure.ts';

const currentFailure = {
  requestId: 2,
  currentRequestId: 2,
  cancelled: false,
  routeActive: true,
  requestRangeKey: '2026-11-22:2026-11-23',
  currentRangeKey: '2026-11-22:2026-11-23',
};

test('reports a failing initial request while its route and range are current', () => {
  assert.equal(shouldReportOperationalLoadFailure(currentFailure), true);
});

test('suppresses failures after a newer request replaces the initial request', () => {
  assert.equal(shouldReportOperationalLoadFailure({ ...currentFailure, currentRequestId: 3 }), false);
});

test('suppresses failures for cancelled, inactive, or changed-range requests', () => {
  assert.equal(shouldReportOperationalLoadFailure({ ...currentFailure, cancelled: true }), false);
  assert.equal(shouldReportOperationalLoadFailure({ ...currentFailure, routeActive: false }), false);
  assert.equal(shouldReportOperationalLoadFailure({ ...currentFailure, currentRangeKey: '2026-11-24:2026-11-25' }), false);
});
