import type { CheckInCounterWindowMap, FlightCounter, FlightLeg, FlightModification, FlightRecord, ModHistoryEntry, ParsedRow } from './types';

type PersistedSourceRow = Omit<ParsedRow, 'arrFlightType' | 'depFlightType'> & {
  arrFlightType?: never;
  depFlightType?: never;
};

type PersistedFlightLeg = Omit<FlightLeg, 'flightType'> & {
  flightType?: never;
};

type PersistedFlightRecord = Omit<FlightRecord, 'flightType'> & {
  flightType?: never;
};

export type PersistedFlightModification = Omit<FlightModification, 'addedLeg'> & {
  addedLeg?: PersistedFlightLeg;
};

function stripUndefinedFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedFields(entry)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    cleaned[key] = stripUndefinedFields(entryValue);
  }
  return cleaned as T;
}

function assertIntegerField(value: number | null | undefined, fieldName: string): void {
  if (value == null) return;
  if (!Number.isInteger(value)) throw new Error(`${fieldName} must be an integer.`);
}

function assertPositiveIntegerField(value: number | null | undefined, fieldName: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${fieldName} must be a positive integer.`);
}

const OPERATIONAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

function assertOperationalTimeField(value: string | null | undefined, fieldName: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !OPERATIONAL_TIME_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use HH:mm format.`);
  }
}

function assertCheckInDateTimeField(value: string | null | undefined, fieldName: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !LOCAL_DATETIME_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use yyyy-mm-ddTHH:mm format.`);
  }
  const [datePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} must use yyyy-mm-ddTHH:mm format.`);
  }
}

function assertCheckInAllocationMode(value: unknown): void {
  if (value == null) return;
  if (value !== 'grouped' && value !== 'broken') {
    throw new Error('checkInAllocationMode must be grouped or broken.');
  }
}

function assertCheckInCounterWindows(value: CheckInCounterWindowMap | null | undefined): void {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('checkInCounterWindows must be an object of counter window assignments.');
  }
  for (const [counterKey, window] of Object.entries(value)) {
    if (!window || typeof window !== 'object' || Array.isArray(window)) {
      throw new Error(`checkInCounterWindows.${counterKey} must include start and end.`);
    }
    assertCheckInDateTimeField(window.start, `checkInCounterWindows.${counterKey}.start`);
    assertCheckInDateTimeField(window.end, `checkInCounterWindows.${counterKey}.end`);
    if (new Date(`${window.start}:00`).getTime() >= new Date(`${window.end}:00`).getTime()) {
      throw new Error(`checkInCounterWindows.${counterKey}.start must be before end.`);
    }
  }
}

function assertCounterField(value: FlightCounter | undefined): void {
  if (value == null) return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    const isValidArray = value.every((entry) => typeof entry === 'string' || typeof entry === 'number');
    if (isValidArray) return;
  } else if (typeof value === 'object') {
    const isValidObject = Object.values(value).every((entry) =>
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      (Array.isArray(entry) && entry.every((item) => typeof item === 'string' || typeof item === 'number'))
    );
    if (isValidObject) return;
  }
  throw new Error('counter must be a string, array, or object of string/number assignments.');
}

function assertOperationalFields(value: Partial<FlightLeg | FlightModification>): void {
  assertIntegerField(value.pax, 'pax');
  assertPositiveIntegerField(value.gate, 'gate');
  assertPositiveIntegerField(value.stand, 'stand');
  assertPositiveIntegerField(value.carousel, 'carousel');
  assertOperationalTimeField(value.mct, 'mct');
  assertOperationalTimeField(value.fb, 'fb');
  assertOperationalTimeField(value.lb, 'lb');
  assertCheckInDateTimeField(value.checkInStart, 'checkInStart');
  assertCheckInDateTimeField(value.checkInEnd, 'checkInEnd');
  assertCheckInAllocationMode(value.checkInAllocationMode);
  assertCheckInCounterWindows(value.checkInCounterWindows);
  assertCounterField(value.counter);
}

type OperationalFieldDefaults = Pick<
  FlightLeg,
  | 'pax'
  | 'gate'
  | 'stand'
  | 'counter'
  | 'carousel'
  | 'mct'
  | 'fb'
  | 'lb'
  | 'bhs'
  | 'ghs'
  | 'checkInStart'
  | 'checkInEnd'
  | 'checkInAllocationMode'
  | 'checkInCounterWindows'
>;

function hydrateOperationalFields<T extends Partial<FlightLeg>>(leg: T): T & OperationalFieldDefaults {
  return {
    ...leg,
    pax: leg.pax ?? null,
    gate: leg.gate ?? null,
    stand: leg.stand ?? null,
    counter: leg.counter ?? null,
    carousel: leg.carousel ?? null,
    mct: leg.mct ?? null,
    fb: leg.fb ?? null,
    lb: leg.lb ?? null,
    bhs: leg.bhs ?? null,
    ghs: leg.ghs ?? null,
    checkInStart: leg.checkInStart ?? null,
    checkInEnd: leg.checkInEnd ?? null,
    checkInAllocationMode: leg.checkInAllocationMode ?? null,
    checkInCounterWindows: leg.checkInCounterWindows ?? null,
  };
}

export function serializeSourceRowForPersistence(row: ParsedRow): PersistedSourceRow {
  const persisted = { ...row } as Partial<ParsedRow>;
  delete persisted.arrFlightType;
  delete persisted.depFlightType;
  return stripUndefinedFields(persisted as PersistedSourceRow);
}

export function hydrateSourceRowFromPersistence(row: Partial<ParsedRow>): ParsedRow {
  return {
    ...row,
    arrFlightType: null,
    depFlightType: null,
  } as ParsedRow;
}

export function serializeFlightLegForPersistence<T extends FlightLeg>(leg: T): Omit<T, 'flightType'> {
  assertOperationalFields(leg);
  const persisted = { ...leg } as Partial<T>;
  delete persisted.flightType;
  return stripUndefinedFields(persisted as Omit<T, 'flightType'>);
}

export function hydrateFlightLegFromPersistence<T extends Partial<FlightLeg>>(leg: T): T & Pick<FlightLeg, 'flightType'> & OperationalFieldDefaults {
  return {
    ...hydrateOperationalFields(leg),
    flightType: 'PAX',
  } as T & Pick<FlightLeg, 'flightType'> & OperationalFieldDefaults;
}

export function serializeFlightRecordForPersistence(record: FlightRecord): PersistedFlightRecord {
  return serializeFlightLegForPersistence(record) as PersistedFlightRecord;
}

export function hydrateFlightRecordFromPersistence(record: Partial<FlightRecord>): FlightRecord {
  return hydrateFlightLegFromPersistence(record) as FlightRecord;
}

export function serializeFlightModificationForPersistence(mod: FlightModification): PersistedFlightModification {
  assertOperationalFields(mod);
  if (mod.action === 'added' && mod.addedLeg) {
    return stripUndefinedFields({
      ...mod,
      addedLeg: serializeFlightLegForPersistence(mod.addedLeg),
    });
  }
  return stripUndefinedFields(mod as PersistedFlightModification);
}

export function hydrateFlightModificationFromPersistence(mod: PersistedFlightModification | FlightModification): FlightModification {
  if (mod.action === 'added' && mod.addedLeg) {
    return {
      ...mod,
      addedLeg: hydrateFlightLegFromPersistence(mod.addedLeg) as FlightLeg,
    };
  }
  return mod as FlightModification;
}

export function serializeModHistoryEntryForPersistence(entry: ModHistoryEntry): ModHistoryEntry {
  return stripUndefinedFields({
    ...entry,
    changes: entry.changes.map((change) => ({
      ...change,
      previousMod: change.previousMod ? serializeFlightModificationForPersistence(change.previousMod) as FlightModification : null,
      newMod: serializeFlightModificationForPersistence(change.newMod) as FlightModification,
    })),
    recordChanges: entry.recordChanges?.map((change) => ({
      ...change,
      previousRecord: change.previousRecord ? serializeFlightRecordForPersistence(change.previousRecord) as unknown as FlightRecord : null,
      newRecord: change.newRecord ? serializeFlightRecordForPersistence(change.newRecord) as unknown as FlightRecord : null,
    })),
  });
}

export function hydrateModHistoryEntryFromPersistence(entry: ModHistoryEntry): ModHistoryEntry {
  return {
    ...entry,
    changes: entry.changes.map((change) => ({
      ...change,
      previousMod: change.previousMod ? hydrateFlightModificationFromPersistence(change.previousMod) : null,
      newMod: hydrateFlightModificationFromPersistence(change.newMod),
    })),
    recordChanges: entry.recordChanges?.map((change) => ({
      ...change,
      previousRecord: change.previousRecord ? hydrateFlightRecordFromPersistence(change.previousRecord) : null,
      newRecord: change.newRecord ? hydrateFlightRecordFromPersistence(change.newRecord) : null,
    })),
  };
}
