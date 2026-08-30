import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeCanonicalFlightRecordIds,
  materializeEffectiveSeasonalLegs,
} from './effectiveSeasonalLegs.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types.ts';

function record(overrides: Partial<FlightRecord> = {}): FlightRecord {
  const date = overrides.date ?? '2026-03-29';
  const type = overrides.type ?? 'A';
  const flightNumber = overrides.flightNumber ?? 'VN336';
  return {
    id: overrides.id ?? 'base-1',
    linkId: overrides.linkId ?? 'link-1',
    type,
    airline: overrides.airline ?? 'VN',
    flightNumber,
    rawFlightNumber: overrides.rawFlightNumber ?? flightNumber.replace(/^[A-Z]+/, ''),
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'KIX',
    schedule: overrides.schedule ?? '06:00',
    aircraft: overrides.aircraft ?? '321',
    category: overrides.category ?? 'J',
    flightType: overrides.flightType ?? 'PAX',
    codeShares: overrides.codeShares ?? null,
    intDomInd: overrides.intDomInd ?? 'I',
    pax: overrides.pax ?? null,
    gate: overrides.gate ?? null,
    stand: overrides.stand ?? null,
    counter: overrides.counter ?? null,
    checkInStart: overrides.checkInStart,
    checkInEnd: overrides.checkInEnd,
    checkInAllocationMode: overrides.checkInAllocationMode,
    checkInCounterWindows: overrides.checkInCounterWindows,
    carousel: overrides.carousel ?? null,
    mct: overrides.mct ?? null,
    fb: overrides.fb ?? null,
    lb: overrides.lb ?? null,
    bhs: overrides.bhs ?? null,
    ghs: overrides.ghs ?? null,
    date,
    scheduledDate: overrides.scheduledDate ?? date,
    scheduledTime: overrides.scheduledTime ?? overrides.schedule ?? '06:00',
    operationalDate: overrides.operationalDate ?? date,
    iataSeasonCode: overrides.iataSeasonCode ?? 'S26',
    flightSeriesId: overrides.flightSeriesId ?? 'SER_A_VN_VN336_KIX',
    dayOfWeek: overrides.dayOfWeek ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    turnaroundId: overrides.turnaroundId,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
    sourceKind: overrides.sourceKind ?? 'imported',
    sourceSide: overrides.sourceSide ?? (type === 'A' ? 'ARR' : 'DEP'),
    status: overrides.status ?? 'active',
  };
}

function addedLeg(overrides: Partial<FlightLeg>): FlightLeg {
  const source = record({
    ...overrides,
    sourceKind: 'added',
    sourceSide: overrides.type === 'D' ? 'DEP' : 'ARR',
  });
  Reflect.deleteProperty(source, 'sourceKind');
  Reflect.deleteProperty(source, 'sourceSide');
  Reflect.deleteProperty(source, 'status');
  return { ...source, action: 'added' };
}

test('materializer deduplicates IDs, prefers base records, recomputes metadata, and filters deletions', () => {
  const base = record();
  const deleted = record({ id: 'deleted-1', flightNumber: 'VN337', rawFlightNumber: '337' });
  const modifications = new Map<string, FlightModification>([
    [base.id, {
      legId: base.id,
      action: 'modified',
      schedule: '04:00',
      route: 'ICN',
      checkInStart: '01:00',
    }],
    [deleted.id, { legId: deleted.id, action: 'deleted' }],
    ['legacy-duplicate', {
      legId: 'legacy-duplicate',
      action: 'added',
      addedLeg: addedLeg({
        id: base.id,
        flightNumber: 'VN999',
        rawFlightNumber: '999',
      }),
    }],
    ['added-1', {
      legId: 'added-1',
      action: 'added',
      addedLeg: addedLeg({
        id: 'added-1',
        flightNumber: 'VN338',
        rawFlightNumber: '338',
        schedule: '03:30',
        scheduledTime: 'stale',
        operationalDate: 'stale',
      }),
    }],
  ]);

  const result = materializeEffectiveSeasonalLegs([base, deleted], modifications);

  assert.deepEqual(result.map((leg) => leg.id).sort(), ['added-1', 'base-1']);
  assert.equal(result.filter((leg) => leg.id === base.id).length, 1);
  const effectiveBase = result.find((leg) => leg.id === base.id);
  assert.ok(effectiveBase);
  assert.equal(effectiveBase.flightNumber, 'VN336');
  assert.equal(effectiveBase.schedule, '04:00');
  assert.equal(effectiveBase.scheduledTime, '04:00');
  assert.equal(effectiveBase.scheduledDate, '2026-03-29');
  assert.equal(effectiveBase.operationalDate, '2026-03-28');
  assert.equal(effectiveBase.iataSeasonCode, 'W25');
  assert.equal(effectiveBase.flightSeriesId, 'SER_A_VN_VN336_ICN');
  assert.equal(effectiveBase.dayOfWeek, 0);
  assert.equal(effectiveBase.checkInStart, '01:00');

  const effectiveAdded = result.find((leg) => leg.id === 'added-1');
  assert.ok(effectiveAdded);
  assert.equal(effectiveAdded.scheduledTime, '03:30');
  assert.equal(effectiveAdded.operationalDate, '2026-03-28');
});

test('materializer keeps one terminal state for each atomic record id', () => {
  const earlier = record({ id: 'atomic-1', route: 'KIX', action: null });
  const latest = record({ id: 'atomic-1', route: 'ICN', action: 'modified' });
  const deleted = record({ id: 'atomic-2', flightNumber: 'VN337', action: 'deleted', status: 'deleted' });
  const staleActiveCopy = record({ id: 'atomic-2', flightNumber: 'VN337', route: 'HAN' });

  const result = materializeEffectiveSeasonalLegs(
    [earlier, latest, deleted, staleActiveCopy],
    new Map([
      ['atomic-2', { legId: 'atomic-2', action: 'modified', route: 'SGN' }],
    ]),
  );

  assert.deepEqual(result.map((leg) => leg.id), ['atomic-1']);
  assert.equal(result[0].route, 'ICN');
});

test('historical deleted occurrence and canonical manual overlay do not duplicate export or Detailed render state', () => {
  const historical = record({ id: 'old-flight', status: 'deleted', action: 'deleted' });
  const active = record({ id: 'active-flight', sourceKind: 'daily', gate: 2 });
  const manual = record({
    id: 'manual-flight',
    flightNumber: 'VN338',
    rawFlightNumber: '338',
    sourceKind: 'manual',
    action: 'added',
  });
  const modifications = new Map<string, FlightModification>([
    ['old-flight', { legId: 'old-flight', action: 'modified', gate: 99 }],
    ['active-flight', { legId: 'active-flight', action: 'modified', gate: 3 }],
    ['manual-flight', { legId: 'manual-flight', action: 'added', addedLeg: addedLeg({
      id: 'manual-flight',
      flightNumber: 'VN338',
      rawFlightNumber: '338',
    }) }],
  ]);

  const result = materializeEffectiveSeasonalLegs([historical, active, manual], modifications);

  assert.deepEqual(result.map((leg) => leg.id).sort(), ['active-flight', 'manual-flight']);
  assert.equal(result.filter((leg) => leg.id === 'manual-flight').length, 1);
  assert.equal(result.find((leg) => leg.id === 'active-flight')?.gate, 3);
});

test('Detailed Save eligibility excludes deleted and stale-action base records', () => {
  const ids = activeCanonicalFlightRecordIds([
    record({ id: 'active' }),
    record({ id: 'deleted-status', status: 'deleted', action: 'deleted' }),
    record({ id: 'deleted-action', status: 'active', action: 'deleted' }),
  ]);

  assert.deepEqual([...ids], ['active']);
});
