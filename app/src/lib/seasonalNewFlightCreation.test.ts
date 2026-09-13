import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { flattenRowsToFlightRecords } from './atomicSchedule.ts';
import { buildCanonicalAddedFlightRecords } from './detailedScheduleState.ts';
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
