import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSeasonalImportPatch } from './seasonalImportPatch.ts';
import type { FlightModification, FlightRecord, ParsedRow } from './types.ts';

function record(overrides: Partial<FlightRecord> & Pick<FlightRecord, 'id' | 'type' | 'airline' | 'flightNumber' | 'date' | 'schedule'>): FlightRecord {
  const operationalDate = overrides.operationalDate ?? overrides.date;
  return {
    linkId: overrides.id,
    rawFlightNumber: overrides.flightNumber,
    requestStatusCode: null,
    route: 'SGN',
    aircraft: '321',
    category: 'PAX',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: null,
    pax: null,
    gate: null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    scheduledDate: overrides.date,
    scheduledTime: overrides.schedule,
    operationalDate,
    iataSeasonCode: 'S26',
    flightSeriesId: `SER_${overrides.type}_${overrides.airline}_${overrides.flightNumber}`,
    dayOfWeek: new Date(`${overrides.date}T00:00:00Z`).getUTCDay(),
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'imported',
    sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
    status: 'active',
    ...overrides,
  };
}

function row(overrides: Partial<ParsedRow>): ParsedRow {
  return {
    rowIndex: 50,
    effective: '01-Jun-26',
    discontinue: '07-Jun-26',
    airline: 'VJ',
    aircraft: '320',
    daysOfWeek: [false, false, true, false, false, false, false],
    sta: null,
    arrFlight: null,
    arrFlightType: null,
    arrRoute: null,
    arrFlightCategory: null,
    arrCodeShares: null,
    arrIntDomInd: null,
    std: '11:00',
    depFlight: '100',
    depFlightType: 'PAX',
    depRoute: 'HAN',
    depFlightCategory: 'PAX',
    depCodeShares: null,
    depIntDomInd: null,
    ...overrides,
  };
}

test('seasonal patch preserves existing ids when route schedule aircraft and row index change', () => {
  const existing = record({
    id: 'old-vj100-jun03',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '10:00',
    route: 'SGN',
    aircraft: '321',
    sourceRowIndex: 7,
  });
  const imported = record({
    id: 'new-row50-vj100-jun03',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '11:00',
    route: 'HAN',
    aircraft: '320',
    sourceRowIndex: 50,
  });

  const result = buildSeasonalImportPatch({
    existingRecords: [existing],
    existingModifications: new Map([['old-vj100-jun03', { legId: 'old-vj100-jun03', action: 'modified', gate: 5 }]]),
    importedRows: [row({})],
    importedRecords: [imported],
  });

  assert.equal(result.mergedRecords.length, 1);
  assert.equal(result.mergedRecords[0].id, 'old-vj100-jun03');
  assert.equal(result.mergedRecords[0].schedule, '11:00');
  assert.equal(result.mergedRecords[0].route, 'HAN');
  assert.equal(result.mergedRecords[0].aircraft, '320');
  assert.equal(result.mergedRecords[0].status, 'active');
  assert.equal(result.mergedRecords[0].action, null);
  assert.deepEqual(result.affectedRecordIds, ['old-vj100-jun03']);
  assert.equal(result.remainingModifications.has('old-vj100-jun03'), false);
  assert.deepEqual(result.modificationDeleteRecordIds, ['old-vj100-jun03']);
});

test('seasonal patch marks omitted records in the imported identity window as baseline deleted', () => {
  const existingInFile = record({
    id: 'old-vj100-jun03',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '10:00',
  });
  const omittedInScope = record({
    id: 'old-vj100-jun06',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-06',
    schedule: '10:00',
  });
  const outsideScope = record({
    id: 'old-vj100-jun10',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-10',
    schedule: '10:00',
  });
  const otherFlight = record({
    id: 'old-vn200-jun03',
    type: 'D',
    airline: 'VN',
    flightNumber: 'VN200',
    date: '2026-06-03',
    schedule: '10:00',
  });
  const imported = record({
    id: 'new-vj100-jun03',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '11:00',
  });
  const mods = new Map<string, FlightModification>([
    ['old-vj100-jun03', { legId: 'old-vj100-jun03', action: 'modified', gate: 5 }],
    ['old-vj100-jun06', { legId: 'old-vj100-jun06', action: 'modified', gate: 6 }],
    ['old-vj100-jun10', { legId: 'old-vj100-jun10', action: 'modified', gate: 10 }],
    ['old-vn200-jun03', { legId: 'old-vn200-jun03', action: 'modified', gate: 20 }],
  ]);

  const result = buildSeasonalImportPatch({
    existingRecords: [existingInFile, omittedInScope, outsideScope, otherFlight],
    existingModifications: mods,
    importedRows: [row({})],
    importedRecords: [imported],
  });

  const byId = new Map(result.mergedRecords.map((item) => [item.id, item]));
  assert.equal(byId.get('old-vj100-jun03')?.status, 'active');
  assert.equal(byId.get('old-vj100-jun03')?.schedule, '11:00');
  assert.equal(byId.get('old-vj100-jun06')?.status, 'deleted');
  assert.equal(byId.get('old-vj100-jun06')?.action, 'deleted');
  assert.equal(byId.get('old-vj100-jun10')?.status, 'active');
  assert.equal(byId.get('old-vn200-jun03')?.status, 'active');
  assert.deepEqual(result.recordsToWrite.map((item) => item.id).sort(), ['old-vj100-jun03', 'old-vj100-jun06']);
  assert.deepEqual(Array.from(result.remainingModifications.keys()).sort(), ['old-vj100-jun10', 'old-vn200-jun03']);
  assert.deepEqual(result.modificationDeleteRecordIds, ['old-vj100-jun03', 'old-vj100-jun06']);
  assert.deepEqual(result.stats, {
    imported: 1,
    added: 0,
    updated: 1,
    deleted: 1,
    unchanged: 2,
    affected: 2,
  });
});

test('seasonal patch appends imported records with no natural-key match', () => {
  const imported = record({
    id: 'new-ak500-jun03',
    type: 'A',
    airline: 'AK',
    flightNumber: 'AK500',
    date: '2026-06-03',
    schedule: '08:00',
  });

  const result = buildSeasonalImportPatch({
    existingRecords: [],
    existingModifications: new Map(),
    importedRows: [row({
      airline: 'AK',
      sta: '08:00',
      arrFlight: '500',
      arrRoute: 'KUL',
      std: null,
      depFlight: null,
      depRoute: null,
    })],
    importedRecords: [imported],
  });

  assert.equal(result.mergedRecords.length, 1);
  assert.equal(result.mergedRecords[0].id, 'new-ak500-jun03');
  assert.equal(result.recordsToWrite.length, 1);
  assert.deepEqual(result.affectedRecordIds, ['new-ak500-jun03']);
  assert.equal(result.stats.added, 1);
});

test('seasonal patch scopes same-row overnight departures by their shifted scheduled dates', () => {
  const keptFirstDeparture = record({
    id: 'old-vj101-jun02',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ101',
    date: '2026-06-02',
    operationalDate: '2026-06-01',
    schedule: '02:00',
  });
  const omittedSecondDeparture = record({
    id: 'old-vj101-jun09',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ101',
    date: '2026-06-09',
    operationalDate: '2026-06-08',
    schedule: '02:00',
  });
  const beforeScopeDeparture = record({
    id: 'old-vj101-jun01',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ101',
    date: '2026-06-01',
    operationalDate: '2026-05-31',
    schedule: '02:00',
  });
  const imported = record({
    id: 'new-vj101-jun02',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ101',
    date: '2026-06-02',
    operationalDate: '2026-06-01',
    schedule: '02:00',
  });

  const result = buildSeasonalImportPatch({
    existingRecords: [keptFirstDeparture, omittedSecondDeparture, beforeScopeDeparture],
    existingModifications: new Map(),
    importedRows: [row({
      effective: '01-Jun-26',
      discontinue: '08-Jun-26',
      daysOfWeek: [true, false, false, false, false, false, false],
      sta: '23:00',
      arrFlight: '100',
      arrRoute: 'SGN',
      std: '02:00',
      depFlight: '101',
      depRoute: 'HAN',
    })],
    importedRecords: [imported],
  });

  const byId = new Map(result.mergedRecords.map((item) => [item.id, item]));
  assert.equal(byId.get('old-vj101-jun02')?.status, 'active');
  assert.equal(byId.get('old-vj101-jun09')?.status, 'deleted');
  assert.equal(byId.get('old-vj101-jun01')?.status, 'active');
});

test('seasonal patch unlinks preserved outside-scope counterparts without deleting their modifications', () => {
  const arrival = record({
    id: 'old-vj100-arr-jun03',
    type: 'A',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '10:00',
    linkId: 'TRN-old',
    turnaroundId: 'TRN-old',
    linkedRecordId: 'old-vj101-dep-jun03',
    linkType: 'sameday',
    pairAnchorDate: '2026-06-03',
  });
  const outsideDeparture = record({
    id: 'old-vj101-dep-jun03',
    type: 'D',
    airline: 'VJ',
    flightNumber: 'VJ101',
    date: '2026-06-03',
    schedule: '12:00',
    linkId: 'TRN-old',
    turnaroundId: 'TRN-old',
    linkedRecordId: 'old-vj100-arr-jun03',
    linkType: 'sameday',
    pairAnchorDate: '2026-06-03',
  });
  const importedArrival = record({
    id: 'new-vj100-arr-jun03',
    type: 'A',
    airline: 'VJ',
    flightNumber: 'VJ100',
    date: '2026-06-03',
    schedule: '10:30',
  });

  const result = buildSeasonalImportPatch({
    existingRecords: [arrival, outsideDeparture],
    existingModifications: new Map([
      ['old-vj100-arr-jun03', { legId: 'old-vj100-arr-jun03', action: 'modified', gate: 1 }],
      ['old-vj101-dep-jun03', { legId: 'old-vj101-dep-jun03', action: 'modified', gate: 2 }],
    ]),
    importedRows: [row({
      sta: '10:30',
      arrFlight: '100',
      arrRoute: 'SGN',
      std: null,
      depFlight: null,
      depRoute: null,
    })],
    importedRecords: [importedArrival],
  });

  const byId = new Map(result.mergedRecords.map((item) => [item.id, item]));
  assert.equal(byId.get('old-vj100-arr-jun03')?.linkedRecordId, undefined);
  assert.equal(byId.get('old-vj100-arr-jun03')?.turnaroundId, undefined);
  assert.equal(byId.get('old-vj100-arr-jun03')?.linkId, 'old-vj100-arr-jun03');
  assert.equal(byId.get('old-vj101-dep-jun03')?.linkedRecordId, undefined);
  assert.equal(byId.get('old-vj101-dep-jun03')?.turnaroundId, undefined);
  assert.equal(byId.get('old-vj101-dep-jun03')?.linkId, 'old-vj101-dep-jun03');
  assert.deepEqual(result.recordsToWrite.map((item) => item.id).sort(), ['old-vj100-arr-jun03', 'old-vj101-dep-jun03']);
  assert.deepEqual(result.modificationDeleteRecordIds, ['old-vj100-arr-jun03']);
  assert.deepEqual(Array.from(result.remainingModifications.keys()), ['old-vj101-dep-jun03']);
});

test('seasonal patch deletes records in gaps between imported periods for the same flight identity', () => {
  const activeInFirstPeriod = record({
    id: 'old-8m455-apr29',
    type: 'D',
    airline: '8M',
    flightNumber: '8M455',
    date: '2026-04-29',
    schedule: '20:00',
  });
  const gapAfterFirstPeriod = record({
    id: 'old-8m455-apr30',
    type: 'D',
    airline: '8M',
    flightNumber: '8M455',
    date: '2026-04-30',
    schedule: '20:00',
  });
  const gapAfterSecondPeriod = record({
    id: 'old-8m455-may09',
    type: 'D',
    airline: '8M',
    flightNumber: '8M455',
    date: '2026-05-09',
    schedule: '20:00',
  });
  const outsideTotalScope = record({
    id: 'old-8m455-oct24',
    type: 'D',
    airline: '8M',
    flightNumber: '8M455',
    date: '2026-10-24',
    schedule: '20:00',
  });
  const imported = record({
    id: 'new-8m455-apr29',
    type: 'D',
    airline: '8M',
    flightNumber: '8M455',
    date: '2026-04-29',
    schedule: '20:00',
  });
  const period = (effective: string, discontinue: string): ParsedRow => row({
    airline: '8M',
    effective,
    discontinue,
    aircraft: 'E90',
    daysOfWeek: [true, true, true, true, true, true, true],
    sta: null,
    arrFlight: null,
    arrRoute: null,
    std: '20:00',
    depFlight: '455',
    depRoute: 'RGN',
  });

  const result = buildSeasonalImportPatch({
    existingRecords: [activeInFirstPeriod, gapAfterFirstPeriod, gapAfterSecondPeriod, outsideTotalScope],
    existingModifications: new Map(),
    importedRows: [
      period('30-Mar-26', '29-Apr-26'),
      period('02-May-26', '08-May-26'),
      period('13-May-26', '01-Aug-26'),
      period('03-Aug-26', '23-Oct-26'),
    ],
    importedRecords: [imported],
  });

  const byId = new Map(result.mergedRecords.map((item) => [item.id, item]));
  assert.equal(byId.get('old-8m455-apr29')?.status, 'active');
  assert.equal(byId.get('old-8m455-apr30')?.status, 'deleted');
  assert.equal(byId.get('old-8m455-may09')?.status, 'deleted');
  assert.equal(byId.get('old-8m455-oct24')?.status, 'active');
  assert.deepEqual(result.recordsToWrite.map((item) => item.id).sort(), [
    'old-8m455-apr29',
    'old-8m455-apr30',
    'old-8m455-may09',
  ]);
});
