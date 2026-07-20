import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260720090000_workspace_window_keyset_v2.sql'),
  'utf8',
);
const schema = readFileSync(join(process.cwd(), 'supabase/schema.sql'), 'utf8');
const sqlTest = readFileSync(join(process.cwd(), 'supabase/tests/workspace_window_keyset_v2.sql'), 'utf8');

function assertV2Contract(sql: string): void {
  const functionDefinition = sql.match(
    /create or replace function public\.get_season_schedule_allocation_window_v2\([\s\S]*?\n\$\$;/i,
  )?.[0];
  assert.ok(functionDefinition, 'workspace window V2 function definition must exist');
  assert.match(sql, /get_season_schedule_allocation_window_v2\([\s\S]*p_page_size integer default 500/);
  assert.match(sql, /p_expected_data_version integer default null[\s\S]*p_expected_server_high_water bigint default null/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /p_page_size < 1 or p_page_size > 1000/);
  assert.match(sql, /num_nonnulls\(p_after_effective_date, p_after_root_id, p_after_root_kind\) not in \(0, 3\)/);
  assert.ok(
    (functionDefinition.match(/cursor_index_range_v2/g) ?? []).length === 2,
    'both indexed root branches must start from the two-column cursor range',
  );
  assert.ok(
    (functionDefinition.match(/>= \(p_after_effective_date, p_after_root_id\)/g) ?? []).length === 2,
    'both indexed root branches must apply the indexable date/id range',
  );
  assert.match(sql, /limit p_page_size \+ 1/);
  assert.doesNotMatch(sql, /\boffset\b/i);
  assert.match(sql, /'status', 'snapshot_changed'[\s\S]*'dataVersion'[\s\S]*'serverHighWater'/);
  assert.match(sql, /season_flight_records_workspace_keyset_idx/);
  assert.match(sql, /season_modification_added_legs_workspace_keyset_idx/);
  assert.doesNotMatch(functionDefinition, /\bfor\s+share\b/i);
  assert.match(functionDefinition, /bounded_root_candidates_v2/);
  assert.match(
    functionDefinition,
    /from public\.season_flight_records r[\s\S]*?limit p_page_size \+ 1[\s\S]*?union all[\s\S]*?from public\.season_modification_added_legs a[\s\S]*?limit p_page_size \+ 1/,
  );
  assert.match(
    functionDefinition,
    /join selected_base_ids ids on ids\.root_id = r\.record_id\s+where r\.season_id = p_season_id/,
  );
  assert.ok(
    (functionDefinition.match(/limit p_page_size \+ 1/g) ?? []).length >= 3,
    'both indexed branches and the bounded merge must apply the page sentinel limit',
  );
}

test('workspace window V2 migration and canonical schema use bounded keyset pages', () => {
  assertV2Contract(migration);
  assertV2Contract(schema);
});

test('workspace window V2 permissions exclude public and anon', () => {
  for (const sql of [migration, schema]) {
    assert.match(sql, /revoke execute on function public\.get_season_schedule_allocation_window_v2[\s\S]*from public/);
    assert.match(sql, /revoke execute on function public\.get_season_schedule_allocation_window_v2[\s\S]*from anon/);
    assert.match(sql, /grant execute on function public\.get_season_schedule_allocation_window_v2[\s\S]*to authenticated/);
  }
});

test('SQL integration coverage exercises page continuity, snapshot fencing, date bounds, and invalid cursors', () => {
  assert.match(sqlTest, /cardinality\(root_ids\) <> 4/);
  assert.match(sqlTest, /snapshot_changed response must not include row arrays/);
  assert.match(sqlTest, /V2 date window returned unexpected roots/);
  assert.match(sqlTest, /partial V2 cursor should have failed/);
  assert.match(sqlTest, /anon must not execute workspace window V2/);
  assert.match(sqlTest, /rollback;/);
});
