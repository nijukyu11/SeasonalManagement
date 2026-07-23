import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260723143000_guard_deleted_schedule_overlays.sql'),
  'utf8',
);

test('stale operational writes cannot replace a persisted delete overlay', () => {
  assert.match(migration, /terminal_deleted_overlay_guard_v1/);
  assert.match(migration, /v_source in \('allocation', 'checkin', 'daily', 'gate'\)/);
  assert.match(migration, /existing_modification\.season_id = v_season_id/);
  assert.match(migration, /existing_modification\.leg_id = v_op_payload->'mod'->>'legId'/);
  assert.match(migration, /existing_modification\.action = 'deleted'/);
  assert.match(migration, /raise exception 'Flight % has been deleted; refresh server data before editing allocations'/);
});

test('schedule editors retain the explicit undo path for deleted overlays', () => {
  assert.doesNotMatch(migration, /v_source in \([^)]*'seasonal'/);
  assert.doesNotMatch(migration, /v_source in \([^)]*'detailed'/);
});

test('migration patches only the reviewed mutation operation seam and is idempotent', () => {
  assert.match(migration, /pg_get_functiondef\(function_oid\)/);
  assert.match(migration, /if position\('terminal_deleted_overlay_guard_v1' in function_definition\) > 0 then/);
  assert.match(migration, /perform public\.apply_workspace_op_json\(v_season_id, v_op_payload\);/);
  assert.match(migration, /function_definition := replace\(function_definition, old_fragment, new_fragment\)/);
});
