import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { flattenRowsToFlightRecords } from './atomicSchedule.ts';
import { buildCanonicalAddedFlightRecords, draftAddedRecordsForCommit, partitionDraftDeleteTargets } from './detailedScheduleState.ts';
import { normalizeFlightRecordForServerMutation, toDeletedFlightRecordForServerMutation } from './persistenceSchema.ts';
import type { FlightLeg, FlightModification, ParsedRow } from './types.ts';

function modalRow(): ParsedRow {
  return {
    rowIndex: 42,
    effective: '2026-03-29',
    discontinue: '2026-03-29',
    airline: 'VJ',
    aircraft: '321',
    daysOfWeek: [true, true, true, true, true, true, true],
    sta: '23:15',
    arrFlight: '81',
    arrFlightType: 'PAX',
    arrRoute: 'ICN',
    arrFlightCategory: 'J',
    arrCodeShares: null,
    arrIntDomInd: null,
    std: null,
    depFlight: null,
    depFlightType: null,
    depRoute: null,
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
  };
}

function addedMod(): FlightModification {
  const leg = {
    id: 'manual-leg-1',
    linkId: 'manual-leg-1',
    type: 'A',
    airline: 'VJ',
    flightNumber: '81',
    rawFlightNumber: '81',
    route: 'ICN',
    schedule: '23:15',
    aircraft: '321',
    category: 'J',
    date: '2026-03-29',
    dayOfWeek: 0,
    action: 'added',
    sourceRowIndex: -1,
  } as FlightLeg;
  return { legId: leg.id, action: 'added', addedLeg: leg } as FlightModification;
}

// The seasonal creation site must hand client-added records to the draft/save
// path; the shared import builder alone tags them 'imported', which the
// canonical source-kind check rejects.
test('seasonal manual creation marks candidate records client-added', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/(desktop)/SeasonalSchedulePage.tsx'), 'utf8');
  const submitStart = page.indexOf('onSubmitSeasonal={async (row)');
  assert.notEqual(submitStart, -1, 'onSubmitSeasonal should exist');
  const submitEnd = page.indexOf('finishSeasonalMutation(mutation);', submitStart);
  assert.notEqual(submitEnd, -1, 'onSubmitSeasonal body should end');
  const submit = page.slice(submitStart, submitEnd);
  assert.match(submit, /flattenRowsToFlightRecords\(\[savedRow\]\)/);
  assert.match(
    submit,
    /sourceKind:\s*'added'/,
    'manually created seasonal records must be marked client-added so the send boundary persists them as canonical manual',
  );
});

test('seasonal-built records normalize to canonical manual for the server mutation', () => {
  const built = flattenRowsToFlightRecords([modalRow()]);
  assert.ok(built.length > 0, 'modal row should expand to at least one record');
  // Same marking the seasonal creation path applies before draft/save, then
  // the exact normalizer runNativeScheduleMutation applies before the RPC.
  const candidateRecords = built.map((record) => ({ ...record, sourceKind: 'added' as const }));
  for (const record of candidateRecords) {
    assert.equal(record.action, null);
    assert.equal(record.status, 'active');
    assert.equal(record.sourceSide, record.type === 'A' ? 'ARR' : 'DEP');
    assert.equal(normalizeFlightRecordForServerMutation(record).sourceKind, 'manual');
  }
});

test('detailed-built records normalize to canonical manual for the server mutation', () => {
  const records = buildCanonicalAddedFlightRecords([addedMod()]);
  assert.equal(records.length, 1);
  assert.equal(normalizeFlightRecordForServerMutation(records[0]).sourceKind, 'manual');
});

test('canonical source kinds pass server normalization through untouched', () => {
  const base = buildCanonicalAddedFlightRecords([addedMod()])[0];
  for (const sourceKind of ['seasonal', 'daily', 'manual'] as const) {
    assert.equal(normalizeFlightRecordForServerMutation({ ...base, sourceKind }).sourceKind, sourceKind);
  }
});

test('undo of a created record normalizes to a valid deleted payload', () => {
  const built = flattenRowsToFlightRecords([modalRow()]);
  assert.ok(built.length > 0, 'modal row should expand to at least one record');
  // Undo-after-create hands the current record back for deletion; the payload
  // must satisfy both the source-kind check and the deleted-lifecycle check.
  const candidateRecords = built.map((record) => ({ ...record, sourceKind: 'added' as const }));
  for (const record of candidateRecords) {
    const deleted = toDeletedFlightRecordForServerMutation(record);
    assert.equal(deleted.sourceKind, 'manual');
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.action, 'deleted');
  }
});

test('undo passes full records for deletion on seasonal and detailed pages', () => {
  for (const relativePath of [
    'src/app/(desktop)/SeasonalSchedulePage.tsx',
    'src/app/(desktop)/detailed/page.tsx',
  ]) {
    const page = readFileSync(join(process.cwd(), relativePath), 'utf8');
    assert.match(page, /undoDeletedRecords/, `${relativePath} should track full undo-delete records`);
    assert.match(
      page,
      /Array\.from\(undoDeletedRecords\.values\(\)\)/,
      `${relativePath} should send full records for undo deletes`,
    );
    assert.doesNotMatch(page, /undoDeletedIds/, `${relativePath} must not send id-only undo deletes`);
  }
});

test('a flight added and deleted inside one draft commits no record', () => {
  const draftRecord = buildCanonicalAddedFlightRecords([addedMod()])[0];
  const baseRecord = flattenRowsToFlightRecords([modalRow()])[0];
  const records = [baseRecord, draftRecord];
  const baseRecordIds = new Set([baseRecord.id]);

  assert.deepEqual(
    draftAddedRecordsForCommit(records, baseRecordIds, [{ legId: draftRecord.id, action: 'deleted' }]).map(
      (record) => record.id,
    ),
    [],
    'the record never reached the server, so a delete overlay for it must not be echoed as an insert',
  );
  assert.deepEqual(
    draftAddedRecordsForCommit(records, baseRecordIds, []).map((record) => record.id),
    [draftRecord.id],
    'a live draft-added flight still commits',
  );
  assert.deepEqual(
    draftAddedRecordsForCommit(records, baseRecordIds, [
      { legId: draftRecord.id, action: 'modified' },
      { legId: draftRecord.id, action: 'deleted' },
    ]).map((record) => record.id),
    [],
    'a delete after edits still nets out',
  );
  assert.deepEqual(
    draftAddedRecordsForCommit(records, baseRecordIds, [{ legId: baseRecord.id, action: 'deleted' }]).map(
      (record) => record.id,
    ),
    [draftRecord.id],
    'deleting a persisted leg must not drop unrelated draft additions',
  );
});

test('draft delete targets split into local removal and persisted overlays', () => {
  const baseRecordIds = new Set(['seasonal-leg-1']);
  assert.deepEqual(partitionDraftDeleteTargets(['seasonal-leg-1', 'manual-leg-1'], baseRecordIds), {
    draftAddedIds: ['manual-leg-1'],
    persistedIds: ['seasonal-leg-1'],
  });
  assert.deepEqual(partitionDraftDeleteTargets(['manual-leg-1'], baseRecordIds), {
    draftAddedIds: ['manual-leg-1'],
    persistedIds: [],
  });
});

test('seasonal delete group drops locally created flights before writing overlays', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/(desktop)/SeasonalSchedulePage.tsx'), 'utf8');
  const handlerStart = page.indexOf('const handleDeleteGroup');
  assert.notEqual(handlerStart, -1, 'handleDeleteGroup should exist');
  const handler = page.slice(handlerStart, page.indexOf('const handleUnlinkGroup', handlerStart));
  assert.match(
    handler,
    /partitionDraftDeleteTargets\(targetIds, baseRecordIds\)/,
    'handleDeleteGroup must separate draft-added legs from persisted ones',
  );
  assert.match(
    handler,
    /deletedIds:\s*draftAddedIds/,
    'draft-added legs must be removed from the workspace instead of receiving a deleted overlay',
  );
  assert.match(
    handler,
    /records:\s*baseDraft\.records\.filter/,
    'the draft must stop tracking the removed record',
  );
  assert.match(
    page,
    /draftAddedRecordsForCommit\(flightRecords, baseRecordIds, draftState\.modifications\)/,
    'commitDraftBeforeSave must not re-insert a record the draft deleted',
  );
});
