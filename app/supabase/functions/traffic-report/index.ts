import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const CONTRACT_VERSION = 'traffic-report-v1';
const ALLOWED_QUERY_KEYS = new Set(['from', 'to', 'type', 'airline', 'route', 'country', 'aircraft_group', 'comp', 'tz', 'after', 'page_size']);
const LIST_KEYS = new Set(['airline', 'route', 'country', 'aircraft_group']);
const SCALAR_KEYS = [...ALLOWED_QUERY_KEYS].filter((key) => !LIST_KEYS.has(key));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type NormalizedRequest = {
  from: string | null;
  to: string | null;
  types: string[];
  airlines: string[];
  routes: string[];
  countries: string[];
  aircraftGroups: string[];
  comparison: 'previous_period' | 'previous_year' | 'none';
  timeBasis: 'local' | 'utc';
  after: string | null;
  pageSize: number;
  canonicalQuery: string;
};

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

function canonicalList(values: string[], uppercase: boolean): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean).map((value) => uppercase ? value.toUpperCase() : value))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeRequest(url: URL, endpoint: string): NormalizedRequest {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new Error(`unsupported query parameter: ${key}`);
  }
  for (const key of SCALAR_KEYS) {
    if (url.searchParams.getAll(key).length > 1) throw new Error(`duplicate scalar parameter: ${key}`);
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if ((from === null) !== (to === null)) throw new Error('from and to must be provided together');
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw new Error('dates must use YYYY-MM-DD');
  if (from && to && from > to) throw new Error('from must not exceed to');
  if (endpoint !== 'overview' && (!from || !to)) throw new Error(`${endpoint} requires from and to`);

  const type = url.searchParams.get('type') ?? 'all';
  const comp = url.searchParams.get('comp') ?? 'previous';
  const timeBasis = url.searchParams.get('tz') ?? 'local';
  if (!['all', 'A', 'D'].includes(type)) throw new Error('invalid type');
  if (!['previous', 'year_ago', 'none'].includes(comp)) throw new Error('invalid comp');
  if (!['local', 'utc'].includes(timeBasis)) throw new Error('invalid tz');
  const after = url.searchParams.get('after');
  if (after && !ISO_DATE.test(after)) throw new Error('after must use YYYY-MM-DD');
  const rawPageSize = url.searchParams.get('page_size');
  const pageSize = rawPageSize ? Number(rawPageSize) : 366;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 732) throw new Error('page_size must be between 1 and 732');

  const airlines = canonicalList(url.searchParams.getAll('airline'), true);
  const routes = canonicalList(url.searchParams.getAll('route'), true);
  const countries = canonicalList(url.searchParams.getAll('country'), false);
  const aircraftGroups = canonicalList(url.searchParams.getAll('aircraft_group'), false);
  if ([airlines, routes, countries, aircraftGroups].some((values) => values.length > 24)) throw new Error('filter cardinality exceeds 24');

  const canonical = new URLSearchParams();
  if (from && to) { canonical.set('from', from); canonical.set('to', to); }
  if (type !== 'all') canonical.set('type', type);
  for (const value of airlines) canonical.append('airline', value);
  for (const value of routes) canonical.append('route', value);
  for (const value of countries) canonical.append('country', value);
  for (const value of aircraftGroups) canonical.append('aircraft_group', value);
  if (comp !== 'previous') canonical.set('comp', comp);
  if (timeBasis !== 'local') canonical.set('tz', timeBasis);
  if (after) canonical.set('after', after);
  if (rawPageSize) canonical.set('page_size', String(pageSize));

  return {
    from,
    to,
    types: type === 'all' ? ['A', 'D'] : [type],
    airlines,
    routes,
    countries,
    aircraftGroups,
    comparison: comp === 'year_ago' ? 'previous_year' : comp === 'none' ? 'none' : 'previous_period',
    timeBasis: timeBasis as 'local' | 'utc',
    after,
    pageSize,
    canonicalQuery: canonical.toString(),
  };
}

async function postgrestRpc(functionName: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) throw new Error('report origin is not configured');
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload ? String((payload as { message: unknown }).message) : `report query failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function requestHash(request: NormalizedRequest): Promise<string> {
  const stable = new URLSearchParams(request.canonicalQuery);
  stable.delete('after');
  stable.delete('page_size');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${CONTRACT_VERSION}?${stable.toString()}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function overviewArgs(request: NormalizedRequest): Record<string, unknown> {
  return {
    p_from_date: request.from,
    p_to_date: request.to,
    p_types: request.types,
    p_airlines: request.airlines,
    p_routes: request.routes,
    p_countries: request.countries,
    p_aircraft_groups: request.aircraftGroups,
    p_comparison: request.comparison,
    p_time_basis: request.timeBasis,
    p_timeline_after: request.after,
    p_timeline_page_size: request.pageSize,
    p_contract_version: CONTRACT_VERSION,
  };
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildAggregateCsv(bundle: Record<string, unknown>): string {
  const breakdowns = bundle.breakdowns && typeof bundle.breakdowns === 'object' ? bundle.breakdowns as Record<string, unknown> : {};
  const lines = [['dimension', 'label', 'flights', 'arrivals', 'departures', 'reported_pax', 'suppressed']];
  for (const dimension of ['airline', 'route', 'country', 'aircraft_group']) {
    const rows = Array.isArray(breakdowns[dimension]) ? breakdowns[dimension] as Array<Record<string, unknown>> : [];
    for (const row of rows) lines.push([dimension, row.label, row.flights, row.arrivals, row.departures, row.reported_pax, row.suppressed]);
  }
  return `\uFEFF${lines.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
  const url = new URL(request.url);
  const endpoint = url.pathname.split('/').filter(Boolean).at(-1) ?? 'overview';
  if (!['overview', 'timeline', 'breakdowns', 'export'].includes(endpoint)) return json({ error: 'not found' }, 404);

  try {
    const normalized = normalizeRequest(url, endpoint);
    const incomingQuery = url.searchParams.toString();
    if (incomingQuery !== normalized.canonicalQuery) {
      const location = `/api/report/v1/${endpoint}${normalized.canonicalQuery ? `?${normalized.canonicalQuery}` : ''}`;
      return new Response(null, { status: 308, headers: { Location: location, 'Cache-Control': 'no-store' } });
    }

    const startedAt = performance.now();
    const dataAsOf = new Date().toISOString();
    const canonicalRequestHash = await requestHash(normalized);
    const payload = await postgrestRpc('get_public_traffic_report_overview_v1', overviewArgs(normalized));
    const duration = Math.round(performance.now() - startedAt);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid report payload');
    const bundle = payload as Record<string, unknown>;

    if (endpoint === 'export') {
      const csv = buildAggregateCsv(bundle);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="traffic-report-aggregate.csv"',
          'Cache-Control': 'no-store',
          'X-Report-Origin-Ms': String(duration),
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const metadata = bundle.metadata && typeof bundle.metadata === 'object'
      ? bundle.metadata as Record<string, unknown>
      : {};
    const responsePayload = endpoint === 'timeline'
      ? {
          contract_version: CONTRACT_VERSION,
          request_hash: canonicalRequestHash,
          data_as_of: bundle.data_as_of ?? dataAsOf,
          metadata: {
            timeline_has_more: Boolean(metadata.timeline_has_more),
            timeline_next_cursor: metadata.timeline_next_cursor ?? null,
            page_from: normalized.after ?? normalized.from,
            page_to: normalized.to,
          },
          timeline: Array.isArray(bundle.timeline) ? bundle.timeline : [],
        }
      : endpoint === 'breakdowns'
        ? { contract_version: CONTRACT_VERSION, request_hash: canonicalRequestHash, data_as_of: bundle.data_as_of ?? dataAsOf, breakdowns: bundle.breakdowns ?? {} }
        : { ...bundle, request_hash: canonicalRequestHash };
    return json(responsePayload, 200, {
      'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=30',
      'X-Report-Origin-Ms': String(duration),
      Vary: 'Accept-Encoding',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'report request failed';
    const clientError = /invalid|unsupported|must|required|cardinality|outside|provided|exceed/i.test(message);
    return json({ error: message }, clientError ? 400 : 503, { 'Cache-Control': 'no-store' });
  }
});
