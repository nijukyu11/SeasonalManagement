import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNoDuplicateFlightNumbersForEffectiveRecords } from './atomicSchedule.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg>): FlightLeg {
  const date = overrides.date ?? '2026-11-01';
  return {
    id: overrides.id ?? `leg-${date}`,
    linkId: overrides.linkId ?? `link-${date}`,
    type: overrides.type ?? 'D',
    airline: overrides.airline ?? 'TG',
    flightNumber: overrides.flightNumber ?? 'TG559',
    rawFlightNumber: overrides.rawFlightNumber ?? '559',
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'BKK',
    schedule: overrides.schedule ?? '10:30',
    aircraft: overrides.aircraft ?? '333',
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
    scheduledDate: overrides.scheduledDate ?? date,
    scheduledTime: overrides.scheduledTime ?? '10:30',
    operationalDate: overrides.operationalDate ?? date,
    iataSeasonCode: overrides.iataSeasonCode ?? 'W26',
    flightSeriesId: overrides.flightSeriesId,
    dayOfWeek: overrides.dayOfWeek ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? -1,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
    turnaroundId: overrides.turnaroundId,
  };
}

test('duplicate validation allows copying same flight number to an empty target date', () => {
  const source = leg({ id: 'source-tg559', date: '2026-11-01' });
  const copied = leg({ id: 'copy-tg559', date: '2026-11-02', action: 'added' });

  assert.doesNotThrow(() => {
    assertNoDuplicateFlightNumbersForEffectiveRecords(
      [source],
      new Map(),
      [copied],
      [{ legId: copied.id, action: 'added' }]
    );
  });
});

test('duplicate validation canonicalizes short and prefixed flight numbers before candidate filtering', () => {
  const existing = leg({
    id: 'existing-lj081',
    airline: 'LJ',
    flightNumber: '81',
    rawFlightNumber: '81',
  });
  const added = leg({
    id: 'added-lj081',
    airline: 'LJ',
    flightNumber: 'LJ081',
    rawFlightNumber: '081',
    action: 'added',
  });

  assert.throws(
    () => assertNoDuplicateFlightNumbersForEffectiveRecords(
      [existing],
      new Map(),
      [added],
      [{ legId: added.id, action: 'added' }],
    ),
    /Duplicate flight number LJ081 on 2026-11-01/,
  );
});

test('pre-policy duplicate flight-days in a season do not block adding an unrelated flight', () => {
  // S26 still carries duplicate flight-days imported before the F07 policy
  // (NX985 on 2026-07-16). Adding an unrelated flight must only validate the
  // added identity instead of rejecting the season as a whole.
  const legacyArrival = leg({
    id: 'legacy-nx985-arr',
    airline: 'NX',
    flightNumber: 'NX985',
    rawFlightNumber: '985',
    type: 'A',
    date: '2026-07-16',
  });
  const legacyDeparture = leg({
    id: 'legacy-nx985-dep',
    airline: 'NX',
    flightNumber: 'NX985',
    rawFlightNumber: '985',
    type: 'D',
    date: '2026-07-16',
  });
  const added = leg({
    id: 'added-jx704',
    airline: 'JX',
    flightNumber: 'JX704',
    rawFlightNumber: '704',
    date: '2026-09-25',
    action: 'added',
  });

  assert.doesNotThrow(() => {
    assertNoDuplicateFlightNumbersForEffectiveRecords([legacyArrival, legacyDeparture], new Map(), [added]);
  });

  assert.throws(
    () => assertNoDuplicateFlightNumbersForEffectiveRecords(
      [legacyArrival, legacyDeparture],
      new Map(),
      [leg({ ...added, id: 'added-nx985', airline: 'NX', flightNumber: 'NX985', rawFlightNumber: '985', date: '2026-07-16' })],
    ),
    /Duplicate flight number NX985 on 2026-07-16/,
  );

  assert.doesNotThrow(() => {
    assertNoDuplicateFlightNumbersForEffectiveRecords(
      [legacyArrival, legacyDeparture],
      new Map([[legacyArrival.id, { legId: legacyArrival.id, action: 'deleted' }], [legacyDeparture.id, { legId: legacyDeparture.id, action: 'deleted' }]]),
      [leg({ ...added, id: 'added-nx985-again', airline: 'NX', flightNumber: 'NX985', rawFlightNumber: '985', date: '2026-07-16' })],
    );
  });
});
