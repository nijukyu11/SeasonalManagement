import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseSeasonalSchedule } from './parser.ts';
import { normalizeSeasonalDate, normalizeSeasonalDay, normalizeSeasonalTime } from './seasonalSourceRowValidation.ts';

function workbook(row: Record<string, unknown>, sheetName = 'S27'): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet([row]);
  return { SheetNames: [sheetName], Sheets: { [sheetName]: sheet } };
}

const validRow = {
  Effective: '01-Mar-27', Discontinue: '31-Mar-27', Airline: 'VN', Aircraft: '321',
  Mon: 1, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0,
  STA: '', ARRFlight: '', ARRRoute: '', STD: '10:30', DEPFlight: '123', DEPRoute: 'HAN',
};

test('normalizes strict dates, times, and boolean days', () => {
  assert.equal(normalizeSeasonalDate('01-MAR-27'), '2027-03-01');
  assert.equal(normalizeSeasonalDate('31-Apr-27'), null);
  assert.match(normalizeSeasonalDate(46417) ?? '', /^2027-\d{2}-\d{2}$/);
  assert.equal(normalizeSeasonalTime('9:05'), '09:05');
  assert.equal(normalizeSeasonalTime('24:00'), null);
  assert.deepEqual(normalizeSeasonalDay(true), { value: true, valid: true });
  assert.deepEqual(normalizeSeasonalDay('maybe'), { value: false, valid: false });
});

test('parser returns canonical rows for uppercase month names and Excel values', () => {
  const uppercase = parseSeasonalSchedule(workbook({ ...validRow, Effective: '01-MAR-27', Mon: true }));
  const serial = parseSeasonalSchedule(workbook({ ...validRow, Effective: 46417, Discontinue: 46447 }));
  assert.equal(uppercase.rows[0]?.effective, '2027-03-01');
  assert.equal(uppercase.rows[0]?.std, '10:30');
  assert.deepEqual(uppercase.issues, []);
  assert.match(serial.rows[0]?.effective ?? '', /^2027-\d{2}-\d{2}$/);
});

test('parser diagnoses invalid rows and excludes them from canonical output', () => {
  const noDays = parseSeasonalSchedule(workbook({
    ...validRow, Mon: false, Tue: false, Wed: false, Thu: false, Fri: false, Sat: false, Sun: false,
  }));
  assert.equal(noDays.rows.length, 0);
  assert.equal(noDays.issues.some((issue) => issue.code === 'no-operating-days'), true);

  const invalid = parseSeasonalSchedule(workbook({ ...validRow, Effective: '31-Apr-27' }));
  assert.equal(invalid.issues.some((issue) => issue.code === 'invalid-effective-date'), true);

  const reversed = parseSeasonalSchedule(workbook({ ...validRow, Effective: '31-Mar-27', Discontinue: '01-Mar-27' }));
  assert.equal(reversed.issues.some((issue) => issue.code === 'reversed-date-range'), true);
});

test('parser reports missing headers, invalid days, and incomplete sides', () => {
  const missing = parseSeasonalSchedule(workbook({ Effective: '01-Mar-27' }));
  assert.equal(missing.issues.some((issue) => issue.code === 'missing-header' && issue.column === 'Airline'), true);

  const invalid = parseSeasonalSchedule(workbook({ ...validRow, Mon: 'MONDAY', DEPRoute: '' }));
  assert.equal(invalid.issues.some((issue) => issue.code === 'invalid-day-value'), true);
  assert.equal(invalid.issues.some((issue) => issue.code === 'incomplete-flight-side'), true);
});
