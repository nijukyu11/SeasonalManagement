import assert from 'node:assert/strict';
import test from 'node:test';

import { getSeasonalRepairImportBlock } from './seasonalRepairGuard.ts';

const baseInput = {
  targetSeasonId: 'season-w26',
  targetSeasonCode: 'W26',
  activeSeasonId: 'season-w26',
  hasDraftChanges: false,
  pendingCount: 0,
  conflictCount: 0,
  busy: false,
};

test('repair import uses the shared Seasonal draft Save/Discard block', () => {
  const block = getSeasonalRepairImportBlock({ ...baseInput, hasDraftChanges: true });
  assert.equal(block?.code, 'draft');
  assert.match(block?.message ?? '', /Save or discard the Seasonal draft before import/);
});

test('repair import blocks active and cross-route target pending state', () => {
  const active = getSeasonalRepairImportBlock({ ...baseInput, pendingCount: 2 });
  assert.equal(active?.code, 'pending');
  assert.match(active?.message ?? '', /current season has 2 unsynced local changes/);
  assert.match(active?.message ?? '', /Save or discard/i);

  const target = getSeasonalRepairImportBlock({
    ...baseInput,
    activeSeasonId: 'season-s26',
    pendingCount: 1,
  });
  assert.equal(target?.code, 'pending');
  assert.match(target?.message ?? '', /season W26 has 1 unsynced local change/);
});

test('repair import permits a clean target and blocks concurrent file actions', () => {
  assert.equal(getSeasonalRepairImportBlock(baseInput), null);
  assert.equal(getSeasonalRepairImportBlock({ ...baseInput, busy: true })?.code, 'busy');
});
