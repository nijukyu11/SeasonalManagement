import type {
  FlightRecordCounterRelationalRow,
  FlightRecordRelationalRow,
  FlightRecordWindowRelationalRow,
  ModificationAddedLegRelationalRow,
  ModificationCounterRelationalRow,
  ModificationRelationalRow,
  ModificationWindowRelationalRow,
} from './supabaseRelationalMappers';

export const WORKSPACE_WINDOW_V2_PAGE_SIZE = 500;
export const WORKSPACE_WINDOW_V2_MAX_PAGE_SIZE = 1000;

export interface WorkspaceWindowV2SnapshotToken {
  dataVersion: number;
  serverHighWater: number;
}

export interface WorkspaceWindowV2RootCursor {
  effectiveDate: string;
  rootId: string;
  rootKind: 0 | 1;
}

export interface WorkspaceWindowV2OkPage {
  status: 'ok';
  seasonId: string;
  startDate: string | null;
  endDate: string | null;
  resourceType: string;
  snapshot: WorkspaceWindowV2SnapshotToken;
  page: {
    returnedCount: number;
    hasMore: boolean;
    nextCursor: WorkspaceWindowV2RootCursor | null;
  };
  flightRecords: FlightRecordRelationalRow[];
  flightRecordCounters: FlightRecordCounterRelationalRow[];
  flightRecordWindows: FlightRecordWindowRelationalRow[];
  modifications: ModificationRelationalRow[];
  modificationCounters: ModificationCounterRelationalRow[];
  modificationWindows: ModificationWindowRelationalRow[];
  modificationAddedLegs: ModificationAddedLegRelationalRow[];
}

export interface WorkspaceWindowV2SnapshotChangedPage {
  status: 'snapshot_changed';
  snapshot: WorkspaceWindowV2SnapshotToken;
}

export type WorkspaceWindowV2Page =
  | WorkspaceWindowV2OkPage
  | WorkspaceWindowV2SnapshotChangedPage;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isObject(entry))) {
    throw new Error(`${label} must be an array of objects.`);
  }
  return value as JsonObject[];
}

function parseSnapshot(value: unknown): WorkspaceWindowV2SnapshotToken {
  const snapshot = requireObject(value, 'snapshot');
  return {
    dataVersion: requireNonNegativeInteger(snapshot.dataVersion, 'snapshot.dataVersion'),
    serverHighWater: requireNonNegativeInteger(snapshot.serverHighWater, 'snapshot.serverHighWater'),
  };
}

function parseCursor(value: unknown): WorkspaceWindowV2RootCursor | null {
  if (value === null) return null;
  const cursor = requireObject(value, 'page.nextCursor');
  const rootKind = requireNonNegativeInteger(cursor.rootKind, 'page.nextCursor.rootKind');
  if (rootKind !== 0 && rootKind !== 1) {
    throw new Error('page.nextCursor.rootKind must be 0 or 1.');
  }
  return {
    effectiveDate: requireString(cursor.effectiveDate, 'page.nextCursor.effectiveDate'),
    rootId: requireString(cursor.rootId, 'page.nextCursor.rootId'),
    rootKind,
  };
}

function requireUniqueIds(rows: JsonObject[], key: string, label: string): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = requireString(row[key], `${label}.${key}`);
    if (ids.has(id)) throw new Error(`${label} contains duplicate ${key} ${id}.`);
    ids.add(id);
  }
  return ids;
}

function requireUniqueCompositeIds(
  rows: JsonObject[],
  keys: string[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = keys.map((key) => String(row[key] ?? '')).join('\u0000');
    if (ids.has(id)) throw new Error(`${label} contains a duplicate composite key.`);
    ids.add(id);
  }
}

function requireOwned(
  rows: JsonObject[],
  key: string,
  owners: Set<string>,
  label: string,
): void {
  for (const row of rows) {
    const id = requireString(row[key], `${label}.${key}`);
    if (!owners.has(id)) throw new Error(`${label} contains orphan ${key} ${id}.`);
  }
}

function hasAnyRowArray(value: JsonObject): boolean {
  return [
    'flightRecords',
    'flightRecordCounters',
    'flightRecordWindows',
    'modifications',
    'modificationCounters',
    'modificationWindows',
    'modificationAddedLegs',
  ].some((key) => key in value);
}

export function parseWorkspaceWindowV2Page(value: unknown): WorkspaceWindowV2Page {
  const payload = requireObject(value, 'workspace window V2 payload');
  const status = requireString(payload.status, 'status');
  const snapshot = parseSnapshot(payload.snapshot);

  if (status === 'snapshot_changed') {
    if (hasAnyRowArray(payload)) {
      throw new Error('snapshot_changed must not include row arrays.');
    }
    return { status, snapshot };
  }
  if (status !== 'ok') throw new Error(`Unsupported workspace window V2 status ${status}.`);

  const pageValue = requireObject(payload.page, 'page');
  const returnedCount = requireNonNegativeInteger(pageValue.returnedCount, 'page.returnedCount');
  if (returnedCount > WORKSPACE_WINDOW_V2_MAX_PAGE_SIZE) {
    throw new Error('page.returnedCount exceeds the V2 page-size contract.');
  }
  const hasMore = requireBoolean(pageValue.hasMore, 'page.hasMore');
  const nextCursor = parseCursor(pageValue.nextCursor);
  if (hasMore !== Boolean(nextCursor)) {
    throw new Error('page.nextCursor must be present exactly when page.hasMore is true.');
  }

  const flightRecords = requireObjectArray(payload.flightRecords, 'flightRecords');
  const flightRecordCounters = requireObjectArray(payload.flightRecordCounters, 'flightRecordCounters');
  const flightRecordWindows = requireObjectArray(payload.flightRecordWindows, 'flightRecordWindows');
  const modifications = requireObjectArray(payload.modifications, 'modifications');
  const modificationCounters = requireObjectArray(payload.modificationCounters, 'modificationCounters');
  const modificationWindows = requireObjectArray(payload.modificationWindows, 'modificationWindows');
  const modificationAddedLegs = requireObjectArray(payload.modificationAddedLegs, 'modificationAddedLegs');

  const recordIds = requireUniqueIds(flightRecords, 'record_id', 'flightRecords');
  const addedLegIds = requireUniqueIds(modificationAddedLegs, 'leg_id', 'modificationAddedLegs');
  for (const addedLegId of addedLegIds) {
    if (recordIds.has(addedLegId)) {
      throw new Error(`workspace roots contain duplicate root id ${addedLegId}.`);
    }
  }
  const rootIds = new Set([...recordIds, ...addedLegIds]);
  const modificationIds = requireUniqueIds(modifications, 'leg_id', 'modifications');
  if (returnedCount !== flightRecords.length + modificationAddedLegs.length) {
    throw new Error('page.returnedCount does not match returned roots.');
  }

  requireOwned(flightRecordCounters, 'record_id', recordIds, 'flightRecordCounters');
  requireOwned(flightRecordWindows, 'record_id', recordIds, 'flightRecordWindows');
  requireOwned(modifications, 'leg_id', rootIds, 'modifications');
  requireOwned(modificationCounters, 'leg_id', modificationIds, 'modificationCounters');
  requireOwned(modificationWindows, 'leg_id', modificationIds, 'modificationWindows');
  requireOwned(modificationAddedLegs, 'leg_id', modificationIds, 'modificationAddedLegs');

  requireUniqueCompositeIds(flightRecordCounters, ['record_id', 'counter_group', 'item_index'], 'flightRecordCounters');
  requireUniqueCompositeIds(flightRecordWindows, ['record_id', 'counter_key'], 'flightRecordWindows');
  requireUniqueCompositeIds(modificationCounters, ['leg_id', 'counter_group', 'item_index'], 'modificationCounters');
  requireUniqueCompositeIds(modificationWindows, ['leg_id', 'counter_key'], 'modificationWindows');

  return {
    status,
    seasonId: requireString(payload.seasonId, 'seasonId'),
    startDate: requireNullableString(payload.startDate, 'startDate'),
    endDate: requireNullableString(payload.endDate, 'endDate'),
    resourceType: requireString(payload.resourceType, 'resourceType'),
    snapshot,
    page: { returnedCount, hasMore, nextCursor },
    flightRecords: flightRecords as FlightRecordRelationalRow[],
    flightRecordCounters: flightRecordCounters as FlightRecordCounterRelationalRow[],
    flightRecordWindows: flightRecordWindows as FlightRecordWindowRelationalRow[],
    modifications: modifications as ModificationRelationalRow[],
    modificationCounters: modificationCounters as ModificationCounterRelationalRow[],
    modificationWindows: modificationWindows as ModificationWindowRelationalRow[],
    modificationAddedLegs: modificationAddedLegs as ModificationAddedLegRelationalRow[],
  };
}
