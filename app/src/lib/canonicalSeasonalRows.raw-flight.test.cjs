/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceDir = __dirname;
process.env.NODE_PATH = path.resolve(sourceDir, '../../node_modules');
require('node:module').Module._initPaths();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seasonal-canonical-export-'));
const moduleNames = [
  'types',
  'importSeasonRules',
  'iataSeason',
  'seasonalPairing',
  'flightPairIntegrity',
  'effectiveSeasonalLegs',
  'seasonalSourceRowValidation',
  'parser',
  'atomicSchedule',
  'detailedScheduleState',
  'exportSave',
  'canonicalSeasonalRows',
  'operationalResourceValues',
  'scheduleTime',
  'persistenceSchema',
];

fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');
for (const name of moduleNames) {
  const source = fs.readFileSync(path.join(sourceDir, `${name}.ts`), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: `${name}.ts`,
  });
  const commonJsOutput = output.outputText.replace(/require\("(\.\/[^\"]+)\.ts"\)/g, 'require("$1.js")');
  fs.writeFileSync(path.join(tempDir, `${name}.js`), commonJsOutput);
}

const {
  buildCanonicalSeasonalRows,
  buildSourceRowRebuildPlan,
  exportCanonicalSeasonalRowsToExcel,
} = require(path.join(tempDir, 'canonicalSeasonalRows.js'));
const { expandToFlightLegs } = require(path.join(tempDir, 'parser.js'));
const { resolveSeasonalPairs } = require(path.join(tempDir, 'seasonalPairing.js'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('round-trip accepts legacy short raw flight numbers after normalization', () => {
  const record = {
    id: 'LEG_A_2026-03-29_153_LJ_LJ081_ICN_23_15_738',
    linkId: 'LEG_A_2026-03-29_153_LJ_LJ081_ICN_23_15_738',
    type: 'A',
    airline: 'LJ',
    flightNumber: '81',
    rawFlightNumber: '81',
    requestStatusCode: null,
    route: 'ICN',
    schedule: '23:15',
    aircraft: '738',
    category: 'J',
    flightType: 'PAX',
    codeShares: 'KE5769',
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
    date: '2026-03-29',
    scheduledDate: '2026-03-29',
    scheduledTime: '23:15',
    operationalDate: '2026-03-29',
    iataSeasonCode: 'S26',
    flightSeriesId: 'S26|LJ|LJ081|A|ICN',
    dayOfWeek: 0,
    action: null,
    sourceRowIndex: 150,
    sourceKind: 'imported',
    sourceSide: 'ARR',
    status: 'active',
  };

  const result = buildCanonicalSeasonalRows({ records: [record], modifications: new Map() });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].arrFlight, '81');
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation));
});

test('canonical identity handles leading zeros and prefixed values without double-prefixing', () => {
  for (const [flightNumber, rawFlightNumber, expectedCell] of [
    ['081', '081', '081'],
    ['LJ81', 'LJ81', 'LJ81'],
    ['LJ081', '081', '081'],
  ]) {
    const candidate = flightRecord({
      id: `identity-${flightNumber}`,
      airline: 'LJ',
      flightNumber,
      rawFlightNumber,
      type: 'A',
    });
    const result = buildCanonicalSeasonalRows({ records: [candidate], modifications: new Map() });
    assert.equal(result.rows[0].arrFlight, expectedCell);
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation));
  }
});

test('season export emits only the active atomic flight after action history is compacted', () => {
  const historicalDeleted = flightRecord({
    id: 'history-old',
    action: 'deleted',
    status: 'deleted',
    route: 'KIX',
  });
  const activeCanonical = flightRecord({
    id: 'atomic-active',
    route: 'ICN',
  });
  const modifications = new Map([
    ['history-old', { legId: 'history-old', action: 'modified', route: 'SGN' }],
    ['atomic-active', { legId: 'atomic-active', action: 'modified', route: 'HAN' }],
  ]);

  const result = buildCanonicalSeasonalRows({
    records: [historicalDeleted, activeCanonical],
    modifications,
  });

  assert.equal(result.effectiveLegs.length, 1);
  assert.equal(result.effectiveLegs[0].id, 'atomic-active');
  assert.equal(result.effectiveLegs[0].route, 'HAN');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].arrRoute, 'HAN');
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation));
});

function flightRecord(overrides = {}) {
  const type = overrides.type ?? 'A';
  const date = overrides.date ?? '2026-05-27';
  const flightNumber = overrides.flightNumber ?? (type === 'A' ? 'YP621' : 'YP622');
  return {
    id: overrides.id ?? `${type}-${date}`,
    linkId: overrides.linkId ?? `link-${overrides.id ?? type}`,
    type,
    airline: overrides.airline ?? 'YP',
    flightNumber,
    rawFlightNumber: overrides.rawFlightNumber ?? flightNumber.replace(/^[A-Z]+/, ''),
    requestStatusCode: null,
    route: overrides.route ?? 'ICN',
    schedule: overrides.schedule ?? (type === 'A' ? '20:40' : '22:45'),
    aircraft: overrides.aircraft ?? '789',
    category: 'J',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: 'I',
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
    date,
    scheduledDate: date,
    scheduledTime: overrides.schedule ?? (type === 'A' ? '20:40' : '22:45'),
    operationalDate: overrides.operationalDate ?? date,
    iataSeasonCode: 'S26',
    flightSeriesId: `SER_${type}_YP_${flightNumber}_ICN`,
    dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(),
    action: overrides.action ?? null,
    sourceRowIndex: overrides.sourceRowIndex ?? 1,
    turnaroundId: overrides.turnaroundId,
    linkType: overrides.linkType,
    pairAnchorDate: overrides.pairAnchorDate,
    linkedRecordId: overrides.linkedRecordId,
    sourceKind: 'imported',
    sourceSide: type === 'A' ? 'ARR' : 'DEP',
    status: overrides.status ?? 'active',
  };
}

const invalidPairFixtures = [
  {
    name: 'missing counterpart',
    expectedCode: 'missing-counterpart',
    records: [flightRecord({ id: 'missing-arr', turnaroundId: 'missing-turn' })],
  },
  {
    name: 'non-reciprocal link',
    expectedCode: 'non-reciprocal-link',
    records: [
      flightRecord({ id: 'nonrec-arr', type: 'A', linkedRecordId: 'nonrec-dep' }),
      flightRecord({ id: 'nonrec-dep', type: 'D' }),
    ],
  },
  {
    name: 'ambiguous turnaround',
    expectedCode: 'ambiguous-pair',
    records: [
      flightRecord({ id: 'amb-arr-1', type: 'A', flightNumber: 'YP621', turnaroundId: 'amb-turn' }),
      flightRecord({ id: 'amb-arr-2', type: 'A', flightNumber: 'YP623', turnaroundId: 'amb-turn' }),
      flightRecord({ id: 'amb-dep-1', type: 'D', flightNumber: 'YP622', turnaroundId: 'amb-turn' }),
      flightRecord({ id: 'amb-dep-2', type: 'D', flightNumber: 'YP624', turnaroundId: 'amb-turn' }),
    ],
  },
];

for (const fixture of invalidPairFixtures) {
  test(`canonical validation rejects ${fixture.name}`, () => {
    const canonical = buildCanonicalSeasonalRows({ records: fixture.records, modifications: new Map() });

    assert.equal(canonical.validation.valid, false);
    assert.equal(canonical.validation.issues.some((issue) => issue.code === fixture.expectedCode), true);
  });
}

test('source-row rebuild cannot apply when canonical pair resolution has issues', () => {
  const records = [flightRecord({ id: 'plan-orphan', turnaroundId: 'plan-missing-turn' })];
  const plan = buildSourceRowRebuildPlan({
    records,
    modifications: new Map(),
    currentRows: [],
    pendingOps: [],
    syncMeta: { pendingCount: 0, syncStatus: 'synced', conflicts: [] },
  });

  assert.equal(plan.validation.valid, false);
  assert.equal(plan.canApply, false);
  assert.match(plan.blockReason ?? '', /counterpart/i);
});

test('synthetic merge export round-trips preserved and incoming occurrence signatures', () => {
  const pair = (prefix, date, sourceRowIndex) => {
    const arrivalId = `${prefix}-arr`;
    const departureId = `${prefix}-dep`;
    return [
      flightRecord({
        id: arrivalId,
        linkId: `${prefix}-turn`,
        type: 'A',
        date,
        sourceRowIndex,
        turnaroundId: `${prefix}-turn`,
        linkType: 'sameday',
        pairAnchorDate: date,
        linkedRecordId: departureId,
      }),
      flightRecord({
        id: departureId,
        linkId: `${prefix}-turn`,
        type: 'D',
        date,
        sourceRowIndex,
        turnaroundId: `${prefix}-turn`,
        linkType: 'sameday',
        pairAnchorDate: date,
        linkedRecordId: arrivalId,
      }),
    ];
  };
  const records = [
    ...pair('preserved', '2026-06-06', 41),
    ...pair('incoming', '2026-06-07', 42),
    flightRecord({
      id: 'deleted-overlay',
      date: '2026-06-08',
      sourceRowIndex: 43,
      action: 'deleted',
      status: 'deleted',
    }),
  ];

  const canonical = buildCanonicalSeasonalRows({
    records,
    modifications: new Map(),
  });
  const reparsedLegs = expandToFlightLegs(canonical.rows);
  const signature = (entry) => [
    entry.type,
    entry.date,
    entry.airline,
    entry.flightNumber,
    entry.route,
    entry.schedule,
  ].join('|');

  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  assert.equal(canonical.validation.expectedCount, 4);
  assert.equal(canonical.validation.actualCount, 4);
  assert.equal(canonical.effectiveLegs.some((entry) => entry.id === 'deleted-overlay'), false);
  assert.deepEqual(
    reparsedLegs.map(signature).sort(),
    canonical.effectiveLegs.map(signature).sort(),
  );
});

test('Excel splits overnight pairs on their own dates and retains manual linking clues', async () => {
  const arrivalId = 'k6-arr-1';
  const departureId = 'k6-dep-1';
  const records = [
    flightRecord({
      id: arrivalId,
      airline: 'K6',
      flightNumber: 'K6842',
      rawFlightNumber: '842',
      route: 'SAI',
      schedule: '19:00',
      aircraft: '320',
      type: 'A',
      date: '2026-10-25',
      linkId: 'TRN-K6-1',
      turnaroundId: 'TRN-K6-1',
      linkType: 'overnight',
      pairAnchorDate: '2026-10-25',
      linkedRecordId: departureId,
      sourceRowIndex: 1,
    }),
    flightRecord({
      id: departureId,
      airline: 'K6',
      flightNumber: 'K6841',
      rawFlightNumber: '841',
      route: 'TPE',
      schedule: '15:40',
      aircraft: '320',
      type: 'D',
      date: '2026-10-26',
      linkId: 'TRN-K6-1',
      turnaroundId: 'TRN-K6-1',
      linkType: 'overnight',
      pairAnchorDate: '2026-10-25',
      linkedRecordId: arrivalId,
      sourceRowIndex: 2,
    }),
  ];

  const canonical = buildCanonicalSeasonalRows({
    records,
    modifications: new Map(),
  });

  assert.equal(canonical.rows.length, 2);
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  const blob = exportCanonicalSeasonalRowsToExcel(canonical.rows, 'W26');
  const XLSX = require('xlsx');
  const bytes = Buffer.from(await blob.arrayBuffer());
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const exported = XLSX.utils.sheet_to_json(workbook.Sheets.W26, { defval: '' });
  const arrivalRow = exported.find((row) => row.ARRFlight === '842');
  const departureRow = exported.find((row) => row.DEPFlight === '841');
  assert.equal(arrivalRow.Effective, '25-Oct-26');
  assert.equal(arrivalRow.DEPFlight, '');
  assert.equal(departureRow.Effective, '26-Oct-26');
  assert.equal(departureRow.ARRFlight, '');
  assert.equal(arrivalRow.Airline, departureRow.Airline);
  assert.equal(arrivalRow.Aircraft, departureRow.Aircraft);
  const references = XLSX.utils.sheet_to_json(workbook.Sheets['Pair References']);
  assert.equal(references.length, 2);
  assert.deepEqual(references.map((row) => row['Pair Key']), ['TRN-K6-1', 'TRN-K6-1']);
  assert.deepEqual(references.map((row) => row['Linked Record ID']).sort(), [arrivalId, departureId].sort());
  const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const parsed = parseSeasonalSchedule(workbook);
  assert.deepEqual(parsed.issues, []);
  const reparsedLegs = expandToFlightLegs(parsed.rows);
  assert.equal(reparsedLegs.length, 2);
  const arrLeg = reparsedLegs.find((l) => l.type === 'A');
  const depLeg = reparsedLegs.find((l) => l.type === 'D');
  assert(arrLeg && depLeg);
  assert.equal(arrLeg.date, '2026-10-25');
  assert.equal(depLeg.date, '2026-10-26');
});

test('Excel preserves same-day, overnight and unlinked occurrences in the unchanged template', async () => {
  const pair = (key, arrivalDate, departureDate) => {
    const linkType = arrivalDate === departureDate ? 'sameday' : 'overnight';
    const common = { linkId: key, turnaroundId: key, linkType, pairAnchorDate: arrivalDate };
    return [
      flightRecord({ ...common, id: `${key}-A`, linkedRecordId: `${key}-D`, type: 'A', date: arrivalDate }),
      flightRecord({ ...common, id: `${key}-D`, linkedRecordId: `${key}-A`, type: 'D', date: departureDate }),
    ];
  };
  const records = [
    ...pair('SAME-1', '2026-10-13', '2026-10-13'),
    ...pair('NIGHT-1', '2026-10-14', '2026-10-15'),
    flightRecord({ id: 'SINGLE-1', date: '2026-10-16', flightNumber: 'YP701' }),
  ];
  const canonical = buildCanonicalSeasonalRows({ records });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  const blob = exportCanonicalSeasonalRowsToExcel(canonical.rows, 'S26');
  const bytes = Buffer.from(await blob.arrayBuffer());
  const XLSX = require('xlsx');
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const sheet = workbook.Sheets.S26;
  const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  assert.deepEqual(data.map((row) => [row.Effective, row.ARRFlight, row.DEPFlight]), [
    ['13-Oct-26', '621', '622'],
    ['14-Oct-26', '621', ''],
    ['15-Oct-26', '', '622'],
    ['16-Oct-26', '701', ''],
  ]);
  const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const parsed = parseSeasonalSchedule(workbook);
  assert.deepEqual(parsed.issues, []);
  const signature = (leg) => [leg.type, leg.date, leg.airline, leg.flightNumber, leg.route, leg.schedule, leg.aircraft].join('|');
  assert.deepEqual(expandToFlightLegs(parsed.rows).map(signature).sort(), records.map(signature).sort());
  for (let row = 2; row <= 5; row += 1) {
    assert.equal(sheet[`A${row}`].t, 's');
    assert.equal(sheet[`B${row}`].t, 's');
    assert.match(sheet[`A${row}`].v, /^\d{1,2}-[A-Z][a-z]{2}-\d{2}$/);
  }
  const references = XLSX.utils.sheet_to_json(workbook.Sheets['Pair References'], { defval: '' });
  assert.deepEqual(references.map((ref) => [ref['Schedule Row'], ref['Pair Key'], ref['Record ID'], ref['Linked Record ID']]), [
    [2, 'SAME-1', 'SAME-1-A', 'SAME-1-D'],
    [2, 'SAME-1', 'SAME-1-D', 'SAME-1-A'],
    [3, 'NIGHT-1', 'NIGHT-1-A', 'NIGHT-1-D'],
    [4, 'NIGHT-1', 'NIGHT-1-D', 'NIGHT-1-A'],
    [5, '', 'SINGLE-1', ''],
  ]);
  for (const reference of references) {
    const record = records.find((leg) => leg.id === reference['Record ID']);
    assert.equal(reference['Scheduled Date'], data[reference['Schedule Row'] - 2].Effective);
    assert.equal(reference['Scheduled Time'], record.schedule);
    assert.equal(reference.Airline, record.airline);
    assert.equal(reference.Aircraft, record.aircraft);
    assert.equal(reference.Route, record.route);
  }
  if (process.env.EXPORT_EXCEL_SAMPLE) {
    fs.writeFileSync(path.resolve(process.env.EXPORT_EXCEL_SAMPLE), bytes);
    console.log(`Verified workbook: ${path.resolve(process.env.EXPORT_EXCEL_SAMPLE)}`);
  }
});

test('early-morning departure keeps its scheduled date and separate operational date without timezone drift', async () => {
  const records = [
    flightRecord({ id: 'midnight-A', linkedRecordId: 'midnight-D', linkId: 'MIDNIGHT', turnaroundId: 'MIDNIGHT', linkType: 'overnight', pairAnchorDate: '2026-10-24', type: 'A', date: '2026-10-24', schedule: '23:30' }),
    flightRecord({ id: 'midnight-D', linkedRecordId: 'midnight-A', linkId: 'MIDNIGHT', turnaroundId: 'MIDNIGHT', linkType: 'overnight', pairAnchorDate: '2026-10-24', type: 'D', date: '2026-10-25', schedule: '02:30', operationalDate: '2026-10-24' }),
  ];
  const canonical = buildCanonicalSeasonalRows({ records });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  const XLSX = require('xlsx');
  const workbook = XLSX.read(Buffer.from(await exportCanonicalSeasonalRowsToExcel(canonical.rows, 'W26').arrayBuffer()), { type: 'buffer' });
  const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const { flattenRowsToFlightRecords } = require(path.join(tempDir, 'atomicSchedule.js'));
  const reparsed = flattenRowsToFlightRecords(parseSeasonalSchedule(workbook).rows);
  const departure = reparsed.find((leg) => leg.type === 'D');
  assert.equal(departure.date, '2026-10-25');
  assert.equal(departure.schedule, '02:30');
  assert.equal(departure.operationalDate, '2026-10-24');
  const references = XLSX.utils.sheet_to_json(workbook.Sheets['Pair References']);
  const departureReference = references.find((entry) => entry.Type === 'D');
  assert.equal(departureReference['Scheduled Date'], '25-Oct-26');
  assert.equal(departureReference['Operational Date'], '24-Oct-26');
  assert.equal(departureReference['Pair Anchor Date'], '24-Oct-26');
});

test('overnight Excel patterns stay aligned through counterpart changes, Sunday rollover and unlinked overlap', async () => {
  const { shiftIsoDate } = require(path.join(tempDir, 'seasonalPairing.js'));
  const { flattenRowsToFlightRecords } = require(path.join(tempDir, 'atomicSchedule.js'));
  const records = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-11-01', '2026-11-02', '2026-11-03'].flatMap((date) => {
    const key = `PAIR-${date}`;
    const common = { linkId: key, turnaroundId: key, linkType: 'overnight', pairAnchorDate: date };
    return [
      flightRecord({ ...common, id: `${key}-A`, linkedRecordId: `${key}-D`, type: 'A', date, schedule: '23:00' }),
      flightRecord({ ...common, id: `${key}-D`, linkedRecordId: `${key}-A`, type: 'D', date: shiftIsoDate(date, 1), schedule: date.endsWith('27') || date.endsWith('03') ? '03:00' : '02:00' }),
    ];
  });
  records.push(flightRecord({ id: 'unlinked-overlap', date: '2026-10-28', schedule: '23:00' }));
  const canonical = buildCanonicalSeasonalRows({ records });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  const XLSX = require('xlsx');
  const workbook = XLSX.read(Buffer.from(await exportCanonicalSeasonalRowsToExcel(canonical.rows, 'W26').arrayBuffer()), { type: 'buffer' });
  const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const parsed = parseSeasonalSchedule(workbook);
  const references = XLSX.utils.sheet_to_json(workbook.Sheets['Pair References']);
  const testedRows = new Set();
  for (const arrival of records.filter((record) => record.type === 'A' && record.linkedRecordId)) {
    const arrReference = references.find((entry) => entry['Record ID'] === arrival.id);
    const depReference = references.find((entry) => entry['Record ID'] === arrival.linkedRecordId);
    const arrRow = parsed.rows[arrReference['Schedule Row'] - 2];
    const depRow = parsed.rows[depReference['Schedule Row'] - 2];
    assert.equal(depRow.effective, shiftIsoDate(arrRow.effective, 1));
    assert.equal(depRow.discontinue, shiftIsoDate(arrRow.discontinue, 1));
    assert.deepEqual(depRow.daysOfWeek, [arrRow.daysOfWeek[6], ...arrRow.daysOfWeek.slice(0, 6)]);
    const arrIds = references.filter((ref) => ref['Schedule Row'] === arrReference['Schedule Row']).map((ref) => ref['Linked Record ID']).sort();
    const depIds = references.filter((ref) => ref['Schedule Row'] === depReference['Schedule Row']).map((ref) => ref['Record ID']).sort();
    assert.deepEqual(depIds, arrIds);
    testedRows.add(arrReference['Schedule Row']);
  }
  assert.equal(testedRows.size, 2);
  const plan = buildSourceRowRebuildPlan({ records, currentRows: [] });
  assert.equal(plan.canApply, true);
  assert.equal(plan.rows.some((row) => Object.hasOwn(row, 'pairReferences')), false);
  const { applySourceRowRebuildPlan, buildSourceRowRebuildBackup } = require(path.join(tempDir, 'canonicalSeasonalRows.js'));
  let persistedRows;
  await applySourceRowRebuildPlan('pattern-season', plan, {
    backup: buildSourceRowRebuildBackup({ seasonId: 'pattern-season', currentRows: [], plan }),
    replaceSourceRows: async (_seasonId, rows) => { persistedRows = rows; },
  });
  assert.equal(persistedRows.some((row) => Object.hasOwn(row, 'pairReferences')), false);
  const rebuilt = flattenRowsToFlightRecords(persistedRows);
  const resolution = resolveSeasonalPairs(rebuilt);
  assert.deepEqual(resolution.issues, []);
  assert.equal(resolution.pairs.length, 6);
  assert.equal(resolution.unpaired.length, 1);
  if (process.env.EXPORT_EXCEL_PATTERN_SAMPLE) {
    XLSX.writeFile(workbook, path.resolve(process.env.EXPORT_EXCEL_PATTERN_SAMPLE));
    console.log(`Verified overnight patterns: ${path.resolve(process.env.EXPORT_EXCEL_PATTERN_SAMPLE)}`);
  }
});

const longestPhaseFixtures = [
  { name: 'leading exception does not consume the weekly phase', dates: ['2026-10-11', '2026-10-13', '2026-10-20', '2026-10-27'], bounds: [['2026-10-11', '2026-10-11'], ['2026-10-13', '2026-10-27']] },
  { name: 'exceptions stay outside both ends of the longest phase', dates: ['2026-10-11', '2026-10-13', '2026-10-20', '2026-10-27', '2026-10-29'], bounds: [['2026-10-11', '2026-10-11'], ['2026-10-13', '2026-10-27'], ['2026-10-29', '2026-10-29']] },
  { name: 'missing week separates otherwise identical weekly phases', dates: ['2026-10-11', '2026-10-18', '2026-11-01', '2026-11-08'], bounds: [['2026-10-11', '2026-10-18'], ['2026-11-01', '2026-11-08']] },
  { name: 'equal spans favor more occurrences before earlier start', dates: ['2026-10-11', '2026-10-17', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'], bounds: [['2026-10-11', '2026-10-11'], ['2026-10-17', '2026-10-23']] },
  { name: 'equal spans and counts favor the earlier phase', dates: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-19', '2026-10-21', '2026-10-26'], bounds: [['2026-10-11', '2026-10-11'], ['2026-10-12', '2026-10-19'], ['2026-10-21', '2026-10-26']] },
];

for (const fixture of longestPhaseFixtures) {
  test(`longest phase Excel: ${fixture.name}`, async () => {
    const records = fixture.dates.map((date) => flightRecord({ date }));
    const canonical = buildCanonicalSeasonalRows({ records });
    assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
    const XLSX = require('xlsx');
    const workbook = XLSX.read(Buffer.from(await exportCanonicalSeasonalRowsToExcel(canonical.rows, 'W26').arrayBuffer()), { type: 'buffer' });
    const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
    const parsed = parseSeasonalSchedule(workbook);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.rows.map((row) => [row.effective, row.discontinue]), fixture.bounds);
    assert.deepEqual(expandToFlightLegs(parsed.rows).map((leg) => leg.date).sort(), fixture.dates);
    for (let i = 1; i < parsed.rows.length; i += 1) {
      assert.ok(parsed.rows[i - 1].discontinue < parsed.rows[i].effective);
    }
    if (fixture === longestPhaseFixtures[1] && process.env.EXPORT_EXCEL_PHASE_SAMPLE) {
      XLSX.writeFile(workbook, path.resolve(process.env.EXPORT_EXCEL_PHASE_SAMPLE));
      console.log(`Verified longest phases: ${path.resolve(process.env.EXPORT_EXCEL_PHASE_SAMPLE)}`);
    }
  });
}

test('longest overnight phase retains matching departure pattern and rebuild links', async () => {
  const { shiftIsoDate } = require(path.join(tempDir, 'seasonalPairing.js'));
  const records = longestPhaseFixtures[1].dates.flatMap((date) => {
    const key = `LONG-${date}`;
    const common = { linkId: key, turnaroundId: key, linkType: 'overnight', pairAnchorDate: date };
    return [
      flightRecord({ ...common, id: `${key}-A`, linkedRecordId: `${key}-D`, type: 'A', date, schedule: '23:00' }),
      flightRecord({ ...common, id: `${key}-D`, linkedRecordId: `${key}-A`, type: 'D', date: shiftIsoDate(date, 1), schedule: '02:00' }),
    ];
  });
  const canonical = buildCanonicalSeasonalRows({ records });
  assert.equal(canonical.validation.valid, true, JSON.stringify(canonical.validation));
  const XLSX = require('xlsx');
  const workbook = XLSX.read(Buffer.from(await exportCanonicalSeasonalRowsToExcel(canonical.rows, 'W26').arrayBuffer()), { type: 'buffer' });
  const { parseSeasonalSchedule } = require(path.join(tempDir, 'parser.js'));
  const parsed = parseSeasonalSchedule(workbook);
  const arrivals = parsed.rows.filter((row) => row.arrFlight);
  const departures = parsed.rows.filter((row) => row.depFlight);
  assert.deepEqual(arrivals.map((row) => [row.effective, row.discontinue]), longestPhaseFixtures[1].bounds);
  assert.deepEqual(departures.map((row) => [row.effective, row.discontinue]), longestPhaseFixtures[1].bounds.map((bounds) => bounds.map((date) => shiftIsoDate(date, 1))));
  const references = XLSX.utils.sheet_to_json(workbook.Sheets['Pair References']);
  for (let i = 0; i < arrivals.length; i += 1) {
    assert.deepEqual(departures[i].daysOfWeek, [arrivals[i].daysOfWeek[6], ...arrivals[i].daysOfWeek.slice(0, 6)]);
    const arrRowNumber = parsed.rows.indexOf(arrivals[i]) + 2;
    const depRowNumber = parsed.rows.indexOf(departures[i]) + 2;
    assert.deepEqual(
      references.filter((ref) => ref['Schedule Row'] === arrRowNumber).map((ref) => ref['Linked Record ID']).sort(),
      references.filter((ref) => ref['Schedule Row'] === depRowNumber).map((ref) => ref['Record ID']).sort(),
    );
  }
  const { flattenRowsToFlightRecords } = require(path.join(tempDir, 'atomicSchedule.js'));
  const signature = (leg) => [leg.type, leg.date, leg.schedule].join('|');
  assert.deepEqual(expandToFlightLegs(parsed.rows).map(signature).sort(), records.map(signature).sort());
  const plan = buildSourceRowRebuildPlan({ records, currentRows: [] });
  assert.equal(plan.canApply, true);
  const resolution = resolveSeasonalPairs(flattenRowsToFlightRecords(plan.rows));
  assert.deepEqual(resolution.issues, []);
  assert.equal(resolution.pairs.length, 5);
  assert.equal(plan.rows.some((row) => Object.hasOwn(row, 'pairReferences')), false);
});

test('phase selection matches exhaustive longest-interval ranking for irregular calendars', () => {
  const offsets = [0, 1, 2, 6, 7, 8, 14, 21];
  const baseMs = Date.UTC(2026, 9, 11);
  const iso = (offset) => new Date(baseMs + offset * 86400000).toISOString().slice(0, 10);
  const reference = (days) => {
    if (days.length === 0) return [];
    let best = [days[0]];
    for (let start = 0; start < days.length; start += 1) {
      for (let end = start; end < days.length; end += 1) {
        const candidate = days.slice(start, end + 1);
        const present = new Set(candidate);
        const weekdays = new Set(candidate.map((day) => day % 7));
        let valid = true;
        for (let day = candidate[0]; day <= candidate.at(-1); day += 1) {
          if (weekdays.has(day % 7) && !present.has(day)) valid = false;
        }
        const span = candidate.at(-1) - candidate[0];
        const bestSpan = best.at(-1) - best[0];
        if (valid && (span > bestSpan || (span === bestSpan && candidate.length > best.length))) best = candidate;
      }
    }
    return [...reference(days.filter((day) => day < best[0])), best, ...reference(days.filter((day) => day > best.at(-1)))];
  };
  for (let mask = 1; mask < 1 << offsets.length; mask += 1) {
    const days = offsets.filter((_day, index) => mask & (1 << index));
    const records = days.map((day) => flightRecord({ date: iso(day) }));
    const canonical = buildCanonicalSeasonalRows({ records });
    assert.equal(canonical.validation.valid, true, `calendar ${mask}`);
    const { normalizeSeasonalDate } = require(path.join(tempDir, 'seasonalSourceRowValidation.js'));
    assert.deepEqual(
      canonical.rows.map((row) => [normalizeSeasonalDate(row.effective), normalizeSeasonalDate(row.discontinue)]),
      reference(days).map((run) => [iso(run[0]), iso(run.at(-1))]),
      `calendar ${mask}`,
    );
  }
});

test('serializeSourceRowForPersistence strips export-only pairReferences from canonical rows', () => {
  const { serializeSourceRowForPersistence } = require(path.join(tempDir, 'persistenceSchema.js'));
  const records = [
    flightRecord({ id: 'ser-arr', linkedRecordId: 'ser-dep', linkId: 'SER-1', turnaroundId: 'SER-1', linkType: 'overnight', pairAnchorDate: '2026-10-25', type: 'A', date: '2026-10-25', schedule: '23:00' }),
    flightRecord({ id: 'ser-dep', linkedRecordId: 'ser-arr', linkId: 'SER-1', turnaroundId: 'SER-1', linkType: 'overnight', pairAnchorDate: '2026-10-25', type: 'D', date: '2026-10-26', schedule: '02:00' }),
  ];
  const canonical = buildCanonicalSeasonalRows({ records });
  assert.equal(canonical.rows.length, 2);
  for (const row of canonical.rows) {
    assert.ok(Array.isArray(row.pairReferences) && row.pairReferences.length === 1);
    const persisted = serializeSourceRowForPersistence(row);
    assert.equal(Object.hasOwn(persisted, 'pairReferences'), false);
    assert.equal(Object.hasOwn(persisted, 'arrFlightType'), false);
    assert.equal(Object.hasOwn(persisted, 'depFlightType'), false);
    assert.equal(persisted.linkType, 'overnight');
    assert.equal(typeof persisted.overnightLinkRowIndex, 'number');
  }
});
