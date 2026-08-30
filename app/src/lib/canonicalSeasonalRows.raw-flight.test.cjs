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
} = require(path.join(tempDir, 'canonicalSeasonalRows.js'));
const { expandToFlightLegs } = require(path.join(tempDir, 'parser.js'));

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
    operationalDate: date,
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
