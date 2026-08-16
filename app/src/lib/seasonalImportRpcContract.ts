import type { ParsedRow } from './types';

export interface SeasonalImportV2Result {
  batchId: string;
  seasonId: string;
  seasonCode: string;
  status: 'committed';
  sourceRowCount: number;
  flightRecordCount: number;
  preservedOperationalCount: number;
  removedImportedCount: number;
  dataVersion: number;
  serverHighWater: number;
  checksum: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Import V2 result must be an object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Import V2 result requires ${field}.`);
  return value;
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Import V2 result requires a non-negative ${field}.`);
  return Number(value);
}

export function parseSeasonalImportV2Result(value: unknown): SeasonalImportV2Result {
  const result = object(value);
  const status = string(result.status, 'status');
  if (status !== 'committed') throw new Error(`Import V2 result status must be committed, received ${status}.`);
  return {
    batchId: string(result.batchId, 'batchId'),
    seasonId: string(result.seasonId, 'seasonId'),
    seasonCode: string(result.seasonCode, 'seasonCode'),
    status,
    sourceRowCount: count(result.sourceRowCount, 'sourceRowCount'),
    flightRecordCount: count(result.flightRecordCount, 'flightRecordCount'),
    preservedOperationalCount: count(result.preservedOperationalCount, 'preservedOperationalCount'),
    removedImportedCount: count(result.removedImportedCount, 'removedImportedCount'),
    dataVersion: count(result.dataVersion, 'dataVersion'),
    serverHighWater: count(result.serverHighWater, 'serverHighWater'),
    checksum: string(result.checksum, 'checksum'),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildSeasonalImportChecksum(seasonCode: string, sourceRows: ParsedRow[]): Promise<string> {
  return sha256(JSON.stringify(stableValue({ seasonCode, sourceRows })));
}

export async function buildSeasonalImportRequestId(input: {
  seasonId?: string | null;
  expectedDataVersion: number | null;
  checksum: string;
}): Promise<string> {
  const hash = await sha256(`${input.seasonId ?? 'new'}|${input.expectedDataVersion ?? 'new'}|${input.checksum}`);
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
