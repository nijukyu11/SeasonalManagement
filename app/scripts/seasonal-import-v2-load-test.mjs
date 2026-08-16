import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const required = ['SEASONAL_SUPABASE_URL', 'SEASONAL_SUPABASE_ANON_KEY', 'SEASONAL_TEST_ACCESS_TOKEN', 'SEASONAL_W26_FIXTURE_PATH'];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
}
if (process.env.SEASONAL_TEST_ALLOW_COMMIT !== '1') {
  console.error('SEASONAL_TEST_ALLOW_COMMIT=1 is required because this harness commits into the isolated test database.');
  process.exit(2);
}

const fixture = JSON.parse(await readFile(process.env.SEASONAL_W26_FIXTURE_PATH, 'utf8'));
const payload = fixture.import ?? fixture;
const encoded = JSON.stringify({ p_import: payload });
assert.ok(!encoded.includes('flightRecords'), 'source-row request must not contain flightRecords');
assert.ok(Buffer.byteLength(encoded) <= 5 * 1024 * 1024, 'source-row request exceeds 5 MB');
assert.ok(Array.isArray(payload.sourceRows) && payload.sourceRows.length > 0, 'fixture sourceRows are required');

const baseUrl = process.env.SEASONAL_SUPABASE_URL.replace(/\/$/, '');
const headers = {
  apikey: process.env.SEASONAL_SUPABASE_ANON_KEY,
  authorization: `Bearer ${process.env.SEASONAL_TEST_ACCESS_TOKEN}`,
  'content-type': 'application/json',
};
async function rpc(name, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (/57014|statement timeout/i.test(text)) throw new Error(`${name} timed out: ${text}`);
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${text}`);
  return { data: JSON.parse(text), durationMs: performance.now() - started };
}

const staged = await rpc('stage_seasonal_import_v2', { p_import: payload });
assert.equal(staged.data.status, 'validated');
assert.equal(staged.data.valid, true);
assert.ok(Number(staged.data.generatedCount) > 0, 'preview generated zero records');
assert.equal(Number(staged.data.duplicateCount ?? 0), 0, 'preview contains duplicate occurrences');
const committed = await rpc('commit_seasonal_import_v2', {
  p_batch_id: staged.data.batchId,
  p_expected_data_version: payload.expectedDataVersion ?? null,
});
assert.equal(committed.data.status, 'committed');
if (fixture.expectedFlightRecordCount != null) {
  assert.equal(Number(committed.data.flightRecordCount), Number(fixture.expectedFlightRecordCount));
}
console.log(JSON.stringify({
  requestBytes: Buffer.byteLength(encoded),
  sourceRowCount: payload.sourceRows.length,
  previewDurationMs: staged.durationMs,
  commitDurationMs: committed.durationMs,
  generatedCount: staged.data.generatedCount,
  duplicateCount: staged.data.duplicateCount ?? 0,
  committed: committed.data,
}, null, 2));
