import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annualKpiSnapshotUrl,
  annualKpiVersionUrl,
  currentHcmYear,
  isAnnualPassengerKpiSnapshot,
  parseAnnualKpiYear,
} from './annualPassengerKpiContract.ts';

test('annual KPI URLs use the public report namespace', () => {
  assert.equal(annualKpiSnapshotUrl(2026), '/api/report/v1/annual-kpi?year=2026');
  assert.equal(annualKpiVersionUrl(2027), '/api/report/v1/dashboard-version?year=2027');
});

test('current year follows Asia/Ho_Chi_Minh', () => {
  assert.equal(currentHcmYear(new Date('2026-12-31T17:30:00.000Z')), 2027);
});

test('snapshot guard rejects an incomplete payload', () => {
  assert.equal(isAnnualPassengerKpiSnapshot({ contract_version: 'annual-passenger-kpi-v1', year: 2026 }), false);
});

test('year selector accepts only a bounded four-digit dashboard year', () => {
  assert.equal(parseAnnualKpiYear('2026'), 2026);
  assert.equal(parseAnnualKpiYear('1999'), null);
  assert.equal(parseAnnualKpiYear('2026x'), null);
  assert.equal(parseAnnualKpiYear(null), null);
});
