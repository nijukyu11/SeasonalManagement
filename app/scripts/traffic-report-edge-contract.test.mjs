import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file) => readFileSync(path.resolve(file), 'utf8');
const edge = read('supabase/functions/traffic-report/index.ts');
const config = read('supabase/config.toml');
const migration = read('supabase/migrations/20260822090000_public_traffic_report_v1.sql');
const nginx = read('../deploy/traffic-report/nginx.conf');

assert.match(config, /\[functions\.traffic-report\]\s*verify_jwt = false/);
assert.match(edge, /request\.method !== 'GET'/);
assert.match(edge, /unsupported query parameter/);
assert.match(edge, /duplicate scalar parameter/);
assert.match(edge, /status: 308/);
assert.match(edge, /'Cache-Control': 'no-store'/);
assert.doesNotMatch(edge, /request\.headers\.get\(['"]Authorization/);
assert.match(edge, /get_public_traffic_report_overview_v1/);
assert.match(edge, /get_traffic_report_timeline/);
assert.match(edge, /get_traffic_report_breakdowns/);
assert.match(edge, /'Accept-Profile': schema/);
assert.match(edge, /max-age=0, s-maxage=60, stale-while-revalidate=30/);

for (const signature of [
  'reporting.get_traffic_report_kpis',
  'reporting.get_traffic_report_timeline',
  'reporting.get_traffic_report_breakdowns',
  'public.get_public_traffic_report_overview_v1',
]) {
  assert.ok(migration.includes(signature), `migration is missing ${signature}`);
}
assert.match(migration, /revoke execute[\s\S]+from public, anon, authenticated/);
assert.match(migration, /grant execute[\s\S]+to service_role/);
assert.match(migration, /effective_action is distinct from 'deleted'/);
assert.match(migration, /public_traffic_duplicate_quarantine/);
assert.match(migration, /generate_series/);
assert.match(migration, /set statement_timeout = '7s'/);

assert.match(nginx, /proxy_cache_valid 200 60s/);
assert.match(nginx, /proxy_cache_background_update off/);
assert.match(nginx, /proxy_cache_use_stale off/);
assert.match(nginx, /\$uri\|\$is_args\$args/);
assert.match(nginx, /proxy_set_header Cookie ""/);
assert.match(nginx, /proxy_set_header Authorization ""/);
assert.match(nginx, /limit_req zone=traffic_report_per_ip/);

console.log(JSON.stringify({ suite: 'traffic-report-edge-contract', status: 'passed' }));
