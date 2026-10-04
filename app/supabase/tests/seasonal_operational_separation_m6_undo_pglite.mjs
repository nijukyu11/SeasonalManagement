import assert from 'node:assert/strict';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
import {
  buildAuthoritativeDraftUndoChanges,
} from '../../src/lib/seasonalPlanningSaveManager.ts';
import {
  countersToSeasonalDraftItems,
  seasonalDraftToFlightRecord,
} from '../../src/lib/seasonalPlanningContract.ts';

const { db, asWriter } = await buildM0Fixture();
let requestSeq = 500;
const nextReqId = () => `70000000-0000-4000-8000-${String(requestSeq++).padStart(12, '0')}`;

const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const getWindow = async () => (await row(
  'select public.get_seasonal_draft_window_v1($1, 100, null, null, null) r',
  [M0_FIXTURE.seasonW26]
)).r;

const apply = async (revision, changes) => (await row(
  'select public.apply_seasonal_draft_changes_v1($1, $2::uuid, $3::bigint, $4::jsonb) r',
  [M0_FIXTURE.seasonW26, nextReqId(), revision, JSON.stringify(changes)]
)).r;

try {
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`, [M0_FIXTURE.writerId]);

  // Baseline
  const baseWindow = await getWindow();
  assert.equal(baseWindow.drafts.length, 5);
  const baseFlightRecords = baseWindow.drafts.map((d) => seasonalDraftToFlightRecord(d));

  // =========================================================================
  // SCENARIO A: Delete single draft -> rev increment -> Undo restores card
  // =========================================================================
  const targetFlight = baseFlightRecords.find((r) => r.flightNumber === 'JX801');
  assert.ok(targetFlight);

  const delReceipt = await apply(baseWindow.revision, [{
    draftId: targetFlight.id,
    expected: { status: 'active', deletion_reason: null },
    patch: { status: 'deleted', deletion_reason: 'planning_removed' },
  }]);

  assert.equal(delReceipt.status, 'committed');
  const afterDelWindow = await getWindow();
  assert.equal(afterDelWindow.drafts.length, 4, 'window hides deleted draft');
  assert.ok(!afterDelWindow.drafts.some((d) => d.draft_id === targetFlight.id));

  // Build authoritative undo changes using targetFlight in beforeRecords
  const undoDelChanges = buildAuthoritativeDraftUndoChanges(delReceipt, baseFlightRecords);
  assert.equal(undoDelChanges.length, 1);
  assert.equal(undoDelChanges[0]?.draftId, targetFlight.id);
  assert.equal(undoDelChanges[0]?.expected.status, 'deleted');
  assert.equal(undoDelChanges[0]?.expected.deletion_reason, 'planning_removed');
  assert.equal(undoDelChanges[0]?.patch.status, 'active');
  assert.equal(undoDelChanges[0]?.patch.deletion_reason, null);

  // Apply undo mutation to DB
  const undoDelReceipt = await apply(delReceipt.revision, undoDelChanges);
  assert.equal(undoDelReceipt.status, 'committed');

  const restoredWindow = await getWindow();
  assert.equal(restoredWindow.drafts.length, 5, 'restored window contains all 5 drafts');
  const restoredDraft = restoredWindow.drafts.find((d) => d.draft_id === targetFlight.id);
  assert.ok(restoredDraft);
  assert.equal(restoredDraft.status, 'active');
  assert.equal(restoredDraft.flight_number, 'JX801');

  // =========================================================================
  // SCENARIO B: Field edits (gate, stand, pax, schedule) -> Undo restores fields
  // =========================================================================
  const currentRecordsB = restoredWindow.drafts.map((d) => seasonalDraftToFlightRecord(d));
  const editTarget = currentRecordsB.find((r) => r.flightNumber === 'JX701');
  assert.ok(editTarget);

  const editReceipt = await apply(restoredWindow.revision, [{
    draftId: editTarget.id,
    expected: {
      gate: editTarget.gate,
      stand: editTarget.stand,
      pax: editTarget.pax,
      schedule: editTarget.schedule,
    },
    patch: {
      gate: 25,
      stand: '42',
      pax: 220,
      schedule: '10:45',
    },
  }]);
  assert.equal(editReceipt.status, 'committed');

  const afterEditWindow = await getWindow();
  const editedDraft = afterEditWindow.drafts.find((d) => d.draft_id === editTarget.id);
  assert.equal(editedDraft?.gate, 25);
  assert.equal(editedDraft?.stand, '42');
  assert.equal(editedDraft?.pax, 220);
  assert.equal(editedDraft?.schedule, '10:45');

  // Build undo changes
  const undoEditChanges = buildAuthoritativeDraftUndoChanges(editReceipt, currentRecordsB);
  assert.equal(undoEditChanges.length, 1);
  assert.equal(undoEditChanges[0]?.draftId, editTarget.id);
  assert.equal(undoEditChanges[0]?.patch.gate, editTarget.gate);
  assert.equal(undoEditChanges[0]?.patch.stand, editTarget.stand);
  assert.equal(undoEditChanges[0]?.patch.pax, editTarget.pax);
  assert.equal(undoEditChanges[0]?.patch.schedule, editTarget.schedule);

  const undoEditReceipt = await apply(editReceipt.revision, undoEditChanges);
  assert.equal(undoEditReceipt.status, 'committed');

  const revertedEditWindow = await getWindow();
  const revertedDraft = revertedEditWindow.drafts.find((d) => d.draft_id === editTarget.id);
  assert.equal(revertedDraft?.gate, editTarget.gate);
  assert.equal(revertedDraft?.stand, editTarget.stand);
  assert.equal(revertedDraft?.pax, editTarget.pax);
  assert.equal(revertedDraft?.schedule, editTarget.schedule);

  // =========================================================================
  // SCENARIO C: Paired turnaround delete -> trigger unlinks survivor -> Undo restores both
  // =========================================================================
  const currentRecordsC = revertedEditWindow.drafts.map((d) => seasonalDraftToFlightRecord(d));
  const d1 = currentRecordsC.find((r) => r.flightNumber === 'JX703');
  const d2 = currentRecordsC.find((r) => r.flightNumber === 'JX701');
  assert.ok(d1 && d2);

  // Pair them
  const pairReceipt = await apply(revertedEditWindow.revision, [
    {
      draftId: d1.id,
      expected: {
        type: d1.type,
        linked_draft_id: null,
        turnaround_id: d1.turnaroundId ?? null,
        link_type: d1.linkType ?? null,
        pair_anchor_date: d1.pairAnchorDate ?? null,
      },
      patch: {
        type: 'A',
        linked_draft_id: d2.id,
        turnaround_id: d1.id,
        link_type: 'sameday',
        pair_anchor_date: d1.date,
      },
    },
    {
      draftId: d2.id,
      expected: {
        type: d2.type,
        linked_draft_id: null,
        turnaround_id: d2.turnaroundId ?? null,
        link_type: d2.linkType ?? null,
        pair_anchor_date: d2.pairAnchorDate ?? null,
      },
      patch: {
        type: 'D',
        linked_draft_id: d1.id,
        turnaround_id: d1.id,
        link_type: 'sameday',
        pair_anchor_date: d1.date,
      },
    },
  ]);
  assert.equal(pairReceipt.status, 'committed');

  const pairedWindow = await getWindow();
  const pairedRecords = pairedWindow.drafts.map((d) => seasonalDraftToFlightRecord(d));

  // Now delete d1 (JX703). PostgreSQL deletes d1 AND unlinks d2 (JX701) survivor!
  const pairDelReceipt = await apply(pairReceipt.revision, [{
    draftId: d1.id,
    expected: { status: 'active', deletion_reason: null },
    patch: { status: 'deleted', deletion_reason: 'planning_removed' },
  }]);
  assert.equal(pairDelReceipt.status, 'committed');
  assert.equal(pairDelReceipt.events.length, 2, 'contains delete of d1 and unlinking of d2');

  // Verify DB state after pair delete
  const afterPairDelWindow = await getWindow();
  assert.equal(afterPairDelWindow.drafts.length, 4);
  const survivorDraft = afterPairDelWindow.drafts.find((d) => d.draft_id === d2.id);
  assert.equal(survivorDraft?.linked_draft_id, null, 'survivor was unlinked');

  // Build undo changes using pairedRecords (which had both flights linked)
  const undoPairDelChanges = buildAuthoritativeDraftUndoChanges(pairDelReceipt, pairedRecords);
  assert.equal(undoPairDelChanges.length, 2);

  // Apply undo
  const undoPairDelReceipt = await apply(pairDelReceipt.revision, undoPairDelChanges);
  assert.equal(undoPairDelReceipt.status, 'committed');

  // Verify both flights are restored and re-linked!
  const finalWindow = await getWindow();
  assert.equal(finalWindow.drafts.length, 5, 'all 5 drafts active');
  const restoredD1 = finalWindow.drafts.find((d) => d.draft_id === d1.id);
  const restoredD2 = finalWindow.drafts.find((d) => d.draft_id === d2.id);
  assert.ok(restoredD1 && restoredD2);
  assert.equal(restoredD1.status, 'active');
  assert.equal(restoredD1.linked_draft_id, d2.id);
  assert.equal(restoredD2.status, 'active');
  assert.equal(restoredD2.linked_draft_id, d1.id);

  // Consecutive edits of one draft must undo against the latest receipt,
  // restoring both scalar and relational allocation values from the first snapshot.
  const originalRecords = finalWindow.drafts.map(seasonalDraftToFlightRecord);
  const firstEdit = await apply(finalWindow.revision, [{
    draftId: d2.id,
    expected: { pax: restoredD2.pax },
    patch: { pax: 0 },
  }]);
  const secondEdit = await apply(firstEdit.revision, [{
    draftId: d2.id,
    expected: { pax: 0, counters: restoredD2.counters },
    patch: { pax: null, counters: countersToSeasonalDraftItems(['31', '32']) },
  }]);
  const changedWindow = await getWindow();
  const changedDraft = changedWindow.drafts.find((d) => d.draft_id === d2.id);
  assert.equal(changedDraft.pax, null);
  assert.deepEqual(changedDraft.counters.map((c) => c.counter_value), ['31', '32']);
  const consolidatedUndo = buildAuthoritativeDraftUndoChanges([firstEdit, secondEdit], originalRecords);
  await apply(secondEdit.revision, consolidatedUndo);
  const consolidatedWindow = await getWindow();
  const consolidatedDraft = consolidatedWindow.drafts.find((d) => d.draft_id === d2.id);
  assert.equal(consolidatedDraft.pax, restoredD2.pax);
  assert.deepEqual(consolidatedDraft.counters, restoredD2.counters);
  assert.equal(consolidatedDraft.linked_draft_id, d1.id);

  console.log('M6 undo PASS: deleted draft, field edits, reciprocal survivor pairing, consecutive NULL/0 Pax and child allocation edits.');
} finally {
  await db.close();
}
