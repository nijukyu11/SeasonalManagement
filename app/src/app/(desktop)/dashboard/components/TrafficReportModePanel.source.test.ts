import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./TrafficReportModePanel.tsx', import.meta.url), 'utf8');

test('Dashboard Report Mode uses the shared live aggregate adapter', () => {
  assert.match(source, /fetchTrafficReportV2Bundle/u);
  assert.doesNotMatch(source, /buildDashboardOverview/u);
  assert.doesNotMatch(source, /FlightRecord/u);
});

test('Dashboard Report Mode keeps missing Pax separate from true zero', () => {
  assert.match(source, /value === null \? '—'/u);
  assert.match(source, /Pax bằng 0/u);
  assert.match(source, /không phải thiếu dữ liệu/u);
});

test('Dashboard Report Mode exposes as-of, watermark, and an accessible daily table', () => {
  assert.match(source, /bundle\.version\.dataAsOf/u);
  assert.match(source, /bundle\.version\.sourceWatermark/u);
  assert.match(source, /aria-label="Bảng số liệu Report theo ngày"/u);
});
