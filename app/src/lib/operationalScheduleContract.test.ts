import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCounterFromLegCounters,
  buildOperationalDateRange,
  buildOperationalLegPatchAndPreimage,
  buildWindowsFromLegCheckinWindows,
  extractOperationalDatesFromChangeEvent,
  getOperationalDayVietnamIso,
  getTodayVietnamIsoDate,
  isOperationalScheduleV1Enabled,
  loadFullOperationalScheduleWindow,
  operationalLegToFlightRecord,
  parseDailyImportCommittedResultV2,
  parseDailyImportStageResultV2,
  resolveOperationalDate,
  shiftVietnamIsoDate,
  shouldInvalidateOperationalWindow,
  subscribeToOperationalChanges,
  type OperationalFlightLeg,
  type OperationalLegCounter,
  type OperationalLegCheckinWindow,
  type OperationalWindowResult,
} from './operationalScheduleContract.ts';

test('isOperationalScheduleV1Enabled defaults to false without env variable', () => {
  const orig = process.env.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED;
  try {
    delete process.env.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED;
    assert.equal(isOperationalScheduleV1Enabled(), false);
    process.env.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED = '1';
    assert.equal(isOperationalScheduleV1Enabled(), true);
  } finally {
    if (orig !== undefined) {
      process.env.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED = orig;
    } else {
      delete process.env.NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED;
    }
  }
});

test('getTodayVietnamIsoDate returns Asia/Ho_Chi_Minh local date', () => {
  const utcDate = new Date('2026-09-28T17:30:00Z');
  assert.equal(getTodayVietnamIsoDate(utcDate), '2026-09-29');

  const earlierUtcDate = new Date('2026-09-28T16:30:00Z');
  assert.equal(getTodayVietnamIsoDate(earlierUtcDate), '2026-09-28');
});

test('buildOperationalDateRange supports presets correctly', () => {
  const fixedNow = new Date('2026-09-29T03:00:00Z');

  const today = buildOperationalDateRange('today', undefined, undefined, fixedNow);
  assert.deepEqual(today, { startDate: '2026-09-29', endDate: '2026-09-29' });

  const tomorrow = buildOperationalDateRange('tomorrow', undefined, undefined, fixedNow);
  assert.deepEqual(tomorrow, { startDate: '2026-09-30', endDate: '2026-09-30' });

  const next7days = buildOperationalDateRange('next7days', undefined, undefined, fixedNow);
  assert.deepEqual(next7days, { startDate: '2026-09-29', endDate: '2026-10-05' });

  const custom = buildOperationalDateRange('custom', '2026-10-01', '2026-10-15', fixedNow);
  assert.deepEqual(custom, { startDate: '2026-10-01', endDate: '2026-10-15' });
});

test('operationalLegToFlightRecord converts OperationalFlightLeg to FlightRecord properly', () => {
  const leg: OperationalFlightLeg = {
    leg_id: '550e8400-e29b-41d4-a716-446655440000',
    leg_key: 'A\x1f2026-09-29\x1fVN\x1f123',
    operational_date: '2026-09-29',
    scheduled_date: '2026-09-29',
    scheduled_time: '14:35:00',
    side: 'ARR',
    airline: 'VN',
    flight_number: '123',
    raw_flight_number: 'VN123',
    route: 'HAN-DAD',
    aircraft_type: '321',
    flight_category: 'C',
    pax: 180,
    gate: 5,
    stand: '21',
    carousel: 2,
    mct: '45',
    fb: '10',
    lb: '20',
    bhs: 'B1',
    ghs: 'G1',
    code_shares: 'AF1234',
    int_dom_ind: 'DOM',
    status: 'active',
    source_type: 'published_seasonal',
    source_season_id: 'W26',
    source_draft_id: 'DRF_01',
    source_batch_id: null,
    source_occurrence_key: null,
    source_row_number: 10,
    published_version_id: '550e8400-e29b-41d4-a716-446655449999',
    deletion_reason: null,
    linked_leg_id: '550e8400-e29b-41d4-a716-446655440001',
    turnaround_id: 'TRN_001',
    link_type: 'sameday',
    pair_anchor_date: '2026-09-29',
    check_in_allocation_mode: 'grouped',
    check_in_start: '12:35',
    check_in_end: '14:05',
    counter_token: 'C1-C4',
  };

  const counters: OperationalLegCounter[] = [
    { leg_id: leg.leg_id, counter_group: '__single__', item_index: 0, counter_value: '01' },
    { leg_id: leg.leg_id, counter_group: '__single__', item_index: 1, counter_value: '02' },
  ];

  const windows: OperationalLegCheckinWindow[] = [
    { leg_id: leg.leg_id, counter_key: '01', window_start: '12:35', window_end: '14:05' },
  ];

  const record = operationalLegToFlightRecord(leg, counters, windows);
  assert.equal(record.id, leg.leg_id);
  assert.equal(record.linkId, 'TRN_001');
  assert.equal(record.iataSeasonCode, undefined);
  assert.equal(record.flightType, 'PAX');
  assert.equal(record.intDomInd, 'DOM');
  assert.equal(record.draftId, 'DRF_01');
  assert.equal(record.type, 'A');
  assert.equal(record.airline, 'VN');
  assert.equal(record.flightNumber, '123');
  assert.equal(record.aircraft, '321');
  assert.equal(record.category, 'C');
  assert.equal(record.sourceKind, 'seasonal');
  assert.equal(record.schedule, '14:35');
  assert.equal(record.pax, 180);
  assert.equal(record.gate, 5);
  assert.equal(record.stand, '21');
  assert.equal(record.carousel, 2);
  assert.equal(record.linkType, 'sameday');
  assert.equal(record.checkInAllocationMode, 'grouped');
  assert.equal(record.turnaroundId, 'TRN_001');
  assert.equal(record.linkedRecordId, '550e8400-e29b-41d4-a716-446655440001');
  assert.deepEqual(record.counter, ['01', '02']);
  assert.deepEqual(record.checkInCounterWindows, {
    '01': { start: '12:35', end: '14:05' },
  });

  const unlinkedLeg = { ...leg, turnaround_id: null, linked_leg_id: null };
  const unlinkedRecord = operationalLegToFlightRecord(unlinkedLeg);
  assert.equal(unlinkedRecord.linkId, unlinkedLeg.leg_id);
});

test('operationalLegToFlightRecord keeps the calendar date for overnight legs', () => {
  // Daily/Gate/Check-in place rows at `${date}T${schedule}`; an 02:00 flight belongs to the previous operational day.
  const record = operationalLegToFlightRecord({
    leg_id: '550e8400-e29b-41d4-a716-446655440002',
    leg_key: 'D\x1f2026-10-26\x1fVN\x1f318',
    operational_date: '2026-10-25',
    scheduled_date: '2026-10-26',
    scheduled_time: '02:00:00',
    side: 'DEP',
    airline: 'VN',
    flight_number: '318',
    route: 'NRT',
    status: 'active',
    source_type: 'daily_import',
  } as OperationalFlightLeg);
  assert.equal(record.date, '2026-10-26');
  assert.equal(record.scheduledDate, '2026-10-26');
  assert.equal(record.operationalDate, '2026-10-25');
  assert.equal(record.dayOfWeek, 1);
});

test('loadFullOperationalScheduleWindow paginates over cursor and handles snapshot_changed', async () => {
  const calls: unknown[] = [];
  let pageCallCount = 0;

  const mockFetch = async (params: unknown): Promise<OperationalWindowResult> => {
    calls.push(params);
    pageCallCount += 1;

    if (pageCallCount === 1) {
      return {
        status: 'snapshot_changed',
        snapshot: { revision: '10', token: 'tok_v10' },
      };
    }

    if (pageCallCount === 2) {
      return {
        status: 'ok',
        startDate: '2026-09-29',
        endDate: '2026-09-29',
        snapshot: { revision: '10', token: 'tok_v10' },
        resources: { operational_gate_resources: [{ id: 'G1' }] },
        legs: [
          {
            leg_id: 'LEG_1',
            leg_key: 'A\x1f2026-09-29\x1fVN\x1f101',
            operational_date: '2026-09-29',
            scheduled_date: '2026-09-29',
            scheduled_time: '08:00:00',
            side: 'ARR',
            airline: 'VN',
            flight_number: '101',
            raw_flight_number: 'VN101',
            route: 'HAN',
            aircraft_type: '321',
            flight_category: 'C',
            pax: 150,
            gate: 1,
            stand: '10',
            carousel: null,
            mct: null,
            fb: null,
            lb: null,
            bhs: null,
            ghs: null,
            code_shares: null,
            int_dom_ind: 'DOM',
            status: 'active',
            source_type: 'published_seasonal',
            source_season_id: 'W26',
            source_draft_id: 'DRF_01',
            source_batch_id: null,
            source_occurrence_key: null,
            source_row_number: 1,
            published_version_id: 'PUB1',
            deletion_reason: null,
            linked_leg_id: null,
            turnaround_id: null,
            link_type: null,
            pair_anchor_date: null,
            check_in_allocation_mode: null,
            check_in_start: null,
            check_in_end: null,
            counter_token: null,
          },
        ],
        page: {
          returnedCount: 1,
          hasMore: true,
          nextCursor: {
            operationalDate: '2026-09-29',
            scheduledTime: '08:00:00',
            legId: 'LEG_1',
          },
        },
      };
    }

    return {
      status: 'ok',
      startDate: '2026-09-29',
      endDate: '2026-09-29',
      snapshot: { revision: '10', token: 'tok_v10' },
      legs: [
        {
          leg_id: 'LEG_2',
          leg_key: 'D\x1f2026-09-29\x1fVN\x1f102',
          operational_date: '2026-09-29',
          scheduled_date: '2026-09-29',
          scheduled_time: '09:00:00',
          side: 'DEP',
          airline: 'VN',
          flight_number: '102',
          raw_flight_number: 'VN102',
          route: 'SGN',
          aircraft_type: '321',
          flight_category: 'C',
          pax: 160,
          gate: 2,
          stand: '11',
          carousel: null,
          mct: null,
          fb: null,
          lb: null,
          bhs: null,
          ghs: null,
          code_shares: null,
          int_dom_ind: 'DOM',
          status: 'active',
          source_type: 'daily_import',
          source_season_id: null,
          source_draft_id: null,
          source_batch_id: '550e8400-e29b-41d4-a716-446655440099',
          source_occurrence_key: 'OCC_01',
          source_row_number: 2,
          published_version_id: null,
          deletion_reason: null,
          linked_leg_id: null,
          turnaround_id: null,
          link_type: null,
          pair_anchor_date: null,
          check_in_allocation_mode: null,
          check_in_start: null,
          check_in_end: null,
          counter_token: null,
        },
      ],
      page: {
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
      },
    };
  };

  const res = await loadFullOperationalScheduleWindow({
    startDate: '2026-09-29',
    endDate: '2026-09-29',
    fetchWindowFn: mockFetch,
  });

  assert.equal(calls.length, 3);
  assert.equal(res.snapshot.revision, '10');
  assert.equal(res.snapshot.token, 'tok_v10');
  assert.equal(res.records.length, 2);
  assert.equal(res.records[0].id, 'LEG_1');
  assert.equal(res.records[1].id, 'LEG_2');
  assert.deepEqual(res.resources, { operational_gate_resources: [{ id: 'G1' }] });
});

test('loadFullOperationalScheduleWindow throws when maxAttempts exceeded instead of returning partial window', async () => {
  const infiniteFetch = async (): Promise<OperationalWindowResult> => ({
    status: 'ok',
    snapshot: { revision: '1', token: 'tok_1' },
    legs: [],
    page: {
      returnedCount: 1,
      hasMore: true,
      nextCursor: {
        operationalDate: '2026-09-29',
        scheduledTime: '10:00:00',
        legId: 'ANY',
      },
    },
  });

  await assert.rejects(
    loadFullOperationalScheduleWindow({
      startDate: '2026-09-29',
      endDate: '2026-09-29',
      maxAttempts: 3,
      fetchWindowFn: infiniteFetch,
    }),
    /Exceeded maximum pagination attempts \(3\)/
  );
});

test('getOperationalDayVietnamIso respects 05:00 HCM boundary', () => {
  // 2026-09-28T21:30:00Z is 04:30:00 on 2026-09-29 in Asia/Ho_Chi_Minh (UTC+7) -> belongs to 2026-09-28
  const earlyMorning = new Date('2026-09-28T21:30:00Z');
  assert.equal(getOperationalDayVietnamIso(earlyMorning), '2026-09-28');

  // 2026-09-28T22:00:00Z is 05:00:00 on 2026-09-29 in Asia/Ho_Chi_Minh -> belongs to 2026-09-29
  const boundaryStart = new Date('2026-09-28T22:00:00Z');
  assert.equal(getOperationalDayVietnamIso(boundaryStart), '2026-09-29');

  // 2026-09-29T03:00:00Z is 10:00:00 on 2026-09-29 in Asia/Ho_Chi_Minh -> belongs to 2026-09-29
  const regularTime = new Date('2026-09-29T03:00:00Z');
  assert.equal(getOperationalDayVietnamIso(regularTime), '2026-09-29');
});

test('resolveOperationalDate shifts to previous day when schedule is before 05:00', () => {
  assert.equal(resolveOperationalDate('2026-09-29', '04:30'), '2026-09-28');
  assert.equal(resolveOperationalDate('2026-09-29', '04:59'), '2026-09-28');
  assert.equal(resolveOperationalDate('2026-09-29', '05:00'), '2026-09-29');
  assert.equal(resolveOperationalDate('2026-09-29', '14:20'), '2026-09-29');
  assert.equal(resolveOperationalDate('2026-09-29', '23:59'), '2026-09-29');
});

test('buildOperationalLegPatchAndPreimage creates matching patch and expected preimage', () => {
  const leg: OperationalFlightLeg = {
    leg_id: '550e8400-e29b-41d4-a716-446655440001',
    leg_key: 'A\x1f2026-09-29\x1fVN\x1f123',
    operational_date: '2026-09-29',
    scheduled_date: '2026-09-29',
    scheduled_time: '10:00:00',
    side: 'ARR',
    airline: 'VN',
    flight_number: '123',
    raw_flight_number: 'VN123',
    route: 'SGN-HAN',
    aircraft_type: 'A321',
    flight_category: 'PAX',
    pax: 150,
    code_shares: null,
    int_dom_ind: 'DOM',
    stand: '12',
    gate: 3,
    carousel: null,
    counter_token: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    check_in_start: null,
    check_in_end: null,
    check_in_allocation_mode: null,
    turnaround_id: null,
    linked_leg_id: null,
    link_type: null,
    pair_anchor_date: null,
    source_type: 'daily_import',
    source_season_id: null,
    source_draft_id: null,
    source_batch_id: null,
    source_occurrence_key: null,
    source_row_number: 1,
    published_version_id: null,
    status: 'active',
    deletion_reason: null,
  };

  const change = buildOperationalLegPatchAndPreimage(leg, {
    gate: 5,
    stand: '14A',
  });

  assert.ok(change);
  assert.equal(change.legId, '550e8400-e29b-41d4-a716-446655440001');
  assert.deepEqual(change.patch, { gate: 5, stand: '14A' });
  assert.deepEqual(change.expected, { gate: 3, stand: '12' });
});

test('Daily Import V2 parsers validate required structure', () => {
  const rawStage = {
    batchId: '550e8400-e29b-41d4-a716-446655440002',
    requestId: '550e8400-e29b-41d4-a716-446655440003',
    status: 'validated',
    previewHash: 'hash_abc',
    preview: {
      importGuardVersion: '2',
      valid: true,
      affectedDates: ['2026-09-29'],
      confirmedZeroFlightDates: [],
      sourceFingerprint: 'fp_123',
      legCount: 5,
      rebaseCount: 0,
      replacedLegs: [],
      rebasedOverrides: [],
      replacedBySource: { published_seasonal: 5 },
      inputHash: 'in_123',
    },
    diagnostics: [],
    expiresAt: '2026-09-29T12:00:00Z',
    result: null,
  };

  const parsedStage = parseDailyImportStageResultV2(rawStage);
  assert.equal(parsedStage.batchId, '550e8400-e29b-41d4-a716-446655440002');
  assert.equal(parsedStage.preview.legCount, 5);

  const rawCommit = {
    status: 'committed',
    batchId: '550e8400-e29b-41d4-a716-446655440002',
    affectedDates: ['2026-09-29'],
    insertedCount: 5,
    replacedCount: 5,
    revision: '42',
  };

  const parsedCommit = parseDailyImportCommittedResultV2(rawCommit);
  assert.equal(parsedCommit.status, 'committed');
  assert.equal(parsedCommit.revision, '42');
});

test('extractOperationalDatesFromChangeEvent extracts both old and new dates', () => {
  // Case 1: flight date changed from 2026-09-28 to 2026-09-29
  const eventDateMove = {
    new: {
      target_id: 'leg_1',
      operational_date: '2026-09-29',
      before_state: { operational_date: '2026-09-28', flight_number: '123' },
      after_state: { operational_date: '2026-09-29', flight_number: '123' },
    },
  };

  const dates = extractOperationalDatesFromChangeEvent(eventDateMove);
  assert.deepEqual(dates.sort(), ['2026-09-28', '2026-09-29']);

  // Case 2: standard in-day modification (e.g. gate change on 2026-09-29)
  const eventGateChange = {
    new: {
      target_id: 'leg_2',
      operational_date: '2026-09-29',
      before_state: { operational_date: '2026-09-29', gate: 1 },
      after_state: { operational_date: '2026-09-29', gate: 2 },
    },
  };

  const gateDates = extractOperationalDatesFromChangeEvent(eventGateChange);
  assert.deepEqual(gateDates, ['2026-09-29']);

  // Case 3: bare event row without new/old wrapper
  const bareEvent = {
    target_type: 'operationalLeg',
    operational_date: '2026-10-01',
  };
  assert.deepEqual(extractOperationalDatesFromChangeEvent(bareEvent), ['2026-10-01']);

  // Case 4: stringified JSON before/after state
  const stringifiedState = {
    new: {
      operational_date: '2026-10-03',
      before_state: JSON.stringify({ operational_date: '2026-10-02' }),
      after_state: JSON.stringify({ operational_date: '2026-10-03' }),
    },
  };
  const stringifiedDates = extractOperationalDatesFromChangeEvent(stringifiedState);
  assert.ok(stringifiedDates.includes('2026-10-02'));
  assert.ok(stringifiedDates.includes('2026-10-03'));

  // Case 5: old row on delete
  const deleteEvent = {
    old: {
      operational_date: '2026-10-05',
    },
  };
  assert.deepEqual(extractOperationalDatesFromChangeEvent(deleteEvent), ['2026-10-05']);

  // Case 6: null or empty
  assert.deepEqual(extractOperationalDatesFromChangeEvent(null as unknown as Record<string, unknown>), []);
  assert.deepEqual(extractOperationalDatesFromChangeEvent({} as Record<string, unknown>), []);
});

test('subscribeToOperationalChanges passes dates and event row to callbacks and supports unsubscribe', () => {
  const captured = { callback: null as ((payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => void) | null };
  let removedChannel: unknown = null;

  let capturedStatusCallback: ((status: string) => void) | undefined;
  const mockChannel = {
    on: (_type: string, _filter: unknown, callback: (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => void) => {
      captured.callback = callback;
      return {
        subscribe: (statusCallback?: (status: string) => void) => {
          capturedStatusCallback = statusCallback;
          return mockChannel;
        },
      };
    },
  };

  const mockClient = {
    channel: (_name: string) => mockChannel,
    removeChannel: (channel: unknown) => {
      removedChannel = channel;
    },
  };

  const receivedDates: string[][] = [];
  const receivedEvents: Array<Record<string, unknown> | undefined> = [];
  const directEvents: Array<Record<string, unknown>> = [];

  const sub = subscribeToOperationalChanges(mockClient, {
    onDateInvalidated: (dates, event) => {
      receivedDates.push(dates);
      receivedEvents.push(event);
    },
    onEvent: (event) => {
      directEvents.push(event);
    },
  });

  assert.ok(captured.callback);

  // Simulate an event arriving from Postgres Realtime
  const fakePayload = {
    new: {
      target_id: 'leg-123',
      operational_date: '2026-09-29',
      request_id: 'req-abc-1',
    },
  };

  captured.callback!(fakePayload);

  assert.equal(receivedDates.length, 1);
  assert.deepEqual(receivedDates[0], ['2026-09-29']);
  assert.equal(receivedEvents[0]?.request_id, 'req-abc-1');
  assert.equal(directEvents[0]?.target_id, 'leg-123');

  // Verify unsubscribe removes channel
  sub.unsubscribe();
  assert.equal(removedChannel, mockChannel);
});

test('subscribeToOperationalChanges triggers onReconnect on every SUBSCRIBED (initial and subsequent)', () => {
  let capturedStatusCallback: ((status: string) => void) | undefined;
  const mockChannel = {
    on: () => ({
      subscribe: (statusCallback?: (status: string) => void) => {
        capturedStatusCallback = statusCallback;
        return mockChannel;
      },
    }),
  };
  const mockClient = {
    channel: () => mockChannel,
    removeChannel: () => undefined,
  };

  const statuses: string[] = [];
  let reconnectCount = 0;

  subscribeToOperationalChanges(mockClient, {
    onDateInvalidated: () => undefined,
    onStatus: (status) => statuses.push(status),
    onReconnect: () => {
      reconnectCount += 1;
    },
  });

  assert.ok(capturedStatusCallback, 'subscribe callback must be captured');

  // 1. Initial connect
  capturedStatusCallback!('SUBSCRIBED');
  assert.deepEqual(statuses, ['SUBSCRIBED']);
  assert.equal(reconnectCount, 1, 'Initial subscribe must trigger onReconnect to close snapshot-to-subscription race');
  // 2. Disconnect / error
  capturedStatusCallback!('CHANNEL_ERROR');
  assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR']);
  assert.equal(reconnectCount, 1, 'Channel error must not trigger a new revalidation');

  // 3. Reconnect
  capturedStatusCallback!('SUBSCRIBED');
  assert.deepEqual(statuses, ['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED']);
  assert.equal(reconnectCount, 2, 'Subsequent SUBSCRIBED must trigger onReconnect');
});

test('shouldInvalidateOperationalWindow handles two-client invalidation, loopback and mutation safety', () => {
  const window = { startDate: '2026-09-29', endDate: '2026-09-29' };
  const ignored = new Set(['self-req-123']);

  // 1. Overlapping date invalidates
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-29'], window),
    true,
    'Overlapping date must invalidate',
  );

  // 2. Non-overlapping date does not invalidate
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-01'], window),
    false,
    'Non-overlapping date must not invalidate',
  );

  // 3. Empty or null dates do not invalidate
  assert.equal(shouldInvalidateOperationalWindow([], window), false);
  assert.equal(shouldInvalidateOperationalWindow(null as unknown as string[], window), false);

  // 4. Suppressed while mutation is in progress (prevents race condition / generation discard)
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-29'], window, { isMutating: true }),
    false,
    'Must not invalidate while mutation is in progress',
  );

  // 5. Suppressed when requestId is our own recent mutation (loopback prevention)
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-29'], window, {
      requestId: 'self-req-123',
      ignoredRequestIds: ignored,
    }),
    false,
    'Must ignore loopback event from own mutation',
  );

  // 6. Allowed when requestId is from another client
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-29'], window, {
      requestId: 'other-client-req-456',
      ignoredRequestIds: ignored,
    }),
    true,
    'Must invalidate when event is from another client',
  );
});

test('loadFullOperationalScheduleWindow deduplicates paired ARR/DEP split-page counters', async () => {
  const legA: OperationalFlightLeg = {
    leg_id: '550e8400-0000-0000-0000-00000000000a',
    leg_key: 'A\x1f2026-09-29\x1fVN\x1f1',
    operational_date: '2026-09-29',
    scheduled_date: '2026-09-29',
    scheduled_time: '08:00:00',
    side: 'ARR',
    airline: 'VN',
    flight_number: '1',
    raw_flight_number: 'VN1',
    route: 'HAN-SGN',
    aircraft_type: 'A321',
    flight_category: 'PAX',
    pax: null,
    code_shares: null,
    int_dom_ind: null,
    stand: null,
    gate: null,
    carousel: null,
    counter_token: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    check_in_start: null,
    check_in_end: null,
    check_in_allocation_mode: null,
    turnaround_id: 'TRN-1',
    linked_leg_id: '550e8400-0000-0000-0000-00000000000b',
    link_type: 'sameday',
    pair_anchor_date: '2026-09-29',
    source_type: 'daily_import',
    source_season_id: null,
    source_draft_id: null,
    source_batch_id: null,
    source_occurrence_key: null,
    source_row_number: 1,
    published_version_id: null,
    status: 'active',
    deletion_reason: null,
  };

  const legB: OperationalFlightLeg = {
    ...legA,
    leg_id: '550e8400-0000-0000-0000-00000000000b',
    leg_key: 'D\x1f2026-09-29\x1fVN\x1f2',
    scheduled_time: '10:00:00',
    side: 'DEP',
    flight_number: '2',
    raw_flight_number: 'VN2',
    route: 'SGN-HAN',
    linked_leg_id: '550e8400-0000-0000-0000-00000000000a',
  };

  const counterA0: OperationalLegCounter = {
    leg_id: legA.leg_id,
    counter_group: '__single__',
    item_index: 0,
    counter_value: '10',
  };
  const counterA1: OperationalLegCounter = {
    leg_id: legA.leg_id,
    counter_group: '__single__',
    item_index: 1,
    counter_value: '11',
  };
  const counterB0: OperationalLegCounter = {
    leg_id: legB.leg_id,
    counter_group: '__single__',
    item_index: 0,
    counter_value: '20',
  };

  let callIndex = 0;
  const fetchPages = async (params: { afterLegId?: string | null }): Promise<OperationalWindowResult> => {
    callIndex += 1;
    if (callIndex === 1) {
      // Page 1 returns legA + linked legB, along with counters for legA and counterpart legB
      return {
        status: 'ok',
        snapshot: { revision: '10', token: 'tok_10' },
        legs: [legA],
        linkedLegs: [legB],
        legCounters: [counterA0, counterA1, counterB0],
        page: {
          returnedCount: 1,
          hasMore: true,
          nextCursor: {
            operationalDate: '2026-09-29',
            scheduledTime: '08:00:00',
            legId: legA.leg_id,
          },
        },
      };
    }
    // Page 2 returns legB + linked legA, along with duplicate counters for legA and counter for legB
    return {
      status: 'ok',
      snapshot: { revision: '10', token: 'tok_10' },
      legs: [legB],
      linkedLegs: [legA],
      legCounters: [counterA0, counterA1, counterB0],
      page: {
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
      },
    };
  };

  const res = await loadFullOperationalScheduleWindow({
    startDate: '2026-09-29',
    endDate: '2026-09-29',
    fetchWindowFn: fetchPages,
  });

  assert.equal(res.records.length, 2);
  const recA = res.records.find((r) => r.id === legA.leg_id)!;
  const recB = res.records.find((r) => r.id === legB.leg_id)!;
  assert.ok(recA);
  assert.ok(recB);

  // Counter must be exactly ['10', '11'], not duplicated to ['10', '11', '10', '11']
  assert.deepEqual(recA.counter, ['10', '11']);
  assert.deepEqual(recB.counter, ['20']);
});

test('buildOperationalLegPatchAndPreimage transforms FlightRecord counters and windows to DB schema', () => {
  const flightRecord = {
    id: '550e8400-0000-0000-0000-000000000001',
    date: '2026-09-29',
    flightNumber: 'VN123',
    airline: 'VN',
    aircraftType: 'A321',
    route: 'SGN-HAN',
    scheduleTime: '10:00',
    gate: 1,
    stand: '12',
    carousel: 3,
    pax: 150,
    counter: ['01', '02'],
    checkInCounterWindows: {
      '01': { start: '08:00', end: '09:30' },
      '02': { start: '08:00', end: '09:30' },
    },
  } as any;

  const result = buildOperationalLegPatchAndPreimage(flightRecord, {
    gate: 2,
    counter: ['03', '04'],
    checkInCounterWindows: {
      '03': { start: '08:30', end: '10:00' },
    },
  });

  assert.ok(result);
  assert.equal(result.legId, flightRecord.id);
  assert.equal(result.patch.gate, 2);
  assert.equal(result.expected.gate, 1);

  // Counters transformed to array of DB records
  assert.deepEqual(result.patch.counters, [
    { counter_group: '__single__', item_index: 0, counter_value: '03' },
    { counter_group: '__single__', item_index: 1, counter_value: '04' },
  ]);
  assert.deepEqual(result.expected.counters, [
    { counter_group: '__single__', item_index: 0, counter_value: '01' },
    { counter_group: '__single__', item_index: 1, counter_value: '02' },
  ]);

  // Windows transformed to array of DB records
  assert.deepEqual(result.patch.checkin_windows, [
    { counter_key: '03', window_start: '08:30', window_end: '10:00' },
  ]);
  assert.deepEqual(result.expected.checkin_windows, [
    { counter_key: '01', window_start: '08:00', window_end: '09:30' },
    { counter_key: '02', window_start: '08:00', window_end: '09:30' },
  ]);
});


test('parseDailyImportCommittedResultV2 validates required SQL receipt fields', () => {
  // Missing required revision or affectedDates throws
  assert.throws(
    () => parseDailyImportCommittedResultV2({ status: 'committed', batchId: 'b-1' }),
    /Daily import commit receipt is missing required SQL receipt fields/,
  );

  // Valid receipt passes
  const valid = parseDailyImportCommittedResultV2({
    status: 'committed',
    batchId: 'batch-123',
    affectedDates: ['2026-09-29'],
    insertedCount: 10,
    replacedCount: 5,
    revision: '99',
  });
  assert.equal(valid.batchId, 'batch-123');
  assert.equal(valid.revision, '99');
  assert.equal(valid.insertedCount, 10);
  assert.deepEqual(valid.affectedDates, ['2026-09-29']);
});

test('shouldInvalidateOperationalWindow correctly evaluates published dates against active window', () => {
  const activeWindow = { startDate: '2026-10-01', endDate: '2026-10-07' };

  // Overlapping published dates return true
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-30', '2026-10-01'], activeWindow),
    true,
  );
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-05'], activeWindow),
    true,
  );
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-07', '2026-10-08'], activeWindow),
    true,
  );

  // Completely non-overlapping dates return false
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-09-20', '2026-09-30'], activeWindow),
    false,
  );
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-08', '2026-10-15'], activeWindow),
    false,
  );
  assert.equal(
    shouldInvalidateOperationalWindow([], activeWindow),
    false,
  );

  // Mutating flag suppresses immediate window invalidation to preserve in-flight writes
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-03'], activeWindow, { isMutating: true }),
    false,
  );

  // Self-originated request IDs are ignored
  const ignoredIds = new Set(['req-self-123']);
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-03'], activeWindow, {
      requestId: 'req-self-123',
      ignoredRequestIds: ignoredIds,
    }),
    false,
  );
  assert.equal(
    shouldInvalidateOperationalWindow(['2026-10-03'], activeWindow, {
      requestId: 'req-other-456',
      ignoredRequestIds: ignoredIds,
    }),
    true,
  );
});

