import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCheckInCommitFailure,
  getCheckInCommitFailureSource,
  withCheckInCommitFailureSource,
} from './checkInCommitErrors.ts';

test('formats Error check-in commit failures with operation, source, leg ids, and raw message', () => {
  assert.equal(
    formatCheckInCommitFailure({
      description: 'Allocated TG559 to counter 21',
      legIds: ['leg-1'],
      source: 'checkin',
      error: new Error('apply season server mutation: permission denied'),
    }),
    'Allocated TG559 to counter 21 failed through checkin for leg-1: apply season server mutation: permission denied'
  );
});

test('formats non-Error check-in commit failures with operation, source, leg ids, and raw value', () => {
  assert.equal(
    formatCheckInCommitFailure({
      description: 'Moved TG559 check-in allocation',
      legIds: ['leg-1', 'leg-2'],
      source: 'checkin-worker',
      error: 'network timeout',
    }),
    'Moved TG559 check-in allocation failed through checkin-worker for leg-1, leg-2: network timeout'
  );
});

test('formats check-in commit failures with unknown leg when no leg ids are available', () => {
  assert.equal(
    formatCheckInCommitFailure({
      description: 'Allocated TG559 to counter 21',
      legIds: [],
      source: 'checkin',
      error: new Error('validation failed'),
    }),
    'Allocated TG559 to counter 21 failed through checkin for unknown leg: validation failed'
  );
});

test('caps check-in commit failure leg ids after the first five ids', () => {
  assert.equal(
    formatCheckInCommitFailure({
      description: 'Batch check-in allocation updates',
      legIds: ['leg-1', 'leg-2', 'leg-3', 'leg-4', 'leg-5', 'leg-6', 'leg-7'],
      source: 'checkin-worker',
      error: 'network timeout',
    }),
    'Batch check-in allocation updates failed through checkin-worker for leg-1, leg-2, leg-3, leg-4, leg-5 and 2 more: network timeout'
  );
});

test('preserves check-in commit failure source on Error values', () => {
  const error = new Error('native write failed');
  const taggedError = withCheckInCommitFailureSource(error, 'checkin-native');

  assert.equal(taggedError, error);
  assert.equal(getCheckInCommitFailureSource(taggedError, 'checkin'), 'checkin-native');
});

test('preserves check-in commit failure source on non-Error thrown values', () => {
  const taggedError = withCheckInCommitFailureSource('network timeout', 'checkin-worker');

  assert.equal(taggedError instanceof Error, true);
  assert.equal(taggedError.message, 'network timeout');
  assert.equal(getCheckInCommitFailureSource(taggedError, 'checkin'), 'checkin-worker');
});
