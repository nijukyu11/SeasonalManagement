import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import {
  buildTrafficWorkbookExportUrl,
  getTrafficComparisonYearRange,
  getTrafficMonthRange,
  getTrafficMonthRangeRange,
  getTrafficSeasonOptions,
  getTrafficSeasonRange,
  getTrafficWeeklyContextRange,
  getTrafficYearRange,
  normalizeTrafficWorkbookExportDraft,
} from './trafficWorkbookExportContract.ts';
import {
  buildWorkbookReportModel,
  normalizeWorkbookRequest,
  workbookComparisonRanges,
  workbookComparisonYearRanges,
  workbookWeeklyContextRanges,
} from '../../supabase/functions/_shared/trafficWorkbookCore.ts';
import {
  buildTrafficWorkbookPackage,
  trafficWorkbookFilename,
} from '../../supabase/functions/_shared/trafficWorkbookRenderer.ts';

function foundationModel(overrides: Partial<Parameters<typeof buildWorkbookReportModel>[0]> = {}) {
  return buildWorkbookReportModel({
    request: normalizeWorkbookRequest(new URL('https://report.test/?report_type=MASTER_OPERATIONS&template_version=master-v1&period_mode=custom&from=2026-09-01&to=2026-09-04')),
    requestHash: 'foundation', requestId: 'foundation', generatedAt: '2026-09-05T00:00:00.000Z',
    currentBundle: { metadata: {}, kpis: { current: { flights: 0, arrivals: 0, departures: 0, reported_pax: null } }, timeline: [], breakdowns: {} },
    currentDimensions: { airline: [], country: [], route: [] },
    ...overrides,
  });
}

test('context-only groups never borrow production from another period', () => {
  const prior = { key: 'prior-only', label: 'Prior only', flights: 10, arrivals: 6, departures: 4, reported_pax: 1000, flight_share: 1 };
  const next = { key: 'next-only', label: 'Next only', flights: 3, arrivals: 1, departures: 2, reported_pax: null, flight_share: 1 };
  const model = foundationModel({
    previousDimensions: { airline: [prior], country: [prior], route: [prior] },
    nextDimensions: { airline: [next], country: [next], route: [next] },
  });
  for (const rows of [model.airlines, model.countries, model.routes]) {
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.flights, null);
      assert.equal(row.arrivals, null);
      assert.equal(row.departures, null);
      assert.equal(row.reportedPax, null);
      assert.equal(row.flightShare, null);
    }
    assert.equal(rows.find((row) => row.key === 'prior-only')?.previous?.flights, 10);
    assert.equal(rows.find((row) => row.key === 'next-only')?.next?.flights, 3);
  }
});

test('groups present only in previous or year-ago periods remain visible without next context', () => {
  const prior = { key: 'prior', label: 'Prior', flights: 8, arrivals: 5, departures: 3, reported_pax: 900 };
  const yearAgo = { key: 'year-ago', label: 'Year ago', flights: 2, arrivals: 1, departures: 1, reported_pax: 200 };
  const model = foundationModel({
    previousDimensions: { airline: [prior], country: [], route: [] },
    yearAgoDimensions: { airline: [yearAgo], country: [], route: [] },
  });
  assert.deepEqual(model.airlines.map((row) => row.key), ['prior', 'year-ago']);
  assert.equal(model.airlines[0].flights, null);
  assert.equal(model.airlines[1].yearAgo?.reportedPax, 200);
});

test('boundary periods use selected calendar days and preserve directional Pax and true zero', () => {
  const timeline = Array.from({ length: 4 }, (_, index) => ({
    ops_date: `2026-09-0${index + 1}`, flights: 10, arrivals: 6, departures: 4,
    reported_pax: index === 0 ? 100 : null,
    arrival_reported_pax: index === 0 ? 100 : null,
    departure_reported_pax: index === 0 ? 0 : null,
    completeness: 'complete',
  }));
  const model = foundationModel({ currentBundle: {
    metadata: { day_count: 4 }, timeline, breakdowns: {},
    kpis: { current: { flights: 40, arrivals: 24, departures: 16, reported_pax: 100 } },
  } });
  const month = model.timelineMonthly[0];
  assert.equal(month.from, '2026-09-01');
  assert.equal(month.to, '2026-09-04');
  assert.equal(month.calendarDays, 4);
  assert.equal(month.averageFlights, 10);
  assert.equal(month.reportedPax, 100);
  assert.equal(month.arrivalReportedPax, 100);
  assert.equal(month.departureReportedPax, 0);
  assert.deepEqual(model.timelineBusinessWeek.map((row) => [row.from, row.to, row.calendarDays]), [
    ['2026-09-01', '2026-09-03', 3], ['2026-09-04', '2026-09-04', 1],
  ]);
  assert.equal(model.timelineBusinessWeek[1].reportedPax, null);
  assert.equal(model.timelineBusinessWeek[1].departureReportedPax, null);
});

test('a missing day stays inside the selected calendar denominator', () => {
  const model = foundationModel({ currentBundle: {
    metadata: { day_count: 4 }, kpis: { current: { flights: 30, arrivals: 18, departures: 12, reported_pax: null } }, breakdowns: {},
    timeline: [1, 3, 4].map((day) => ({ ops_date: `2026-09-0${day}`, flights: 10, arrivals: 6, departures: 4, reported_pax: null, completeness: 'complete' })),
  } });
  assert.equal(model.timelineMonthly[0].calendarDays, 4);
  assert.equal(model.timelineMonthly[0].averageFlights, 7.5);
  assert.equal(model.timelineMonthly[0].completeness, 'missing');
});

test('each comparison uses its own calendar denominator including leap years', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/?report_type=MONTHLY_OVERVIEW_L2&template_version=monthly-l2-v1&period_mode=month&month=2024-03&from=2024-03-01&to=2024-03-31&comparison=previous&comparison=year_ago'));
  const metrics = (flights: number) => ({ kpis: { current: { flights, arrivals: flights, departures: 0, reported_pax: null } }, metadata: {}, timeline: [], breakdowns: {} });
  const model = foundationModel({ request, currentBundle: metrics(310), previousBundle: metrics(290), yearAgoBundle: metrics(620) });
  const reopened = XLSX.read(zipSync(buildTrafficWorkbookPackage(model)), { type: 'array' });
  const sheet = reopened.Sheets['Sản lượng chuyến bay'];
  assert.equal(sheet.F4.v, 31);
  assert.equal(sheet.F5.v, 29);
  assert.equal(sheet.F6.v, 31);
  assert.equal(sheet.G4.v, 10);
  assert.equal(sheet.G5.v, 10);
  assert.equal(sheet.G6.v, 20);
});

test('weekly calendar aggregation retains previous and next context boundaries', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/?report_type=WEEKLY_DETAIL&template_version=weekly-detail-v1&period_mode=custom&from=2026-09-08&to=2026-09-11'));
  const day = (ops_date: string) => ({ ops_date, flights: 1, arrivals: 1, departures: 0, reported_pax: null, completeness: 'complete' });
  const period = (dates: string[]) => ({ metadata: {}, kpis: {}, breakdowns: {}, timeline: dates.map(day) });
  const model = foundationModel({ request,
    currentBundle: period(['2026-09-08', '2026-09-11']),
    previousBundle: period(['2026-09-01', '2026-09-07']),
    nextBundle: period(['2026-09-12', '2026-09-18']),
  });
  assert.equal(model.timelineMonthly[0].from, '2026-09-01');
  assert.equal(model.timelineMonthly[0].to, '2026-09-18');
  assert.equal(model.timelineMonthly[0].calendarDays, 18);
});
const filter = {
  from: '2026-09-01', to: '2026-09-30', type: 'all' as const,
  airline: [], route: [], country: [], comp: 'previous' as const, tz: 'local' as const,
};

function bundle(from: string, to: string, flights: number, dataAsOf = '2026-10-02T00:00:00.000Z') {
  return {
    contract_version: 'traffic-report-v1', request_hash: 'source-hash', data_as_of: dataAsOf, source_watermark: 50104,
    metadata: {
      min_ops_date: '2025-01-01', max_ops_date: '2027-03-27', latest_completed_ops_date: '2026-09-30',
      normalized_filter: { ...filter, from, to }, day_count: 30, timeline_has_more: false, timeline_next_cursor: null,
      projection: { status: 'fresh' },
    },
    kpis: {
      current: { flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: flights * 100, status: 'complete' },
      peak_day: { ops_date: from, flights: Math.min(flights, 140), status: 'complete' },
      pax_coverage: { reported_legs: flights, due_legs: flights, percent: 100, status: 'available' },
    },
    timeline: [
      { ops_date: from, flights: Math.min(flights, 140), arrivals: 70, departures: 70, reported_pax: 14_000, completeness: 'complete', reported_legs: 140, due_legs: 140, pax_coverage_pct: 100, pax_status: 'available' },
      { ops_date: to, flights: Math.min(flights, 120), arrivals: 60, departures: 60, reported_pax: null, completeness: 'partial', reported_legs: 0, due_legs: 120, pax_coverage_pct: 0, pax_status: 'unavailable' },
    ],
    breakdowns: {
      peak_hour: [{ hour_bucket: '07:00', arrivals: 60, departures: 50, suppressed: false, regular_flights: { arrivals: [], departures: [] } }],
      peak_hour_monthly: [{ month: from.slice(0, 7), time_basis: 'local', arrival_hour: '07:00', arrival_flights: 60, departure_hour: '08:00', departure_flights: 50, arrival_suppressed: false, departure_suppressed: false }],
      day_of_week: [],
      aircraft_group: [{ key: 'narrowbody', label: 'Narrowbody', flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: flights * 100, share: 1 }],
      aircraft_type: [{ key: 'a320', aircraft_group: 'Narrowbody', label: 'A320', flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: flights * 100, share: 1 }],
    },
    quality: { unknown_country_legs: 1, pax_due_missing_legs: 120, quarantined_duplicate_candidates: 2, notes: ['fixture quality note'] },
  };
}

const dimensions = {
  airline: [{ key: 'vn', label: '=VN', flights: 3898, arrivals: 1950, departures: 1948, reported_pax: 389_800, flight_share: 1, pax_share: 1, reported_legs: 3898, due_legs: 3898, pax_coverage_pct: 100, pax_status: 'available', suppressed: false }],
  country: [{ key: 'unknown', label: 'Unknown', flights: 3898, arrivals: 1950, departures: 1948, reported_pax: 389_800, flight_share: 1, pax_share: 1, reported_legs: 3898, due_legs: 3898, pax_coverage_pct: 100, pax_status: 'available', suppressed: false }],
  route: [{ key: 'dad-han', label: 'DAD-HAN', flights: 3898, arrivals: 1950, departures: 1948, reported_pax: 389_800, flight_share: 1, pax_share: 1, reported_legs: 3898, due_legs: 3898, pax_coverage_pct: 100, pax_status: 'available', suppressed: false }],
};

test('season and month presets normalize exact inclusive Ops Date ranges', () => {
  assert.deepEqual(getTrafficSeasonRange('S26'), { code: 'S26', from: '2026-03-29', to: '2026-10-24' });
  assert.deepEqual(getTrafficSeasonRange('W26'), { code: 'W26', from: '2026-10-25', to: '2027-03-27' });
  assert.deepEqual(getTrafficMonthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.ok(getTrafficSeasonOptions('2026-01-01', '2027-12-31').some((season) => season.code === 'S26'));
});

test('period presets and same-period years preserve leap-day and cross-year semantics', () => {
  assert.deepEqual(getTrafficMonthRangeRange('2026-11', '2027-02'), { from: '2026-11-01', to: '2027-02-28' });
  assert.deepEqual(getTrafficYearRange('2028'), { from: '2028-01-01', to: '2028-12-31' });
  assert.deepEqual(getTrafficComparisonYearRange({ periodMode: 'custom', from: '2028-02-29', to: '2028-03-02', comparisonYear: 2027 }), { from: '2027-02-28', to: '2027-03-02', label: '2027' });
  assert.deepEqual(getTrafficComparisonYearRange({ periodMode: 'month_range', from: '2026-11-01', to: '2027-02-28', comparisonYear: 2025 }), { from: '2025-11-01', to: '2026-02-28', label: '2025–2026' });
});

test('client request contract allowlists report/template and preserves current dimension filters', () => {
  const request = normalizeTrafficWorkbookExportDraft({
    reportType: 'MONTHLY_OVERVIEW_L2', periodMode: 'month', seasonCode: '', month: '2026-09',
    monthFrom: '', monthTo: '', year: '', from: '', to: '', comparisons: ['previous', 'year_ago'], comparisonYears: [], timeBasis: 'local',
  }, { ...filter, airline: ['VN'] }, '2025-01-01', '2027-03-27');
  assert.equal(request.templateVersion, 'monthly-l2-v1');
  assert.deepEqual(request.period, { mode: 'month', month: '2026-09', seasonCode: undefined, from: '2026-09-01', to: '2026-09-30' });
  const url = buildTrafficWorkbookExportUrl(request);
  assert.match(url, /^\/api\/report\/v1\/workbook-export\?/u);
  assert.match(url, /report_type=MONTHLY_OVERVIEW_L2/u);
  assert.match(url, /airline=VN/u);
  assert.throws(() => normalizeTrafficWorkbookExportDraft({ ...request, reportType: 'MONTHLY_OVERVIEW_L2', periodMode: 'custom', seasonCode: '', month: '2026-09', comparisons: request.comparisons } as never, filter, '2025-01-01', '2027-03-27'));
});

test('weekly detail adds exactly seven days before and after the selected range', () => {
  assert.deepEqual(getTrafficWeeklyContextRange('2026-09-08', '2026-09-14'), {
    previous: { from: '2026-09-01', to: '2026-09-07' },
    selected: { from: '2026-09-08', to: '2026-09-14' },
    next: { from: '2026-09-15', to: '2026-09-21' },
    full: { from: '2026-09-01', to: '2026-09-21' },
  });
  const request = normalizeTrafficWorkbookExportDraft({
    reportType: 'WEEKLY_DETAIL', periodMode: 'custom', seasonCode: '', month: '',
    monthFrom: '', monthTo: '', year: '', from: '2026-09-08', to: '2026-09-14', comparisons: ['previous', 'year_ago'], comparisonYears: [], timeBasis: 'local',
  }, filter, '2026-01-01', '2026-12-31');
  assert.equal(request.templateVersion, 'weekly-detail-v1');
  assert.deepEqual(request.comparisons, []);
  assert.match(buildTrafficWorkbookExportUrl(request), /report_type=WEEKLY_DETAIL/u);
  assert.throws(() => normalizeTrafficWorkbookExportDraft({
    reportType: 'WEEKLY_DETAIL', periodMode: 'custom', seasonCode: '', month: '',
    monthFrom: '', monthTo: '', year: '', from: '2026-01-01', to: '2026-01-07', comparisons: [], comparisonYears: [], timeBasis: 'local',
  }, filter, '2026-01-01', '2026-12-31'));
});

test('server request normalization rejects drifted presets and unknown templates', () => {
  const valid = new URL('https://report.test/api/report/v1/workbook-export?report_type=MONTHLY_OVERVIEW_L2&template_version=monthly-l2-v1&period_mode=month&from=2026-09-01&to=2026-09-30&month=2026-09&comparison=previous&comparison=year_ago');
  const normalized = normalizeWorkbookRequest(valid);
  assert.equal(normalized.reportType, 'MONTHLY_OVERVIEW_L2');
  assert.deepEqual(workbookComparisonRanges(normalized), [
    { mode: 'previous', from: '2026-08-01', to: '2026-08-31' },
    { mode: 'year_ago', from: '2025-09-01', to: '2025-09-30' },
  ]);
  assert.throws(() => normalizeWorkbookRequest(new URL(valid.href.replace('to=2026-09-30', 'to=2026-09-29'))));
  assert.throws(() => normalizeWorkbookRequest(new URL(valid.href.replace('monthly-l2-v1', 'monthly-l2-v2'))));
  assert.throws(() => normalizeWorkbookRequest(new URL(`${valid.href}&sheet=Data`)));
});

test('server weekly detail contract fixes context ranges and rejects manual comparisons', () => {
  const valid = new URL('https://report.test/api/report/v1/workbook-export?report_type=WEEKLY_DETAIL&template_version=weekly-detail-v1&period_mode=custom&from=2026-09-08&to=2026-09-14');
  const normalized = normalizeWorkbookRequest(valid);
  assert.equal(normalized.reportType, 'WEEKLY_DETAIL');
  assert.deepEqual(workbookWeeklyContextRanges(normalized), [
    { mode: 'previous', from: '2026-09-01', to: '2026-09-07' },
    { mode: 'selected', from: '2026-09-08', to: '2026-09-14' },
    { mode: 'next', from: '2026-09-15', to: '2026-09-21' },
  ]);
  assert.throws(() => normalizeWorkbookRequest(new URL(`${valid.href}&comparison=previous`)));
});

test('period analysis accepts multiple comparison years without a fixed three-year limit', () => {
  const years = Array.from({ length: 12 }, (_, index) => 2025 - index);
  const query = years.map((year) => `comparison_year=${year}`).join('&');
  const normalized = normalizeWorkbookRequest(new URL(`https://report.test/api/report/v1/workbook-export?report_type=PERIOD_ANALYSIS&template_version=period-analysis-v1&period_mode=custom&from=2026-02-28&to=2026-03-02&${query}`));
  assert.deepEqual(normalized.comparisonYears, years);
  const ranges = workbookComparisonYearRanges(normalized);
  assert.equal(ranges.length, 12);
  assert.deepEqual(ranges[0], { id: 'comparison-2025', comparisonYear: 2025, label: '2025', from: '2025-02-28', to: '2025-03-02', calendarDays: 3 });
  assert.throws(() => normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=BAO_CAO_SAN_LUONG&template_version=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24&comparison_year=2025')));
});

test('monthly renderer creates nine business sheets, two native charts and formula-safe text', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=MONTHLY_OVERVIEW_L2&template_version=monthly-l2-v1&period_mode=month&from=2026-09-01&to=2026-09-30&month=2026-09&comparison=previous&comparison=year_ago'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'a'.repeat(64), requestId: 'request-1', generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: bundle('2026-09-01', '2026-09-30', 3898), previousBundle: bundle('2026-08-01', '2026-08-31', 3700), yearAgoBundle: bundle('2025-09-01', '2025-09-30', 3500),
    currentDimensions: dimensions, previousDimensions: dimensions, yearAgoDimensions: dimensions,
  });
  assert.equal(model.metadata.publishStatus, 'FINAL');
  const packageFiles = buildTrafficWorkbookPackage(model);
  assert.equal(Object.keys(packageFiles).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path)).length, 9);
  assert.equal(Object.keys(packageFiles).filter((path) => /^xl\/charts\/chart\d+\.xml$/u.test(path)).length, 2);
  assert.ok(!Object.keys(packageFiles).some((path) => /vbaProject|externalLink|pivotCache|sharedStrings/iu.test(path)));
  const allXml = Object.entries(packageFiles).filter(([path]) => path.endsWith('.xml')).map(([, bytes]) => strFromU8(bytes)).join('\n');
  assert.doesNotMatch(allXml, /<f>|#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/iu);
  assert.doesNotMatch(allXml, /canonical|data_as_of|watermark|request hash|template version|renderer version|audit metadata|Coverage Pax|PeriodId|Suppressed|Kiểm soát dữ liệu|name="Kiểm soát"/iu);
  assert.match(allXml, /&apos;=VN/u);
  const zipped = zipSync(packageFiles, { level: 6 });
  const reopened = XLSX.read(zipped, { type: 'array', cellDates: true });
  assert.deepEqual(reopened.SheetNames, ['Tóm tắt tháng', 'Sản lượng chuyến bay', 'Ngày cao điểm', 'Giờ cao điểm', 'Chuyến bay sớm', 'Hãng hàng không', 'Thị trường', 'Chặng bay', 'Ghi chú nghiệp vụ']);
  assert.equal(reopened.Sheets['Tóm tắt tháng']?.A1?.v, 'TÓM TẮT KHAI THÁC THÁNG 2026-09');
  assert.match(trafficWorkbookFilename(model), /^tong-quan-khai-thac-2026-09-final-/u);
});

test('renderer keeps strict Open XML element order for Excel Desktop', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=MONTHLY_OVERVIEW_L2&template_version=monthly-l2-v1&period_mode=month&from=2026-09-01&to=2026-09-30&month=2026-09&comparison=previous&comparison=year_ago'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'f'.repeat(64), requestId: 'request-openxml', generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: bundle('2026-09-01', '2026-09-30', 3898), previousBundle: bundle('2026-08-01', '2026-08-31', 3700), yearAgoBundle: bundle('2025-09-01', '2025-09-30', 3500),
    currentDimensions: dimensions, previousDimensions: dimensions, yearAgoDimensions: dimensions,
  });
  const packageFiles = buildTrafficWorkbookPackage(model);
  assert.ok(!Object.keys(packageFiles).some((path) => /theme\/theme1\.xml$/u.test(path)));
  for (const [path, bytes] of Object.entries(packageFiles).filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))) {
    const source = strFromU8(bytes);
    if (source.includes('<tableParts ')) {
      assert.doesNotMatch(source, /<autoFilter /u, `${path} must not duplicate the Excel Table autoFilter at worksheet level`);
    } else if (source.includes('<autoFilter ')) {
      assert.ok(source.indexOf('<autoFilter ') < source.indexOf('<mergeCells '), `${path} must place worksheet autoFilter before mergeCells`);
    }
  }
  for (const [path, bytes] of Object.entries(packageFiles).filter(([path]) => /^xl\/tables\/table\d+\.xml$/u.test(path))) {
    assert.match(strFromU8(bytes), /<autoFilter /u, `${path} must keep the Excel Table autoFilter`);
  }
  for (const [path, bytes] of Object.entries(packageFiles).filter(([path]) => /^xl\/charts\/chart\d+\.xml$/u.test(path))) {
    const source = strFromU8(bytes);
    assert.ok(source.indexOf('<c:majorGridlines/>') < source.indexOf('<c:numFmt '), `${path} must place majorGridlines before numFmt`);
  }
  const styles = strFromU8(packageFiles['xl/styles.xml']);
  assert.match(styles, /<font><b\/><sz val="16"\/><color rgb="FFFFFFFF"\/><name val="Aptos Display"\/><\/font>/u);
  assert.match(styles, /<tableStyles count="0"/u);
});

test('master renderer creates twelve reader-facing sheets without technical control content', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=MASTER_OPERATIONS&template_version=master-v1&period_mode=custom&from=2026-09-01&to=2026-09-30&comparison=previous'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'b'.repeat(64), requestId: 'request-2', generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: bundle('2026-09-01', '2026-09-30', 3898), previousBundle: bundle('2026-08-02', '2026-08-31', 3700),
    currentDimensions: dimensions, previousDimensions: dimensions,
  });
  const packageFiles = buildTrafficWorkbookPackage(model);
  const zipped = zipSync(packageFiles, { level: 6 });
  assert.equal(Object.keys(unzipSync(zipped)).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path)).length, 12);
  const reopened = XLSX.read(zipped, { type: 'array' });
  assert.deepEqual(reopened.SheetNames, ['Hướng dẫn', 'Thông tin báo cáo', 'Tổng quan', 'Theo ngày', 'Theo tháng', 'Theo tuần', 'Hãng hàng không', 'Thị trường', 'Chặng bay', 'Giờ khai thác', 'Tần suất', 'Tàu bay']);
  const packageText = Object.entries(packageFiles).filter(([path]) => path.endsWith('.xml')).map(([, value]) => strFromU8(value)).join('\n');
  assert.doesNotMatch(packageText, /record_id|raw_history|deleted_row|overlay_internals|<sheet[^>]+name="Data"/iu);
  assert.doesNotMatch(packageText, /canonical|data_as_of|watermark|request hash|template version|renderer version|audit metadata|Coverage Pax|PeriodId|Suppressed|Kiểm soát dữ liệu/iu);
});

test('weekly renderer creates eight detailed sheets with previous, selected and next context', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=WEEKLY_DETAIL&template_version=weekly-detail-v1&period_mode=custom&from=2026-09-08&to=2026-09-14'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'c'.repeat(64), requestId: 'request-3', generatedAt: '2026-09-22T00:00:00.000Z',
    currentBundle: bundle('2026-09-08', '2026-09-14', 980), previousBundle: bundle('2026-09-01', '2026-09-07', 930), nextBundle: bundle('2026-09-15', '2026-09-21', 1010),
    currentDimensions: dimensions, previousDimensions: dimensions, nextDimensions: dimensions,
  });
  assert.equal(model.timelineDaily.length, 6);
  assert.deepEqual([...new Set(model.timelineDaily.map((row) => row.contextPeriod))], ['previous', 'selected', 'next']);
  assert.equal(model.kpis.next?.flights, 1010);
  const packageFiles = buildTrafficWorkbookPackage(model);
  const reopened = XLSX.read(zipSync(packageFiles, { level: 6 }), { type: 'array', cellDates: true });
  assert.deepEqual(reopened.SheetNames, ['Tổng quan', 'Theo ngày', 'Theo tuần', 'Chi tiết Airline', 'Chi tiết Country', 'Chi tiết Route', 'AC Group', 'AC Type']);
  assert.equal(reopened.Sheets['Tổng quan']?.A1?.v, 'BÁO CÁO TUẦN CHI TIẾT');
  assert.match(trafficWorkbookFilename(model), /^chi-tiet-khai-thac-tuan-2026-09-08-2026-09-14-/u);
  const packageText = Object.entries(packageFiles).filter(([path]) => path.endsWith('.xml')).map(([, value]) => strFromU8(value)).join('\n');
  assert.doesNotMatch(packageText, /record_id|raw_history|deleted_row|<sheet[^>]+name="Data"/iu);
  assert.doesNotMatch(packageText, /canonical|data_as_of|watermark|request hash|template version|renderer version|audit metadata|Coverage Pax|PeriodId|Suppressed|Kiểm soát dữ liệu/iu);
});

test('period analysis renderer creates seven long-form multi-period sheets', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=PERIOD_ANALYSIS&template_version=period-analysis-v1&period_mode=custom&from=2026-09-01&to=2026-09-30&comparison_year=2025&comparison_year=2024'));
  const comparisonPeriods = workbookComparisonYearRanges(request);
  const model = buildWorkbookReportModel({
    request, requestHash: 'd'.repeat(64), requestId: 'request-4', generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: bundle('2026-09-01', '2026-09-30', 3898), currentDimensions: dimensions,
    comparisonSnapshots: comparisonPeriods.map((period, index) => ({ period, bundle: bundle(period.from, period.to, 3500 - index * 100), dimensions })),
  });
  assert.equal(model.periods.length, 3);
  const packageFiles = buildTrafficWorkbookPackage(model);
  const reopened = XLSX.read(zipSync(packageFiles, { level: 6 }), { type: 'array', cellDates: true });
  assert.deepEqual(reopened.SheetNames, ['Tổng quan', 'Theo thời gian', 'Chi tiết Airline', 'Chi tiết Country', 'Chi tiết Route', 'AC Group', 'AC Type']);
  assert.equal(reopened.Sheets['Tổng quan']?.A1?.v, 'PHÂN TÍCH THEO KỲ');
  const packageText = Object.entries(packageFiles).filter(([path]) => path.endsWith('.xml')).map(([, value]) => strFromU8(value)).join('\n');
  assert.doesNotMatch(packageText, /canonical|data_as_of|watermark|request hash|template version|renderer version|audit metadata|Coverage Pax|PeriodId|Suppressed|Kiểm soát dữ liệu/iu);
  assert.match(trafficWorkbookFilename(model), /^phan-tich-theo-ky-2026-09-01-2026-09-30-/u);
});

test('BaoCaoSanLuong renderer creates macro-free summer season sheets', () => {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=BAO_CAO_SAN_LUONG&template_version=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'e'.repeat(64), requestId: 'request-5', generatedAt: '2026-10-25T00:00:00.000Z',
    currentBundle: bundle('2026-03-29', '2026-10-24', 24_000), currentDimensions: dimensions,
    businessWeekDimensionSnapshots: [
      { id: 'business-week-1', label: '2026-04-24–2026-04-30', from: '2026-04-24', to: '2026-04-30', partial: false, dimensions },
      { id: 'business-week-2', label: '2026-05-01–2026-05-07', from: '2026-05-01', to: '2026-05-07', partial: false, dimensions },
    ],
  });
  const packageFiles = buildTrafficWorkbookPackage(model);
  const zipped = zipSync(packageFiles, { level: 6 });
  const reopened = XLSX.read(zipped, { type: 'array', cellDates: true });
  assert.deepEqual(reopened.SheetNames, ['TOTAL', 'WEEKLY', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'Analysis_Airline', 'Analysis_Country']);
  assert.equal(reopened.Sheets.Analysis_Airline?.A4?.v, '2026-04-24–2026-04-30');
  assert.ok(!Object.keys(unzipSync(zipped)).some((path) => /vbaProject|externalLink|connections|queryTable|DataMashup/iu.test(path)));
  const packageText = Object.values(unzipSync(zipped)).map((value) => strFromU8(value)).join('\n');
  assert.doesNotMatch(packageText, /C:\\Users\\|<sheet[^>]+name="Table1"/iu);
  assert.doesNotMatch(packageText, /canonical|data_as_of|watermark|request hash|template version|renderer version|audit metadata|Coverage Pax|PeriodId|Suppressed|Kiểm soát dữ liệu/iu);
  assert.match(trafficWorkbookFilename(model), /^bao-cao-san-luong-S26-/u);
});

test('versioned manifests match renderer sheet order and pinned source fingerprints', () => {
  const master = JSON.parse(readFileSync('report-templates/master-operations/v1/manifest.json', 'utf8')) as { sheets: string[]; forbidden_parts: string[] };
  const monthly = JSON.parse(readFileSync('report-templates/monthly-overview-l2/v1/manifest.json', 'utf8')) as { sheets: string[]; charts: string[] };
  const weekly = JSON.parse(readFileSync('report-templates/weekly-detail/v1/manifest.json', 'utf8')) as { sheets: string[]; required_features: string[] };
  const period = JSON.parse(readFileSync('report-templates/period-analysis/v1/manifest.json', 'utf8')) as { sheets: string[]; period_modes: string[] };
  const production = JSON.parse(readFileSync('report-templates/bao-cao-san-luong/v1/manifest.json', 'utf8')) as { summer_sheets: string[]; forbidden_parts: string[]; compiled_public_asset: { sha256: string } };
  const fingerprints = JSON.parse(readFileSync('report-templates/source-reference-fingerprints.json', 'utf8')) as { authority: string; files: Array<{ name: string; sha256: string }> };
  assert.equal(master.sheets.length, 12);
  assert.equal(monthly.sheets.length, 9);
  assert.equal(monthly.charts.length, 2);
  assert.equal(weekly.sheets.length, 8);
  assert.ok(weekly.required_features.includes('next-7-days'));
  assert.equal(period.sheets.length, 7);
  assert.equal(period.period_modes.length, 5);
  assert.equal(production.summer_sheets.length, 11);
  assert.ok(production.forbidden_parts.includes('vbaProject'));
  const publicTemplateBytes = readFileSync('report-templates/bao-cao-san-luong/v1/BaoCaoSanLuong-public-v1.xlsx');
  assert.equal(createHash('sha256').update(publicTemplateBytes).digest('hex').toUpperCase(), production.compiled_public_asset.sha256);
  const publicTemplate = unzipSync(publicTemplateBytes);
  const publicTemplateText = Object.entries(publicTemplate).filter(([path]) => path.endsWith('.xml') || path.endsWith('.rels')).map(([, value]) => strFromU8(value)).join('\n');
  assert.ok(!Object.keys(publicTemplate).some((path) => /vbaProject|externalLink|connections|queryTable|DataMashup/iu.test(path)));
  assert.doesNotMatch(publicTemplateText, /vbaProject|externalLink|connections|queryTable|DataMashup|C:\\Users\\|<sheet[^>]+name="Table1"/iu);
  assert.ok(master.forbidden_parts.includes('hidden-data-sheet'));
  assert.equal(fingerprints.authority, 'SanLuong_S26 - Copy.xlsm');
  assert.equal(fingerprints.files.length, 6);
  assert.ok(fingerprints.files.every((file) => /^[A-F0-9]{64}$/u.test(file.sha256)));
});
