import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runner = await readFile(new URL('../../deploy/traffic-report/seasonal-traffic-dashboard-runner', import.meta.url), 'utf8');

test('runner selects durable corrections before the normal Daily candidate', () => {
  const correction = runner.indexOf('select_public_dashboard_correction_candidate_v1');
  const daily = runner.indexOf('select_public_dashboard_candidate_v1');
  assert.ok(correction >= 0);
  assert.ok(daily > correction);
  assert.match(runner, /no_correction.*defer_to_daily/u);
  assert.match(runner, /correction_debouncing/u);
});

test('runner uses a two-minute wake, single-flight and correction trigger', () => {
  assert.match(runner, /for delay in 2m 5m 15m/u);
  assert.match(runner, /flock -n 9/u);
  assert.match(runner, /manual_correction/u);
  assert.match(runner, /Daily Pax auto-save correction after two-minute quiet window/u);
});

test('runner verifies before conditionally acknowledging and retains failures', () => {
  const verify = runner.indexOf('verify_public_dashboard_publication_v1');
  const acknowledge = runner.lastIndexOf('acknowledge_corrections');
  assert.ok(verify >= 0);
  assert.ok(acknowledge > verify);
  assert.match(runner, /defer_public_dashboard_correction_v1/u);
  assert.match(runner, /cache_sla_seconds=120/u);
  assert.match(runner, /DASHBOARD_VERIFY_PUBLIC_CACHE:-true/u);
});
