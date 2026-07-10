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
  'flightPairIntegrity',
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

const { buildCanonicalSeasonalRows } = require(path.join(tempDir, 'canonicalSeasonalRows.js'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('round-trip accepts legacy short raw flight numbers after normalization', () => {
  const record = {
    id: 'LEG_A_2026-03-29_153_LJ_LJ081_ICN_23_15_738',
    linkId: 'LEG_A_2026-03-29_153_LJ_LJ081_ICN_23_15_738',
    type: 'A',
    airline: 'LJ',
    flightNumber: 'LJ081',
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
