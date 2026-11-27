import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDailyScheduleWorkbookToV2Payload,
} from './dailyImportV2Parser.ts';
import {
  uploadDailyImportInChunksV2,
  saveDailyUploadJournal,
  getDailyUploadJournalByFingerprint,
  getActiveDailyUploadJournal,
  clearDailyUploadJournal,
  resolveOperatorId,
  getDailyJournalStorageKey,
  DailyImportStorageError,
  isTransportError,
  type ChunkedUploadClient,
  type DailyImportUploadProgress,
  type DailyImportUploadJournalEntry,
} from './dailyImportChunkedUpload.ts';
import {
  parseDailyImportStageResultV2,
  parseDailyImportCommittedResultV2,
  type DailyImportStagePayloadV2,
} from './operationalScheduleContract.ts';
import { parseDailyImportRowsStrict } from './dailyScheduleImport.ts';
import * as XLSX from 'xlsx';

// Test fixture: clean benchmark generator with distinct ARR and DEP flight numbers
function generateDailyCleanBenchmarkRows(rowCount: number, days: number = 10): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < rowCount; i++) {
    const dayOffset = i % days;
    const dateStr = `2026-09-${String(dayOffset + 1).padStart(2, '0')}`;
    rows.push({
      __rowNum__: i + 1,
      AIRCRAFT_SERIES: '321',
      // DISTINCT flight numbers: ARR odd, DEP even
      'ARR-AIRLINE_FLIGHT_SUFFIX': `VN${1001 + i * 2}`,
      'ARR-Scheduled': `${dateStr} 08:00:00`,
      'ARR-FlightType': 'J',
      'ARR-ORIG_DEST_AIRPORT_CODE': 'SGN',
      'ARR-FlightCategory': 'D',
      'DEP-AIRLINE_FLIGHT_SUFFIX': `VN${1000 + i * 2}`,
      'DEP-Scheduled': `${dateStr} 09:30:00`,
      'DEP-FlightType': 'J',
      'DEP-ORIG_DEST_AIRPORT_CODE': 'HAN',
      'DEP-FlightCategory': 'D',
    });
  }
  return rows;
}

// Test fixture: clean 43-column array-of-arrays workbook buffer
function createCleanBenchmarkArrayBuffer(rowCount: number, days: number = 2): ArrayBuffer {
  const header: unknown[] = new Array(43).fill(null);
  header[1] = 'AIRCRAFT_SERIES';
  header[3] = 'ARR-AIRLINE_FLIGHT_SUFFIX';
  header[6] = 'ARR-Scheduled';
  header[7] = 'ARR-FlightType';
  header[8] = 'ARR-ORIG_DEST_AIRPORT_CODE';
  header[9] = 'ARR-FlightCategory';
  header[23] = 'DEP-AIRLINE_FLIGHT_SUFFIX';
  header[26] = 'DEP-Scheduled';
  header[27] = 'DEP-FlightType';
  header[28] = 'DEP-ORIG_DEST_AIRPORT_CODE';
  header[29] = 'DEP-FlightCategory';

  const rows: unknown[][] = [header];
  for (let i = 0; i < rowCount; i++) {
    const dayOffset = i % days;
    const dateStr = `2026-09-${String(dayOffset + 1).padStart(2, '0')}`;
    const row: unknown[] = new Array(43).fill(null);
    row[1] = '321';
    row[3] = `VN${1001 + i * 2}`;
    row[6] = `${dateStr} 08:00:00`;
    row[7] = 'J';
    row[8] = 'SGN';
    row[9] = 'D';
    row[23] = `VN${1000 + i * 2}`;
    row[26] = `${dateStr} 09:30:00`;
    row[27] = 'J';
    row[28] = 'HAN';
    row[29] = 'D';
    rows.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'OperationalTurns');
  const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  // Avoid node/browser buffer slice offset bug
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

test('generateDailyCleanBenchmarkRows generates distinct ARR and DEP flight numbers per row with zero diagnostics', () => {
  const rowCount = 50;
  const days = 10;
  const rows = generateDailyCleanBenchmarkRows(rowCount, days);

  assert.equal(rows.length, rowCount);

  for (const row of rows) {
    const arrFlight = String(row['ARR-AIRLINE_FLIGHT_SUFFIX']);
    const depFlight = String(row['DEP-AIRLINE_FLIGHT_SUFFIX']);
    assert.notEqual(arrFlight, depFlight, `Row ${row.__rowNum__} ARR and DEP must be distinct`);
    assert.match(arrFlight, /^VN\d+$/, 'Arrival flight number format');
    assert.match(depFlight, /^VN\d+$/, 'Departure flight number format');
  }

  const strict = parseDailyImportRowsStrict(rows as unknown as Parameters<typeof parseDailyImportRowsStrict>[0], { workbookProfile: 'legacy-operationalturns' });
  const blockingDiagnostics = strict.diagnostics.filter((d) => d.severity === 'blocking');
  assert.equal(blockingDiagnostics.length, 0, `Expected 0 blocking diagnostics, got: ${JSON.stringify(blockingDiagnostics)}`);

  assert.equal(strict.legs.length, rowCount * 2);
});

test('parseDailyScheduleWorkbookToV2Payload parses 43-column clean workbook without buffer offset issues', async () => {
  const buffer = createCleanBenchmarkArrayBuffer(10, 2);
  const result = await parseDailyScheduleWorkbookToV2Payload(buffer, 'benchmark_schedule.xlsx');

  assert.equal(result.payload.fileName, 'benchmark_schedule.xlsx');
  assert.equal(result.payload.contractVersion, 2);
  assert.equal(result.payload.legs.length, 20);
  assert.equal(result.payload.rawChecksum?.length, 64);
  assert.equal(result.payload.canonicalChecksum.length, 64);
  assert.equal(result.payload.affectedDates.length, 2);
  assert.equal(result.payload.diagnostics?.length, 0);

  // Check leg resource and route mapping preservation
  const firstLeg = result.payload.legs[0];
  assert.equal(firstLeg.airline, 'VN');
  assert.equal(firstLeg.aircraft, '321');
  assert.equal(firstLeg.category, 'D');
  assert.equal(firstLeg.flightType, 'J');
  assert.ok(firstLeg.resources !== null && typeof firstLeg.resources === 'object');
  assert.ok(firstLeg.rawResourceTokens !== null && typeof firstLeg.rawResourceTokens === 'object');
});

test('uploadDailyImportInChunksV2 orchestrates begin -> append -> finalize with progress events', async () => {
  const mockPayload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: 'test-req-001',
    fileName: 'season_chunk_test.xlsx',
    workbookProfile: 'legacy-operationalturns',
    rawChecksum: 'a'.repeat(64),
    canonicalChecksum: 'b'.repeat(64),
    resourcePolicyHash: 'c'.repeat(64),
    affectedDates: ['2026-09-01', '2026-09-02'],
    confirmedZeroFlightDates: [],
    legs: Array.from({ length: 125 }, (_, i) => ({
      scheduledDate: '2026-09-01',
      scheduledTime: '10:00',
      side: 'ARR' as const,
      airline: 'VN',
      flightNumber: `VN${1000 + i}`,
      aircraft: '321',
      route: 'SGN',
      operationalDate: '2026-09-01',
      pax: 150,
      seatCapacity: 180,
      sourceRowNumber: i + 1,
      rawResourceTokens: { gate: null, stand: null, carousel: null, counter: null },
    })),
    diagnostics: [],
  };

  const beginCalls: Array<Parameters<ChunkedUploadClient['beginDailyScheduleImportUploadV2']>[0]> = [];
  const appendCalls: Array<Parameters<ChunkedUploadClient['appendDailyScheduleImportUploadV2']>[0]> = [];
  const finalizeCalls: string[] = [];
  const progressSnapshots: DailyImportUploadProgress[] = [];

  const mockClient: ChunkedUploadClient = {
    beginDailyScheduleImportUploadV2: async (input: Parameters<ChunkedUploadClient['beginDailyScheduleImportUploadV2']>[0]) => {
      beginCalls.push(input);
      return {
        uploadId: 'upload-uuid-1',
        batchId: 'batch-uuid-1',
        requestId: input.importPayload.requestId,
        chunkCount: input.chunkCount,
        totalChunks: input.chunkCount,
        legCount: input.legCount,
        nextChunkIndex: 0,
        status: 'uploading' as const,
      };
    },
    appendDailyScheduleImportUploadV2: async (input: Parameters<ChunkedUploadClient['appendDailyScheduleImportUploadV2']>[0]) => {
      appendCalls.push(input);
      return {
        uploadId: input.uploadId,
        chunkIndex: input.chunkIndex,
        receivedChunks: input.chunkIndex + 1,
        totalChunks: 3,
        legCount: 125,
        nextChunkIndex: input.chunkIndex + 1,
        status: 'uploading' as const,
      };
    },
    finalizeDailyScheduleImportUploadV2: async (uploadId: string) => {
      finalizeCalls.push(uploadId);
      return {
        batchId: 'batch-uuid-1',
        requestId: 'test-req-001',
        status: 'validated' as const,
        previewHash: 'preview-hash-1',
        preview: {
          importGuardVersion: '2' as const,
          valid: true,
          affectedDates: ['2026-09-01', '2026-09-02'],
          confirmedZeroFlightDates: [],
          sourceFingerprint: 'mock-fp',
          inputHash: 'mock-input-hash',
          replacedBySource: {},
          legCount: 125,
          replacedCount: 10,
          rebaseCount: 5,
          replacedLegsTruncated: false,
          rebasedOverridesTruncated: false,
          replacedLegs: [],
          rebasedOverrides: [],
        },
        diagnostics: [],
        expiresAt: '2026-10-16T12:00:00Z',
        result: null,
      };
    },
  };

  const result = await uploadDailyImportInChunksV2(mockPayload, {
    operatorId: 'test-operator',
    client: mockClient,
    chunkSize: 50,
    onProgress: (p) => progressSnapshots.push({ ...p }),
  });

  assert.equal(result.batchId, 'batch-uuid-1');
  assert.equal(result.status, 'validated');
  assert.equal(beginCalls.length, 1);
  assert.equal(beginCalls[0].legCount, 125);
  assert.equal(beginCalls[0].chunkCount, 3);

  assert.equal(appendCalls.length, 3);
  assert.equal(appendCalls[0].chunkIndex, 0);
  assert.equal(appendCalls[0].legs.length, 50);
  assert.equal(appendCalls[1].chunkIndex, 1);
  assert.equal(appendCalls[1].legs.length, 50);
  assert.equal(appendCalls[2].chunkIndex, 2);
  assert.equal(appendCalls[2].legs.length, 25);

  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0], 'upload-uuid-1');

  assert.ok(progressSnapshots.length >= 4);
  assert.equal(progressSnapshots[progressSnapshots.length - 1].percent, 100);
});

test('uploadDailyImportInChunksV2 retries ONLY transport errors with backoff and fails immediately on non-transport errors', async () => {
  const mockPayload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: 'test-transport-retry',
    fileName: 'retry_test.xlsx',
    workbookProfile: 'legacy-operationalturns',
    rawChecksum: 'a'.repeat(64),
    canonicalChecksum: 'b'.repeat(64),
    resourcePolicyHash: 'c'.repeat(64),
    affectedDates: ['2026-09-01'],
    confirmedZeroFlightDates: [],
    legs: Array.from({ length: 30 }, (_, i) => ({
      scheduledDate: '2026-09-01',
      scheduledTime: '08:00',
      side: 'ARR' as const,
      airline: 'VN',
      flightNumber: `VN${100 + i}`,
      aircraft: '321',
      route: 'DAD',
      operationalDate: '2026-09-01',
      sourceRowNumber: i + 1,
      rawResourceTokens: { gate: null, stand: null, carousel: null, counter: null },
    })),
    diagnostics: [],
  };

  assert.equal(isTransportError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransportError(new Error('Connection reset by peer')), true);
  assert.equal(isTransportError(new Error('HTTP 409 Conflict: preview expired')), false);
  assert.equal(isTransportError(new Error('HTTP 400 Bad Request: invalid payload')), false);

  let appendAttempts = 0;
  const mockClient: ChunkedUploadClient = {
    beginDailyScheduleImportUploadV2: async (input: Parameters<ChunkedUploadClient['beginDailyScheduleImportUploadV2']>[0]) => ({
      uploadId: 'upload-retry-id',
      batchId: 'batch-retry-id',
      requestId: input.importPayload.requestId,
      chunkCount: input.chunkCount,
      totalChunks: input.chunkCount,
      legCount: 30,
      nextChunkIndex: 0,
      status: 'uploading' as const,
    }),
    appendDailyScheduleImportUploadV2: async (input: Parameters<ChunkedUploadClient['appendDailyScheduleImportUploadV2']>[0]) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        throw new TypeError('Failed to fetch (network offline)');
      }
      return {
        uploadId: input.uploadId,
        chunkIndex: 0,
        receivedChunks: 1,
        totalChunks: 1,
        legCount: 30,
        nextChunkIndex: 1,
        status: 'uploading' as const,
      };
    },
    finalizeDailyScheduleImportUploadV2: async () => ({
      batchId: 'batch-retry-ok',
      requestId: 'test-transport-retry',
      status: 'validated' as const,
      previewHash: 'retry-preview-hash',
      preview: {
        importGuardVersion: '2' as const,
        valid: true,
        affectedDates: ['2026-09-01'],
        confirmedZeroFlightDates: [],
        sourceFingerprint: 'retry-fp',
        inputHash: 'retry-input-hash',
        replacedBySource: {},
        legCount: 30,
        replacedCount: 0,
        rebaseCount: 0,
        replacedLegsTruncated: false,
        rebasedOverridesTruncated: false,
        replacedLegs: [],
        rebasedOverrides: [],
      },
      diagnostics: [],
      expiresAt: '2026-10-16T12:00:00Z',
      result: null,
    }),
  };

  const result = await uploadDailyImportInChunksV2(mockPayload, {
    operatorId: 'test-operator',
    client: mockClient,
    chunkSize: 50,
    maxRetriesPerChunk: 2,
  });

  assert.equal(result.batchId, 'batch-retry-ok');
  assert.equal(appendAttempts, 2, 'Retried once on transport error and succeeded');

  // Verify non-transport error fails immediately without retrying
  let nonTransportAttempts = 0;
  const failingClient: ChunkedUploadClient = {
    ...mockClient,
    appendDailyScheduleImportUploadV2: async () => {
      nonTransportAttempts++;
      throw new Error('HTTP 400 Bad Request');
    },
  };

  await assert.rejects(
    uploadDailyImportInChunksV2(mockPayload, { operatorId: 'test-operator', client: failingClient, chunkSize: 50, maxRetriesPerChunk: 3 }),
    /HTTP 400 Bad Request/,
  );
  assert.equal(nonTransportAttempts, 1, 'Non-transport error must not retry');
});

test('parseDailyImportStageResultV2 and parseDailyImportCommittedResultV2 normalize bounded preview fields', () => {
  const rawStageResult = {
    batch_id: 'b-123',
    request_id: 'r-123',
    status: 'validated',
    preview_hash: 'phash',
    preview: {
      import_guard_version: 2,
      valid: true,
      affected_dates: ['2026-09-01'],
      confirmed_zero_flight_dates: [],
      source_fingerprint: 'sfp',
      leg_count: 5000,
      replaced_count: 3500,
      rebase_count: 120,
      replaced_legs_truncated: true,
      rebased_overrides_truncated: false,
      replaced_legs: [
        { leg_id: 'leg-1', scheduled_date: '2026-09-01', scheduled_time: '08:00', side: 'ARR', flight_number: 'VN123', replaced_by_source: 'import' }
      ],
      rebased_overrides: [],
    },
    diagnostics: [],
  };

  const parsed = parseDailyImportStageResultV2(rawStageResult);
  assert.equal(parsed.batchId, 'b-123');
  assert.equal(parsed.preview.legCount, 5000);
  assert.equal(parsed.preview.replacedCount, 3500);
  assert.equal(parsed.preview.rebaseCount, 120);
  assert.equal(parsed.preview.replacedLegsTruncated, true);
  assert.equal(parsed.preview.rebasedOverridesTruncated, false);
  assert.equal(parsed.preview.replacedLegs?.length, 1);

  const rawCommitResult = {
    batch_id: 'b-123',
    request_id: 'r-123',
    status: 'committed',
    inserted_count: 5000,
    replaced_count: 3500,
    affected_dates: ['2026-09-01'],
    revision: 'rev-999',
  };

  const parsedCommit = parseDailyImportCommittedResultV2(rawCommitResult);
  assert.equal(parsedCommit.batchId, 'b-123');
  assert.equal(parsedCommit.insertedCount, 5000);
  assert.equal(parsedCommit.replacedCount, 3500);
  assert.equal(parsedCommit.status, 'committed');
});

function setupMockStorage() {
  const memory = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, v); },
    removeItem: (k: string) => { memory.delete(k); },
    clear: () => { memory.clear(); },
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    get length() { return memory.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
  return { memory, mockStorage };
}

async function dailyImportPayloadFingerprint(payload: DailyImportStagePayloadV2): Promise<string> {
  const fingerprintInput = { ...payload, requestId: undefined };
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(fingerprintInput)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
test.beforeEach(() => { setupMockStorage(); });
test.after(() => {
  if (originalStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('Operator-scoped journal stores and restores session by fingerprint and active pointer in durable localStorage', () => {
  const { mockStorage } = setupMockStorage();
  const operatorId = 'test-operator-007';
  const rawChecksum = 'hash-abc-123';

  const entry: DailyImportUploadJournalEntry = {
    operatorId,
    rawChecksum,
    requestId: 'req-uuid-456',
    uploadId: 'upload-uuid-789',
    batchId: 'batch-uuid-101',
    fileName: 'schedule.xlsx',
    totalChunks: 5,
    legCount: 250,
    nextChunkIndex: 2,
    status: 'uploading',
    savedAt: 12345678,
  };

  saveDailyUploadJournal(entry);

  const byFp = getDailyUploadJournalByFingerprint(operatorId, rawChecksum);
  assert.deepEqual(byFp, entry);

  const active = getActiveDailyUploadJournal(operatorId);
  assert.deepEqual(active, entry);

  // Simulating native startup / session reset clearing sessionStorage must NOT affect localStorage journal
  if (typeof globalThis.sessionStorage !== 'undefined') {
    globalThis.sessionStorage.clear();
  }
  assert.deepEqual(getActiveDailyUploadJournal(operatorId), entry);

  // Clear by fingerprint
  clearDailyUploadJournal(operatorId, rawChecksum);
  assert.equal(getDailyUploadJournalByFingerprint(operatorId, rawChecksum), null);
  assert.equal(getActiveDailyUploadJournal(operatorId), null);
});

test('daily import journal rejects anonymous recovery and operatorless operations', () => {
  setupMockStorage();
  assert.equal(resolveOperatorId(null), null);
  assert.equal(resolveOperatorId(''), null);
  assert.equal(getActiveDailyUploadJournal(''), null);
  assert.equal(getDailyUploadJournalByFingerprint('', 'some-fp'), null);

  const anonymousEntry: DailyImportUploadJournalEntry = {
    operatorId: '',
    rawChecksum: 'fp-1',
    requestId: 'req-1',
    totalChunks: 1,
    legCount: 1,
    nextChunkIndex: 0,
    status: 'uploading',
    savedAt: Date.now(),
  };
  assert.throws(() => saveDailyUploadJournal(anonymousEntry), DailyImportStorageError);
});

test('clearing daily upload journal never clears another operator journal', () => {
  setupMockStorage();
  const entryA: DailyImportUploadJournalEntry = {
    operatorId: 'operator-alice',
    rawChecksum: 'fp-alice',
    requestId: 'req-alice',
    totalChunks: 2,
    legCount: 50,
    nextChunkIndex: 1,
    status: 'uploading',
    savedAt: 1000,
  };
  const entryB: DailyImportUploadJournalEntry = {
    operatorId: 'operator-bob',
    rawChecksum: 'fp-bob',
    requestId: 'req-bob',
    totalChunks: 2,
    legCount: 50,
    nextChunkIndex: 1,
    status: 'uploading',
    savedAt: 2000,
  };
  saveDailyUploadJournal(entryA);
  saveDailyUploadJournal(entryB);

  assert.ok(getActiveDailyUploadJournal('operator-alice'));
  assert.ok(getActiveDailyUploadJournal('operator-bob'));

  // Clear Alice's journal
  clearDailyUploadJournal('operator-alice');
  assert.equal(getActiveDailyUploadJournal('operator-alice'), null);
  // Bob's journal remains completely untouched!
  assert.deepEqual(getActiveDailyUploadJournal('operator-bob'), entryB);
});

test('daily import journal throws DailyImportStorageError on quota exceeded without promising recoverability', () => {
  const failingStorage: Storage = {
    getItem: () => null,
    setItem: () => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const entry: DailyImportUploadJournalEntry = {
    operatorId: 'operator-quota',
    requestId: 'req-quota',
    totalChunks: 1,
    legCount: 1,
    nextChunkIndex: 0,
    status: 'uploading',
    savedAt: Date.now(),
  };
  assert.throws(
    () => saveDailyUploadJournal(entry, failingStorage),
    DailyImportStorageError
  );
});

test('committed daily import journal is retained across reloads until explicitly cleared after authoritative refresh', () => {
  setupMockStorage();
  const entry: DailyImportUploadJournalEntry = {
    operatorId: 'operator-commit-retention',
    requestId: 'req-commit-999',
    rawChecksum: 'committed-file-checksum',
    batchId: 'batch-999',
    totalChunks: 1,
    legCount: 10,
    nextChunkIndex: 1,
    status: 'committed',
    committedResult: {
      status: 'committed',
      batchId: 'batch-999',
      affectedDates: ['2026-09-01'],
      insertedCount: 10,
      replacedCount: 0,
      revision: 'rev-999',
    },
    savedAt: Date.now(),
  };
  saveDailyUploadJournal(entry);

  // Reload 1: journal is still committed with receipt
  const reload1 = getActiveDailyUploadJournal('operator-commit-retention');
  assert.ok(reload1);
  assert.equal(reload1.status, 'committed');
  assert.equal(reload1.committedResult?.batchId, 'batch-999');

  // Reload 2: journal still retained
  const reload2 = getActiveDailyUploadJournal('operator-commit-retention');
  assert.ok(reload2);
  assert.equal(reload2.status, 'committed');

  // Authoritative clear
  clearDailyUploadJournal('operator-commit-retention');
  assert.equal(getActiveDailyUploadJournal('operator-commit-retention'), null);
  assert.equal(getDailyUploadJournalByFingerprint(entry.operatorId, entry.rawChecksum!), null);
});

test('signed-out browser rejects explicit old owner in daily import', (t) => {
  const { mockStorage } = setupMockStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: mockStorage },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  // Browser is signed out; passing explicit operator cannot bypass
  assert.equal(resolveOperatorId('old-operator'), null);
  assert.equal(getActiveDailyUploadJournal('old-operator'), null);
  assert.equal(getDailyUploadJournalByFingerprint('old-operator', 'some-fp'), null);
  clearDailyUploadJournal('old-operator');
});

test('storage failure before first RPC prevents any beginUploadRpc calls (zero server calls)', async () => {
  let beginCalls = 0;
  const failingStorage: Storage = {
    getItem: () => null,
    setItem: () => {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: failingStorage,
    configurable: true,
    writable: true,
  });

  const payload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: 'storage-fail-req',
    rawChecksum: 'storage-fail-fp',
    canonicalChecksum: 'checksum',
    affectedDates: ['2026-09-01'],
    legs: [],
  };

  await assert.rejects(
    uploadDailyImportInChunksV2(payload, {
      operatorId: 'operator-quota-test',
      client: {
        beginDailyScheduleImportUploadV2: async () => {
          beginCalls++;
          return { uploadId: 'up-1', batchId: 'b-1', requestId: payload.requestId, chunkCount: 0, legCount: 0, nextChunkIndex: 0, status: 'validated' };
        },
        appendDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
        finalizeDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
      },
    }),
    DailyImportStorageError
  );

  // Storage refusal caused ZERO server calls!
  assert.equal(beginCalls, 0);
});

test('lost begin ACK or network drop retains recoverable request identity in journal', async () => {
  setupMockStorage();
  const operatorId = 'operator-lost-ack';
  const rawChecksum = 'lost-ack-fp';
  const requestId = 'req-identity-preserve-123';

  const payload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId,
    rawChecksum,
    canonicalChecksum: 'checksum',
    affectedDates: ['2026-09-01'],
    legs: [],
  };

  // Simulate network transport failure during beginUploadRpc
  await assert.rejects(
    uploadDailyImportInChunksV2(payload, {
      operatorId,
      client: {
        beginDailyScheduleImportUploadV2: async () => {
          throw new TypeError('Failed to fetch (network drop / lost ACK)');
        },
        appendDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
        finalizeDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
      },
    }),
    /Failed to fetch/
  );

  // Pre-RPC journal persisted the request BEFORE the server call, so request identity remains recoverable!
  const journal = getDailyUploadJournalByFingerprint(operatorId, rawChecksum);
  assert.ok(journal);
  assert.equal(journal.requestId, requestId);
  assert.equal(journal.status, 'uploading');
  assert.equal(journal.nextChunkIndex, 0);

  // Retrying with a new payload instance but same rawChecksum automatically recovers the stored requestId
  const retryPayload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: 'different-uuid-that-should-be-superseded-by-journal',
    rawChecksum,
    canonicalChecksum: 'checksum',
    affectedDates: ['2026-09-01'],
    legs: [],
  };

  let usedBeginRequestId: string | null = null;
  await uploadDailyImportInChunksV2(retryPayload, {
    operatorId,
    client: {
      beginDailyScheduleImportUploadV2: async (input) => {
        usedBeginRequestId = input.importPayload.requestId;
        return {
          uploadId: 'up-recovered',
          batchId: 'batch-recovered',
          requestId: input.importPayload.requestId,
          chunkCount: 0,
          legCount: 0,
          nextChunkIndex: 0,
          status: 'validated',
        };
      },
      appendDailyScheduleImportUploadV2: async () => ({
        uploadId: 'up-recovered',
        nextChunkIndex: 0,
        receivedChunks: 0,
        totalChunks: 0,
      }),
      finalizeDailyScheduleImportUploadV2: async () => ({
        batchId: 'batch-recovered',
        requestId,
        status: 'validated',
        previewHash: 'hash',
        preview: {
          importGuardVersion: '2',
          valid: true,
          affectedDates: retryPayload.affectedDates,
          confirmedZeroFlightDates: [],
          sourceFingerprint: 'recovered-source',
          legCount: 0,
          replacedBySource: {},
          inputHash: 'recovered-input',
          replacedLegsTruncated: false,
          rebasedOverridesTruncated: false,
          replacedLegs: [],
          rebasedOverrides: [],
        },
        diagnostics: [],
        expiresAt: '2026-10-16T12:00:00Z',
        result: null,
      }),
    },
  });
  // Verified: the retry used the original preserved requestId!
  assert.equal(usedBeginRequestId, requestId);
  assert.equal(getActiveDailyUploadJournal(operatorId)?.requestId, requestId);
});

test('same raw checksum with changed confirmation does not reuse the incompatible request ID', async () => {
  setupMockStorage();
  const operatorId = 'operator-confirmation-change';
  const rawChecksum = 'same-file-checksum';
  const basePayload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId: 'first-request',
    fileName: 'daily.xlsx',
    workbookProfile: 'legacy-operationalturns',
    rawChecksum,
    canonicalChecksum: 'same-canonical-checksum',
    resourcePolicyHash: 'same-policy',
    affectedDates: ['2026-09-01'],
    confirmedZeroFlightDates: [],
    legs: [],
    diagnostics: [],
  };

  await assert.rejects(uploadDailyImportInChunksV2(basePayload, {
    operatorId,
    client: {
      beginDailyScheduleImportUploadV2: async () => { throw new TypeError('Failed to fetch'); },
      appendDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
      finalizeDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
    },
  }), /Failed to fetch/);

  const changedPayload = {
    ...basePayload,
    requestId: 'confirmed-zero-request',
    confirmedZeroFlightDates: ['2026-09-01'],
  };
  let usedRequestId: string | null = null;
  await assert.rejects(uploadDailyImportInChunksV2(changedPayload, {
    operatorId,
    client: {
      beginDailyScheduleImportUploadV2: async (input) => {
        usedRequestId = input.importPayload.requestId;
        return {
          uploadId: 'cancelled-upload',
          batchId: 'cancelled-batch',
          requestId: input.importPayload.requestId,
          chunkCount: 0,
          legCount: 0,
          nextChunkIndex: 0,
          status: 'cancelled',
        };
      },
      appendDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
      finalizeDailyScheduleImportUploadV2: async () => { throw new Error('Not reached'); },
    },
  }), /Vui lòng chọn lại tệp/);

  assert.equal(usedRequestId, changedPayload.requestId);
  assert.notEqual(usedRequestId, basePayload.requestId);
});
test('uploadDailyImportInChunksV2 resumes chunked upload from nextChunkIndex when journal exists', async () => {
  const operatorId = 'test-operator-resume';
  const rawChecksum = 'resume-hash-999';
  const requestId = 'req-resume-123';

  // Setup prior journal entry at chunk 2 of 4
  saveDailyUploadJournal({
    operatorId,
    rawChecksum,
    requestId,
    uploadId: 'prior-upload-id',
    batchId: 'prior-batch-id',
    fileName: 'resume.xlsx',
    totalChunks: 4,
    legCount: 200,
    nextChunkIndex: 2,
    status: 'uploading',
    savedAt: Date.now(),
  });

  const legs = Array.from({ length: 200 }, (_, i) => ({
    operationalDate: '2026-09-01',
    scheduledDate: '2026-09-01',
    scheduledTime: '08:00',
    side: i % 2 === 0 ? 'ARR' as const : 'DEP' as const,
    airline: 'VN',
    flightNumber: `VN${100 + i}`,
    aircraft: '321',
    route: 'HAN',
    sourceRowNumber: i + 1,
    rawResourceTokens: { gate: null, stand: null, carousel: null, counter: null },
  }));

  const resumePayload: DailyImportStagePayloadV2 = {
    contractVersion: 2,
    requestId,
    fileName: 'resume.xlsx',
    workbookProfile: 'legacy-operationalturns',
    rawChecksum,
    canonicalChecksum: rawChecksum,
    resourcePolicyHash: 'policy-hash',
    affectedDates: ['2026-09-01'],
    confirmedZeroFlightDates: [],
    legs,
    diagnostics: [],
  };
  const priorJournal = getDailyUploadJournalByFingerprint(operatorId, rawChecksum);
  assert.ok(priorJournal);
  saveDailyUploadJournal({
    ...priorJournal,
    payloadFingerprint: await dailyImportPayloadFingerprint(resumePayload),
  });

  const appendedIndices: number[] = [];
  let beginCalled = false;
  let finalizedUploadId = '';

  const resumeClient: ChunkedUploadClient = {
    beginDailyScheduleImportUploadV2: async () => {
      beginCalled = true;
      return {
        uploadId: 'prior-upload-id',
        batchId: 'prior-batch-id',
        requestId,
        totalChunks: 4,
        legCount: 200,
        nextChunkIndex: 2, // Server confirms resumption from chunk 2
        chunkCount: 4,
        status: 'uploading' as const,
      };
    },
    appendDailyScheduleImportUploadV2: async (input) => {
      appendedIndices.push(input.chunkIndex);
      return {
        uploadId: input.uploadId,
        chunkIndex: input.chunkIndex,
        receivedChunks: input.chunkIndex + 1,
        totalChunks: 4,
        legCount: 200,
        nextChunkIndex: input.chunkIndex + 1,
        status: 'uploading' as const,
      };
    },
    finalizeDailyScheduleImportUploadV2: async (uploadId) => {
      finalizedUploadId = uploadId;
      return {
        batchId: 'prior-batch-id',
        requestId,
        status: 'validated' as const,
        previewHash: 'resumed-preview-hash',
        preview: {
          importGuardVersion: '2' as const,
          valid: true,
          affectedDates: ['2026-09-01'],
          confirmedZeroFlightDates: [],
          sourceFingerprint: 'fp-resumed',
          inputHash: 'hash-resumed',
          replacedBySource: {},
          legCount: 200,
          replacedCount: 0,
          rebaseCount: 0,
          replacedLegsTruncated: false,
          rebasedOverridesTruncated: false,
          replacedLegs: [],
          rebasedOverrides: [],
        },
        diagnostics: [],
        expiresAt: '2026-10-16T12:00:00Z',
        result: null,
      };
    },
  };

  const result = await uploadDailyImportInChunksV2(resumePayload, {
    client: resumeClient,
    chunkSize: 50,
    operatorId,
  });

  assert.equal(beginCalled, true);
  assert.deepEqual(appendedIndices, [2, 3], 'Should only upload missing chunks 2 and 3, skipping 0 and 1');
  assert.equal(finalizedUploadId, 'prior-upload-id');
  assert.equal(result.batchId, 'prior-batch-id');
  assert.equal(result.status, 'validated');

  // Journal entry is updated to staged
  const updatedEntry = getDailyUploadJournalByFingerprint(operatorId, rawChecksum);
  assert.equal(updatedEntry?.status, 'staged');
  assert.equal(updatedEntry?.previewHash, 'resumed-preview-hash');
});

test('terminal upload clears only its own journal so reselecting the file can start a new request', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); },
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const payload: DailyImportStagePayloadV2 = {
    contractVersion: 2, requestId: 'terminal-request', rawChecksum: 'terminal-file',
    canonicalChecksum: 'checksum', affectedDates: ['2026-09-01'], legs: [],
  };
  const entry: DailyImportUploadJournalEntry = {
    operatorId: 'terminal-operator', rawChecksum: payload.rawChecksum, requestId: payload.requestId,
    totalChunks: 0, legCount: 0, nextChunkIndex: 0, status: 'uploading', savedAt: 1,
  };
  saveDailyUploadJournal({ ...entry, operatorId: 'other-operator' });
  for (const status of ['expired', 'cancelled', 'failed']) {
    saveDailyUploadJournal(entry);
    await assert.rejects(uploadDailyImportInChunksV2(payload, {
      operatorId: entry.operatorId,
      client: {
        beginDailyScheduleImportUploadV2: async () => ({
          uploadId: 'terminal-upload', batchId: 'terminal-batch', requestId: payload.requestId,
          chunkCount: 0, legCount: 0, nextChunkIndex: 0, status,
        }),
        appendDailyScheduleImportUploadV2: async () => { throw new Error('Must not append terminal upload'); },
        finalizeDailyScheduleImportUploadV2: async () => { throw new Error('Must not finalize terminal upload'); },
      },
    }), /Vui lòng chọn lại tệp/);
    assert.equal(getDailyUploadJournalByFingerprint(entry.operatorId, payload.rawChecksum!), null);
    assert.equal(getActiveDailyUploadJournal(entry.operatorId), null);
    assert.equal(getActiveDailyUploadJournal('other-operator')?.requestId, payload.requestId);
  }
});
