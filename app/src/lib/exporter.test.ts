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
