import type { FlightModification, FlightRecord, ModHistoryEntry, ParsedRow } from './types';
import {
  deserializeModificationEntries,
  rebuildPendingOpsFromBaseline,
  serializeModificationMap,
  type LocalEntityVersionMap,
  type LocalPendingOp,
  type LocalSeasonWorkspace,
} from './localSeasonStore';

export type SeasonChangeTargetType = 'flightRecord' | 'sourceRow' | 'modification' | 'modHistory';
export type SeasonConflictResolution = 'keepMine' | 'acceptRemote' | 'editManually';

export interface SeasonChangeEventPayload {
  type: LocalPendingOp['type'];
  record?: FlightRecord | { id: string; [key: string]: unknown };
  row?: ParsedRow | { rowIndex: number; [key: string]: unknown };
  mod?: FlightModification;
  legId?: string;
  entry?: ModHistoryEntry;
  baseEntityVersion?: number;
  baseFieldVersions?: Record<string, number>;
}

export interface SeasonChangeEvent {
  eventId: string;
  seasonId: string;
  clientId: string;
  opId: string;
  actorUserId?: string | null;
  serverSeq: number | null;
  targetType: SeasonChangeTargetType;
  targetId: string;
  changedFields: string[];
  opPayload: SeasonChangeEventPayload;
  createdAt: string;
}

export interface SeasonConflictItem {
  id: string;
  event: SeasonChangeEvent;
  targetType: SeasonChangeTargetType;
  targetId: string;
  overlappingFields: string[];
  localFields: Record<string, unknown>;
  remoteFields: Record<string, unknown>;
  createdAt: number;
  message: string;
}

export interface MergeRemoteSeasonEventResult {
  workspace: LocalSeasonWorkspace;
  applied: boolean;
  conflict: boolean;
  skipped: boolean;
  autoResolvedConflictCount?: number;
  autoResolvedConflictIds?: string[];
}

const DELETE_FIELD = '__delete__';
export const AUTO_REMOTE_WIN_MODIFICATION_FIELDS = [
  'counter',
  'checkInStart',
  'checkInEnd',
  'checkInAllocationMode',
  'checkInCounterWindows',
  'gate',
  'stand',
  'bhs',
] as const;
const AUTO_REMOTE_WIN_MODIFICATION_FIELD_SET = new Set<string>(AUTO_REMOTE_WIN_MODIFICATION_FIELDS);
export const LOCAL_CLIENT_STORAGE_KEY = 'seasonal-management-sync-client-id';

let memoryClientId: string | null = null;

function randomId(prefix: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function getOrCreateSeasonClientId(): string {
  if (memoryClientId) return memoryClientId;
  if (typeof window !== 'undefined' && window.localStorage) {
    const stored = window.localStorage.getItem(LOCAL_CLIENT_STORAGE_KEY);
    if (stored) {
      memoryClientId = stored;
      return stored;
    }
    const next = randomId('client');
    window.localStorage.setItem(LOCAL_CLIENT_STORAGE_KEY, next);
    memoryClientId = next;
    return next;
  }
  memoryClientId = randomId('client');
  return memoryClientId;
}

export function resetSeasonClientIdMemory(): void {
  memoryClientId = null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

function isSameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function changedKeys(
  current: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  ignored: Set<string>
): string[] {
  const keys = new Set<string>(Object.keys(current));
  for (const key of Object.keys(base ?? {})) keys.add(key);
  return Array.from(keys)
    .filter((key) => !ignored.has(key))
    .filter((key) => !isSameValue(current[key], base?.[key]))
    .sort((a, b) => a.localeCompare(b));
}

function opTarget(op: LocalPendingOp): { targetType: SeasonChangeTargetType; targetId: string; changedFields: string[] } {
  if (op.type === 'flightRecord') {
    return { targetType: 'flightRecord', targetId: String(op.record.id), changedFields: [] };
  }
  if (op.type === 'sourceRow') {
    return { targetType: 'sourceRow', targetId: String(op.row.rowIndex), changedFields: [] };
  }
  if (op.type === 'modification') {
    return { targetType: 'modification', targetId: op.mod.legId, changedFields: [] };
  }
  if (op.type === 'modificationDelete') {
    return { targetType: 'modification', targetId: op.legId, changedFields: [DELETE_FIELD] };
  }
  return { targetType: 'modHistory', targetId: op.entry.id, changedFields: ['entry'] };
}

function eventPayloadForOp(op: LocalPendingOp, baseFieldVersions: Record<string, number>): SeasonChangeEventPayload {
  if (op.type === 'flightRecord') return { type: op.type, record: op.record, baseFieldVersions };
  if (op.type === 'sourceRow') return { type: op.type, row: op.row, baseFieldVersions };
  if (op.type === 'modification') return { type: op.type, mod: op.mod, baseFieldVersions };
  if (op.type === 'modificationDelete') return { type: op.type, legId: op.legId, baseFieldVersions };
  return { type: op.type, entry: op.entry, baseFieldVersions };
}

export function seasonEventTargetKey(targetType: SeasonChangeTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

function baseFieldVersionMapFromWorkspace(
  workspace: LocalSeasonWorkspace,
  targetType: SeasonChangeTargetType,
  targetId: string,
  fields: string[]
): Record<string, number> {
  const versions = workspace.entityVersions?.[seasonEventTargetKey(targetType, targetId)] ?? {};
  return fields.reduce<Record<string, number>>((acc, field) => {
    acc[field] = versions[field] ?? 0;
    return acc;
  }, {});
}

export function buildPendingChangeEvents(
  workspace: LocalSeasonWorkspace,
  options: { clientId?: string; now?: number; actorUserId?: string | null } = {}
): SeasonChangeEvent[] {
  const clientId = options.clientId ?? workspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
  const now = options.now ?? Date.now();
  const baseRecordsById = new Map(workspace.baseRecords.map((record) => [record.id, record]));
  const baseMods = deserializeModificationEntries(workspace.baseModificationEntries);

  return workspace.pendingOps.filter((op) => op.type !== 'sourceRow').map((op) => {
    const target = opTarget(op);
    let changedFields = target.changedFields;
    if (op.type === 'flightRecord') {
      changedFields = changedKeys(
        op.record as Record<string, unknown>,
        baseRecordsById.get(String(op.record.id)) as unknown as Record<string, unknown> | undefined,
        new Set(['id'])
      );
    } else if (op.type === 'modification') {
      changedFields = changedKeys(
        op.mod as unknown as Record<string, unknown>,
        baseMods.get(op.mod.legId) as unknown as Record<string, unknown> | undefined,
        new Set(['legId'])
      );
    }
    if (changedFields.length === 0) changedFields = target.changedFields.length > 0 ? target.changedFields : ['payload'];

    const opFingerprint = { seasonId: workspace.season.id, target, changedFields, op };
    const opId = `${clientId}:${target.targetType}:${target.targetId}:${stableHash(opFingerprint)}`;
    const baseFieldVersions = baseFieldVersionMapFromWorkspace(
      workspace,
      target.targetType,
      target.targetId,
      changedFields
    );
    return {
      eventId: randomId('event'),
      seasonId: workspace.season.id,
      clientId,
      opId,
      actorUserId: options.actorUserId ?? null,
      serverSeq: null,
      targetType: target.targetType,
      targetId: target.targetId,
      changedFields,
      opPayload: eventPayloadForOp(op, baseFieldVersions),
      createdAt: new Date(now).toISOString(),
    };
  });
}

function eventKey(event: Pick<SeasonChangeEvent, 'eventId' | 'opId'>): string {
  return event.eventId || event.opId;
}

function sameTarget(left: Pick<SeasonChangeEvent, 'targetType' | 'targetId'>, right: Pick<SeasonChangeEvent, 'targetType' | 'targetId'>): boolean {
  return left.targetType === right.targetType && left.targetId === right.targetId;
}

function findOverlappingFields(localFields: string[], remoteFields: string[]): string[] {
  if (localFields.includes(DELETE_FIELD) || remoteFields.includes(DELETE_FIELD)) {
    return Array.from(new Set([...localFields, ...remoteFields]));
  }
  const remote = new Set(remoteFields);
  return localFields.filter((field) => remote.has(field));
}

export function isAutoResolvableRemoteLatestConflict(
  event: Pick<SeasonChangeEvent, 'targetType' | 'changedFields'>
): boolean {
  return event.targetType === 'modification' &&
    event.changedFields.length === 1 &&
    AUTO_REMOTE_WIN_MODIFICATION_FIELD_SET.has(event.changedFields[0]);
}

function readPayloadEntity(event: SeasonChangeEvent): Record<string, unknown> | null {
  if (event.opPayload.type === 'flightRecord') return event.opPayload.record as Record<string, unknown>;
  if (event.opPayload.type === 'sourceRow') return event.opPayload.row as Record<string, unknown>;
  if (event.opPayload.type === 'modification') return event.opPayload.mod as unknown as Record<string, unknown>;
  if (event.opPayload.type === 'modHistory') return event.opPayload.entry as unknown as Record<string, unknown>;
  return null;
}

function readLocalEntity(workspace: LocalSeasonWorkspace, event: SeasonChangeEvent): Record<string, unknown> | null {
  if (event.targetType === 'flightRecord') {
    return workspace.records.find((record) => record.id === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (event.targetType === 'sourceRow') {
    return workspace.rows.find((row) => String(row.rowIndex) === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (event.targetType === 'modification') {
    return workspace.modifications.get(event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  return workspace.modHistory.find((entry) => entry.id === event.targetId) as unknown as Record<string, unknown> | undefined ?? null;
}

function pickFields(source: Record<string, unknown> | null, fields: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) output[field] = source?.[field] ?? null;
  return output;
}

function buildConflict(workspace: LocalSeasonWorkspace, event: SeasonChangeEvent, overlappingFields: string[]): SeasonConflictItem {
  const localEntity = readLocalEntity(workspace, event);
  const remoteEntity = readPayloadEntity(event);
  return {
    id: `${eventKey(event)}:${event.targetType}:${event.targetId}:${overlappingFields.join(',')}`,
    event,
    targetType: event.targetType,
    targetId: event.targetId,
    overlappingFields,
    localFields: pickFields(localEntity, overlappingFields),
    remoteFields: pickFields(remoteEntity, overlappingFields),
    createdAt: Date.now(),
    message: `Remote ${event.targetType} ${event.targetId} changed ${overlappingFields.join(', ')} while local edits were pending.`,
  };
}

function mergeConflicts(existing: SeasonConflictItem[] | undefined, incoming: SeasonConflictItem[]): SeasonConflictItem[] {
  const byId = new Map((existing ?? []).map((conflict) => [conflict.id, conflict]));
  for (const conflict of incoming) byId.set(conflict.id, conflict);
  return Array.from(byId.values());
}

function mergeRecordFields<T extends Record<string, unknown>>(current: T | undefined, remote: T, changedFields: string[]): T {
  const next = { ...(current ?? remote) } as Record<string, unknown>;
  for (const field of changedFields) {
    if (field === DELETE_FIELD) continue;
    next[field] = remote[field];
  }
  return next as T;
}

function upsertById<T extends Record<string, unknown>>(items: T[], idKey: string, id: string, value: T): T[] {
  let found = false;
  const next = items.map((item) => {
    if (String(item[idKey]) !== id) return item;
    found = true;
    return value;
  });
  if (!found) next.push(value);
  return next;
}

function readWorkspaceEntityByTarget(
  workspace: LocalSeasonWorkspace,
  targetType: SeasonChangeTargetType,
  targetId: string
): Record<string, unknown> | null {
  if (targetType === 'flightRecord') {
    return workspace.records.find((record) => record.id === targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (targetType === 'sourceRow') {
    return workspace.rows.find((row) => String(row.rowIndex) === targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (targetType === 'modification') {
    return workspace.modifications.get(targetId) as unknown as Record<string, unknown> | undefined ?? null;
  }
  return workspace.modHistory.find((entry) => entry.id === targetId) as unknown as Record<string, unknown> | undefined ?? null;
}

function eventWithSnapshotPayload(
  event: SeasonChangeEvent,
  snapshot: LocalSeasonWorkspace,
  changedFields: string[]
): SeasonChangeEvent {
  const remoteEntity = readWorkspaceEntityByTarget(snapshot, event.targetType, event.targetId);
  const baseFieldVersions = event.opPayload.baseFieldVersions ?? {};
  const opPayload: SeasonChangeEventPayload = event.targetType === 'flightRecord'
    ? { type: 'flightRecord', record: remoteEntity as unknown as FlightRecord, baseFieldVersions }
    : event.targetType === 'sourceRow'
      ? { type: 'sourceRow', row: remoteEntity as unknown as ParsedRow, baseFieldVersions }
      : event.targetType === 'modHistory'
        ? { type: 'modHistory', entry: remoteEntity as unknown as ModHistoryEntry, baseFieldVersions }
        : remoteEntity
          ? { type: 'modification', mod: remoteEntity as unknown as FlightModification, baseFieldVersions }
          : { type: 'modificationDelete', legId: event.targetId, baseFieldVersions };
  return {
    ...event,
    eventId: `snapshot:${event.opId}`,
    clientId: 'server-snapshot',
    serverSeq: snapshot.syncMeta.lastServerSeq ?? null,
    changedFields,
    opPayload,
    createdAt: new Date().toISOString(),
  };
}

function applyLocalEventPatchToSnapshot(
  workspace: LocalSeasonWorkspace,
  event: SeasonChangeEvent
): LocalSeasonWorkspace {
  if (event.targetType === 'flightRecord' && event.opPayload.record) {
    const local = event.opPayload.record as unknown as Record<string, unknown>;
    const current = workspace.records.find((record) => record.id === event.targetId) as unknown as Record<string, unknown> | undefined;
    const patched = mergeRecordFields(current, local, event.changedFields) as unknown as FlightRecord;
    return {
      ...workspace,
      records: upsertById(workspace.records as unknown as Array<Record<string, unknown>>, 'id', event.targetId, patched as unknown as Record<string, unknown>) as unknown as FlightRecord[],
    };
  }
  if (event.targetType === 'sourceRow' && event.opPayload.row) {
    const local = event.opPayload.row as unknown as Record<string, unknown>;
    const current = workspace.rows.find((row) => String(row.rowIndex) === event.targetId) as unknown as Record<string, unknown> | undefined;
    const patched = mergeRecordFields(current, local, event.changedFields) as unknown as ParsedRow;
    return {
      ...workspace,
      rows: upsertById(workspace.rows as unknown as Array<Record<string, unknown>>, 'rowIndex', event.targetId, patched as unknown as Record<string, unknown>) as unknown as ParsedRow[],
    };
  }
  if (event.targetType === 'modification') {
    const mods = new Map(workspace.modifications);
    if (event.opPayload.type === 'modificationDelete' || event.changedFields.includes(DELETE_FIELD)) {
      mods.delete(event.targetId);
      return { ...workspace, modifications: mods };
    }
    if (event.opPayload.mod) {
      const current = mods.get(event.targetId) as unknown as Record<string, unknown> | undefined;
      const patched = mergeRecordFields(current, event.opPayload.mod as unknown as Record<string, unknown>, event.changedFields) as unknown as FlightModification;
      mods.set(event.targetId, patched);
      return { ...workspace, modifications: mods };
    }
  }
  if (event.targetType === 'modHistory' && event.opPayload.entry) {
    const exists = workspace.modHistory.some((entry) => entry.id === event.targetId);
    return exists ? workspace : { ...workspace, modHistory: [event.opPayload.entry, ...workspace.modHistory] };
  }
  return workspace;
}

function updateEntityVersionsForEvent(
  entityVersions: LocalEntityVersionMap,
  event: SeasonChangeEvent
): LocalEntityVersionMap {
  const serverSeq = event.serverSeq ?? 0;
  if (serverSeq <= 0) return entityVersions;
  const targetKey = seasonEventTargetKey(event.targetType, event.targetId);
  const currentTarget = entityVersions[targetKey] ?? {};
  const nextTarget = { ...currentTarget };
  for (const field of event.changedFields) {
    nextTarget[field] = Math.max(nextTarget[field] ?? 0, serverSeq);
  }
  return {
    ...entityVersions,
    [targetKey]: nextTarget,
  };
}

function markSeasonEventSeen(workspace: LocalSeasonWorkspace, event: SeasonChangeEvent): LocalSeasonWorkspace {
  return {
    ...workspace,
    entityVersions: updateEntityVersionsForEvent(workspace.entityVersions, event),
    syncMeta: {
      ...workspace.syncMeta,
      lastServerSeq: Math.max(workspace.syncMeta.lastServerSeq ?? 0, event.serverSeq ?? 0),
      appliedEventIds: Array.from(new Set([...(workspace.syncMeta.appliedEventIds ?? []), eventKey(event)])).slice(-200),
    },
  };
}

function applyEventToWorkspace(
  workspace: LocalSeasonWorkspace,
  event: SeasonChangeEvent,
  options: { force?: boolean } = {}
): LocalSeasonWorkspace {
  let next: LocalSeasonWorkspace = markSeasonEventSeen(workspace, event);

  if (event.targetType === 'flightRecord' && event.opPayload.record) {
    const remote = event.opPayload.record as FlightRecord;
    const current = next.records.find((record) => record.id === event.targetId) as unknown as Record<string, unknown> | undefined;
    const mergedCurrent = options.force ? remote : mergeRecordFields(current, remote as unknown as Record<string, unknown>, event.changedFields) as unknown as FlightRecord;
    next = {
      ...next,
      records: upsertById(next.records as unknown as Array<Record<string, unknown>>, 'id', event.targetId, mergedCurrent as unknown as Record<string, unknown>) as unknown as FlightRecord[],
      baseRecords: upsertById(next.baseRecords as unknown as Array<Record<string, unknown>>, 'id', event.targetId, remote as unknown as Record<string, unknown>) as unknown as FlightRecord[],
    };
  } else if (event.targetType === 'sourceRow' && event.opPayload.row) {
    const remote = event.opPayload.row as ParsedRow;
    const current = next.rows.find((row) => String(row.rowIndex) === event.targetId) as unknown as Record<string, unknown> | undefined;
    const mergedCurrent = options.force ? remote : mergeRecordFields(current, remote as unknown as Record<string, unknown>, event.changedFields) as unknown as ParsedRow;
    next = {
      ...next,
      rows: upsertById(next.rows as unknown as Array<Record<string, unknown>>, 'rowIndex', event.targetId, mergedCurrent as unknown as Record<string, unknown>) as unknown as ParsedRow[],
      baseRows: upsertById(next.baseRows as unknown as Array<Record<string, unknown>>, 'rowIndex', event.targetId, remote as unknown as Record<string, unknown>) as unknown as ParsedRow[],
    };
  } else if (event.targetType === 'modification') {
    const baseMods = deserializeModificationEntries(next.baseModificationEntries);
    const mods = new Map(next.modifications);
    if (event.opPayload.type === 'modificationDelete' || event.changedFields.includes(DELETE_FIELD)) {
      baseMods.delete(event.targetId);
      mods.delete(event.targetId);
    } else if (event.opPayload.mod) {
      const remote = event.opPayload.mod;
      baseMods.set(event.targetId, remote);
      const current = mods.get(event.targetId) as unknown as Record<string, unknown> | undefined;
      mods.set(event.targetId, options.force ? remote : mergeRecordFields(current, remote as unknown as Record<string, unknown>, event.changedFields) as unknown as FlightModification);
    }
    next = {
      ...next,
      modifications: mods,
      baseModificationEntries: serializeModificationMap(baseMods),
    };
  } else if (event.targetType === 'modHistory' && event.opPayload.entry) {
    const entry = event.opPayload.entry;
    const hasEntry = (items: ModHistoryEntry[]) => items.some((item) => item.id === entry.id);
    next = {
      ...next,
      modHistory: hasEntry(next.modHistory) ? next.modHistory : [entry, ...next.modHistory],
      baseModHistory: hasEntry(next.baseModHistory) ? next.baseModHistory : [entry, ...next.baseModHistory],
    };
  }

  const rebuilt = rebuildPendingOpsFromBaseline(next, next.syncMeta.lastLocalChangeAt);
  return {
    ...rebuilt,
    syncMeta: {
      ...rebuilt.syncMeta,
      lastServerSeq: next.syncMeta.lastServerSeq,
      appliedEventIds: next.syncMeta.appliedEventIds,
      conflicts: next.syncMeta.conflicts ?? [],
    },
  };
}

export function mergeRemoteSeasonEvent(
  workspace: LocalSeasonWorkspace,
  event: SeasonChangeEvent,
  options: { clientId?: string; force?: boolean } = {}
): MergeRemoteSeasonEventResult {
  const clientId = options.clientId ?? workspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
  const appliedEventIds = new Set(workspace.syncMeta.appliedEventIds ?? []);
  if (!options.force && (event.clientId === clientId || appliedEventIds.has(eventKey(event)))) {
    return { workspace, applied: false, conflict: false, skipped: true };
  }

  const localEvents = buildPendingChangeEvents(workspace, { clientId });
  const overlap = localEvents
    .filter((localEvent) => sameTarget(localEvent, event))
    .flatMap((localEvent) => findOverlappingFields(localEvent.changedFields, event.changedFields));
  const overlappingFields = Array.from(new Set(overlap));

  if (!options.force && overlappingFields.length > 0) {
    if (isAutoResolvableRemoteLatestConflict(event)) {
      const conflictId = buildConflict(workspace, event, overlappingFields).id;
      const next = applyEventToWorkspace(workspace, event, { force: true });
      return {
        workspace: next,
        applied: true,
        conflict: false,
        skipped: false,
        autoResolvedConflictCount: 1,
        autoResolvedConflictIds: [conflictId],
      };
    }
    const conflict = buildConflict(workspace, event, overlappingFields);
    const existingConflicts = workspace.syncMeta.conflicts ?? [];
    const nextConflicts = existingConflicts.some((item) => item.id === conflict.id)
      ? existingConflicts
      : [...existingConflicts, conflict];
    const seenWorkspace = markSeasonEventSeen(workspace, event);
    return {
      workspace: {
        ...seenWorkspace,
        syncMeta: {
          ...seenWorkspace.syncMeta,
          conflicts: nextConflicts,
          syncStatus: workspace.pendingOps.length > 0 ? 'dirty' : 'needs_review',
        },
      },
      applied: false,
      conflict: true,
      skipped: false,
    };
  }

  const next = applyEventToWorkspace(workspace, event, { force: options.force });
  return { workspace: next, applied: true, conflict: false, skipped: false };
}

export function mergeRemoteSeasonEvents(
  workspace: LocalSeasonWorkspace,
  events: SeasonChangeEvent[],
  options: { clientId?: string } = {}
): MergeRemoteSeasonEventResult {
  return events.reduce<MergeRemoteSeasonEventResult>(
    (result, event) => {
      const merged = mergeRemoteSeasonEvent(result.workspace, event, options);
      return {
        workspace: merged.workspace,
        applied: result.applied || merged.applied,
        conflict: result.conflict || merged.conflict,
        skipped: result.skipped && merged.skipped,
        autoResolvedConflictCount: (result.autoResolvedConflictCount ?? 0) + (merged.autoResolvedConflictCount ?? 0),
        autoResolvedConflictIds: [
          ...(result.autoResolvedConflictIds ?? []),
          ...(merged.autoResolvedConflictIds ?? []),
        ],
      };
    },
    { workspace, applied: false, conflict: false, skipped: true, autoResolvedConflictCount: 0, autoResolvedConflictIds: [] }
  );
}

export function applySeasonEventRange(
  workspace: LocalSeasonWorkspace,
  events: SeasonChangeEvent[],
  options: { clientId?: string } = {}
): MergeRemoteSeasonEventResult {
  const clientId = options.clientId ?? workspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
  const orderedEvents = [...events].sort((a, b) => (a.serverSeq ?? 0) - (b.serverSeq ?? 0));
  let nextWorkspace = workspace;
  let applied = false;
  let conflict = false;
  let skipped = true;

  for (const event of orderedEvents) {
    const appliedEventIds = new Set(nextWorkspace.syncMeta.appliedEventIds ?? []);
    if (event.clientId === clientId || appliedEventIds.has(eventKey(event))) {
      nextWorkspace = markSeasonEventSeen(nextWorkspace, event);
      skipped = skipped && true;
      continue;
    }
    const merged = mergeRemoteSeasonEvent(nextWorkspace, event, { clientId });
    nextWorkspace = merged.workspace;
    applied = applied || merged.applied;
    conflict = conflict || merged.conflict;
    skipped = skipped && merged.skipped;
  }

  return {
    workspace: nextWorkspace,
    applied,
    conflict,
    skipped,
  };
}

export function mergeSeasonSnapshotIntoLocalWorkspace(
  localWorkspace: LocalSeasonWorkspace,
  snapshotWorkspace: LocalSeasonWorkspace,
  options: { clientId?: string } = {}
): LocalSeasonWorkspace {
  const clientId = options.clientId ?? localWorkspace.syncMeta.clientId ?? getOrCreateSeasonClientId();
  const localEvents = buildPendingChangeEvents(localWorkspace, { clientId });
  const serverHighWater = snapshotWorkspace.syncMeta.lastServerSeq ?? 0;

  if (localEvents.length === 0) {
    const conflictCount = localWorkspace.syncMeta.conflicts?.length ?? 0;
    return {
      ...snapshotWorkspace,
      syncMeta: {
        ...snapshotWorkspace.syncMeta,
        clientId,
        lastServerSeq: serverHighWater,
        conflicts: localWorkspace.syncMeta.conflicts ?? [],
        syncStatus: conflictCount > 0 ? 'needs_review' : 'synced',
      },
    };
  }

  const snapshotConflicts: SeasonConflictItem[] = [];
  let mergedWorkspace: LocalSeasonWorkspace = {
    ...snapshotWorkspace,
    syncMeta: {
      ...snapshotWorkspace.syncMeta,
      clientId,
      localRevision: localWorkspace.syncMeta.localRevision,
      lastLocalChangeAt: localWorkspace.syncMeta.lastLocalChangeAt,
      lastServerSeq: serverHighWater,
      conflicts: localWorkspace.syncMeta.conflicts ?? [],
    },
  };

  for (const event of localEvents) {
    const targetVersions = snapshotWorkspace.entityVersions[seasonEventTargetKey(event.targetType, event.targetId)] ?? {};
    const overlappingFields = event.changedFields.filter((field) => {
      const serverVersion = targetVersions[field] ?? 0;
      const baseVersion = event.opPayload.baseFieldVersions?.[field] ?? 0;
      return serverVersion > baseVersion;
    });
    if (overlappingFields.length > 0) {
      const conflictEvent = eventWithSnapshotPayload(event, snapshotWorkspace, overlappingFields);
      if (isAutoResolvableRemoteLatestConflict(conflictEvent)) {
        mergedWorkspace = applyEventToWorkspace(mergedWorkspace, conflictEvent, { force: true });
        continue;
      }
      snapshotConflicts.push({
        id: `snapshot-conflict:${event.opId}:${overlappingFields.join(',')}`,
        event: conflictEvent,
        targetType: event.targetType,
        targetId: event.targetId,
        overlappingFields,
        localFields: pickFields(readWorkspaceEntityByTarget(localWorkspace, event.targetType, event.targetId), overlappingFields),
        remoteFields: pickFields(readWorkspaceEntityByTarget(snapshotWorkspace, event.targetType, event.targetId), overlappingFields),
        createdAt: Date.now(),
        message: `Server snapshot has newer ${event.targetType} ${event.targetId} ${overlappingFields.join(', ')} values.`,
      });
    }
    mergedWorkspace = applyLocalEventPatchToSnapshot(mergedWorkspace, event);
  }

  const rebuilt = rebuildPendingOpsFromBaseline({
    ...mergedWorkspace,
    baseRows: snapshotWorkspace.baseRows,
    baseRecords: snapshotWorkspace.baseRecords,
    baseModificationEntries: snapshotWorkspace.baseModificationEntries,
    baseModHistory: snapshotWorkspace.baseModHistory,
    entityVersions: snapshotWorkspace.entityVersions,
    syncMeta: {
      ...mergedWorkspace.syncMeta,
      baseServerVersion: snapshotWorkspace.syncMeta.baseServerVersion,
      lastServerSeq: serverHighWater,
      conflicts: mergeConflicts(mergedWorkspace.syncMeta.conflicts, snapshotConflicts),
    },
  }, localWorkspace.syncMeta.lastLocalChangeAt);

  const conflictCount = rebuilt.syncMeta.conflicts?.length ?? 0;
  return {
    ...rebuilt,
    syncMeta: {
      ...rebuilt.syncMeta,
      clientId,
      lastServerSeq: serverHighWater,
      conflicts: rebuilt.syncMeta.conflicts,
      syncStatus: conflictCount > 0 ? (rebuilt.pendingOps.length > 0 ? 'dirty' : 'needs_review') : rebuilt.syncMeta.syncStatus,
    },
  };
}

export function resolveSeasonConflict(
  workspace: LocalSeasonWorkspace,
  conflictId: string,
  resolution: SeasonConflictResolution
): LocalSeasonWorkspace {
  const conflict = workspace.syncMeta.conflicts?.find((item) => item.id === conflictId);
  if (!conflict) return workspace;

  const withoutConflict = {
    ...workspace,
    syncMeta: {
      ...workspace.syncMeta,
      conflicts: (workspace.syncMeta.conflicts ?? []).filter((item) => item.id !== conflictId),
    },
  };

  if (resolution === 'editManually') {
    return workspace;
  }

  if (resolution === 'keepMine') {
    return withoutConflict;
  }

  const accepted = mergeRemoteSeasonEvent(withoutConflict, conflict.event, {
    clientId: withoutConflict.syncMeta.clientId,
    force: true,
  }).workspace;
  return {
    ...accepted,
    syncMeta: {
      ...accepted.syncMeta,
      conflicts: withoutConflict.syncMeta.conflicts,
    },
  };
}
