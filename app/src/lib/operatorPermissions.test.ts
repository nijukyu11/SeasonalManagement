import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_PERMISSION_KEYS,
  canAssignOperatorRole,
  canGrantOperatorPermission,
  resolveOperatorPermissions,
  validateOperatorAssignment,
} from './operatorPermissions.ts';

test('role defaults resolve the approved operational permissions', () => {
  const viewer = resolveOperatorPermissions({ roles: ['viewer'] });
  assert.equal(viewer.has('dashboard.read'), true);
  assert.equal(viewer.has('seasonal.write'), false);
  assert.equal(viewer.has('users.manage'), false);

  const planner = resolveOperatorPermissions({ roles: ['schedule_planner'] });
  assert.equal(planner.has('seasonal.write'), true);
  assert.equal(planner.has('checkin.write'), false);

  const coordinator = resolveOperatorPermissions({ roles: ['resource_coordinator'] });
  assert.equal(coordinator.has('checkin.write'), true);
  assert.equal(coordinator.has('gate.write'), true);
  assert.equal(coordinator.has('daily.write'), false);
});

test('super admin resolves every known permission', () => {
  const permissions = resolveOperatorPermissions({ roles: ['super_admin'] });
  for (const permission of OPERATOR_PERMISSION_KEYS) {
    assert.equal(permissions.has(permission), true, permission);
  }
});

test('explicit deny overrides role defaults and compatibility flags', () => {
  const permissions = resolveOperatorPermissions({
    roles: ['super_admin'],
    canManageAi: true,
    overrides: {
      'ai.manage': 'deny',
      'users.manage': 'deny',
    },
  });
  assert.equal(permissions.has('ai.manage'), false);
  assert.equal(permissions.has('users.manage'), false);
  assert.equal(permissions.has('roles.manage'), true);
});

test('legacy AI fields map to AI capabilities', () => {
  assert.deepEqual(Array.from(resolveOperatorPermissions({ canUseAi: true })).sort(), ['ai.use']);
  assert.deepEqual(Array.from(resolveOperatorPermissions({ canManageAi: true })).sort(), ['ai.manage', 'ai.use']);
});

test('ops admin can create non-super users but cannot assign super admin', () => {
  const ops = resolveOperatorPermissions({ roles: ['ops_admin'] });
  assert.equal(canAssignOperatorRole(ops, 'viewer'), true);
  assert.equal(canAssignOperatorRole(ops, 'schedule_planner'), true);
  assert.equal(canAssignOperatorRole(ops, 'resource_coordinator'), true);
  assert.equal(canAssignOperatorRole(ops, 'ops_admin'), true);
  assert.equal(canAssignOperatorRole(ops, 'super_admin'), false);
});

test('only roles.manage can grant super admin or user/role management as extra permissions', () => {
  const ops = resolveOperatorPermissions({ roles: ['ops_admin'] });
  const superAdmin = resolveOperatorPermissions({ roles: ['super_admin'] });

  assert.equal(canGrantOperatorPermission(ops, 'ai.use'), true);
  assert.equal(canGrantOperatorPermission(ops, 'roles.manage'), false);
  assert.equal(canGrantOperatorPermission(ops, 'users.manage'), false);
  assert.equal(canAssignOperatorRole(superAdmin, 'super_admin'), true);
  assert.equal(canGrantOperatorPermission(superAdmin, 'roles.manage'), true);
});

test('assignment validation returns actionable denial reasons', () => {
  const ops = resolveOperatorPermissions({ roles: ['ops_admin'] });
  assert.deepEqual(validateOperatorAssignment({ actorPermissions: ops, roleId: 'viewer', extraPermissions: ['ai.use'] }), { ok: true });
  assert.deepEqual(validateOperatorAssignment({ actorPermissions: ops, roleId: 'super_admin' }), {
    ok: false,
    reason: 'super_admin requires roles.manage',
  });
  assert.deepEqual(validateOperatorAssignment({ actorPermissions: ops, roleId: 'viewer', extraPermissions: ['roles.manage'] }), {
    ok: false,
    reason: 'roles.manage requires roles.manage',
  });
});
