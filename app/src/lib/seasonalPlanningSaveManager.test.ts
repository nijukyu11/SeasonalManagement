import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyModificationsToFlightRecords,
  buildAuthoritativeDraftUndoChanges,
  createInitialDraftSaveState,
  executeSeasonalPlanningDraftSave,
  getSeasonalPlanningExportLegs,
  isDraftWorkspaceNotFoundError,
  loadFullSeasonalDraftRecords,
  retrySeasonalPlanningDraft,
  saveSeasonalPlanningDraft,
  seasonalDraftExportSnapshotToFlightRecords,
} from './seasonalPlanningSaveManager.ts';
import type {
  SeasonalDraftChangeInput,
  SeasonalDraftMutationReceipt,
} from './seasonalPlanningContract.ts';
import type { FlightModification, FlightRecord } from './types.ts';

const BASE_RECORD: FlightRecord = {
  id: 'REC_PLAN_001',
  linkId: 'REC_PLAN_001',
  type: 'A',
  airline: 'VN',
  flightNumber: '123',
  rawFlightNumber: 'VN123',
  requestStatusCode: null,
  route: 'HAN',
  schedule: '08:00',
  aircraft: '321',
  category: 'C',
  flightType: 'PAX',
  codeShares: null,
  intDomInd: null,
  pax: null,
  gate: null,
  stand: null,
  counter: null,
  carousel: null,
  mct: null,
  fb: null,
  lb: null,
  bhs: null,
  ghs: null,
  date: '2026-10-25',
  scheduledDate: '2026-10-25',
  scheduledTime: '08:00',
  operationalDate: '2026-10-25',
  dayOfWeek: 7,
  action: null,
  sourceRowIndex: 1,
  sourceKind: 'imported',
  sourceSide: 'ARR',
  status: 'active',
};
test('saveSeasonalPlanningDraft returns saved immediately if no changes exist', async () => {
  let called = false;
  const result = await saveSeasonalPlanningDraft({
    seasonId: 'W26',
    currentRecords: [BASE_RECORD],
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async () => {
      called = true;
      throw new Error('Should not be called');
    },
  });

  assert.equal(called, false);
  assert.equal(result.status, 'saved');
  assert.equal(result.receipt, null);
  assert.equal(result.changesCount, 0);
  assert.equal(result.error, null);
});

test('saveSeasonalPlanningDraft applies additions and returns valid receipt', async () => {
  const newRecord: FlightRecord = {
    ...BASE_RECORD,
    id: 'REC_PLAN_NEW',
    flightNumber: '999',
    sourceKind: 'manual',
  };

  const mockReceipt: SeasonalDraftMutationReceipt = {
    status: 'committed',
    requestId: 'req-1',
    revision: '6',
    events: [],
  };
  let receivedPayload: unknown = null;
  const result = await saveSeasonalPlanningDraft({
    seasonId: 'W26',
    currentRecords: [BASE_RECORD, newRecord],
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async (payload) => {
      receivedPayload = payload;
      return mockReceipt;
    },
  });

  assert.ok(receivedPayload);
  assert.equal(result.status, 'saved');
  assert.equal(result.changesCount, 1);
  assert.deepEqual(result.receipt, mockReceipt);
});

test('saveSeasonalPlanningDraft detects deletions and marks status deleted', async () => {
  const receivedChanges: SeasonalDraftChangeInput[] = [];
  const result = await saveSeasonalPlanningDraft({
    seasonId: 'W26',
    currentRecords: [], // Base record was removed from current
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async ({ changes }) => {
      receivedChanges.push(...changes);
      return {
        status: 'committed',
        requestId: 'req-2',
        revision: '6',
        events: [],
      };
    },
  });

  assert.equal(result.status, 'saved');
  assert.equal(receivedChanges.length, 1);
  const change = receivedChanges[0];
  assert.ok(change);
  assert.equal(change.draftId, BASE_RECORD.id);
  assert.equal(change.patch.status, 'deleted');
  assert.equal(change.patch.deletion_reason, 'planning_removed');
});

test('saveSeasonalPlanningDraft catches stale conflict (40001) and returns stale status', async () => {
  const modifiedRecord: FlightRecord = {
    ...BASE_RECORD,
    schedule: '09:30',
  };

  const result = await saveSeasonalPlanningDraft({
    seasonId: 'W26',
    currentRecords: [modifiedRecord],
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async () => {
      const err = new Error('Stale draft mutation');
      const errWithCode = err as Error & { code?: string };
      errWithCode.code = '40001';
      throw err;
    },
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.errorCode, '40001');
  assert.ok(result.error?.includes('thay đổi bởi người dùng khác'));
});

test('getSeasonalPlanningExportLegs filters deleted draft records and materializes active legs', async () => {
  const result = await getSeasonalPlanningExportLegs({
    seasonId: 'W26',
    expectedEpoch: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 10,
    getSnapshotFn: async () => ({
      seasonId: 'W26',
      seasonCode: 'W26',
      draftRevision: '10',
      draftEpoch: '00000000-0000-4000-8000-000000000001',
      totalCount: 2,
      serverHighWater: '10',
      truncated: false,
      flightRecords: [
        {
          draft_id: 'DRF_1',
          season_id: 'W26',
          type: 'A',
          airline: 'VN',
          flight_number: '123',
          route: 'HAN',
          schedule: '08:00',
          aircraft: '321',
          category: 'C',
          date: '2026-10-25',
          day_of_week: 7,
          source_row_index: 1,
          status: 'active',
          counters: [],
          checkin_windows: [],
        },
        {
          draft_id: 'DRF_2_DEL',
          season_id: 'W26',
          type: 'D',
          airline: 'VN',
          flight_number: '124',
          route: 'SGN',
          schedule: '09:00',
          aircraft: '321',
          category: 'C',
          date: '2026-10-25',
          day_of_week: 7,
          source_row_index: 2,
          status: 'deleted',
          counters: [],
          checkin_windows: [],
        },
      ],
      flightRecordCounters: [],
      flightRecordWindows: [],
    }),
  });

  assert.equal(result.seasonId, 'W26');
  assert.equal(result.effectiveLegs.length, 1);
  assert.equal(result.effectiveLegs[0].id, 'DRF_1');
  assert.equal(result.effectiveLegs[0].flightNumber, '123');
  assert.equal(result.effectiveLegs[0].route, 'HAN');
});

test('seasonalDraftExportSnapshotToFlightRecords handles database RPC snapshot format with record_id, relational counters and windows', async () => {
  const rpcSnapshot = {
    seasonId: 'W26',
    seasonCode: 'W26',
    draftRevision: '42',
    draftEpoch: '00000000-0000-4000-8000-000000000001',
    totalCount: 2,
    serverHighWater: '42',
    truncated: false,
    flightRecords: [
      {
        record_id: 'DRF_REAL_1',
        linked_record_id: 'DRF_REAL_2',
        season_id: 'W26',
        type: 'A',
        airline: 'VN',
        flight_number: 'VN123',
        raw_flight_number: '123',
        route: 'HAN',
        schedule: '08:00',
        aircraft: '321',
        category: 'C',
        date: '2026-10-25',
        day_of_week: 7,
        source_row_index: 1,
        status: 'active',
      },
      {
        record_id: 'DRF_REAL_DEL',
        linked_record_id: null,
        season_id: 'W26',
        type: 'D',
        airline: 'VN',
        flight_number: 'VN124',
        raw_flight_number: '124',
        route: 'SGN',
        schedule: '09:00',
        aircraft: '321',
        category: 'C',
        date: '2026-10-25',
        day_of_week: 7,
        source_row_index: 2,
        status: 'deleted',
      },
    ],
    flightRecordCounters: [
      { record_id: 'DRF_REAL_1', counter_group: 'T1', item_index: 0, counter_value: '10' },
    ],
    flightRecordWindows: [
      { record_id: 'DRF_REAL_1', counter_key: '10', window_start: '06:00', window_end: '07:30' },
    ],
  };

  const records = seasonalDraftExportSnapshotToFlightRecords(rpcSnapshot);
  assert.equal(records.length, 1, 'deleted records must be excluded');
  assert.equal(records[0].id, 'DRF_REAL_1');
  assert.equal(records[0].flightNumber, 'VN123');
  assert.equal(records[0].route, 'HAN');
  assert.deepEqual(records[0].counter, { T1: '10' });
  assert.deepEqual(records[0].checkInCounterWindows, { '10': { start: '06:00', end: '07:30' } });

  const result = await getSeasonalPlanningExportLegs({
    seasonId: 'W26',
    expectedEpoch: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 42,
    getSnapshotFn: async () => rpcSnapshot,
  });
  assert.equal(result.effectiveLegs.length, 1);
  assert.equal(result.effectiveLegs[0].id, 'DRF_REAL_1');
});

test('applyModificationsToFlightRecords applies modified fields and deleted status', () => {
  const records = [BASE_RECORD];
  const mods: FlightModification[] = [
    {
      legId: 'REC_PLAN_001',
      action: 'modified',
      gate: 5,
      stand: '21',
      schedule: '09:30',
    },
  ];
  const applied = applyModificationsToFlightRecords(records, mods);
  assert.equal(applied[0].gate, 5);
  assert.equal(applied[0].stand, '21');
  assert.equal(applied[0].schedule, '09:30');
  assert.equal(applied[0].status, 'active');

  const deleteMods: FlightModification[] = [
    {
      legId: 'REC_PLAN_001',
      action: 'deleted',
    },
  ];
  const deleted = applyModificationsToFlightRecords(records, deleteMods);
  assert.equal(deleted[0].status, 'deleted');
  assert.equal(deleted[0].action, 'deleted');
});

test('saveSeasonalPlanningDraft generates patch for gate and schedule modification', async () => {
  const mods: FlightModification[] = [
    {
      legId: 'REC_PLAN_001',
      action: 'modified',
      gate: 7,
      schedule: '10:00',
    },
  ];
  const currentRecords = applyModificationsToFlightRecords([BASE_RECORD], mods);
  let capturedChanges: SeasonalDraftChangeInput[] = [];

  const result = await saveSeasonalPlanningDraft({
    seasonId: 'W26',
    currentRecords,
    baseRecords: [BASE_RECORD],
    expectedRevision: 10,
    applyFn: async (payload) => {
      capturedChanges = payload.changes;
      return {
        status: 'committed',
        requestId: payload.requestId,
        revision: '11',
        nextRevision: '11',
        events: [],
      };
    },
  });

  assert.equal(result.status, 'saved');
  assert.equal(capturedChanges.length, 1);
  assert.equal(capturedChanges[0].draftId, 'REC_PLAN_001');
  assert.equal(capturedChanges[0].patch.gate, 7);
  assert.equal(capturedChanges[0].patch.schedule, '10:00');
  assert.equal(capturedChanges[0].expected?.gate, null);
  assert.equal(capturedChanges[0].expected?.schedule, '08:00');
});

test('loadFullSeasonalDraftRecords pages across batches and sends expectedEpoch and expectedRevision with pageSize 1000', async () => {
  const calls: unknown[] = [];
  const pages = [
    {
      status: 'ok' as const,
      revision: '5',
      epoch: 'ep1',
      serverHighWater: '10',
      hasMore: true,
      nextDraftId: 'DRF_002',
      drafts: [
        {
          draft_id: 'DRF_001',
          season_id: 'W26',
          link_id: 'DRF_001',
          type: 'A' as const,
          airline: 'VN',
          flight_number: '123',
          raw_flight_number: 'VN123',
          route: 'HAN',
          schedule: '08:00',
          aircraft: '321',
          category: 'C',
          date: '2026-10-25',
          day_of_week: 7,
          status: 'active' as const,
          source_kind: 'imported' as const,
          counters: [],
          checkin_windows: [],
        },
      ],
    },
    {
      status: 'ok' as const,
      revision: '6',
      epoch: 'ep1',
      serverHighWater: '20',
      hasMore: false,
      nextDraftId: null,
      drafts: [
        {
          draft_id: 'DRF_003',
          season_id: 'W26',
          link_id: 'DRF_003',
          type: 'D' as const,
          airline: 'VN',
          flight_number: '125',
          raw_flight_number: 'VN125',
          route: 'DAD',
          schedule: '10:00',
          aircraft: '321',
          category: 'C',
          date: '2026-10-25',
          day_of_week: 7,
          status: 'active' as const,
          source_kind: 'imported' as const,
          counters: [],
          checkin_windows: [],
        },
      ],
    },
  ];

  let pageIndex = 0;
  const result = await loadFullSeasonalDraftRecords('W26', async (input) => {
    calls.push(input);
    return pages[pageIndex++];
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    seasonId: 'W26',
    pageSize: 1000,
    afterDraftId: null,
    expectedEpoch: null,
    expectedRevision: null,
  });
  assert.deepEqual(calls[1], {
    seasonId: 'W26',
    pageSize: 1000,
    afterDraftId: 'DRF_002',
    expectedEpoch: 'ep1',
    expectedRevision: '5',
  });
  assert.equal(result.revision, '6');
  assert.equal(result.epoch, 'ep1');
  assert.equal(result.records.length, 2);
});

test('isDraftWorkspaceNotFoundError identifies P0002 and season not found errors', () => {
  assert.equal(isDraftWorkspaceNotFoundError({ code: 'P0002', message: 'Season not found' }), true);
  assert.equal(isDraftWorkspaceNotFoundError(new Error('Season not found')), true);
  assert.equal(isDraftWorkspaceNotFoundError('Season not found'), true);
  assert.equal(isDraftWorkspaceNotFoundError({ code: '22023', message: 'Invalid draft page' }), false);
  assert.equal(isDraftWorkspaceNotFoundError(new Error('Network timeout')), false);
  assert.equal(isDraftWorkspaceNotFoundError(null), false);
});

test('createInitialDraftSaveState initializes idle unconfirmed-free state', () => {
  const state = createInitialDraftSaveState(10);
  assert.equal(state.status, 'idle');
  assert.equal(state.revision, 10);
  assert.equal(state.hasUnconfirmedChanges, false);
  assert.equal(state.pendingRequest, null);
  assert.equal(state.error, null);
});

test('executeSeasonalPlanningDraftSave updates state to saved only when receipt is confirmed', async () => {
  const newRecord: FlightRecord = {
    ...BASE_RECORD,
    id: 'REC_PLAN_NEW_2',
    flightNumber: '888',
  };
  const mockReceipt: SeasonalDraftMutationReceipt = {
    status: 'committed',
    requestId: 'req-confirmed-1',
    revision: '15',
    events: [],
  };

  const { state, result } = await executeSeasonalPlanningDraftSave({
    seasonId: 'W26',
    currentRecords: [BASE_RECORD, newRecord],
    baseRecords: [BASE_RECORD],
    expectedRevision: 14,
    applyFn: async () => mockReceipt,
  });

  assert.equal(result.status, 'saved');
  assert.equal(state.status, 'saved');
  assert.equal(state.revision, '15');
  assert.equal(state.hasUnconfirmedChanges, false);
  assert.equal(state.pendingRequest, null);
  assert.ok(state.lastSavedAt);
});

test('executeSeasonalPlanningDraftSave retains exact requestId and request on failure and retry re-executes identical payload', async () => {
  const modifiedRecord: FlightRecord = {
    ...BASE_RECORD,
    route: 'DAD',
  };

  let callCount = 0;
  interface CapturedPayload {
    seasonId: string;
    requestId: string;
    expectedRevision: string | number;
    changes: SeasonalDraftChangeInput[];
  }
  const capturedPayloads: CapturedPayload[] = [];

  const mockReceipt: SeasonalDraftMutationReceipt = {
    status: 'committed',
    requestId: 'stable-req-id-123',
    revision: '21',
    events: [],
  };

  const applyFn = async (payload: { seasonId: string; requestId: string; expectedRevision: string | number; changes: SeasonalDraftChangeInput[] }) => {
    callCount++;
    capturedPayloads.push({ ...payload });
    if (callCount === 1) {
      throw new Error('Network timeout');
    }
    return mockReceipt;
  };

  // Initial attempt - fails with network error
  const currentArray = [modifiedRecord];
  const firstRun = await executeSeasonalPlanningDraftSave({
    seasonId: 'W26',
    currentRecords: currentArray,
    baseRecords: [BASE_RECORD],
    expectedRevision: 20,
    requestId: 'stable-req-id-123',
    applyFn,
  });

  assert.equal(firstRun.result.status, 'error');
  assert.equal(firstRun.state.status, 'error');
  assert.equal(firstRun.state.hasUnconfirmedChanges, true);
  assert.ok(firstRun.state.pendingRequest);
  assert.equal(firstRun.state.pendingRequest.requestId, 'stable-req-id-123');

  // Mutate original array and record in-place to verify pendingRequest preserved serialized fields
  currentArray.push({ ...BASE_RECORD, id: 'REC_MUTATED_AFTER' });
  modifiedRecord.route = 'SGN';

  // Retry attempt - re-executes the exact pendingRequest
  const retryRun = await retrySeasonalPlanningDraft(firstRun.state);
  assert.equal(retryRun.state.status, 'saved');
  assert.equal(retryRun.state.revision, '21');
  assert.equal(retryRun.state.hasUnconfirmedChanges, false);
  assert.equal(retryRun.state.pendingRequest, null);

  assert.equal(callCount, 2);
  const firstPayload = capturedPayloads[0];
  const secondPayload = capturedPayloads[1];
  assert.ok(firstPayload);
  assert.ok(secondPayload);
  // Prove both calls used the EXACT same requestId, expectedRevision, and changes
  assert.equal(firstPayload.requestId, secondPayload.requestId);
  assert.equal(firstPayload.expectedRevision, secondPayload.expectedRevision);
  assert.deepEqual(firstPayload.changes, secondPayload.changes);
});

test('executeSeasonalPlanningDraftSave handles stale 40001 conflict without false saved status', async () => {
  const modifiedRecord: FlightRecord = {
    ...BASE_RECORD,
    schedule: '11:00',
  };

  const { state, result } = await executeSeasonalPlanningDraftSave({
    seasonId: 'W26',
    currentRecords: [modifiedRecord],
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async () => {
      const err = new Error('Stale snapshot');
      (err as Error & { code?: string }).code = '40001';
      throw err;
    },
  });

  assert.equal(result.status, 'stale');
  assert.equal(state.status, 'stale');
  assert.equal(state.hasUnconfirmedChanges, true);
  assert.equal(state.errorCode, '40001');
  assert.notEqual(state.status, 'saved');
});

test('executeSeasonalPlanningDraftSave returns idle state without false saved status when no mutations exist', async () => {
  const { state, result } = await executeSeasonalPlanningDraftSave({
    seasonId: 'W26',
    currentRecords: [BASE_RECORD],
    baseRecords: [BASE_RECORD],
    expectedRevision: 5,
    applyFn: async () => {
      throw new Error('Should not be called');
    },
  });

  assert.equal(result.status, 'saved');
  assert.equal(result.receipt, null);
  assert.equal(result.changesCount, 0);
  assert.equal(state.status, 'idle');
  assert.equal(state.hasUnconfirmedChanges, false);
  assert.equal(state.lastSavedAt, null);
});

test('buildAuthoritativeDraftUndoChanges correctly inverts deletions, additions, and edits', () => {
  const receipt = {
    status: 'committed',
    requestId: 'req-undo-1',
    revision: '15',
    events: [
      // Deletion of linked flight
      {
        serverSeq: '101',
        draftId: 'DRF_DEL',
        changedFields: ['status', 'deletion_reason'],
        before: {
          draft_id: 'DRF_DEL',
          status: 'active',
          deletion_reason: null,
          linked_draft_id: 'DRF_SURVIVOR',
          turnaround_id: 'DRF_DEL',
          link_type: 'sameday',
          pair_anchor_date: '2026-10-25',
        },
        after: {
          draft_id: 'DRF_DEL',
          status: 'deleted',
          deletion_reason: 'planning_removed',
          linked_draft_id: null,
          turnaround_id: null,
          link_type: null,
          pair_anchor_date: null,
        },
      },
      // Unlinking of survivor
      {
        serverSeq: '102',
        draftId: 'DRF_SURVIVOR',
        changedFields: ['linked_draft_id', 'turnaround_id', 'link_type', 'pair_anchor_date'],
        before: {
          draft_id: 'DRF_SURVIVOR',
          linked_draft_id: 'DRF_DEL',
          turnaround_id: 'DRF_DEL',
          link_type: 'sameday',
          pair_anchor_date: '2026-10-25',
        },
        after: {
          draft_id: 'DRF_SURVIVOR',
          linked_draft_id: null,
          turnaround_id: null,
          link_type: null,
          pair_anchor_date: null,
        },
      },
      // Creation of new flight
      {
        serverSeq: '103',
        draftId: 'DRF_NEW',
        changedFields: ['status', 'flight_number'],
        before: null,
        after: {
          draft_id: 'DRF_NEW',
          status: 'active',
          deletion_reason: null,
          flight_number: 'VN999',
        },
      },
      // Modification of existing flight
      {
        serverSeq: '104',
        draftId: 'DRF_MOD',
        changedFields: ['schedule'],
        before: {
          draft_id: 'DRF_MOD',
          schedule: '08:00',
        },
        after: {
          draft_id: 'DRF_MOD',
          schedule: '09:30',
        },
      },
    ],
  } as unknown as SeasonalDraftMutationReceipt;

  const beforeRecords: FlightRecord[] = [
    {
      ...BASE_RECORD,
      id: 'DRF_DEL',
      status: 'active',
      linkedRecordId: 'DRF_SURVIVOR',
      turnaroundId: 'DRF_DEL',
      linkType: 'sameday',
      pairAnchorDate: '2026-10-25',
    },
    {
      ...BASE_RECORD,
      id: 'DRF_SURVIVOR',
      status: 'active',
      linkedRecordId: 'DRF_DEL',
      turnaroundId: 'DRF_DEL',
      linkType: 'sameday',
      pairAnchorDate: '2026-10-25',
    },
    {
      ...BASE_RECORD,
      id: 'DRF_MOD',
      status: 'active',
      schedule: '08:00',
    },
  ];

  const undoChanges = buildAuthoritativeDraftUndoChanges(receipt, beforeRecords);
  assert.equal(undoChanges.length, 4);

  // Verify DRF_DEL undo
  const delUndo = undoChanges.find((c) => c.draftId === 'DRF_DEL');
  assert.ok(delUndo);
  assert.ok(delUndo.expected);
  assert.ok(delUndo.patch);
  assert.equal(delUndo.expected.status, 'deleted');
  assert.equal(delUndo.expected.deletion_reason, 'planning_removed');
  assert.equal(delUndo.expected.linked_draft_id, null);
  assert.equal(delUndo.expected.turnaround_id, null);
  assert.equal(delUndo.expected.link_type, null);
  assert.equal(delUndo.expected.pair_anchor_date, null);
  assert.equal(delUndo.patch.status, 'active');
  assert.equal(delUndo.patch.deletion_reason, null);
  assert.equal(delUndo.patch.linked_draft_id, 'DRF_SURVIVOR');
  assert.equal(delUndo.patch.turnaround_id, 'DRF_DEL');
  assert.equal(delUndo.patch.link_type, 'sameday');
  assert.equal(delUndo.patch.pair_anchor_date, '2026-10-25');

  // Verify DRF_SURVIVOR undo
  const survivorUndo = undoChanges.find((c) => c.draftId === 'DRF_SURVIVOR');
  assert.ok(survivorUndo);
  assert.ok(survivorUndo.expected);
  assert.ok(survivorUndo.patch);
  assert.equal(survivorUndo.expected.linked_draft_id, null);
  assert.equal(survivorUndo.expected.turnaround_id, null);
  assert.equal(survivorUndo.expected.link_type, null);
  assert.equal(survivorUndo.expected.pair_anchor_date, null);
  assert.equal(survivorUndo.patch.linked_draft_id, 'DRF_DEL');
  assert.equal(survivorUndo.patch.turnaround_id, 'DRF_DEL');
  assert.equal(survivorUndo.patch.link_type, 'sameday');
  assert.equal(survivorUndo.patch.pair_anchor_date, '2026-10-25');

  // Verify DRF_NEW undo (revert by deleting)
  const newUndo = undoChanges.find((c) => c.draftId === 'DRF_NEW');
  assert.ok(newUndo);
  assert.deepEqual(newUndo.expected, {
    status: 'active',
    deletion_reason: null,
  });
  assert.deepEqual(newUndo.patch, {
    status: 'deleted',
    deletion_reason: 'planning_removed',
  });

  // Verify DRF_MOD undo
  const modUndo = undoChanges.find((c) => c.draftId === 'DRF_MOD');
  assert.ok(modUndo);
  assert.ok(modUndo.expected);
  assert.ok(modUndo.patch);
  assert.equal(modUndo.expected.schedule, '09:30');
  assert.equal(modUndo.patch.schedule, '08:00');
});

test('buildAuthoritativeDraftUndoChanges merges consecutive edits in reverse chronological order', () => {
  const receipt1 = {
    status: 'committed',
    requestId: 'req-1',
    revision: '10',
    events: [
      {
        serverSeq: '1',
        draftId: 'DRF_CHAIN',
        changedFields: ['schedule'],
        before: { schedule: '08:00' },
        after: { schedule: '09:00' },
      },
    ],
  } as unknown as SeasonalDraftMutationReceipt;

  const receipt2 = {
    status: 'committed',
    requestId: 'req-2',
    revision: '11',
    events: [
      {
        serverSeq: '2',
        draftId: 'DRF_CHAIN',
        changedFields: ['schedule'],
        before: { schedule: '09:00' },
        after: { schedule: '10:00' },
      },
    ],
  } as unknown as SeasonalDraftMutationReceipt;

  // Pass in [receipt1, receipt2] (chronological order)
  const initialRecord: FlightRecord = {
    ...BASE_RECORD,
    id: 'DRF_CHAIN',
    status: 'active',
    schedule: '08:00',
  };
  const undoChanges = buildAuthoritativeDraftUndoChanges([receipt1, receipt2], [initialRecord]);
  assert.equal(undoChanges.length, 1);
  assert.equal(undoChanges[0]?.draftId, 'DRF_CHAIN');
  assert.ok(undoChanges[0]);
  assert.ok(undoChanges[0].expected);
  assert.ok(undoChanges[0].patch);
  // Expected preimage must be 10:00 (latest state in DB)
  assert.equal(undoChanges[0].expected.schedule, '10:00');
  assert.equal(undoChanges[0].patch.schedule, '08:00');
});

test('buildAuthoritativeDraftUndoChanges reconstructs undo from minimal RPC receipt and beforeRecords', () => {
  const beforeFlight: FlightRecord = {
    ...BASE_RECORD,
    id: 'DRF_MIN_DEL',
    status: 'active',
    linkedRecordId: 'DRF_MIN_PAIR',
    turnaroundId: 'DRF_MIN_DEL',
    linkType: 'sameday',
    pairAnchorDate: '2026-10-25',
  };

  const survivorFlight: FlightRecord = {
    ...BASE_RECORD,
    id: 'DRF_MIN_PAIR',
    status: 'active',
    linkedRecordId: 'DRF_MIN_DEL',
    turnaroundId: 'DRF_MIN_DEL',
    linkType: 'sameday',
    pairAnchorDate: '2026-10-25',
  };

  const receipt: SeasonalDraftMutationReceipt = {
    status: 'committed',
    requestId: 'req-rpc-1',
    revision: '20',
    events: [
      {
        draftId: 'DRF_MIN_DEL',
        serverSeq: '201',
        after: {
          status: 'deleted',
          deletion_reason: 'planning_removed',
          linked_draft_id: null,
          turnaround_id: null,
          link_type: null,
          pair_anchor_date: null,
        },
      },
      {
        draftId: 'DRF_MIN_PAIR',
        serverSeq: '202',
        after: {
          status: 'active',
          deletion_reason: null,
          linked_draft_id: null,
          turnaround_id: null,
          link_type: null,
          pair_anchor_date: null,
        },
      },
    ],
  };

  const undoChanges = buildAuthoritativeDraftUndoChanges(receipt, [beforeFlight, survivorFlight]);
  assert.equal(undoChanges.length, 2);

  const delUndo = undoChanges.find((c) => c.draftId === 'DRF_MIN_DEL');
  assert.ok(delUndo);
  assert.ok(delUndo.expected);
  assert.ok(delUndo.patch);
  assert.equal(delUndo.expected.status, 'deleted');
  assert.equal(delUndo.expected.deletion_reason, 'planning_removed');
  assert.equal(delUndo.expected.linked_draft_id, null);
  assert.equal(delUndo.expected.turnaround_id, null);
  assert.equal(delUndo.expected.link_type, null);
  assert.equal(delUndo.expected.pair_anchor_date, null);
  assert.equal(delUndo.patch.status, 'active');
  assert.equal(delUndo.patch.deletion_reason, null);
  assert.equal(delUndo.patch.linked_draft_id, 'DRF_MIN_PAIR');
  assert.equal(delUndo.patch.turnaround_id, 'DRF_MIN_DEL');
  assert.equal(delUndo.patch.link_type, 'sameday');
  assert.equal(delUndo.patch.pair_anchor_date, '2026-10-25');

  const pairUndo = undoChanges.find((c) => c.draftId === 'DRF_MIN_PAIR');
  assert.ok(pairUndo);
  assert.ok(pairUndo.expected);
  assert.ok(pairUndo.patch);
  assert.equal(pairUndo.expected.linked_draft_id, null);
  assert.equal(pairUndo.expected.turnaround_id, null);
  assert.equal(pairUndo.expected.link_type, null);
  assert.equal(pairUndo.expected.pair_anchor_date, null);
  assert.equal(pairUndo.patch.linked_draft_id, 'DRF_MIN_DEL');
  assert.equal(pairUndo.patch.turnaround_id, 'DRF_MIN_DEL');
  assert.equal(pairUndo.patch.link_type, 'sameday');
  assert.equal(pairUndo.patch.pair_anchor_date, '2026-10-25');
});
