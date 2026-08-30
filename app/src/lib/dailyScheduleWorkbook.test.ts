import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { analyzeDailyScheduleWorkbook } from './dailyScheduleWorkbook.ts';

function row(length: number, values: Array<[number, unknown]>): unknown[] {
  const output = Array.from({ length }, () => null as unknown);
  for (const [index, value] of values) output[index] = value;
  return output;
}

const legacyHeader = row(43, [
  [1, 'AIRCRAFT_SERIES'], [3, 'ARR-AIRLINE_FLIGHT_SUFFIX'], [6, 'ARR-Scheduled'],
  [8, 'ARR-ORIG_DEST_AIRPORT_CODE'], [20, 'ARRStand'], [23, 'DEP-AIRLINE_FLIGHT_SUFFIX'],
  [26, 'DEP-Scheduled'], [28, 'DEP-ORIG_DEST_AIRPORT_CODE'], [37, 'DEPGate'],
  [38, 'CheckInDesk'], [40, 'DEPStand'],
]);

const compactHeader = row(44, [
  [2, 'A/C Type'], [4, 'Arr Flight'], [7, 'STA'], [9, 'From'], [21, 'Arr Stand'],
  [24, 'Dep Flight'], [27, 'STD'], [29, 'To'], [38, 'Gate'], [39, 'Counters'], [41, 'Dep Stand'],
]);

test('detects legacy A1 and compact B2 layouts by relative field positions', () => {
  const workbook = XLSX.utils.book_new();
  const compactSheet = XLSX.utils.aoa_to_sheet([
    row(44, []),
    compactHeader,
    row(44, [[2, '32N'], [4, 'RF531'], [7, 46113.99652777778], [9, 'CJJ'], [21, 'Stand20A'], [24, 'RF532'], [27, 46114.03819444445], [29, 'CJJ'], [38, 'G1'], [39, 'C30 M1']]),
  ]);
  XLSX.utils.book_append_sheet(workbook, compactSheet, 'Daily');

  const compact = analyzeDailyScheduleWorkbook(workbook);
  assert.equal(compact.selected?.firstLogicalColumnIndex, 1);
  assert.equal(compact.selected?.headerRowIndex, 1);
  assert.equal(compact.selected?.profile, 'compact-lb');
  assert.equal(compact.selected?.rows[0]['ARR-AIRLINE_FLIGHT_SUFFIX'], 'RF531');
  assert.match(String(compact.selected?.rows[0]['ARR-Scheduled']), /^2026-/);

  const legacyWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(legacyWorkbook, XLSX.utils.aoa_to_sheet([
    legacyHeader,
    row(43, [[1, '321'], [3, 'VN100'], [6, '2026-08-23 06:00:00'], [8, 'HAN'], [23, 'VN101'], [26, '2026-08-23 08:00:00'], [28, 'SGN']]),
  ]), 'OperationalTurns');
  const legacy = analyzeDailyScheduleWorkbook(legacyWorkbook);
  assert.equal(legacy.selected?.firstLogicalColumnIndex, 0);
  assert.equal(legacy.selected?.profile, 'legacy-operationalturns');
});

test('ignores a junk first sheet but blocks when more than one valid schedule sheet exists', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['notes']]), 'Notes');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([legacyHeader, row(43, [[3, 'VN100'], [6, '2026-08-23 06:00:00'], [8, 'HAN'], [23, 'VN101'], [26, '2026-08-23 08:00:00'], [28, 'SGN']])]), 'Daily');
  assert.equal(analyzeDailyScheduleWorkbook(workbook).selected?.sheetName, 'Daily');

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([legacyHeader]), 'Daily Copy');
  const ambiguous = analyzeDailyScheduleWorkbook(workbook);
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.diagnostics[0]?.code, 'DAILY_WORKBOOK_MULTIPLE_SHEETS');
});

test('rejects a header whose identity anchors were swapped', () => {
  const swapped = [...legacyHeader];
  [swapped[3], swapped[6]] = [swapped[6], swapped[3]];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([swapped]), 'Daily');
  const analysis = analyzeDailyScheduleWorkbook(workbook);
  assert.equal(analysis.selected, null);
  assert.equal(analysis.diagnostics[0]?.code, 'DAILY_WORKBOOK_LAYOUT_NOT_FOUND');
});
