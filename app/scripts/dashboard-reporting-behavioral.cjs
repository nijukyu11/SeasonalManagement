/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const tempDir = path.join(root, '.tmp-dashboard-behavioral-tests');

function setupFixtures() {
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"type":"commonjs"}\n');

  const moduleNames = [
    'types',
    'routeCountry',
    'dashboardAnalysis',
    'exportSave',
    'dashboardReportExport',
  ];

  for (const name of moduleNames) {
    const sourcePath = path.join(root, 'src', 'lib', `${name}.ts`);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });
    fs.writeFileSync(path.join(tempDir, `${name}.js`), output.outputText, 'utf8');
  }
}

setupFixtures();

const {
  buildDashboardComparison,
} = require(path.join(tempDir, 'dashboardAnalysis.js'));

const {
  CANONICAL_DASHBOARD_REPORT_COLUMNS,
  buildDashboardReportRows,
  buildSanLuongSummaryWorkbook,
  buildMomWowAnalysisWorkbook,
} = require(path.join(tempDir, 'dashboardReportExport.js'));

const seasonalRecord = (overrides) => ({
  id: overrides.id,
  linkId: overrides.id,
  type: overrides.type,
  airline: overrides.airline ?? 'VN',
  flightNumber: `${overrides.airline ?? 'VN'}${String(overrides.rawFlightNumber).padStart(3, '0')}`,
  rawFlightNumber: String(overrides.rawFlightNumber),
  requestStatusCode: null,
  route: overrides.route ?? (overrides.type === 'A' ? 'NRT-DAD' : 'DAD-NRT'),
  schedule: overrides.schedule,
  aircraft: overrides.aircraft ?? '321',
  category: 'J',
  flightType: 'J',
  codeShares: null,
  intDomInd: null,
  pax: overrides.pax ?? null,
  gate: null,
  stand: null,
  counter: null,
  carousel: null,
  mct: null,
  fb: null,
  lb: null,
  bhs: null,
  ghs: null,
  date: overrides.date,
  dayOfWeek: 1,
  action: null,
  sourceRowIndex: overrides.sourceRowIndex ?? 1,
  sourceKind: 'imported',
  sourceSide: overrides.type === 'A' ? 'ARR' : 'DEP',
  status: 'active',
  ...overrides,
});

const customRouteCountryMap = [
  { route: 'ICN', country: 'South Korea' },
  { route: 'PUS', country: 'South Korea' },
  { route: 'BKK', country: 'Thailand' },
  { route: 'SIN', country: 'Singapore' },
  { route: 'KUL', country: 'Malaysia' },
  { route: 'HAN', country: 'Vietnam' },
  { route: 'SGN', country: 'Vietnam' },
  { route: 'DAD', country: 'Vietnam' },
];

test('canonical dashboard report rows normalize active records and exclude deleted records', () => {
  const dashboardReportRows = buildDashboardReportRows({
    records: [
      seasonalRecord({ id: 'REP-A1', type: 'A', airline: 'VJ', rawFlightNumber: '901', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
      seasonalRecord({ id: 'REP-D1', type: 'D', airline: 'VJ', rawFlightNumber: '902', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '23:30', pax: 181 }),
      seasonalRecord({ id: 'REP-D2', type: 'D', airline: 'VN', rawFlightNumber: '903', route: 'PUS', aircraft: '789', date: '2026-07-04', schedule: '01:00', pax: 230 }),
      { ...seasonalRecord({ id: 'REP-DELETED', type: 'D', airline: 'AK', rawFlightNumber: '999', route: 'KUL', aircraft: '320', date: '2026-07-05', schedule: '12:00', pax: 100 }), status: 'deleted' },
    ],
    routeCountries: customRouteCountryMap,
    timeBasis: 'local',
  });

  assert(
    JSON.stringify(CANONICAL_DASHBOARD_REPORT_COLUMNS) === JSON.stringify(['Type', 'Flight', 'Config', 'STA/STD', 'Routes', 'Pax', 'Note', 'Airlines', 'Ops Date', 'Country', 'Weeknum', 'UTC', 'HourUTC', 'A/C Type', 'DayIndex', 'Weekday', 'IsoWeek']) &&
      dashboardReportRows.length === 3 &&
      dashboardReportRows[0].Country === 'South Korea' &&
      dashboardReportRows[0].Note === 'Bags Delivered' &&
      dashboardReportRows[2].UTC === '2026-07-03 18:00' &&
      dashboardReportRows[2].HourUTC === 18 &&
      dashboardReportRows[2].DayIndex === 4 &&
      dashboardReportRows[2].IsoWeek === '2026-W27' &&
      !JSON.stringify(dashboardReportRows).includes('REP-DELETED'),
    `dashboard report rows should normalize active FlightRecords into canonical SanLuong columns, got ${JSON.stringify(dashboardReportRows)}`
  );
});

test('buildSanLuongSummaryWorkbook populates raw rows and airline summary sheets', () => {
  const dashboardReportRows = buildDashboardReportRows({
    records: [
      seasonalRecord({ id: 'REP-A1', type: 'A', airline: 'VJ', rawFlightNumber: '901', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
      seasonalRecord({ id: 'REP-D1', type: 'D', airline: 'VJ', rawFlightNumber: '902', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '23:30', pax: 181 }),
      seasonalRecord({ id: 'REP-D2', type: 'D', airline: 'VN', rawFlightNumber: '903', route: 'PUS', aircraft: '789', date: '2026-07-04', schedule: '01:00', pax: 230 }),
    ],
    routeCountries: customRouteCountryMap,
    timeBasis: 'local',
  });

  const sanLuongWorkbook = buildSanLuongSummaryWorkbook({
    records: dashboardReportRows.map((row, index) => seasonalRecord({
      id: `REP-WB-${index}`,
      type: row.Type,
      airline: row.Airlines,
      rawFlightNumber: String(row.Flight).replace(row.Airlines, ''),
      route: row.Routes,
      aircraft: row['A/C Type'],
      date: String(row['Ops Date']).slice(0, 10),
      schedule: String(row['STA/STD']).slice(11, 16),
      pax: row.Pax,
    })),
    routeCountries: customRouteCountryMap,
    seasonCode: 'S26',
    timeBasis: 'local',
    generatedAt: new Date('2026-07-10T00:00:00Z'),
  });

  assert(
    ['Report Guide', 'Data', 'Airline', 'Country', 'Routes', 'Frequency', 'Month', 'Week', 'PeakHour', 'Per30min', '30days', 'ACType'].every((name) => sanLuongWorkbook.SheetNames.includes(name)),
    `SanLuong summary workbook should include guide, raw Data, and generated pivot-style sheets, got ${JSON.stringify(sanLuongWorkbook.SheetNames)}`
  );
  const sanLuongDataRows = XLSX.utils.sheet_to_json(sanLuongWorkbook.Sheets.Data, { defval: '' });
  const sanLuongAirlineRows = XLSX.utils.sheet_to_json(sanLuongWorkbook.Sheets.Airline, { defval: '' });
  assert(
    sanLuongDataRows.length === 3 &&
      Object.keys(sanLuongDataRows[0]).includes('IsoWeek') &&
      sanLuongAirlineRows.some((row) => row.Airlines === 'VJ' && row['Total Flight'] === 2 && row['Total Pax'] === 371),
    `SanLuong summary workbook should populate raw rows and airline summary rows, got ${JSON.stringify({ sanLuongDataRows, sanLuongAirlineRows })}`
  );
});

test('buildMomWowAnalysisWorkbook preserves period totals and driver values', () => {
  const comparisonRecords = [
    seasonalRecord({ id: 'REP-KEEP-1', type: 'D', airline: 'VJ', rawFlightNumber: '901', route: 'ICN', aircraft: '321', date: '2026-07-03', schedule: '11:00', pax: 190 }),
    seasonalRecord({ id: 'REP-KEEP-2', type: 'D', airline: 'VJ', rawFlightNumber: '902', route: 'ICN', aircraft: '321', date: '2026-06-03', schedule: '10:00', pax: 180 }),
  ];

  const depOnlyComparison = buildDashboardComparison({
    records: comparisonRecords,
    mode: 'mom',
    metric: 'flights',
    typeFilter: 'D',
    dimension: 'airline',
    timeBasis: 'local',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
  });

  const comparisonReportFilters = {
    comparisonMode: 'mom',
    metric: 'flights',
    typeFilter: 'D',
    dimension: 'airline',
    timeBasis: 'local',
  };

  const comparisonSelectedDriver = depOnlyComparison.drivers.find((driver) => driver.key === 'VJ') ?? null;
  const comparisonReportContext = {
    filters: comparisonReportFilters,
    comparison: depOnlyComparison,
    waterfallRows: [],
    selectedDriver: comparisonSelectedDriver,
    selectedDriverRecords: {
      totalRecords: 2,
      includedRecords: 2,
      records: comparisonRecords,
    },
  };

  const momWorkbook = buildMomWowAnalysisWorkbook({
    context: comparisonReportContext,
    seasonCode: 'S26',
    generatedAt: new Date('2026-07-10T00:00:00Z'),
  });

  const momSummaryRows = XLSX.utils.sheet_to_json(momWorkbook.Sheets.Summary, { defval: '' });
  const momDriverRows = XLSX.utils.sheet_to_json(momWorkbook.Sheets.Drivers, { defval: '' });
  assert(
    momSummaryRows.some((row) => row.Field === 'Current Total' && row.Value === 1) &&
      momSummaryRows.some((row) => row.Field === 'Previous Total' && row.Value === 1) &&
      momDriverRows.some((row) => row.Driver === 'VJ' && row.Current === 1 && row.Previous === 1 && row.Delta === 0),
    `MoM/WoW workbook must preserve business values, got ${JSON.stringify({ momSummaryRows, momDriverRows })}`
  );
});

test('buildDashboardComparison handles empty and ready comparison status', () => {
  const records = [
    seasonalRecord({ id: 'D1', type: 'D', airline: 'VJ', rawFlightNumber: '1', route: 'ICN', date: '2026-07-03', schedule: '11:00', pax: 190 }),
    seasonalRecord({ id: 'D2', type: 'D', airline: 'VJ', rawFlightNumber: '2', route: 'ICN', date: '2026-06-03', schedule: '10:00', pax: 180 }),
  ];

  const emptyComparison = buildDashboardComparison({
    records,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-05',
    previousPeriod: '2026-04',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert.equal(emptyComparison.status, 'empty');

  const readyComparison = buildDashboardComparison({
    records,
    mode: 'mom',
    metric: 'flights',
    currentPeriod: '2026-07',
    previousPeriod: '2026-06',
    typeFilter: 'all',
    timeBasis: 'local',
    dimension: 'airline',
  });
  assert.equal(readyComparison.status, 'ready');
  assert.equal(readyComparison.delta, 0);
  assert.equal(readyComparison.drivers.length, 1);
  assert.equal(readyComparison.drivers[0].key, 'VJ');
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
