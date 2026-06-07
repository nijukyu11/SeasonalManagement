import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesSeasonalFlightFilter, parseCommaFilterTerms } from './seasonalFlightFilter.ts';

test('parseCommaFilterTerms ignores empty trailing comma terms', () => {
  assert.deepEqual(parseCommaFilterTerms('8M, '), ['8m']);
});

test('parseCommaFilterTerms does not split whitespace', () => {
  assert.deepEqual(parseCommaFilterTerms('8M YP'), ['8m yp']);
});

test('matchesSeasonalFlightFilter matches comma terms as OR', () => {
  assert.equal(matchesSeasonalFlightFilter({
    arrFlightNumber: null,
    depFlightNumber: '8M101',
    airline: '8M',
  }, '8M, YP'), true);
  assert.equal(matchesSeasonalFlightFilter({
    arrFlightNumber: 'VN300',
    depFlightNumber: null,
    airline: 'VN',
  }, '8M, YP'), false);
});

test('matchesSeasonalFlightFilter keeps whitespace text as one term', () => {
  assert.equal(matchesSeasonalFlightFilter({
    arrFlightNumber: null,
    depFlightNumber: '8M101',
    airline: '8M',
  }, '8M YP'), false);
});
