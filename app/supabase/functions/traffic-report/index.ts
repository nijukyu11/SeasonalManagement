import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const CONTRACT_VERSION = 'traffic-report-v1';
const V2_CONTRACT_VERSION = 'traffic-report-v2';
const ALLOWED_QUERY_KEYS = new Set(['from', 'to', 'type', 'airline', 'route', 'country', 'aircraft_group', 'comp', 'tz', 'after', 'dimension', 'sort', 'page', 'page_size', 'expected_watermark']);
const LIST_KEYS = new Set(['airline', 'route', 'country', 'aircraft_group']);
const SCALAR_KEYS = [...ALLOWED_QUERY_KEYS].filter((key) => !LIST_KEYS.has(key));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KPI_YEAR = /^\d{4}$/;
const KPI_ADMIN_COOKIE = 'annual_kpi_admin';
const KPI_ADMIN_SESSION_SECONDS = 10 * 60;
const KPI_ADMIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const KPI_ADMIN_MAX_FAILURES = 5;
const KPI_ADMIN_FAILURES = new Map<string, number[]>();

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
  dimension: 'route' | 'country' | 'airline' | null;
  sort: 'flights' | 'reported_pax' | 'flight_share' | 'pax_share' | 'label';
  page: number;
  expectedWatermark: number | null;
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

function normalizeRequest(url: URL, endpoint: string, contractVersion: 'v1' | 'v2' = 'v1'): NormalizedRequest {
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
  const dimensionEndpoint = endpoint === 'dimension' || endpoint === 'dimension-export';
  const rawDimension = url.searchParams.get('dimension');
  const dimension = rawDimension && ['route', 'country', 'airline'].includes(rawDimension) ? rawDimension as NormalizedRequest['dimension'] : null;
  if (dimensionEndpoint && !dimension) throw new Error('dimension is required');
  if (!dimensionEndpoint && rawDimension) throw new Error('dimension is not supported for this endpoint');
  const rawSort = url.searchParams.get('sort') ?? 'flights';
  if (!['flights', 'reported_pax', 'flight_share', 'pax_share', 'label'].includes(rawSort)) throw new Error('invalid sort');
  if (!dimensionEndpoint && url.searchParams.has('sort')) throw new Error('sort is not supported for this endpoint');
  const rawPage = url.searchParams.get('page');
  const page = rawPage ? Number(rawPage) : 1;
  if (!Number.isInteger(page) || page < 1) throw new Error('page must be a positive integer');
  if (!dimensionEndpoint && rawPage) throw new Error('page is not supported for this endpoint');
  const rawPageSize = url.searchParams.get('page_size');
  const pageSize = rawPageSize ? Number(rawPageSize) : dimensionEndpoint ? (endpoint === 'dimension-export' ? 732 : 50) : 366;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 732) throw new Error('page_size must be between 1 and 732');
  if (dimensionEndpoint && after) throw new Error('after is not supported for dimension endpoints');
  if (contractVersion === 'v1' && url.searchParams.has('expected_watermark')) throw new Error('expected_watermark is not supported for v1');
  if (contractVersion === 'v2' && url.searchParams.has('aircraft_group')) throw new Error('aircraft_group is not supported for v2');
  const rawExpectedWatermark = url.searchParams.get('expected_watermark');
  const expectedWatermark = rawExpectedWatermark === null ? null : Number(rawExpectedWatermark);
  if (rawExpectedWatermark !== null && (!Number.isSafeInteger(expectedWatermark) || expectedWatermark < 0)) {
    throw new Error('expected_watermark must be a non-negative integer');
  }

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
  if (dimension) canonical.set('dimension', dimension);
  if (dimensionEndpoint && rawSort !== 'flights') canonical.set('sort', rawSort);
  if (dimensionEndpoint && page !== 1) canonical.set('page', String(page));
  if (rawPageSize) canonical.set('page_size', String(pageSize));
  if (expectedWatermark !== null) canonical.set('expected_watermark', String(expectedWatermark));

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
    dimension,
    sort: rawSort as NormalizedRequest['sort'],
    page,
    expectedWatermark,
    canonicalQuery: canonical.toString(),
  };
}

async function postgrestRpc(functionName: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const configuredRestUrl = Deno.env.get('SUPABASE_REST_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) throw new Error('report origin is not configured');
  const restUrl = (configuredRestUrl ?? `${supabaseUrl}/rest/v1`).replace(/\/$/u, '');
  const response = await fetch(`${restUrl}/rpc/${functionName}`, {
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

function annualKpiYear(url: URL): number {
  for (const key of url.searchParams.keys()) {
    if (key !== 'year') throw new Error(`unsupported query parameter: ${key}`);
  }
  if (url.searchParams.getAll('year').length !== 1) throw new Error('year is required');
  const rawYear = url.searchParams.get('year') ?? '';
  if (!KPI_YEAR.test(rawYear)) throw new Error('year must use YYYY');
  const year = Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('year must be between 2000 and 2200');
  return year;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function sha256Etag(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `"${base64Url(new Uint8Array(digest))}"`;
}

async function verifyConfiguredPin(pin: string): Promise<boolean> {
  const encoded = Deno.env.get('ANNUAL_KPI_ADMIN_PIN_HASH') ?? '';
  const [scheme, rawIterations, rawSalt, rawHash] = encoded.split('$');
  const iterations = Number(rawIterations);
  if (scheme !== 'pbkdf2_sha256' || !Number.isInteger(iterations) || iterations < 210_000 || !rawSalt || !rawHash) {
    throw new Error('annual KPI admin PIN is not configured');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const expected = decodeBase64(rawHash);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: decodeBase64(rawSalt),
    iterations,
  }, key, expected.length * 8));
  return constantTimeEqual(derived, expected);
}

async function hmac(value: string): Promise<string> {
  const secret = Deno.env.get('ANNUAL_KPI_ADMIN_SESSION_SECRET');
  if (!secret || secret.length < 32) throw new Error('annual KPI admin session is not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function createAdminSession(): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + KPI_ADMIN_SESSION_SECONDS;
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(18)));
  const unsigned = `v1.${expiresAt}.${nonce}`;
  return `${unsigned}.${await hmac(unsigned)}`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  for (const pair of cookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return null;
}

async function hasValidAdminSession(request: Request): Promise<boolean> {
  const token = cookieValue(request, KPI_ADMIN_COOKIE);
  if (!token) return false;
  const [version, rawExpiry, nonce, signature, ...rest] = token.split('.');
  const expiry = Number(rawExpiry);
  if (rest.length > 0 || version !== 'v1' || !Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000) || !nonce || !signature) return false;
  const unsigned = `${version}.${rawExpiry}.${nonce}`;
  const expected = await hmac(unsigned);
  return constantTimeEqual(new TextEncoder().encode(signature), new TextEncoder().encode(expected));
}

function adminOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const configured = Deno.env.get('ANNUAL_KPI_ADMIN_ALLOWED_ORIGINS')
    ?? 'https://report.ahtops.xyz,http://localhost:3000,http://127.0.0.1:3000';
  return configured.split(',').map((item) => item.trim()).filter(Boolean).includes(origin);
}

function clientAddress(request: Request): string {
  return (request.headers.get('X-Forwarded-For') ?? request.headers.get('X-Real-IP') ?? 'unknown')
    .split(',')[0].trim().slice(0, 128);
}

function activePinFailures(address: string): number[] {
  const cutoff = Date.now() - KPI_ADMIN_FAILURE_WINDOW_MS;
  const failures = (KPI_ADMIN_FAILURES.get(address) ?? []).filter((timestamp) => timestamp >= cutoff);
  if (failures.length > 0) KPI_ADMIN_FAILURES.set(address, failures);
  else KPI_ADMIN_FAILURES.delete(address);
  return failures;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > 4096) throw new Error('request body exceeds limit');
  const payload: unknown = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid JSON body');
  return payload as Record<string, unknown>;
}

async function discardRequestBody(request: Request): Promise<void> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > 4096) throw new Error('request body exceeds limit');
  if (request.body) await request.arrayBuffer();
}

function sessionCookie(value: string, maxAge: number): string {
  return `${KPI_ADMIN_COOKIE}=${value}; Path=/api/report/v1/kpi-admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function handleAnnualKpiAdmin(request: Request, url: URL): Promise<Response> {
  if (!adminOriginAllowed(request)) return json({ error_code: 'ADMIN_ORIGIN_REJECTED', error: 'Yêu cầu quản trị không hợp lệ.' }, 403, { 'Cache-Control': 'no-store' });

  if (url.pathname.endsWith('/kpi-admin/unlock')) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
    const address = clientAddress(request);
    const failures = activePinFailures(address);
    if (failures.length >= KPI_ADMIN_MAX_FAILURES) {
      return json({ error_code: 'ADMIN_RATE_LIMITED', error: 'Đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' }, 429, { 'Cache-Control': 'no-store', 'Retry-After': '900' });
    }
    const payload = await requestJson(request);
    const pin = typeof payload.pin === 'string' ? payload.pin : '';
    if (pin.length < 4 || pin.length > 128 || !await verifyConfiguredPin(pin)) {
      failures.push(Date.now());
      KPI_ADMIN_FAILURES.set(address, failures);
      return json({ error_code: 'ADMIN_PIN_INVALID', error: 'PIN không đúng.' }, 401, { 'Cache-Control': 'no-store' });
    }
    KPI_ADMIN_FAILURES.delete(address);
    const token = await createAdminSession();
    return json({ unlocked: true, expires_in_seconds: KPI_ADMIN_SESSION_SECONDS }, 200, {
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(token, KPI_ADMIN_SESSION_SECONDS),
    });
  }

  if (url.pathname.endsWith('/kpi-admin/lock')) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
    await discardRequestBody(request);
    return json({ unlocked: false }, 200, {
      'Cache-Control': 'no-store',
      // Overwrite the valid session immediately. A one-second invalid token is
      // more reliable through the public proxy than an expired-cookie header.
      'Set-Cookie': sessionCookie('locked', 1),
    });
  }

  const yearMatch = /\/kpi-admin\/(\d{4})$/u.exec(url.pathname);
  if (!yearMatch) return json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' });
  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405, { Allow: 'PUT' });
  if (!await hasValidAdminSession(request)) {
    return json({ error_code: 'ADMIN_SESSION_REQUIRED', error: 'Phiên chỉnh sửa đã hết hạn. Vui lòng nhập lại PIN.' }, 401, { 'Cache-Control': 'no-store' });
  }
  const year = Number(yearMatch[1]);
  const payload = await requestJson(request);
  const target = typeof payload.target_reported_pax === 'number' ? payload.target_reported_pax : Number(payload.target_reported_pax);
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('target_reported_pax must be a positive integer');
  const saved = await postgrestRpc('upsert_annual_passenger_kpi_v1', { p_year: year, p_target_reported_pax: target });
  const snapshot = await postgrestRpc('get_public_annual_passenger_kpi_v1', { p_year: year, p_today: null });
  return json({ config: saved, snapshot }, 200, { 'Cache-Control': 'no-store' });
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

function v2Args(request: NormalizedRequest, payloadScope: 'full' | 'timeline' | 'dimensions'): Record<string, unknown> {
  const type = request.types.length === 2 ? 'all' : request.types[0];
  return {
    p_from_date: request.from,
    p_to_date: request.to,
    p_type: type,
    p_airlines: request.airlines,
    p_routes: request.routes,
    p_countries: request.countries,
    p_comparison: request.comparison === 'previous_period'
      ? 'previous'
      : request.comparison === 'previous_year' ? 'year_ago' : 'none',
    p_time_basis: request.timeBasis,
    p_expected_watermark: request.expectedWatermark,
    p_contract_version: V2_CONTRACT_VERSION,
    p_payload_scope: payloadScope,
  };
}

function dimensionArgs(
  request: NormalizedRequest,
  page = request.page,
  dataAsOf = new Date().toISOString(),
): Record<string, unknown> {
  return {
    p_from_date: request.from,
    p_to_date: request.to,
    p_dimension: request.dimension,
    p_types: request.types,
    p_airlines: request.airlines,
    p_routes: request.routes,
    p_countries: request.countries,
    p_sort: request.sort,
    p_page: page,
    p_page_size: request.pageSize,
    p_data_as_of: dataAsOf,
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

function buildDimensionCsv(payload: Record<string, unknown>): string {
  const rows = Array.isArray(payload.rows) ? payload.rows as Array<Record<string, unknown>> : [];
  const lines = [[
    'dimension', 'scope', 'label', 'flights', 'flight_share', 'reported_pax', 'pax_share',
    'reported_legs', 'due_legs', 'pax_coverage_pct', 'suppressed', 'pax_status',
  ]];
  for (const row of rows) {
    lines.push([
      payload.dimension, payload.type, row.label, row.flights, row.flight_share, row.reported_pax,
      row.pax_share, row.reported_legs, row.due_legs, row.pax_coverage_pct, row.suppressed, row.pax_status,
    ]);
  }
  return `\uFEFF${lines.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

function buildV2AggregateCsv(bundle: Record<string, unknown>): string {
  const dimensions = bundle.dimensions && typeof bundle.dimensions === 'object'
    ? bundle.dimensions as Record<string, unknown>
    : {};
  const lines: unknown[][] = [[
    'dimension', 'label', 'flights', 'arrivals', 'departures', 'reported_pax',
    'reported_legs', 'due_legs', 'missing_due_legs', 'true_zero_reported_legs',
  ]];
  for (const dimension of ['airline', 'route', 'country']) {
    const rows = Array.isArray(dimensions[dimension]) ? dimensions[dimension] as Array<Record<string, unknown>> : [];
    for (const row of rows) lines.push([
      dimension, row.label, row.flights, row.arrivals, row.departures, row.reported_pax,
      row.reported_legs, row.due_legs, row.missing_due_legs, row.true_zero_reported_legs,
    ]);
  }
  return `\uFEFF${lines.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const endpoint = url.pathname.split('/').filter(Boolean).at(-1) ?? 'overview';
  const isV2 = /\/api\/report\/v2(?:\/|$)/u.test(url.pathname);

  try {
    if (url.pathname.includes('/kpi-admin/')) return await handleAnnualKpiAdmin(request, url);
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });

    if (endpoint === 'annual-kpi' || endpoint === 'dashboard-version' || endpoint === 'kpi-config') {
      if (endpoint === 'kpi-config' && !url.searchParams.has('year') && [...url.searchParams.keys()].length > 0) {
        throw new Error('unsupported query parameter');
      }
      const year = endpoint === 'kpi-config' && !url.searchParams.has('year') ? null : annualKpiYear(url);
      const functionName = endpoint === 'annual-kpi'
        ? 'get_public_annual_passenger_kpi_v1'
        : endpoint === 'dashboard-version'
          ? 'get_public_annual_passenger_kpi_version_v1'
          : 'get_public_annual_passenger_kpi_config_v1';
      const payload = await postgrestRpc(functionName, endpoint === 'annual-kpi'
        ? { p_year: year, p_today: null }
        : { p_year: year });
      const etag = await sha256Etag(payload);
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': endpoint === 'dashboard-version'
              ? 'public, max-age=0, s-maxage=300'
              : endpoint === 'kpi-config'
                ? 'no-store'
                : 'public, max-age=0, s-maxage=60',
          },
        });
      }
      return json(payload, 200, {
        ETag: etag,
        'Cache-Control': endpoint === 'dashboard-version'
          ? 'public, max-age=0, s-maxage=300'
          : endpoint === 'kpi-config'
            ? 'no-store'
            : 'public, max-age=0, s-maxage=60',
        Vary: 'Accept-Encoding',
      });
    }

    const supportedEndpoints = isV2
      ? ['overview', 'timeline', 'dimension', 'dimension-export', 'export']
      : ['overview', 'timeline', 'breakdowns', 'dimension', 'dimension-export', 'export'];
    if (!supportedEndpoints.includes(endpoint)) return json({ error: 'not found' }, 404);
    const normalized = normalizeRequest(url, endpoint, isV2 ? 'v2' : 'v1');
    const incomingQuery = url.searchParams.toString();
    if (incomingQuery !== normalized.canonicalQuery) {
      const location = `/api/report/${isV2 ? 'v2' : 'v1'}/${endpoint}${normalized.canonicalQuery ? `?${normalized.canonicalQuery}` : ''}`;
      return new Response(null, { status: 308, headers: { Location: location, 'Cache-Control': 'no-store' } });
    }

    const startedAt = performance.now();
    if (isV2) {
      const payloadScope = endpoint === 'timeline'
        ? 'timeline'
        : endpoint === 'overview' ? 'full' : 'dimensions';
      const payload = await postgrestRpc('get_public_traffic_report_v2', v2Args(normalized, payloadScope));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid traffic-report-v2 payload');
      const bundle = payload as Record<string, unknown>;
      const sourceWatermark = bundle.source_watermark;
      const filterHash = bundle.filter_hash;
      if (!Number.isSafeInteger(sourceWatermark) || typeof filterHash !== 'string') throw new Error('invalid traffic-report-v2 version envelope');
      const etag = await sha256Etag({ endpoint, sourceWatermark, filterHash, query: normalized.canonicalQuery });
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=0, s-maxage=30' } });
      }
      const version = {
        contract_version: bundle.contract_version,
        data_as_of: bundle.data_as_of,
        source_watermark: bundle.source_watermark,
        data_version: bundle.data_version,
        filter_hash: bundle.filter_hash,
        source_mode: bundle.source_mode,
        normalized_filter: bundle.normalized_filter,
      };
      if (endpoint === 'export') {
        return new Response(buildV2AggregateCsv(bundle), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="traffic-report-v2-aggregate.csv"',
            'Cache-Control': 'no-store',
            'X-Report-Source-Mode': String(bundle.source_mode ?? 'live'),
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      let responsePayload: Record<string, unknown> = bundle;
      if (endpoint === 'timeline') {
        const allRows = Array.isArray(bundle.timeline) ? bundle.timeline as Array<Record<string, unknown>> : [];
        const firstIndex = normalized.after
          ? allRows.findIndex((row) => String(row.ops_date) > normalized.after!)
          : 0;
        const offset = firstIndex < 0 ? allRows.length : firstIndex;
        const rows = allRows.slice(offset, offset + normalized.pageSize);
        responsePayload = {
          ...version,
          page_size: normalized.pageSize,
          has_more: offset + rows.length < allRows.length,
          next_cursor: offset + rows.length < allRows.length && rows.length > 0
            ? String(rows.at(-1)?.ops_date ?? '')
            : null,
          timeline: rows,
        };
      }
      if (endpoint === 'dimension' || endpoint === 'dimension-export') {
        const dimensions = bundle.dimensions && typeof bundle.dimensions === 'object'
          ? bundle.dimensions as Record<string, unknown>
          : {};
        const allRows = normalized.dimension && Array.isArray(dimensions[normalized.dimension])
          ? [...dimensions[normalized.dimension] as Array<Record<string, unknown>>]
          : [];
        allRows.sort((left, right) => {
          if (normalized.sort === 'label') {
            return String(left.label ?? '').localeCompare(String(right.label ?? ''), 'vi');
          }
          const leftValue = typeof left[normalized.sort] === 'number' ? left[normalized.sort] as number : null;
          const rightValue = typeof right[normalized.sort] === 'number' ? right[normalized.sort] as number : null;
          if (leftValue === null && rightValue !== null) return 1;
          if (leftValue !== null && rightValue === null) return -1;
          if (leftValue !== rightValue) return (rightValue ?? 0) - (leftValue ?? 0);
          return String(left.label ?? '').localeCompare(String(right.label ?? ''), 'vi');
        });
        const offset = (normalized.page - 1) * normalized.pageSize;
        responsePayload = {
          ...version,
          dimension: normalized.dimension,
          type: normalized.types.length === 1 ? normalized.types[0] : 'all',
          page: normalized.page,
          page_size: normalized.pageSize,
          total_rows: allRows.length,
          has_more: offset + normalized.pageSize < allRows.length,
          rows: allRows.slice(offset, offset + normalized.pageSize),
        };
        if (endpoint === 'dimension-export') {
          return new Response(buildDimensionCsv(responsePayload), {
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="traffic-report-${normalized.dimension}-${normalized.types.join('').toLowerCase()}.csv"`,
              'Cache-Control': 'no-store',
              'X-Report-Origin-Ms': String(Math.round(performance.now() - startedAt)),
              'X-Report-Source-Mode': String(bundle.source_mode ?? 'live'),
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }
      }
      return json(responsePayload, 200, {
        ETag: etag,
        'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=15',
        'X-Report-Origin-Ms': String(Math.round(performance.now() - startedAt)),
        'X-Report-Source-Mode': String(bundle.source_mode ?? 'live'),
        Vary: 'Accept-Encoding',
      });
    }

    const dataAsOf = new Date().toISOString();
    const canonicalRequestHash = await requestHash(normalized);
    if (endpoint === 'dimension' || endpoint === 'dimension-export') {
      const firstPayload = await postgrestRpc('get_public_traffic_report_dimension_v2', dimensionArgs(normalized));
      if (!firstPayload || typeof firstPayload !== 'object' || Array.isArray(firstPayload)) throw new Error('invalid dimension payload');
      const dimensionPayload = firstPayload as Record<string, unknown>;
      const dimensionDataAsOf = typeof dimensionPayload.data_as_of === 'string'
        ? dimensionPayload.data_as_of
        : dataAsOf;
      if (endpoint === 'dimension-export') {
        const rows = Array.isArray(dimensionPayload.rows) ? [...dimensionPayload.rows] : [];
        let page = normalized.page;
        let hasMore = Boolean(dimensionPayload.has_more);
        while (hasMore && page < normalized.page + 25) {
          page += 1;
          const nextPayload = await postgrestRpc(
            'get_public_traffic_report_dimension_v2',
            dimensionArgs(normalized, page, dimensionDataAsOf),
          );
          if (!nextPayload || typeof nextPayload !== 'object' || Array.isArray(nextPayload)) throw new Error('invalid dimension export payload');
          const next = nextPayload as Record<string, unknown>;
          if (Array.isArray(next.rows)) rows.push(...next.rows);
          hasMore = Boolean(next.has_more);
        }
        if (hasMore) throw new Error('dimension export exceeds resource budget');
        const csv = buildDimensionCsv({ ...dimensionPayload, rows });
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="traffic-report-${normalized.dimension}-${normalized.types.join('').toLowerCase()}.csv"`,
            'Cache-Control': 'no-store',
            'X-Report-Origin-Ms': String(Math.round(performance.now() - startedAt)),
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      return json({ ...dimensionPayload, contract_version: CONTRACT_VERSION, request_hash: canonicalRequestHash, data_as_of: dimensionDataAsOf }, 200, {
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=30',
        'X-Report-Origin-Ms': String(Math.round(performance.now() - startedAt)),
        Vary: 'Accept-Encoding',
      });
    }
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
    const adminRequest = url.pathname.includes('/kpi-admin/');
    if (adminRequest) {
      const unavailable = /not configured/i.test(message);
      return json({
        error_code: unavailable ? 'ADMIN_NOT_CONFIGURED' : 'ADMIN_REQUEST_INVALID',
        error: unavailable ? 'Trình chỉnh sửa KPI chưa được cấu hình trên máy chủ.' : 'Thông tin KPI chưa hợp lệ.',
      }, unavailable ? 503 : 400, { 'Cache-Control': 'no-store' });
    }
    if (/DATA_VERSION_CHANGED/i.test(message)) {
      const expected = /expected=(\d+)/u.exec(message)?.[1] ?? null;
      const actual = /actual=(\d+)/u.exec(message)?.[1] ?? null;
      return json({
        error_code: 'DATA_VERSION_CHANGED',
        error: 'Dữ liệu báo cáo đã thay đổi. Vui lòng tải lại toàn bộ báo cáo.',
        expected_watermark: expected === null ? null : Number(expected),
        actual_watermark: actual === null ? null : Number(actual),
      }, 409, { 'Cache-Control': 'no-store' });
    }
    const clientError = /invalid|unsupported|must|required|cardinality|outside|provided|exceed/i.test(message);
    return json({
      error_code: clientError ? 'INVALID_REPORT_FILTER' : 'REPORT_TEMPORARILY_UNAVAILABLE',
      error: clientError ? 'Bộ lọc báo cáo chưa hợp lệ. Vui lòng kiểm tra phạm vi ngày và các lựa chọn.' : 'Báo cáo tạm thời chưa thể cập nhật. Vui lòng thử lại.',
    }, clientError ? 400 : 503, { 'Cache-Control': 'no-store' });
  }
});
