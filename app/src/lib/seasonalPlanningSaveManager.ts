import {
  flightRecordToSeasonalDraftChange,
  seasonalDraftToFlightRecord,
  type SeasonalDraftChangeInput,
  type SeasonalDraftExportSnapshotResult,
  type SeasonalDraftMutationReceipt,
  type SeasonalDraftRecord,
  type SeasonalDraftWindowResult,
} from './seasonalPlanningContract.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types.ts';
import { withOperationalFlightMetadata } from './iataSeason.ts';
import {
  fromFlightRecordRows,
  type FlightRecordCounterRelationalRow,
  type FlightRecordRelationalRow,
  type FlightRecordWindowRelationalRow,
} from './supabaseRelationalMappers.ts';

export type SeasonalDraftSaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'stale';

export interface SeasonalDraftSaveResult {
  status: SeasonalDraftSaveStatus;
  receipt: SeasonalDraftMutationReceipt | null;
  changesCount: number;
  error: string | null;
  errorCode?: string | null;
}

export interface SeasonalDraftPendingRequest {
  seasonId: string;
  requestId: string;
  expectedRevision: string | number;
  changes: SeasonalDraftChangeInput[];
  applyFn: SeasonalDraftApplyFn;
  currentRecords: FlightRecord[];
  baseRecords: FlightRecord[];
}

export interface SeasonalDraftSaveState {
  status: SeasonalDraftSaveStatus;
  revision: string | number;
  lastSavedAt: number | null;
  error: string | null;
  errorCode?: string | null;
  pendingRequest: SeasonalDraftPendingRequest | null;
  hasUnconfirmedChanges: boolean;
}

export function createInitialDraftSaveState(initialRevision: string | number = 0): SeasonalDraftSaveState {
  return {
    status: 'idle',
    revision: initialRevision,
    lastSavedAt: null,
    error: null,
    errorCode: null,
    pendingRequest: null,
    hasUnconfirmedChanges: false,
  };
}

export async function executeSeasonalPlanningDraftSave(
  input: SaveSeasonalPlanningDraftInput,
): Promise<{ state: SeasonalDraftSaveState; result: SeasonalDraftSaveResult }> {
  const requestId = input.requestId || (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `REQ_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

  const changes = input.changes
    ? input.changes.map((c) => ({ ...c, patch: { ...c.patch } }))
    : diffSeasonalDraftRecords(input.currentRecords, input.baseRecords);

  const serializedChanges: SeasonalDraftChangeInput[] = changes.map((c) => ({
    ...c,
    patch: { ...c.patch },
  }));

  const stableInput: SeasonalDraftPendingRequest = {
    seasonId: input.seasonId,
    requestId,
    expectedRevision: input.expectedRevision,
    changes: serializedChanges,
    applyFn: input.applyFn,
    currentRecords: input.currentRecords.map((r) => ({ ...r })),
    baseRecords: input.baseRecords.map((r) => ({ ...r })),
  };

  const result = await saveSeasonalPlanningDraft(stableInput);

  if (result.status === 'saved') {
    const nextRevision = result.receipt?.revision ?? stableInput.expectedRevision;
    return {
      state: {
        status: result.receipt ? 'saved' : 'idle',
        revision: nextRevision,
        lastSavedAt: result.receipt ? Date.now() : null,
        error: null,
        errorCode: null,
        pendingRequest: null,
        hasUnconfirmedChanges: false,
      },
      result,
    };
  }

  return {
    state: {
      status: result.status,
      revision: stableInput.expectedRevision,
      lastSavedAt: null,
      error: result.error,
      errorCode: result.errorCode,
      pendingRequest: stableInput,
      hasUnconfirmedChanges: true,
    },
    result,
  };
}

export async function retrySeasonalPlanningDraft(
  currentState: SeasonalDraftSaveState,
): Promise<{ state: SeasonalDraftSaveState; result: SeasonalDraftSaveResult | null }> {
  if (!currentState.pendingRequest) {
    return { state: currentState, result: null };
  }
  const saveResult = await executeSeasonalPlanningDraftSave(currentState.pendingRequest);
  return {
    state: {
      ...saveResult.state,
      lastSavedAt: saveResult.state.lastSavedAt ?? currentState.lastSavedAt,
    },
    result: saveResult.result,
  };
}

export type SeasonalDraftApplyFn = (input: {
  seasonId: string;
  requestId: string;
  expectedRevision: string | number;
  changes: SeasonalDraftChangeInput[];
}) => Promise<SeasonalDraftMutationReceipt>;

export type SeasonalDraftSnapshotFn = (input: {
  seasonId: string;
  expectedEpoch: string;
  expectedRevision: string | number;
}) => Promise<SeasonalDraftExportSnapshotResult>;

export interface SaveSeasonalPlanningDraftInput {
  seasonId: string;
  currentRecords: FlightRecord[];
  baseRecords: FlightRecord[];
  expectedRevision: string | number;
  requestId?: string;
  applyFn: SeasonalDraftApplyFn;
  changes?: SeasonalDraftChangeInput[];
}


export function applyModificationsToFlightRecords(
  records: FlightRecord[],
  modifications: FlightModification[] | Map<string, FlightModification>
): FlightRecord[] {
  const modMap = modifications instanceof Map
    ? modifications
    : new Map(modifications.map((m) => [m.legId, m]));

  return records.map((record) => {
    const mod = modMap.get(record.id);
    if (!mod) return record;
    if (mod.action === 'deleted') {
      return {
        ...record,
        status: 'deleted' as const,
        action: 'deleted' as const,
      };
    }
    if (mod.action === 'modified') {
      const updatedSchedule = mod.schedule ?? record.schedule;

      const baseUpdated: FlightRecord = {
        ...record,
        action: 'modified' as const,
        schedule: updatedSchedule,
        scheduledTime: updatedSchedule,
        aircraft: mod.aircraft ?? record.aircraft,
        route: mod.route ?? record.route,
        codeShares: 'codeShares' in mod ? (mod.codeShares ?? null) : record.codeShares,
        pax: 'pax' in mod ? (mod.pax ?? null) : record.pax,
        gate: 'gate' in mod ? (mod.gate ?? null) : record.gate,
        stand: 'stand' in mod ? (mod.stand ?? null) : record.stand,
        counter: 'counter' in mod ? (mod.counter ?? null) : record.counter,
        carousel: 'carousel' in mod ? (mod.carousel ?? null) : record.carousel,
        checkInStart: 'checkInStart' in mod ? (mod.checkInStart ?? null) : record.checkInStart,
        checkInEnd: 'checkInEnd' in mod ? (mod.checkInEnd ?? null) : record.checkInEnd,
        checkInAllocationMode: 'checkInAllocationMode' in mod ? (mod.checkInAllocationMode ?? null) : record.checkInAllocationMode,
        checkInCounterWindows: 'checkInCounterWindows' in mod ? (mod.checkInCounterWindows ?? null) : record.checkInCounterWindows,
        mct: 'mct' in mod ? (mod.mct ?? null) : record.mct,
        fb: 'fb' in mod ? (mod.fb ?? null) : record.fb,
        lb: 'lb' in mod ? (mod.lb ?? null) : record.lb,
        bhs: 'bhs' in mod ? (mod.bhs ?? null) : record.bhs,
        ghs: 'ghs' in mod ? (mod.ghs ?? null) : record.ghs,
      };

      return withOperationalFlightMetadata(baseUpdated);
    }
    return record;
  });
}
export function isDraftWorkspaceNotFoundError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const err = error as { code?: string; message?: string; details?: string };
    if (err.code === 'P0002') return true;
    if (typeof err.message === 'string' && /season not found|P0002/i.test(err.message)) return true;
    if (typeof err.details === 'string' && /season not found|P0002/i.test(err.details)) return true;
  }
  if (typeof error === 'string' && /season not found|P0002/i.test(error)) return true;
  return false;
}

export interface SeasonalDraftRecordsSnapshot {
  records: FlightRecord[];
  revision: string;
  epoch: string;
}


export async function loadFullSeasonalDraftRecords(
  seasonId: string,
  fetchWindowFn: (input: {
    seasonId: string;
    pageSize?: number;
    afterDraftId?: string | null;
    expectedEpoch?: string | null;
    expectedRevision?: string | number | null;
  }) => Promise<SeasonalDraftWindowResult>
): Promise<SeasonalDraftRecordsSnapshot> {
  const records: FlightRecord[] = [];
  let afterDraftId: string | null = null;
  let hasMore = true;
  let latestRevision: string | null = null;
  let latestEpoch: string | null = null;

  while (hasMore) {
    const res = await fetchWindowFn({
      seasonId,
      pageSize: 1000,
      afterDraftId,
      expectedEpoch: latestEpoch,
      expectedRevision: latestRevision,
    });
    if (res.status === 'snapshot_changed') {
      records.length = 0;
      afterDraftId = null;
      latestRevision = null;
      latestEpoch = null;
      hasMore = true;
      continue;
    }
    latestRevision = res.revision;
    latestEpoch = res.epoch;
    for (const draft of res.drafts) {
      if (draft.status !== 'deleted') {
        records.push(seasonalDraftToFlightRecord(draft));
      }
    }
    hasMore = Boolean(res.hasMore && res.nextDraftId);
    afterDraftId = res.nextDraftId ?? null;
    if (!afterDraftId) break;
  }

  return { records, revision: latestRevision ?? '0', epoch: latestEpoch ?? '' };
}



export function diffSeasonalDraftRecords(
  currentRecords: FlightRecord[],
  baseRecords: FlightRecord[]
): SeasonalDraftChangeInput[] {
  const baseRecordMap = new Map<string, FlightRecord>();
  for (const base of baseRecords) {
    baseRecordMap.set(base.id, base);
  }

  const currentRecordMap = new Map<string, FlightRecord>();
  const changes: SeasonalDraftChangeInput[] = [];

  // 1. Process current records (added or modified)
  for (const record of currentRecords) {
    currentRecordMap.set(record.id, record);
    const base = baseRecordMap.get(record.id);
    const change = flightRecordToSeasonalDraftChange(record, base);
    if (change) {
      changes.push(change);
    }
  }

  // 2. Process deletions (records present in base but missing or deleted in current)
  for (const [baseId, base] of baseRecordMap.entries()) {
    if (!currentRecordMap.has(baseId)) {
      const deletedRecord: FlightRecord = {
        ...base,
        status: 'deleted',
      };
      const change = flightRecordToSeasonalDraftChange(deletedRecord, base);
      if (change) {
        changes.push(change);
      }
    }
  }

  return changes;
}

export async function saveSeasonalPlanningDraft(
  input: SaveSeasonalPlanningDraftInput,
): Promise<SeasonalDraftSaveResult> {
  const { seasonId, currentRecords, baseRecords, expectedRevision, applyFn } = input;
  const requestId = input.requestId || (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `REQ_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

  const changes = input.changes
    ? input.changes.map((c) => ({ ...c, patch: { ...c.patch } }))
    : diffSeasonalDraftRecords(currentRecords, baseRecords);
  // If no mutations detected, return saved immediately without server roundtrip
  if (changes.length === 0) {
    return {
      status: 'saved',
      receipt: null,
      changesCount: 0,
      error: null,
    };
  }

  try {
    const receipt = await applyFn({
      seasonId,
      requestId,
      expectedRevision,
      changes,
    });

    if (!receipt || typeof receipt.revision === 'undefined') {
      throw new Error('Server returned an invalid draft mutation receipt.');
    }

    return {
      status: 'saved',
      receipt,
      changesCount: changes.length,
      error: null,
    };
  } catch (err: unknown) {
    const errObj = err as { code?: string; message?: string; details?: string };
    const code = errObj.code;
    const msg = errObj.message || String(err);

    if (code === '40001' || msg.includes('stale') || msg.includes('mismatch') || msg.includes('Draft snapshot required')) {
      return {
        status: 'stale',
        receipt: null,
        changesCount: changes.length,
        error: 'Phiên bản kế hoạch mùa đã thay đổi bởi người dùng khác. Vui lòng tải lại dữ liệu.',
        errorCode: '40001',
      };
    }

    return {
      status: 'error',
      receipt: null,
      changesCount: changes.length,
      error: msg,
      errorCode: code,
    };
  }
}

/**
 * Convert seasonal draft export snapshot payload (relational SQL RPC format)
 * into typed FlightRecord array.
 */
export function seasonalDraftExportSnapshotToFlightRecords(
  snapshot: SeasonalDraftExportSnapshotResult,
): FlightRecord[] {
  const countersByRecord = new Map<string, FlightRecordCounterRelationalRow[]>();
  for (const rawCounter of (snapshot.flightRecordCounters || [])) {
    const c = rawCounter as unknown as FlightRecordCounterRelationalRow;
    const recordId = c.record_id;
    if (!recordId) continue;
    const list = countersByRecord.get(recordId);
    if (list) list.push(c);
    else countersByRecord.set(recordId, [c]);
  }

  const windowsByRecord = new Map<string, FlightRecordWindowRelationalRow[]>();
  for (const rawWindow of (snapshot.flightRecordWindows || [])) {
    const w = rawWindow as unknown as FlightRecordWindowRelationalRow;
    const recordId = w.record_id;
    if (!recordId) continue;
    const list = windowsByRecord.get(recordId);
    if (list) list.push(w);
    else windowsByRecord.set(recordId, [w]);
  }

  const records: FlightRecord[] = [];
  for (const raw of (snapshot.flightRecords || [])) {
    const rawObj = raw as Record<string, unknown>;
    const recordId = (rawObj.record_id ?? rawObj.draft_id ?? '') as string;
    const status = (rawObj.status ?? 'active') as string;
    if (status === 'deleted') continue;

    if (rawObj.draft_id && !rawObj.record_id) {
      records.push(seasonalDraftToFlightRecord(rawObj as unknown as SeasonalDraftRecord));
    } else {
      const row: FlightRecordRelationalRow = {
        season_id: (rawObj.season_id ?? snapshot.seasonId) as string,
        record_id: recordId,
        link_id: (rawObj.link_id ?? rawObj.turnaround_id ?? null) as string | null,
        type: rawObj.type as 'A' | 'D' | null,
        airline: (rawObj.airline ?? '') as string,
        flight_number: (rawObj.flight_number ?? '') as string,
        raw_flight_number: (rawObj.raw_flight_number ?? rawObj.flight_number ?? '') as string,
        request_status_code: (rawObj.request_status_code ?? null) as string | null,
        route: (rawObj.route ?? '') as string,
        schedule: (rawObj.schedule ?? '') as string,
        aircraft: (rawObj.aircraft ?? '') as string,
        category: (rawObj.category ?? '') as string,
        code_shares: (rawObj.code_shares ?? null) as string | null,
        int_dom_ind: (rawObj.int_dom_ind ?? null) as string | null,
        pax: rawObj.pax != null ? Number(rawObj.pax) : null,
        gate: rawObj.gate != null ? Number(rawObj.gate) : null,
        stand: (rawObj.stand ?? null) as string | null,
        carousel: rawObj.carousel != null ? Number(rawObj.carousel) : null,
        mct: (rawObj.mct ?? null) as string | null,
        fb: (rawObj.fb ?? null) as string | null,
        lb: (rawObj.lb ?? null) as string | null,
        bhs: (rawObj.bhs ?? null) as string | null,
        ghs: (rawObj.ghs ?? null) as string | null,
        date: (rawObj.date ?? '') as string,
        scheduled_date: (rawObj.scheduled_date ?? rawObj.date ?? null) as string | null,
        scheduled_time: (rawObj.scheduled_time ?? rawObj.schedule ?? null) as string | null,
        operational_date: (rawObj.operational_date ?? rawObj.date ?? null) as string | null,
        iata_season_code: (rawObj.iata_season_code ?? null) as string | null,
        flight_series_id: (rawObj.flight_series_id ?? null) as string | null,
        day_of_week: Number(rawObj.day_of_week ?? 0),
        action: (rawObj.action ?? null) as 'modified' | 'added' | 'deleted' | null,
        source_row_index: Number(rawObj.source_row_index ?? 0),
        linked_source_row_index: rawObj.linked_source_row_index != null ? Number(rawObj.linked_source_row_index) : null,
        link_type: (rawObj.link_type ?? null) as 'overnight' | 'sameday' | null,
        pair_anchor_date: (rawObj.pair_anchor_date ?? null) as string | null,
        linked_record_id: (rawObj.linked_record_id ?? rawObj.linked_draft_id ?? null) as string | null,
        source_kind: (rawObj.source_kind ?? 'imported') as 'imported' | 'manual',
        source_side: (rawObj.source_side ?? (rawObj.type === 'A' ? 'ARR' : 'DEP')) as 'ARR' | 'DEP',
        status: status as 'active' | 'deleted',
        turnaround_id: (rawObj.turnaround_id ?? null) as string | null,
      };
      records.push(
        fromFlightRecordRows(
          row,
          countersByRecord.get(recordId) ?? [],
          windowsByRecord.get(recordId) ?? [],
        ),
      );
    }
  }
  return records;
}

/**
 * Adapter to fetch versioned seasonal draft snapshot and materialize effective legs
 * preserving existing export template format.
 */
export async function getSeasonalPlanningExportLegs(input: {
  seasonId: string;
  expectedEpoch: string;
  expectedRevision: string | number;
  getSnapshotFn: SeasonalDraftSnapshotFn;
}): Promise<{
  seasonId: string;
  seasonCode: string;
  draftRevision: string;
  draftEpoch: string;
  effectiveLegs: FlightLeg[];
}> {
  const snapshot = await input.getSnapshotFn({
    seasonId: input.seasonId,
    expectedEpoch: input.expectedEpoch,
    expectedRevision: input.expectedRevision,
  });

  const effectiveLegs = seasonalDraftExportSnapshotToFlightRecords(snapshot);

  return {
    seasonId: snapshot.seasonId,
    seasonCode: snapshot.seasonCode,
    draftRevision: snapshot.draftRevision,
    draftEpoch: snapshot.draftEpoch,
    effectiveLegs,
  };
}

/**
 * Invert committed draft mutation receipt events into authoritative undo changes
 * with valid database preimages, preserving links, restorations, and modifications.
 */
export function buildAuthoritativeDraftUndoChanges(
  receipt: SeasonalDraftMutationReceipt | SeasonalDraftMutationReceipt[],
  beforeRecords?: FlightRecord[] | Map<string, FlightRecord>,
): SeasonalDraftChangeInput[] {
  const receipts = Array.isArray(receipt) ? receipt : [receipt];
  const beforeMap = beforeRecords instanceof Map
    ? beforeRecords
    : beforeRecords
      ? new Map(beforeRecords.map((r) => [r.id, r]))
      : new Map<string, FlightRecord>();

  const undoChanges: SeasonalDraftChangeInput[] = [];

  // Process receipts in reverse order (newest mutation first)
  for (let rIdx = receipts.length - 1; rIdx >= 0; rIdx--) {
    const curReceipt = receipts[rIdx];
    if (!curReceipt?.events) continue;

    for (let eIdx = curReceipt.events.length - 1; eIdx >= 0; eIdx--) {
      const ev = curReceipt.events[eIdx];
      const draftId = ev.draftId;
      if (!draftId) continue;

      const beforeRecord = beforeMap.get(draftId);
      const rawAfter = ev.after as unknown as SeasonalDraftRecord;
      const afterRecord = seasonalDraftToFlightRecord({
        ...rawAfter,
        type: rawAfter.type ?? beforeRecord?.type ?? 'A',
        airline: rawAfter.airline ?? beforeRecord?.airline ?? 'VN',
        flight_number: rawAfter.flight_number ?? beforeRecord?.flightNumber ?? '100',
        route: rawAfter.route ?? beforeRecord?.route ?? 'HAN',
        schedule: rawAfter.schedule ?? beforeRecord?.schedule ?? '08:00',
        aircraft: rawAfter.aircraft ?? beforeRecord?.aircraft ?? '321',
        category: rawAfter.category ?? beforeRecord?.category ?? 'C',
        date: rawAfter.date ?? beforeRecord?.date ?? '2026-10-25',
        counters: rawAfter.counters ?? [],
        checkin_windows: rawAfter.checkin_windows ?? [],
      });

      let singleUndo: SeasonalDraftChangeInput | null = null;

      if (!beforeRecord) {
        // Row was newly created in this mutation -> undo by deleting it
        singleUndo = {
          draftId,
          expected: {
            status: (ev.after.status as string) ?? 'active',
            deletion_reason: (ev.after.deletion_reason as string | null) ?? null,
          },
          patch: {
            status: 'deleted',
            deletion_reason: 'planning_removed',
          },
        };
      } else {
        // Row existed before mutation -> diff beforeRecord (desired target) against afterRecord (current DB state)
        singleUndo = flightRecordToSeasonalDraftChange(beforeRecord, afterRecord);
        if (singleUndo) {
          const exp = singleUndo.expected ? { ...singleUndo.expected } : {};
          singleUndo.expected = exp;
          // When restoring a deleted record, after.status is 'deleted', so expected preimage
          // requires matching the database tombstone's exact deletion_reason:
          if (ev.after.status === 'deleted') {
            exp.status = 'deleted';
            exp.deletion_reason = (ev.after.deletion_reason as string) ?? 'planning_removed';
            singleUndo.patch.status = 'active';
            singleUndo.patch.deletion_reason = null;
          }
        }
      }

      if (!singleUndo || Object.keys(singleUndo.patch).length === 0) continue;

      undoChanges.push(singleUndo);
    }
  }

  return composeSeasonalDraftUndoChanges(undoChanges);
}

/** Merge newest-to-oldest undo changes using current preimages and earliest targets. */
export function composeSeasonalDraftUndoChanges(
  changes: readonly SeasonalDraftChangeInput[]
): SeasonalDraftChangeInput[] {
  const byId = new Map<string, SeasonalDraftChangeInput>();
  for (const change of changes) {
    const existing = byId.get(change.draftId);
    if (!existing) {
      byId.set(change.draftId, {
        draftId: change.draftId,
        expected: { ...change.expected },
        patch: { ...change.patch },
      });
      continue;
    }
    const expected = existing.expected!;
    for (const [field, value] of Object.entries(change.expected ?? {})) {
      if (!(field in expected)) expected[field] = value;
    }
    Object.assign(existing.patch, change.patch);
  }

  const result: SeasonalDraftChangeInput[] = [];
  for (const change of byId.values()) {
    const expected = change.expected!;
    // Undoing an insertion removes the row, not each intervening field edit.
    if (change.patch.status === 'deleted') {
      if (expected.status === 'deleted') continue;
      result.push({
        draftId: change.draftId,
        expected: { status: expected.status, deletion_reason: expected.deletion_reason },
        patch: { status: 'deleted', deletion_reason: change.patch.deletion_reason },
      });
      continue;
    }
    const patch: Record<string, unknown> = {};
    const preimage: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(change.patch)) {
      if (JSON.stringify(value) !== JSON.stringify(expected[field])) {
        patch[field] = value;
        preimage[field] = expected[field];
      }
    }
    if (Object.keys(patch).length > 0) {
      result.push({ draftId: change.draftId, expected: preimage, patch });
    }
  }
  return result;
}
