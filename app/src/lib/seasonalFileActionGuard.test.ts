import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSeasonalAvailableRecordIds,
  createSeasonalFileActionController,
  getSeasonalFileActionBlock,
  reconcileSeasonalSelection,
} from './seasonalFileActionGuard.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('import and export are blocked while another seasonal operation is busy', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: false,
    busy: true,
  })?.code, 'busy');
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: true,
    selectedCount: 1,
  })?.code, 'busy');
});

test('import and export are blocked while a Seasonal draft exists', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: true,
    busy: false,
  })?.code, 'draft');
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: true,
    busy: false,
    selectedCount: 1,
  })?.code, 'draft');
});

test('export requires a selection while import does not', () => {
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: false,
    selectedCount: 0,
  })?.code, 'no-selection');
  assert.equal(getSeasonalFileActionBlock({
    action: 'import',
    hasDraftChanges: false,
    busy: false,
  }), null);
});

test('selection reconciliation reports matched and unknown ids', () => {
  assert.deepEqual(
    reconcileSeasonalSelection(['W26-current', 'S26-old'], new Set(['W26-current'])),
    {
      matchedIds: ['W26-current'],
      unknownIds: ['S26-old'],
    },
  );
});

test('a stale-only selection is blocked as stale instead of a valid empty export', () => {
  const selection = reconcileSeasonalSelection(['S26-old'], new Set(['W26-current']));

  assert.deepEqual(selection, {
    matchedIds: [],
    unknownIds: ['S26-old'],
  });
  assert.equal(getSeasonalFileActionBlock({
    action: 'export',
    hasDraftChanges: false,
    busy: false,
    selectedCount: selection.matchedIds.length,
    staleSelectionCount: selection.unknownIds.length,
  })?.code, 'stale-selection');
});

test('file actions and seasonal mutations hold an exclusive controller lock', () => {
  const controller = createSeasonalFileActionController();
  const mutation = controller.beginMutation();

  assert.ok(mutation);
  assert.equal(controller.beginFileAction('import', { seasonId: 'S26', draftRevision: 0 }), null);
  controller.finishMutation(mutation);

  const fileAction = controller.beginFileAction('export', { seasonId: 'S26', draftRevision: 0 });
  assert.ok(fileAction);
  assert.equal(controller.beginMutation(), null);
  assert.equal(controller.isFileActionActive(), true);

  controller.finishFileAction(fileAction);
  assert.equal(controller.isFileActionActive(), false);
});

test('a draft created while import awaits invalidates the original operation token', async () => {
  const controller = createSeasonalFileActionController();
  const operation = controller.beginFileAction('import', { seasonId: 'S26', draftRevision: 4 });
  const gate = deferred();
  assert.ok(operation);

  const validation = (async () => {
    await gate.promise;
    return controller.validateFileAction(operation, {
      seasonId: 'S26',
      draftRevision: 5,
      hasDraftChanges: true,
    });
  })();

  gate.resolve();
  assert.equal((await validation)?.code, 'draft-changed');
  assert.equal(controller.validateFileAction(operation, {
    seasonId: 'S26',
    draftRevision: 6,
    hasDraftChanges: false,
  })?.code, 'draft-changed');
});

test('season changes and replaced operation tokens fail revalidation', () => {
  const controller = createSeasonalFileActionController();
  const first = controller.beginFileAction('export', { seasonId: 'S26', draftRevision: 2 });
  assert.ok(first);

  assert.equal(controller.validateFileAction(first, {
    seasonId: 'W26',
    draftRevision: 2,
    hasDraftChanges: false,
  })?.code, 'season-changed');

  controller.finishFileAction(first);
  const second = controller.beginFileAction('export', { seasonId: 'S26', draftRevision: 2 });
  assert.ok(second);
  controller.finishFileAction(first);
  assert.equal(controller.isFileActionActive(), true);
  assert.equal(controller.validateFileAction(first, {
    seasonId: 'S26',
    draftRevision: 2,
    hasDraftChanges: false,
  })?.code, 'operation-replaced');
  controller.finishFileAction(second);
});

test('effective availability keeps valid added modifications selectable', () => {
  const records = [{ id: 'BASE', status: 'active', action: null }] as FlightRecord[];
  const addedLeg = { id: 'ADDED', action: 'added' } as FlightLeg;
  const modifications = new Map<string, FlightModification>([
    ['BASE', { legId: 'BASE', action: 'modified' }],
    ['ADDED', { legId: 'ADDED', action: 'added', addedLeg }],
  ]);

  assert.deepEqual(
    Array.from(buildSeasonalAvailableRecordIds(records, modifications)).sort(),
    ['ADDED', 'BASE'],
  );
});

test('effective availability excludes deleted base and added legs', () => {
  const records = [
    { id: 'DELETED_BY_MOD', status: 'active', action: null },
    { id: 'DELETED_RECORD', status: 'deleted', action: null },
  ] as FlightRecord[];
  const modifications = new Map<string, FlightModification>([
    ['DELETED_BY_MOD', { legId: 'DELETED_BY_MOD', action: 'deleted' }],
    ['INVALID_ADDED', {
      legId: 'INVALID_ADDED',
      action: 'added',
      addedLeg: { id: 'INVALID_ADDED', action: 'deleted' } as FlightLeg,
    }],
    ['MISSING_ADDED_LEG', { legId: 'MISSING_ADDED_LEG', action: 'added' }],
  ]);

  assert.deepEqual(Array.from(buildSeasonalAvailableRecordIds(records, modifications)), []);
});
