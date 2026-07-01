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

test('Settings exposes Users & Roles only behind users.manage access', () => {
  const settingsSource = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
  const tabSource = readFileSync(join(root, 'app', 'settings', 'components', 'UsersRolesTab.tsx'), 'utf8');
  assert.match(settingsSource, /getCurrentOperatorAccess/);
  assert.match(settingsSource, /canManageUsers \? \[\{ id: 'usersRoles'/);
  assert.match(settingsSource, /activeTab === 'usersRoles' && canManageUsers/);
  assert.match(tabSource, /createOperatorUser/);
  assert.match(tabSource, /listOperatorUsers/);
  assert.match(tabSource, /role\.id !== 'super_admin'/);
});
