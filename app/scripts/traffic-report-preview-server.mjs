import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('out');
const port = Number(process.env.TRAFFIC_REPORT_PREVIEW_PORT ?? 4173);
const apiRequests = [];

function timeline() {
  return Array.from({ length: 31 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    const arrivals = 28 + (index * 7) % 19;
    const departures = 30 + (index * 5) % 17;
    return { ops_date: `2026-07-${day}`, flights: arrivals + departures, arrivals, departures, reported_pax: (arrivals + departures) * 132, completeness: 'complete' };
  });
}

const row = (key, label, flights, share) => ({ key, label, flights, arrivals: Math.floor(flights / 2), departures: Math.ceil(flights / 2), reported_pax: flights * 132, share, suppressed: false });
const sample = {
  contract_version: 'traffic-report-v1', request_hash: 'preview-13ba8c5412f9', data_as_of: '2026-08-22T09:15:00.000Z', source_watermark: 28761,
  metadata: { min_ops_date: '2025-10-26', max_ops_date: '2026-10-24', normalized_filter: { from: '2026-07-01', to: '2026-07-31', type: 'all', airline: [], route: [], country: [], comp: 'previous', tz: 'local' }, day_count: 31, timeline_granularity: 'day', timeline_has_more: false, timeline_next_cursor: null },
  kpis: { current: { flights: 2184, arrivals: 1076, departures: 1108, reported_pax: 273921, status: 'complete' }, comparison: { from: '2026-05-31', to: '2026-06-30', mode: 'previous', flights: 2071, arrivals: 1020, departures: 1051, reported_pax: 258442, status: 'complete' }, peak_day: { ops_date: '2026-07-18', flights: 86, status: 'available' }, pax_coverage: { reported_legs: 1998, due_legs: 2184, percent: 91.5, status: 'available' } },
  timeline: timeline(),
  breakdowns: {
    airline: [row('vn', 'Vietnam Airlines', 724, .3315), row('vj', 'VietJet Air', 612, .2802), row('qh', 'Bamboo Airways', 241, .1103), row('other', 'Khác', 607, .278)],
    route: [row('sgn', 'SGN', 506, .2317), row('han', 'HAN', 442, .2024), row('icn', 'ICN', 166, .076), row('other', 'Khác', 1070, .4899)],
    country: [row('vn', 'Vietnam', 1334, .6108), row('kr', 'Korea', 246, .1126), row('th', 'Thailand', 142, .065), row('unknown', 'Unknown', 76, .0348), row('other', 'Khác', 386, .1768)],
    aircraft_group: [row('nb', 'Narrow-body', 1625, .744), row('wb', 'Wide-body', 386, .1767), row('other', 'Khác', 173, .0793)],
    peak_hour: [],
  },
  quality: { unknown_country_legs: 76, pax_due_missing_legs: 186, quarantined_duplicate_candidates: 0, notes: ['Pax = 0 hoặc null không được suy diễn là đã báo cáo.', 'Coverage dùng mọi leg đến hạn T+1; chưa có cờ miễn trừ cargo/ferry.', 'Country lấy từ database; tuyến chưa mapping thuộc nhóm Unknown.'] },
};

function serveFile(requestPath) {
  const clean = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const candidates = [clean, `${clean}.html`, path.join(clean, 'index.html')].filter(Boolean);
  if (!clean) candidates.unshift('index.html');
  for (const candidate of candidates) {
    const file = path.resolve(root, candidate);
    if (!file.startsWith(root)) continue;
    try { if (statSync(file).isFile()) return file; } catch { /* continue */ }
  }
  return path.join(root, '404.html');
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  if (url.pathname === '/__stats') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ apiRequests }));
    return;
  }
  if (url.pathname.startsWith('/api/report/v1/')) {
    apiRequests.push(`${url.pathname}${url.search}`);
    response.writeHead(200, { 'Content-Type': url.pathname.endsWith('/export') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(url.pathname.endsWith('/export') ? '\uFEFFdimension,label,flights\r\nairline,Vietnam Airlines,724' : JSON.stringify(sample));
    return;
  }
  const file = serveFile(url.pathname);
  const extension = path.extname(file);
  const contentType = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  response.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`traffic report preview http://127.0.0.1:${port}/reports/traffic`));
