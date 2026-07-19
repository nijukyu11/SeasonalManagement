import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSeasonalExportSelection } from './seasonalExportSelection.ts';
import type { FlightLeg } from './types.ts';

function leg(overrides: Partial<FlightLeg> = {}): FlightLeg {
  const type = overrides.type ?? 'A';
  const date = overrides.date ?? '2026-03-29';
  const flightNumber = overrides.flightNumber ?? (type === 'A' ? 'LJ081' : 'LJ082');
  return {
    id: overrides.id ?? `${type}-${date}`,
    linkId: overrides.linkId ?? 'link-1',
    type,
    airline: overrides.airline ?? 'LJ',
    flightNumber,
    rawFlightNumber: overrides.rawFlightNumber ?? flightNumber.replace(/^[A-Z]+/, ''),
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'ICN',
    schedule: overrides.schedule ?? (type === 'A' ? '23:15' : '07:05'),
    aircraft: overrides.aircraft ?? '738',
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
    iataSeasonCode: overrides.iataSeasonCode ?? 'S26',
    flightSeriesId: overrides.flightSeriesId ?? `${type}|LJ|${flightNumber}|ICN`,
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

function select(input: {
  seasonId?: string;
  dataVersion?: number;
  mode?: 'ids' | 'all';
  recordIds?: string[];
  snapshotSeasonId?: string;
  snapshotDataVersion?: number;
  legs?: FlightLeg[];
}) {
  return validateSeasonalExportSelection({
    selection: {
      seasonId: input.seasonId ?? 'season-s26',
      dataVersion: input.dataVersion ?? 4,
      mode: input.mode ?? 'ids',
      recordIds: input.recordIds ?? [],
    },
    snapshotSeasonId: input.snapshotSeasonId ?? 'season-s26',
    snapshotDataVersion: input.snapshotDataVersion ?? 4,
    effectiveLegs: input.legs ?? [],
  });
}

test('rejects stale S26 selection against a W26 snapshot', () => {
  const result = select({
    seasonId: 'season-s26',
    snapshotSeasonId: 'season-w26',
    recordIds: ['s26-leg'],
    legs: [leg({ id: 'w26-leg' })],
  });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, 'season-mismatch');
});

test('rejects data-version mismatch, empty ID selection, and every unknown ID', () => {
  assert.equal(select({ dataVersion: 3, snapshotDataVersion: 4 }).issues[0]?.code, 'version-mismatch');
  assert.equal(select({ recordIds: [], legs: [leg({ id: 'known' })] }).issues[0]?.code, 'zero-selection');

  const unknown = select({ recordIds: ['known', 'missing'], legs: [leg({ id: 'known' })] });
  assert.equal(unknown.valid, false);
  assert.deepEqual(unknown.issues.filter((issue) => issue.code === 'unknown-record-id').map((issue) => issue.recordId), ['missing']);
});

test('all mode selects the complete effective snapshot in deterministic order', () => {
  const result = select({
    mode: 'all',
    recordIds: ['ignored-mounted-row'],
    legs: [
      leg({ id: 'later', date: '2026-03-30', schedule: '09:00' }),
      leg({ id: 'earlier', date: '2026-03-29', schedule: '08:00' }),
    ],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.legs.map((entry) => entry.id), ['earlier', 'later']);
});

test('selecting one paired leg closes over its counterpart', () => {
  const arrival = leg({
    id: 'arr',
    type: 'A',
    linkedRecordId: 'dep',
    linkType: 'sameday',
    pairAnchorDate: '2026-03-29',
  });
  const departure = leg({
    id: 'dep',
    type: 'D',
    linkedRecordId: 'arr',
    linkType: 'sameday',
    pairAnchorDate: '2026-03-29',
  });

  const result = select({ recordIds: ['arr'], legs: [departure, arrival] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.legs.map((entry) => entry.id), ['arr', 'dep']);
});

test('rejects ambiguous pairing for a selected leg', () => {
  const legs = [
    leg({ id: 'arr-1', type: 'A', turnaroundId: 'ambiguous' }),
    leg({ id: 'arr-2', type: 'A', turnaroundId: 'ambiguous' }),
    leg({ id: 'dep-1', type: 'D', turnaroundId: 'ambiguous' }),
    leg({ id: 'dep-2', type: 'D', turnaroundId: 'ambiguous' }),
  ];

  const result = select({ recordIds: ['arr-1'], legs });

  assert.equal(result.valid, false);
  assert.equal(result.issues.some((issue) => issue.code === 'ambiguous-pair' && issue.recordId === 'arr-1'), true);
});

test('rejects a final effective set with zero legs in all mode', () => {
  const result = select({ mode: 'all', legs: [] });

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, 'zero-selection');
});
