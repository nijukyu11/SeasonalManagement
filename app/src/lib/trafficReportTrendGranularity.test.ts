import assert from 'node:assert/strict';
import test from 'node:test';
import { countCalendarMonths, shouldUseMonthlyTrend } from './trafficReportTrendGranularity.ts';

test('counts distinct calendar months inclusively', () => {
  assert.equal(countCalendarMonths('2026-01-31', '2026-03-01'), 3);
  assert.equal(countCalendarMonths('2026-01-31', '2026-04-01'), 4);
  assert.equal(countCalendarMonths('2025-11-15', '2026-02-02'), 4);
});

test('switches the trend to monthly only after three calendar months', () => {
  assert.equal(shouldUseMonthlyTrend('2026-01-01', '2026-03-31'), false);
  assert.equal(shouldUseMonthlyTrend('2026-01-31', '2026-04-01'), true);
});

test('rejects malformed dates instead of silently choosing a granularity', () => {
  assert.throws(() => countCalendarMonths('2026-01', '2026-03-31'), /không hợp lệ/u);
});
