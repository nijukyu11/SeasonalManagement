import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260721090000_fix_seasonal_export_snapshot_identity_counts.sql',
);
const schemaPath = join(process.cwd(), 'supabase/schema.sql');

function exportFunction(source: string): string {
  const match = source.match(
    /create or replace function public\.get_seasonal_export_snapshot_v2\([\s\S]*?\n\$\$;/i,
  );
  assert.ok(match, 'get_seasonal_export_snapshot_v2 definition is required');
  return match[0];
}

test('Export V2 hotfix restores the strict identity and count contract', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  const schema = readFileSync(schemaPath, 'utf8');

  for (const source of [exportFunction(migration), exportFunction(schema)]) {
    assert.match(source, /'seasonId',\s*seasons\.id/);
    assert.match(source, /'seasonCode',\s*seasons\.season_code/);
    assert.match(source, /'sourceRowCount',[\s\S]*?from public\.season_source_rows source_rows/);
    assert.match(source, /'totalCount',[\s\S]*?from public\.season_flight_records records/);
    assert.match(source, /return v_snapshot_state->'payload'/);
  }

  assert.match(
    migration,
    /revoke execute on function public\.get_seasonal_export_snapshot_v2\(text, integer\) from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_seasonal_export_snapshot_v2\(text, integer\) to authenticated/,
  );
});
