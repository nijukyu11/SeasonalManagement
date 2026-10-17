import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSettingsProtectedTab } from './settingsAccessState.ts';

test('persisted usersRoles tab waits for access resolution', () => {
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'usersRoles',
    accessLoading: true,
    canManageUsers: false,
  }), 'usersRoles');
});

test('authorized users manager remains on tab and unauthorized operator redirects after resolution', () => {
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'usersRoles',
    accessLoading: false,
    canManageUsers: true,
  }), 'usersRoles');
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'usersRoles',
    accessLoading: false,
    canManageUsers: false,
  }), 'checkinCounters');
});

test('obsolete or unknown tab resolves to checkinCounters regardless of loading state', () => {
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'seasonRepair',
    accessLoading: true,
    canManageUsers: true,
  }), 'checkinCounters');
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'seasonRepair',
    accessLoading: false,
    canManageUsers: true,
  }), 'checkinCounters');
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'aiAnalysis',
    accessLoading: true,
    canManageUsers: true,
  }), 'checkinCounters');
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'invalidTabName',
    accessLoading: false,
    canManageUsers: true,
  }), 'checkinCounters');
});
