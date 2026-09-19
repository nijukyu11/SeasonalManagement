import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { buildWorkbookReportModel, normalizeWorkbookRequest } from '../supabase/functions/_shared/trafficWorkbookCore.ts';
import { buildTrafficWorkbookPackage } from '../supabase/functions/_shared/trafficWorkbookRenderer.ts';

const output = resolve(process.argv[2] ?? 'report-templates/bao-cao-san-luong/v1/BaoCaoSanLuong-public-v1.xlsx');
const request = normalizeWorkbookRequest(new URL('https://template.local/api/report/v1/workbook-export?report_type=BAO_CAO_SAN_LUONG&template_version=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24'));
const emptyBundle = {
  contract_version: 'traffic-report-v1',
  data_as_of: '2000-01-01T00:00:00.000Z',
  source_watermark: 'template',
  metadata: {
    min_ops_date: '2026-03-29', max_ops_date: '2026-10-24', latest_completed_ops_date: null,
    day_count: 210, projection: { status: 'template' },
  },
  kpis: {
    current: { flights: null, arrivals: null, departures: null, reported_pax: null, status: 'template' },
    peak_day: { ops_date: null, flights: null },
    pax_coverage: { reported_legs: null, due_legs: null, percent: null, status: 'template' },
  },
  timeline: [],
  breakdowns: { peak_hour: [], peak_hour_monthly: [], day_of_week: [], aircraft_group: [], aircraft_type: [] },
  quality: { notes: ['Template public rỗng; runtime ghi values từ canonical backend.'] },
};
const model = buildWorkbookReportModel({
  request,
  requestHash: 'template',
  requestId: 'template',
  generatedAt: '2000-01-01T00:00:00.000Z',
  currentBundle: emptyBundle,
  currentDimensions: { airline: [], country: [], route: [] },
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, zipSync(buildTrafficWorkbookPackage(model), { level: 9 }));
process.stdout.write(`${output}\n`);
