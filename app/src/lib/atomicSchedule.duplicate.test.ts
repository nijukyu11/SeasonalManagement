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
