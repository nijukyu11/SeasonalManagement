import assert from 'node:assert/strict';
import test from 'node:test';

import { materializeEffectiveSeasonalLegs } from './effectiveSeasonalLegs.ts';
import { validateSeasonalExportSelection } from './seasonalExportSelection.ts';
import {
  materializeSeasonalExportSnapshot,
  parseSeasonalExportSnapshotRows,
} from './seasonalExportSnapshot.ts';
import { loadTargetedCommittedImportRefresh } from './seasonalImportRecovery.ts';
import type { RemoteSeasonalImportResult } from './remoteStore.ts';
import {
  fromModificationRows,
  type ModificationAddedLegRelationalRow,
  type ModificationRelationalRow,
} from './supabaseRelationalMappers.ts';
import type { Season } from './types.ts';

function record(recordId = 'record-1', overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    seasonId: 'season-s26',
    seasonCode: 'S26',
    dataVersion: 7,
    totalCount: 1,
    sourceRowCount: 1,
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
  assert.equal(parsed.seasonCode, 'S26');
  assert.equal(parsed.sourceRowCount, 1);
  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.truncated, false);
});

test('stand overlays accept canonical text and legacy integer values', () => {
  for (const stand of ['20A', '20', 20, null]) {
    const parsed = parseSeasonalExportSnapshotRows(payload({ modifications: [modification({ stand, changed_fields: ['stand'] })] }), { seasonId: 'season-s26', dataVersion: 7 });
    assert.equal(parsed.modifications[0].stand, stand);
  }
  assert.throws(() => parseSeasonalExportSnapshotRows(payload({ modifications: [modification({ stand: {} })] }), { seasonId: 'season-s26', dataVersion: 7 }), /stand/);
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

test('rejects malformed metadata, entries, physical count mismatch, season mismatch, and version mismatch', () => {
  for (const [field, value] of [
    ['dataVersion', Number.NaN],
    ['totalCount', -1],
    ['sourceRowCount', -1],
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
    () => parseSeasonalExportSnapshotRows(payload({ seasonCode: '' }), { seasonId: 'season-s26', dataVersion: 7 }),
    /seasonCode.*non-empty/i,
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

  for (const field of ['seasonCode', 'sourceRowCount']) {
    const missing = payload();
    Reflect.deleteProperty(missing, field);
    assert.throws(
      () => parseSeasonalExportSnapshotRows(missing, { seasonId: 'season-s26', dataVersion: 7 }),
      new RegExp(field, 'i'),
    );
  }
});

test('accepts preserved physical added records without changing imported row semantics', () => {
  const parsed = parseSeasonalExportSnapshotRows(payload({
    totalCount: 2,
    flightRecords: [
      record('imported-record'),
      record('legacy-added-record', { source_kind: 'added', action: 'added', status: 'active' }),
    ],
  }), { seasonId: 'season-s26', dataVersion: 7 });

  assert.equal(parsed.flightRecords.length, 2);
  assert.deepEqual(parsed.flightRecords.map((entry) => entry.source_kind), ['imported', 'added']);
});

test('strict materializer and committed refresh cache imported plus preserved physical rows', async () => {
  const snapshot = materializeSeasonalExportSnapshot(payload({
    totalCount: 2,
    flightRecords: [
      record('imported-deleted', { action: 'deleted', status: 'deleted' }),
      record('preserved-added', { source_kind: 'added', action: 'added', status: 'active' }),
    ],
  }), { seasonId: 'season-s26', expectedDataVersion: 7 });
  const committed = {
    batchId: '10000000-0000-4000-8000-000000000001',
    seasonId: 'season-s26',
    seasonCode: 'S26',
    status: 'committed',
    sourceRowCount: 1,
    flightRecordCount: 1,
    preservedOperationalCount: 1,
    removedImportedCount: 0,
    dataVersion: 7,
    serverHighWater: 12,
    checksum: 'cross-layer',
  } satisfies RemoteSeasonalImportResult;
  const season = {
    id: committed.seasonId,
    seasonCode: committed.seasonCode,
    name: 'Summer 2026',
    fileName: 'S26.xlsx',
    uploadedAt: 0,
    effectiveStart: '2026-03-29',
    effectiveEnd: '2026-10-24',
    totalLegs: 1,
    totalSourceRows: 1,
    dataVersion: 7,
  } satisfies Season;

  const refreshed = await loadTargetedCommittedImportRefresh({
    committedImport: committed,
    loadSeasons: async () => [season],
    loadSnapshot: async () => snapshot,
  });

  assert.deepEqual(refreshed.window.records.map((entry) => entry.id), [
    'imported-deleted',
    'preserved-added',
  ]);
  assert.deepEqual(refreshed.window.records.map((entry) => entry.sourceKind), [
    'imported',
    'added',
  ]);
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

test('post-merge export preserves omitted baseline, excludes deleted overlay, and closes subsets over pairs', () => {
  const pairedRecord = (
    recordId: string,
    counterpartId: string,
    type: 'A' | 'D',
    date: string,
    sourceRowIndex: number,
  ) => record(recordId, {
    link_id: `turn-${sourceRowIndex}`,
    type,
    flight_number: type === 'A' ? `KE${sourceRowIndex}1` : `KE${sourceRowIndex}2`,
    raw_flight_number: type === 'A' ? `${sourceRowIndex}1` : `${sourceRowIndex}2`,
    schedule: type === 'A' ? '08:30' : '10:00',
    date,
    scheduled_date: date,
    scheduled_time: type === 'A' ? '08:30' : '10:00',
    operational_date: date,
    day_of_week: new Date(`${date}T00:00:00Z`).getUTCDay(),
    source_row_index: sourceRowIndex,
    source_side: type === 'A' ? 'ARR' : 'DEP',
    turnaround_id: `turn-${sourceRowIndex}`,
    link_type: 'sameday',
    pair_anchor_date: date,
    linked_record_id: counterpartId,
  });
  const rows = [
    pairedRecord('preserved-arr', 'preserved-dep', 'A', '2026-06-06', 41),
    pairedRecord('preserved-dep', 'preserved-arr', 'D', '2026-06-06', 41),
    pairedRecord('incoming-arr', 'incoming-dep', 'A', '2026-06-07', 42),
    pairedRecord('incoming-dep', 'incoming-arr', 'D', '2026-06-07', 42),
    record('deleted-overlay', {
      flight_number: 'KE999',
      raw_flight_number: '999',
      date: '2026-06-08',
      scheduled_date: '2026-06-08',
      operational_date: '2026-06-08',
      day_of_week: 1,
      source_row_index: 43,
    }),
  ];
  const snapshot = materializeSeasonalExportSnapshot(payload({
    totalCount: rows.length,
    sourceRowCount: 0,
    flightRecords: rows,
    modifications: [
      modification({
        leg_id: 'deleted-overlay',
        action: 'deleted',
        changed_fields: [],
        gate: null,
      }),
    ],
  }), { seasonId: 'season-s26', expectedDataVersion: 7 });
  const effectiveLegs = materializeEffectiveSeasonalLegs(snapshot.records, snapshot.modifications);

  const all = validateSeasonalExportSelection({
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
  const subset = validateSeasonalExportSelection({
    selection: {
      seasonId: snapshot.seasonId,
      dataVersion: snapshot.dataVersion,
      mode: 'ids',
      recordIds: ['incoming-arr'],
    },
    snapshotSeasonId: snapshot.seasonId,
    snapshotDataVersion: snapshot.dataVersion,
    effectiveLegs,
  });

  assert.equal(snapshot.sourceRowCount, 0);
  assert.equal(all.valid, true, JSON.stringify(all.issues));
  assert.equal(new Set(all.recordIds).size, 4);
  assert.deepEqual(new Set(all.recordIds), new Set([
    'preserved-arr',
    'preserved-dep',
    'incoming-arr',
    'incoming-dep',
  ]));
  assert.equal(all.recordIds.includes('deleted-overlay'), false);
  assert.equal(subset.valid, true, JSON.stringify(subset.issues));
  assert.deepEqual(new Set(subset.recordIds), new Set(['incoming-arr', 'incoming-dep']));

});
