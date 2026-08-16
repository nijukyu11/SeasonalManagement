import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSeasonalSelectionOverPairs, resolveSeasonalPairs } from './seasonalPairing.ts';
import type { FlightLeg } from './types';

function leg(id: string, type: 'A' | 'D', overrides: Partial<FlightLeg> = {}): FlightLeg {
  return {
    id, linkId: '', type, airline: 'VN', flightNumber: `VN${id}`, rawFlightNumber: id,
    requestStatusCode: null, route: 'DAD', schedule: type === 'A' ? '22:00' : '23:00', aircraft: '321',
    category: 'PAX', flightType: 'J', codeShares: null, intDomInd: null, pax: null, gate: null,
    stand: null, counter: null, carousel: null, mct: null, fb: null, lb: null, bhs: null, ghs: null,
    date: '2026-05-10', dayOfWeek: 0, action: null, sourceRowIndex: 1, ...overrides,
  };
}

test('reciprocal links resolve first and close selection', () => {
  const arrival = leg('arr', 'A', { linkedRecordId: 'dep' });
  const departure = leg('dep', 'D', { linkedRecordId: 'arr' });
  const resolution = resolveSeasonalPairs([arrival, departure]);
  assert.equal(resolution.pairs.length, 1);
  assert.deepEqual(new Set(closeSeasonalSelectionOverPairs(['arr'], resolution)), new Set(['arr', 'dep']));
});

test('unique turnaround and anchor groups resolve without choosing ambiguous groups', () => {
  const turnaround = resolveSeasonalPairs([
    leg('a1', 'A', { turnaroundId: 't1' }), leg('d1', 'D', { turnaroundId: 't1' }),
  ]);
  assert.equal(turnaround.pairs.length, 1);
  const anchor = resolveSeasonalPairs([
    leg('a2', 'A', { linkId: 'l2', pairAnchorDate: '2026-05-10', linkType: 'sameday' }),
    leg('d2', 'D', { linkId: 'l2', pairAnchorDate: '2026-05-10', linkType: 'sameday' }),
  ]);
  assert.equal(anchor.pairs.length, 1);
  const ambiguous = resolveSeasonalPairs([
    leg('a3', 'A', { turnaroundId: 't3' }), leg('d3', 'D', { turnaroundId: 't3' }),
    leg('a4', 'A', { turnaroundId: 't3' }), leg('d4', 'D', { turnaroundId: 't3' }),
  ]);
  assert.equal(ambiguous.pairs.length, 0);
  assert.equal(ambiguous.issues.every((issue) => issue.code === 'ambiguous-pair'), true);
});

test('missing and non-reciprocal direct counterparts are explicit', () => {
  const missing = resolveSeasonalPairs([leg('a', 'A', { linkedRecordId: 'missing' })]);
  assert.equal(missing.issues[0]?.code, 'missing-counterpart');
  const nonReciprocal = resolveSeasonalPairs([
    leg('a', 'A', { linkedRecordId: 'd' }), leg('d', 'D'),
  ]);
  assert.equal(nonReciprocal.issues[0]?.code, 'non-reciprocal-link');
});
