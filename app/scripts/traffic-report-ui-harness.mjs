import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.TRAFFIC_REPORT_HARNESS_PORT ?? 3010);
const outRoot = path.resolve('out-report');
const apiUpstream = process.env.TRAFFIC_REPORT_API_UPSTREAM?.replace(/\/$/, '') ?? null;
const numberOfDays = 63;
const start = new Date('2025-12-15T00:00:00Z');

const isoDate = (offset) => {
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const timelineFor = (type) => Array.from({ length: numberOfDays }, (_, index) => {
  const missing = index === 14;
  const partial = index === 31 || index === 32;
  const base = 44 + Math.round(10 * Math.sin(index / 4)) + (index % 7 === 5 ? 8 : 0);
  const flights = type === 'A' ? Math.round(base * 0.51) : type === 'D' ? Math.round(base * 0.49) : base;
  const pax = Math.max(0, Math.round(flights * (138 + 12 * Math.cos(index / 5))));
  const due = flights;
  const reported = Math.max(0, flights - (index % 6));
  return {
    ops_date: isoDate(index),
    flights: missing ? null : flights,
    arrivals: missing ? null : type === 'D' ? 0 : Math.round(base * 0.51),
    departures: missing ? null : type === 'A' ? 0 : Math.round(base * 0.49),
    reported_pax: missing || index % 11 === 0 ? null : pax,
    reported_legs: missing ? null : reported,
    due_legs: missing ? null : due,
    pax_coverage_pct: missing || due === 0 ? null : Math.round(reported * 1000 / due) / 10,
    pax_status: missing || index % 11 === 0 ? 'unavailable' : 'available',
    completeness: missing ? 'missing' : partial ? 'partial' : 'complete',
    status: missing ? 'missing' : partial ? 'partial' : 'complete',
    suppressed: false,
  };
});

const breakdownRows = (prefix, count) => Array.from({ length: count }, (_, index) => ({
  key: `${prefix}-${index + 1}`,
  label: prefix === 'route' ? ['HAN', 'SGN', 'CXR', 'PQC', 'HPH', 'VDO', 'VII', 'DLI', 'BKK', 'SIN', 'Khác'][index]
    : prefix === 'country' ? ['Vietnam', 'Thailand', 'Singapore', 'South Korea', 'Malaysia', 'Japan', 'Unknown', 'Khác'][index]
      : ['VN', 'VJ', 'QH', 'BL', 'SQ', 'TG', 'KE', 'AK', 'Khác'][index],
  flights: 1180 - index * 93,
  arrivals: 600 - index * 47,
  departures: 580 - index * 46,
  reported_pax: 154000 - index * 13600,
  reported_legs: 1120 - index * 88,
  due_legs: 1180 - index * 93,
  pax_coverage_pct: 94.9 - index * 0.7,
  flight_share: Math.max(0.02, 0.29 - index * 0.024),
  pax_share: Math.max(0.018, 0.31 - index * 0.027),
  suppressed: false,
  pax_status: 'available',
}));

const peakHours = Array.from({ length: 24 }, (_, hour) => ({
  hour_bucket: `${String(hour).padStart(2, '0')}:00`,
  bucket_minutes: 60,
  time_basis: 'local',
  arrivals: 45 + ((hour * 7) % 50),
  departures: 40 + ((hour * 9) % 55),
  regular_flights: {
    arrivals: hour === 23 ? [
      { airline: 'VN', flight_number: 'VN171', route: 'HAN', typical_time: '23:10', operating_days: [1, 2, 3, 4, 5, 6, 7], occurrence_days: 61, eligible_days: 63, consistency_percent: 97 },
      { airline: 'VJ', flight_number: 'VJ641', route: 'SGN', typical_time: '23:35', operating_days: [1, 3, 5], occurrence_days: 26, eligible_days: 27, consistency_percent: 96 },
    ] : [],
    departures: hour === 12 ? [
      { airline: 'VN', flight_number: 'VN182', route: 'HAN', typical_time: '12:15', operating_days: [1, 2, 3, 4, 5], occurrence_days: 44, eligible_days: 45, consistency_percent: 98 },
    ] : [],
  },
  suppressed: false,
}));

const overview = {
  contract_version: 'traffic-report-v1',
  request_hash: 'ui-harness-only',
  data_as_of: '2026-02-17T03:00:00.000Z',
  source_watermark: 1,
  metadata: {
    min_ops_date: '2025-03-30',
    max_ops_date: '2027-10-24',
    latest_completed_ops_date: '2026-02-16',
    normalized_filter: { from: '2025-12-15', to: '2026-02-15', type: 'all', airline: [], route: [], country: [], comp: 'previous', tz: 'local' },
    day_count: numberOfDays,
    selected_day_count: numberOfDays,
    covered_day_count: 60,
    partial_day_count: 2,
    missing_day_count: 1,
    timeline_granularity: 'day',
    timeline_has_more: false,
    timeline_next_cursor: null,
    filter_options: { airline: ['VN', 'VJ', 'QH', 'SQ', 'TG'], route: ['HAN', 'SGN', 'CXR', 'PQC', 'BKK', 'SIN'], country: ['Vietnam', 'Thailand', 'Singapore', 'Unknown'] },
    available_dimensions: ['route', 'country', 'airline'],
    filter_options_limit: 250,
  },
  kpis: {
    current: { flights: 2954, arrivals: 1508, departures: 1446, reported_pax: 402810, arrival_reported_pax: 206500, departure_reported_pax: 196310, status: 'partial' },
    comparison: { flights: 2812, arrivals: 1431, departures: 1381, reported_pax: 378440, arrival_reported_pax: 192500, departure_reported_pax: 185940, from: '2025-10-13', to: '2025-12-14', mode: 'previous', status: 'complete' },
    peak_day: { ops_date: '2026-01-17', flights: 68, status: 'available' },
    pax_coverage: { reported_legs: 2780, due_legs: 2954, percent: 94.1, status: 'available' },
  },
  timeline: timelineFor('all'),
  breakdowns: {
    airline: breakdownRows('airline', 9).map((row) => ({ ...row, share: row.flight_share })),
    route: breakdownRows('route', 11).map((row) => ({ ...row, share: row.flight_share })),
    country: breakdownRows('country', 8).map((row) => ({ ...row, share: row.flight_share })),
    aircraft_group: [
      { key: 'a321', label: 'A320/A321', flights: 1720, arrivals: 870, departures: 850, reported_pax: 242000, share: 0.58, suppressed: false },
      { key: 'b737', label: 'B737', flights: 830, arrivals: 425, departures: 405, reported_pax: 118000, share: 0.28, suppressed: false },
      { key: 'wide', label: 'Wide-body', flights: 404, arrivals: 213, departures: 191, reported_pax: 42810, share: 0.14, suppressed: false },
    ],
    aircraft_type: [
      { key: 'a321-a321', aircraft_group_key: 'a321', aircraft_group: 'A320/A321', label: 'A321', flights: 1080, arrivals: 550, departures: 530, reported_pax: 158000, share: 0.63, suppressed: false },
      { key: 'a321-a320', aircraft_group_key: 'a321', aircraft_group: 'A320/A321', label: 'A320', flights: 640, arrivals: 320, departures: 320, reported_pax: 84000, share: 0.37, suppressed: false },
      { key: 'b737-b738', aircraft_group_key: 'b737', aircraft_group: 'B737', label: 'B738', flights: 830, arrivals: 425, departures: 405, reported_pax: 118000, share: 1, suppressed: false },
      { key: 'wide-a359', aircraft_group_key: 'wide', aircraft_group: 'Wide-body', label: 'A359', flights: 240, arrivals: 126, departures: 114, reported_pax: 27900, share: 0.59, suppressed: false },
      { key: 'wide-b789', aircraft_group_key: 'wide', aircraft_group: 'Wide-body', label: 'B789', flights: 164, arrivals: 87, departures: 77, reported_pax: 14910, share: 0.41, suppressed: false },
    ],
    peak_hour: peakHours,
    peak_hour_monthly: [
      { month: '2025-12', time_basis: 'local', arrival_hour: '08:00', arrival_flights: 124, departure_hour: '20:00', departure_flights: 119, arrival_suppressed: false, departure_suppressed: false },
      { month: '2026-01', time_basis: 'local', arrival_hour: '09:00', arrival_flights: 151, departure_hour: '19:00', departure_flights: 148, arrival_suppressed: false, departure_suppressed: false },
      { month: '2026-02', time_basis: 'local', arrival_hour: '08:00', arrival_flights: 76, departure_hour: '18:00', departure_flights: 72, arrival_suppressed: false, departure_suppressed: false },
    ],
    day_of_week: Array.from({ length: 7 }, (_, index) => ({ day_index: index + 1, calendar_days: 9, total_flights: 410 + index * 7, average_flights: 45.6 + index * 0.8, min_flights: 37 + index, max_flights: 59 + index, arrivals: 210 + index * 3, departures: 200 + index * 4, suppressed: false })),
  },
  quality: { unknown_country_legs: 38, pax_due_missing_legs: 174, quarantined_duplicate_candidates: 0, notes: ['Sản lượng khách chỉ cộng số đã báo cáo trên các chuyến đã đến hạn.', 'Ngày chưa được xác nhận đầy đủ không được tự động xem là sản lượng bằng 0.', 'Quốc gia lấy từ database; tuyến chưa mapping thuộc nhóm Unknown.'] },
};

function json(response, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(response) };
}

async function serveStatic(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const candidates = clean === '/' ? ['index.html'] : clean.endsWith('/') ? [`${clean.slice(1)}index.html`] : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
  for (const candidate of candidates) {
    const resolved = path.resolve(outRoot, candidate);
    if (!resolved.startsWith(outRoot)) continue;
    try {
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      const extension = path.extname(resolved);
      const type = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
      return { status: 200, headers: { 'Content-Type': type }, body: await readFile(resolved) };
    } catch {}
  }
  return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  let result;
  if (url.pathname.endsWith('/overview')) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    result = json(from && to ? { ...overview, metadata: { ...overview.metadata, normalized_filter: { ...overview.metadata.normalized_filter, from, to } } } : overview);
  } else if (url.pathname.endsWith('/timeline')) {
    const type = url.searchParams.get('type') ?? 'all';
    result = json({ contract_version: 'traffic-report-v1', request_hash: 'ui-harness-only', data_as_of: overview.data_as_of, metadata: { timeline_has_more: false, timeline_next_cursor: null }, timeline: timelineFor(type) });
  } else if (url.pathname.endsWith('/dimension')) {
    const dimension = url.searchParams.get('dimension') ?? 'route';
    const type = url.searchParams.get('type') ?? 'all';
    const rows = breakdownRows(dimension, dimension === 'route' ? 11 : dimension === 'country' ? 8 : 9);
    result = json({ contract_version: 'traffic-report-v1', request_hash: 'ui-harness-only', data_as_of: overview.data_as_of, dimension, type, page: 1, page_size: 50, total_rows: rows.length, has_more: false, rows });
  } else if (url.pathname.includes('/api/report/') && apiUpstream) {
    const upstream = await fetch(`${apiUpstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { Accept: request.headers.accept ?? 'application/json' },
    });
    result = {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(upstream.headers.get('etag') ? { ETag: upstream.headers.get('etag') } : {}),
      },
      body: Buffer.from(await upstream.arrayBuffer()),
    };
  } else if (url.pathname.includes('/api/report/')) {
    result = json({ error: 'Harness endpoint not implemented.' }, 404);
  } else {
    result = await serveStatic(url.pathname);
  }
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}).listen(port, '127.0.0.1', () => {
  console.log(`Traffic report UI harness: http://127.0.0.1:${port}/reports/traffic`);
});
