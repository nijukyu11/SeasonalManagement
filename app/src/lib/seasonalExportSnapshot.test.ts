import assert from 'node:assert/strict';
import test from 'node:test';

import { materializeEffectiveSeasonalLegs } from './effectiveSeasonalLegs.ts';
import { validateSeasonalExportSelection } from './seasonalExportSelection.ts';
import { parseSeasonalExportSnapshotRows } from './seasonalExportSnapshot.ts';
import {
  fromModificationRows,
  type ModificationAddedLegRelationalRow,
  type ModificationRelationalRow,
} from './supabaseRelationalMappers.ts';

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

function addedModification(legId = 'added-record', changedFields: unknown[] = ['addedLeg']) {
  return modification({
    leg_id: legId,
    action: 'added',
    changed_fields: changedFields,
    gate: null,
  });
}

function addedLeg(legId = 'added-record', overrides: Record<string, unknown> = {}) {
  return {
    ...record(legId),
    leg_id: legId,
    action: 'added',
    source_row_index: 0,
    source_kind: 'added',
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

test('rejects an added modification without an added-leg child', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*exactly one.*added-leg/i,
  );
});

test("rejects an added modification whose changed_fields omit 'addedLeg'", () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification('added-record', [])],
      modificationAddedLegs: [addedLeg()],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*changed_fields.*addedLeg/i,
  );
});

test('rejects orphan, duplicate, and non-added-parent added-leg children', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [],
      modificationAddedLegs: [addedLeg('orphan-record')],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /modificationAddedLegs\[0\].*snapshot owner/i,
  );

  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg(), addedLeg()],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /modificationAddedLegs\[1\].*duplicates added-record/i,
  );

  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [modification({ leg_id: 'modified-record' })],
      modificationAddedLegs: [addedLeg('modified-record')],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /modificationAddedLegs\[0\].*added modification/i,
  );
});

test('rejects an added-leg child whose record identity differs from its parent', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg('added-record', { record_id: 'cross-wired-record' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*record_id.*parent leg_id/i,
  );
});

test('rejects an added modification whose identity collides with a base record', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      flightRecords: [record('added-record')],
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg()],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*must not reference.*base flight record/i,
  );
});

test('rejects an inactive added-leg child', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg('added-record', { status: 'deleted' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*status.*active/i,
  );
});

test('rejects a wrong-action added-leg child', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg('added-record', { action: 'modified' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*action.*added/i,
  );
});

test('rejects an added-leg child with non-manual source_kind', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg('added-record', { source_kind: 'imported' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*source_kind.*added/i,
  );
});

test('rejects an added-leg child with source_side inconsistent with its type', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [addedModification()],
      modificationAddedLegs: [addedLeg('added-record', { source_side: 'DEP' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /added-record.*source_side.*ARR/i,
  );
});

test('rejects an orphan modified modification', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [modification({ leg_id: 'orphan-modified' })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /orphan-modified.*modified.*base flight record/i,
  );
});

test('rejects an orphan deleted modification', () => {
  assert.throws(
    () => parseSeasonalExportSnapshotRows(payload({
      modifications: [modification({
        leg_id: 'orphan-deleted',
        action: 'deleted',
        changed_fields: [],
      })],
    }), { seasonId: 'season-s26', dataVersion: 7 }),
    /orphan-deleted.*deleted.*base flight record/i,
  );
});

test('accepts modified and deleted modifications owned by base flight records', () => {
  const snapshot = parseSeasonalExportSnapshotRows(payload({
    totalCount: 2,
    flightRecords: [record('modified-record'), record('deleted-record')],
    modifications: [
      modification({ leg_id: 'modified-record' }),
      modification({ leg_id: 'deleted-record', action: 'deleted', changed_fields: [] }),
    ],
  }), { seasonId: 'season-s26', dataVersion: 7 });

  assert.deepEqual(snapshot.modifications.map((entry) => entry.leg_id), [
    'modified-record',
    'deleted-record',
  ]);
});

test("mode='all' materializes a valid added modification from its marked child", () => {
  const snapshot = parseSeasonalExportSnapshotRows(payload({
    totalCount: 0,
    flightRecords: [],
    modifications: [addedModification()],
    modificationAddedLegs: [addedLeg()],
  }), { seasonId: 'season-s26', dataVersion: 7 });
  const modificationRow = snapshot.modifications[0] as unknown as ModificationRelationalRow;
  const addedLegRow = snapshot.modificationAddedLegs[0] as unknown as ModificationAddedLegRelationalRow;
  const modifications = new Map([
    [modificationRow.leg_id, fromModificationRows(modificationRow, [], [], addedLegRow)],
  ]);
  const effectiveLegs = materializeEffectiveSeasonalLegs([], modifications);
  const selection = validateSeasonalExportSelection({
    selection: {
      seasonId: snapshot.seasonId,
      dataVersion: snapshot.dataVersion,
      mode: 'all',
      recordIds: [],
    },
    snapshotSeasonId: snapshot.seasonId,
    snapshotDataVersion: snapshot.dataVersion,
    effectiveLegs,
  });

  assert.equal(modifications.get('added-record')?.addedLeg?.id, 'added-record');
  assert.deepEqual(effectiveLegs.map((leg) => leg.id), ['added-record']);
  assert.equal(selection.valid, true);
  assert.deepEqual(selection.recordIds, ['added-record']);
});
