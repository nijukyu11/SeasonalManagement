import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.TRAFFIC_REPORT_PREVIEW_ROOT ?? 'out');
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
const peakHourRows = Array.from({ length: 24 }, (_, hour) => ({ hour_bucket: `${String(hour).padStart(2, '0')}:00`, bucket_minutes: 60, time_basis: 'local', arrivals: 18 + (hour * 5) % 33, departures: 16 + (hour * 7) % 31, suppressed: false }));
const weekdayRows = Array.from({ length: 7 }, (_, index) => ({ day_index: index + 1, calendar_days: 4 + Number(index < 3), complete_day_count: 4 + Number(index < 3), total_flights: 260 + index * 8, average_flights: 65 + index * 2, min_flights: 54 + index, max_flights: 76 + index * 2, arrivals: 130 + index * 4, average_arrivals: 32 + index, min_arrivals: 25 + index, max_arrivals: 39 + index, departures: 130 + index * 4, average_departures: 33 + index, min_departures: 27 + index, max_departures: 40 + index, status: 'complete', suppressed: false }));
const monthlyWeekdayRows = weekdayRows.map((item) => ({ month: '2026-07', day_index: item.day_index, selected_day_count: item.calendar_days, complete_day_count: item.complete_day_count, average_flights: item.average_flights, average_arrivals: item.average_arrivals, average_departures: item.average_departures, status: 'complete', is_peak_all: item.day_index === 7, is_peak_arrivals: item.day_index === 7, is_peak_departures: item.day_index === 7 }));

function peakHourHeatmap(url) {
  const type = url.searchParams.get('type') ?? 'all';
  const basis = url.searchParams.get('tz') ?? 'local';
  const hours = Array.from({ length: 24 }, (_, offset) => (offset + (basis === 'utc' ? 22 : 5)) % 24);
  const bucketRows = (dayOffset) => hours.map((hour) => ({ hour_bucket: `${String(hour).padStart(2, '0')}:00`, flights: Math.round(1 + ((hour * 3 + dayOffset * 5) % 9) * (type === 'all' ? 1.8 : 1)) }));
  return {
    contract_version: 'traffic-report-v1', request_hash: 'preview-heatmap', data_as_of: sample.data_as_of, source_watermark: sample.source_watermark,
    month: (url.searchParams.get('from') ?? '2026-07-01').slice(0, 7), type, time_basis: basis,
    selected_day_count: 31, complete_day_count: 29, partial_day_count: 1, missing_day_count: 1,
    monthly_average: bucketRows(0),
    days: Array.from({ length: 31 }, (_, index) => ({ ops_date: `2026-07-${String(index + 1).padStart(2, '0')}`, status: index === 29 ? 'partial' : index === 30 ? 'missing' : 'complete', total_flights: index === 30 ? null : index === 17 ? 92 : 58 + (index * 7) % 29, is_month_peak: index === 17, buckets: index === 30 ? hours.map((hour) => ({ hour_bucket: `${String(hour).padStart(2, '0')}:00`, flights: null })) : bucketRows(index) })),
  };
}
const sample = {
  contract_version: 'traffic-report-v1', request_hash: 'preview-13ba8c5412f9', data_as_of: '2026-08-22T09:15:00.000Z', source_watermark: 28761,
  metadata: { min_ops_date: '2025-10-26', max_ops_date: '2026-10-24', normalized_filter: { from: '2026-07-01', to: '2026-07-31', type: 'all', airline: [], route: [], country: [], comp: 'previous', tz: 'local' }, day_count: 31, timeline_granularity: 'day', timeline_has_more: false, timeline_next_cursor: null, filter_options: { airline: ['VN', 'VJ', 'QH'], route: ['SGN', 'HAN', 'ICN'], country: ['Vietnam', 'Korea', 'Thailand'] }, filter_options_limit: 250 },
  kpis: { current: { flights: 2184, arrivals: 1076, departures: 1108, reported_pax: 273921, status: 'complete' }, comparison: { from: '2026-05-31', to: '2026-06-30', mode: 'previous', flights: 2071, arrivals: 1020, departures: 1051, reported_pax: 258442, status: 'complete' }, peak_day: { ops_date: '2026-07-18', flights: 86, status: 'available' }, pax_coverage: { reported_legs: 1998, due_legs: 2184, percent: 91.5, status: 'available' } },
  timeline: timeline(),
  breakdowns: {
    airline: Array.from({ length: 25 }, (_, index) => row(`al${index + 1}`, `Hãng ${String(index + 1).padStart(2, '0')}`, 725 - index * 20, 0)),
    route: [row('sgn', 'SGN', 506, .2317), row('han', 'HAN', 442, .2024), row('icn', 'ICN', 166, .076), row('other', 'Khác', 1070, .4899)],
    country: [row('vn', 'Vietnam', 1334, .6108), row('kr', 'Korea', 246, .1126), row('th', 'Thailand', 142, .065), row('unknown', 'Unknown', 76, .0348), row('other', 'Khác', 386, .1768)],
    aircraft_group: [row('nb', 'Narrow-body', 1625, .744), row('wb', 'Wide-body', 386, .1767), row('other', 'Khác', 173, .0793)],
    peak_hour: peakHourRows, aircraft_type: [], peak_hour_monthly: [], day_of_week: weekdayRows, day_of_week_monthly: monthlyWeekdayRows,
  },
  quality: { unknown_country_legs: 76, pax_due_missing_legs: 186, quarantined_duplicate_candidates: 0, notes: ['Pax = 0 hoặc null không được suy diễn là đã báo cáo.', 'Coverage dùng mọi leg đến hạn T+1; chưa có cờ miễn trừ cargo/ferry.', 'Country lấy từ database; tuyến chưa mapping thuộc nhóm Unknown.'] },
};

function reportSample(url) {
  return {
    ...sample,
    metadata: {
      ...sample.metadata,
      normalized_filter: {
        ...sample.metadata.normalized_filter,
        from: url.searchParams.get('from') ?? sample.metadata.normalized_filter.from,
        to: url.searchParams.get('to') ?? sample.metadata.normalized_filter.to,
        tz: url.searchParams.get('tz') ?? 'local',
      },
    },
  };
}

function dimensionSample(url) {
  const dimension = url.searchParams.get('dimension') ?? 'route';
  const sourceRows = sample.breakdowns[dimension] ?? [];
  const totalFlights = sourceRows.reduce((sum, item) => sum + item.flights, 0);
  const totalPax = sourceRows.reduce((sum, item) => sum + item.reported_pax, 0);
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('page_size') ?? 50);
  const rows = sourceRows.map((item) => ({
    key: item.key,
    label: item.label,
    flights: item.flights,
    arrivals: item.arrivals,
    departures: item.departures,
    reported_pax: item.reported_pax,
    flight_share: totalFlights > 0 ? item.flights / totalFlights : null,
    pax_share: totalPax > 0 ? item.reported_pax / totalPax : null,
    reported_legs: item.flights,
    due_legs: item.flights,
    pax_coverage_pct: 100,
    pax_status: 'available',
    suppressed: false,
  }));
  const start = (page - 1) * pageSize;
  return {
    contract_version: 'traffic-report-v1',
    request_hash: `preview-${dimension}`,
    data_as_of: sample.data_as_of,
    dimension,
    type: url.searchParams.get('type') ?? 'all',
    page,
    page_size: pageSize,
    total_rows: rows.length,
    has_more: start + pageSize < rows.length,
    rows: rows.slice(start, start + pageSize),
  };
}

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
    const payload = url.pathname.endsWith('/peak-hour-heatmap')
      ? peakHourHeatmap(url)
      : url.pathname.endsWith('/dimension')
        ? dimensionSample(url)
        : reportSample(url);
    response.end(url.pathname.endsWith('/export') ? '\uFEFFdimension,label,flights\r\nairline,Vietnam Airlines,724' : JSON.stringify(payload));
    return;
  }
  const file = serveFile(url.pathname);
  const extension = path.extname(file);
  const contentType = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType });
  response.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`traffic report preview http://127.0.0.1:${port}/reports/traffic`));
