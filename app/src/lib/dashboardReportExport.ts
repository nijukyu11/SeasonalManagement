import * as XLSX from 'xlsx';
import type { DashboardAiContext, DashboardCustomWorkbookSpec } from './dashboardAiAnalysis';
import { saveWorkbookAsXlsx, workbookToXlsxBlob as sharedWorkbookToXlsxBlob, type ExportSaveResult } from './exportSave';
import type { FlightRecord, RouteCountryMapping } from './types';
import { resolveCountryForRoute } from './routeCountry';

export type DashboardReportTemplateId = 'mom-wow-analysis' | 'sanluong-summary';

export interface DashboardReportRow {
  Type: 'A' | 'D';
  Flight: string;
  Config: string | number | null;
  'STA/STD': string;
  Routes: string;
  Pax: number;
  Note: string;
  Airlines: string;
  'Ops Date': string;
  Country: string;
  Weeknum: number | null;
  UTC: string;
  HourUTC: number | null;
  'A/C Type': string;
  DayIndex: number | null;
  Weekday: string;
  IsoWeek: string;
}

export interface BuildDashboardReportRowsInput {
  records: FlightRecord[];
  routeCountries?: RouteCountryMapping[] | null;
  timeBasis?: 'local' | 'utc';
}

export interface BuildDashboardWorkbookInput extends BuildDashboardReportRowsInput {
  seasonCode?: string | null;
  generatedAt?: Date;
}

export interface BuildMomWowAnalysisWorkbookInput {
  context: DashboardAiContext;
  aiNotes?: string | null;
  seasonCode?: string | null;
  generatedAt?: Date;
}

export interface BuildCustomDashboardWorkbookOptions {
  seasonCode?: string | null;
  generatedAt?: Date;
}

export const CANONICAL_DASHBOARD_REPORT_COLUMNS = [
  'Type',
  'Flight',
  'Config',
  'STA/STD',
  'Routes',
  'Pax',
  'Note',
  'Airlines',
  'Ops Date',
  'Country',
  'Weeknum',
  'UTC',
  'HourUTC',
  'A/C Type',
  'DayIndex',
  'Weekday',
  'IsoWeek',
] as const;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LOCAL_UTC_OFFSET_MINUTES = 7 * 60;

export function buildDashboardReportRows(input: BuildDashboardReportRowsInput): DashboardReportRow[] {
  return input.records
    .filter((record) => record.status !== 'deleted')
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule) || left.flightNumber.localeCompare(right.flightNumber))
    .map((record) => {
      const localDateTime = formatLocalDateTime(record.date, record.schedule);
      const utcDateTime = formatUtcDateTime(record.date, record.schedule);
      const utcHour = utcDateTime ? Number(utcDateTime.slice(11, 13)) : null;
      const parsedDate = parseIsoDate(record.date);
      return {
        Type: record.type,
        Flight: record.flightNumber || `${record.airline}${record.rawFlightNumber}`,
        Config: null,
        'STA/STD': localDateTime,
        Routes: record.route || 'Unknown',
        Pax: normalizeNumber(record.pax),
        Note: record.type === 'A' ? 'Bags Delivered' : 'Departed',
        Airlines: record.airline || 'Unknown',
        'Ops Date': `${record.date} 00:00:00`,
        Country: resolveCountryForRoute(record.route, input.routeCountries ?? undefined),
        Weeknum: isoWeekNumber(record.date),
        UTC: utcDateTime,
        HourUTC: Number.isFinite(utcHour) ? utcHour : null,
        'A/C Type': record.aircraft || 'Unknown',
        DayIndex: parsedDate ? parsedDate.getUTCDate() : null,
        Weekday: parsedDate ? WEEKDAY_LABELS[parsedDate.getUTCDay()] : 'Unknown',
        IsoWeek: isoWeekKey(record.date),
      };
    });
}

export function buildSanLuongSummaryWorkbook(input: BuildDashboardWorkbookInput): XLSX.WorkBook {
  const rows = buildDashboardReportRows(input);
  const workbook = XLSX.utils.book_new();
  appendRowsSheet(workbook, 'Report Guide', buildReportGuideRows({
    template: 'sanluong-summary',
    seasonCode: input.seasonCode,
    generatedAt: input.generatedAt,
  }));
  appendRowsSheet(workbook, 'Data', rows, [...CANONICAL_DASHBOARD_REPORT_COLUMNS]);
  appendRowsSheet(workbook, 'Airline', summarizeBy(rows, 'Airlines'));
  appendRowsSheet(workbook, 'Country', summarizeBy(rows, 'Country'));
  appendRowsSheet(workbook, 'Routes', summarizeBy(rows, 'Routes'));
  appendRowsSheet(workbook, 'Frequency', summarizeFrequency(rows));
  appendRowsSheet(workbook, 'Month', summarizeMonth(rows));
  appendRowsSheet(workbook, 'Week', summarizeWeek(rows));
  appendRowsSheet(workbook, 'PeakHour', summarizeBy(rows, 'HourUTC'));
  appendRowsSheet(workbook, 'Per30min', summarizeHalfHour(rows));
  appendRowsSheet(workbook, '30days', summarizeBy(rows, 'DayIndex'));
  appendRowsSheet(workbook, 'ACType', summarizeBy(rows, 'A/C Type'));
  return workbook;
}

export function buildMomWowAnalysisWorkbook(input: BuildMomWowAnalysisWorkbookInput): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const { context } = input;
  const filters = context.filters ?? {
    comparisonMode: 'mom',
    metric: 'flights',
    typeFilter: 'all',
    dimension: 'airline',
    timeBasis: 'local',
  };
  const comparison = context.comparison;
  const selectedDriverRecords = context.selectedDriverRecords ?? {
    totalRecords: 0,
    includedRecords: 0,
    truncated: false,
    records: [],
  };
  appendRowsSheet(workbook, 'Report Guide', buildReportGuideRows({
    template: 'mom-wow-analysis',
    seasonCode: input.seasonCode,
    generatedAt: input.generatedAt,
  }));
  appendRowsSheet(workbook, 'Summary', [
    { Field: 'Report Type', Value: 'MoM/WoW AI Analysis' },
    { Field: 'Season', Value: input.seasonCode ?? '' },
    { Field: 'Generated At', Value: formatGeneratedAt(input.generatedAt) },
    { Field: 'Comparison Mode', Value: filters.comparisonMode },
    { Field: 'Metric', Value: filters.metric },
    { Field: 'Type Filter', Value: filters.typeFilter },
    { Field: 'Dimension', Value: filters.dimension },
    { Field: 'Time Basis', Value: filters.timeBasis },
    { Field: 'Current Period', Value: comparison?.periodLabels.current ?? '' },
    { Field: 'Previous Period', Value: comparison?.periodLabels.previous ?? '' },
    { Field: 'Current Total', Value: comparison?.current.total ?? '' },
    { Field: 'Previous Total', Value: comparison?.previous.total ?? '' },
    { Field: 'Delta', Value: comparison?.delta ?? '' },
    { Field: 'Delta Percent', Value: comparison?.deltaPct ?? '' },
    { Field: 'Status', Value: comparison?.status ?? '' },
    { Field: 'Selected Driver', Value: context.selectedDriver?.label ?? '' },
  ]);
  appendRowsSheet(workbook, 'Drivers', (comparison?.drivers ?? []).map((driver) => ({
    Driver: driver.label,
    Current: driver.currentValue,
    Previous: driver.previousValue,
    Delta: driver.delta,
    'Delta %': driver.deltaPct ?? '',
    'CTG %': driver.ctgPct ?? '',
    'Current Share': driver.currentShare,
    'Previous Share': driver.previousShare,
    'Share Shift': driver.shareShift,
  })));
  appendRowsSheet(workbook, 'Waterfall', (context.waterfallRows ?? []).map((row) => ({
    Dimension: row.label,
    Metric: row.result.metric,
    Current: row.result.current.total,
    Previous: row.result.previous.total,
    Delta: row.result.delta,
    'Top Driver': row.topDriver?.label ?? '',
    'Top Driver Delta': row.topDriver?.delta ?? '',
    'Reconciled Delta': row.reconciledDelta,
  })));
  appendRowsSheet(workbook, 'Selected Records', selectedDriverRecords.records.map((record) => ({
    Date: record.date,
    Type: record.type,
    Airline: record.airline,
    Flight: record.flightNumber,
    RawFlight: record.rawFlightNumber,
    Route: record.route,
    Schedule: record.schedule,
    Aircraft: record.aircraft,
    Pax: record.pax ?? '',
  })));
  appendRowsSheet(workbook, 'AI Notes', [
    { Field: 'Latest AI Answer', Value: input.aiNotes?.trim() || 'No AI answer included.' },
    { Field: 'Selected Records Included', Value: selectedDriverRecords.includedRecords },
    { Field: 'Selected Records Total', Value: selectedDriverRecords.totalRecords },
    { Field: 'Selected Records Truncated', Value: selectedDriverRecords.truncated ? 'Yes' : 'No' },
  ]);
  return workbook;
}

export function buildCustomDashboardWorkbook(
  spec: DashboardCustomWorkbookSpec,
  options: BuildCustomDashboardWorkbookOptions = {}
): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  appendRowsSheet(workbook, 'Report Guide', [
    { Field: 'Template', Value: 'dashboard-custom-workbook' },
    { Field: 'Title', Value: spec.title },
    { Field: 'Season', Value: options.seasonCode ?? '' },
    { Field: 'Generated At', Value: formatGeneratedAt(options.generatedAt) },
    { Field: 'Safety', Value: 'Generated locally from a validated AI workbook spec. Formulas, paths, macros, scripts, and external links are not allowed.' },
  ]);
  for (const sheet of spec.sheets) {
    appendRowsSheet(workbook, sheet.name, sheet.rows, sheet.columns);
    if (sheet.notes) {
      const worksheet = workbook.Sheets[sheet.name] as XLSX.WorkSheet & { '!comments'?: unknown };
      const noteCell = XLSX.utils.encode_cell({ r: 0, c: Math.max(0, sheet.columns.length - 1) });
      worksheet[noteCell] = worksheet[noteCell] ?? { t: 's', v: sheet.columns[Math.max(0, sheet.columns.length - 1)] ?? 'Notes' };
      worksheet[noteCell].c = [{ a: 'AI', t: sheet.notes }];
    }
  }
  return workbook;
}

export function buildDashboardReportFileName(templateId: DashboardReportTemplateId, seasonCode?: string | null, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const season = sanitizeFilePart(seasonCode || 'Season');
  return templateId === 'mom-wow-analysis'
    ? `${season}_MoM_WoW_AI_Analysis_${stamp}.xlsx`
    : `${season}_SanLuong_Summary_${stamp}.xlsx`;
}

export function workbookToXlsxBlob(workbook: XLSX.WorkBook): Blob {
  return sharedWorkbookToXlsxBlob(workbook);
}

export function downloadDashboardWorkbook(workbook: XLSX.WorkBook, fileName: string): Promise<ExportSaveResult> {
  return saveWorkbookAsXlsx(workbook, fileName);
}

function summarizeBy(rows: DashboardReportRow[], field: keyof DashboardReportRow): Array<Record<string, string | number>> {
  const groups = new Map<string, SummaryAccumulator>();
  for (const row of rows) {
    const key = String(row[field] ?? 'Unknown') || 'Unknown';
    addSummary(groups, key, row);
  }
  return summaryRows(groups, String(field));
}

function summarizeFrequency(rows: DashboardReportRow[]): Array<Record<string, string | number>> {
  const groups = new Map<string, SummaryAccumulator & { Airlines: string; IsoWeek: string }>();
  for (const row of rows) {
    const key = `${row.Airlines}|${row.IsoWeek}`;
    const current = groups.get(key) ?? { ...emptyAccumulator(), Airlines: row.Airlines, IsoWeek: row.IsoWeek };
    addToAccumulator(current, row);
    groups.set(key, current);
  }
  return [...groups.values()]
    .sort((a, b) => a.Airlines.localeCompare(b.Airlines) || a.IsoWeek.localeCompare(b.IsoWeek))
    .map((value) => ({ Airlines: value.Airlines, IsoWeek: value.IsoWeek, ...accumulatorToRow(value) }));
}

function summarizeMonth(rows: DashboardReportRow[]): Array<Record<string, string | number>> {
  const groups = new Map<string, SummaryAccumulator & { Month: string }>();
  for (const row of rows) {
    const monthKey = String(row['Ops Date']).slice(0, 7);
    const month = formatMonthLabel(monthKey);
    const current = groups.get(monthKey) ?? { ...emptyAccumulator(), Month: month };
    addToAccumulator(current, row);
    groups.set(monthKey, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => ({ Month: value.Month, ...accumulatorToRow(value) }));
}

function summarizeWeek(rows: DashboardReportRow[]): Array<Record<string, string | number>> {
  const groups = new Map<string, SummaryAccumulator>();
  for (const row of rows) addSummary(groups, row.IsoWeek, row);
  return summaryRows(groups, 'IsoWeek');
}

function summarizeHalfHour(rows: DashboardReportRow[]): Array<Record<string, string | number>> {
  const groups = new Map<string, SummaryAccumulator>();
  for (const row of rows) {
    const halfHour = String(row['STA/STD']).slice(11, 16).replace(/:[0-2]\d$/, ':00').replace(/:[3-5]\d$/, ':30');
    addSummary(groups, halfHour || 'Unknown', row);
  }
  return summaryRows(groups, 'HalfHour');
}

interface SummaryAccumulator {
  arrFlights: number;
  depFlights: number;
  totalFlights: number;
  arrPax: number;
  depPax: number;
  totalPax: number;
}

function emptyAccumulator(): SummaryAccumulator {
  return {
    arrFlights: 0,
    depFlights: 0,
    totalFlights: 0,
    arrPax: 0,
    depPax: 0,
    totalPax: 0,
  };
}

function addSummary(groups: Map<string, SummaryAccumulator>, key: string, row: DashboardReportRow): void {
  const current = groups.get(key) ?? emptyAccumulator();
  addToAccumulator(current, row);
  groups.set(key, current);
}

function addToAccumulator(current: SummaryAccumulator, row: DashboardReportRow): void {
  current.totalFlights += 1;
  current.totalPax += row.Pax;
  if (row.Type === 'A') {
    current.arrFlights += 1;
    current.arrPax += row.Pax;
  } else {
    current.depFlights += 1;
    current.depPax += row.Pax;
  }
}

function summaryRows(groups: Map<string, SummaryAccumulator>, label: string): Array<Record<string, string | number>> {
  return [...groups.entries()]
    .sort((left, right) => right[1].totalFlights - left[1].totalFlights || left[0].localeCompare(right[0]))
    .map(([key, value]) => ({ [label]: key, ...accumulatorToRow(value) }));
}

function accumulatorToRow(value: SummaryAccumulator): Record<string, number> {
  return {
    'ARR Flight': value.arrFlights,
    'DEP Flight': value.depFlights,
    'Total Flight': value.totalFlights,
    'ARR Pax': value.arrPax,
    'DEP Pax': value.depPax,
    'Total Pax': value.totalPax,
  };
}

function appendRowsSheet(workbook: XLSX.WorkBook, sheetName: string, rows: object[], header?: readonly string[]): void {
  const effectiveHeader = [...(header ?? collectHeaders(rows))];
  const worksheet = rows.length > 0
    ? XLSX.utils.json_to_sheet(rows as Array<Record<string, unknown>>, { header: effectiveHeader as string[] })
    : XLSX.utils.aoa_to_sheet([effectiveHeader]);
  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1:A1');
  worksheet['!autofilter'] = { ref: XLSX.utils.encode_range(range) };
  worksheet['!cols'] = effectiveHeader.map((key) => ({ wch: Math.min(32, Math.max(10, String(key).length + 4)) }));
  (worksheet as XLSX.WorkSheet & { '!freeze'?: unknown })['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

function collectHeaders(rows: object[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers.length > 0 ? headers : ['Field', 'Value'];
}

function buildReportGuideRows(input: { template: DashboardReportTemplateId; seasonCode?: string | null; generatedAt?: Date }): Array<Record<string, string>> {
  return [
    { Field: 'Template', Value: input.template },
    { Field: 'Season', Value: input.seasonCode ?? '' },
    { Field: 'Generated At', Value: formatGeneratedAt(input.generatedAt) },
    { Field: 'Reference Shape', Value: 'Generated summary sheets mirror SanLuong report tabs without native Excel pivot XML.' },
    { Field: 'Pivot Note', Value: 'Native pivot tables require a future template-preserving harness that clones a reference workbook and replaces Data.' },
    { Field: 'Data Columns', Value: CANONICAL_DASHBOARD_REPORT_COLUMNS.join(', ') },
  ];
}

function formatGeneratedAt(value?: Date): string {
  return (value ?? new Date()).toISOString();
}

function formatLocalDateTime(date: string, schedule: string): string {
  return `${date} ${normalizeSchedule(schedule)}`;
}

function formatUtcDateTime(date: string, schedule: string): string {
  const parsed = parseLocalDateTime(date, schedule);
  if (!parsed) return '';
  parsed.setUTCMinutes(parsed.getUTCMinutes() - LOCAL_UTC_OFFSET_MINUTES);
  return `${formatIsoDate(parsed)} ${formatTime(parsed)}`;
}

function parseLocalDateTime(date: string, schedule: string): Date | null {
  const parsedDate = parseIsoDate(date);
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!parsedDate || !match) return null;
  parsedDate.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  return parsedDate;
}

function normalizeSchedule(schedule: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!match) return '';
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatTime(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function isoWeekNumber(date: string): number | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeekKey(date));
  return match ? Number(match[2]) : null;
}

function isoWeekKey(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return '';
  const target = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const weekYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function formatMonthLabel(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return monthKey;
  return `${MONTH_LABELS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

function normalizeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Season';
}
