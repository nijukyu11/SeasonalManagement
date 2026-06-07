import type { FlightLeg, FlightModification, FlightRecord, ModHistoryEntry } from './types';
import { buildOperationalFlightMetadata } from './iataSeason.ts';
import {
  expectedDateForLinkedLeg,
  findValidLinkedCounterpart,
  inferLinkedPairType,
  isValidLinkedFlightPair,
  shiftIsoDate,
} from './flightPairIntegrity.ts';

export interface OvernightCompanionState {
  flightNumber: string;
  schedule: string;
  route: string;
  aircraft: string;
  type: 'A' | 'D';
  linkId: string;
}

export function formatLinkedFlightTime(
  schedule: string | null | undefined,
  linkType: 'overnight' | 'sameday' | null | undefined,
  linkedFlightType?: 'A' | 'D' | null
): string {
  if (!schedule) return '—';
  if (linkType !== 'overnight') return schedule;
  return `${schedule} ${linkedFlightType === 'A' ? '-1' : '+1'}`;
}

export function applyFlightRecordUpdates<T extends Pick<FlightRecord, 'id'>>(records: T[], updatedRecords: T[]): T[] {
  if (updatedRecords.length === 0) return records;
  const updatesById = new Map(updatedRecords.map((record) => [record.id, record]));
  return records.map((record) => updatesById.get(record.id) ?? record);
}

export function buildSpatialCalendarDateSelection(
  calendarDates: Array<string | null>,
  startDate: string,
  endDate: string,
  columnCount = 7
): string[] {
  const startIndex = calendarDates.indexOf(startDate);
  const endIndex = calendarDates.indexOf(endDate);
  if (startIndex < 0 || endIndex < 0 || columnCount <= 0) return [];

  const startRow = Math.floor(startIndex / columnCount);
  const endRow = Math.floor(endIndex / columnCount);
  const startColumn = startIndex % columnCount;
  const endColumn = endIndex % columnCount;
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minColumn = Math.min(startColumn, endColumn);
  const maxColumn = Math.max(startColumn, endColumn);

  return calendarDates.filter((date, index) => {
    if (!date) return false;
    const row = Math.floor(index / columnCount);
    const column = index % columnCount;
    return row >= minRow && row <= maxRow && column >= minColumn && column <= maxColumn;
  }) as string[];
}

export type CalendarSelectionMode = 'replace' | 'append';

export function mergeCalendarDateSelections(
  currentDates: string[],
  nextDates: string[],
  mode: CalendarSelectionMode
): string[] {
  if (mode === 'replace') return [...nextDates];
  return Array.from(new Set([...currentDates, ...nextDates])).sort();
}

export type NewFlightDateSelection =
  | { kind: 'dates'; dates: string[] }
  | { kind: 'range'; dates: [string, string] };

function addUtcDays(isoDate: string, offsetDays: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

function expandIsoDateRange(startDate: string, endDate: string): string[] {
  const start = startDate <= endDate ? startDate : endDate;
  const end = startDate <= endDate ? endDate : startDate;
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = addUtcDays(cursor, 1);
  }
  return dates;
}

export function normalizeNewFlightDateSelection(
  selection?: NewFlightDateSelection,
  fallbackCsvDates = ''
): string[] {
  const rawDates = selection
    ? selection.kind === 'range'
      ? expandIsoDateRange(selection.dates[0], selection.dates[1])
      : selection.dates
    : fallbackCsvDates.split(',');

  return Array.from(new Set(rawDates.map((date) => date.trim()).filter(Boolean))).sort();
}

type DetailedNewFlightType = 'arrival' | 'departure' | 'turnaround';

export interface DetailedNewFlightInput {
  dates: string[];
  airline: string;
  flightType: DetailedNewFlightType;
  aircraft: string;
  category: string;
  arrFlightNum: string;
  arrRoute: string;
  arrTime: string;
  arrCodeShares: string;
  depFlightNum: string;
  depRoute: string;
  depTime: string;
  depCodeShares: string;
  idSeed?: string;
}

export function buildDetailedNewFlightModifications(input: DetailedNewFlightInput): FlightModification[] {
  const dates = normalizeNewFlightDateSelection({ kind: 'dates', dates: input.dates });
  const airline = input.airline.trim().toUpperCase();
  const aircraft = input.aircraft.trim();
  const category = input.category;
  const showArr = input.flightType === 'arrival' || input.flightType === 'turnaround';
  const showDep = input.flightType === 'departure' || input.flightType === 'turnaround';
  const seed = input.idSeed ?? `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${seed}_${sequence++}`;
  const mods: FlightModification[] = [];

  for (const dateStr of dates) {
    const sharedLinkId = input.flightType === 'turnaround' ? nextId('L_NEW') : null;
    const arrId = showArr ? nextId('F_NEW') : null;
    const depId = showDep ? nextId('F_NEW') : null;

    if (showArr && arrId) {
      const arrLeg: FlightLeg = {
        id: arrId,
        linkId: sharedLinkId ?? `L_${arrId}`,
        type: 'A',
        airline,
        flightNumber: `${airline}${input.arrFlightNum.trim().padStart(3, '0')}`,
        rawFlightNumber: input.arrFlightNum.trim(),
        requestStatusCode: null,
        route: input.arrRoute.trim().toUpperCase(),
        schedule: input.arrTime,
        aircraft,
        category,
        flightType: 'PAX',
        codeShares: input.arrCodeShares.trim() || null,
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
        date: dateStr,
        dayOfWeek: new Date(`${dateStr}T00:00:00Z`).getUTCDay(),
        action: 'added',
        sourceRowIndex: -1,
        ...(input.flightType === 'turnaround' && depId ? {
          linkType: 'sameday' as const,
          pairAnchorDate: dateStr,
          linkedRecordId: depId,
        } : {}),
      };
      mods.push({ legId: arrId, action: 'added', addedLeg: arrLeg });
    }

    if (showDep && depId) {
      const depLeg: FlightLeg = {
        id: depId,
        linkId: sharedLinkId ?? `L_${depId}`,
        type: 'D',
        airline,
        flightNumber: `${airline}${input.depFlightNum.trim().padStart(3, '0')}`,
        rawFlightNumber: input.depFlightNum.trim(),
        requestStatusCode: null,
        route: input.depRoute.trim().toUpperCase(),
        schedule: input.depTime,
        aircraft,
        category,
        flightType: 'PAX',
        codeShares: input.depCodeShares.trim() || null,
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
        date: dateStr,
        dayOfWeek: new Date(`${dateStr}T00:00:00Z`).getUTCDay(),
        action: 'added',
        sourceRowIndex: -1,
        ...(input.flightType === 'turnaround' && arrId ? {
          linkType: 'sameday' as const,
          pairAnchorDate: dateStr,
          linkedRecordId: arrId,
        } : {}),
      };
      mods.push({ legId: depId, action: 'added', addedLeg: depLeg });
    }
  }

  return mods;
}

export function addedModificationToFlightRecord(mod: FlightModification): FlightRecord | null {
  if (mod.action !== 'added' || !mod.addedLeg) return null;
  const leg = mod.addedLeg;
  return {
    ...leg,
    action: null,
    sourceKind: 'added',
    sourceSide: leg.type === 'A' ? 'ARR' : 'DEP',
    status: 'active',
  };
}

function findUndefinedPayloadPath(value: unknown, path = 'record'): string | null {
  if (value === undefined) return path;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUndefinedPayloadPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = findUndefinedPayloadPath(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function assertCanonicalAddedFlightRecord(record: FlightRecord, index: number): void {
  const missingFields = [
    ['id', record.id],
    ['linkId', record.linkId],
    ['type', record.type],
    ['airline', record.airline],
    ['flightNumber', record.flightNumber],
    ['rawFlightNumber', record.rawFlightNumber],
    ['route', record.route],
    ['schedule', record.schedule],
    ['date', record.date],
  ]
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([field]) => field);
  if (missingFields.length > 0) {
    throw new Error(`Added flight record ${index} is missing required fields: ${missingFields.join(', ')}.`);
  }
  if (record.sourceKind !== 'added') {
    throw new Error(`Added flight record ${record.id} must use sourceKind=added.`);
  }
  if (record.sourceSide !== (record.type === 'A' ? 'ARR' : 'DEP')) {
    throw new Error(`Added flight record ${record.id} has inconsistent sourceSide.`);
  }
  if (record.status !== 'active') {
    throw new Error(`Added flight record ${record.id} must be active before native persistence.`);
  }
  if (record.action !== null) {
    throw new Error(`Added flight record ${record.id} must persist with action=null.`);
  }
  const undefinedPath = findUndefinedPayloadPath(record);
  if (undefinedPath) {
    throw new Error(`Added flight record ${record.id} contains undefined at ${undefinedPath}.`);
  }
}

export function buildCanonicalAddedFlightRecords(mods: FlightModification[]): FlightRecord[] {
  return mods.map((mod, index) => {
    const record = addedModificationToFlightRecord(mod);
    if (!record) {
      throw new Error(`Added flight payload ${index} is missing leg data.`);
    }
    assertCanonicalAddedFlightRecord(record, index);
    return record;
  });
}

export function addedModificationsToFlightRecords(mods: FlightModification[]): FlightRecord[] {
  return mods.flatMap((mod) => {
    const record = addedModificationToFlightRecord(mod);
    return record ? [record] : [];
  });
}

export function applyModificationBatch(
  currentMods: Map<string, FlightModification>,
  mods: FlightModification[]
): Map<string, FlightModification> {
  const next = new Map(currentMods);
  for (const mod of mods) {
    next.set(mod.legId, mod);
  }
  return next;
}

export function revertModificationHistoryMap(
  currentMods: Map<string, FlightModification>,
  entriesToUndo: ModHistoryEntry[]
): Map<string, FlightModification> {
  const next = new Map(currentMods);
  const sorted = [...entriesToUndo].sort((a, b) => b.timestamp - a.timestamp);
  for (const entry of sorted) {
    for (const change of entry.changes) {
      if (change.previousMod) {
        next.set(change.legId, change.previousMod);
      } else {
        next.delete(change.legId);
      }
    }
  }
  return next;
}

export function revertFlightRecordHistoryList(
  currentRecords: FlightRecord[],
  entriesToUndo: ModHistoryEntry[]
): FlightRecord[] {
  const nextById = new Map(currentRecords.map((record) => [record.id, record]));
  const sorted = [...entriesToUndo].sort((a, b) => b.timestamp - a.timestamp);
  for (const entry of sorted) {
    for (const change of entry.recordChanges ?? []) {
      if (change.previousRecord) {
        nextById.set(change.recordId, change.previousRecord);
      } else {
        nextById.delete(change.recordId);
      }
    }
  }
  const order = new Map(currentRecords.map((record, index) => [record.id, index]));
  return Array.from(nextById.values()).sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function buildFlightRecordHistoryEntry({
  id,
  timestamp,
  description,
  beforeRecords,
  afterRecords,
}: {
  id: string;
  timestamp: number;
  description: string;
  beforeRecords: FlightRecord[];
  afterRecords: FlightRecord[];
}): ModHistoryEntry | null {
  const beforeById = new Map(beforeRecords.map((record) => [record.id, record]));
  const afterById = new Map(afterRecords.map((record) => [record.id, record]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const recordChanges = Array.from(ids).flatMap((recordId) => {
    const previousRecord = beforeById.get(recordId) ?? null;
    const newRecord = afterById.get(recordId) ?? null;
    if (JSON.stringify(previousRecord) === JSON.stringify(newRecord)) return [];
    return [{ recordId, previousRecord, newRecord }];
  });
  if (recordChanges.length === 0) return null;
  return {
    id,
    timestamp,
    description,
    changes: [],
    recordChanges,
  };
}

export function countHistoryEntryLegs(entry: ModHistoryEntry): number {
  return entry.changes.length + (entry.recordChanges?.length ?? 0);
}

export function applyModificationsToFlightLegs(
  baseLegs: FlightLeg[],
  mods: Map<string, FlightModification>
): FlightLeg[] {
  const next = baseLegs
    .map((leg) => {
      const mod = mods.get(leg.id);
      if (!mod) return leg;
      if (mod.action === 'deleted') return { ...leg, action: 'deleted' as const };
      if (mod.action === 'modified') {
        return {
          ...leg,
          schedule: mod.schedule ?? leg.schedule,
          aircraft: mod.aircraft ?? leg.aircraft,
          route: mod.route ?? leg.route,
          codeShares: 'codeShares' in mod ? mod.codeShares ?? null : leg.codeShares,
          pax: 'pax' in mod ? mod.pax ?? null : leg.pax,
          gate: 'gate' in mod ? mod.gate ?? null : leg.gate,
          stand: 'stand' in mod ? mod.stand ?? null : leg.stand,
          counter: 'counter' in mod ? mod.counter ?? null : leg.counter,
          carousel: 'carousel' in mod ? mod.carousel ?? null : leg.carousel,
          mct: 'mct' in mod ? mod.mct ?? null : leg.mct,
          fb: 'fb' in mod ? mod.fb ?? null : leg.fb,
          lb: 'lb' in mod ? mod.lb ?? null : leg.lb,
          bhs: 'bhs' in mod ? mod.bhs ?? null : leg.bhs,
          ghs: 'ghs' in mod ? mod.ghs ?? null : leg.ghs,
          action: 'modified' as const,
        };
      }
      return leg;
    })
    .filter((leg) => leg.action !== 'deleted');

  for (const mod of mods.values()) {
    if (mod.action === 'added' && mod.addedLeg) {
      next.push({ ...mod.addedLeg, action: 'added' });
    }
  }

  return next;
}

export function filterDetailedLegs(
  legs: FlightLeg[],
  targetArrFlight: string | null,
  targetDepFlight: string | null
): FlightLeg[] {
  if (!targetArrFlight && !targetDepFlight) return [];
  return legs.filter((leg) => {
    if (targetArrFlight && leg.type === 'A' && leg.flightNumber === targetArrFlight) return true;
    if (targetDepFlight && leg.type === 'D' && leg.flightNumber === targetDepFlight) return true;
    return false;
  });
}

export function filterDetailedLegsForView(
  legs: FlightLeg[],
  targetArrFlight: string | null,
  targetDepFlight: string | null,
  dateFrom?: string | null,
  dateTo?: string | null
): FlightLeg[] {
  const from = dateFrom?.trim() || null;
  const to = dateTo?.trim() || null;
  return filterDetailedLegs(legs, targetArrFlight, targetDepFlight).filter((leg) => {
    if (from && leg.date < from) return false;
    if (to && leg.date > to) return false;
    return true;
  });
}

export interface DetailedScheduleQueryWindow {
  dateFrom: string | null;
  dateTo: string | null;
  flightNumberFilter: string | null;
}

export function buildDetailedScheduleQueryWindow(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  targetArrFlight?: string | null;
  targetDepFlight?: string | null;
}): DetailedScheduleQueryWindow {
  const dateFrom = input.dateFrom?.trim() || null;
  const dateTo = input.dateTo?.trim() || null;
  const hasFlightSelection = Boolean(input.targetArrFlight || input.targetDepFlight);
  if (!hasFlightSelection) {
    return {
      dateFrom,
      dateTo,
      flightNumberFilter: null,
    };
  }
  return {
    dateFrom: dateFrom ? shiftIsoDate(dateFrom, -1) : null,
    dateTo: dateTo ? shiftIsoDate(dateTo, 1) : null,
    flightNumberFilter: null,
  };
}

export type DetailedTransferMode = 'copy' | 'move';

export interface DetailedTransferInput {
  sourceLeg: FlightLeg;
  visibleLegs: FlightLeg[];
  allLegs: FlightLeg[];
  targetDate: string;
  mode: DetailedTransferMode;
  idSeed?: string;
}

function targetAnchorDateForTransfer(sourceLeg: FlightLeg, targetDate: string, linkType: 'overnight' | 'sameday'): string {
  if (linkType === 'overnight' && sourceLeg.type === 'D') return shiftIsoDate(targetDate, -1);
  return targetDate;
}

function transferredSingleLeg(sourceLeg: FlightLeg, targetDate: string, newId: string): FlightLeg {
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: targetDate,
    scheduledTime: sourceLeg.scheduledTime ?? sourceLeg.schedule,
    type: sourceLeg.type,
    airline: sourceLeg.airline,
    flightNumber: sourceLeg.flightNumber,
    route: sourceLeg.route,
  });
  const next: FlightLeg = {
    ...sourceLeg,
    ...metadata,
    id: newId,
    linkId: `L_${newId}`,
    date: metadata.scheduledDate,
    dayOfWeek: new Date(`${metadata.scheduledDate}T00:00:00Z`).getUTCDay(),
    action: 'added',
  };
  delete next.linkType;
  delete next.pairAnchorDate;
  delete next.linkedRecordId;
  delete next.linkedSourceRowIndex;
  return next;
}

function transferredPairLeg(
  sourceLeg: FlightLeg,
  targetDate: string,
  newId: string,
  sharedLinkId: string,
  linkedRecordId: string,
  linkType: 'overnight' | 'sameday',
  pairAnchorDate: string,
  linkedSourceRowIndex: number
): FlightLeg {
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: targetDate,
    scheduledTime: sourceLeg.scheduledTime ?? sourceLeg.schedule,
    type: sourceLeg.type,
    airline: sourceLeg.airline,
    flightNumber: sourceLeg.flightNumber,
    route: sourceLeg.route,
  });
  return {
    ...sourceLeg,
    ...metadata,
    id: newId,
    linkId: sharedLinkId,
    date: metadata.scheduledDate,
    dayOfWeek: new Date(`${metadata.scheduledDate}T00:00:00Z`).getUTCDay(),
    action: 'added',
    linkType,
    pairAnchorDate,
    linkedRecordId,
    linkedSourceRowIndex,
  };
}

export function buildDetailedTransferModifications(input: DetailedTransferInput): FlightModification[] {
  const seed = input.idSeed ?? `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${seed}_${sequence++}`;
  const counterpart = findValidLinkedCounterpart(input.sourceLeg, input.allLegs);

  if (!counterpart) {
    const newId = nextId('F_NEW');
    const mods: FlightModification[] = [{
      legId: newId,
      action: 'added',
      addedLeg: transferredSingleLeg(input.sourceLeg, input.targetDate, newId),
    }];
    if (input.mode === 'move') mods.push({ legId: input.sourceLeg.id, action: 'deleted' });
    return mods;
  }

  const sourcePair = input.sourceLeg.type === 'A'
    ? { arr: input.sourceLeg, dep: counterpart }
    : { arr: counterpart, dep: input.sourceLeg };
  if (!isValidLinkedFlightPair(sourcePair.arr, sourcePair.dep)) {
    const newId = nextId('F_NEW');
    const mods: FlightModification[] = [{
      legId: newId,
      action: 'added',
      addedLeg: transferredSingleLeg(input.sourceLeg, input.targetDate, newId),
    }];
    if (input.mode === 'move') mods.push({ legId: input.sourceLeg.id, action: 'deleted' });
    return mods;
  }

  const linkType = inferLinkedPairType(sourcePair.arr, sourcePair.dep);
  const pairAnchorDate = targetAnchorDateForTransfer(input.sourceLeg, input.targetDate, linkType);
  const sharedLinkId = nextId('L_NEW');
  const arrId = nextId('F_NEW');
  const depId = nextId('F_NEW');
  const arrDate = expectedDateForLinkedLeg(pairAnchorDate, 'A', linkType);
  const depDate = expectedDateForLinkedLeg(pairAnchorDate, 'D', linkType);
  const arrLeg = transferredPairLeg(sourcePair.arr, arrDate, arrId, sharedLinkId, depId, linkType, pairAnchorDate, sourcePair.dep.sourceRowIndex);
  const depLeg = transferredPairLeg(sourcePair.dep, depDate, depId, sharedLinkId, arrId, linkType, pairAnchorDate, sourcePair.arr.sourceRowIndex);
  const mods: FlightModification[] = [
    { legId: arrId, action: 'added', addedLeg: arrLeg },
    { legId: depId, action: 'added', addedLeg: depLeg },
  ];

  if (input.mode === 'move') {
    mods.push({ legId: sourcePair.arr.id, action: 'deleted' });
    mods.push({ legId: sourcePair.dep.id, action: 'deleted' });
  }

  return mods;
}

export function buildOvernightCompanionMap(
  primaryLegs: FlightLeg[],
  allLegs: FlightLeg[]
): Map<string, OvernightCompanionState> {
  const companionMap = new Map<string, OvernightCompanionState>();

  for (const leg of primaryLegs) {
    if (!leg.linkId) continue;
    const linked = findValidLinkedCounterpart(leg, allLegs);
    if (!linked) continue;

    const key = `${leg.date}_${leg.id}`;
    if (leg.type === 'A') {
      companionMap.set(key, {
        flightNumber: linked.flightNumber,
        schedule: leg.linkType === 'overnight' ? `${linked.schedule}+1` : linked.schedule,
        route: linked.route,
        aircraft: linked.aircraft,
        type: 'D',
        linkId: leg.linkId,
      });
    } else {
      companionMap.set(key, {
        flightNumber: linked.flightNumber,
        schedule: leg.linkType === 'overnight' ? `${linked.schedule}-1` : linked.schedule,
        route: linked.route,
        aircraft: linked.aircraft,
        type: 'A',
        linkId: leg.linkId,
      });
    }
  }

  return companionMap;
}
