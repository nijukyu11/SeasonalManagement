import assert from 'node:assert/strict';
import test from 'node:test';

import { closeSeasonalSelectionOverPairs, resolveSeasonalPairs } from './seasonalPairing.ts';
import { findValidLinkedCounterpart, isValidLinkedFlightPair } from './flightPairIntegrity.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg>): FlightLeg {
  const type = overrides.type ?? 'A';
  const date = overrides.date ?? '2026-10-25';
  const flightNumber = overrides.flightNumber ?? (type === 'A' ? 'VN336' : 'VN337');
  return {
    id: overrides.id ?? `${type}-${date}`,
    linkId: overrides.linkId ?? 'link-1',
    type,
    airline: overrides.airline ?? 'VN',
    flightNumber,
    rawFlightNumber: overrides.rawFlightNumber ?? flightNumber.replace(/^[A-Z]+/, ''),
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'KIX',
    schedule: overrides.schedule ?? (type === 'A' ? '23:15' : '07:05'),
    aircraft: overrides.aircraft ?? '321',
    category: overrides.category ?? 'J',
    flightType: overrides.flightType ?? 'PAX',
    codeShares: overrides.codeShares ?? null,
    intDomInd: overrides.intDomInd ?? 'I',
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
    scheduledTime: overrides.scheduledTime ?? overrides.schedule ?? (type === 'A' ? '23:15' : '07:05'),
    operationalDate: overrides.operationalDate ?? date,
    iataSeasonCode: overrides.iataSeasonCode ?? 'W26',
    flightSeriesId: overrides.flightSeriesId ?? `SER_${type}_VN_${flightNumber}_KIX`,
    dayOfWeek: overrides.dayOfWeek ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    turnaroundId: overrides.turnaroundId,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
  };
}

test('pair resolver prioritizes reciprocal linked record IDs', () => {
  const arrival = leg({
    id: 'arr-direct',
    type: 'A',
    linkedRecordId: 'dep-direct',
    turnaroundId: 'shared-with-extra',
    linkType: 'sameday',
    pairAnchorDate: '2026-10-25',
  });
  const departure = leg({
    id: 'dep-direct',
    type: 'D',
    linkedRecordId: 'arr-direct',
    turnaroundId: 'shared-with-extra',
    linkType: 'sameday',
    pairAnchorDate: '2026-10-25',
  });
  const extra = leg({ id: 'arr-extra', type: 'A', turnaroundId: 'shared-with-extra' });

  const result = resolveSeasonalPairs([arrival, departure, extra]);

  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].arrival.id, arrival.id);
  assert.equal(result.pairs[0].departure.id, departure.id);
  assert.equal(result.byLegId.get(arrival.id), departure.id);
  assert.deepEqual(result.unpaired.map((candidate) => candidate.id), [extra.id]);
  assert.equal(result.issues.some((issue) => issue.legId === extra.id && issue.code === 'missing-counterpart'), true);
});

test('pair resolver uses unique turnaround and anchor fallbacks', () => {
  const turnaroundArrival = leg({
    id: 'arr-turn',
    type: 'A',
    turnaroundId: 'turn-1',
    linkId: 'legacy-arr-link',
  });
  const turnaroundDeparture = leg({
    id: 'dep-turn',
    type: 'D',
    turnaroundId: 'turn-1',
    linkId: 'legacy-dep-link',
  });
  const anchorArrival = leg({
    id: 'arr-anchor',
    type: 'A',
    linkId: 'anchor-link',
    pairAnchorDate: '2026-10-25',
    linkType: 'overnight',
  });
  const anchorDeparture = leg({
    id: 'dep-anchor',
    type: 'D',
    date: '2026-10-26',
    linkId: 'anchor-link',
    pairAnchorDate: '2026-10-25',
    linkType: 'overnight',
  });

  const result = resolveSeasonalPairs([
    turnaroundArrival,
    turnaroundDeparture,
    anchorArrival,
    anchorDeparture,
  ]);

  assert.equal(result.pairs.length, 2);
  assert.equal(result.issues.length, 0);
  assert.equal(result.byLegId.get(turnaroundArrival.id), turnaroundDeparture.id);
  assert.equal(result.byLegId.get(anchorArrival.id), anchorDeparture.id);
});

test('pair resolver reports missing, non-reciprocal, and ambiguous groups without arbitrary matches', () => {
  const missing = leg({ id: 'arr-missing', linkedRecordId: 'not-present' });
  const nonReciprocalArrival = leg({ id: 'arr-nonreciprocal', type: 'A', linkedRecordId: 'dep-nonreciprocal' });
  const nonReciprocalDeparture = leg({ id: 'dep-nonreciprocal', type: 'D' });
  const ambiguous = [
    leg({ id: 'arr-1', type: 'A', turnaroundId: 'turn-ambiguous' }),
    leg({ id: 'arr-2', type: 'A', turnaroundId: 'turn-ambiguous' }),
    leg({ id: 'dep-1', type: 'D', turnaroundId: 'turn-ambiguous' }),
    leg({ id: 'dep-2', type: 'D', turnaroundId: 'turn-ambiguous' }),
  ];

  const result = resolveSeasonalPairs([
    missing,
    nonReciprocalArrival,
    nonReciprocalDeparture,
    ...ambiguous,
  ]);

  assert.equal(result.pairs.length, 0);
  assert.equal(result.issues.some((issue) => issue.code === 'missing-counterpart' && issue.legId === missing.id), true);
  assert.equal(result.issues.some((issue) => issue.code === 'non-reciprocal-link' && issue.legId === nonReciprocalArrival.id), true);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === 'ambiguous-pair').map((issue) => issue.legId).sort(),
    ambiguous.map((candidate) => candidate.id).sort(),
  );
  assert.equal(result.unpaired.length, 7);
});

test('selection closure automatically includes the selected overnight counterpart', () => {
  const arrival = leg({
    id: 'arr-overnight',
    type: 'A',
    linkId: 'overnight-link',
    pairAnchorDate: '2026-10-25',
    linkType: 'overnight',
  });
  const departure = leg({
    id: 'dep-overnight',
    type: 'D',
    date: '2026-10-26',
    linkId: 'overnight-link',
    pairAnchorDate: '2026-10-25',
    linkType: 'overnight',
  });
  const resolution = resolveSeasonalPairs([arrival, departure]);

  assert.deepEqual(
    closeSeasonalSelectionOverPairs([departure.id], resolution),
    [departure.id, arrival.id],
  );
});

test('pair resolver rejects duplicate IDs without self-pairing', () => {
  const duplicateArrival = leg({ id: 'duplicate-id', type: 'A', linkedRecordId: 'duplicate-id' });
  const duplicateDeparture = leg({ id: 'duplicate-id', type: 'D', linkedRecordId: 'duplicate-id' });

  const result = resolveSeasonalPairs([duplicateArrival, duplicateDeparture]);

  assert.equal(result.pairs.length, 0);
  assert.equal(result.byLegId.has('duplicate-id'), false);
  assert.equal(result.unpaired.length, 2);
  assert.equal(
    result.issues.some((issue) => issue.legId === 'duplicate-id' && issue.code === 'ambiguous-pair'),
    true,
  );
});

test('pair resolver rejects invalid runtime leg types explicitly', () => {
  const invalid = leg({
    id: 'invalid-type',
    type: 'X' as FlightLeg['type'],
    linkedRecordId: 'valid-arrival',
  });
  const arrival = leg({ id: 'valid-arrival', type: 'A', linkedRecordId: invalid.id });

  const result = resolveSeasonalPairs([invalid, arrival]);

  assert.equal(result.pairs.length, 0);
  assert.equal(result.unpaired.length, 2);
  assert.equal(
    result.issues.some((issue) => issue.legId === invalid.id && issue.code === 'ambiguous-pair'),
    true,
  );
});

test('legacy compatibility helpers delegate to turnaround resolution', () => {
  const arrival = leg({ id: 'adapter-arr', type: 'A', linkId: 'legacy-arr', turnaroundId: 'adapter-turn' });
  const departure = leg({ id: 'adapter-dep', type: 'D', linkId: 'legacy-dep', turnaroundId: 'adapter-turn' });

  assert.equal(isValidLinkedFlightPair(arrival, departure), true);
  assert.equal(findValidLinkedCounterpart(arrival, [arrival, departure])?.id, departure.id);
});
