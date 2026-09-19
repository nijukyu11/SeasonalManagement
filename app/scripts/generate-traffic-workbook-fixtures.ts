import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import { buildWorkbookReportModel, normalizeWorkbookRequest, workbookComparisonYearRanges } from '../supabase/functions/_shared/trafficWorkbookCore.ts';
import { buildTrafficWorkbookPackage } from '../supabase/functions/_shared/trafficWorkbookRenderer.ts';

const outputDirectory = resolve(process.argv[2] ?? 'outputs/2026-09-03-workbook-master-monthly-l2');
function makeDays(from: string, to: string) {
  const count = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return Array.from({ length: count }, (_, index) => {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + index);
  const opsDate = date.toISOString().slice(0, 10);
  const flights = 118 + (index % 7) * 4;
  const missingPax = opsDate === '2026-09-30';
  return { ops_date: opsDate, flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: missingPax ? null : flights * 132, completeness: missingPax ? 'partial' : 'complete', reported_legs: missingPax ? 0 : flights, due_legs: flights, pax_coverage_pct: missingPax ? 0 : 100, pax_status: missingPax ? 'unavailable' : 'available' };
  });
}

function makeDimensions(multiplier = 1) {
  const base = [
    ['vn', 'Vietnam Airlines', 1400], ['vj', 'VietJet Air', 1200], ['qh', 'Bamboo Airways', 650],
    ['sq', 'Singapore Airlines', 300], ['ak', 'AirAsia', 300], ['unknown', 'Unknown', 48],
  ] as const;
  const rows = base.map(([key, label, original]) => {
    const flights = Math.round(original * multiplier);
    return { key, label, flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: flights * 128, flight_share: flights / Math.round(3898 * multiplier), pax_share: flights / Math.round(3898 * multiplier), reported_legs: flights, due_legs: flights, pax_coverage_pct: 100, pax_status: 'available', suppressed: false };
  });
  return { airline: rows, country: rows.map((row, index) => ({ ...row, key: `country-${index}`, label: ['Việt Nam', 'Thái Lan', 'Hàn Quốc', 'Singapore', 'Malaysia', 'Unknown'][index] })), route: rows.map((row, index) => ({ ...row, key: `route-${index}`, label: ['DAD-SGN', 'DAD-HAN', 'DAD-BKK', 'DAD-SIN', 'DAD-KUL', 'Unknown'][index] })) };
}

function makeBundle(from: string, to: string, multiplier = 1) {
  const flights = Math.round(3898 * multiplier);
  return {
    contract_version: 'traffic-report-v1', request_hash: 'fixture', data_as_of: '2026-10-02T00:00:00.000Z', source_watermark: 50104,
    metadata: { min_ops_date: '2025-01-01', max_ops_date: '2027-03-27', latest_completed_ops_date: '2026-09-30', normalized_filter: { from, to, type: 'all', airline: [], route: [], country: [], comp: 'none', tz: 'local' }, day_count: makeDays(from, to).length, timeline_has_more: false, timeline_next_cursor: null, projection: { status: 'fresh' } },
    kpis: { current: { flights, arrivals: Math.ceil(flights / 2), departures: Math.floor(flights / 2), reported_pax: flights * 132, arrival_reported_pax: Math.ceil(flights / 2) * 132, departure_reported_pax: Math.floor(flights / 2) * 132, status: 'complete' }, peak_day: { ops_date: from, flights: 142, status: 'complete' }, pax_coverage: { reported_legs: flights, due_legs: flights, percent: 100, status: 'available' } },
    timeline: makeDays(from, to),
    breakdowns: {
      peak_hour: Array.from({ length: 24 }, (_, hour) => ({ hour_bucket: `${String(hour).padStart(2, '0')}:00`, arrivals: 20 + ((hour * 7) % 37), departures: 18 + ((hour * 5) % 41), suppressed: false, regular_flights: { arrivals: [], departures: [] } })),
      peak_hour_monthly: [{ month: '2026-09', time_basis: 'local', arrival_hour: '07:00', arrival_flights: 57, departure_hour: '08:00', departure_flights: 59, arrival_suppressed: false, departure_suppressed: false }],
      day_of_week: [], aircraft_group: [{ label: 'Narrowbody', flights: 3200, arrivals: 1600, departures: 1600, reported_pax: 420000, share: 0.82 }], aircraft_type: [{ aircraft_group: 'Narrowbody', label: 'A320', flights: 1800, arrivals: 900, departures: 900, reported_pax: 230000, share: 0.56 }],
    },
    quality: { unknown_country_legs: 28, pax_due_missing_legs: 0, quarantined_duplicate_candidates: 3, notes: ['Fixture kiểm tra trực quan; không phải số liệu production.'] },
  };
}

async function writeWorkbook(reportType: 'MASTER_OPERATIONS' | 'MONTHLY_OVERVIEW_L2' | 'WEEKLY_DETAIL', filename: string) {
  const query = reportType === 'MASTER_OPERATIONS'
    ? 'report_type=MASTER_OPERATIONS&template_version=master-v1&period_mode=custom&from=2026-09-01&to=2026-09-30&comparison=previous&comparison=year_ago'
    : reportType === 'MONTHLY_OVERVIEW_L2'
      ? 'report_type=MONTHLY_OVERVIEW_L2&template_version=monthly-l2-v1&period_mode=month&from=2026-09-01&to=2026-09-30&month=2026-09&comparison=previous&comparison=year_ago'
      : 'report_type=WEEKLY_DETAIL&template_version=weekly-detail-v1&period_mode=custom&from=2026-09-08&to=2026-09-14';
  const currentRange = reportType === 'WEEKLY_DETAIL' ? ['2026-09-08', '2026-09-14'] : ['2026-09-01', '2026-09-30'];
  const previousRange = reportType === 'WEEKLY_DETAIL' ? ['2026-09-01', '2026-09-07'] : ['2026-08-01', '2026-08-31'];
  const model = buildWorkbookReportModel({
    request: normalizeWorkbookRequest(new URL(`https://report.test/api/report/v1/workbook-export?${query}`)),
    requestHash: 'fixture-request-hash', requestId: `fixture-${reportType}`, generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: makeBundle(currentRange[0], currentRange[1]), previousBundle: makeBundle(previousRange[0], previousRange[1], 0.94), yearAgoBundle: reportType === 'WEEKLY_DETAIL' ? undefined : makeBundle('2025-09-01', '2025-09-30', 0.89), nextBundle: reportType === 'WEEKLY_DETAIL' ? makeBundle('2026-09-15', '2026-09-21', 1.03) : undefined,
    currentDimensions: makeDimensions(), previousDimensions: makeDimensions(0.94), yearAgoDimensions: reportType === 'WEEKLY_DETAIL' ? undefined : makeDimensions(0.89), nextDimensions: reportType === 'WEEKLY_DETAIL' ? makeDimensions(1.03) : undefined,
  });
  await writeFile(resolve(outputDirectory, filename), zipSync(buildTrafficWorkbookPackage(model), { level: 6 }));
}

async function writePeriodWorkbook() {
  const request = normalizeWorkbookRequest(new URL('https://report.test/api/report/v1/workbook-export?report_type=PERIOD_ANALYSIS&template_version=period-analysis-v1&period_mode=custom&from=2026-09-01&to=2026-09-30&comparison_year=2025&comparison_year=2024'));
  const model = buildWorkbookReportModel({
    request, requestHash: 'fixture-request-hash', requestId: 'fixture-PERIOD_ANALYSIS', generatedAt: '2026-10-02T00:00:00.000Z',
    currentBundle: makeBundle('2026-09-01', '2026-09-30'), currentDimensions: makeDimensions(),
    comparisonSnapshots: workbookComparisonYearRanges(request).map((period, index) => ({
      period, bundle: makeBundle(period.from, period.to, 0.9 - index * 0.05), dimensions: makeDimensions(0.9 - index * 0.05),
    })),
  });
  await writeFile(resolve(outputDirectory, 'period-analysis-golden.xlsx'), zipSync(buildTrafficWorkbookPackage(model), { level: 6 }));
}

await mkdir(outputDirectory, { recursive: true });
const fixture = process.argv[3] ?? 'all';
const jobs = fixture === 'weekly'
  ? [writeWorkbook('WEEKLY_DETAIL', 'weekly-detail-golden.xlsx')]
  : [
      writeWorkbook('MASTER_OPERATIONS', 'workbook-master-operations-golden.xlsx'),
      writeWorkbook('MONTHLY_OVERVIEW_L2', 'monthly-overview-l2-golden.xlsx'),
      writeWorkbook('WEEKLY_DETAIL', 'weekly-detail-golden.xlsx'),
      writePeriodWorkbook(),
    ];
await Promise.all(jobs);
console.log(JSON.stringify({ outputDirectory }));
