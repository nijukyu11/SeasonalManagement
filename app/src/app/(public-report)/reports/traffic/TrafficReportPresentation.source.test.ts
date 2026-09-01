import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const trendPath = 'src/app/(public-report)/reports/traffic/TrafficReportTrend.tsx';
const dimensionPath = 'src/app/(public-report)/reports/traffic/TrafficReportDimensionSection.tsx';
const clientPath = 'src/app/(public-report)/reports/traffic/TrafficReportClient.tsx';
const advancedChartsPath = 'src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx';
const trendSource = readFileSync(join(process.cwd(), trendPath), 'utf8');
const dimensionSource = readFileSync(join(process.cwd(), dimensionPath), 'utf8');
const clientSource = readFileSync(join(process.cwd(), clientPath), 'utf8');
const advancedChartsSource = readFileSync(join(process.cwd(), advancedChartsPath), 'utf8');

test('Report live cutover is flag-gated and pins every secondary read to one Report Read Version', () => {
  assert.match(clientSource, /NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED === '1'/);
  assert.match(clientSource, /fetchTrafficReportV2Bundle/);
  assert.match(clientSource, /toTrafficReportPresentationBundle/);
  assert.match(clientSource, /bundle\.contract_version === 'traffic-report-v2'/);
  assert.match(clientSource, /buildTrafficReportV2ExportUrl/);
  assert.match(trendSource, /fetchTrafficReportV2TimelinePage\(filter, scope, after, expectedWatermark, readVersionToken/);
  assert.match(dimensionSource, /fetchTrafficReportV2DimensionPage\(filter, dimension, scope/);
  assert.match(dimensionSource, /buildTrafficReportV2DimensionUrl\(filter, dimension, scope, sort, 1, 732, expectedWatermark, readVersionToken, true\)/);
  assert.match(clientSource, /readVersionToken={readVersionToken}/);
  assert.match(clientSource, /onVersionChanged=\{reloadVersionedBundle\}/);
});

test('public trend and dimension views omit technical Pax coverage fields', () => {
  for (const [path, source] of [[trendPath, trendSource], [dimensionPath, dimensionSource]] as const) {
    assert.doesNotMatch(source, /Tỷ lệ chuyến có số khách|Chuyến có khách|chuyến đến hạn|Trạng thái dữ liệu|pax_coverage_pct|reported_legs|due_legs/, path);
  }
});

test('trend tooltip has separate pointer and keyboard lifecycle controls', () => {
  assert.match(trendSource, /const \[pointerIndex, setPointerIndex\] = useState/);
  assert.match(trendSource, /const \[keyboardIndex, setKeyboardIndex\] = useState/);
  assert.match(trendSource, /onPointerLeave=/);
  assert.match(trendSource, /onPointerCancel=/);
  assert.match(trendSource, /onBlur=\{closeInteractions\}/);
  assert.match(trendSource, /event\.key === 'Escape'/);
  assert.match(trendSource, /document\.addEventListener\('pointerdown', closeOnOutsidePointer, true\)/);
});

test('trend preserves missing Pax as a gap and omits a fake all-null maximum', () => {
  assert.match(trendSource, /row\.reported_pax == null \? \[\] : \[row\.reported_pax\]/);
  assert.match(trendSource, /const maxPax = paxValues\.length > 0 \? Math\.max\(\.\.\.paxValues\) : null/);
  assert.match(trendSource, /const paxSeries = buildSeries\('reported_pax', paxY, \(\) => true\)/);
  assert.match(trendSource, /chart\.maxPax == null \? null/);
  assert.match(trendSource, /chart\.paxSeries\.segments\.map/);
});

test('trend renders singleton and zero Pax points with readable axes and dates', () => {
  assert.match(trendSource, /current\.length === 1\) singletons\.push/);
  assert.match(trendSource, /chart\.paxSeries\.singletons\.map/);
  assert.match(trendSource, /activeRow\.reported_pax != null \? <circle/);
  assert.doesNotMatch(trendSource, /activeRow\.reported_pax != null && activeRow\.completeness/);
  assert.match(trendSource, />Chuyến bay<\/text>/);
  assert.match(trendSource, /Sản lượng khách/);
  assert.match(trendSource, /chart\.xTickIndexes\.map/);
  assert.match(trendSource, /formatDate\(rows\[index\]\.ops_date\)/);
});

test('trend uses flight columns and a solid passenger line', () => {
  assert.match(trendSource, /<rect[\s\S]*?key=\{`flights-/);
  assert.match(trendSource, /chart\.barWidth/);
  assert.match(trendSource, /chart\.paxSeries\.segments\.map/);
  assert.doesNotMatch(trendSource, /strokeDasharray="8 6"/);
  assert.doesNotMatch(trendSource, /chart\.flightSeries\.segments/);
});

test('dimension table keeps only the four business measures', () => {
  assert.match(dimensionSource, />Chuyến bay</);
  assert.match(dimensionSource, />Tỷ trọng chuyến bay</);
  assert.match(dimensionSource, />Sản lượng khách</);
  assert.match(dimensionSource, />Tỷ trọng sản lượng khách</);
  assert.doesNotMatch(dimensionSource, />Trạng thái</);
});

test('overview uses three ordered flight and passenger cards without deriving scoped Pax', () => {
  const totalIndex = clientSource.indexOf('label="Tổng"');
  const arrivalIndex = clientSource.indexOf('label="Chuyến bay đến"');
  const departureIndex = clientSource.indexOf('label="Chuyến bay đi"');
  assert.ok(totalIndex >= 0 && totalIndex < arrivalIndex && arrivalIndex < departureIndex);
  assert.match(clientSource, /label="Tổng"[\s\S]*?flights=\{current\?\.flights \?\? null\}[\s\S]*?pax=\{current\?\.reported_pax \?\? null\}/);
  assert.match(clientSource, /label="Chuyến bay đến"[\s\S]*?flights=\{current\?\.arrivals \?\? null\}[\s\S]*?pax=\{current\?\.arrival_reported_pax \?\? null\}/);
  assert.match(clientSource, /label="Chuyến bay đi"[\s\S]*?flights=\{current\?\.departures \?\? null\}[\s\S]*?pax=\{current\?\.departure_reported_pax \?\? null\}/);
  assert.match(clientSource, /lg:grid-cols-3/);
  assert.doesNotMatch(clientSource, /(?:arrival_reported_pax|departure_reported_pax|reported_pax)\s*\/\s*2/);
});

test('public report consistently uses the business label for passenger volume', () => {
  for (const [path, source] of [[clientPath, clientSource], [trendPath, trendSource], [dimensionPath, dimensionSource]] as const) {
    assert.match(source, /Sản lượng khách/, path);
    assert.doesNotMatch(source, /Hành khách đã báo cáo/, path);
  }
});

test('dimension ranking uses its own fixed first-page flights request', () => {
  assert.match(dimensionSource, /const \[chartData, setChartData\] = useState/);
  assert.match(dimensionSource, /const loadChart = useCallback/);
  assert.match(dimensionSource, /buildDimensionUrl\(filter, dimension, scope, 'flights', 1, 50\)/);
  assert.match(dimensionSource, /const chartRows = chartData\?\.rows/);
  assert.doesNotMatch(dimensionSource, /const chartRows = visibleRows/);
});

test('dimension ranking uses one shared legend above compact flight and passenger share rows', () => {
  assert.match(dimensionSource, /aria-label="Chú thích tỷ trọng"/);
  assert.match(dimensionSource, />Tỷ trọng chuyến bay<\/span>/);
  assert.match(dimensionSource, />Tỷ trọng sản lượng khách<\/span>/);
  assert.match(dimensionSource, /<ShareMetric value=\{row\.flight_share\} tone="flights"/);
  assert.match(dimensionSource, /<ShareMetric value=\{row\.pax_share\} tone="pax"/);
  assert.match(dimensionSource, /aria-label=\{`\$\{row\.label\}: tỷ trọng chuyến bay/);
  assert.doesNotMatch(dimensionSource, /<ShareMetric label=/);
  assert.match(dimensionSource, /aria-hidden="true"/);
  assert.doesNotMatch(dimensionSource, /formatShare\(row\.flight_share\)\} · \{formatShare\(row\.pax_share\)/);
});

test('dimension views do not hide aggregate rows in the client', () => {
  assert.match(dimensionSource, /const visibleRows = data\?\.rows \?\? \[\]/);
  assert.match(dimensionSource, /const chartRows = chartData\?\.rows\.slice\(0, 10\) \?\? \[\]/);
  assert.doesNotMatch(dimensionSource, /filter\(\(row\) => !row\.suppressed\)/);
});

test('dimension does not draw a missing share as zero and exposes its mobile table scroll region', () => {
  assert.match(dimensionSource, /value == null \? <span/);
  assert.match(dimensionSource, /Chưa có số liệu/);
  assert.match(dimensionSource, /Vuốt ngang để xem đầy đủ các cột/);
  assert.match(dimensionSource, /role="region"/);
  assert.match(dimensionSource, /tabIndex=\{0\}/);
  assert.match(dimensionSource, /aria-label=\{`Bảng dữ liệu/);
});

test('executive peak-hour insight uses daily averages instead of period totals', () => {
  assert.match(clientSource, /getAverageFlightsPerSelectedDay\(arrivalPeak\?\.arrivals \?\? null, bundle\.metadata\.day_count\)/);
  assert.match(clientSource, /numberFormat\.format\(Math\.round\(averagePeakArrivals\)\)/);
  assert.match(clientSource, /selectedDayCount=\{bundle\.metadata\.day_count\}/);
  assert.doesNotMatch(clientSource, /formatNumber\(arrivalPeak\.arrivals\)/);
});

test('peak-hour chart exposes all hours, local direction controls and recurring schedules', () => {
  assert.match(advancedChartsSource, />\{row\.hour_bucket\}<\/span>/);
  assert.doesNotMatch(advancedChartsSource, /index % 3/);
  assert.match(advancedChartsSource, /\['all', 'A', 'D'\]/);
  assert.match(advancedChartsSource, /Các chuyến bay thường lệ trong khung giờ/);
  assert.match(advancedChartsSource, /regular_flights\?\.arrivals/);
  assert.match(advancedChartsSource, /regular_flights\?\.departures/);
  assert.match(advancedChartsSource, /Math\.round\(value\)/);
  assert.doesNotMatch(advancedChartsSource, /maximumFractionDigits: 1[^\n]+average/);
});

test('interactive report controls use a high-contrast focus ring and long labels retain their full text', () => {
  assert.match(trendSource, /focus-visible:ring-2 focus-visible:ring-blue-900/);
  assert.match(dimensionSource, /focus-visible:ring-2 focus-visible:ring-blue-900/);
  assert.match(dimensionSource, /title=\{row\.label\}/);
  assert.match(trendSource, /title="Xu hướng chuyến bay và sản lượng khách"/);
});
