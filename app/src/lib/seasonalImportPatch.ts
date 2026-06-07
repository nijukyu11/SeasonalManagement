import { getOperationalDate } from './iataSeason.ts';
import type { FlightModification, FlightRecord, ParsedRow } from './types.ts';

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

interface ImportScope {
  identity: string;
  start: string;
  end: string;
}

interface TotalImportScope {
  start: string;
  end: string;
}

export interface SeasonalImportPatchStats {
  imported: number;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  affected: number;
}

export interface SeasonalImportPatchInput {
  existingRecords: FlightRecord[];
  existingModifications: Map<string, FlightModification>;
  importedRows: ParsedRow[];
  importedRecords: FlightRecord[];
}

export interface SeasonalImportPatchResult {
  mergedRecords: FlightRecord[];
  recordsToWrite: FlightRecord[];
  remainingModifications: Map<string, FlightModification>;
  affectedRecordIds: string[];
  modificationDeleteRecordIds: string[];
  stats: SeasonalImportPatchStats;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function timeToMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseImportDate(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parts = raw.split('-');
  if (parts.length < 3) return null;
  const day = Number(parts[0]);
  const month = MONTHS[String(parts[1]).trim().slice(0, 3).toUpperCase()];
  const yearValue = Number(parts[2]);
  if (!Number.isFinite(day) || month == null || !Number.isFinite(yearValue)) return null;
  const year = yearValue < 100 ? 2000 + yearValue : yearValue;
  return isoDate(new Date(Date.UTC(year, month, day)));
}

function normalizePart(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase();
}

function rowFlightNumber(row: ParsedRow, side: 'ARR' | 'DEP'): string | null {
  const rawFlight = side === 'ARR' ? row.arrFlight : row.depFlight;
  if (!rawFlight) return null;
  const raw = normalizePart(rawFlight);
  if (!raw) return null;
  const normalizedFlight = /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw;
  return `${normalizePart(row.airline)}${normalizedFlight}`;
}

function identity(type: FlightRecord['type'], airline: string, flightNumber: string): string {
  return [type, normalizePart(airline), normalizePart(flightNumber)].join('|');
}

function recordOperationalDate(record: FlightRecord): string {
  return record.operationalDate ?? getOperationalDate(record.scheduledDate ?? record.date, record.scheduledTime ?? record.schedule);
}

function naturalKey(record: FlightRecord): string {
  return [identity(record.type, record.airline, record.flightNumber), recordOperationalDate(record)].join('|');
}

function rowScope(row: ParsedRow, side: 'ARR' | 'DEP'): ImportScope | null {
  const flightNumber = rowFlightNumber(row, side);
  const schedule = side === 'ARR' ? row.sta : row.std;
  if (!flightNumber || !schedule) return null;
  let start = parseImportDate(row.effective);
  let end = parseImportDate(row.discontinue);
  if (!start || !end) return null;
  const depMinutes = timeToMinutes(row.std);
  const arrMinutes = timeToMinutes(row.sta);
  if (
    side === 'DEP' &&
    row.arrFlight &&
    row.depFlight &&
    (row.linkType === 'overnight' || (row.linkType == null && depMinutes != null && arrMinutes != null && depMinutes < arrMinutes))
  ) {
    start = shiftIsoDate(start, 1);
    end = shiftIsoDate(end, 1);
  }
  return {
    identity: identity(side === 'ARR' ? 'A' : 'D', row.airline, flightNumber),
    start: getOperationalDate(start, schedule),
    end: getOperationalDate(end, schedule),
  };
}

function buildScopes(rows: ParsedRow[]): ImportScope[] {
  const scopes: ImportScope[] = [];
  for (const row of rows) {
    const arrival = rowScope(row, 'ARR');
    const departure = rowScope(row, 'DEP');
    if (arrival) scopes.push(arrival);
    if (departure) scopes.push(departure);
  }
  return scopes;
}

function buildTotalScopes(scopes: ImportScope[]): Map<string, TotalImportScope> {
  const totals = new Map<string, TotalImportScope>();
  for (const scope of scopes) {
    const current = totals.get(scope.identity);
    if (!current) {
      totals.set(scope.identity, { start: scope.start, end: scope.end });
      continue;
    }
    totals.set(scope.identity, {
      start: scope.start < current.start ? scope.start : current.start,
      end: scope.end > current.end ? scope.end : current.end,
    });
  }
  return totals;
}

function isRecordInTotalScope(record: FlightRecord, totalScopes: Map<string, TotalImportScope>): boolean {
  const recordIdentity = identity(record.type, record.airline, record.flightNumber);
  const operationalDate = recordOperationalDate(record);
  const totalScope = totalScopes.get(recordIdentity);
  return !!totalScope && operationalDate >= totalScope.start && operationalDate <= totalScope.end;
}

function rewriteImportedRecordIds(records: FlightRecord[], idMap: Map<string, string>): FlightRecord[] {
  return records.map((record) => {
    const nextId = idMap.get(record.id) ?? record.id;
    const nextLinkedRecordId = record.linkedRecordId ? idMap.get(record.linkedRecordId) ?? record.linkedRecordId : undefined;
    const nextLinkId = idMap.get(record.linkId) ?? (record.linkId === record.id ? nextId : record.linkId);
    return {
      ...record,
      id: nextId,
      linkId: nextLinkId,
      ...(nextLinkedRecordId ? { linkedRecordId: nextLinkedRecordId } : { linkedRecordId: undefined }),
    };
  });
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function clearTurnaroundLink(record: FlightRecord): FlightRecord {
  const next: FlightRecord = {
    ...record,
    linkId: record.id,
  };
  delete next.turnaroundId;
  delete next.pairAnchorDate;
  delete next.linkedRecordId;
  delete next.linkedSourceRowIndex;
  delete next.linkType;
  return next;
}

function hasTurnaroundMetadata(record: FlightRecord): boolean {
  return !!record.turnaroundId || !!record.linkedRecordId || !!record.linkType || !!record.pairAnchorDate;
}

function findUnsafeTurnaroundLinkIds(records: FlightRecord[]): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const activeTurnaroundGroups = new Map<string, FlightRecord[]>();
  for (const record of records) {
    if (record.status === 'deleted' || !record.turnaroundId) continue;
    const group = activeTurnaroundGroups.get(record.turnaroundId) ?? [];
    group.push(record);
    activeTurnaroundGroups.set(record.turnaroundId, group);
  }

  const unsafeIds = new Set<string>();
  for (const record of records) {
    if (!hasTurnaroundMetadata(record)) continue;
    if (record.status === 'deleted') {
      unsafeIds.add(record.id);
      continue;
    }

    if (record.linkedRecordId) {
      const linked = byId.get(record.linkedRecordId);
      if (!linked || linked.status === 'deleted' || linked.linkedRecordId !== record.id) {
        unsafeIds.add(record.id);
        continue;
      }
    }

    if (record.turnaroundId) {
      const group = activeTurnaroundGroups.get(record.turnaroundId) ?? [];
      const reciprocal = record.linkedRecordId ? byId.get(record.linkedRecordId) : null;
      if (group.length !== 2 || !reciprocal || reciprocal.turnaroundId !== record.turnaroundId) {
        unsafeIds.add(record.id);
      }
    }
  }

  if (unsafeIds.size === 0) return unsafeIds;
  for (const record of records) {
    if (!hasTurnaroundMetadata(record)) continue;
    if (record.linkedRecordId && unsafeIds.has(record.linkedRecordId)) unsafeIds.add(record.id);
    if (record.turnaroundId && records.some((candidate) => candidate.turnaroundId === record.turnaroundId && unsafeIds.has(candidate.id))) {
      unsafeIds.add(record.id);
    }
  }
  return unsafeIds;
}

export function buildSeasonalImportPatch(input: SeasonalImportPatchInput): SeasonalImportPatchResult {
  const scopes = buildScopes(input.importedRows);
  const totalScopes = buildTotalScopes(scopes);
  const existingByNaturalKey = new Map<string, FlightRecord>();
  for (const record of input.existingRecords) {
    const key = naturalKey(record);
    const current = existingByNaturalKey.get(key);
    if (!current || (current.status === 'deleted' && record.status !== 'deleted')) {
      existingByNaturalKey.set(key, record);
    }
  }

  const importedIdMap = new Map<string, string>();
  const writeIds = new Set<string>();
  const modificationDeleteIds = new Set<string>();
  const importedFinalRecords: FlightRecord[] = [];
  let added = 0;
  let updated = 0;

  for (const importedRecord of input.importedRecords) {
    const existing = existingByNaturalKey.get(naturalKey(importedRecord));
    if (existing) {
      importedIdMap.set(importedRecord.id, existing.id);
      writeIds.add(existing.id);
      modificationDeleteIds.add(existing.id);
      importedFinalRecords.push(importedRecord);
      updated += 1;
    } else {
      importedIdMap.set(importedRecord.id, importedRecord.id);
      writeIds.add(importedRecord.id);
      modificationDeleteIds.add(importedRecord.id);
      importedFinalRecords.push(importedRecord);
      added += 1;
    }
  }

  const rewrittenImportedRecords = rewriteImportedRecordIds(importedFinalRecords, importedIdMap).map((record) => ({
    ...record,
    status: 'active' as const,
    action: null,
  }));
  const importedById = new Map(rewrittenImportedRecords.map((record) => [record.id, record]));
  const importedNaturalKeys = new Set(rewrittenImportedRecords.map((record) => naturalKey(record)));
  const mergedById = new Map(input.existingRecords.map((record) => [record.id, record]));
  const newIds: string[] = [];
  let deleted = 0;

  for (const record of rewrittenImportedRecords) {
    if (!mergedById.has(record.id)) newIds.push(record.id);
    mergedById.set(record.id, record);
  }

  for (const existing of input.existingRecords) {
    if (importedById.has(existing.id)) continue;
    if (!isRecordInTotalScope(existing, totalScopes)) continue;
    if (importedNaturalKeys.has(naturalKey(existing))) continue;
    writeIds.add(existing.id);
    modificationDeleteIds.add(existing.id);
    if (existing.status !== 'deleted' || existing.action !== 'deleted') deleted += 1;
    mergedById.set(existing.id, {
      ...existing,
      status: 'deleted',
      action: 'deleted',
    });
  }

  const unsafeLinkIds = findUnsafeTurnaroundLinkIds(Array.from(mergedById.values()));
  for (const id of unsafeLinkIds) {
    const current = mergedById.get(id);
    if (!current) continue;
    mergedById.set(id, clearTurnaroundLink(current));
    writeIds.add(id);
  }

  const affectedRecordIds = uniqueSorted(writeIds);
  const modificationDeleteRecordIds = uniqueSorted(modificationDeleteIds);
  const remainingModifications = new Map(input.existingModifications);
  for (const id of modificationDeleteRecordIds) remainingModifications.delete(id);

  const mergedRecords = [
    ...input.existingRecords.map((record) => mergedById.get(record.id) ?? record),
    ...newIds.map((id) => mergedById.get(id)).filter((record): record is FlightRecord => !!record),
  ];
  const recordsToWrite = affectedRecordIds
    .map((id) => mergedById.get(id))
    .filter((record): record is FlightRecord => !!record);

  return {
    mergedRecords,
    recordsToWrite,
    remainingModifications,
    affectedRecordIds,
    modificationDeleteRecordIds,
    stats: {
      imported: input.importedRecords.length,
      added,
      updated,
      deleted,
      unchanged: input.existingRecords.filter((record) => !writeIds.has(record.id)).length,
      affected: affectedRecordIds.length,
    },
  };
}
