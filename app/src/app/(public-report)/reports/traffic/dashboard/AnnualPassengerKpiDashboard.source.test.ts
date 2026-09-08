import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./AnnualPassengerKpiDashboard.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../../report.css', import.meta.url), 'utf8');

test('wallboard keeps the approved public wording and omits technical labels', () => {
  assert.match(source, /KPI sản lượng khách năm \{year\}/);
  assert.match(source, /Hôm nay cần phục vụ tối thiểu/);
  assert.match(source, /Đã vượt chỉ tiêu/);
  assert.match(source, /Cập nhật lúc/);
  assert.doesNotMatch(source, /AHT · Public traffic report/);
  assert.doesNotMatch(source, /Coverage Pax|Chất lượng dữ liệu|đến hết ngày hôm qua|đến hết hôm qua/i);
  assert.doesNotMatch(source, /Dữ liệu minh họa|Bản mẫu giao diện/);
});

test('wallboard preserves the approved Sites layout instead of the alternate KPI layout', () => {
  assert.match(source, /className="hero-grid"/);
  assert.match(source, /className="hero-panel relative overflow-hidden"/);
  assert.match(source, /className="status-panel"/);
  assert.match(source, /completion-ring/);
  assert.match(source, /Sản lượng khách so với tiến độ KPI/);
  assert.doesNotMatch(source, /Phạm vi A \+ D/);
  assert.match(source, /const requestedView = searchParams\.get\('view'\)/);
  assert.match(source, /const wallboard = requestedView !== 'standard'/);
  assert.match(source, /wallboard && 'kpi-wallboard'/);
  assert.match(source, /<TrendChart snapshot=\{snapshot\} wallboard=\{wallboard\}/);
});

test('wallboard gives all remaining viewport height to the trend chart without scrolling', () => {
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.dashboard-shell[\s\S]*?height: 100dvh;/);
  assert.match(styles, /grid-template-rows: auto auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.bottom-grid[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.chart-panel[\s\S]*?height: 100%;[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.kpi-trend-chart[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.dashboard-header[\s\S]*?min-height: 2\.25rem;[\s\S]*?padding-block: 0;/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.hero-panel[\s\S]*?min-height: clamp\(17rem, 29vh, 19rem\);/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.completion-ring[\s\S]*?width: clamp\(11\.5rem, 12vw, 13\.5rem\);/);
  assert.match(styles, /\.kpi-dashboard\.kpi-wallboard \.hero-progress-value[\s\S]*?font-size: clamp\(2\.1rem, 2\.1vw, 2\.75rem\);/);
});

test('compact screens reserve ring width instead of squeezing the status row', () => {
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.kpi-dashboard \.completion-ring[\s\S]*?width: clamp\(9rem, 26vw, 11rem\);/);
  assert.match(styles, /@media \(min-width: 1024px\) and \(max-width: 1279px\) and \(max-height: 719px\)[\s\S]*?\.kpi-dashboard \.hero-grid[\s\S]*?grid-template-columns: 1fr;/);
});

test('wallboard uses the high-contrast light operations theme', () => {
  assert.match(styles, /\.kpi-dashboard \{[\s\S]*?background: #f1f5f9;[\s\S]*?color: #0f172a;[\s\S]*?color-scheme: light;/);
  assert.match(styles, /\.kpi-dashboard \.hero-panel,[\s\S]*?background: #ffffff;/);
  assert.match(styles, /\.kpi-dashboard \.kpi-trend-chart \{[\s\S]*?background: #f8fafc;/);
  assert.match(source, /<CartesianGrid vertical=\{false\} stroke="#cbd5e1" strokeWidth=\{1\.2\}/);
  assert.match(source, /const yAxisMax = Math\.max\(2\.5, Math\.ceil\(maximum \* 2\) \/ 2 \+ 0\.5\)/);
  assert.match(source, /ticks=\{yAxisTicks\} interval=\{0\}/);
  assert.match(source, /dataKey="actual"[\s\S]*?stroke="#0369a1"[\s\S]*?strokeWidth=\{wallboard \? 6 : 3\.5\}/);
  assert.match(source, /dataKey="target"[\s\S]*?stroke="#334155"[\s\S]*?strokeDasharray="4 8"/);
  assert.match(source, /dataKey="projection"[\s\S]*?stroke="#c2410c"[\s\S]*?strokeDasharray="16 8"/);
  assert.match(source, /Ngày số liệu mới nhất: \$\{displayDayMonth\(snapshot\.period_to\)\}/);
  assert.match(source, /Đã đạt \$\{displayMillions\(actualEnd\)\}/);
  assert.match(source, /<XAxis dataKey="day" type="number" domain=\{\[1, daysInYear\]\}/);
  assert.match(source, /<XAxis xAxisId="days"[\s\S]*?ticks=\{dayTicks\} interval=\{0\}[\s\S]*?tick=\{<DayDot \/>\}/);
  assert.match(source, /Dự báo \$\{displayMillions\(projectionEnd\)\}/);
  assert.match(source, /KPI \$\{displayMillions\(targetEnd\)\}/);
  assert.doesNotMatch(source, /blur-3xl/);
});

test('wallboard uses the approved fixed scope and refresh strategy', () => {
  assert.match(source, /annualKpiSnapshotUrl/);
  assert.match(source, /annualKpiVersionUrl/);
  assert.match(source, /DASHBOARD_DAILY_PUBLICATION_ENABLED/);
  assert.match(source, /annualDashboardPublicationUrl/);
  assert.match(source, /annualDashboardPublicationVersionUrl/);
  assert.match(source, /decodeAnnualPassengerDashboardSnapshot/);
  assert.match(source, /ANNUAL_KPI_VERSION_POLL_MS/);
  assert.match(source, /If-None-Match/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /window\.addEventListener\('online'/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /if \(clear\) setSnapshot\(null\)/);
  assert.doesNotMatch(source, /trafficReportDataAdapter/);
  assert.doesNotMatch(source, /airline|route|country/);
});

test('forecast card explains its rolling window without changing the card label', () => {
  assert.match(source, /label="Dự báo cuối năm"/);
  assert.match(source, /forecast_method === 'rolling_completed_ops_dates_30'/);
  assert.match(source, /forecast_average_reported_pax_per_day/);
  assert.match(source, /Theo TB \$\{displayNumber\(snapshot\.forecast_window_days\)\} ngày gần nhất:/);
  assert.match(source, /Dự báo luỹ kế năm/);
  assert.doesNotMatch(source, /YTD/);
});

test('daily publication exposes its Business Date and preserves last-known-good during background failures', () => {
  assert.match(source, /Ngày số liệu/);
  assert.match(source, /snapshot\.publication\.business_date/);
  assert.match(source, /loadSnapshot\(year\)/);
  assert.doesNotMatch(source, /catch[\s\S]{0,240}setSnapshot\(null\)/);
});

test('year selector lives inside the hidden editor and can pin or release a year', () => {
  assert.match(source, /searchParams\.get\('year'\)/);
  assert.match(source, /nextParams\.set\('year', value\)/);
  assert.match(source, /nextParams\.delete\('year'\)/);
  assert.match(source, /Năm dashboard đang xem/);
  assert.match(source, /Tự động \(\{automaticYear\}\)/);
  const header = source.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.doesNotMatch(header, /<select/);
});

test('hidden editor uses server-side PIN session endpoints', () => {
  assert.match(source, /kpi-admin\/unlock/);
  assert.match(source, /kpi-admin\/lock/);
  assert.match(source, /credentials: 'include'/);
  assert.match(source, /Mở trình chỉnh sửa KPI/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /setTarget\(String\(savedConfig\.target_reported_pax\)\)/);
  assert.match(source, /await onSaved\(payload\.snapshot\)/);
});
