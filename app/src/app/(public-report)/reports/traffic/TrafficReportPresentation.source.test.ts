import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const trendPath = 'src/app/(public-report)/reports/traffic/TrafficReportTrend.tsx';
const dimensionPath = 'src/app/(public-report)/reports/traffic/TrafficReportDimensionSection.tsx';
const clientPath = 'src/app/(public-report)/reports/traffic/TrafficReportClient.tsx';
const advancedChartsPath = 'src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx';
const workbookDialogPath = 'src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx';
const peakHourHeatmapPath = 'src/app/(public-report)/reports/traffic/TrafficPeakHourHeatmap.tsx';
const weekdayHeatmapPath = 'src/app/(public-report)/reports/traffic/TrafficMonthlyDayOfWeekHeatmap.tsx';
const trendTablePath = 'src/app/(public-report)/reports/traffic/TrafficTrendTable.tsx';
const donutPath = 'src/app/(public-report)/reports/traffic/TrafficDimensionShareDonut.tsx';
const trendGranularityPath = 'src/lib/trafficReportTrendGranularity.ts';
const trendSource = readFileSync(join(process.cwd(), trendPath), 'utf8');
const dimensionSource = readFileSync(join(process.cwd(), dimensionPath), 'utf8');
const clientSource = readFileSync(join(process.cwd(), clientPath), 'utf8');
const advancedChartsSource = readFileSync(join(process.cwd(), advancedChartsPath), 'utf8');
const workbookDialogSource = readFileSync(join(process.cwd(), workbookDialogPath), 'utf8');
const peakHourHeatmapSource = readFileSync(join(process.cwd(), peakHourHeatmapPath), 'utf8');
const weekdayHeatmapSource = readFileSync(join(process.cwd(), weekdayHeatmapPath), 'utf8');
const trendTableSource = readFileSync(join(process.cwd(), trendTablePath), 'utf8');
const donutSource = readFileSync(join(process.cwd(), donutPath), 'utf8');
const trendGranularitySource = readFileSync(join(process.cwd(), trendGranularityPath), 'utf8');

test('Report live cutover is flag-gated and pins every secondary read to one Report Read Version', () => {
  assert.match(clientSource, /NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED === '1'/);
  assert.match(clientSource, /fetchTrafficReportV2Bundle/);
  assert.match(clientSource, /toTrafficReportPresentationBundle/);
  assert.match(trendSource, /fetchTrafficReportV2TimelinePage\(filter, scope, after, expectedWatermark, readVersionToken/);
  assert.match(dimensionSource, /fetchTrafficReportV2DimensionPage\(filter, dimension, scope/);
  assert.match(dimensionSource, /buildTrafficReportV2DimensionUrl\(filter, dimension, scope, sort, 1, 732, expectedWatermark, readVersionToken, true\)/);
  assert.match(clientSource, /readVersionToken={readVersionToken}/);
  assert.match(clientSource, /onVersionChanged=\{reloadVersionedBundle\}/);
});

test('public trend and dimension views omit technical Pax coverage fields', () => {
  for (const [path, source] of [[trendPath, trendSource], [dimensionPath, dimensionSource]] as const) {
    assert.doesNotMatch(source, /Tỷ lệ chuyến có số khách|Chuyến có khách|chuyến đến hạn|Trạng thái dữ liệu/, path);
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
  assert.match(trendSource, /label: formatDate\(row\.ops_date\)/);
});

test('trend uses flight columns and a solid passenger line', () => {
  assert.match(trendSource, /<rect[\s\S]*?key=\{`flights-/);
  assert.match(trendSource, /chart\.barWidth/);
  assert.match(trendSource, /chart\.paxSeries\.segments\.map/);
  assert.doesNotMatch(trendSource, /strokeDasharray="8 6"/);
  assert.doesNotMatch(trendSource, /chart\.flightSeries\.segments/);
});

test('trend renders comparison reference line with amber dash and scales to monthly mode', () => {
  assert.match(trendSource, /refFlight/);
  assert.match(trendSource, /strokeDasharray="4 4"/);
  assert.match(trendSource, /paintOrder="stroke"/);
  assert.match(trendSource, /countCalendarMonths\(comparison\.from, comparison\.to\)/);
  assert.match(clientSource, /comparison=\{comparison\}/);
});

test('trend switches after three calendar months and exposes monthly drill-down', () => {
  assert.match(trendSource, /shouldUseMonthlyTrend\(filter\.from, filter\.to\)/);
  assert.match(trendGranularitySource, /return countCalendarMonths\(from, to\) > 3/);
  assert.match(trendSource, /fetchTrafficReportV2MonthlyTimeline/);
  assert.match(trendSource, /<TrafficTrendTable monthlyRows=\{monthlyRows\}/);
  assert.match(trendTableSource, /<details/);
  assert.match(trendTableSource, /fetchTrafficReportV2MonthDetail/);
  assert.match(trendTableSource, /Chi tiết ngày của/);
});

test('monthly labels use calendar coverage instead of partial Pax days', () => {
  assert.match(trendTableSource, /row\.period_status/);
  assert.match(trendTableSource, /periodStatus\(row\) === 'partial'/);
  assert.doesNotMatch(trendTableSource, /row\.partial_day_count > 0/);
  assert.match(trendSource, /period_status: periodStatus\(month, monthRows\)/);
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

test('route, country, and airline use independent flight and passenger donut rankings', () => {
  assert.match(dimensionSource, /fetchTrafficReportV2DimensionShare\(filter, dimension, scope, metric/);
  assert.match(dimensionSource, /Promise\.allSettled\(\[loadMetric\('flights'\), loadMetric\('reported_pax'\)\]\)/);
  assert.match(dimensionSource, /'Top 10 chặng bay'/);
  assert.match(dimensionSource, /'Top 10 Quốc gia'/);
  assert.match(dimensionSource, /'Top 10 hãng hàng không'/);
  assert.doesNotMatch(dimensionSource, /Top 10 hãng hàng không theo số chuyến/);
  assert.match(dimensionSource, /title="Tỷ trọng số chuyến"/);
  assert.match(dimensionSource, /title="Tỷ trọng sản lượng khách"/);
  assert.match(donutSource, /data\.other/);
  assert.match(donutSource, /Khác/);
});

test('all dimension tables are limited to 20 rows per page while full export remains available', () => {
  assert.match(dimensionSource, /scope, sort, page, 20, expectedWatermark/);
  assert.match(dimensionSource, /scope, sort, page, 20\)/);
  assert.doesNotMatch(dimensionSource, /page, 50/);
  assert.match(dimensionSource, /buildTrafficReportV2DimensionUrl\(filter, dimension, scope, sort, 1, 732/);
  assert.match(dimensionSource, /buildDimensionUrl\(filter, dimension, scope, sort, 1, 732, true\)/);
});

test('dimension views do not hide aggregate rows in the client', () => {
  assert.match(dimensionSource, /const visibleRows = data\?\.rows \?\? \[\]/);
  assert.doesNotMatch(dimensionSource, /const chartRows =/);
  assert.doesNotMatch(dimensionSource, /filter\(\(row\) => !row\.suppressed\)/);
});

test('dimension does not draw a missing share as zero and exposes its mobile table scroll region', () => {
  assert.match(donutSource, /data\.total_value == null/);
  assert.match(donutSource, /Chưa có dữ liệu để thể hiện tỷ trọng/);
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

test('peak-hour breakdown is a lazy monthly 24-hour matrix with rounded averages and peak-day labels', () => {
  assert.match(advancedChartsSource, /<TrafficPeakHourHeatmap filter=\{filter\} scope=\{scope\} timeBasis=\{timeBasis\}/);
  assert.match(peakHourHeatmapSource, /buildPeakHourHeatmapUrl\(filter, scope, range\.from, range\.to\)/);
  assert.match(peakHourHeatmapSource, /onToggle=/);
  assert.match(peakHourHeatmapSource, /monthly_average/);
  assert.match(peakHourHeatmapSource, />TB tháng</);
  assert.match(peakHourHeatmapSource, />Cao nhất</);
  assert.match(peakHourHeatmapSource, /role="region"/);
  assert.match(peakHourHeatmapSource, /tabIndex=\{0\}/);
  assert.match(peakHourHeatmapSource, /bucket\.flights == null \? '—'/);
});

test('weekday chart and monthly heatmap share the all, arrival and departure scope', () => {
  assert.match(advancedChartsSource, /DayOfWeekChart\(\{ rows, monthlyRows \}/);
  assert.match(advancedChartsSource, /const \[scope, setScope\] = useState<TrafficType>\('all'\)/);
  assert.match(advancedChartsSource, /<TrafficMonthlyDayOfWeekHeatmap rows=\{monthlyRows\} scope=\{scope\}/);
  assert.match(weekdayHeatmapSource, /average_arrivals/);
  assert.match(weekdayHeatmapSource, /average_departures/);
  assert.match(weekdayHeatmapSource, /is_peak_all/);
  assert.match(weekdayHeatmapSource, />Cao nhất</);
  assert.match(weekdayHeatmapSource, /role="region"/);
});

test('weekly operations uses a complete seven-day view and occupies a full report row', () => {
  assert.match(advancedChartsSource, /Array\.from\(\{ length: 7 \}/);
  assert.match(advancedChartsSource, /average_arrivals/);
  assert.match(advancedChartsSource, /average_departures/);
  assert.match(clientSource, /<div className="mt-5">\s*<DayOfWeekChart/);
  assert.doesNotMatch(clientSource, />Nguồn (?:live|snapshot)|>Watermark/iu);
});

test('interactive report controls use a high-contrast focus ring and long labels retain their full text', () => {
  assert.match(trendSource, /focus-visible:ring-2 focus-visible:ring-blue-900/);
  assert.match(dimensionSource, /focus-visible:ring-2 focus-visible:ring-blue-900/);
  assert.match(trendSource, /title="Xu hướng chuyến bay và sản lượng khách"/);
});

test('workbook export is feature flagged, server-rendered and drops the legacy Excel/CSV buttons', () => {
  assert.match(clientSource, /NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED/);
  assert.match(clientSource, /<TrafficWorkbookExportDialog/);
  assert.doesNotMatch(clientSource, /Tải Excel 6 sheet \(cũ\)|Tải CSV tổng hợp/);
  assert.match(workbookDialogSource, /buildTrafficWorkbookExportUrl/);
  assert.match(workbookDialogSource, /cache: 'no-store'/);
  assert.match(workbookDialogSource, /response\.blob\(\)/);
  assert.doesNotMatch(workbookDialogSource, /buildTrafficWorkbookData|XLSX|sheet_to_json/);
});

test('workbook dialog exposes all report families and accessible period/comparison states', () => {
  assert.match(workbookDialogSource, /Workbook tổng hợp khai thác/);
  assert.match(workbookDialogSource, /Tổng quan khai thác tháng - Mức 2/);
  assert.match(workbookDialogSource, /Báo cáo tuần chi tiết/);
  assert.match(workbookDialogSource, /Phân tích theo kỳ/);
  assert.match(workbookDialogSource, /Báo cáo sản lượng theo mẫu/);
  assert.match(workbookDialogSource, /So sánh với cùng kỳ trong quá khứ/);
  assert.match(workbookDialogSource, /Chọn tất cả/);
  assert.match(workbookDialogSource, /Đủ dữ liệu/);
  assert.match(workbookDialogSource, /workbook-period-options/);
  assert.match(workbookDialogSource, /7 ngày liền trước và 7 ngày liền sau/);
  assert.match(workbookDialogSource, /getTrafficWeeklyContextRange/);
  assert.match(workbookDialogSource, /Cả mùa/);
  assert.match(workbookDialogSource, /Khoảng ngày tùy chỉnh/);
  assert.match(workbookDialogSource, /type="month"/);
  assert.match(workbookDialogSource, /12 sheet tổng hợp/);
  assert.match(workbookDialogSource, /9 sheet phục vụ/);
  assert.match(workbookDialogSource, /8 sheet; tự động/);
  assert.match(workbookDialogSource, /7 sheet; chọn tháng/);
  assert.match(workbookDialogSource, /11 sheet theo bố cục BaoCaoSanLuong/);
  assert.match(workbookDialogSource, /Đang chuẩn bị báo cáo/);
  assert.match(workbookDialogSource, /Đang tổng hợp dữ liệu/);
  assert.doesNotMatch(workbookDialogSource, /kiểm soát dữ liệu|phiên bản nguồn cố định|không chứa macro|dữ liệu thô/iu);
  assert.match(workbookDialogSource, /role="alert"/);
  assert.match(workbookDialogSource, /aria-labelledby="traffic-workbook-export-title"/);
  assert.match(workbookDialogSource, /safe-area-inset-bottom/);
});

test('public web formatters use Number.isFinite and render dash for non-finite values', () => {
  assert.match(clientSource, /Number\.isFinite\(value\) \? numberFormat\.format\(value as number\) : '—'/);
  assert.match(dimensionSource, /Number\.isFinite\(value\) \? numberFormat\.format\(value as number\) : '—'/);
  assert.match(dimensionSource, /Number\.isFinite\(value\) \? `\$\{percentFormat\.format\(\(value as number\) \* 100\)\}%` : '—'/);
  assert.match(trendSource, /Number\.isFinite\(value\) \? numberFormat\.format\(value as number\) : '—'/);
  assert.match(advancedChartsSource, /Number\.isFinite\(value\) \? numberFormat\.format\(value\) : '—'/);
});

test('traffic report client handles comparison edge cases with neutral zero and new badge', () => {
  assert.match(clientSource, /previous === 0\) \{\s*if \(current > 0\) return 'new';\s*if \(current === 0\) return 0;/);
  assert.match(clientSource, /value === 'new'/);
  assert.match(clientSource, /label \? `Mới · \$\{label\}` : 'Mới'/);
  assert.match(clientSource, /isZero\s*\?\s*'bg-slate-100 text-slate-700'/);
  assert.match(clientSource, /window\.addEventListener\('beforeprint', handleBeforePrint\)/);
  assert.match(clientSource, /window\.addEventListener\('afterprint', handleAfterPrint\)/);
});

test('dimension section uses sticky thead with filter bar offset and fixed numeric widths', () => {
  assert.match(dimensionSource, /sticky top-\[var\(--report-filter-bar-height,72px\)\]/);
  assert.match(dimensionSource, /w-28 bg-white p-2 text-right tabular-nums/);
  assert.match(dimensionSource, /w-36 bg-white p-2 text-right tabular-nums/);
  assert.match(dimensionSource, /w-32 bg-white p-2 text-right tabular-nums/);
  assert.match(dimensionSource, /w-40 bg-white p-2 text-right tabular-nums/);
  assert.match(dimensionSource, /lg:overflow-visible/);
});
