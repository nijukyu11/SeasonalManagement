import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const required = ['SEASONAL_SUPABASE_URL', 'SEASONAL_SUPABASE_ANON_KEY', 'SEASONAL_TEST_ACCESS_TOKEN', 'SEASONAL_TEST_SEASON_ID'];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
}

const baseUrl = process.env.SEASONAL_SUPABASE_URL.replace(/\/$/, '');
const endpoint = `${baseUrl}/rest/v1/rpc/get_season_schedule_allocation_window_v2`;
const headers = {
  apikey: process.env.SEASONAL_SUPABASE_ANON_KEY,
  authorization: `Bearer ${process.env.SEASONAL_TEST_ACCESS_TOKEN}`,
  'content-type': 'application/json',
};
const clients = Number(process.env.SEASONAL_LOAD_CLIENTS ?? 7);
const pageSize = Number(process.env.SEASONAL_WORKSPACE_PAGE_SIZE ?? 500);
const p95LimitMs = Number(process.env.SEASONAL_PAGE_P95_LIMIT_MS ?? 2000);
const maxLimitMs = Number(process.env.SEASONAL_PAGE_MAX_LIMIT_MS ?? 4000);
let active = 0;
let maxActive = 0;
const latencies = [];

async function rpc(payload) {
  active += 1;
  maxActive = Math.max(maxActive, active);
  const started = performance.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    if (/57014|statement timeout/i.test(text)) throw new Error(`workspace V2 timeout: ${text}`);
    if (!response.ok) throw new Error(`workspace V2 HTTP ${response.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    latencies.push(performance.now() - started);
    active -= 1;
  }
}

async function loadChain(clientIndex) {
  let cursor = null;
  let snapshot = null;
  const roots = [];
  let pageCount = 0;
  do {
    const page = await rpc({
      p_season_id: process.env.SEASONAL_TEST_SEASON_ID,
      p_start_date: process.env.SEASONAL_TEST_DATE_FROM ?? null,
      p_end_date: process.env.SEASONAL_TEST_DATE_TO ?? null,
      p_resource_type: process.env.SEASONAL_TEST_RESOURCE_TYPE ?? 'schedule',
      p_page_size: pageSize,
      p_after_effective_date: cursor?.effectiveDate ?? null,
      p_after_root_id: cursor?.rootId ?? null,
      p_after_root_kind: cursor?.rootKind ?? null,
      p_expected_data_version: snapshot?.dataVersion ?? null,
      p_expected_server_high_water: snapshot?.serverHighWater ?? null,
    });
    assert.equal(page.status, 'ok', `client ${clientIndex} page status`);
    snapshot ??= page.snapshot;
    assert.deepEqual(page.snapshot, snapshot, `client ${clientIndex} mixed snapshot`);
    for (const row of page.flightRecords ?? []) roots.push(`record:${row.record_id}`);
    for (const row of page.modifications ?? []) roots.push(`modification:${row.leg_id}`);
    cursor = page.page.hasMore ? page.page.nextCursor : null;
    assert.ok(!page.page.hasMore || cursor, `client ${clientIndex} missing cursor`);
    pageCount += 1;
  } while (cursor);
  assert.equal(new Set(roots).size, roots.length, `client ${clientIndex} duplicate roots`);
  return { snapshot, roots: roots.sort(), pageCount };
}

const results = await Promise.all(Array.from({ length: clients }, (_, index) => loadChain(index + 1)));
for (const result of results.slice(1)) assert.deepEqual(result, results[0], 'independent clients assembled different windows');
const sorted = [...latencies].sort((a, b) => a - b);
const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
const maximum = sorted.at(-1) ?? 0;
assert.ok(maxActive <= clients, `page concurrency ${maxActive} exceeded client count ${clients}`);
assert.ok(p95 < p95LimitMs, `page p95 ${p95.toFixed(1)}ms exceeded ${p95LimitMs}ms`);
assert.ok(maximum < maxLimitMs, `page max ${maximum.toFixed(1)}ms exceeded ${maxLimitMs}ms`);
console.log(JSON.stringify({ clients, pageSize, pageStatements: latencies.length, maxActive, p95Ms: p95, maxMs: maximum, ...results[0] }, null, 2));
