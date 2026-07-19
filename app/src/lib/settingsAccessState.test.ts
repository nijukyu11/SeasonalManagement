import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSettingsProtectedTab } from './settingsAccessState.ts';

test('persisted Season Repair tab waits for access resolution', () => {
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'seasonRepair',
    accessLoading: true,
    canRepairSeason: false,
    canManageUsers: false,
  }), 'seasonRepair');
});

test('authorized repair operator remains on tab and unauthorized operator redirects after resolution', () => {
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'seasonRepair',
    accessLoading: false,
    canRepairSeason: true,
    canManageUsers: false,
  }), 'seasonRepair');
  assert.equal(resolveSettingsProtectedTab({
    activeTab: 'seasonRepair',
    accessLoading: false,
    canRepairSeason: false,
    canManageUsers: false,
  }), 'checkinCounters');
});
