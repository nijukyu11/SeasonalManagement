import { create } from 'zustand';
import type { LocalSyncMeta } from './localSeasonStore';
import type { FlightModification, FlightRecord, OperationalSettings, ParsedRow, Season } from './types';

export type SeasonWindowKey = string;

export interface SeasonWorkspaceCounters {
  totalRecords: number;
  activeRecords: number;
  deletedRecords: number;
  arrivalRecords: number;
  departureRecords: number;
  pendingCount: number;
  lastLocalChangeAt: number | null;
}

export interface ReplaceSeasonWindowInput {
  seasonId: string;
  season?: Season | null;
  rows?: ParsedRow[];
  records: FlightRecord[];
  modifications: FlightModification[] | Map<string, FlightModification>;
  syncMeta?: LocalSyncMeta | null;
  windowKey?: SeasonWindowKey;
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
}

export interface SeasonWorkspaceSlice {
  season: Season | null;
  rows: ParsedRow[];
  recordsById: Map<string, FlightRecord>;
  recordOrder: string[];
  modificationsByLegId: Map<string, FlightModification>;
  syncMeta: LocalSyncMeta | null;
  windowIds: Map<SeasonWindowKey, string[]>;
  staleWindowKeys: Set<SeasonWindowKey>;
  updatedAt: number;
}

export interface SeasonWorkspaceStoreState {
  seasons: Season[];
  operationalSettings: OperationalSettings | null;
  workspaces: Record<string, SeasonWorkspaceSlice>;
  resetSeasonWorkspaceStore: () => void;
  setSeasons: (seasons: Season[]) => void;
  setOperationalSettings: (settings: OperationalSettings | null) => void;
  replaceSeasonWindow: (input: ReplaceSeasonWindowInput) => void;
  patchSeasonWorkspace: (input: PatchSeasonWorkspaceInput) => void;
  markSeasonWindowStale: (seasonId: string, windowKey: SeasonWindowKey) => void;
  clearSeasonWindowStale: (seasonId: string, windowKey: SeasonWindowKey) => void;
}

function createEmptyWorkspace(): SeasonWorkspaceSlice {
  return {
    season: null,
    rows: [],
    recordsById: new Map(),
    recordOrder: [],
    modificationsByLegId: new Map(),
    syncMeta: null,
    windowIds: new Map(),
    staleWindowKeys: new Set(),
    updatedAt: 0,
  };
}

function normalizeModifications(
  modifications: FlightModification[] | Map<string, FlightModification> | undefined
): Map<string, FlightModification> {
  if (!modifications) return new Map();
  if (modifications instanceof Map) return new Map(modifications);
  return new Map(modifications.map((mod) => [mod.legId, mod]));
}

function replaceOrCreateWorkspace(
  current: SeasonWorkspaceSlice | undefined,
  input: ReplaceSeasonWindowInput,
  updatedAt: number
): SeasonWorkspaceSlice {
  const previous = current ?? createEmptyWorkspace();
  const nextWindowIds = input.records.map((record) => record.id);
  const previousWindowIds = input.windowKey ? previous.windowIds.get(input.windowKey) ?? [] : [];
  const recordsById = new Map(previous.recordsById);
  for (const record of input.records) recordsById.set(record.id, record);

  const windowIds = new Map(previous.windowIds);
  const staleWindowKeys = new Set(previous.staleWindowKeys);
  if (input.windowKey) {
    windowIds.set(input.windowKey, nextWindowIds);
    staleWindowKeys.delete(input.windowKey);
  }

  const retainedWindowIds = new Set<string>();
  if (input.windowKey) {
    for (const [key, ids] of windowIds) {
      if (key === input.windowKey) continue;
      for (const id of ids) retainedWindowIds.add(id);
    }
  }

  const nextWindowIdSet = new Set(nextWindowIds);
  for (const id of previousWindowIds) {
    if (nextWindowIdSet.has(id)) continue;
    if (!retainedWindowIds.has(id)) recordsById.delete(id);
  }

  const previousRecordOrderSet = new Set(previous.recordOrder);
  const recordOrder = [
    ...previous.recordOrder.filter((id) => recordsById.has(id)),
    ...nextWindowIds.filter((id) => !previousRecordOrderSet.has(id) && recordsById.has(id)),
  ];

  const modificationsByLegId = new Map(previous.modificationsByLegId);
  for (const id of nextWindowIds) modificationsByLegId.delete(id);
  for (const [legId, modification] of normalizeModifications(input.modifications)) {
    modificationsByLegId.set(legId, modification);
  }

  return {
    season: input.season === undefined ? previous.season : input.season,
    rows: input.rows ?? previous.rows,
    recordsById,
    recordOrder,
    modificationsByLegId,
    syncMeta: input.syncMeta === undefined ? previous.syncMeta : input.syncMeta,
    windowIds,
    staleWindowKeys,
    updatedAt,
  };
}

function patchExistingWorkspace(
  current: SeasonWorkspaceSlice | undefined,
  input: PatchSeasonWorkspaceInput,
  updatedAt: number
): SeasonWorkspaceSlice {
  const previous = current ?? createEmptyWorkspace();
  const recordsById = new Map(previous.recordsById);
  const deletedIds = new Set(input.deletedIds ?? []);
  let orderChanged = false;

  for (const id of deletedIds) {
    if (recordsById.delete(id)) orderChanged = true;
  }

  for (const record of input.records ?? []) {
    if (!recordsById.has(record.id)) orderChanged = true;
    recordsById.set(record.id, record);
  }

  const recordOrder = orderChanged
    ? [
        ...previous.recordOrder.filter((id) => recordsById.has(id)),
        ...(input.records ?? [])
          .map((record) => record.id)
          .filter((id) => !previous.recordOrder.includes(id) && recordsById.has(id)),
      ]
    : previous.recordOrder;

  const modificationsByLegId = new Map(previous.modificationsByLegId);
  for (const [legId, modification] of normalizeModifications(input.modifications)) {
    modificationsByLegId.set(legId, modification);
  }

  const affectedIds = new Set([
    ...(input.affectedIds ?? []),
    ...(input.records ?? []).map((record) => record.id),
    ...deletedIds,
    ...normalizeModifications(input.modifications).keys(),
  ]);
  const staleWindowKeys = new Set(previous.staleWindowKeys);
  if (affectedIds.size > 0) {
    for (const [windowKey, ids] of previous.windowIds) {
      if (ids.some((id) => affectedIds.has(id))) staleWindowKeys.add(windowKey);
    }
  }
  if (input.windowKey) staleWindowKeys.delete(input.windowKey);

  return {
    ...previous,
    rows: input.rows ?? previous.rows,
    recordsById,
    recordOrder,
    modificationsByLegId,
    syncMeta: input.syncMeta === undefined ? previous.syncMeta : input.syncMeta,
    staleWindowKeys,
    updatedAt,
  };
}

export const useSeasonWorkspaceStore = create<SeasonWorkspaceStoreState>()((set) => ({
  seasons: [],
  operationalSettings: null,
  workspaces: {},
  resetSeasonWorkspaceStore: () => set({
    seasons: [],
    operationalSettings: null,
    workspaces: {},
  }),
  setSeasons: (seasons) => set({ seasons }),
  setOperationalSettings: (settings) => set({ operationalSettings: settings }),
  replaceSeasonWindow: (input) => set((state) => ({
    workspaces: {
      ...state.workspaces,
      [input.seasonId]: replaceOrCreateWorkspace(state.workspaces[input.seasonId], input, Date.now()),
    },
  })),
  patchSeasonWorkspace: (input) => set((state) => ({
    workspaces: {
      ...state.workspaces,
      [input.seasonId]: patchExistingWorkspace(state.workspaces[input.seasonId], input, Date.now()),
    },
  })),
  markSeasonWindowStale: (seasonId, windowKey) => set((state) => {
    const current = state.workspaces[seasonId] ?? createEmptyWorkspace();
    const staleWindowKeys = new Set(current.staleWindowKeys);
    staleWindowKeys.add(windowKey);
    return {
      workspaces: {
        ...state.workspaces,
        [seasonId]: {
          ...current,
          staleWindowKeys,
          updatedAt: Date.now(),
        },
      },
    };
  }),
  clearSeasonWindowStale: (seasonId, windowKey) => set((state) => {
    const current = state.workspaces[seasonId];
    if (!current || !current.staleWindowKeys.has(windowKey)) return state;
    const staleWindowKeys = new Set(current.staleWindowKeys);
    staleWindowKeys.delete(windowKey);
    return {
      workspaces: {
        ...state.workspaces,
        [seasonId]: {
          ...current,
          staleWindowKeys,
          updatedAt: Date.now(),
        },
      },
    };
  }),
}));

export function selectSeasonRecordOrder(
  state: SeasonWorkspaceStoreState,
  seasonId: string
): string[] {
  return state.workspaces[seasonId]?.recordOrder ?? [];
}

export function selectSeasonRecords(
  state: SeasonWorkspaceStoreState,
  seasonId: string
): FlightRecord[] {
  const workspace = state.workspaces[seasonId];
  if (!workspace) return [];
  return workspace.recordOrder
    .map((id) => workspace.recordsById.get(id))
    .filter((record): record is FlightRecord => Boolean(record));
}

export function selectSeasonModifications(
  state: SeasonWorkspaceStoreState,
  seasonId: string
): Map<string, FlightModification> {
  return state.workspaces[seasonId]?.modificationsByLegId ?? new Map();
}

export function selectSeasonSyncMeta(
  state: SeasonWorkspaceStoreState,
  seasonId: string
): LocalSyncMeta | null {
  return state.workspaces[seasonId]?.syncMeta ?? null;
}

export function selectSeasonWorkspaceCounters(
  state: SeasonWorkspaceStoreState,
  seasonId: string
): SeasonWorkspaceCounters {
  const workspace = state.workspaces[seasonId];
  if (!workspace) {
    return {
      totalRecords: 0,
      activeRecords: 0,
      deletedRecords: 0,
      arrivalRecords: 0,
      departureRecords: 0,
      pendingCount: 0,
      lastLocalChangeAt: null,
    };
  }

  let activeRecords = 0;
  let deletedRecords = 0;
  let arrivalRecords = 0;
  let departureRecords = 0;
  for (const record of workspace.recordsById.values()) {
    if (record.status === 'deleted') deletedRecords += 1;
    else activeRecords += 1;
    if (record.type === 'A') arrivalRecords += 1;
    if (record.type === 'D') departureRecords += 1;
  }

  return {
    totalRecords: workspace.recordsById.size,
    activeRecords,
    deletedRecords,
    arrivalRecords,
    departureRecords,
    pendingCount: workspace.syncMeta?.pendingCount ?? 0,
    lastLocalChangeAt: workspace.syncMeta?.lastLocalChangeAt ?? null,
  };
}
