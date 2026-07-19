type JsonObject = Record<string, unknown>;

export interface SeasonalExportSnapshotRows {
  seasonId: string;
  dataVersion: number;
  totalCount: number;
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
  const dataVersion = nonNegativeInteger(root, 'dataVersion');
  const totalCount = nonNegativeInteger(root, 'totalCount');
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
  arrays.modificationAddedLegs.forEach((row, index) => {
    const owner = modificationsById.get(row.leg_id as string);
    if (owner?.action !== 'added') {
      throw new Error(`modificationAddedLegs[${index}].leg_id must reference an added modification.`);
    }
  });
  arrays.modifications.forEach((modification) => {
    if (modification.action !== 'added') return;
    const legId = modification.leg_id as string;
    const changedFields = modification.changed_fields as string[];
    if (!changedFields.includes('addedLeg')) {
      throw new Error(`Added modification ${legId} changed_fields must include addedLeg.`);
    }
    if (!addedLegIds.has(legId)) {
      throw new Error(`Added modification ${legId} must have exactly one matching added-leg child.`);
    }
  });

  return {
    seasonId,
    dataVersion,
    totalCount,
    serverHighWater,
    truncated: false,
    ...arrays,
  };
}
