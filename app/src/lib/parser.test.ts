import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { cleanFlightNumber, parseSeasonalSchedule } from './parser.ts';

const REQUIRED_HEADERS = [
  'Effective',
  'Discontinue',
  'Airline',
  'Aircraft',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
  'STA',
  'ARRFlight',
  'ARRRoute',
  'STD',
  'DEPFlight',
  'DEPRoute',
] as const;

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Effective: '01-MAR-27',
    Discontinue: '31-MAR-27',
    Airline: 'vn',
    Aircraft: '32n',
    Mon: true,
    Tue: false,
    Wed: false,
    Thu: false,
    Fri: false,
    Sat: false,
    Sun: false,
    STA: '09:05',
    ARRFlight: '123',
    ARRRoute: 'dad',
    STD: '',
    DEPFlight: '',
    DEPRoute: '',
    ...overrides,
  };
}

function workbookFromRows(
  rows: Record<string, unknown>[],
  headers: readonly string[] = REQUIRED_HEADERS,
  options: { date1904?: boolean } = {},
): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...headers],
    ...rows.map((row) => headers.map((header) => row[header] ?? '')),
  ]);
  const workbook = XLSX.utils.book_new();
  if (options.date1904 !== undefined) {
    workbook.Workbook = { WBProps: { date1904: options.date1904 } };
  }
  XLSX.utils.book_append_sheet(workbook, sheet, 'S27');
  return workbook;
}

function issueCodes(workbook: XLSX.WorkBook): string[] {
  return parseSeasonalSchedule(workbook).issues.map((issue) => issue.code);
}

test('cleanFlightNumber does not double-prefix raw values that already include airline', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559'), {
    flightNumber: 'TG559',
    rawFlightNumber: '559',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber keeps suffixes after removing existing airline prefix', () => {
  assert.deepEqual(cleanFlightNumber('TG', 'TG559A'), {
    flightNumber: 'TG559A',
    rawFlightNumber: '559A',
    requestStatusCode: null,
  });
});

test('cleanFlightNumber still pads numeric values', () => {
  assert.deepEqual(cleanFlightNumber('TG', '59'), {
    flightNumber: 'TG059',
    rawFlightNumber: '059',
    requestStatusCode: null,
  });
});

test('parseSeasonalSchedule returns canonical dates, times, booleans, and uppercase fields', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({
      Effective: '01-MAR-27',
      Discontinue: 46448,
      STA: 0.5,
      ARRRoute: 'dad',
      STD: '07:05',
      DEPFlight: '456a',
      DEPRoute: 'sgn',
    }),
  ]));

  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    rowIndex: 1,
    effective: '2027-03-01',
    discontinue: '2027-03-02',
    airline: 'VN',
    aircraft: '32N',
    daysOfWeek: [true, false, false, false, false, false, false],
    sta: '12:00',
    arrFlight: '123',
    arrFlightType: null,
    arrRoute: 'DAD',
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
    std: '07:05',
    depFlight: '456A',
    depFlightType: null,
    depRoute: 'SGN',
    depFlightCategory: null,
    depCodeShares: null,
    depIntDomInd: null,
  });
});

test('parseSeasonalSchedule honors the workbook 1904 date system', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ Effective: 59, Discontinue: 60 }),
  ], REQUIRED_HEADERS, { date1904: true }));

  assert.deepEqual(result.issues, []);
  assert.equal(result.rows[0]?.effective, '1904-02-29');
  assert.equal(result.rows[0]?.discontinue, '1904-03-01');
});

test('parseSeasonalSchedule accepts a real Excel boolean TRUE for DOW', () => {
  const workbook = workbookFromRows([sourceRow()]);

  assert.equal(workbook.Sheets.S27.E2.t, 'b');

  const result = parseSeasonalSchedule(workbook);
  assert.equal(result.issues.length, 0);
  assert.equal(result.rows[0]?.daysOfWeek[0], true);
});

test('parseSeasonalSchedule reports no-operating-days when all seven DOW values are false', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ Mon: false }),
  ]));

  assert.deepEqual(issueCodes(workbookFromRows([sourceRow({ Mon: false })])), ['no-operating-days']);
  assert.equal(result.rows.length, 0);
  assert.equal(result.issues[0]?.rowIndex, 1);
});

test('parseSeasonalSchedule reports invalid and reversed dates', () => {
  const invalid = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ Effective: '31-Apr-27' }),
  ]));
  assert.equal(invalid.rows.length, 0);
  assert.ok(invalid.issues.some((issue) => (
    issue.code === 'invalid-effective-date' && issue.column === 'Effective'
  )));

  const reversed = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ Effective: '02-MAR-27', Discontinue: '01-MAR-27' }),
  ]));
  assert.equal(reversed.rows.length, 0);
  assert.ok(reversed.issues.some((issue) => issue.code === 'reversed-date-range'));
});

test('parseSeasonalSchedule reports every missing required header before mapping rows', () => {
  const headers = REQUIRED_HEADERS.filter((header) => (
    header !== 'Aircraft' && header !== 'DEPRoute'
  ));
  const result = parseSeasonalSchedule(workbookFromRows([sourceRow()], headers));

  assert.equal(result.rows.length, 0);
  assert.deepEqual(
    result.issues.map(({ code, rowIndex, column }) => ({ code, rowIndex, column })),
    [
      { code: 'missing-header', rowIndex: null, column: 'Aircraft' },
      { code: 'missing-header', rowIndex: null, column: 'DEPRoute' },
    ],
  );
});

test('parseSeasonalSchedule reports invalid times and invalid DOW values', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ STA: '24:00', Mon: 'YES' }),
    sourceRow({ STA: '', ARRFlight: '', ARRRoute: '', STD: '12:60', DEPFlight: '456', DEPRoute: 'sgn' }),
  ]));

  assert.equal(result.rows.length, 0);
  assert.ok(result.issues.some((issue) => issue.code === 'invalid-time' && issue.column === 'STA'));
  assert.ok(result.issues.some((issue) => issue.code === 'invalid-time' && issue.column === 'STD'));
  assert.ok(result.issues.some((issue) => issue.code === 'invalid-day-value' && issue.column === 'Mon'));
});

test('parseSeasonalSchedule does not report structural side issues for present invalid times', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ STA: '24:00' }),
    sourceRow({
      STA: '',
      ARRFlight: '',
      ARRRoute: '',
      STD: '12:60',
      DEPFlight: '456',
      DEPRoute: 'sgn',
    }),
  ]));

  assert.equal(result.rows.length, 0);
  assert.deepEqual(
    result.issues.map(({ code, rowIndex, column }) => ({ code, rowIndex, column })),
    [
      { code: 'invalid-time', rowIndex: 1, column: 'STA' },
      { code: 'invalid-time', rowIndex: 2, column: 'STD' },
    ],
  );
});

test('parseSeasonalSchedule reports missing airline and aircraft on non-empty rows', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ Airline: '' }),
    sourceRow({ Aircraft: '' }),
  ]));

  assert.equal(result.rows.length, 0);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'missing-airline' && issue.rowIndex === 1 && issue.column === 'Airline'
  )));
  assert.ok(result.issues.some((issue) => (
    issue.code === 'missing-aircraft' && issue.rowIndex === 2 && issue.column === 'Aircraft'
  )));
});

test('parseSeasonalSchedule reports incomplete ARR and DEP sides', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ ARRRoute: '', STD: '10:15', DEPFlight: '456', DEPRoute: 'sgn' }),
    sourceRow({ STD: '10:15', DEPFlight: '456', DEPRoute: '' }),
  ]));

  assert.equal(result.rows.length, 0);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'incomplete-flight-side' && issue.rowIndex === 1 && issue.column === 'ARR'
  )));
  assert.ok(result.issues.some((issue) => (
    issue.code === 'incomplete-flight-side' && issue.rowIndex === 2 && issue.column === 'DEP'
  )));
});

test('parseSeasonalSchedule reports a row with no complete flight side', () => {
  const result = parseSeasonalSchedule(workbookFromRows([
    sourceRow({ STA: '', ARRFlight: '', ARRRoute: '' }),
  ]));

  assert.equal(result.rows.length, 0);
  assert.ok(result.issues.some((issue) => issue.code === 'no-flight-side'));
});
