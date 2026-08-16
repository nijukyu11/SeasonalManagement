import { closeSeasonalSelectionOverPairs, resolveSeasonalPairs } from './seasonalPairing.ts';
import type { FlightLeg } from './types';

export interface SeasonalExportSelection {
  seasonId: string;
  dataVersion: number;
  mode: 'ids' | 'all';
  recordIds: string[];
}

export interface SeasonalExportSnapshotEnvelope {
  seasonId: string;
  dataVersion: number;
  serverHighWater: number;
  totalCount: number;
  truncated: false;
  flightRecords: unknown[];
  flightRecordCounters: unknown[];
  flightRecordWindows: unknown[];
  modifications: unknown[];
  modificationCounters: unknown[];
  modificationWindows: unknown[];
  modificationAddedLegs: unknown[];
}

function finiteInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) throw new Error(`Seasonal export snapshot ${label} is invalid.`);
  return number;
}

function requiredArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(`Seasonal export snapshot is missing ${key}.`);
  return value;
}

export function parseSeasonalExportSnapshotEnvelope(
  value: unknown,
  expected: { seasonId: string; dataVersion: number },
): SeasonalExportSnapshotEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Seasonal export snapshot is malformed.');
  const source = value as Record<string, unknown>;
  const seasonId = String(source.seasonId ?? '');
  const dataVersion = finiteInteger(source.dataVersion, 'dataVersion');
  const serverHighWater = finiteInteger(source.serverHighWater, 'serverHighWater');
  const totalCount = finiteInteger(source.totalCount, 'totalCount');
  if (seasonId !== expected.seasonId) throw new Error('Seasonal export snapshot belongs to another season.');
  if (dataVersion !== expected.dataVersion) throw new Error('Seasonal export snapshot data version changed.');
  if (source.truncated !== false) throw new Error('Seasonal export snapshot is incomplete.');
  const flightRecords = requiredArray(source, 'flightRecords');
  if (flightRecords.length !== totalCount) throw new Error('Seasonal export snapshot record count is incomplete.');
  return {
    seasonId, dataVersion, serverHighWater, totalCount, truncated: false, flightRecords,
    flightRecordCounters: requiredArray(source, 'flightRecordCounters'),
    flightRecordWindows: requiredArray(source, 'flightRecordWindows'),
    modifications: requiredArray(source, 'modifications'),
    modificationCounters: requiredArray(source, 'modificationCounters'),
    modificationWindows: requiredArray(source, 'modificationWindows'),
    modificationAddedLegs: requiredArray(source, 'modificationAddedLegs'),
  };
}

export function selectSeasonalExportLegs(
  selection: SeasonalExportSelection,
  snapshot: { seasonId: string; dataVersion: number },
  effectiveLegs: FlightLeg[],
): FlightLeg[] {
  if (selection.seasonId !== snapshot.seasonId) throw new Error('The export selection belongs to another season.');
  if (selection.dataVersion !== snapshot.dataVersion) throw new Error('The export selection is stale because the schedule changed.');
  if (effectiveLegs.length === 0) throw new Error('The server snapshot contains no effective flights to export.');
  if (selection.mode === 'all') return effectiveLegs;
  if (selection.recordIds.length === 0) throw new Error('Select at least one flight before export.');
  const byId = new Map(effectiveLegs.map((leg) => [leg.id, leg]));
  const unknownIds = selection.recordIds.filter((id) => !byId.has(id));
  if (unknownIds.length > 0) throw new Error(`The export selection contains ${unknownIds.length} stale flight ID(s).`);
  const resolution = resolveSeasonalPairs(effectiveLegs);
  const selected = new Set(closeSeasonalSelectionOverPairs(selection.recordIds, resolution));
  const result = effectiveLegs.filter((leg) => selected.has(leg.id));
  if (result.length === 0) throw new Error('The validated export selection contains no effective flights.');
  return result;
}
