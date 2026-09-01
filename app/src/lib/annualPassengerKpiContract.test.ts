import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annualDashboardPublicationUrl,
  annualDashboardPublicationVersionUrl,
  annualKpiSnapshotUrl,
  annualKpiVersionUrl,
  currentHcmYear,
  decodeAnnualPassengerDashboardSnapshot,
  isAnnualPassengerKpiSnapshot,
  parseAnnualKpiYear,
} from './annualPassengerKpiContract.ts';

test('annual KPI URLs use the public report namespace', () => {
  assert.equal(annualKpiSnapshotUrl(2026), '/api/report/v1/annual-kpi?year=2026');
  assert.equal(annualKpiVersionUrl(2027), '/api/report/v1/dashboard-version?year=2027');
  assert.equal(annualDashboardPublicationUrl(2026), '/api/report/v1/dashboard-publication?year=2026');
  assert.equal(annualDashboardPublicationVersionUrl(2027), '/api/report/v1/dashboard-publication-version?year=2027');
});

test('current year follows Asia/Ho_Chi_Minh', () => {
  assert.equal(currentHcmYear(new Date('2026-12-31T17:30:00.000Z')), 2027);
});

test('snapshot guard rejects an incomplete payload', () => {
  assert.equal(isAnnualPassengerKpiSnapshot({ contract_version: 'annual-passenger-kpi-v1', year: 2026 }), false);
});

test('daily publication is adapted to the existing wallboard presentation contract', () => {
  const decoded = decodeAnnualPassengerDashboardSnapshot({
    contract_version: 'annual-passenger-publication-v1',
    year: 2026,
    period_state: 'current',
    period_from: '2026-01-01',
    period_to: '2026-03-02',
    monthly: [],
    publication: {
      publication_id: 17,
      business_date: '2026-03-02',
      published_at: '2026-03-03T02:00:00Z',
      data_as_of: '2026-03-03T02:00:00Z',
      source_watermark: 42,
      source_data_version: 3,
      metrics_contract_version: 'traffic-report-v2',
      payload_checksum: 'a'.repeat(64),
      latest_attempt_status: 'ready',
      latest_attempt_business_date: '2026-03-02',
      latest_attempt_completed_at: '2026-03-03T02:00:01Z',
      freshness: 'fresh',
    },
  });
  assert.equal(decoded?.projection.projection_status, 'fresh');
  assert.equal(decoded?.projection.source_watermark, 42);
  assert.equal(decoded?.publication?.business_date, '2026-03-02');
});

test('year selector accepts only a bounded four-digit dashboard year', () => {
  assert.equal(parseAnnualKpiYear('2026'), 2026);
  assert.equal(parseAnnualKpiYear('1999'), null);
  assert.equal(parseAnnualKpiYear('2026x'), null);
  assert.equal(parseAnnualKpiYear(null), null);
});
