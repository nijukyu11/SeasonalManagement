import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./AnnualPassengerKpiDashboard.tsx', import.meta.url), 'utf8');

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
  assert.match(source, /Phạm vi A \+ D/);
});

test('wallboard uses the approved fixed scope and refresh strategy', () => {
  assert.match(source, /annualKpiSnapshotUrl/);
  assert.match(source, /annualKpiVersionUrl/);
  assert.match(source, /ANNUAL_KPI_VERSION_POLL_MS/);
  assert.match(source, /If-None-Match/);
  assert.doesNotMatch(source, /airline|route|country/);
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
