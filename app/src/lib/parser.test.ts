import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanFlightNumber } from './parser.ts';

test('cleanFlightNumber does not double-prefix raw values that already include airline', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559'), {
    flightNumber: 'TG559',
    rawFlightNumber: '559',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber keeps suffixes after removing existing airline prefix', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559A'), {
    flightNumber: 'TG559A',
    rawFlightNumber: '559A',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber still pads numeric values', () => {
  assert.deepEqual(cleanFlightNumber('TG', '59'), {
    flightNumber: 'TG059',
    rawFlightNumber: '059',
    requestStatusCode: null,
  });
});
