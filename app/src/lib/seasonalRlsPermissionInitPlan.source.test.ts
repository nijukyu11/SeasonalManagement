import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260720213000_optimize_seasonal_rls_permission_initplans.sql'),
  'utf8',
);
const schema = readFileSync(join(process.cwd(), 'supabase/schema.sql'), 'utf8');

function assertPermissionInitPlans(sql: string): void {
  assert.match(sql, /seasonal baseline read/);
  assert.match(sql, /seasonal overlay read/);
  assert.match(sql, /permissioned operational overlay writes/);
  assert.match(sql, /using \(\(select public\.app_operator_has_permission\(''seasonal\.read''\)\)\)/);
  assert.match(sql, /select public\.app_operator_has_permission\(''seasonal\.write''\)/);
  assert.match(sql, /select public\.app_operator_has_permission\(''detailed\.write''\)/);
  assert.match(sql, /select public\.app_operator_has_permission\(''daily\.write''\)/);
  assert.match(sql, /select public\.app_operator_has_permission\(''checkin\.write''\)/);
  assert.match(sql, /select public\.app_operator_has_permission\(''gate\.write''\)/);
  assert.match(sql, /using \(\(select public\.is_app_operator\(\)\)\)/);
  assert.match(sql, /with check \(\(select public\.is_app_operator\(\)\)\)/);
}

test('seasonal RLS permission checks use statement-level InitPlans', () => {
  assertPermissionInitPlans(migration);
  assertPermissionInitPlans(schema);
});
