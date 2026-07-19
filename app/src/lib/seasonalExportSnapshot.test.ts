import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSeasonalExportSnapshotRows } from './seasonalExportSnapshot.ts';

function record(recordId = 'record-1') {
  return {
    season_id: 'season-s26',
    record_id: recordId,
    link_id: recordId,
    type: 'A',
    airline: 'LJ',
    flight_number: 'LJ081',
    raw_flight_number: '81',
    request_status_code: null,
    route: 'ICN',
    schedule: '23:15',
    aircraft: '738',
    category: 'J',
    code_shares: null,
    int_dom_ind: 'I',
    pax: null,
    gate: null,
    stand: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-03-29',
    scheduled_date: '2026-03-29',
    scheduled_time: '23:15',
    operational_date: '2026-03-29',
    iata_season_code: 'S26',
    flight_series_id: 'S26|LJ|LJ081|A|ICN',
    day_of_week: 0,
    action: null,
    source_row_index: 1,
    linked_source_row_index: null,
    link_type: null,
    pair_anchor_date: null,
    linked_record_id: null,
    source_kind: 'imported',
    source_side: 'ARR',
    status: 'active',
    turnaround_id: null,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    seasonId: 'season-s26',
    dataVersion: 7,
    totalCount: 1,
    serverHighWater: 12,
    truncated: false,
    flightRecords: [record()],
    flightRecordCounters: [],
    flightRecordWindows: [],
    modifications: [],
    modificationCounters: [],
    modificationWindows: [],
    modificationAddedLegs: [],
    ...overrides,
  };
}

function modification(overrides: Record<string, unknown> = {}) {
  return {
    season_id: 'season-s26',
    leg_id: 'record-1',
    action: 'modified',
    changed_fields: ['gate'],
    schedule: null,
    aircraft: null,
    route: null,
    code_shares: null,
    pax: null,
    gate: 4,
    stand: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    check_in_start: null,
    check_in_end: null,
    check_in_allocation_mode: null,
    ...overrides,
  };
}

test('accepts one complete exact export snapshot', () => {
  const parsed = parseSeasonalExportSnapshotRows(payload(), {
    seasonId: 'season-s26',
    dataVersion: 7,
  });

  assert.equal(parsed.flightRecords.length, 1);
  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.truncated, false);
});

test('rejects every missing relation array and truncated snapshots', () => {
  const arrayNames = [
    'flightRecords',
    'flightRecordCounters',
    'flightRecordWindows',
    'modifications',
    'modificationCounters',
    'modificationWindows',
    'modificationAddedLegs',
  ];
  for (const name of arrayNames) {
    const missing = payload();
    Reflect.deleteProperty(missing, name);
    assert.throws(
      () => parseSeasonalExportSnapshotRows(missing, { seasonId: 'season-s26', dataVersion: 7 }),
      new RegExp(`${name}.*array`, 'i'),
    );
  }

  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ truncated: true }), { seasonId: 'season-s26', dataVersion: 7 }),
    /truncated.*false/i,
  );
});

test('rejects malformed counts, entries, count mismatch, season mismatch, and version mismatch', () => {
  for (const [field, value] of [
    ['dataVersion', Number.NaN],
    ['totalCount', -1],
    ['serverHighWater', 1.5],
  ] as const) {
    assert.throws(
      () => parseSeasonalExportSnapshotRows(payload({ [field]: value }), { seasonId: 'season-s26', dataVersion: 7 }),
      new RegExp(field, 'i'),
    );
  }

  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ totalCount: 2 }), { seasonId: 'season-s26', dataVersion: 7 }),
    /totalCount.*flightRecords/i,
  );
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ seasonId: 'season-w26' }), { seasonId: 'season-s26', dataVersion: 7 }),
    /season.*mismatch/i,
  );
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ dataVersion: 8 }), { seasonId: 'season-s26', dataVersion: 7 }),
    /version.*mismatch/i,
  );
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ flightRecords: [{ ...record(), record_id: 42 }] }), { seasonId: 'season-s26', dataVersion: 7 }),
    /flightRecords\[0\].*record_id/i,
  );
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({ modifications: [modification({ changed_fields: ['gate', 42] })] }), { seasonId: 'season-s26', dataVersion: 7 }),
    /modifications\[0\].*changed_fields/i,
  );
});
