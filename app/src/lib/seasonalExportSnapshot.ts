import type {
  RemoteSeasonalExportSnapshot,
  RemoteSeasonalExportSnapshotInput,
} from './remoteStore.ts';
import {
  fromFlightRecordRows,
  fromModificationRows,
  type FlightRecordCounterRelationalRow,
  type FlightRecordRelationalRow,
  type FlightRecordWindowRelationalRow,
  type ModificationAddedLegRelationalRow,
  type ModificationCounterRelationalRow,
  type ModificationRelationalRow,
  type ModificationWindowRelationalRow,
} from './supabaseRelationalMappers.ts';

type JsonObject = Record<string, unknown>;

export interface SeasonalExportSnapshotRows {
  seasonId: string;
  seasonCode: string;
  dataVersion: number;
  totalCount: number;
  sourceRowCount: number;
  serverHighWater: number;
  truncated: false;
  flightRecords: JsonObject[];
  flightRecordCounters: JsonObject[];
  flightRecordWindows: JsonObject[];
  modifications: JsonObject[];
  modificationCounters: JsonObject[];
  modificationWindows: JsonObject[];
  modificationAddedLegs: JsonObject[];
}

const SNAPSHOT_ARRAYS = [
  'flightRecords',
  'flightRecordCounters',
  'flightRecordWindows',
  'modifications',
  'modificationCounters',
  'modificationWindows',
  'modificationAddedLegs',
] as const;

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as JsonObject;
}

function requireField(row: JsonObject, field: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`${path}.${field} is missing.`);
  }
  return row[field];
}

function stringField(row: JsonObject, field: string, path: string, allowEmpty = true): string {
  const value = requireField(row, field, path);
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path}.${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}

function nullableStringField(row: JsonObject, field: string, path: string): void {
  const value = requireField(row, field, path);
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${path}.${field} must be a string or null.`);
  }
}

function integerField(row: JsonObject, field: string, path: string, nullable = false): void {
  const value = requireField(row, field, path);
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${path}.${field} must be ${nullable ? 'an integer or null' : 'an integer'}.`);
  }
}

function literalField(row: JsonObject, field: string, path: string, values: readonly unknown[], nullable = false): void {
  const value = requireField(row, field, path);
  if (nullable && value === null) return;
  if (!values.includes(value)) {
    throw new Error(`${path}.${field} has an invalid value.`);
  }
}

function stringArrayField(row: JsonObject, field: string, path: string): void {
  const value = requireField(row, field, path);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path}.${field} must be an array of strings.`);
  }
}

function validateFlightRecord(value: unknown, path: string, seasonId: string, added = false): JsonObject {
  const row = objectAt(value, path);
  const rowSeasonId = stringField(row, 'season_id', path, false);
  if (rowSeasonId !== seasonId) throw new Error(`${path}.season_id does not match snapshot season.`);
  if (added) stringField(row, 'leg_id', path, false);
  stringField(row, 'record_id', path, false);
  for (const field of [
    'link_id', 'airline', 'flight_number', 'raw_flight_number', 'route', 'schedule',
    'aircraft', 'category', 'date',
  ]) stringField(row, field, path);
  for (const field of [
    'request_status_code', 'code_shares', 'int_dom_ind', 'mct', 'fb', 'lb', 'bhs', 'ghs',
    'scheduled_date', 'scheduled_time', 'operational_date', 'iata_season_code', 'flight_series_id',
    'pair_anchor_date', 'linked_record_id', 'turnaround_id',
  ]) nullableStringField(row, field, path);
  for (const field of ['pax', 'gate', 'stand', 'carousel', 'linked_source_row_index']) {
    integerField(row, field, path, true);
  }
  integerField(row, 'day_of_week', path);
  integerField(row, 'source_row_index', path);
  literalField(row, 'type', path, ['A', 'D']);
  literalField(row, 'action', path, ['modified', 'added', 'deleted'], true);
  literalField(row, 'link_type', path, ['overnight', 'sameday'], true);
  literalField(row, 'source_kind', path, ['imported', 'added']);
  literalField(row, 'source_side', path, ['ARR', 'DEP']);
  literalField(row, 'status', path, ['active', 'deleted']);
  return row;
}

function validateCounter(value: unknown, path: string, ownerField: 'record_id' | 'leg_id'): JsonObject {
  const row = objectAt(value, path);
  stringField(row, ownerField, path, false);
  stringField(row, 'counter_group', path);
  integerField(row, 'item_index', path);
  stringField(row, 'counter_value', path);
  return row;
}

function validateWindow(value: unknown, path: string, ownerField: 'record_id' | 'leg_id'): JsonObject {
  const row = objectAt(value, path);
  stringField(row, ownerField, path, false);
  stringField(row, 'counter_key', path, false);
  stringField(row, 'window_start', path);
  stringField(row, 'window_end', path);
  return row;
}

function validateModification(value: unknown, path: string, seasonId: string): JsonObject {
  const row = objectAt(value, path);
  if (stringField(row, 'season_id', path, false) !== seasonId) {
    throw new Error(`${path}.season_id does not match snapshot season.`);
  }
  stringField(row, 'leg_id', path, false);
  literalField(row, 'action', path, ['modified', 'deleted', 'added']);
  stringArrayField(row, 'changed_fields', path);
  for (const field of [
    'schedule', 'aircraft', 'route', 'code_shares', 'mct', 'fb', 'lb', 'bhs', 'ghs',
    'check_in_start', 'check_in_end',
  ]) nullableStringField(row, field, path);
  for (const field of ['pax', 'gate', 'stand', 'carousel']) integerField(row, field, path, true);
  literalField(row, 'check_in_allocation_mode', path, ['grouped', 'broken'], true);
  return row;
}

function arrayOfObjects(root: JsonObject, field: typeof SNAPSHOT_ARRAYS[number]): JsonObject[] {
  const value = root[field];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value as JsonObject[];
}

function nonNegativeInteger(root: JsonObject, field: string): number {
  const value = root[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function uniqueOwnerIds(rows: JsonObject[], field: string, path: string): Set<string> {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    const id = row[field];
    if (typeof id !== 'string' || !id) throw new Error(`${path}[${index}].${field} must be a non-empty string.`);
    if (ids.has(id)) throw new Error(`${path}[${index}].${field} duplicates ${id}.`);
    ids.add(id);
  });
  return ids;
}

function assertRelations(rows: JsonObject[], ownerField: string, owners: Set<string>, path: string): void {
  rows.forEach((row, index) => {
    const ownerId = row[ownerField];
    if (typeof ownerId !== 'string' || !owners.has(ownerId)) {
      throw new Error(`${path}[${index}].${ownerField} does not reference a snapshot owner.`);
    }
  });
}

export function parseSeasonalExportSnapshotRows(
  value: unknown,
  expected: { seasonId: string; dataVersion: number },
): SeasonalExportSnapshotRows {
  const root = objectAt(value, 'seasonal export snapshot');
  const seasonId = typeof root.seasonId === 'string' && root.seasonId.length > 0
    ? root.seasonId
    : (() => { throw new Error('seasonId must be a non-empty string.'); })();
  const seasonCode = stringField(root, 'seasonCode', 'seasonal export snapshot', false);
  const dataVersion = nonNegativeInteger(root, 'dataVersion');
  const totalCount = nonNegativeInteger(root, 'totalCount');
  const sourceRowCount = nonNegativeInteger(root, 'sourceRowCount');
  const serverHighWater = nonNegativeInteger(root, 'serverHighWater');
  if (root.truncated !== false) throw new Error('truncated must be exactly false.');
  if (seasonId !== expected.seasonId) throw new Error(`Export snapshot season mismatch: expected ${expected.seasonId}, got ${seasonId}.`);
  if (dataVersion !== expected.dataVersion) {
    throw new Error(`Export snapshot version mismatch: expected ${expected.dataVersion}, got ${dataVersion}.`);
  }

  const arrays = Object.fromEntries(SNAPSHOT_ARRAYS.map((field) => [field, arrayOfObjects(root, field)])) as {
    [K in typeof SNAPSHOT_ARRAYS[number]]: JsonObject[];
  };
  arrays.flightRecords = arrays.flightRecords.map((row, index) =>
    validateFlightRecord(row, `flightRecords[${index}]`, seasonId));
  arrays.flightRecordCounters = arrays.flightRecordCounters.map((row, index) =>
    validateCounter(row, `flightRecordCounters[${index}]`, 'record_id'));
  arrays.flightRecordWindows = arrays.flightRecordWindows.map((row, index) =>
    validateWindow(row, `flightRecordWindows[${index}]`, 'record_id'));
  arrays.modifications = arrays.modifications.map((row, index) =>
    validateModification(row, `modifications[${index}]`, seasonId));
  arrays.modificationCounters = arrays.modificationCounters.map((row, index) =>
    validateCounter(row, `modificationCounters[${index}]`, 'leg_id'));
  arrays.modificationWindows = arrays.modificationWindows.map((row, index) =>
    validateWindow(row, `modificationWindows[${index}]`, 'leg_id'));
  arrays.modificationAddedLegs = arrays.modificationAddedLegs.map((row, index) =>
    validateFlightRecord(row, `modificationAddedLegs[${index}]`, seasonId, true));

  if (arrays.flightRecords.length !== totalCount) {
    throw new Error(`totalCount ${totalCount} does not match flightRecords length ${arrays.flightRecords.length}.`);
  }
  const recordIds = uniqueOwnerIds(arrays.flightRecords, 'record_id', 'flightRecords');
  const modificationIds = uniqueOwnerIds(arrays.modifications, 'leg_id', 'modifications');
  const addedLegIds = uniqueOwnerIds(arrays.modificationAddedLegs, 'leg_id', 'modificationAddedLegs');
  assertRelations(arrays.flightRecordCounters, 'record_id', recordIds, 'flightRecordCounters');
  assertRelations(arrays.flightRecordWindows, 'record_id', recordIds, 'flightRecordWindows');
  assertRelations(arrays.modificationCounters, 'leg_id', modificationIds, 'modificationCounters');
  assertRelations(arrays.modificationWindows, 'leg_id', modificationIds, 'modificationWindows');
  assertRelations(arrays.modificationAddedLegs, 'leg_id', modificationIds, 'modificationAddedLegs');
  const modificationsById = new Map(arrays.modifications.map((modification) => [
    modification.leg_id as string,
    modification,
  ]));
  const addedLegsById = new Map(arrays.modificationAddedLegs.map((addedLeg) => [
    addedLeg.leg_id as string,
    addedLeg,
  ]));
  arrays.modificationAddedLegs.forEach((row, index) => {
    const owner = modificationsById.get(row.leg_id as string);
    if (owner?.action !== 'added') {
      throw new Error(`modificationAddedLegs[${index}].leg_id must reference an added modification.`);
    }
  });
  arrays.modifications.forEach((modification) => {
    const legId = modification.leg_id as string;
    if (modification.action !== 'added') {
      if (!recordIds.has(legId)) {
        throw new Error(`Modification ${legId} with action ${modification.action} must reference a base flight record.`);
      }
      return;
    }
    const changedFields = modification.changed_fields as string[];
    if (!changedFields.includes('addedLeg')) {
      throw new Error(`Added modification ${legId} changed_fields must include addedLeg.`);
    }
    const addedLeg = addedLegsById.get(legId);
    if (!addedLegIds.has(legId) || !addedLeg) {
      throw new Error(`Added modification ${legId} must have exactly one matching added-leg child.`);
    }
    if (recordIds.has(legId)) {
      throw new Error(`Added modification ${legId} must not reference an existing base flight record.`);
    }
    if (addedLeg.record_id !== legId) {
      throw new Error(`Added modification ${legId} child record_id must equal its parent leg_id.`);
    }
    if (addedLeg.action !== 'added') {
      throw new Error(`Added modification ${legId} child action must be added.`);
    }
    if (addedLeg.status !== 'active') {
      throw new Error(`Added modification ${legId} child status must be active.`);
    }
    if (addedLeg.source_kind !== 'added') {
      throw new Error(`Added modification ${legId} child source_kind must be added.`);
    }
    const expectedSourceSide = addedLeg.type === 'A' ? 'ARR' : 'DEP';
    if (addedLeg.source_side !== expectedSourceSide) {
      throw new Error(`Added modification ${legId} child source_side must be ${expectedSourceSide} for type ${addedLeg.type}.`);
    }
  });

  return {
    seasonId,
    seasonCode,
    dataVersion,
    totalCount,
    sourceRowCount,
    serverHighWater,
    truncated: false,
    ...arrays,
  };
}

function groupRowsByKey<T>(rows: T[], getKey: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

export function materializeSeasonalExportSnapshot(
  payload: unknown,
  input: RemoteSeasonalExportSnapshotInput,
): RemoteSeasonalExportSnapshot {
  const snapshot = parseSeasonalExportSnapshotRows(payload, {
    seasonId: input.seasonId,
    dataVersion: input.expectedDataVersion,
  });
  const flightRecordRows = snapshot.flightRecords as FlightRecordRelationalRow[];
  const flightRecordCounters = snapshot.flightRecordCounters as FlightRecordCounterRelationalRow[];
  const flightRecordWindows = snapshot.flightRecordWindows as FlightRecordWindowRelationalRow[];
  const modificationRows = snapshot.modifications as ModificationRelationalRow[];
  const modificationCounters = snapshot.modificationCounters as ModificationCounterRelationalRow[];
  const modificationWindows = snapshot.modificationWindows as ModificationWindowRelationalRow[];
  const modificationAddedLegs = snapshot.modificationAddedLegs as ModificationAddedLegRelationalRow[];
  const countersByRecord = groupRowsByKey(flightRecordCounters, (row) => row.record_id);
  const windowsByRecord = groupRowsByKey(flightRecordWindows, (row) => row.record_id);
  const records = flightRecordRows.map((row) => fromFlightRecordRows(
    row,
    countersByRecord.get(row.record_id) ?? [],
    windowsByRecord.get(row.record_id) ?? [],
  ));
  const countersByLeg = groupRowsByKey(modificationCounters, (row) => row.leg_id);
  const windowsByLeg = groupRowsByKey(modificationWindows, (row) => row.leg_id);
  const addedLegsByLeg = new Map(modificationAddedLegs.map((row) => [row.leg_id, row]));
  const modifications = new Map(modificationRows.map((row) => [row.leg_id, fromModificationRows(
    row,
    countersByLeg.get(row.leg_id) ?? [],
    windowsByLeg.get(row.leg_id) ?? [],
    addedLegsByLeg.get(row.leg_id),
  )]));

  return {
    seasonId: snapshot.seasonId,
    seasonCode: snapshot.seasonCode,
    dataVersion: snapshot.dataVersion,
    totalCount: snapshot.totalCount,
    sourceRowCount: snapshot.sourceRowCount,
    serverHighWater: snapshot.serverHighWater,
    truncated: false,
    records,
    modifications,
  };
}
