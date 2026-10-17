import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countersToSeasonalDraftItems,
  seasonalDraftItemsToCounter,
  windowsToSeasonalDraftItems,
  seasonalDraftItemsToWindows,
  seasonalDraftToFlightRecord,
  flightRecordToSeasonalDraftChange,
  isSeasonalPlanningV1Enabled,
  type SeasonalDraftRecord,
} from './seasonalPlanningContract.ts';
import type { FlightRecord } from './types.ts';

const SAMPLE_FLIGHT_RECORD: FlightRecord = {
  id: 'REC_TEST_001',
  linkId: 'TRN_PAIR_01',
  type: 'A',
  airline: 'JX',
  flightNumber: '701',
  rawFlightNumber: 'JX701',
  requestStatusCode: null,
  route: 'TPE',
  schedule: '10:00',
  aircraft: '321',
  category: 'J',
  flightType: 'PAX',
  codeShares: null,
  intDomInd: 'I',
  pax: 180,
  gate: 12,
  stand: '31',
  counter: { T1: ['21', '22'] },
  checkInCounterWindows: { '21': { start: '07:00', end: '09:30' } },
  carousel: 4,
  mct: null,
  fb: null,
  lb: null,
  bhs: null,
  ghs: null,
  date: '2026-10-25',
  scheduledDate: '2026-10-25',
  scheduledTime: '10:00',
  operationalDate: '2026-10-25',
  dayOfWeek: 7,
  action: null,
  sourceRowIndex: 1,
  linkedRecordId: 'REC_TEST_002',
  sourceKind: 'imported',
  sourceSide: 'ARR',
  status: 'active',
  turnaroundId: 'TRN_PAIR_01',
  linkType: 'sameday',
  pairAnchorDate: '2026-10-25',
};

test('countersToSeasonalDraftItems and seasonalDraftItemsToCounter round-trip accurately', () => {
  const counterObj = { T1: ['21', '22'], T2: ['30'] };
  const items = countersToSeasonalDraftItems(counterObj);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { counter_group: 'T1', item_index: 0, counter_value: '21' });
  assert.deepEqual(items[1], { counter_group: 'T1', item_index: 1, counter_value: '22' });
  assert.deepEqual(items[2], { counter_group: 'T2', item_index: 0, counter_value: '30' });

  const restored = seasonalDraftItemsToCounter(items);
  assert.deepEqual(restored, counterObj);

  // Array single group
  const singleItems = countersToSeasonalDraftItems(['10', '11']);
  assert.equal(singleItems.length, 2);
  assert.equal(singleItems[0].counter_group, '__single__');
  const restoredSingle = seasonalDraftItemsToCounter(singleItems);
  assert.deepEqual(restoredSingle, ['10', '11']);
});

test('windowsToSeasonalDraftItems and seasonalDraftItemsToWindows round-trip accurately', () => {
  const windows = {
    '21': { start: '07:00', end: '09:30' },
    '22': { start: '07:00', end: '09:30' },
  };
  const items = windowsToSeasonalDraftItems(windows);
  assert.equal(items.length, 2);
  const restored = seasonalDraftItemsToWindows(items);
  assert.deepEqual(restored, windows);
});

test('seasonalDraftToFlightRecord maps database draft record into typed FlightRecord', () => {
  const draft: SeasonalDraftRecord = {
    draft_id: 'DRF_101',
    season_id: 'W26',
    link_id: 'TRN_001',
    type: 'D',
    airline: 'VN',
    flight_number: 'VN999',
    raw_flight_number: 'VN999',
    route: 'SGN',
    schedule: '14:30',
    aircraft: 'A321',
    category: 'C',
    date: '2026-11-01',
    scheduled_date: '2026-11-01',
    scheduled_time: '14:30',
    operational_date: '2026-11-01',
    day_of_week: 7,
    source_row_index: 2,
    source_kind: 'manual',
    status: 'active',
    turnaround_id: 'TRN_001',
    counters: [{ counter_group: '__single__', item_index: 0, counter_value: '55' }],
    checkin_windows: [{ counter_key: '55', window_start: '12:00', window_end: '14:00' }],
    pax: 150,
    gate: 7,
    stand: '12',
  };

  const record = seasonalDraftToFlightRecord(draft);
  assert.equal(record.id, 'DRF_101');
  assert.equal(record.linkId, 'TRN_001');
  assert.equal(record.type, 'D');
  assert.equal(record.airline, 'VN');
  assert.equal(record.flightNumber, 'VN999');
  assert.equal(record.sourceKind, 'manual');
  assert.equal(record.sourceSide, 'DEP');
  assert.equal(record.pax, 150);
  assert.equal(record.gate, 7);
  assert.equal(record.stand, '12');
  assert.deepEqual(record.counter, ['55']);
  assert.deepEqual(record.checkInCounterWindows, { '55': { start: '12:00', end: '14:00' } });
});

test('seasonalDraftToFlightRecord correctly handles draft records with both snake_case and camelCase fields', () => {
  const dualDraft: SeasonalDraftRecord = {
    draft_id: 'DRF_DUAL_1',
    link_id: 'TRN_DUAL_1',
    category: 'J',
    season_id: 'W26',
    flight_number: 'VJ123',
    airline: 'VJ',
    type: 'A',
    date: '2026-11-05',
    scheduled_date: '2026-11-05',
    schedule: '08:00',
    route: 'HAN',
    aircraft: 'A321',
    pax: 220,
    counters: [],
    checkin_windows: [],
  };

  const record = seasonalDraftToFlightRecord(dualDraft);
  assert.equal(record.id, 'DRF_DUAL_1');
  assert.equal(record.airline, 'VJ');
  assert.equal(record.flightNumber, 'VJ123');
  assert.equal(record.pax, 220);
  assert.equal(record.type, 'A');
  assert.equal(record.sourceSide, 'ARR');
});

test('flightRecordToSeasonalDraftChange generates new record change payload with null expected', () => {
  const change = flightRecordToSeasonalDraftChange(SAMPLE_FLIGHT_RECORD, null);
  assert.ok(change);
  assert.equal(change.draftId, SAMPLE_FLIGHT_RECORD.id);
  assert.equal(change.expected, null);
  assert.equal(change.patch.airline, 'JX');
  assert.equal(change.patch.flight_number, '701');
  assert.equal(change.patch.route, 'TPE');
  assert.equal(change.patch.schedule, '10:00');
  assert.equal(change.patch.pax, 180);
  assert.equal(change.patch.gate, 12);
  assert.equal(change.patch.stand, '31');
  assert.equal(change.patch.status, 'active');
  assert.equal(change.patch.turnaround_id, 'TRN_PAIR_01');
  assert.equal(change.patch.linked_draft_id, 'REC_TEST_002');
});

test('flightRecordToSeasonalDraftChange detects modified fields and generates preimage expected', () => {
  const modified: FlightRecord = {
    ...SAMPLE_FLIGHT_RECORD,
    schedule: '11:15',
    scheduledTime: '11:15',
    route: 'ICN',
    pax: null,
    gate: 15,
    counter: { T1: ['21', '25'] },
  };

  const change = flightRecordToSeasonalDraftChange(modified, SAMPLE_FLIGHT_RECORD);
  assert.ok(change);
  assert.equal(change.draftId, SAMPLE_FLIGHT_RECORD.id);
  assert.notEqual(change.expected, null);

  // Preimages and patches
  assert.equal(change.expected?.schedule, '10:00');
  assert.equal(change.patch.schedule, '11:15');
  assert.equal(change.expected?.route, 'TPE');
  assert.equal(change.patch.route, 'ICN');
  assert.equal(change.expected?.pax, 180);
  assert.equal(change.patch.pax, null);
  assert.equal(change.expected?.gate, 12);
  assert.equal(change.patch.gate, 15);

  // Counters changed
  assert.ok(change.expected?.counters);
  assert.ok(change.patch.counters);

  // Unchanged fields are not in patch
  assert.equal(change.patch.airline, undefined);
  assert.equal(change.patch.aircraft, undefined);
  assert.equal(change.patch.carousel, undefined);
});

test('flightRecordToSeasonalDraftChange returns null when there are no changes', () => {
  const identical = { ...SAMPLE_FLIGHT_RECORD };
  const change = flightRecordToSeasonalDraftChange(identical, SAMPLE_FLIGHT_RECORD);
  assert.equal(change, null);
});

test('flightRecordToSeasonalDraftChange marks deletion correctly', () => {
  const deleted: FlightRecord = {
    ...SAMPLE_FLIGHT_RECORD,
    status: 'deleted',
  };

  const change = flightRecordToSeasonalDraftChange(deleted, SAMPLE_FLIGHT_RECORD);
  assert.ok(change);
  assert.equal(change.expected?.status, 'active');
  assert.equal(change.patch.status, 'deleted');
  assert.equal(change.expected?.deletion_reason, null);
  assert.equal(change.patch.deletion_reason, 'planning_removed');
});

test('isSeasonalPlanningV1Enabled respects environment flag', () => {
  const orig = process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED;
  try {
    delete process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED;
    assert.equal(isSeasonalPlanningV1Enabled(), false);

    process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED = '0';
    assert.equal(isSeasonalPlanningV1Enabled(), false);

    process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED = '1';
    assert.equal(isSeasonalPlanningV1Enabled(), true);
  } finally {
    if (orig !== undefined) {
      process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED = orig;
    } else {
      delete process.env.NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED;
    }
  }
});
