import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSeasonalDate,
  normalizeSeasonalDay,
  normalizeSeasonalTime,
  REQUIRED_SEASONAL_HEADERS,
} from './seasonalSourceRowValidation.ts';

test('REQUIRED_SEASONAL_HEADERS defines the canonical source columns', () => {
  assert.deepEqual(REQUIRED_SEASONAL_HEADERS, [
    'Effective',
    'Discontinue',
    'Airline',
    'Aircraft',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
    'Sun',
    'STA',
    'ARRFlight',
    'ARRRoute',
    'STD',
    'DEPFlight',
    'DEPRoute',
  ]);
});

test('normalizeSeasonalDate accepts case-insensitive seasonal dates and ISO dates', () => {
  assert.equal(normalizeSeasonalDate('01-MAR-27'), '2027-03-01');
  assert.equal(normalizeSeasonalDate('1-mar-2027'), '2027-03-01');
  assert.equal(normalizeSeasonalDate('2027-03-01'), '2027-03-01');
});

test('normalizeSeasonalDate accepts Excel serial dates and rejects rollover dates', () => {
  assert.equal(normalizeSeasonalDate(0), null);
  assert.equal(normalizeSeasonalDate(0.5), null);
  assert.equal(normalizeSeasonalDate(60), null);
  assert.equal(normalizeSeasonalDate(46447), '2027-03-01');
  assert.equal(normalizeSeasonalDate('31-Apr-27'), null);
  assert.equal(normalizeSeasonalDate('2027-04-31'), null);
});

test('normalizeSeasonalTime accepts strict clock values and valid Excel fractions', () => {
  assert.equal(normalizeSeasonalTime('00:00'), '00:00');
  assert.equal(normalizeSeasonalTime('07:05'), '07:05');
  assert.equal(normalizeSeasonalTime('23:59'), '23:59');
  assert.equal(normalizeSeasonalTime(0.5), '12:00');
  assert.equal(normalizeSeasonalTime(1439 / 1440), '23:59');
});

test('normalizeSeasonalTime rejects values outside the canonical clock range', () => {
  assert.equal(normalizeSeasonalTime('7:05'), null);
  assert.equal(normalizeSeasonalTime('24:00'), null);
  assert.equal(normalizeSeasonalTime('12:60'), null);
  assert.equal(normalizeSeasonalTime('noon'), null);
  assert.equal(normalizeSeasonalTime(-0.5), null);
  assert.equal(normalizeSeasonalTime(1), null);
});

test('normalizeSeasonalDay accepts only canonical boolean representations', () => {
  for (const value of [true, 1, 'TRUE', 'true', '1']) {
    assert.deepEqual(normalizeSeasonalDay(value), { value: true, valid: true });
  }
  for (const value of [false, 0, 'FALSE', 'false', '0', '', '   ', null, undefined]) {
    assert.deepEqual(normalizeSeasonalDay(value), { value: false, valid: true });
  }
  for (const value of [2, -1, 'YES', 'x']) {
    assert.deepEqual(normalizeSeasonalDay(value), { value: false, valid: false });
  }
});
