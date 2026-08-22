import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  buildOverviewUrl,
  detectTrafficReportDatePreset,
  getLatestCompletedOpsDate,
  getTrafficReportPresetRange,
  parseTrafficReportSearchParams,
  toTrafficReportSearchParams,
  type TrafficReportBundle,
} from './trafficReportContract.ts';
import { buildTrafficWorkbookData } from './trafficReportExcelExport.ts';

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

test('date presets anchor to the latest Ops Date and stay inside the available domain', () => {
  assert.deepEqual(getTrafficReportPresetRange('7d', '2025-01-01', '2026-08-21'), { from: '2026-08-15', to: '2026-08-21' });
  assert.deepEqual(getTrafficReportPresetRange('30d', '2026-08-10', '2026-08-21'), { from: '2026-08-10', to: '2026-08-21' });
  assert.deepEqual(getTrafficReportPresetRange('ytd', '2025-01-01', '2026-08-21'), { from: '2026-01-01', to: '2026-08-21' });
});

test('latest completed Ops Date does not drift into future schedule dates', () => {
  assert.equal(getLatestCompletedOpsDate('2026-08-22T14:14:00.000Z', '2026-10-24'), '2026-08-21');
  assert.equal(getLatestCompletedOpsDate('2026-08-22T14:14:00.000Z', '2026-08-18'), '2026-08-18');
});

test('date preset detection keeps manually selected ranges custom', () => {
  assert.equal(detectTrafficReportDatePreset('2026-08-15', '2026-08-21', '2025-01-01', '2026-08-21'), '7d');
  assert.equal(detectTrafficReportDatePreset('2026-02-01', '2026-08-21', '2025-01-01', '2026-08-21'), null);
});

test('Excel workbook data stays aggregate-only and includes Phase 2 sheets', () => {
  const bundle: TrafficReportBundle = {
    contract_version: 'traffic-report-v1', request_hash: 'hash', data_as_of: '2026-08-22T00:00:00Z', source_watermark: 1,
    metadata: { min_ops_date: '2026-01-01', max_ops_date: '2026-12-31', normalized_filter: { from: '2026-08-15', to: '2026-08-21', type: 'all', airline: [], route: [], country: [], comp: 'previous', tz: 'local' }, day_count: 7, timeline_granularity: 'day', timeline_has_more: false, timeline_next_cursor: null, filter_options: { airline: ['VN'], route: ['HAN'] }, filter_options_limit: 250 },
    kpis: { current: { flights: 7, arrivals: 4, departures: 3, reported_pax: 100 }, comparison: { flights: 7, arrivals: 4, departures: 3, reported_pax: 100, from: '2026-08-08', to: '2026-08-14', mode: 'previous' }, peak_day: { ops_date: '2026-08-15', flights: 7, status: 'complete' }, pax_coverage: { reported_legs: 3, due_legs: 7, percent: 42.9, status: 'available' } },
    timeline: [{ ops_date: '2026-08-15', flights: 7, arrivals: 4, departures: 3, reported_pax: 100, completeness: 'complete' }],
    breakdowns: { airline: [], route: [], country: [], aircraft_group: [], peak_hour: [], day_of_week: [] },
    quality: { unknown_country_legs: 0, pax_due_missing_legs: 4, quarantined_duplicate_candidates: 0, notes: [] },
  };
  const workbook = buildTrafficWorkbookData(bundle, bundle.timeline);
  assert.deepEqual(Object.keys(workbook), ['Tổng quan', 'Timeline', 'Cơ cấu', '24 khung giờ', 'Thứ trong tuần']);
  assert.ok(!JSON.stringify(workbook).includes('flight_number'));
  assert.ok(!JSON.stringify(workbook).includes('record_id'));

  const xlsxWorkbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(workbook)) {
    XLSX.utils.book_append_sheet(xlsxWorkbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }
  const serialized = XLSX.write(xlsxWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  const reopened = XLSX.read(serialized, { type: 'buffer' });
  assert.deepEqual(reopened.SheetNames, Object.keys(workbook));
  assert.equal(reopened.Sheets['Tổng quan']?.A1?.v, 'BÁO CÁO SẢN LƯỢNG KHAI THÁC — AGGREGATE ONLY');
  assert.equal(reopened.Sheets.Timeline?.A2?.v, '2026-08-15');
});
