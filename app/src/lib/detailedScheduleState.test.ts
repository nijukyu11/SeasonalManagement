import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDetailedTransferModifications,
  buildOvernightCompanionMap,
} from './detailedScheduleState.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg>): FlightLeg {
  const type = overrides.type ?? 'A';
  const flightNumber = overrides.flightNumber ?? (type === 'A' ? 'YP621' : 'YP622');
  const date = overrides.date ?? '2026-05-27';
  return {
    id: overrides.id ?? `${type}-${date}`,
    linkId: overrides.linkId ?? 'LINK-1',
    type,
    airline: overrides.airline ?? 'YP',
    flightNumber,
    rawFlightNumber: overrides.rawFlightNumber ?? flightNumber.replace(/^[A-Z]+/, ''),
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'ICN',
    schedule: overrides.schedule ?? (type === 'A' ? '20:40' : '22:45'),
    aircraft: overrides.aircraft ?? '789',
    category: overrides.category ?? 'PAX',
    flightType: overrides.flightType ?? 'PAX',
    codeShares: overrides.codeShares ?? null,
    intDomInd: overrides.intDomInd ?? 'J',
    pax: overrides.pax ?? null,
    gate: overrides.gate ?? null,
    stand: overrides.stand ?? null,
    counter: overrides.counter ?? null,
    carousel: overrides.carousel ?? null,
    mct: overrides.mct ?? null,
    fb: overrides.fb ?? null,
    lb: overrides.lb ?? null,
    bhs: overrides.bhs ?? null,
    ghs: overrides.ghs ?? null,
    date,
    scheduledDate: overrides.scheduledDate,
    scheduledTime: overrides.scheduledTime,
    operationalDate: overrides.operationalDate,
    iataSeasonCode: overrides.iataSeasonCode,
    flightSeriesId: overrides.flightSeriesId,
    dayOfWeek: overrides.dayOfWeek ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 833,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
  };
}

test('buildDetailedTransferModifications moves both linked legs from all legs even when one is visible', () => {
  const arr = leg({
    id: 'arr-wed',
    type: 'A',
    date: '2026-05-27',
    scheduledDate: '2026-05-27',
    operationalDate: '2026-05-27',
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'dep-wed',
  });
  const dep = leg({
    id: 'dep-wed',
    type: 'D',
    date: '2026-05-27',
    scheduledDate: '2026-05-27',
    operationalDate: '2026-05-27',
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'arr-wed',
  });

  const mods = buildDetailedTransferModifications({
    sourceLeg: arr,
    visibleLegs: [arr],
    allLegs: [arr, dep],
    targetDate: '2026-05-28',
    mode: 'move',
    idSeed: 'seed',
  });

  const added = mods.filter((mod) => mod.action === 'added');
  const deletedIds = mods.filter((mod) => mod.action === 'deleted').map((mod) => mod.legId).sort();

  assert.deepEqual(deletedIds, ['arr-wed', 'dep-wed']);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((mod) => mod.addedLeg?.type).sort(), ['A', 'D']);

  const addedArr = added.find((mod) => mod.addedLeg?.type === 'A')?.addedLeg;
  const addedDep = added.find((mod) => mod.addedLeg?.type === 'D')?.addedLeg;
  assert.ok(addedArr);
  assert.ok(addedDep);
  assert.equal(addedArr.date, '2026-05-28');
  assert.equal(addedDep.date, '2026-05-28');
  assert.equal(addedArr.scheduledDate, '2026-05-28');
  assert.equal(addedDep.scheduledDate, '2026-05-28');
  assert.equal(addedArr.operationalDate, '2026-05-28');
  assert.equal(addedDep.operationalDate, '2026-05-28');
  assert.equal(addedArr.dayOfWeek, 4);
  assert.equal(addedDep.dayOfWeek, 4);
  assert.equal(addedArr.linkedRecordId, addedDep.id);
  assert.equal(addedDep.linkedRecordId, addedArr.id);
  assert.equal(addedArr.pairAnchorDate, '2026-05-28');
  assert.equal(addedDep.pairAnchorDate, '2026-05-28');
  assert.equal(addedArr.linkId, addedDep.linkId);
});

test('buildDetailedTransferModifications clears stale pair fields when linked counterpart is invalid', () => {
  const arr = leg({
    id: 'arr-thu',
    type: 'A',
    date: '2026-05-28',
    scheduledDate: '2026-05-27',
    operationalDate: '2026-05-27',
    dayOfWeek: 3,
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'dep-wed',
  });
  const dep = leg({
    id: 'dep-wed',
    type: 'D',
    date: '2026-05-27',
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'arr-thu',
  });

  const mods = buildDetailedTransferModifications({
    sourceLeg: arr,
    visibleLegs: [arr],
    allLegs: [arr, dep],
    targetDate: '2026-06-04',
    mode: 'copy',
    idSeed: 'single',
  });

  assert.equal(mods.length, 1);
  const copied = mods[0].addedLeg;
  assert.ok(copied);
  assert.equal(copied.date, '2026-06-04');
  assert.equal(copied.scheduledDate, '2026-06-04');
  assert.equal(copied.operationalDate, '2026-06-04');
  assert.equal(copied.dayOfWeek, 4);
  assert.equal(copied.linkType, undefined);
  assert.equal(copied.pairAnchorDate, undefined);
  assert.equal(copied.linkedRecordId, undefined);
});

test('buildOvernightCompanionMap does not render stale same-day linked record from another date', () => {
  const arr = leg({
    id: 'arr-thu',
    type: 'A',
    date: '2026-05-28',
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'dep-wed',
  });
  const dep = leg({
    id: 'dep-wed',
    type: 'D',
    date: '2026-05-27',
    linkType: 'sameday',
    pairAnchorDate: '2026-05-27',
    linkedRecordId: 'arr-thu',
  });

  const companions = buildOvernightCompanionMap([arr], [arr, dep]);

  assert.equal(companions.size, 0);
});
