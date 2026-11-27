/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

// Compile local TS modules in memory; no workbook or database writes.
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const nativeRequire = Module.createRequire(file);
  const localRequire = (name) => {
    if (!name.startsWith('.')) return nativeRequire(name);
    const resolved = path.resolve(path.dirname(file), name);
    return load(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
  };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', output)(localRequire, mod, mod.exports);
  return mod.exports;
}
const { buildDailyImportStagePayloadV1 } = load(path.join(__dirname, 'dailyImportV1Contract.ts'));
const { confirmDailyImportZeroFlightDatesV1 } = load(path.join(__dirname, 'dailyImportScope.ts'));
const { parseDailyImportRowsStrict } = load(path.join(__dirname, 'dailyScheduleImport.ts'));
const { cleanFlightNumber } = load(path.join(__dirname, 'parser.ts'));
const XLSX = require('xlsx');
const { analyzeDailyScheduleWorkbook } = load(path.join(__dirname, 'dailyScheduleWorkbook.ts'));
const { parseDailyScheduleWorkbookToV2Payload } = load(path.join(__dirname, 'dailyImportV2Parser.ts'));
function row(date, status = 'Departed', flight = 'VN101') {
  return { 'DEP-AIRLINE_FLIGHT_SUFFIX': flight, 'DEP-Scheduled': `${date} 08:00`, 'DEP-ORIG_DEST_AIRPORT_CODE': 'HAN', 'DEP-STATUS_CODE': status };
}
function build(rows, profile = 'compact-lb') {
  return buildDailyImportStagePayloadV1({ fileName: 'untrusted-range.xlsx', rawBuffer: new ArrayBuffer(0),
    seasons: [{ id: 's26', seasonCode: 'S26', dataVersion: 1 }],
    sheet: { sheetName: 'Data', profile, rows, headerRowIndex: 0, firstLogicalColumnIndex: 0, score: 11 } });
}
for (const [profile, cancelled] of [['compact-lb', 'Cancelled'], ['legacy-operationalturns', 'CX']]) {
  test(`${profile}: cancellation at both boundaries remains explicit coverage`, async () => {
    const result = await build([row('2026-09-02', cancelled), row('2026-09-03'), row('2026-09-04', cancelled)], profile);
    assert.equal(result.legs.length, 1);
    assert.equal(result.seasons[0].rangeStart, '2026-09-02');
    assert.equal(result.seasons[0].rangeEnd, '2026-09-04');
    assert.ok(result.diagnostics.some(d => d.code === 'DAILY_COVERAGE_GAP'));
    await assert.rejects(confirmDailyImportZeroFlightDatesV1(result, { s26: ['2026-09-04'] }), /thiếu xác nhận/);
    const confirmed = await confirmDailyImportZeroFlightDatesV1(result, { s26: ['2026-09-02', '2026-09-04'] });
    assert.deepEqual(confirmed.seasons[0].affectedDates, ['2026-09-02', '2026-09-03', '2026-09-04']);
    assert.equal(confirmed.diagnostics.length, 0);
  });
  test(`${profile}: all-cancelled file can confirm an empty replacement`, async () => {
    const result = await build([row('2026-09-02', cancelled)], profile);
    assert.equal(result.seasons.length, 1);
    assert.equal(result.legs.length, 0);
    const confirmed = await confirmDailyImportZeroFlightDatesV1(result, { s26: ['2026-09-02'] });
    assert.deepEqual(confirmed.seasons[0].affectedDates, ['2026-09-02']);
    assert.equal(confirmed.diagnostics.length, 0);
  });
}
test('cancelled coverage uses the same 05:00 Ops Date rule', async () => {
  const result = await build([{ ...row('2026-09-03', 'Cancelled'), 'DEP-Scheduled': '2026-09-03 03:00' }]);
  assert.equal(result.seasons[0].rangeStart, '2026-09-02');
});
test('unparseable cancelled date blocks rather than silently narrowing coverage', async () => {
  const result = await build([{ ...row('2026-09-02', 'Cancelled'), 'DEP-Scheduled': 'invalid' }, row('2026-09-03')]);
  assert.ok(result.diagnostics.some(d => d.severity === 'blocking'));
});
test('Daily and Seasonal use identical suffix normalization', () => {
  assert.equal(cleanFlightNumber('VN', 'VN1A').flightNumber, 'VN001A');
  for (const flight of ['VN1A', 'VN001A', 'VN1', 'VJ1234', '7C1A']) {
    const leg = parseDailyImportRowsStrict([row('2026-09-02', 'Departed', flight)]).legs[0];
    assert.equal(leg.flightNumber, cleanFlightNumber(leg.airline, flight).flightNumber);
  }
});
test('same calendar-day flight number is rejected even with a different time or route', () => {
  const result = parseDailyImportRowsStrict([row('2026-09-02'), { ...row('2026-09-02'), 'DEP-Scheduled': '2026-09-02 12:00', 'DEP-ORIG_DEST_AIRPORT_CODE': 'SGN' }]);
  assert.ok(result.diagnostics.some(d => d.code === 'DAILY_DUPLICATE_FLIGHT_NUMBER'));
});

test('confirmation rejects invalid or out-of-preview dates', async () => {
  const result = await build([row('2026-09-02', 'Cancelled')]);
  await assert.rejects(confirmDailyImportZeroFlightDatesV1(result, { s26: ['2026-02-30'] }), /YYYY-MM-DD/);
  await assert.rejects(confirmDailyImportZeroFlightDatesV1(result, { s26: ['2026-09-01'] }), /ngoài phạm vi/);
});

test('flight-day duplicate policy crosses the Ops Date cutoff, not calendar dates', () => {
  const early = { ...row('2026-09-02'), 'DEP-Scheduled': '2026-09-02 03:00' };
  assert.ok(parseDailyImportRowsStrict([early, row('2026-09-02')]).diagnostics.some(d => d.code === 'DAILY_DUPLICATE_FLIGHT_NUMBER'));
  assert.equal(parseDailyImportRowsStrict([row('2026-09-02'), row('2026-09-03')]).diagnostics.length, 0);
});

test('Summary preserves explicit Ops Date and both sides through V1 and V2 payloads', async () => {
  const headers = ['Type', 'Flight', 'Config', 'STA/STD', 'Routes', 'TTL Pax', 'Load Factor', 'Airlines',
    'Ops Date', 'Country', 'A/C Type', 'Stand', 'Carousel', 'Gate', 'Counters', 'MCT', 'FB', 'LB', 'GHS'];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers,
    ['A', 'ZE593A', null, '2026-03-29 06:00', 'ICN', 180, null, 'ZE', '2026-03-28', 'Korea', '738', '20A', 2, null, null, '06:05', '06:10', '06:20'],
    ['D', 'VN101', null, '2026-03-29 03:00', 'HAN', 0, null, 'VN', '2026-03-29', null, '321', '18', null, 4, '17,18,19', '03:05'],
  ]), 'Summary');
  const sheet = analyzeDailyScheduleWorkbook(workbook).selected;
  assert.equal(sheet.profile, 'summary-19');
  const v1 = await buildDailyImportStagePayloadV1({ fileName: 'summary.xlsx', rawBuffer: new ArrayBuffer(0), sheet,
    seasons: [{ id: 'w25', seasonCode: 'W25', dataVersion: 1 }, { id: 's26', seasonCode: 'S26', dataVersion: 1 }] });
  assert.deepEqual(v1.diagnostics, []);
  assert.deepEqual(v1.legs.map(leg => [leg.operationalDate, leg.seasonCode, leg.resources.pax]),
    [['2026-03-28', 'W25', 180], ['2026-03-29', 'S26', 0]]);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const v2 = await parseDailyScheduleWorkbookToV2Payload(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'summary.xlsx');
  assert.deepEqual(v2.affectedDates, ['2026-03-28', '2026-03-29']);
  assert.deepEqual(v2.payload.legs.map(leg => [leg.operationalDate, leg.scheduledDate, leg.scheduledTime, leg.resources.pax]),
    [['2026-03-28', '2026-03-29', '06:00', 180], ['2026-03-29', '2026-03-29', '03:00', 0]]);
  assert.equal(v2.payload.legs[0].resources.stand, '20A');
  assert.equal(v2.payload.legs[0].resources.carousel, 2);
  assert.equal(v2.payload.legs[0].resources.fb, '06:10');
  assert.equal(v2.payload.legs[1].resources.gate, 4);
  assert.equal(v2.payload.legs[1].requestStatusCode, null);
  for (const [key, value] of [['ARR-OperationalDate', null], ['ARR-OperationalDate', '2026-02-30'],
    ['Summary-Type', 'X']]) {
    const result = parseDailyImportRowsStrict([{ ...sheet.rows[0], [key]: value }], { workbookProfile: sheet.profile });
    assert.ok(result.diagnostics.some(d => d.code === 'DAILY_INVALID_VALUE'), key);
    assert.deepEqual(result.coverage, []);
  }
});

test('Summary keeps the Flight prefix when the Airlines display code differs', () => {
  const result = parseDailyImportRowsStrict([{
    'Summary-Type': 'A', 'Summary-Airline': 'IC', 'ARR-AIRLINE_FLIGHT_SUFFIX': 'ICE1208',
    'ARR-Scheduled': '2026-05-05 14:15', 'ARR-OperationalDate': '2026-05-05',
    'ARR-ORIG_DEST_AIRPORT_CODE': 'NGO', 'ARR-PAX_TOTAL': 61,
  }], { workbookProfile: 'summary-19' });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.legs[0].flightNumber, 'ICE1208');
  assert.equal(result.legs[0].airline, 'ICE');
  assert.equal(result.legs[0].updates.pax, 61);
});
