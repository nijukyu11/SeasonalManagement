import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { expandToFlightLegs, parseSeasonalSchedule } from '../src/lib/parser.ts';

const fixturePaths = (process.env.SEASONAL_ROUNDTRIP_FIXTURES ?? '')
  .split(';')
  .map((value) => value.trim())
  .filter(Boolean);
if (fixturePaths.length === 0) {
  console.error('SEASONAL_ROUNDTRIP_FIXTURES is required (semicolon-separated S26/W26 workbook paths).');
  process.exit(2);
}

const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function workbookRows(rows) {
  return rows.map((row) => ({
    Effective: row.effective,
    Discontinue: row.discontinue,
    Airline: row.airline,
    Aircraft: row.aircraft,
    ...Object.fromEntries(dayNames.map((day, index) => [day, Boolean(row.daysOfWeek[index])])),
    STA: row.sta ?? '',
    ARRFlight: row.arrFlight ?? '',
    ARRFlightType: row.arrFlightType ?? '',
    ARRRoute: row.arrRoute ?? '',
    ARRFlightCategory: row.arrFlightCategory ?? '',
    ARRCodeShares: row.arrCodeShares ?? '',
    ARRIntDomInd: row.arrIntDomInd ?? '',
    STD: row.std ?? '',
    DEPFlight: row.depFlight ?? '',
    DEPFlightType: row.depFlightType ?? '',
    DEPRoute: row.depRoute ?? '',
    DEPFlightCategory: row.depFlightCategory ?? '',
    DEPCodeShares: row.depCodeShares ?? '',
    DEPIntDomInd: row.depIntDomInd ?? '',
  }));
}

function signatures(rows) {
  const values = expandToFlightLegs(rows).map((leg) => [leg.type, leg.date, leg.airline, leg.flightNumber].join('|')).sort();
  assert.equal(new Set(values).size, values.length, 'duplicate occurrence signature');
  return values;
}

const results = [];
for (const fixturePath of fixturePaths) {
  const sourceBuffer = await readFile(fixturePath);
  const source = parseSeasonalSchedule(XLSX.read(sourceBuffer, { type: 'buffer', cellDates: false }));
  assert.deepEqual(source.issues, [], `${fixturePath} has parser issues`);
  assert.ok(source.rows.length > 0, `${fixturePath} produced no source rows`);
  const before = signatures(source.rows);

  const roundTripBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(roundTripBook, XLSX.utils.json_to_sheet(workbookRows(source.rows)), source.seasonCode || 'Season');
  const bytes = XLSX.write(roundTripBook, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(bytes.byteLength > 0, 'round-trip workbook is empty');
  const reparsed = parseSeasonalSchedule(XLSX.read(bytes, { type: 'buffer', cellDates: false }));
  assert.deepEqual(reparsed.issues, [], `${fixturePath} re-import has parser issues`);
  const after = signatures(reparsed.rows);
  assert.deepEqual(after, before, `${fixturePath} occurrence signatures changed after XLSX round-trip`);
  results.push({ fixturePath, seasonCode: source.seasonCode, sourceRows: source.rows.length, occurrences: before.length, workbookBytes: bytes.byteLength });
}

console.log(JSON.stringify(results, null, 2));
