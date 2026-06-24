import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('operator user management frontend calls the static-export-safe edge function', () => {
  const source = readFileSync(join(root, 'lib', 'operatorUserManagement.ts'), 'utf8');
  const nextConfig = readFileSync(join(root, '..', 'next.config.ts'), 'utf8');
  assert.match(nextConfig, /output:\s*["']export["']/);
  assert.match(source, /invokeSupabaseFunction<OperatorUserManagementListResponse>\('operator-user-management'/);
  assert.match(source, /invokeSupabaseFunction<OperatorUserManagementCreateResponse>\('operator-user-management'/);
  assert.doesNotMatch(source, /SERVICE_ROLE/i);
  assert.doesNotMatch(source, /auth\.admin\.createUser/);
});

test('operator user management edge function owns auth admin and assignment checks', () => {
  const source = readFileSync(join(root, '..', 'supabase', 'functions', 'operator-user-management', 'index.ts'), 'utf8');
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /auth\.admin\.createUser/);
  assert.match(source, /users\.manage permission is required/);
  assert.match(source, /roles\.manage is required to assign super_admin/);
  assert.match(source, /operator_username/);
  assert.match(source, /app_operator_roles/);
  assert.match(source, /app_operator_permission_overrides/);
});
