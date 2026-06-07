import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScheduleNotificationPayloadFromHistory,
  coalesceScheduleNotificationPayloads,
  formatScheduleNotificationMessages,
  withScheduleNotificationPayload,
  TELEGRAM_MESSAGE_SAFE_LIMIT,
  type ScheduleNotificationPayload,
} from './scheduleNotifications.ts';
import { resolveLinkedDeletionTargets } from './pairDeletion.ts';
import type { FlightModification, FlightRecord, ModHistoryEntry, Season } from './types.ts';

const season: Pick<Season, 'id' | 'seasonCode'> = {
  id: 'season-s26',
  seasonCode: 'S26',
};

function record(overrides: Partial<FlightRecord>): FlightRecord {
  const id = overrides.id ?? `${overrides.type ?? 'A'}-${overrides.flightNumber ?? '100'}`;
  return {
    id,
    linkId: overrides.linkId ?? 'link-1',
    type: overrides.type ?? 'A',
    airline: overrides.airline ?? 'VN',
    flightNumber: overrides.flightNumber ?? '100',
    rawFlightNumber: overrides.rawFlightNumber ?? overrides.flightNumber ?? '100',
    requestStatusCode: overrides.requestStatusCode ?? null,
    route: overrides.route ?? 'HAN',
    schedule: overrides.schedule ?? '10:00',
    aircraft: overrides.aircraft ?? '321',
    category: overrides.category ?? 'PAX',
    flightType: overrides.flightType ?? 'PAX',
    codeShares: overrides.codeShares ?? null,
    intDomInd: overrides.intDomInd ?? 'D',
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
    date: overrides.date ?? '2026-04-01',
    scheduledDate: overrides.scheduledDate,
    scheduledTime: overrides.scheduledTime,
    operationalDate: overrides.operationalDate,
    iataSeasonCode: overrides.iataSeasonCode,
    flightSeriesId: overrides.flightSeriesId,
    dayOfWeek: overrides.dayOfWeek ?? 3,
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    linkedSourceRowIndex: overrides.linkedSourceRowIndex,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
    sourceKind: overrides.sourceKind ?? 'imported',
    sourceSide: overrides.sourceSide ?? (overrides.type === 'D' ? 'DEP' : 'ARR'),
    status: overrides.status ?? 'active',
    turnaroundId: overrides.turnaroundId,
    checkInStart: overrides.checkInStart ?? null,
    checkInEnd: overrides.checkInEnd ?? null,
    checkInAllocationMode: overrides.checkInAllocationMode ?? null,
    checkInCounterWindows: overrides.checkInCounterWindows ?? null,
  };
}

test('resolves active linked counterpart records for pair deletion', () => {
  const arrival = record({
    id: 'arr-5j-1',
    type: 'A',
    airline: '5J',
    flightNumber: '5756',
    route: 'MNL',
    date: '2026-06-22',
    turnaroundId: 'turn-5j-1',
    linkedRecordId: 'dep-5j-1',
  });
  const departure = record({
    id: 'dep-5j-1',
    type: 'D',
    airline: '5J',
    flightNumber: '5757',
    route: 'MNL',
    date: '2026-06-22',
    turnaroundId: 'turn-5j-1',
    linkedRecordId: 'arr-5j-1',
  });

  const result = resolveLinkedDeletionTargets([arrival, departure], [arrival.id]);

  assert.equal(result.hasActiveCounterpart, true);
  assert.deepEqual(result.selectedIds, [arrival.id]);
  assert.deepEqual(result.counterpartIds, [departure.id]);
  assert.deepEqual(result.pairIds, [arrival.id, departure.id]);
});

test('does not prompt for pair deletion when counterpart is already deleted', () => {
  const arrival = record({
    id: 'arr-deleted-counterpart',
    type: 'A',
    turnaroundId: 'turn-deleted-counterpart',
    linkedRecordId: 'dep-deleted-counterpart',
  });
  const departure = record({
    id: 'dep-deleted-counterpart',
    type: 'D',
    turnaroundId: 'turn-deleted-counterpart',
    linkedRecordId: 'arr-deleted-counterpart',
    status: 'deleted',
  });

  const result = resolveLinkedDeletionTargets([arrival, departure], [arrival.id]);

  assert.equal(result.hasActiveCounterpart, false);
  assert.deepEqual(result.selectedIds, [arrival.id]);
  assert.deepEqual(result.counterpartIds, []);
  assert.deepEqual(result.pairIds, [arrival.id]);
});

test('resolves detailed pair deletion only for selected affected occurrences', () => {
  const selectedArrivalOne = record({
    id: 'arr-detail-1',
    type: 'A',
    date: '2026-06-22',
    linkedRecordId: 'dep-detail-1',
    linkId: 'link-detail',
    pairAnchorDate: '2026-06-22',
  });
  const selectedArrivalTwo = record({
    id: 'arr-detail-2',
    type: 'A',
    date: '2026-06-23',
    linkedRecordId: 'dep-detail-2',
    linkId: 'link-detail',
    pairAnchorDate: '2026-06-23',
  });
  const matchingDepartureOne = record({
    id: 'dep-detail-1',
    type: 'D',
    date: '2026-06-22',
    linkedRecordId: 'arr-detail-1',
    linkId: 'link-detail',
    pairAnchorDate: '2026-06-22',
  });
  const matchingDepartureTwo = record({
    id: 'dep-detail-2',
    type: 'D',
    date: '2026-06-23',
    linkedRecordId: 'arr-detail-2',
    linkId: 'link-detail',
    pairAnchorDate: '2026-06-23',
  });
  const outsidePeriodDeparture = record({
    id: 'dep-detail-outside',
    type: 'D',
    date: '2026-06-24',
    linkId: 'link-detail',
    pairAnchorDate: '2026-06-24',
  });

  const result = resolveLinkedDeletionTargets(
    [selectedArrivalOne, selectedArrivalTwo, matchingDepartureOne, matchingDepartureTwo, outsidePeriodDeparture],
    [selectedArrivalOne.id, selectedArrivalTwo.id],
  );

  assert.deepEqual(result.counterpartIds, [matchingDepartureOne.id, matchingDepartureTwo.id]);
  assert.deepEqual(result.pairIds, [
    selectedArrivalOne.id,
    selectedArrivalTwo.id,
    matchingDepartureOne.id,
    matchingDepartureTwo.id,
  ]);
});

test('formats paired updates with the operational Telegram template', () => {
  const beforeArrival = record({
    id: 'arr-1',
    type: 'A',
    airline: 'VJ',
    flightNumber: '801',
    route: 'DAD',
    schedule: '14:00',
    date: '2026-06-01',
    turnaroundId: 'turn-1',
    linkedRecordId: 'dep-1',
  });
  const afterArrival = { ...beforeArrival, schedule: '14:30' };
  const beforeDeparture = record({
    id: 'dep-1',
    type: 'D',
    airline: 'VJ',
    flightNumber: '802',
    route: 'DAD',
    schedule: '15:00',
    date: '2026-06-01',
    turnaroundId: 'turn-1',
    linkedRecordId: 'arr-1',
  });
  const afterDeparture = { ...beforeDeparture, schedule: '15:30' };
  const historyEntry: ModHistoryEntry = {
    id: 'history-1',
    timestamp: 1_777_777_777_000,
    description: 'Modified 2 flights',
    changes: [],
    recordChanges: [
      { recordId: 'arr-1', previousRecord: beforeArrival, newRecord: afterArrival },
      { recordId: 'dep-1', previousRecord: beforeDeparture, newRecord: afterDeparture },
    ],
  };

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry,
    module: 'detailed',
    operation: 'Modified 2 flights',
    beforeRecords: [beforeArrival, beforeDeparture],
    afterRecords: [afterArrival, afterDeparture],
    targetRecordIds: ['arr-1', 'dep-1'],
  });

  assert.equal(payload.counts.modified, 2);
  assert.equal(payload.counts.added, 0);
  assert.equal(payload.counts.deleted, 0);
  assert.deepEqual(payload.affectedPeriod, { from: '2026-06-01', to: '2026-06-01' });
  assert.equal(payload.flights.length, 2);
  assert.equal(payload.flights[0].pairKey, 'turnaround:turn-1');
  assert.deepEqual(payload.monthlyImpact, [{
    month: '2026-06',
    label: 'Jun 2026',
    before: 1,
    after: 1,
  }]);
  assert.equal(payload.deltas.filter((delta) => delta.field === 'schedule').length, 2);

  const [message] = formatScheduleNotificationMessages(payload, {
    operator: { uid: 'user-1', email: 'ops@example.com', displayName: 'Nguyen Van A' },
    sentAt: '2026-05-24T01:00:00.000Z',
  });

  assert.match(message, /🚨 FLIGHT SCHEDULE UPDATE/);
  assert.match(message, /👤 User: Nguyen Van A/);
  assert.match(message, /📅 Season: S26/);
  assert.match(message, /🔄 Modification Summary: Updated 1 Flight Pair\(s\) \(Period: 2026-06-01\)/);
  assert.match(message, /📊 Affection: Jun 2026 1 \(before\) -> 1 \(after\)/);
  assert.match(message, /✈️ Flight Pair: VJ801 \/ VJ802 \(DAD-DAD-DAD\)/);
  assert.match(message, /❌ Old Schedule: STA 14:00 \/ STD 15:00/);
  assert.match(message, /✅ New Schedule: STA 14:30 \/ STD 15:30 \(\+30 mins\)/);
  assert.match(message, /⏰ Timestamp: 2026-05-24 08:00 \(UTC\+7\)/);
});

test('formats added turnaround occurrences as one flight pair notification block', () => {
  const dates = ['2026-05-13', '2026-05-15', '2026-05-22'];
  const addedRecords = dates.flatMap((date, index) => {
    const pairKey = `turn-bx-${index}`;
    const arrivalId = `arr-bx-${index}`;
    const departureId = `dep-bx-${index}`;
    return [
      record({
        id: arrivalId,
        type: 'A',
        airline: 'BX',
        flightNumber: '7315',
        route: 'PUS',
        schedule: '01:10',
        date,
        turnaroundId: pairKey,
        linkedRecordId: departureId,
      }),
      record({
        id: departureId,
        type: 'D',
        airline: 'BX',
        flightNumber: '7316',
        route: 'PUS',
        schedule: '02:05',
        date,
        turnaroundId: pairKey,
        linkedRecordId: arrivalId,
      }),
    ];
  });
  const historyEntry: ModHistoryEntry = {
    id: 'history-added-pair',
    timestamp: 1_777_777_777_000,
    description: 'Added 6 flight occurrence(s)',
    changes: [],
    recordChanges: addedRecords.map((added) => ({
      recordId: added.id,
      previousRecord: null,
      newRecord: added,
    })),
  };

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry,
    module: 'seasonal',
    operation: historyEntry.description,
    beforeRecords: [],
    afterRecords: addedRecords,
    targetRecordIds: addedRecords.map((added) => added.id),
  });

  assert.deepEqual(payload.counts, { total: 6, added: 6, deleted: 0, modified: 0 });
  assert.deepEqual(payload.monthlyImpact, [{
    month: '2026-05',
    label: 'May 2026',
    before: 0,
    after: 3,
  }]);

  const [message] = formatScheduleNotificationMessages(payload, {
    operator: { uid: 'user-5', email: 'ops@example.com', displayName: null },
    sentAt: '2026-05-24T12:31:00.000Z',
  });

  assert.match(message, /Modification Summary: Added 3 Flight Pair\(s\) \(Period: 2026-05-13 to 2026-05-22\)/);
  assert.match(message, /Affection: May 2026 0 \(before\) -> 3 \(after\)/);
  assert.match(message, /Flight Pair: BX7315 \/ BX7316 \(PUS-DAD-PUS\)/);
  assert.doesNotMatch(message, /Flight: BX7315/);
  assert.match(message, /Old Schedule: None/);
  assert.match(message, /New Schedule: STA 01:10 \/ STD 02:05/);
});

test('scopes deletes with full-season context to explicit target records only', () => {
  const augustDates = [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-09',
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-16',
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-24',
  ];
  const bxFlights = augustDates.map((date, index) => record({
    id: `bx-${index + 1}`,
    airline: 'BX',
    flightNumber: '774',
    type: 'A',
    route: 'PUS',
    schedule: '00:45',
    date,
    linkId: `bx-link-${index + 1}`,
    pairAnchorDate: date,
  }));
  const unrelatedFlights = Array.from({ length: 40 }, (_, index) => record({
    id: `unrelated-${index + 1}`,
    airline: 'VN',
    flightNumber: String(100 + index),
    route: 'HAN',
    schedule: '12:00',
    date: `2026-08-${String((index % 28) + 1).padStart(2, '0')}`,
  }));
  const targetIds = bxFlights.slice(0, 9).map((flight) => flight.id);
  const beforeModifications = new Map<string, FlightModification>([
    ['unrelated-1', { legId: 'unrelated-1', action: 'modified', schedule: '12:10' }],
  ]);
  const afterModifications = new Map<string, FlightModification>(beforeModifications);
  for (const targetId of targetIds) {
    afterModifications.set(targetId, { legId: targetId, action: 'deleted' });
  }
  const historyEntry: ModHistoryEntry = {
    id: 'history-delete-9',
    timestamp: 1_777_777_777_000,
    description: 'Deleted 9 flight(s)',
    changes: targetIds.map((targetId) => ({
      legId: targetId,
      previousMod: null,
      newMod: { legId: targetId, action: 'deleted' },
    })),
  };

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry,
    module: 'detailed',
    operation: historyEntry.description,
    beforeRecords: [...bxFlights, ...unrelatedFlights],
    afterRecords: [...bxFlights, ...unrelatedFlights],
    beforeModifications,
    afterModifications,
    targetRecordIds: targetIds,
  });

  assert.deepEqual(payload.counts, { total: 9, added: 0, deleted: 9, modified: 0 });
  assert.equal(payload.flights.length, 9);
  assert.ok(payload.flights.every((flight) => flight.label === 'BX774'));
  assert.ok(!payload.flights.some((flight) => flight.label.startsWith('VN')));
  assert.deepEqual(payload.affectedPeriod, { from: '2026-08-03', to: '2026-08-17' });
  assert.deepEqual(payload.monthlyImpact, [{
    month: '2026-08',
    label: 'Aug 2026',
    before: 12,
    after: 3,
  }]);
  assert.ok(!payload.deltas.some((delta) => delta.targetLabel.startsWith('VN')));

  const messages = formatScheduleNotificationMessages(payload, {
    operator: { uid: 'user-2', email: 'ops@example.com', displayName: null },
    sentAt: '2026-05-24T01:00:00.000Z',
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /🔄 Modification Summary: Cancelled 9 Flights \(Period: 2026-08-03 to 2026-08-17\)/);
  assert.match(messages[0], /📊 Affection: Aug 2026 12 \(before\) -> 3 \(after\)/);
  assert.match(messages[0], /✈️ Flight: BX774 \(PUS-DAD\)/);
  assert.match(messages[0], /❌ Old Schedule: STA 00:45/);
  assert.match(messages[0], /✅ New Schedule: Cancelled/);
  assert.doesNotMatch(messages[0], /VN100/);
});

test('counts monthly impact for a single affected flight even when full snapshots contain paired counterparts', () => {
  const juneDates = [
    '2026-06-17',
    '2026-06-18',
    '2026-06-19',
    '2026-06-20',
    '2026-06-21',
    '2026-06-22',
    '2026-06-23',
    '2026-06-24',
    '2026-06-25',
    '2026-06-26',
  ];
  const julyDates = [
    '2026-07-01',
    '2026-07-02',
    '2026-07-03',
    '2026-07-04',
    '2026-07-05',
    '2026-07-06',
    '2026-07-07',
    '2026-07-08',
  ];
  const arrivalRecords = [...juneDates, ...julyDates].map((date, index) => record({
    id: `arr-5j-${index + 1}`,
    airline: '5J',
    flightNumber: '5756',
    type: 'A',
    route: 'MNL',
    schedule: '21:30',
    date,
    linkId: `turn-${date}`,
    pairAnchorDate: date,
    linkedRecordId: `dep-5j-${index + 1}`,
  }));
  const departureRecords = [...juneDates, ...julyDates].map((date, index) => record({
    id: `dep-5j-${index + 1}`,
    airline: '5J',
    flightNumber: '5757',
    type: 'D',
    route: 'MNL',
    schedule: '22:30',
    date,
    linkId: `turn-${date}`,
    pairAnchorDate: date,
    linkedRecordId: `arr-5j-${index + 1}`,
  }));
  const targetIds = [
    ...arrivalRecords.slice(0, 6),
    ...arrivalRecords.slice(juneDates.length, juneDates.length + 4),
  ].map((record) => record.id);
  const afterModifications = targetIds.map((targetId) => ({ legId: targetId, action: 'deleted' as const }));
  const historyEntry: ModHistoryEntry = {
    id: 'history-single-in-pair-delete',
    timestamp: 1_777_777_777_000,
    description: 'Deleted 10 flight(s)',
    changes: afterModifications.map((mod) => ({
      legId: mod.legId,
      previousMod: null,
      newMod: mod,
    })),
  };

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry,
    module: 'detailed',
    operation: historyEntry.description,
    beforeRecords: [...arrivalRecords, ...departureRecords],
    afterRecords: [...arrivalRecords, ...departureRecords],
    beforeModifications: [],
    afterModifications,
    targetRecordIds: targetIds,
  });

  assert.deepEqual(payload.monthlyImpact, [
    { month: '2026-06', label: 'Jun 2026', before: 10, after: 4 },
    { month: '2026-07', label: 'Jul 2026', before: 8, after: 4 },
  ]);

  const [message] = formatScheduleNotificationMessages(payload, {
    operator: { uid: 'user-3', email: 'ops@example.com', displayName: null },
    sentAt: '2026-05-24T12:02:00.000Z',
  });
  assert.match(message, /Affection: Jun 2026 10 \(before\) -> 4 \(after\)/);
  assert.match(message, /Affection: Jul 2026 8 \(before\) -> 4 \(after\)/);
  assert.match(message, /Flight: 5J5756 \(MNL-DAD\)/);
  assert.doesNotMatch(message, /Flight Pair: 5J5756 \/ 5J5757/);
});

test('coalesces complementary arrival and departure payloads into one paired notification', () => {
  const arrival = record({
    id: 'arr-we-1',
    airline: 'WE',
    flightNumber: '201',
    type: 'A',
    route: 'ICN',
    schedule: '21:10',
    date: '2026-06-22',
    turnaroundId: 'turn-we-1',
    linkedRecordId: 'dep-we-1',
  });
  const departure = record({
    id: 'dep-we-1',
    airline: 'WE',
    flightNumber: '202',
    type: 'D',
    route: 'ICN',
    schedule: '22:40',
    date: '2026-06-22',
    turnaroundId: 'turn-we-1',
    linkedRecordId: 'arr-we-1',
  });
  const baseHistory = {
    timestamp: 1_777_777_777_000,
    description: 'Deleted 1 flight(s)',
  };
  const arrPayload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry: { ...baseHistory, id: 'history-arr' },
    module: 'detailed',
    operation: baseHistory.description,
    beforeRecords: [arrival, departure],
    afterRecords: [arrival, departure],
    beforeModifications: [],
    afterModifications: [{ legId: arrival.id, action: 'deleted' }],
    targetRecordIds: [arrival.id],
  });
  const depPayload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry: { ...baseHistory, id: 'history-dep' },
    module: 'detailed',
    operation: baseHistory.description,
    beforeRecords: [arrival, departure],
    afterRecords: [arrival, departure],
    beforeModifications: [],
    afterModifications: [{ legId: departure.id, action: 'deleted' }],
    targetRecordIds: [departure.id],
  });

  const [coalesced] = coalesceScheduleNotificationPayloads([arrPayload, depPayload]);

  assert.deepEqual(coalesced.counts, { total: 2, added: 0, deleted: 2, modified: 0 });
  assert.deepEqual(coalesced.monthlyImpact, [{
    month: '2026-06',
    label: 'Jun 2026',
    before: 1,
    after: 0,
  }]);

  const [message] = formatScheduleNotificationMessages(coalesced, {
    operator: { uid: 'user-4', email: 'ops@example.com', displayName: null },
    sentAt: '2026-05-24T12:02:00.000Z',
  });
  assert.match(message, /Modification Summary: Cancelled 1 Flight Pair\(s\) \(Period: 2026-06-22\)/);
  assert.match(message, /Affection: Jun 2026 1 \(before\) -> 0 \(after\)/);
  assert.match(message, /Flight Pair: WE201 \/ WE202 \(ICN-DAD-ICN\)/);
  assert.match(message, /Old Schedule: STA 21:10 \/ STD 22:40/);
});

test('coalesces sequential same-flight pattern edits into one compact schedule notification', () => {
  const beforeDates = ['2026-06-03', '2026-06-10', '2026-06-17', '2026-06-24', '2026-07-01', '2026-07-08'];
  const afterDates = ['2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25', '2026-07-02', '2026-07-09'];
  const beforeRecords = beforeDates.map((date, index) => record({
    id: `yp-before-${index + 1}`,
    airline: 'YP',
    flightNumber: '621',
    type: 'A',
    route: 'ICN',
    schedule: '20:40',
    aircraft: '321',
    date,
  }));
  const afterRecords = afterDates.map((date, index) => record({
    id: `yp-after-${index + 1}`,
    airline: 'YP',
    flightNumber: '621',
    type: 'A',
    route: 'ICN',
    schedule: '20:40',
    aircraft: '321',
    date,
  }));
  const common = {
    season,
    module: 'detailed' as const,
    operation: 'Draft pattern change',
    beforeRecords,
    afterRecords,
  };
  const firstPayload = buildScheduleNotificationPayloadFromHistory({
    ...common,
    historyEntry: { id: 'history-yp-jun', timestamp: 1_777_777_777_000 },
    targetRecordIds: ['yp-before-1', 'yp-after-1'],
  });
  const secondPayload = buildScheduleNotificationPayloadFromHistory({
    ...common,
    historyEntry: { id: 'history-yp-jul', timestamp: 1_777_777_778_000 },
    targetRecordIds: ['yp-before-6', 'yp-after-6'],
  });

  const [coalesced] = coalesceScheduleNotificationPayloads([secondPayload, firstPayload]);

  assert.equal(coalesced.changeKinds?.join(','), 'pattern');
  assert.deepEqual(coalesced.affectedPeriod, { from: '2026-06-03', to: '2026-07-09' });
  assert.deepEqual(coalesced.monthlyImpact, [
    { month: '2026-06', label: 'Jun 2026', before: 4, after: 4 },
    { month: '2026-07', label: 'Jul 2026', before: 2, after: 2 },
  ]);

  const [message] = formatScheduleNotificationMessages(coalesced, {
    operator: { uid: 'user-yp', email: 'ops@example.com', displayName: null },
    sentAt: '2026-05-26T13:29:00.000Z',
  });

  assert.match(message, /📅 Season: S26\n\n✈️ Flight: YP621 \(ICN-DAD\)\n🕓 Schedule: STA 20:40\n🔁 Pattern: 3 -> 4/);
  assert.match(message, /🔄 Modification Summary: Changed Pattern 4 Flights \(Period: 2026-06-03 to 2026-07-09\)/);
  assert.match(message, /📊 Affection: Jun 2026 4 \(before\) -> 4 \(after\)/);
  assert.match(message, /📊 Affection: Jul 2026 2 \(before\) -> 2 \(after\)/);
  assert.doesNotMatch(message, /Old Schedule: STA 20:40/);
  assert.doesNotMatch(message, /New Schedule: STA 20:40/);
});

test('formats one pair notification when deletion targets include both linked legs', () => {
  const arrival = record({
    id: 'arr-5j-pair-delete',
    type: 'A',
    airline: '5J',
    flightNumber: '5756',
    route: 'MNL',
    schedule: '21:30',
    date: '2026-06-22',
    turnaroundId: 'turn-5j-delete',
    linkedRecordId: 'dep-5j-pair-delete',
  });
  const departure = record({
    id: 'dep-5j-pair-delete',
    type: 'D',
    airline: '5J',
    flightNumber: '5757',
    route: 'MNL',
    schedule: '22:30',
    date: '2026-06-22',
    turnaroundId: 'turn-5j-delete',
    linkedRecordId: 'arr-5j-pair-delete',
  });
  const target = resolveLinkedDeletionTargets([arrival, departure], [departure.id]);
  const deleteMods = target.pairIds.map((id) => ({ legId: id, action: 'deleted' as const }));

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry: { id: 'history-pair-delete', timestamp: 1_777_777_777_000 },
    module: 'seasonal',
    operation: 'Deleted 2 flight occurrence(s) for 5J5757',
    beforeRecords: [arrival, departure],
    afterRecords: [arrival, departure],
    beforeModifications: [],
    afterModifications: deleteMods,
    targetRecordIds: target.pairIds,
  });
  const [message] = formatScheduleNotificationMessages(payload, {
    operator: { email: 'ops@example.com', uid: 'user-1', displayName: null },
    sentAt: '2026-05-24T13:00:00.000Z',
  });

  assert.match(message, /Modification Summary: Cancelled 1 Flight Pair\(s\) \(Period: 2026-06-22\)/);
  assert.match(message, /Affection: Jun 2026 1 \(before\) -> 0 \(after\)/);
  assert.match(message, /Flight Pair: 5J5756 \/ 5J5757 \(MNL-DAD-MNL\)/);
  assert.doesNotMatch(message, /Flight: 5J5757/);
});

test('omits Telegram payloads for route-only schedule edits', () => {
  const before = record({
    id: 'route-only-1',
    flightNumber: '621',
    type: 'A',
    route: 'ICN',
    schedule: '20:40',
    aircraft: '321',
  });
  const historyEntry: ModHistoryEntry = {
    id: 'history-route-only',
    timestamp: 1_777_777_777_000,
    description: 'Modified route',
    changes: [{
      legId: before.id,
      previousMod: null,
      newMod: { legId: before.id, action: 'modified', route: 'PUS' },
    }],
  };

  const entry = withScheduleNotificationPayload(historyEntry, {
    season,
    module: 'detailed',
    operation: historyEntry.description,
    beforeRecords: [before],
    afterRecords: [before],
    beforeModifications: [],
    afterModifications: [{ legId: before.id, action: 'modified', route: 'PUS' }],
    targetRecordIds: [before.id],
  });

  assert.equal(entry.scheduleNotification, undefined);
});

test('formats large notifications into safe chunks while enumerating every flight', () => {
  const flights = Array.from({ length: 80 }, (_, index) => {
    const current = record({
      id: `flight-${index + 1}`,
      flightNumber: String(500 + index),
      schedule: '08:00',
      date: `2026-04-${String((index % 28) + 1).padStart(2, '0')}`,
    });
    return {
      id: current.id,
      label: `VN${current.flightNumber}`,
      type: current.type,
      date: current.date,
      schedule: current.schedule,
      route: current.route,
      aircraft: current.aircraft,
      action: 'added' as const,
      pairKey: `single:${current.id}`,
    };
  });
  const payload: ScheduleNotificationPayload = {
    version: 1,
    historyEntryId: 'history-large',
    seasonId: season.id,
    seasonCode: season.seasonCode,
    module: 'seasonal',
    operation: 'Added 80 flights',
    timestamp: 1_777_777_777_000,
    counts: { total: 80, added: 80, deleted: 0, modified: 0 },
    affectedPeriod: { from: '2026-04-01', to: '2026-04-28' },
    monthlyImpact: [{ month: '2026-04', label: 'Apr 2026', before: 0, after: 80 }],
    flights,
    deltas: flights.map((flight) => ({
      targetId: flight.id,
      targetLabel: flight.label,
      field: 'record',
      before: null,
      after: { id: flight.id, flightNumber: flight.label, date: flight.date },
    })),
  };

  const messages = formatScheduleNotificationMessages(payload, {
    operator: { uid: 'user-2', email: null, displayName: null },
    sentAt: '2026-05-24T01:00:00.000Z',
  });

  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= TELEGRAM_MESSAGE_SAFE_LIMIT));
  for (const flight of flights) {
    assert.ok(messages.some((message) => message.includes(flight.label)), `${flight.label} should be enumerated`);
  }
  assert.match(messages[0], /\[1\/\d+\]/);
});

test('shows base-record old values when a new modification overrides schedule fields', () => {
  const before = record({
    id: 'mod-1',
    flightNumber: '333',
    schedule: '09:00',
    aircraft: '320',
  });
  const historyEntry: ModHistoryEntry = {
    id: 'history-mod',
    timestamp: 1_777_777_777_000,
    description: 'Modified 1 flight',
    changes: [{
      legId: before.id,
      previousMod: null,
      newMod: {
        legId: before.id,
        action: 'modified',
        schedule: '09:45',
        aircraft: '321',
      },
    }],
  };

  const payload = buildScheduleNotificationPayloadFromHistory({
    season,
    historyEntry,
    module: 'detailed',
    operation: historyEntry.description,
    beforeRecords: [before],
    afterRecords: [before],
    beforeModifications: [],
    afterModifications: historyEntry.changes.map((change) => change.newMod),
    targetRecordIds: [before.id],
  });

  assert.ok(payload.deltas.some((delta) => (
    delta.field === 'schedule' &&
    delta.before === '09:00' &&
    delta.after === '09:45'
  )));
  assert.ok(payload.deltas.some((delta) => (
    delta.field === 'aircraft' &&
    delta.before === '320' &&
    delta.after === '321'
  )));
});
