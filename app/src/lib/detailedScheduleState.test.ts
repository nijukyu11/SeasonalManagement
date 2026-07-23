import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  buildCanonicalAddedFlightRecords,
  buildDetailedTransferPairContext,
  buildDetailedTransferModifications,
  buildOvernightCompanionMap,
  compactDraftModifications,
} from './detailedScheduleState.ts';
import type { FlightLeg, FlightModification } from './types.ts';

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
    turnaroundId: overrides.turnaroundId,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
  };
}

test('compactDraftModifications keeps delete terminal over stale operational edits', () => {
  const mods: FlightModification[] = [
    { legId: 'Z2827-2027-01-04', action: 'modified', counter: [43, 44, 45] },
    { legId: 'Z2827-2027-01-04', action: 'deleted' },
    { legId: 'Z2827-2027-01-04', action: 'modified', counter: null },
    { legId: 'Z26827-2027-01-04', action: 'deleted' },
    { legId: 'outside-draft', action: 'deleted' },
  ];

  const compacted = compactDraftModifications(
    mods,
    new Set(['Z2827-2027-01-04', 'Z26827-2027-01-04']),
  );

  assert.deepEqual(compacted, [
    { legId: 'Z2827-2027-01-04', action: 'deleted' },
    { legId: 'Z26827-2027-01-04', action: 'deleted' },
  ]);
});

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
    turnaroundId: 'TRN_SOURCE',
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
    turnaroundId: 'TRN_SOURCE',
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
  assert.equal(addedArr.turnaroundId, addedArr.linkId);
  assert.equal(addedDep.turnaroundId, addedArr.turnaroundId);
  assert.notEqual(addedArr.turnaroundId, arr.turnaroundId);

  const canonical = buildCanonicalAddedFlightRecords(added);
  assert.equal(canonical.length, 2);
});

test('buildDetailedTransferModifications keeps a truly unpaired copy free of pair fields', () => {
  const arr = leg({
    id: 'arr-thu',
    type: 'A',
    date: '2026-05-28',
    scheduledDate: '2026-05-27',
    operationalDate: '2026-05-27',
    dayOfWeek: 3,
  });

  const mods = buildDetailedTransferModifications({
    sourceLeg: arr,
    visibleLegs: [arr],
    allLegs: [arr],
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
  assert.equal(Object.hasOwn(copied, 'turnaroundId'), false);

  const canonical = buildCanonicalAddedFlightRecords(mods);
  assert.equal(canonical.length, 1);
  assert.equal(Object.hasOwn(canonical[0], 'turnaroundId'), false);
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

for (const mode of ['copy', 'move'] as const) {
  const verb = mode === 'copy' ? 'copies' : 'moves';
  test(`buildDetailedTransferModifications ${verb} a legacy turnaround pair with distinct link IDs`, () => {
    const arr = leg({
      id: `legacy-arr-${mode}`,
      linkId: `legacy-arr-link-${mode}`,
      type: 'A',
      turnaroundId: `legacy-turn-${mode}`,
    });
    const dep = leg({
      id: `legacy-dep-${mode}`,
      linkId: `legacy-dep-link-${mode}`,
      type: 'D',
      turnaroundId: `legacy-turn-${mode}`,
    });

    const modifications = buildDetailedTransferModifications({
      sourceLeg: arr,
      visibleLegs: [arr],
      allLegs: [arr, dep],
      targetDate: '2026-05-28',
      mode,
      idSeed: `legacy-${mode}`,
    });

    assert.equal(modifications.filter((entry) => entry.action === 'added').length, 2);
    assert.deepEqual(
      modifications.filter((entry) => entry.action === 'deleted').map((entry) => entry.legId).sort(),
      mode === 'move' ? [arr.id, dep.id].sort() : [],
    );
  });
}

test('buildDetailedTransferModifications surfaces a pair issue instead of moving one orphan leg', () => {
  const orphan = leg({
    id: 'orphan-arr',
    type: 'A',
    turnaroundId: 'missing-turnaround',
  });

  assert.throws(
    () => buildDetailedTransferModifications({
      sourceLeg: orphan,
      visibleLegs: [orphan],
      allLegs: [orphan],
      targetDate: '2026-05-28',
      mode: 'move',
      idSeed: 'orphan',
    }),
    /Cannot move paired flight.*no unique active counterpart/i,
  );
});

test('buildDetailedTransferModifications rejects a pair context from another allLegs snapshot', () => {
  const arr = leg({ id: 'snapshot-arr', type: 'A', linkedRecordId: 'snapshot-dep' });
  const dep = leg({ id: 'snapshot-dep', type: 'D', linkedRecordId: 'snapshot-arr' });
  const originalSnapshot = [arr, dep];
  const currentSnapshot = [...originalSnapshot];
  const pairContext = buildDetailedTransferPairContext(originalSnapshot);

  assert.throws(
    () => buildDetailedTransferModifications({
      sourceLeg: arr,
      visibleLegs: currentSnapshot,
      allLegs: currentSnapshot,
      targetDate: '2026-05-28',
      mode: 'copy',
      idSeed: 'stale-context',
      pairContext,
    }),
    /current allLegs snapshot/i,
  );
});

test('buildDetailedTransferModifications preserves pair issues from a precomputed context', () => {
  const orphan = leg({ id: 'context-orphan', type: 'A', turnaroundId: 'context-missing-turnaround' });
  const allLegs = [orphan];
  const pairContext = buildDetailedTransferPairContext(allLegs);

  assert.throws(
    () => buildDetailedTransferModifications({
      sourceLeg: orphan,
      visibleLegs: allLegs,
      allLegs,
      targetDate: '2026-05-28',
      mode: 'copy',
      idSeed: 'context-orphan',
      pairContext,
    }),
    /Cannot copy paired flight.*no unique active counterpart/i,
  );
});

test('one immutable transfer context handles 57k legs across 365 dates without rescanning allLegs', { timeout: 30_000 }, (t) => {
  const allLegs: FlightLeg[] = [];
  const pairCount = 28_500;
  for (let index = 0; index < pairCount; index += 1) {
    const arrId = `context-arr-${index}`;
    const depId = `context-dep-${index}`;
    const linkId = `context-link-${index}`;
    allLegs.push(
      leg({ id: arrId, linkId, type: 'A', linkedRecordId: depId, sourceRowIndex: index }),
      leg({ id: depId, linkId, type: 'D', linkedRecordId: arrId, sourceRowIndex: index }),
    );
  }

  const startedAt = performance.now();
  const pairContext = buildDetailedTransferPairContext(allLegs);
  const contextElapsedMs = performance.now() - startedAt;
  assert.equal(Object.isFrozen(pairContext), true);
  assert.equal(pairContext.legsById.size, 57_000);

  Object.defineProperties(allLegs, {
    some: {
      configurable: true,
      value: () => { throw new Error('allLegs.some must not run with a transfer pair context'); },
    },
    [Symbol.iterator]: {
      configurable: true,
      value: () => { throw new Error('allLegs must not be iterated with a transfer pair context'); },
    },
  });

  const transferStartedAt = performance.now();
  let addedCount = 0;
  try {
    for (let day = 0; day < 365; day += 1) {
      const targetDate = new Date(Date.UTC(2027, 0, day + 1)).toISOString().slice(0, 10);
      const modifications = buildDetailedTransferModifications({
        sourceLeg: allLegs[0],
        visibleLegs: [],
        allLegs,
        targetDate,
        mode: 'copy',
        idSeed: `context-${day}`,
        pairContext,
      });
      addedCount += modifications.filter((entry) => entry.action === 'added').length;
    }
  } finally {
    Reflect.deleteProperty(allLegs, 'some');
    Reflect.deleteProperty(allLegs, Symbol.iterator);
  }
  const transferElapsedMs = performance.now() - transferStartedAt;
  const totalElapsedMs = performance.now() - startedAt;

  assert.equal(addedCount, 730);
  assert.ok(totalElapsedMs < 15_000, `expected bounded 57k/365 transfer work, took ${totalElapsedMs.toFixed(1)}ms`);
  t.diagnostic(`57k context ${contextElapsedMs.toFixed(1)}ms; 365 transfers ${transferElapsedMs.toFixed(1)}ms`);
});

test('buildOvernightCompanionMap resolves a legacy turnaround pair with distinct link IDs', () => {
  const arr = leg({ id: 'legacy-arr', linkId: 'legacy-arr-link', type: 'A', turnaroundId: 'legacy-turn' });
  const dep = leg({ id: 'legacy-dep', linkId: 'legacy-dep-link', type: 'D', turnaroundId: 'legacy-turn' });

  const companions = buildOvernightCompanionMap([arr], [arr, dep]);

  assert.equal(companions.get(`${arr.date}_${arr.id}`)?.flightNumber, dep.flightNumber);
});

test('buildOvernightCompanionMap remains linear for a large resolved set', () => {
  const primaryLegs: FlightLeg[] = [];
  const allLegs: FlightLeg[] = [];
  const pairCount = 4_000;
  for (let index = 0; index < pairCount; index += 1) {
    const arrId = `perf-arr-${index}`;
    const depId = `perf-dep-${index}`;
    const linkId = `perf-link-${index}`;
    const arr = leg({ id: arrId, linkId, type: 'A', linkedRecordId: depId, sourceRowIndex: index });
    const dep = leg({ id: depId, linkId, type: 'D', linkedRecordId: arrId, sourceRowIndex: index });
    primaryLegs.push(arr);
    allLegs.push(arr, dep);
  }

  const startedAt = performance.now();
  const companions = buildOvernightCompanionMap(primaryLegs, allLegs);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(companions.size, pairCount);
  assert.ok(elapsedMs < 1_500, `expected linear companion lookup, took ${elapsedMs.toFixed(1)}ms`);
});
