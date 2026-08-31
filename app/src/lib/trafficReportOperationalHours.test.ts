import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TrafficReportBundle, TrafficTimeBasis } from './trafficReportContract.ts';
import { buildTrafficWorkbookData } from './trafficReportExcelExport.ts';
import {
  getAverageFlightsPerSelectedDay,
  getOperationalHourOffset,
  getSelectedDayCountForMonth,
  orderTrafficPeakHours,
} from './trafficReportOperationalHours.ts';

const hours = Array.from({ length: 24 }, (_, hour) => ({
  hour_bucket: `${String(hour).padStart(2, '0')}:00`,
}));

test('local operational day is ordered from 05:00 through 04:00', () => {
  const ordered = orderTrafficPeakHours([...hours].reverse(), 'local').map((row) => row.hour_bucket);
  assert.deepEqual(ordered, [
    '05:00', '06:00', '07:00', '08:00', '09:00', '10:00',
    '11:00', '12:00', '13:00', '14:00', '15:00', '16:00',
    '17:00', '18:00', '19:00', '20:00', '21:00', '22:00',
    '23:00', '00:00', '01:00', '02:00', '03:00', '04:00',
  ]);
});

test('UTC operational day is ordered from 22:00 through 21:00', () => {
  const ordered = orderTrafficPeakHours(hours, 'utc').map((row) => row.hour_bucket);
  assert.deepEqual(ordered, [
    '22:00', '23:00', '00:00', '01:00', '02:00', '03:00',
    '04:00', '05:00', '06:00', '07:00', '08:00', '09:00',
    '10:00', '11:00', '12:00', '13:00', '14:00', '15:00',
    '16:00', '17:00', '18:00', '19:00', '20:00', '21:00',
  ]);
});

test('invalid buckets sort last without disturbing their input order', () => {
  const ordered = orderTrafficPeakHours([
    { hour_bucket: 'invalid-a' },
    { hour_bucket: '05:00' },
    { hour_bucket: 'invalid-b' },
  ], 'local').map((row) => row.hour_bucket);
  assert.deepEqual(ordered, ['05:00', 'invalid-a', 'invalid-b']);
  assert.equal(getOperationalHourOffset('24:00', 'local'), Number.POSITIVE_INFINITY);
});

test('peak-hour totals are converted to averages over every selected Ops Date', () => {
  assert.equal(getAverageFlightsPerSelectedDay(1048, 241), 1048 / 241);
  assert.equal(getAverageFlightsPerSelectedDay(1070, 241), 1070 / 241);
  assert.equal(getAverageFlightsPerSelectedDay(0, 241), 0, 'a real zero stays zero');
  assert.equal(getAverageFlightsPerSelectedDay(null, 241), null, 'missing data stays missing');
  assert.equal(getAverageFlightsPerSelectedDay(12, 0), null, 'an invalid denominator must not fabricate an average');
});

test('monthly averages use only the selected dates that intersect each month', () => {
  assert.equal(getSelectedDayCountForMonth('2026-01', '2026-01-15', '2026-03-10'), 17);
  assert.equal(getSelectedDayCountForMonth('2026-02', '2026-01-15', '2026-03-10'), 28);
  assert.equal(getSelectedDayCountForMonth('2026-03', '2026-01-15', '2026-03-10'), 10);
  assert.equal(getSelectedDayCountForMonth('2025-12', '2026-01-15', '2026-03-10'), 0);
  assert.equal(getSelectedDayCountForMonth('invalid', '2026-01-15', '2026-03-10'), 0);
});

function reportBundle(timeBasis: TrafficTimeBasis): TrafficReportBundle {
  return {
    contract_version: 'traffic-report-v1',
    request_hash: 'hour-order-test',
    data_as_of: '2026-08-30T00:00:00Z',
    source_watermark: 1,
    metadata: {
      min_ops_date: '2026-08-01',
      max_ops_date: '2026-08-31',
      normalized_filter: { from: '2026-08-01', to: '2026-08-07', type: 'all', airline: [], route: [], country: [], comp: 'none', tz: timeBasis },
      day_count: 7,
      timeline_granularity: 'day',
      timeline_has_more: false,
      timeline_next_cursor: null,
      filter_options: { airline: [], route: [], country: [] },
      filter_options_limit: 250,
    },
    kpis: {
      current: { flights: 24, arrivals: 12, departures: 12, reported_pax: null },
      comparison: { flights: null, arrivals: null, departures: null, reported_pax: null, from: null, to: null, mode: 'none' },
      peak_day: { ops_date: '2026-08-01', flights: 24, status: 'complete' },
      pax_coverage: { reported_legs: null, due_legs: null, percent: null, status: 'unavailable' },
    },
    timeline: [],
    breakdowns: {
      airline: [],
      route: [],
      country: [],
      aircraft_group: [],
      peak_hour: [...hours].reverse().map((row, index) => ({ ...row, bucket_minutes: 60, time_basis: timeBasis, arrivals: index, departures: index + 1, suppressed: false })),
      peak_hour_monthly: [],
      day_of_week: [],
    },
    quality: { unknown_country_legs: null, pax_due_missing_legs: null, quarantined_duplicate_candidates: null, notes: [] },
  };
}

test('Excel keeps auditable period totals while the operations chart presents daily averages', () => {
  const localWorkbook = buildTrafficWorkbookData(reportBundle('local'), []);
  const utcWorkbook = buildTrafficWorkbookData(reportBundle('utc'), []);
  assert.equal(localWorkbook['24 khung giờ'][1][0], '05:00');
  assert.equal(localWorkbook['24 khung giờ'][24][0], '04:00');
  assert.equal(utcWorkbook['24 khung giờ'][1][0], '22:00');
  assert.equal(utcWorkbook['24 khung giờ'][24][0], '21:00');
  const localSourceTotal = reportBundle('local').breakdowns.peak_hour.find((row) => row.hour_bucket === '05:00')?.arrivals;
  assert.equal(localWorkbook['24 khung giờ'][1][2], localSourceTotal, 'Excel must preserve the total instead of dividing by selected days');
  assert.doesNotMatch(JSON.stringify(localWorkbook['24 khung giờ'][0]), /TB\/ngày/);
  assert.doesNotMatch(JSON.stringify(localWorkbook), /Tỷ lệ chuyến có số khách|Chuyến đã đến hạn|Trạng thái dữ liệu|Đã ẩn/);
});

test('operations UI keeps mobile scroll regions accessible and removes technical wording', () => {
  const source = readFileSync(new URL('../app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label="Biểu đồ 24 khung giờ khai thác, có thể cuộn ngang trên màn hình nhỏ"/);
  assert.match(source, /Vuốt ngang để xem đủ 24 khung giờ/);
  assert.match(source, /Trung bình số chuyến trong từng khung giờ/);
  assert.match(source, /TB chuyến bay đến\/ngày/);
  assert.match(source, /Tổng chuyến bay đến trong kỳ/);
  assert.match(source, /getSelectedDayCountForMonth/);
  assert.match(source, /monthlyRows\.length > 0 \? <details className=/);
  assert.doesNotMatch(source, /monthlyRows\.length > 0 \? <details[^>]*\sopen/);
  assert.match(source, /Giờ cao điểm chuyến bay đến/);
  assert.match(source, /Trung bình số chuyến/);
  assert.match(source, /thấp nhất–cao nhất/);
  assert.match(source, /Sản lượng khách/);
  assert.match(source, /title=\{row\.label\} aria-label=\{row\.label\}/);
  assert.doesNotMatch(source, /Trạng thái|cohort|database|Đã ẩn/);
});
