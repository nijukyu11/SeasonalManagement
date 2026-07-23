import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as XLSX from 'xlsx';

const { parseSeasonalSchedule } = await import('../src/lib/parser.ts');
const {
  parseSeasonalImportV3CancelResult,
  parseSeasonalImportV3StageResult,
  prepareSeasonalImportV3Attempt,
} = await import('../src/lib/seasonalImportV3Contract.ts');

const REQUIRED_ENV = [
  'SEASONAL_SUPABASE_URL',
  'SEASONAL_SUPABASE_ANON_KEY',
  'SEASONAL_TEST_ACCESS_TOKEN',
];
const DEFAULT_TIMEOUT_MS = 120_000;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requireOption(name) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function rpcError(label, status, payload) {
  const detail = payload && typeof payload === 'object'
    ? [payload.code, payload.message, payload.details, payload.hint].filter(Boolean).join(' | ')
    : String(payload ?? '');
  return new Error(`${label} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
}

async function fetchJson(url, init, label, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out.`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${label} returned non-JSON data.`);
      }
    }
    if (!response.ok) throw rpcError(label, response.status, payload);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]?.trim()) throw new Error(`${key} is required.`);
  }

  const filePath = path.resolve(requireOption('--file'));
  const requestedSeasonCode = requireOption('--season').toUpperCase();
  const strategy = (option('--strategy') ?? 'merge').toLowerCase();
  if (strategy !== 'merge' && strategy !== 'replace') {
    throw new Error('--strategy must be merge or replace.');
  }
  const timeoutMs = positiveInteger(
    option('--timeout-ms') ?? String(DEFAULT_TIMEOUT_MS),
    '--timeout-ms',
  );
  const startedAt = Date.now();
  const baseUrl = process.env.SEASONAL_SUPABASE_URL.trim().replace(/\/$/, '');
  const headers = {
    apikey: process.env.SEASONAL_SUPABASE_ANON_KEY.trim(),
    Authorization: `Bearer ${process.env.SEASONAL_TEST_ACCESS_TOKEN.trim()}`,
    'Content-Type': 'application/json',
  };

  const [bytes, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const parsed = parseSeasonalSchedule(workbook);
  if (parsed.seasonCode !== requestedSeasonCode) {
    throw new Error(
      `Workbook season ${parsed.seasonCode} does not match requested season ${requestedSeasonCode}.`,
    );
  }
  if (parsed.issues.length > 0) {
    throw new Error(`Workbook has ${parsed.issues.length} local validation issue(s).`);
  }
  if (parsed.rows.length === 0) throw new Error('Workbook contains no valid source rows.');

  const params = new URLSearchParams({
    select: 'id,season_code,data_version',
    season_code: `eq.${requestedSeasonCode}`,
    limit: '2',
  });
  const seasons = await fetchJson(
    `${baseUrl}/rest/v1/seasons?${params}`,
    { method: 'GET', headers },
    'resolve shadow season',
    timeoutMs,
  );
  if (!Array.isArray(seasons) || seasons.length > 1) {
    throw new Error('Season lookup returned an invalid or ambiguous result.');
  }
  const existing = seasons[0] ?? null;
  const attempt = await prepareSeasonalImportV3Attempt({
    seasonId: existing?.id ?? null,
    seasonCode: requestedSeasonCode,
    expectedDataVersion: existing?.data_version ?? 0,
    strategy,
    fileName: path.basename(filePath),
    uploadedAt: Math.trunc(fileStats.mtimeMs),
    sourceRows: parsed.rows,
  });

  let stage = null;
  let cancel = null;
  try {
    const rawStage = await fetchJson(
      `${baseUrl}/rest/v1/rpc/stage_seasonal_import_v3`,
      { method: 'POST', headers, body: JSON.stringify({ p_import: attempt }) },
      'stage Seasonal import V3 shadow',
      timeoutMs,
    );
    stage = parseSeasonalImportV3StageResult(rawStage);
  } finally {
    if (stage) {
      const rawCancel = await fetchJson(
        `${baseUrl}/rest/v1/rpc/cancel_seasonal_import_v3`,
        { method: 'POST', headers, body: JSON.stringify({ p_batch_id: stage.batchId }) },
        'cancel Seasonal import V3 shadow',
        timeoutMs,
      );
      cancel = parseSeasonalImportV3CancelResult(rawCancel);
    }
  }

  const summary = {
    status: stage.valid ? 'validated' : 'diagnostics',
    requestId: stage.requestId,
    batchId: stage.batchId,
    seasonId: stage.seasonId,
    seasonCode: stage.seasonCode,
    strategy: stage.strategy,
    dataVersion: stage.expectedDataVersion,
    counts: stage.counts,
    diagnosticCount: stage.diagnosticCount,
    diagnosticsTruncated: stage.diagnosticsTruncated,
    diagnostics: stage.diagnostics,
    previewHash: stage.previewHash,
    durationMs: Date.now() - startedAt,
    commitCalled: false,
    cancelStatus: cancel?.status ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));

  const strategyDrift = stage.strategy !== strategy;
  const identityDrift = stage.requestId !== attempt.requestId
    || stage.seasonCode !== requestedSeasonCode;
  const countDrift = stage.counts.sourceRowCount !== attempt.sourceRows.length
    || stage.counts.generatedOccurrenceCount < 1;
  if (
    !stage.valid
    || stage.diagnosticCount > 0
    || strategyDrift
    || identityDrift
    || countDrift
    || cancel?.status !== 'cancelled'
  ) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: 'failed', error: message }, null, 2));
  process.exitCode = 1;
}
