import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOverviewUrl,
  parseTrafficReportSearchParams,
  toTrafficReportSearchParams,
} from './trafficReportContract.ts';

test('URL contract allows no season and no dates for the initial overview', () => {
  const filter = parseTrafficReportSearchParams(new URLSearchParams());
  assert.equal(buildOverviewUrl(filter), '/api/report/v1/overview');
  assert.equal(filter.from, null);
  assert.equal(filter.to, null);
});

test('URL contract sorts and deduplicates list filters', () => {
  const filter = parseTrafficReportSearchParams(new URLSearchParams('airline=VN&airline=QH&airline=VN&type=D'));
  assert.equal(toTrafficReportSearchParams(filter).toString(), 'type=D&airline=QH&airline=VN');
});

test('URL contract rejects half ranges, reversed ranges and unknown params', () => {
  assert.throws(() => parseTrafficReportSearchParams(new URLSearchParams('from=2026-01-01')));
  assert.throws(() => parseTrafficReportSearchParams(new URLSearchParams('from=2026-02-01&to=2026-01-01')));
  assert.throws(() => parseTrafficReportSearchParams(new URLSearchParams('season_id=W26')));
});
