import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSeasonalExportSnapshotEnvelope, selectSeasonalExportLegs } from './seasonalExportSelection.ts';
import type { FlightLeg } from './types';

const arrays = {
  flightRecords: [{}], flightRecordCounters: [], flightRecordWindows: [], modifications: [],
  modificationCounters: [], modificationWindows: [], modificationAddedLegs: [],
};

test('strict snapshot parser rejects missing arrays, truncation, counts, and version drift', () => {
  const expected = { seasonId: 'S26', dataVersion: 4 };
  const valid = { seasonId: 'S26', dataVersion: 4, serverHighWater: 10, totalCount: 1, truncated: false, ...arrays };
  assert.equal(parseSeasonalExportSnapshotEnvelope(valid, expected).totalCount, 1);
  assert.throws(() => parseSeasonalExportSnapshotEnvelope({ ...valid, modifications: undefined }, expected), /missing modifications/);
  assert.throws(() => parseSeasonalExportSnapshotEnvelope({ ...valid, truncated: true }, expected), /incomplete/);
  assert.throws(() => parseSeasonalExportSnapshotEnvelope({ ...valid, totalCount: 2 }, expected), /record count/);
  assert.throws(() => parseSeasonalExportSnapshotEnvelope({ ...valid, dataVersion: 5 }, expected), /version changed/);
});

function leg(id: string, overrides: Partial<FlightLeg> = {}): FlightLeg {
  return {
    id, linkId: '', type: 'D', airline: 'VN', flightNumber: `VN${id}`, rawFlightNumber: id,
    requestStatusCode: null, route: 'DAD', schedule: '10:00', aircraft: '321', category: 'PAX',
    flightType: 'J', codeShares: null, intDomInd: null, pax: null, gate: null, stand: null,
    counter: null, carousel: null, mct: null, fb: null, lb: null, bhs: null, ghs: null,
    date: '2026-05-10', dayOfWeek: 0, action: null, sourceRowIndex: 1, ...overrides,
  };
}

test('selection is season/version scoped, nonempty, and closes reciprocal pairs', () => {
  const arrival = leg('arr', { type: 'A', linkedRecordId: 'dep' });
  const departure = leg('dep', { type: 'D', linkedRecordId: 'arr' });
  const snapshot = { seasonId: 'S26', dataVersion: 4 };
  const selected = selectSeasonalExportLegs({ seasonId: 'S26', dataVersion: 4, mode: 'ids', recordIds: ['arr'] }, snapshot, [arrival, departure]);
  assert.deepEqual(new Set(selected.map((value) => value.id)), new Set(['arr', 'dep']));
  assert.throws(() => selectSeasonalExportLegs({ seasonId: 'W26', dataVersion: 4, mode: 'ids', recordIds: ['arr'] }, snapshot, [arrival]), /another season/);
  assert.throws(() => selectSeasonalExportLegs({ seasonId: 'S26', dataVersion: 3, mode: 'ids', recordIds: ['arr'] }, snapshot, [arrival]), /stale/);
  assert.throws(() => selectSeasonalExportLegs({ seasonId: 'S26', dataVersion: 4, mode: 'ids', recordIds: ['old'] }, snapshot, [arrival]), /stale flight/);
  assert.throws(() => selectSeasonalExportLegs({ seasonId: 'S26', dataVersion: 4, mode: 'all', recordIds: [] }, snapshot, []), /no effective flights/);
});
