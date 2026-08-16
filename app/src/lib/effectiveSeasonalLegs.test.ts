import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeEffectiveSeasonalLegs } from './effectiveSeasonalLegs.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types';

function record(id: string, overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id, linkId: '', type: 'D', airline: 'VN', flightNumber: 'VN100', rawFlightNumber: '100',
    requestStatusCode: null, route: 'DAD', schedule: '10:00', aircraft: '321', category: 'PAX',
    flightType: 'J', codeShares: null, intDomInd: null, pax: null, gate: null, stand: null,
    counter: null, carousel: null, mct: null, fb: null, lb: null, bhs: null, ghs: null,
    date: '2026-05-10', dayOfWeek: 0, action: null, sourceRowIndex: 1,
    sourceKind: 'imported', sourceSide: 'DEP', status: 'active', ...overrides,
  };
}

test('base IDs win over duplicate legacy added legs and deleted records disappear', () => {
  const duplicateAdded = { ...record('base-1'), route: 'WRONG' } as unknown as FlightLeg;
  const modifications = new Map<string, FlightModification>([
    ['base-1', { legId: 'base-1', action: 'added', addedLeg: duplicateAdded }],
    ['base-2', { legId: 'base-2', action: 'deleted' }],
  ]);
  const legs = materializeEffectiveSeasonalLegs([record('base-1'), record('base-2')], modifications);
  assert.deepEqual(legs.map((leg) => leg.id), ['base-1']);
  assert.equal(legs[0].route, 'DAD');
});

test('schedule changes recompute operational metadata once', () => {
  const modifications = new Map<string, FlightModification>([
    ['base-1', { legId: 'base-1', action: 'modified', schedule: '04:00', route: 'HAN' }],
  ]);
  const [leg] = materializeEffectiveSeasonalLegs([record('base-1')], modifications);
  assert.equal(leg.schedule, '04:00');
  assert.equal(leg.scheduledTime, '04:00');
  assert.equal(leg.operationalDate, '2026-05-09');
  assert.match(leg.flightSeriesId ?? '', /HAN/);
});
