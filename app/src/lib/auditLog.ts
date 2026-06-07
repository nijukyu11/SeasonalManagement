import type { LocalPendingOp, LocalSeasonWorkspace } from './localSeasonStore';
import type { FlightModification, FlightRecord, OperationalSettings, Season } from './types';

export const FIRESTORE_AUDIT_DELTA_SAFE_BYTES = 850000;

export type AuditModule = 'seasonal' | 'detailed' | 'daily' | 'checkin' | 'gate' | 'settings' | 'sync' | 'import';
export type AuditCategory = 'user-action' | 'sync' | 'import' | 'settings';
export type AuditSyncStatus = 'synced' | 'noop' | 'conflict' | 'failed';
export type AuditTargetType = 'flight' | 'sourceRow' | 'modification' | 'settings' | 'sync';

export type AuditActor = {
  uid: string | null;
  email: string | null;
  displayName: string | null;
  isAnonymous: boolean;
};

export type AuditDeltaItem = {
  targetType: AuditTargetType;
  targetId: string;
  targetLabel: string;
  field: string;
  before: unknown;
  after: unknown;
};

export type AuditSyncDelta = {
  status?: AuditSyncStatus;
  records: number;
  sourceRows: number;
  modifications: number;
  historyEntries: number;
  flightsAdded: number;
  flightsRemoved: number;
  flightsModified: number;
  affectedPeriod: {
    from: string | null;
    to: string | null;
  };
  exactChanges: AuditDeltaItem[];
};

export type AuditSession = {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  actor: AuditActor;
  userAgent: string | null;
};

export type AuditLogEntry = {
  id: string;
  sessionId: string;
  timestamp: number;
  seasonId: string | null;
  seasonCode: string | null;
  module: AuditModule;
  category: AuditCategory;
  operation: string;
  targetFlightIds: string[];
  targetFlightLabels: string[];
  actor: AuditActor;
  deltas: AuditDeltaItem[];
  syncDelta?: AuditSyncDelta;
  metadata?: Record<string, unknown>;
  deltaChunkCount?: number;
};

export type AuditDeltaChunk = {
  id: string;
  chunkIndex: number;
  items: AuditDeltaItem[];
};

export type BuildFlightActionAuditEntryInput = {
  id?: string;
  sessionId: string;
  timestamp?: number;
  actor?: AuditActor;
  seasonId: string | null;
  seasonCode?: string | null;
  module: AuditModule;
  category?: AuditCategory;
  operation: string;
  beforeRecords?: Array<Partial<FlightRecord> | null | undefined>;
  afterRecords?: Array<Partial<FlightRecord> | null | undefined>;
  beforeModifications?: Map<string, FlightModification> | FlightModification[];
  afterModifications?: Map<string, FlightModification> | FlightModification[];
  targetRecordIds?: string[];
  metadata?: Record<string, unknown>;
};

export type AppendAuditLogEntryInput = Omit<AuditLogEntry, 'id' | 'sessionId' | 'timestamp' | 'actor' | 'targetFlightIds' | 'targetFlightLabels' | 'deltas'> & {
  id?: string;
  sessionId?: string;
  timestamp?: number;
  actor?: AuditActor;
  targetFlightIds?: string[];
  targetFlightLabels?: string[];
  deltas?: AuditDeltaItem[];
};

const AUDIT_SESSION_STORAGE_KEY = 'seasonalManagement.audit.sessionId';

const FLIGHT_DELTA_FIELDS: Array<keyof FlightRecord> = [
  'date',
  'schedule',
  'aircraft',
  'route',
  'category',
  'codeShares',
  'intDomInd',
  'pax',
  'gate',
  'stand',
  'counter',
  'checkInStart',
  'checkInEnd',
  'checkInAllocationMode',
  'checkInCounterWindows',
  'carousel',
  'mct',
  'fb',
  'lb',
  'bhs',
  'ghs',
  'status',
  'linkedRecordId',
  'linkType',
];

const MODIFICATION_DELTA_FIELDS: Array<keyof FlightModification> = [
  'action',
  'schedule',
  'aircraft',
  'route',
  'codeShares',
  'pax',
  'gate',
  'stand',
  'counter',
  'checkInStart',
  'checkInEnd',
  'checkInAllocationMode',
  'checkInCounterWindows',
  'carousel',
  'mct',
  'fb',
  'lb',
  'bhs',
  'ghs',
];

function now(): number {
  return Date.now();
}

function randomId(prefix: string): string {
  const cryptoId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${cryptoId}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeValue(left);
  const normalizedRight = normalizeValue(right);
  if (normalizedLeft === normalizedRight) return true;
  return stableStringify(normalizedLeft) === stableStringify(normalizedRight);
}

function isRecordLike(value: Partial<FlightRecord> | null | undefined): value is Partial<FlightRecord> & { id: string } {
  return Boolean(value && typeof value.id === 'string' && value.id.length > 0);
}

function normalizeFlightNumber(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim().toUpperCase();
  return trimmed.replace(/\s+/g, '');
}

export function formatAuditFlightLabel(record: Partial<FlightRecord> | null | undefined): string {
  if (!record) return 'Unknown flight';
  const airline = String(record.airline ?? '').trim().toUpperCase();
  const flightNumber = normalizeFlightNumber(record.flightNumber ?? record.rawFlightNumber);
  if (!airline && !flightNumber) return record.id ? `Flight ${record.id}` : 'Unknown flight';
  if (flightNumber.startsWith(airline)) return flightNumber;
  return `${airline}${flightNumber}`;
}

function recordMap(records: Array<Partial<FlightRecord> | null | undefined> | undefined): Map<string, Partial<FlightRecord>> {
  const map = new Map<string, Partial<FlightRecord>>();
  for (const record of records ?? []) {
    if (isRecordLike(record)) map.set(record.id, record);
  }
  return map;
}

function modificationMap(
  modifications: Map<string, FlightModification> | FlightModification[] | undefined
): Map<string, FlightModification> {
  if (!modifications) return new Map();
  if (modifications instanceof Map) return new Map(modifications);
  return new Map(modifications.map((mod) => [mod.legId, mod]));
}

function resolveTargetIds(
  targetRecordIds: string[] | undefined,
  beforeRecords: Map<string, Partial<FlightRecord>>,
  afterRecords: Map<string, Partial<FlightRecord>>,
  beforeMods: Map<string, FlightModification>,
  afterMods: Map<string, FlightModification>,
): Set<string> {
  const explicitIds = (targetRecordIds ?? []).filter((id) => String(id).trim().length > 0);
  if (explicitIds.length > 0) return new Set(explicitIds);

  const targetIds = new Set<string>();
  beforeRecords.forEach((_record, id) => targetIds.add(id));
  afterRecords.forEach((_record, id) => targetIds.add(id));
  beforeMods.forEach((_mod, id) => targetIds.add(id));
  afterMods.forEach((_mod, id) => targetIds.add(id));
  return targetIds;
}

function buildRecordDeltas(
  before: Partial<FlightRecord> | undefined,
  after: Partial<FlightRecord> | undefined,
  labelRecord: Partial<FlightRecord> | undefined,
): AuditDeltaItem[] {
  const targetId = String(after?.id ?? before?.id ?? '');
  const targetLabel = formatAuditFlightLabel(labelRecord ?? after ?? before);
  const deltas: AuditDeltaItem[] = [];

  if (!before || !after) {
    deltas.push({
      targetType: 'flight',
      targetId,
      targetLabel,
      field: 'record',
      before: before ?? null,
      after: after ?? null,
    });
    return deltas;
  }

  for (const field of FLIGHT_DELTA_FIELDS) {
    const beforeValue = normalizeValue(before[field]);
    const afterValue = normalizeValue(after[field]);
    if (valuesEqual(beforeValue, afterValue)) continue;
    deltas.push({
      targetType: 'flight',
      targetId,
      targetLabel,
      field: String(field),
      before: beforeValue,
      after: afterValue,
    });
  }

  return deltas;
}

function buildModificationDeltas(
  before: FlightModification | undefined,
  after: FlightModification | undefined,
  labelRecord?: Partial<FlightRecord>,
): AuditDeltaItem[] {
  const targetId = String(after?.legId ?? before?.legId ?? labelRecord?.id ?? '');
  const targetLabel = formatAuditFlightLabel(labelRecord ?? { id: targetId, airline: '', flightNumber: targetId });
  const deltas: AuditDeltaItem[] = [];

  if (!before || !after) {
    deltas.push({
      targetType: 'modification',
      targetId,
      targetLabel,
      field: 'modification',
      before: before ?? null,
      after: after ?? null,
    });
    return deltas;
  }

  for (const field of MODIFICATION_DELTA_FIELDS) {
    const beforeValue = normalizeValue(before[field]);
    const afterValue = normalizeValue(after[field]);
    if (valuesEqual(beforeValue, afterValue)) continue;
    deltas.push({
      targetType: 'modification',
      targetId,
      targetLabel,
      field: String(field),
      before: beforeValue,
      after: afterValue,
    });
  }

  return deltas;
}

export function resolveAuditActor(currentUser?: {
  uid?: string | null;
  email?: string | null;
  displayName?: string | null;
  isAnonymous?: boolean | null;
} | null): AuditActor {
  return {
    uid: currentUser?.uid ?? null,
    email: currentUser?.email ?? null,
    displayName: currentUser?.displayName ?? null,
    isAnonymous: currentUser?.isAnonymous ?? !currentUser?.uid,
  };
}

export function getOrCreateAuditSessionId(): string {
  if (typeof window === 'undefined') return randomId('server-audit-session');

  const existing = window.sessionStorage.getItem(AUDIT_SESSION_STORAGE_KEY);
  if (existing) return existing;

  const nextSessionId = randomId('audit-session');
  window.sessionStorage.setItem(AUDIT_SESSION_STORAGE_KEY, nextSessionId);
  return nextSessionId;
}

export function buildAuditSession(sessionId: string, actor: AuditActor, timestamp = now()): AuditSession {
  return {
    id: sessionId,
    startedAt: timestamp,
    lastSeenAt: timestamp,
    actor,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
  };
}

export function buildFlightActionAuditEntry(input: BuildFlightActionAuditEntryInput): AuditLogEntry {
  const beforeRecords = recordMap(input.beforeRecords);
  const afterRecords = recordMap(input.afterRecords);
  const beforeMods = modificationMap(input.beforeModifications);
  const afterMods = modificationMap(input.afterModifications);
  const targetIds = resolveTargetIds(input.targetRecordIds, beforeRecords, afterRecords, beforeMods, afterMods);

  const deltas: AuditDeltaItem[] = [];
  const labels = new Set<string>();
  for (const targetId of targetIds) {
    const beforeRecord = beforeRecords.get(targetId);
    const afterRecord = afterRecords.get(targetId);
    const labelRecord = afterRecord ?? beforeRecord;
    if (labelRecord) labels.add(formatAuditFlightLabel(labelRecord));
    deltas.push(...buildRecordDeltas(beforeRecord, afterRecord, labelRecord));

    const beforeMod = beforeMods.get(targetId);
    const afterMod = afterMods.get(targetId);
    if (beforeMod || afterMod) {
      deltas.push(...buildModificationDeltas(beforeMod, afterMod, labelRecord));
    }
  }

  return {
    id: input.id ?? randomId('audit-entry'),
    sessionId: input.sessionId,
    timestamp: input.timestamp ?? now(),
    actor: input.actor ?? resolveAuditActor(null),
    seasonId: input.seasonId,
    seasonCode: input.seasonCode ?? null,
    module: input.module,
    category: input.category ?? 'user-action',
    operation: input.operation,
    targetFlightIds: Array.from(targetIds),
    targetFlightLabels: Array.from(labels),
    deltas,
    metadata: input.metadata,
  };
}

function getChangedRecordIds(workspace: LocalSeasonWorkspace): Set<string> {
  const ids = new Set<string>();
  for (const op of workspace.pendingOps) {
    if (op.type === 'flightRecord') ids.add(String(op.record.id));
    if (op.type === 'modification') ids.add(op.mod.legId);
    if (op.type === 'modificationDelete') ids.add(op.legId);
  }
  return ids;
}

function getRecordDate(record: Partial<FlightRecord> | undefined): string | null {
  const date = String(record?.date ?? '').trim();
  return date || null;
}

function pushAffectedDate(dates: string[], record: Partial<FlightRecord> | undefined): void {
  const date = getRecordDate(record);
  if (date) dates.push(date);
}

function buildPendingOpDelta(op: LocalPendingOp, workspace: LocalSeasonWorkspace): AuditDeltaItem[] {
  const baseRecordsById = new Map(workspace.baseRecords.map((record) => [record.id, record]));
  const currentRecordsById = new Map(workspace.records.map((record) => [record.id, record]));
  const baseMods = new Map(workspace.baseModificationEntries);

  if (op.type === 'flightRecord') {
    const recordId = String(op.record.id);
    const currentRecord = (currentRecordsById.get(recordId) ?? op.record) as FlightRecord;
    return buildRecordDeltas(baseRecordsById.get(recordId), currentRecord, currentRecord);
  }
  if (op.type === 'sourceRow') {
    const rowIndex = op.row.rowIndex;
    const before = workspace.baseRows.find((row) => row.rowIndex === rowIndex) ?? null;
    return [{
      targetType: 'sourceRow',
      targetId: String(rowIndex),
      targetLabel: `Source row ${rowIndex}`,
      field: 'row',
      before,
      after: op.row,
    }];
  }
  if (op.type === 'modification') {
    return buildModificationDeltas(baseMods.get(op.mod.legId), op.mod, currentRecordsById.get(op.mod.legId) ?? baseRecordsById.get(op.mod.legId));
  }
  if (op.type === 'modificationDelete') {
    return buildModificationDeltas(baseMods.get(op.legId), undefined, currentRecordsById.get(op.legId) ?? baseRecordsById.get(op.legId));
  }
  return [{
    targetType: 'sync',
    targetId: op.entry.id,
    targetLabel: op.entry.description,
    field: 'historyEntry',
    before: null,
    after: op.entry,
  }];
}

export function buildSyncAuditDelta(workspace: LocalSeasonWorkspace): AuditSyncDelta {
  const counts = {
    records: 0,
    sourceRows: 0,
    modifications: 0,
    historyEntries: 0,
  };
  for (const op of workspace.pendingOps) {
    if (op.type === 'flightRecord') counts.records += 1;
    if (op.type === 'sourceRow') counts.sourceRows += 1;
    if (op.type === 'modification' || op.type === 'modificationDelete') counts.modifications += 1;
    if (op.type === 'modHistory') counts.historyEntries += 1;
  }

  const baseRecordsById = new Map(workspace.baseRecords.map((record) => [record.id, record]));
  const currentRecordsById = new Map(workspace.records.map((record) => [record.id, record]));
  let flightsAdded = 0;
  let flightsRemoved = 0;
  let flightsModified = 0;
  const affectedDates: string[] = [];

  for (const recordId of getChangedRecordIds(workspace)) {
    const before = baseRecordsById.get(recordId);
    const after = currentRecordsById.get(recordId);
    pushAffectedDate(affectedDates, before);
    pushAffectedDate(affectedDates, after);

    if (!before && after?.status !== 'deleted') flightsAdded += 1;
    else if (before && after?.status === 'deleted') flightsRemoved += 1;
    else if (before && after && !valuesEqual(before, after)) flightsModified += 1;
    else if (before && !after) flightsRemoved += 1;
  }

  affectedDates.sort();
  return {
    ...counts,
    flightsAdded,
    flightsRemoved,
    flightsModified,
    affectedPeriod: {
      from: affectedDates[0] ?? null,
      to: affectedDates[affectedDates.length - 1] ?? null,
    },
    exactChanges: workspace.pendingOps.flatMap((op) => buildPendingOpDelta(op, workspace)),
  };
}

export function buildSettingsAuditDeltas(
  before: OperationalSettings | null | undefined,
  after: OperationalSettings
): AuditDeltaItem[] {
  const beforeObject = before ?? null;
  return [{
    targetType: 'settings',
    targetId: 'operational',
    targetLabel: 'Operational settings',
    field: 'settings',
    before: beforeObject,
    after,
  }];
}

export function estimateAuditPayloadBytes(value: unknown): number {
  const payload = JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(payload).byteLength;
  return payload.length;
}

export function splitAuditDeltaChunks(
  items: AuditDeltaItem[],
  maxBytes = FIRESTORE_AUDIT_DELTA_SAFE_BYTES
): AuditDeltaChunk[] {
  const chunks: AuditDeltaChunk[] = [];
  let currentItems: AuditDeltaItem[] = [];

  function flush(): void {
    if (currentItems.length === 0) return;
    chunks.push({
      id: `chunk-${String(chunks.length + 1).padStart(4, '0')}`,
      chunkIndex: chunks.length,
      items: currentItems,
    });
    currentItems = [];
  }

  for (const item of items) {
    const candidate = [...currentItems, item];
    const candidateChunk: AuditDeltaChunk = {
      id: 'candidate',
      chunkIndex: chunks.length,
      items: candidate,
    };
    if (currentItems.length > 0 && estimateAuditPayloadBytes(candidateChunk) > maxBytes) flush();

    const singleItemChunk: AuditDeltaChunk = {
      id: 'candidate',
      chunkIndex: chunks.length,
      items: [item],
    };
    if (estimateAuditPayloadBytes(singleItemChunk) > maxBytes) {
      throw new Error(`Audit delta item for ${item.targetLabel}.${item.field} exceeds Firestore-safe chunk size`);
    }
    currentItems.push(item);
  }

  flush();
  return chunks;
}

export function createAuditLogEntry(input: AppendAuditLogEntryInput): AuditLogEntry {
  const sessionId = input.sessionId ?? getOrCreateAuditSessionId();
  return {
    id: input.id ?? randomId('audit-entry'),
    sessionId,
    timestamp: input.timestamp ?? now(),
    actor: input.actor ?? resolveAuditActor(null),
    seasonId: input.seasonId,
    seasonCode: input.seasonCode ?? null,
    module: input.module,
    category: input.category,
    operation: input.operation,
    targetFlightIds: input.targetFlightIds ?? [],
    targetFlightLabels: input.targetFlightLabels ?? [],
    deltas: input.deltas ?? [],
    syncDelta: input.syncDelta,
    metadata: input.metadata,
  };
}

export async function appendAuditLogEntry(input: AppendAuditLogEntryInput): Promise<void> {
  try {
    const { getCurrentRemoteActor, saveAuditLogEntry } = await import('./remoteStore');
    const actor = input.actor ?? resolveAuditActor(await getCurrentRemoteActor());
    const entry = createAuditLogEntry({ ...input, actor });
    const session = buildAuditSession(entry.sessionId, actor, entry.timestamp);
    await saveAuditLogEntry(session, entry);
  } catch (error) {
    console.debug('[audit-log] append failed', error);
  }
}

export function createFlightActionAuditFromHistory(params: {
  sessionId?: string;
  season: Pick<Season, 'id' | 'seasonCode'>;
  module: AuditModule;
  operation: string;
  beforeRecords?: Array<Partial<FlightRecord> | null | undefined>;
  afterRecords?: Array<Partial<FlightRecord> | null | undefined>;
  beforeModifications?: Map<string, FlightModification> | FlightModification[];
  afterModifications?: Map<string, FlightModification> | FlightModification[];
  targetRecordIds?: string[];
  metadata?: Record<string, unknown>;
}): AuditLogEntry {
  return buildFlightActionAuditEntry({
    sessionId: params.sessionId ?? getOrCreateAuditSessionId(),
    seasonId: params.season.id,
    seasonCode: params.season.seasonCode,
    module: params.module,
    operation: params.operation,
    beforeRecords: params.beforeRecords,
    afterRecords: params.afterRecords,
    beforeModifications: params.beforeModifications,
    afterModifications: params.afterModifications,
    targetRecordIds: params.targetRecordIds,
    metadata: params.metadata,
  });
}
