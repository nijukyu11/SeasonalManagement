import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupFlightLegs,
  validateFlightLegsForSeasonalExport,
} from './exporter.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg>): FlightLeg {
  const type = overrides.type ?? 'A';
  const flightNumber = overrides.flightNumber ?? (type === 'A' ? 'YP621' : 'YP622');
  const date = overrides.date ?? '2026-05-28';
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

test('validateFlightLegsForSeasonalExport reports stale linked date metadata before export', () => {
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

  const result = validateFlightLegsForSeasonalExport([arr, dep]);

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => issue.code === 'date-metadata-mismatch' && issue.legId === 'arr-thu'), true);
  assert.equal(result.issues.some((issue) => issue.code === 'invalid-linked-pair' && issue.legId === 'arr-thu'), true);
});

test('validateFlightLegsForSeasonalExport rejects incomplete pairing metadata', () => {
  const incomplete = leg({
    id: 'arr-incomplete',
    type: 'A',
    linkType: 'sameday',
  });

  const result = validateFlightLegsForSeasonalExport([incomplete]);

  assert.equal(result.valid, false);
  assert.equal(
    result.issues.some((issue) => issue.code === 'invalid-linked-pair' && issue.legId === incomplete.id),
    true,
  );
});

test('groupFlightLegs exports repaired YP pattern as two combined rows', () => {
  const legs: FlightLeg[] = [];
  const addPair = (date: string, sourceRowIndex: number) => {
    const arrId = `arr-${date}`;
    const depId = `dep-${date}`;
    const linkId = `link-${date}`;
    legs.push(leg({
      id: arrId,
      linkId,
      type: 'A',
      date,
      scheduledDate: date,
      operationalDate: date,
      dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(),
      sourceRowIndex,
      linkedSourceRowIndex: sourceRowIndex,
      linkType: 'sameday',
      pairAnchorDate: date,
      linkedRecordId: depId,
    }));
    legs.push(leg({
      id: depId,
      linkId,
      type: 'D',
      date,
      scheduledDate: date,
      operationalDate: date,
      dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(),
      sourceRowIndex,
      linkedSourceRowIndex: sourceRowIndex,
      linkType: 'sameday',
      pairAnchorDate: date,
      linkedRecordId: arrId,
    }));
  };

  ['2026-05-17', '2026-05-20', '2026-05-21', '2026-05-23', '2026-05-24'].forEach((date) => addPair(date, 42));
  ['2026-05-28', '2026-05-31', '2026-06-04', '2026-06-07'].forEach((date) => addPair(date, 833));

  const validation = validateFlightLegsForSeasonalExport(legs);
  const groups = groupFlightLegs(legs).filter((group) => group.airline === 'YP');

  assert.equal(validation.valid, true);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.daysOfWeek), [
    [false, false, true, true, false, true, true],
    [false, false, false, true, false, false, true],
  ]);
  assert.deepEqual(groups.map((group) => [group.arrFlightNumber, group.depFlightNumber]), [
    ['621', '622'],
    ['621', '622'],
  ]);
});

test('groupFlightLegs combines a unique legacy turnaround with distinct link IDs', () => {
  const arrival = leg({
    id: 'legacy-group-arr',
    type: 'A',
    linkId: 'legacy-arr-link',
    turnaroundId: 'legacy-group-turn',
  });
  const departure = leg({
    id: 'legacy-group-dep',
    type: 'D',
    linkId: 'legacy-dep-link',
    turnaroundId: 'legacy-group-turn',
  });

  const groups = groupFlightLegs([arrival, departure]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].arrFlightNumber, arrival.rawFlightNumber);
  assert.equal(groups[0].depFlightNumber, departure.rawFlightNumber);
});

test('pair issues fail validation and block grouping', () => {
  const ambiguous = [
    leg({ id: 'amb-arr-1', type: 'A', turnaroundId: 'ambiguous-export' }),
    leg({ id: 'amb-arr-2', type: 'A', turnaroundId: 'ambiguous-export' }),
    leg({ id: 'amb-dep-1', type: 'D', turnaroundId: 'ambiguous-export' }),
    leg({ id: 'amb-dep-2', type: 'D', turnaroundId: 'ambiguous-export' }),
  ];

  const validation = validateFlightLegsForSeasonalExport(ambiguous);

  assert.equal(validation.valid, false);
  assert.throws(() => groupFlightLegs(ambiguous), /ambiguous turnaround/i);
});

test('invalid runtime leg type fails export validation and grouping', () => {
  const invalid = leg({ id: 'invalid-export-type', type: 'X' as FlightLeg['type'] });

  const validation = validateFlightLegsForSeasonalExport([invalid]);

  assert.equal(validation.valid, false);
  assert.throws(() => groupFlightLegs([invalid]), /invalid flight type/i);
});

test('grouping after a merge keeps preserved and incoming pairs once while excluding deleted legs', () => {
  const records: FlightLeg[] = [];
  const addPair = (prefix: string, date: string, sourceRowIndex: number) => {
    const arrivalId = `${prefix}-arr`;
    const departureId = `${prefix}-dep`;
    records.push(leg({
      id: arrivalId,
      linkId: `${prefix}-turn`,
      type: 'A',
      date,
      sourceRowIndex,
      turnaroundId: `${prefix}-turn`,
      linkType: 'sameday',
      pairAnchorDate: date,
      linkedRecordId: departureId,
    }));
    records.push(leg({
      id: departureId,
      linkId: `${prefix}-turn`,
      type: 'D',
      date,
      sourceRowIndex,
      turnaroundId: `${prefix}-turn`,
      linkType: 'sameday',
      pairAnchorDate: date,
      linkedRecordId: arrivalId,
    }));
  };
  addPair('preserved', '2026-06-06', 41);
  addPair('incoming', '2026-06-07', 42);
  records.push(leg({
    id: 'deleted-overlay',
    type: 'A',
    date: '2026-06-08',
    sourceRowIndex: 43,
    action: 'deleted',
  }));

  const validation = validateFlightLegsForSeasonalExport(records);
  const groups = groupFlightLegs(records);

  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].effective, '2026-06-06');
  assert.equal(groups[0].discontinue, '2026-06-07');
});
