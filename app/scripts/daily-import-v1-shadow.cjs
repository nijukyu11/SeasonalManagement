/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const XLSX = require('xlsx');

const appRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(appRoot, '.tmp-daily-import-v1-shadow-'));
const sourceNames = [
  'types',
  'importSeasonRules',
  'seasonalSourceRowValidation',
  'parser',
  'iataSeason',
  'seasonalPairing',
  'atomicSchedule',
  'operationalResourceValues',
  'dailyScheduleImport',
  'dailyScheduleWorkbook',
  'dailyImportScope',
  'dailyImportV1Contract',
];

function compileSources() {
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');
  for (const name of sourceNames) {
    const source = fs.readFileSync(path.join(appRoot, 'src', 'lib', `${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: `${name}.ts`,
    }).outputText.replace(/require\("(\.\/[^\"]+)\.ts"\)/g, 'require("$1.js")');
    fs.writeFileSync(path.join(tempDir, `${name}.js`), compiled);
  }
}

async function analyzeFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const rawBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const { analyzeDailyScheduleWorkbook } = require(path.join(tempDir, 'dailyScheduleWorkbook.js'));
  const { parseDailyImportRowsStrict } = require(path.join(tempDir, 'dailyScheduleImport.js'));
  const { buildDailyImportStagePayloadV1 } = require(path.join(tempDir, 'dailyImportV1Contract.js'));
  const analysis = analyzeDailyScheduleWorkbook(workbook);
  if (!analysis.selected) {
    return { file: path.basename(filePath), valid: false, diagnostics: analysis.diagnostics };
  }
  const strict = parseDailyImportRowsStrict(analysis.selected.rows);
  const seasonCodes = [...new Set(strict.legs.map((leg) => leg.iataSeasonCode))].sort();
  const seasons = seasonCodes.map((seasonCode) => ({
    id: `shadow-${seasonCode.toLowerCase()}`,
    seasonCode,
    dataVersion: 0,
  }));
  const payload = await buildDailyImportStagePayloadV1({
    fileName: path.basename(filePath),
    rawBuffer,
    sheet: analysis.selected,
    seasons,
  });
  const rawGateTokens = analysis.selected.rows.map((row) => String(row.DEPGate ?? '').trim().toUpperCase());
  return {
    file: path.basename(filePath),
    valid: payload.diagnostics.every((item) => item.severity !== 'blocking'),
    profile: analysis.selected.profile,
    sheet: analysis.selected.sheetName,
    headerRow: analysis.selected.headerRowIndex + 1,
    firstLogicalColumn: XLSX.utils.encode_col(analysis.selected.firstLogicalColumnIndex),
    sourceRows: analysis.selected.rows.length,
    legs: payload.legs.length,
    seasonTargets: payload.seasons.map((target) => ({
      seasonCode: target.seasonCode,
      rangeStart: target.rangeStart,
      rangeEnd: target.rangeEnd,
      affectedDateCount: target.affectedDates.length,
      legCount: target.legCount,
    })),
    resourceEvidence: {
      bareGateRows: rawGateTokens.filter((token) => token === 'G').length,
      prefixedGateLegs: payload.legs.filter((leg) => /^G\d+$/i.test(leg.rawResourceTokens.gate ?? '')).length,
      alphanumericStandLegs: payload.legs.filter((leg) => /[A-Z]$/i.test(String(leg.resources.stand ?? ''))).length,
      cPrefixedCounterLegs: payload.legs.filter((leg) => /(?:^|[,\s])C\d+/i.test(leg.rawResourceTokens.counter ?? '')).length,
      mCounterLegs: payload.legs.filter((leg) => /(?:^|[,\s])M\d+/i.test(leg.rawResourceTokens.counter ?? '')).length,
    },
    diagnostics: payload.diagnostics.map((item) => ({ severity: item.severity, code: item.code, rowNumber: item.rowNumber })),
    rawChecksum: payload.rawChecksum,
    canonicalChecksum: payload.canonicalChecksum,
  };
}

async function main() {
  compileSources();
  const defaults = [
    'C:\\Users\\tuan\\Pictures\\LB_20260823_20260827.xlsx',
    'C:\\Users\\tuan\\Desktop\\OperationalTurns (16).xls',
  ];
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaults;
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) throw new Error(`Workbook not found: ${filePath}`);
  }
  const results = [];
  for (const filePath of files) results.push(await analyzeFile(filePath));
  console.log(JSON.stringify({ mode: 'read-only-shadow', results }, null, 2));
  if (results.some((result) => !result.valid)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
