import { create } from 'zustand';
import type { LocalSyncMeta } from './localSeasonStore';
import { getOperatorSessionEpoch, isOperatorSessionEpochCurrent } from './operatorSessionCacheRegistry.ts';
import type { FlightModification, FlightRecord, OperationalSettings, ParsedRow, Season } from './types';

export type SeasonWindowKey = string;
export type SeasonWorkspaceWindowRequestStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
export type SeasonWindowStaleReason = 'manual' | 'mutation' | 'realtime' | 'ttl' | 'request-error' | null;

export interface SeasonWorkspaceWindowMetadata {
  generation: number;
  fetchedAt: number | null;
  dataVersion: number | null;
  serverHighWater: number | null;
  requestStatus: SeasonWorkspaceWindowRequestStatus;
  staleReason: SeasonWindowStaleReason;
  lastError: string | null;
}

export interface SeasonWorkspaceWindowSnapshot {
  rows: ParsedRow[];
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
}

export interface CommitSeasonWindowResultInput extends SeasonWorkspaceWindowSnapshot {
  seasonId: string;
  windowKey: SeasonWindowKey;
  requestGeneration: number;
  operatorSessionEpoch: number;
  fetchedAt: number;
  dataVersion: number;
  serverHighWater: number;
}

export interface ReplaceSeasonWindowInput {
  seasonId: string;
  season?: Season | null;
  rows?: ParsedRow[];
  records: FlightRecord[];
  modifications: FlightModification[] | Map<string, FlightModification>;
  syncMeta?: LocalSyncMeta | null;
  windowKey?: SeasonWindowKey;
  operatorSessionEpoch?: number;
}

export interface PatchSeasonWorkspaceInput {
  seasonId: string;
  affectedIds?: string[];
  rows?: ParsedRow[];
  records?: FlightRecord[];
  deletedIds?: string[];
  modifications?: FlightModification[] | Map<string, FlightModification>;
  syncMeta?: LocalSyncMeta | null;
  windowKey?: SeasonWindowKey;
  operatorSessionEpoch?: number;
}

export interface ApplyServerModificationPatchInput {
  seasonId: string;
  legId: string;
  modification: FlightModification;
  serverSeq: number;
  operatorSessionEpoch: number;
}

export type ApplyServerModificationPatchResult =
  | 'applied'
  | 'ignored-stale'
  | 'missing-target'
  | 'invalid-epoch';

export interface SeasonWorkspaceCounters {
  totalRecords: number;
  activeRecords: number;
  deletedRecords: number;
  arrivalRecords: number;
  departureRecords: number;
  pendingCount: number;
  lastLocalChangeAt: number | null;
}

export interface SeasonWorkspaceSlice {
  season: Season | null;
  rows: ParsedRow[];
  recordsById: Map<string, FlightRecord>;
  recordOrder: string[];
  modificationsByLegId: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
  windowSnapshots: Map<SeasonWindowKey, SeasonWorkspaceWindowSnapshot>;
  windowMetadata: Map<SeasonWindowKey, SeasonWorkspaceWindowMetadata>;
  recordServerHighWater: Map<string, number>;
  modificationServerHighWater: Map<string, number>;
  updatedAt: number;
}

export interface SeasonWorkspaceStoreState {
  seasons: Season[];
  operationalSettings: OperationalSettings | null;
  workspaces: Record<string, SeasonWorkspaceSlice>;
  resetSeasonWorkspaceStore(): void;
  setSeasons(seasons: Season[], operatorSessionEpoch?: number): boolean;
  setOperationalSettings(settings: OperationalSettings | null, operatorSessionEpoch?: number): boolean;
  beginSeasonWindowRequest(seasonId: string, windowKey: SeasonWindowKey): number;
  commitSeasonWindowResult(input: CommitSeasonWindowResultInput): boolean;
  failSeasonWindowRequest(seasonId: string, windowKey: SeasonWindowKey, generation: number, error: unknown): void;
  cancelSeasonWindowRequest(seasonId: string, windowKey: SeasonWindowKey, generation: number): void;
  markSeasonWindowStale(seasonId: string, windowKey: SeasonWindowKey, reason: SeasonWindowStaleReason, operatorSessionEpoch: number): boolean;
  markSeasonWorkspaceStale(seasonId: string, reason: SeasonWindowStaleReason, operatorSessionEpoch: number): boolean;
  replaceSeasonWindow(input: ReplaceSeasonWindowInput): boolean;
  patchSeasonWorkspace(input: PatchSeasonWorkspaceInput): boolean;
  applyServerModificationPatch(input: ApplyServerModificationPatchInput): ApplyServerModificationPatchResult;
}

function createWindowMetadata(): SeasonWorkspaceWindowMetadata {
  return { generation: 0, fetchedAt: null, dataVersion: null, serverHighWater: null, requestStatus: 'idle', staleReason: null, lastError: null };
}

function createEmptyWorkspace(): SeasonWorkspaceSlice {
  return {
    season: null, rows: [], recordsById: new Map(), recordOrder: [], modificationsByLegId: new Map(), syncMeta: null,
    windowSnapshots: new Map(), windowMetadata: new Map(), recordServerHighWater: new Map(), modificationServerHighWater: new Map(), updatedAt: 0,
  };
}

function normalizeModifications(value: FlightModification[] | Map<string, FlightModification> | undefined): Map<string, FlightModification> {
  if (!value) return new Map();
  return value instanceof Map ? new Map(value) : new Map(value.map((mod) => [mod.legId, mod]));
}

function validOptionalEpoch(epoch: number | undefined): boolean {
  return epoch === undefined || isOperatorSessionEpochCurrent(epoch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncMetaAtHighWater(syncMeta: LocalSyncMeta | null, serverHighWater: number): LocalSyncMeta | null {
  if (!syncMeta) return null;
  return {
    ...syncMeta,
    baseServerVersion: Math.max(syncMeta.baseServerVersion, serverHighWater),
    lastServerSeq: Math.max(syncMeta.lastServerSeq ?? -1, serverHighWater),
    localRevision: Math.max(syncMeta.localRevision, serverHighWater),
  };
}

function referencedByAnySnapshot(snapshots: Map<string, SeasonWorkspaceWindowSnapshot>, id: string): boolean {
  for (const snapshot of snapshots.values()) {
    if (snapshot.records.some((record) => record.id === id) || snapshot.modifications.has(id)) return true;
  }
  return false;
}

export const useSeasonWorkspaceStore = create<SeasonWorkspaceStoreState>()((set, get) => ({
  seasons: [],
  operationalSettings: null,
  workspaces: {},
  resetSeasonWorkspaceStore: () => set({ seasons: [], operationalSettings: null, workspaces: {} }),
  setSeasons: (seasons, epoch) => {
    if (!validOptionalEpoch(epoch)) return false;
    set({ seasons });
    return true;
  },
  setOperationalSettings: (operationalSettings, epoch) => {
    if (!validOptionalEpoch(epoch)) return false;
    set({ operationalSettings });
    return true;
  },
  beginSeasonWindowRequest: (seasonId, windowKey) => {
    const state = get();
    const previous = state.workspaces[seasonId] ?? createEmptyWorkspace();
    const metadata = previous.windowMetadata.get(windowKey) ?? createWindowMetadata();
    const windowMetadata = new Map(previous.windowMetadata);
    windowMetadata.set(windowKey, {
      ...metadata,
      requestStatus: previous.windowSnapshots.has(windowKey) ? 'refreshing' : 'loading',
      lastError: null,
    });
    set({ workspaces: { ...state.workspaces, [seasonId]: { ...previous, windowMetadata } } });
    return metadata.generation;
  },
  commitSeasonWindowResult: (input) => {
    if (!isOperatorSessionEpochCurrent(input.operatorSessionEpoch)) return false;
    const state = get();
    const previous = state.workspaces[input.seasonId] ?? createEmptyWorkspace();
    const metadata = previous.windowMetadata.get(input.windowKey) ?? createWindowMetadata();
    if (metadata.generation !== input.requestGeneration) return false;

    const windowSnapshots = new Map(previous.windowSnapshots);
    const previousSnapshot = windowSnapshots.get(input.windowKey);
    const modifications = new Map(input.modifications);

    const recordsById = new Map(previous.recordsById);
    const recordServerHighWater = new Map(previous.recordServerHighWater);
    for (const record of input.records) {
      if (input.serverHighWater >= (recordServerHighWater.get(record.id) ?? -1)) {
        recordsById.set(record.id, record);
        recordServerHighWater.set(record.id, input.serverHighWater);
      }
    }
    const modificationsByLegId = new Map(previous.modificationsByLegId);
    const modificationServerHighWater = new Map(previous.modificationServerHighWater);
    for (const [legId, modification] of modifications) {
      if (input.serverHighWater >= (modificationServerHighWater.get(legId) ?? -1)) {
        modificationsByLegId.set(legId, modification);
        modificationServerHighWater.set(legId, input.serverHighWater);
      }
    }

    const snapshotRecordIds = new Set(input.records.map((record) => record.id));
    const protectedModifications = new Map<string, FlightModification>();
    for (const [legId, modification] of previousSnapshot?.modifications ?? []) {
      if (
        !modifications.has(legId)
        && snapshotRecordIds.has(legId)
        && (modificationServerHighWater.get(legId) ?? -1) > input.serverHighWater
      ) {
        protectedModifications.set(legId, modification);
      }
    }

    for (const record of previousSnapshot?.records ?? []) {
      if (input.records.some((candidate) => candidate.id === record.id) || referencedByAnySnapshot(windowSnapshots, record.id)) continue;
      if ((recordServerHighWater.get(record.id) ?? -1) <= input.serverHighWater) {
        recordsById.delete(record.id);
        recordServerHighWater.delete(record.id);
      }
    }
    for (const legId of previousSnapshot?.modifications.keys() ?? []) {
      if (modifications.has(legId) || referencedByAnySnapshot(windowSnapshots, legId)) continue;
      if ((modificationServerHighWater.get(legId) ?? -1) <= input.serverHighWater) {
        modificationsByLegId.delete(legId);
        modificationServerHighWater.delete(legId);
      }
    }

    const existingOrder = new Set(previous.recordOrder);
    const recordOrder = [
      ...previous.recordOrder.filter((id) => recordsById.has(id)),
      ...input.records.map((record) => record.id).filter((id) => !existingOrder.has(id)),
    ];
    const windowMetadata = new Map(previous.windowMetadata);
    const committedHighWater = Math.max(metadata.serverHighWater ?? -1, input.serverHighWater);
    const committedSyncMeta = syncMetaAtHighWater(input.syncMeta, committedHighWater);
    windowSnapshots.set(input.windowKey, {
      rows: [...input.rows],
      records: input.records.map((record) => recordsById.get(record.id) ?? record),
      modifications: new Map([
        ...Array.from(modifications.keys()).map((legId) => [legId, modificationsByLegId.get(legId) ?? modifications.get(legId)!] as const),
        ...protectedModifications,
      ]),
      syncMeta: committedSyncMeta,
    });
    windowMetadata.set(input.windowKey, {
      generation: metadata.generation,
      fetchedAt: input.fetchedAt,
      dataVersion: input.dataVersion,
      serverHighWater: committedHighWater,
      requestStatus: 'ready',
      staleReason: null,
      lastError: null,
    });
    set({
      workspaces: {
        ...state.workspaces,
        [input.seasonId]: {
          ...previous,
          rows: [...input.rows], recordsById, recordOrder, modificationsByLegId, syncMeta: committedSyncMeta,
          windowSnapshots, windowMetadata, recordServerHighWater, modificationServerHighWater, updatedAt: input.fetchedAt,
        },
      },
    });
    return true;
  },
  failSeasonWindowRequest: (seasonId, windowKey, generation, error) => {
    const state = get();
    const previous = state.workspaces[seasonId];
    const metadata = previous?.windowMetadata.get(windowKey);
    if (!previous || !metadata || metadata.generation !== generation) return;
    const windowMetadata = new Map(previous.windowMetadata);
    windowMetadata.set(windowKey, { ...metadata, requestStatus: 'error', staleReason: 'request-error', lastError: errorMessage(error) });
    set({ workspaces: { ...state.workspaces, [seasonId]: { ...previous, windowMetadata } } });
  },
  cancelSeasonWindowRequest: (seasonId, windowKey, generation) => {
    const state = get();
    const previous = state.workspaces[seasonId];
    const metadata = previous?.windowMetadata.get(windowKey);
    if (!previous || !metadata || metadata.generation !== generation) return;
    const windowMetadata = new Map(previous.windowMetadata);
    windowMetadata.set(windowKey, { ...metadata, requestStatus: previous.windowSnapshots.has(windowKey) ? 'ready' : 'idle' });
    set({ workspaces: { ...state.workspaces, [seasonId]: { ...previous, windowMetadata } } });
  },
  markSeasonWindowStale: (seasonId, windowKey, reason, epoch) => {
    if (!isOperatorSessionEpochCurrent(epoch)) return false;
    const state = get();
    const previous = state.workspaces[seasonId] ?? createEmptyWorkspace();
    const metadata = previous.windowMetadata.get(windowKey) ?? createWindowMetadata();
    const windowMetadata = new Map(previous.windowMetadata);
    windowMetadata.set(windowKey, { ...metadata, generation: metadata.generation + 1, staleReason: reason });
    set({ workspaces: { ...state.workspaces, [seasonId]: { ...previous, windowMetadata, updatedAt: Date.now() } } });
    return true;
  },
  markSeasonWorkspaceStale: (seasonId, reason, epoch) => {
    if (!isOperatorSessionEpochCurrent(epoch)) return false;
    const state = get();
    const previous = state.workspaces[seasonId];
    if (!previous) return true;
    const keys = new Set([...previous.windowMetadata.keys(), ...previous.windowSnapshots.keys()]);
    const windowMetadata = new Map(previous.windowMetadata);
    for (const key of keys) {
      const metadata = windowMetadata.get(key) ?? createWindowMetadata();
      windowMetadata.set(key, { ...metadata, generation: metadata.generation + 1, staleReason: reason });
    }
    set({ workspaces: { ...state.workspaces, [seasonId]: { ...previous, windowMetadata, updatedAt: Date.now() } } });
    return true;
  },
  replaceSeasonWindow: (input) => {
    if (!validOptionalEpoch(input.operatorSessionEpoch)) return false;
    if (input.windowKey) {
      const generation = get().workspaces[input.seasonId]?.windowMetadata.get(input.windowKey)?.generation ?? 0;
      const cursor = input.syncMeta?.lastServerSeq ?? input.syncMeta?.baseServerVersion ?? 0;
      const committed = get().commitSeasonWindowResult({
        seasonId: input.seasonId,
        windowKey: input.windowKey,
        requestGeneration: generation,
        operatorSessionEpoch: input.operatorSessionEpoch ?? getOperatorSessionEpoch(),
        rows: input.rows ?? [],
        records: input.records,
        modifications: normalizeModifications(input.modifications),
        syncMeta: input.syncMeta ?? null,
        fetchedAt: Date.now(),
        dataVersion: input.season?.dataVersion ?? cursor,
        serverHighWater: cursor,
      });
      if (committed && input.season !== undefined) {
        const state = get();
        const current = state.workspaces[input.seasonId];
        if (current) set({ workspaces: { ...state.workspaces, [input.seasonId]: { ...current, season: input.season } } });
      }
      return committed;
    }
    const state = get();
    const previous = state.workspaces[input.seasonId] ?? createEmptyWorkspace();
    const recordsById = new Map(input.records.map((record) => [record.id, record]));
    set({ workspaces: { ...state.workspaces, [input.seasonId]: {
      ...previous,
      season: input.season === undefined ? previous.season : input.season,
      rows: input.rows ?? previous.rows,
      recordsById,
      recordOrder: input.records.map((record) => record.id),
      modificationsByLegId: normalizeModifications(input.modifications),
      syncMeta: input.syncMeta === undefined ? previous.syncMeta : input.syncMeta,
      updatedAt: Date.now(),
    } } });
    return true;
  },
  patchSeasonWorkspace: (input) => {
    if (!validOptionalEpoch(input.operatorSessionEpoch)) return false;
    const state = get();
    const previous = state.workspaces[input.seasonId] ?? createEmptyWorkspace();
    const recordsById = new Map(previous.recordsById);
    const deletedIds = new Set(input.deletedIds ?? []);
    for (const id of deletedIds) recordsById.delete(id);
    for (const record of input.records ?? []) recordsById.set(record.id, record);
    const modificationsByLegId = new Map(previous.modificationsByLegId);
    for (const [legId, modification] of normalizeModifications(input.modifications)) modificationsByLegId.set(legId, modification);

    const recordUpdates = new Map((input.records ?? []).map((record) => [record.id, record]));
    const modificationUpdates = normalizeModifications(input.modifications);
    const windowSnapshots = new Map(previous.windowSnapshots);
    for (const [key, snapshot] of windowSnapshots) {
      const snapshotRecordIds = new Set(snapshot.records.map((record) => record.id));
      const nextSnapshotModifications = new Map(
        [...snapshot.modifications]
          .filter(([legId]) => !deletedIds.has(legId))
          .map(([legId, mod]) => [legId, modificationUpdates.get(legId) ?? mod]),
      );
      for (const [legId, modification] of modificationUpdates) {
        if (snapshotRecordIds.has(legId)) nextSnapshotModifications.set(legId, modification);
      }
      windowSnapshots.set(key, {
        ...snapshot,
        rows: input.rows ?? snapshot.rows,
        records: snapshot.records.filter((record) => !deletedIds.has(record.id)).map((record) => recordUpdates.get(record.id) ?? record),
        modifications: nextSnapshotModifications,
        syncMeta: input.syncMeta === undefined ? snapshot.syncMeta : input.syncMeta,
      });
    }
    const windowMetadata = new Map(previous.windowMetadata);
    for (const key of new Set([...windowMetadata.keys(), ...windowSnapshots.keys()])) {
      const metadata = windowMetadata.get(key) ?? createWindowMetadata();
      windowMetadata.set(key, { ...metadata, generation: metadata.generation + 1, staleReason: 'mutation' });
    }
    const addedRecordIds = (input.records ?? []).map((record) => record.id).filter((id) => !previous.recordsById.has(id));
    const recordOrder = deletedIds.size === 0 && addedRecordIds.length === 0
      ? previous.recordOrder
      : [...previous.recordOrder.filter((id) => recordsById.has(id)), ...addedRecordIds];
    set({ workspaces: { ...state.workspaces, [input.seasonId]: {
      ...previous,
      rows: input.rows ?? previous.rows,
      recordsById, recordOrder, modificationsByLegId,
      syncMeta: input.syncMeta === undefined ? previous.syncMeta : input.syncMeta,
      windowSnapshots, windowMetadata, updatedAt: Date.now(),
    } } });
    return true;
  },
  applyServerModificationPatch: (input) => {
    if (!isOperatorSessionEpochCurrent(input.operatorSessionEpoch)) return 'invalid-epoch';
    if (!Number.isFinite(input.serverSeq) || input.modification.legId !== input.legId) return 'missing-target';
    const state = get();
    const previous = state.workspaces[input.seasonId];
    if (!previous) return 'missing-target';
    const currentHighWater = previous.modificationServerHighWater.get(input.legId);
    if (currentHighWater != null && input.serverSeq <= currentHighWater) return 'ignored-stale';

    const targetExists = previous.recordsById.has(input.legId)
      || previous.modificationsByLegId.has(input.legId)
      || referencedByAnySnapshot(previous.windowSnapshots, input.legId);
    if (!targetExists) return 'missing-target';

    const modificationsByLegId = new Map(previous.modificationsByLegId);
    const currentModification = modificationsByLegId.get(input.legId);
    const mergedModification = currentModification
      ? { ...currentModification, ...input.modification }
      : input.modification;
    modificationsByLegId.set(input.legId, mergedModification);
    const modificationServerHighWater = new Map(previous.modificationServerHighWater);
    modificationServerHighWater.set(input.legId, input.serverSeq);

    const windowSnapshots = new Map(previous.windowSnapshots);
    for (const [key, snapshot] of previous.windowSnapshots) {
      const containsTarget = snapshot.modifications.has(input.legId)
        || snapshot.records.some((record) => record.id === input.legId);
      if (!containsTarget) continue;
      const modifications = new Map(snapshot.modifications);
      const currentSnapshotModification = modifications.get(input.legId);
      modifications.set(
        input.legId,
        currentSnapshotModification
          ? { ...currentSnapshotModification, ...input.modification }
          : input.modification,
      );
      windowSnapshots.set(key, {
        ...snapshot,
        modifications,
        syncMeta: syncMetaAtHighWater(snapshot.syncMeta, input.serverSeq),
      });
    }

    const windowMetadata = new Map(previous.windowMetadata);
    for (const key of new Set([...previous.windowMetadata.keys(), ...previous.windowSnapshots.keys()])) {
      const metadata = previous.windowMetadata.get(key) ?? createWindowMetadata();
      windowMetadata.set(key, {
        ...metadata,
        serverHighWater: Math.max(metadata.serverHighWater ?? -1, input.serverSeq),
      });
    }

    set({
      workspaces: {
        ...state.workspaces,
        [input.seasonId]: {
          ...previous,
          modificationsByLegId,
          modificationServerHighWater,
          windowSnapshots,
          windowMetadata,
          syncMeta: syncMetaAtHighWater(previous.syncMeta, input.serverSeq),
          updatedAt: Date.now(),
        },
      },
    });
    return 'applied';
  },
}));

export function selectSeasonRecordOrder(state: SeasonWorkspaceStoreState, seasonId: string): string[] {
  return state.workspaces[seasonId]?.recordOrder ?? [];
}

export function selectSeasonRecords(state: SeasonWorkspaceStoreState, seasonId: string): FlightRecord[] {
  const workspace = state.workspaces[seasonId];
  if (!workspace) return [];
  return workspace.recordOrder.map((id) => workspace.recordsById.get(id)).filter((record): record is FlightRecord => Boolean(record));
}

export function selectSeasonModifications(state: SeasonWorkspaceStoreState, seasonId: string): Map<string, FlightModification> {
  return state.workspaces[seasonId]?.modificationsByLegId ?? new Map();
}

export function selectSeasonSyncMeta(state: SeasonWorkspaceStoreState, seasonId: string): LocalSyncMeta | null {
  return state.workspaces[seasonId]?.syncMeta ?? null;
}

export function selectSeasonWorkspaceCounters(state: SeasonWorkspaceStoreState, seasonId: string): SeasonWorkspaceCounters {
  const workspace = state.workspaces[seasonId];
  if (!workspace) return { totalRecords: 0, activeRecords: 0, deletedRecords: 0, arrivalRecords: 0, departureRecords: 0, pendingCount: 0, lastLocalChangeAt: null };
  let activeRecords = 0; let deletedRecords = 0; let arrivalRecords = 0; let departureRecords = 0;
  for (const record of workspace.recordsById.values()) {
    if (record.status === 'deleted') deletedRecords += 1; else activeRecords += 1;
    if (record.type === 'A') arrivalRecords += 1;
    if (record.type === 'D') departureRecords += 1;
  }
  return {
    totalRecords: workspace.recordsById.size, activeRecords, deletedRecords, arrivalRecords, departureRecords,
    pendingCount: workspace.syncMeta?.pendingCount ?? 0, lastLocalChangeAt: workspace.syncMeta?.lastLocalChangeAt ?? null,
  };
}
