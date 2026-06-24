'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getOperationalSettings, getSeasons, loadSeasonWorkspaceWindow } from '@/lib/remoteStore';
import { publishSeasonWorkspaceChanged } from '@/lib/seasonDataCache';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  buildDashboardOverview,
  buildDashboardComparison,
  buildEffectiveDashboardRecords,
  getDashboardOperationalDate,
  listDashboardPeriods,
  type DashboardComparisonGranularity,
  type DashboardComparisonMode,
  type DashboardDimension,
  type DashboardMetric,
  type DashboardTimeBasis,
  type DashboardTypeFilter,
} from '@/lib/dashboardAnalysis';
import {
  buildOperationalDashboard,
  buildPeakDayHeatmap,
  buildPeakHourHeatmap,
  computePaxCoverage,
  type OperationalDashboardBucketSize,
  type OperationalDashboardRecord,
  type OperationalPeakDayHeatmapCell,
  type OperationalTimelineBucket,
} from '@/lib/operationalDashboardAnalysis';
import {
  analyzeDashboardWithAi, 
  appendDashboardAiRunEvent,
  buildDashboardAiFallbackBoardPatch, 
  buildDashboardAiActiveArtifactFromCell,
  buildDashboardAiFollowUpBoardPatchFromCells,
  buildDashboardAiNotebookContext, 
  capDashboardAiNotebookQueryResults,
  capDashboardAiLocalHistory,
  inferDashboardAiSemanticIntent,
  isDashboardAiConfigured,
  listEnabledDashboardAiModels,
  normalizeDashboardAiWorkspaceSeasonIds,
  resolveDashboardAiAvailableTools,
  resolveDashboardAiDataScopeForPrompt,
  resolveDashboardAiQueryResults,
  resolveDashboardAiSessionFollowUp,
  resolveDashboardAiWorkflowForPrompt,
  resolveDashboardAiSkillForPrompt,
  resolveDashboardAiModel,
  type DashboardAiExportAction,
  type DashboardAiContext,
  type DashboardAiSeasonCatalog,
  type DashboardAiNotebook,
  type DashboardAiNotebookCell,
  type DashboardAiRunEvent,
  type DashboardAiToolTraceSummary,
  type DashboardAiToolName,
  type DashboardAiWorkspaceBlock,
} from '@/lib/dashboardAiAnalysis';
import {
  buildDashboardReportFileName,
  buildCustomDashboardWorkbook,
  buildMomWowAnalysisWorkbook,
  buildSanLuongSummaryWorkbook,
  downloadDashboardWorkbook,
  type DashboardReportTemplateId,
} from '@/lib/dashboardReportExport';
import {
  getCachedSeasons,
  setCachedSeasonData,
  setCachedSeasons,
} from '@/lib/seasonDataCache';
import type { LocalSyncMeta } from '@/lib/localSeasonStore';
import { queryNativeScheduleWindow } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { SERVER_AUTHORITATIVE_MODE } from '@/lib/serverAuthoritativeMode';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { readCachedWorkspaceWindow, readWorkspaceWindowSnapshot } from '@/lib/seasonWorkspaceReadModel';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { resolveCountryForRoute } from '@/lib/routeCountry';
import type { AiAnalysisModelSetting, DashboardAlertSettings, FlightModification, FlightRecord, OperationalSettings, RouteCountryMapping, Season } from '@/lib/types';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import { useCachedRouteSearchParams } from '../components/RouteCacheContext';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import SyncActionButton from '../components/SyncActionButton';
import {
  getSeasonSyncPendingCount,
  useSeasonSync,
} from '../components/SeasonSyncProvider';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSessionState } from '../hooks/useSessionState';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';
import { AiWorkspacePanel, type AiWorkspacePreset } from './components/AiWorkspacePanel';
import type { AiNotebookLoadingStep } from './components/AiNotebookCanvas';
import type { AiNotebookRendererData } from './components/AiNotebookBlockRenderers';

const METRICS: Array<{ value: DashboardMetric; label: string }> = [
  { value: 'flights', label: 'Chuyến bay' },
  { value: 'pax', label: 'Khách' },
];

const TYPE_FILTERS: Array<{ value: DashboardTypeFilter; label: string }> = [
  { value: 'all', label: 'Tất cả' },
  { value: 'A', label: 'ARR' },
  { value: 'D', label: 'DEP' },
];

const DRIVER_TABS: Array<{ value: DashboardDimension; label: string; icon: string }> = [
  { value: 'airline', label: 'Hãng bay', icon: 'airlines' },
  { value: 'country', label: 'Quốc gia', icon: 'public' },
  { value: 'route', label: 'Đường bay', icon: 'route' },
  { value: 'aircraft', label: 'A/C Type', icon: 'flight' },
  { value: 'dayOfWeek', label: 'Thứ', icon: 'calendar_month' },
  { value: 'hourBucket', label: 'Giờ', icon: 'schedule' },
];

const WATERFALL_DIMENSIONS: Array<{ value: DashboardDimension; label: string }> = [
  { value: 'airline', label: 'Hãng bay' },
  { value: 'country', label: 'Quốc gia' },
  { value: 'route', label: 'Đường bay' },
  { value: 'aircraft', label: 'A/C Type' },
  { value: 'dayOfWeek', label: 'Thứ' },
  { value: 'hourBucket', label: 'Giờ' },
];

const AI_WORKSPACE_PRESETS: AiWorkspacePreset[] = [
  {
    label: 'Tạo bảng AI Workspace',
    prompt: 'Tạo bảng AI Workspace gồm KPI, bảng tổng hợp mùa, biểu đồ xu hướng tháng và biểu đồ xếp hạng hãng bay.',
    mode: 'board',
    preferredTool: 'compose_dashboard_ai_board',
  },
  {
    label: 'So sánh mùa đã chọn',
    prompt: 'So sánh các mùa đã chọn trên AI Workspace bằng bảng tổng hợp multi-season và biểu đồ.',
    mode: 'board',
    preferredTool: 'compose_dashboard_ai_board',
  },
  {
    label: 'Tạo bảng tác nhân',
    prompt: 'Tạo bảng đóng góp tác nhân và biểu đồ waterfall trên AI Workspace.',
    mode: 'board',
    preferredTool: 'compose_dashboard_ai_board',
  },
  {
    label: 'Vẽ biểu đồ peak hour',
    prompt: 'Vẽ biểu đồ peak hour và bảng khung giờ cao điểm trên AI Workspace.',
    mode: 'board',
    preferredTool: 'compose_dashboard_ai_board',
  },
  {
    label: 'Tạo báo cáo trực quan',
    prompt: 'Tạo báo cáo trực quan trên AI Workspace gồm KPI, biểu đồ xu hướng, biểu đồ peak hour, bảng xếp hạng và nhận định.',
    mode: 'board',
    preferredTool: 'compose_dashboard_ai_board',
  },
  { label: 'Giải thích tác nhân chính', prompt: 'Giải thích các tác nhân chính bằng Supabase reporting/query và trả lời bằng tiếng Việt.', mode: 'chat' },
  { label: 'Tìm bất thường', prompt: 'Tìm các điểm bất thường bằng Supabase reporting/query và trả lời bằng tiếng Việt.', mode: 'chat' },
  { label: 'Vì sao chỉ số giảm?', prompt: 'Vì sao chỉ số này giảm theo Supabase reporting/query? Trả lời bằng tiếng Việt và nêu số liệu.', mode: 'chat' },
];

const WEEKDAY_COLUMNS = [
  { key: 'Sun', label: 'CN' },
  { key: 'Mon', label: 'T2' },
  { key: 'Tue', label: 'T3' },
  { key: 'Wed', label: 'T4' },
  { key: 'Thu', label: 'T5' },
  { key: 'Fri', label: 'T6' },
  { key: 'Sat', label: 'T7' },
];
const WEEKDAY_KEYS = WEEKDAY_COLUMNS.map((weekday) => weekday.key);
const MONDAY_FIRST_WEEKDAY_COLUMNS = [
  { key: 'Mon', label: 'T2' },
  { key: 'Tue', label: 'T3' },
  { key: 'Wed', label: 'T4' },
  { key: 'Thu', label: 'T5' },
  { key: 'Fri', label: 'T6' },
  { key: 'Sat', label: 'T7' },
  { key: 'Sun', label: 'CN' },
];
const HEATMAP_CELL_TONES = [
  'bg-cyan-100 text-cyan-950 ring-cyan-200 dark:bg-cyan-950/60 dark:text-cyan-100 dark:ring-cyan-800',
  'bg-sky-200 text-sky-950 ring-sky-300 dark:bg-sky-900 dark:text-sky-50 dark:ring-sky-700',
  'bg-teal-300 text-teal-950 ring-teal-400 dark:bg-teal-800 dark:text-teal-50 dark:ring-teal-600',
  'bg-blue-500 text-white ring-blue-600 dark:bg-blue-600 dark:text-white dark:ring-blue-500',
  'bg-blue-700 text-white ring-blue-800 dark:bg-blue-700 dark:text-white dark:ring-blue-500',
  'bg-indigo-900 text-white ring-indigo-950 dark:bg-indigo-800 dark:text-white dark:ring-indigo-500',
];
const MONTH_LABELS = ['Thg 1', 'Thg 2', 'Thg 3', 'Thg 4', 'Thg 5', 'Thg 6', 'Thg 7', 'Thg 8', 'Thg 9', 'Thg 10', 'Thg 11', 'Thg 12'];
const numberFormat = new Intl.NumberFormat('en-US');
type DashboardView = 'operations' | 'comparison' | 'ai-workspace';
type LegacyDashboardView = 'overview' | 'analysis';
type PeakDayCalendarCell = {
  key: string;
  date: string;
  cell: OperationalPeakDayHeatmapCell | null;
  weekMinFlights: number;
  weekMaxFlights: number;
  isMonthHigh: boolean;
};

const DEFAULT_DASHBOARD_ALERT_SETTINGS: DashboardAlertSettings = {
  arrivalBucketFlights: null,
  departureBucketFlights: null,
  adGapFlights: null,
  ctgAbsPct: null,
  paxCoverageMinPct: null,
};

interface DashboardAiWorkspaceSeasonData {
  season: Season;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  effectiveRecords: FlightRecord[];
  dataSource: 'active' | 'local' | 'cache' | 'server';
  syncMeta?: LocalSyncMeta;
  total?: number;
  truncated?: boolean;
}

interface DashboardRouteState {
  seasons: Season[];
  season: Season;
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  operationalSettings: OperationalSettings | null;
  syncMeta: LocalSyncMeta | null;
  dataSource: 'cache';
  windowKey: string;
}

function buildDashboardWindowKey(scope: 'operations' | 'ai-workspace' = 'operations'): string {
  return `dashboard:${scope}:full`;
}

function readInitialDashboardRouteState(targetSeasonId: string | null): DashboardRouteState | null {
  const storeState = useSeasonWorkspaceStore.getState();
  const cachedSeasons = getCachedSeasons() ?? storeState.seasons;
  if (!cachedSeasons || cachedSeasons.length === 0) return null;

  const targetSeason = cachedSeasons.find((item) => item.id === targetSeasonId) ?? cachedSeasons[0];
  if (!targetSeasonId || targetSeasonId !== targetSeason.id) return null;

  const windowKey = buildDashboardWindowKey('operations');
  const cachedWindow = readCachedWorkspaceWindow(storeState.workspaces[targetSeason.id], windowKey);
  if (!cachedWindow) return null;

  return {
    seasons: cachedSeasons,
    season: targetSeason,
    records: cachedWindow.records,
    modifications: cachedWindow.modifications,
    operationalSettings: storeState.operationalSettings,
    syncMeta: cachedWindow.syncMeta,
    dataSource: 'cache',
    windowKey,
  };
}

function normalizeDashboardView(value: DashboardView | LegacyDashboardView | unknown): DashboardView {
  if (value === 'analysis') return 'comparison';
  if (value === 'overview') return 'operations';
  if (value === 'comparison' || value === 'ai-workspace' || value === 'operations') return value;
  return 'operations';
}

function emptyDashboardAiSeasonCatalog(): DashboardAiSeasonCatalog {
  return {
    totalRecords: 0,
    dateRange: { from: '', to: '' },
    months: [],
    weeks: [],
    typeTotals: [],
    topAirlines: [],
    topRoutes: [],
    topCountries: [],
    topAircraft: [],
    truncated: { topRows: false },
  };
}

function buildDashboardAiQueryOnlyContext(input: {
  seasonIds: string[];
  availableSeasonCatalog: Array<{ seasonId: string; seasonCode: string; name: string; dateRange: { from: string; to: string } }>;
  dataScope: ReturnType<typeof resolveDashboardAiDataScopeForPrompt>;
  semanticIntent: ReturnType<typeof inferDashboardAiSemanticIntent>;
}): DashboardAiContext & {
  sourcePolicy: 'supabase-reporting-query-only';
  selectedSeasonCatalog: Array<{ seasonId: string; seasonCode: string; name: string; dateRange: { from: string; to: string } }>;
} {
  const selected = input.availableSeasonCatalog.filter((item) => input.seasonIds.includes(item.seasonId));
  return {
    contextVersion: 2,
    generatedAt: new Date().toISOString(),
    seasonCatalog: emptyDashboardAiSeasonCatalog(),
    availableSeasonCatalog: input.availableSeasonCatalog,
    selectedSeasonCatalog: selected,
    dataScope: input.dataScope,
    semanticIntent: input.semanticIntent,
    dataSourcePolicy: 'supabase-reporting',
    sourcePolicy: 'supabase-reporting-query-only',
    resolvedDataRequest: null,
  };
}

function monthBounds(month: string): { from: string; to: string } {
  const dates = monthDateKeys(month);
  return { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' };
}

function todayLocalIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mondayFirstOffset(date: string): number {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return 0;
  return (parsed.getDay() + 6) % 7;
}

function operationalRecordPax(record: { pax?: number | null }): number {
  return Number.isFinite(record.pax) ? Number(record.pax) : 0;
}

function summarizeOperationalRecords(
  records: OperationalDashboardRecord[],
  keyForRecord: (record: OperationalDashboardRecord) => string
): Array<{ key: string; label: string; flights: number; arrivals: number; departures: number; pax: number; share: number }> {
  const total = Math.max(1, records.length);
  const groups = new Map<string, { key: string; label: string; flights: number; arrivals: number; departures: number; pax: number; share: number }>();
  for (const record of records) {
    const key = keyForRecord(record) || 'Không rõ';
    const current = groups.get(key) ?? { key, label: key, flights: 0, arrivals: 0, departures: 0, pax: 0, share: 0 };
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((row) => ({ ...row, share: row.flights / total }))
    .sort((left, right) => right.flights - left.flights || left.label.localeCompare(right.label));
}

function summarizeFlightRecordsByOperationalDate(records: FlightRecord[]): Array<{ date: string; flights: number; arrivals: number; departures: number; pax: number }> {
  const groups = new Map<string, { date: string; flights: number; arrivals: number; departures: number; pax: number }>();
  for (const record of records) {
    if (record.status === 'deleted') continue;
    const date = getDashboardOperationalDate(record);
    const current = groups.get(date) ?? { date, flights: 0, arrivals: 0, departures: 0, pax: 0 };
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(date, current);
  }
  return [...groups.values()].sort((left, right) => left.date.localeCompare(right.date));
}

type DashboardComparisonTrendRow = {
  key: string;
  label: string;
  value: number;
  flights: number;
  arrivals: number;
  departures: number;
  pax: number;
  day?: string;
};

function metricValueForRecord(record: FlightRecord, metric: DashboardMetric): number {
  return metric === 'pax' ? operationalRecordPax(record) : 1;
}

function summarizeComparisonRecordsByMonth(records: FlightRecord[], metric: DashboardMetric): DashboardComparisonTrendRow[] {
  const groups = new Map<string, DashboardComparisonTrendRow>();
  for (const record of records) {
    const key = getDashboardOperationalDate(record).slice(0, 7);
    if (!key) continue;
    const current = groups.get(key) ?? {
      key,
      label: periodLabel(key, 'mom'),
      value: 0,
      flights: 0,
      arrivals: 0,
      departures: 0,
      pax: 0,
    };
    current.value += metricValueForRecord(record, metric);
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function summarizeComparisonRecordsByDate(records: FlightRecord[], metric: DashboardMetric): DashboardComparisonTrendRow[] {
  const groups = new Map<string, DashboardComparisonTrendRow>();
  for (const record of records) {
    const key = getDashboardOperationalDate(record);
    if (!key) continue;
    const current = groups.get(key) ?? {
      key,
      label: key,
      day: key.slice(8, 10),
      value: 0,
      flights: 0,
      arrivals: 0,
      departures: 0,
      pax: 0,
    };
    current.value += metricValueForRecord(record, metric);
    current.flights += 1;
    current.pax += operationalRecordPax(record);
    if (record.type === 'A') current.arrivals += 1;
    if (record.type === 'D') current.departures += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function resolveAircraftGroupLabel(record: { aircraft?: string | null }, operationalSettings: OperationalSettings | null): string {
  const aircraft = record.aircraft || 'Không rõ';
  const group = operationalSettings?.aircraftGroups.find((item) => item.aircraftTypes.includes(aircraft));
  return group?.name || aircraft;
}

function isConsecutiveSeasonPrompt(prompt: string): boolean {
  return /mùa liên tiếp|mua lien tiep|consecutive seasons|so sánh mùa|so sanh mua/i.test(prompt);
}

function resolveConsecutiveAiSeasonIds(selectedIds: string[], seasons: Season[]): string[] {
  if (selectedIds.length !== 1) return normalizeDashboardAiWorkspaceSeasonIds(selectedIds);
  const selectedId = selectedIds[0];
  const ordered = [...seasons].sort((left, right) => (
    (left.effectiveStart || left.seasonCode).localeCompare(right.effectiveStart || right.seasonCode)
  ));
  const index = ordered.findIndex((item) => item.id === selectedId);
  if (index < 0) return [selectedId];
  const previous = ordered[index - 1]?.id;
  const next = ordered[index + 1]?.id;
  return normalizeDashboardAiWorkspaceSeasonIds(previous ? [previous, selectedId] : next ? [selectedId, next] : [selectedId]);
}

function seasonOverlapsCalendarYear(season: Season, year: number): boolean {
  const start = season.effectiveStart || `${year}-01-01`;
  const end = season.effectiveEnd || `${year}-12-31`;
  return start <= `${year}-12-31` && end >= `${year}-01-01`;
}

function resolveYoySeasonIds(seasons: Season[], records: FlightRecord[], activeSeason: Season | null): string[] {
  const years = new Set<number>();
  for (const record of records) {
    const year = Number(getDashboardOperationalDate(record).slice(0, 4));
    if (Number.isFinite(year)) years.add(year);
  }
  if (years.size === 0 && activeSeason?.effectiveEnd) {
    const year = Number(activeSeason.effectiveEnd.slice(0, 4));
    if (Number.isFinite(year)) years.add(year);
  }
  const latestYear = Math.max(...Array.from(years));
  if (!Number.isFinite(latestYear)) return [];
  const targetYears = [latestYear, latestYear - 1];
  return normalizeDashboardAiWorkspaceSeasonIds(seasons
    .filter((item) => targetYears.some((year) => seasonOverlapsCalendarYear(item, year)))
    .map((item) => item.id));
}

type AiWorkspaceTableRow = Record<string, string | number | boolean | null>;
const DASHBOARD_AI_NOTEBOOK_MAX_CELLS = 20;
const DASHBOARD_AI_NOTEBOOK_MAX_BLOCKS = 12;
const DASHBOARD_AI_NOTEBOOK_BLOCK_TYPES = new Set(['kpi', 'table', 'chart', 'insight-list', 'data-quality-notes', 'rich-markdown', 'html-preview']);
const DASHBOARD_AI_NOTEBOOK_CHART_TYPES = new Set(['bar-ranking', 'line-trend', 'waterfall', 'heatmap', 'kpi-strip', 'stacked-bar', 'area', 'pie']);
const DASHBOARD_AI_NOTEBOOK_TABLE_TEMPLATES = new Set([
  'season-summary',
  'comparison-drivers',
  'monthly-trend',
  'airline-ranking',
  'route-country-ranking',
  'peak-hour',
  'multi-season-summary',
  'custom-table',
]);

function buildDashboardAiNotebook(input: {
  seasonIds: string[];
  title?: string;
  cells?: DashboardAiNotebookCell[];
  now?: number;
}): DashboardAiNotebook {
  const now = input.now ?? Date.now();
  return {
    id: `ai-notebook-${now}`,
    title: input.title ?? 'Rich Chat AI',
    seasonIds: normalizeDashboardAiWorkspaceSeasonIds(input.seasonIds),
    cells: (input.cells ?? []).slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS),
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeNotebookText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '').replace(/<\/?[^>]+>/g, '').trim().slice(0, 4000) || fallback;
}

function sanitizeStoredHtmlPreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '') 
    .replace(/<embed[\s\S]*?>/gi, '') 
    .replace(/<form[\s\S]*?<\/form>/gi, '') 
    .replace(/<link[\s\S]*?>/gi, '') 
    .replace(/<meta[^>]*(?:http-equiv|refresh)[^>]*>/gi, '') 
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '') 
    .replace(/\s+(?:src|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '') 
    .replace(/\s+(?:src|href)\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>]+)/gi, '') 
    .replace(/url\(\s*https?:\/\/[^)]*\)/gi, 'none') 
    .trim()
    .slice(0, 12000);
}

function sanitizeStoredNotebookBlocks(value: unknown): DashboardAiWorkspaceBlock[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((block): block is DashboardAiWorkspaceBlock => {
      if (!block || typeof block !== 'object') return false;
      const candidate = block as DashboardAiWorkspaceBlock;
      if (!DASHBOARD_AI_NOTEBOOK_BLOCK_TYPES.has(candidate.type)) return false;
      if (candidate.chart && !DASHBOARD_AI_NOTEBOOK_CHART_TYPES.has(candidate.chart.chartType)) return false;
      if (candidate.table && !DASHBOARD_AI_NOTEBOOK_TABLE_TEMPLATES.has(candidate.table.templateId ?? 'custom-table')) return false;
      return true;
    })
    .slice(0, DASHBOARD_AI_NOTEBOOK_MAX_BLOCKS)
    .map((block) => ({
      ...block,
      title: sanitizeNotebookText(block.title, 'AI block'),
      markdown: block.markdown
        ? { content: sanitizeNotebookText(block.markdown.content) }
        : undefined,
      htmlPreview: block.htmlPreview
        ? {
            html: sanitizeStoredHtmlPreview(block.htmlPreview.html),
            sanitized: block.htmlPreview.sanitized === true,
            rejectedReason: sanitizeNotebookText(block.htmlPreview.rejectedReason),
          }
        : undefined,
      insights: Array.isArray(block.insights)
        ? block.insights.map((insight) => sanitizeNotebookText(insight)).filter(Boolean).slice(0, 8)
        : undefined,
    }));
}

function sanitizeStoredRunEvents(value: unknown): DashboardAiRunEvent[] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set([
    'init',
    'user',
    'partial_assistant',
    'tool_call_start',
    'tool_call_end',
    'permission_request',
    'usage',
    'compaction',
    'result',
    'error',
    'skill_invoked',
    'skill_completed',
  ]);
  return value
    .filter((event): event is Record<string, unknown> => Boolean(event && typeof event === 'object' && !Array.isArray(event)))
    .map((event, index): DashboardAiRunEvent | null => {
      const type = typeof event.type === 'string' && allowedTypes.has(event.type) ? event.type as DashboardAiRunEvent['type'] : null;
      if (!type) return null;
      const runId = sanitizeNotebookText(event.runId, `ai-run-${index}`);
      const createdAt = Number(event.createdAt ?? Date.now());
      return {
        id: sanitizeNotebookText(event.id, `${runId}-${type}-${index}`),
        runId,
        type,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        ...(typeof event.prompt === 'string' ? { prompt: sanitizeNotebookText(event.prompt) } : {}),
        ...(typeof event.message === 'string' ? { message: sanitizeNotebookText(event.message) } : {}),
        ...(typeof event.reason === 'string' ? { reason: sanitizeNotebookText(event.reason) } : {}),
        ...(typeof event.error === 'string' ? { error: sanitizeNotebookText(event.error) } : {}),
      };
    })
    .filter((event): event is DashboardAiRunEvent => event != null)
    .slice(-40);
}

function normalizeStoredAiNotebook(value: unknown, fallback: DashboardAiNotebook): DashboardAiNotebook {
  if (!value || typeof value !== 'object') return fallback;
  const parsed = value as Partial<DashboardAiNotebook>;
  if (!Array.isArray(parsed.cells)) return fallback;
  const cells = parsed.cells
    .filter((cell): cell is DashboardAiNotebookCell => Boolean(cell && typeof cell === 'object'))
    .map((cell, index) => {
      const queryResults = capDashboardAiNotebookQueryResults(
        resolveDashboardAiQueryResults((cell as { queryResults?: unknown }).queryResults),
        { maxResults: 2, maxRowsPerResult: 100 }
      );
      const normalizedCell: DashboardAiNotebookCell = {
        id: sanitizeNotebookText(cell.id, `cell-${index}`),
        prompt: sanitizeNotebookText(cell.prompt, 'AI prompt'),
        assistantText: sanitizeNotebookText(cell.assistantText),
        blocks: sanitizeStoredNotebookBlocks(cell.blocks),
        toolTraceSummary: Array.isArray(cell.toolTraceSummary) ? cell.toolTraceSummary.slice(0, 6) : [],
        exportAction: null,
        createdAt: Number.isFinite(cell.createdAt) ? cell.createdAt : Date.now(),
        modelId: sanitizeNotebookText(cell.modelId),
        runEvents: sanitizeStoredRunEvents((cell as { runEvents?: unknown }).runEvents),
        ...(queryResults.length > 0 ? { queryResults } : {}),
        ...(Array.isArray(cell.resultProfiles) ? { resultProfiles: cell.resultProfiles.slice(0, 2) } : {}),
        ...(cell.answerVerification && typeof cell.answerVerification === 'object' ? { answerVerification: cell.answerVerification } : {}),
      };
      return {
        ...normalizedCell,
        activeArtifact: queryResults.length > 0 || normalizedCell.blocks.length > 0
          ? buildDashboardAiActiveArtifactFromCell(normalizedCell, { sourceCellIndex: index + 1 })
          : null,
      };
    })
    .slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS);
  return {
    ...fallback,
    ...parsed,
    id: sanitizeNotebookText(parsed.id, fallback.id),
    title: sanitizeNotebookText(parsed.title, fallback.title),
    seasonIds: normalizeDashboardAiWorkspaceSeasonIds(Array.isArray(parsed.seasonIds) ? parsed.seasonIds : fallback.seasonIds),
    cells,
    updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : fallback.updatedAt,
  };
}

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
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

function periodKey(record: FlightRecord, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  const operationalDate = getDashboardOperationalDate(record);
  if (mode === 'wow') return isoWeekKey(operationalDate);
  if (mode === 'yoy' && granularity === 'year') return operationalDate.slice(0, 4);
  return operationalDate.slice(0, 7);
}

function periodLabel(key: string, mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): string {
  if (mode === 'yoy' && granularity === 'year') return key || 'Không có kỳ';
  if (mode === 'wow') {
    const match = /^(\d{4})-W(\d{2})$/.exec(key);
    return match ? `Tuần ${Number(match[2])} ${match[1]}` : key;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key || 'Không có kỳ';
  return `${MONTH_LABELS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

function monthDateKeys(month: string): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

function listPeriods(records: FlightRecord[], mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): Array<{ key: string; label: string }> {
  return listDashboardPeriods(records, mode, granularity);
}

function resolveDefaultPreviousPeriod(
  periods: Array<{ key: string }>,
  currentPeriod: string,
  mode: DashboardComparisonMode,
  granularity: DashboardComparisonGranularity
): string {
  if (mode === 'yoy') {
    const match = granularity === 'year'
      ? /^(\d{4})$/.exec(currentPeriod)
      : /^(\d{4})-(\d{2})$/.exec(currentPeriod);
    if (match) {
      const previousKey = granularity === 'year'
        ? String(Number(match[1]) - 1)
        : `${Number(match[1]) - 1}-${match[2]}`;
      if (periods.some((period) => period.key === previousKey)) return previousKey;
    }
  }
  const currentIndex = periods.findIndex((period) => period.key === currentPeriod);
  return currentIndex > 0 ? periods[currentIndex - 1]?.key ?? '' : '';
}

function formatValue(value: number): string {
  return numberFormat.format(Math.round(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function heatmapCellTone(flights: number | undefined, maxFlights: number): string {
  if (!flights || flights <= 0 || maxFlights <= 0) {
    return 'bg-surface-container-low text-on-surface-variant ring-outline-variant';
  }
  const ratio = Math.min(1, flights / maxFlights);
  const toneIndex = Math.min(HEATMAP_CELL_TONES.length - 1, Math.max(0, Math.ceil(ratio * HEATMAP_CELL_TONES.length) - 1));
  return HEATMAP_CELL_TONES[toneIndex];
}

function peakDayWeekTone(flights: number, weekMinFlights: number, weekMaxFlights: number): string {
  if (flights <= 0) return 'bg-surface-container-low text-on-surface-variant ring-outline-variant';
  if (weekMaxFlights <= weekMinFlights) return heatmapCellTone(flights, weekMaxFlights || flights);
  const ratio = Math.min(1, Math.max(0, (flights - weekMinFlights) / (weekMaxFlights - weekMinFlights)));
  const toneIndex = Math.min(HEATMAP_CELL_TONES.length - 1, Math.round(ratio * (HEATMAP_CELL_TONES.length - 1)));
  return HEATMAP_CELL_TONES[toneIndex];
}

function trendBarHeight(value: number, maxValue: number): string {
  if (value <= 0 || maxValue <= 0) return '0%';
  return `${Math.max(4, value / maxValue * 100)}%`;
}

function formatDelta(value: number): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${formatValue(value)}`;
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function formatPointPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;
}

function parseScheduleMinutes(schedule: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(schedule ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function hourBucket(schedule: string, timeBasis: DashboardTimeBasis): string {
  const minutes = parseScheduleMinutes(schedule);
  if (minutes == null) return 'Không rõ';
  const shifted = timeBasis === 'utc' ? (minutes - 7 * 60 + 24 * 60) % (24 * 60) : minutes;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:00`;
}

function dimensionValue(
  record: FlightRecord,
  dimension: DashboardDimension,
  timeBasis: DashboardTimeBasis,
  routeCountries?: RouteCountryMapping[]
): string {
  if (dimension === 'airline') return record.airline || 'Không rõ';
  if (dimension === 'route') return record.route || 'Không rõ';
  if (dimension === 'country') return resolveCountryForRoute(record.route, routeCountries);
  if (dimension === 'aircraft') return record.aircraft || 'Không rõ';
  if (dimension === 'type') return record.type;
  if (dimension === 'dayOfWeek') {
    const parsed = parseIsoDate(getDashboardOperationalDate(record));
    return parsed ? WEEKDAY_KEYS[parsed.getUTCDay()] ?? 'Không rõ' : 'Không rõ';
  }
  if (dimension === 'hourBucket') return hourBucket(record.schedule, timeBasis);
  return record.flightNumber || record.rawFlightNumber || 'Không rõ';
}

function DashboardContent({ routeBase = '/dashboard' }: { routeBase?: '/' | '/dashboard' }) {
  const router = useRouter();
  const dashboardRoute = routeBase;
  const searchParams = useCachedRouteSearchParams();
  const { notifyExportCompleted } = useExportNotifications();
  const targetSeasonId = searchParams.get('season');
  const initialDashboardRouteState = readInitialDashboardRouteState(targetSeasonId);

  const [seasons, setSeasons] = useState<Season[]>(() => initialDashboardRouteState?.seasons ?? []);
  const [season, setSeason] = useState<Season | null>(() => initialDashboardRouteState?.season ?? null);
  const [records, setRecords] = useState<FlightRecord[]>(() => initialDashboardRouteState?.records ?? []);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(
    () => initialDashboardRouteState?.modifications ?? new Map()
  );
  const [operationalSettings, setOperationalSettings] = useState<OperationalSettings | null>(
    () => initialDashboardRouteState?.operationalSettings ?? null
  );
  const [loading, setLoading] = useState(() => !initialDashboardRouteState);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading dashboard...', 10, 'Preparing analysis')
  );
  const [error, setError] = useState<string | null>(null);
  const [fetchUpdateNotice, setFetchUpdateNotice] = useState<{ title: string; message: string; tone: 'warning' | 'error' } | null>(null);
  const [dataSource, setDataSource] = useState<'local' | 'cache' | 'server' | null>(
    () => initialDashboardRouteState?.dataSource ?? null
  );
  const [syncMeta, setSyncMeta] = useState<LocalSyncMeta | null>(() => initialDashboardRouteState?.syncMeta ?? null);

  const [dashboardViewState, setDashboardView] = useSessionState<DashboardView>('dashboard:view', 'operations');
  const dashboardView = normalizeDashboardView(dashboardViewState);
  const [metric, setMetric] = useSessionState<DashboardMetric>('dashboard:metric', 'flights');
  const [comparisonMode, setComparisonMode] = useSessionState<DashboardComparisonMode>('dashboard:comparisonMode', 'mom');
  const [comparisonGranularity, setComparisonGranularity] = useSessionState<DashboardComparisonGranularity>('dashboard:comparisonGranularity', 'month');
  const [typeFilter, setTypeFilter] = useSessionState<DashboardTypeFilter>('dashboard:typeFilter', 'all');
  const [timeBasis, setTimeBasis] = useSessionState<DashboardTimeBasis>('dashboard:timeBasis', 'local');
  const [operationalDate, setOperationalDate] = useSessionState('dashboard:operationalDate', '');
  const [operationalBucketSize, setOperationalBucketSize] = useSessionState<OperationalDashboardBucketSize>('dashboard:operationalBucketSize', 60);
  const [operationalPeakDayMonth, setOperationalPeakDayMonth] = useSessionState('dashboard:operationalPeakDayMonth', '');
  const [operationalPeakHourTypeFilter, setOperationalPeakHourTypeFilter] = useSessionState<DashboardTypeFilter>('dashboard:operationalPeakHourTypeFilter', 'all');
  const [dimension, setDimension] = useSessionState<DashboardDimension>('dashboard:dimension', 'airline');
  const [currentPeriod, setCurrentPeriod] = useSessionState('dashboard:currentPeriod', '');
  const [previousPeriod, setPreviousPeriod] = useSessionState('dashboard:previousPeriod', '');
  const [comparisonTrendMonth, setComparisonTrendMonth] = useSessionState('dashboard:comparisonTrendMonth', '');
  const [overviewMonthFrom] = useSessionState('dashboard:overviewMonthFrom', '');
  const [overviewMonthTo] = useSessionState('dashboard:overviewMonthTo', '');
  const [overviewAirline] = useSessionState('dashboard:overviewAirline', 'all');
  const [overviewCountry] = useSessionState('dashboard:overviewCountry', 'all');
  const [overviewRoute] = useSessionState('dashboard:overviewRoute', 'all');
  const [overviewPeakHourMonth] = useSessionState('dashboard:overviewPeakHourMonth', 'all');
  const [selectedDriverKey, setSelectedDriverKey] = useSessionState<string | null>('dashboard:selectedDriverKey', null);
  const [selectedAiModelId, setSelectedAiModelId] = useSessionState('dashboard:selectedAiModelId', '');
  const [aiNotebook, setAiNotebook] = useState<DashboardAiNotebook | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiLoadingMessage, setAiLoadingMessage] = useState('AI đang phân tích dữ liệu...');
  const [aiLoadingStep, setAiLoadingStep] = useState<AiNotebookLoadingStep>('context');
  const [aiLoadingStartedAt, setAiLoadingStartedAt] = useState<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selectedAiSeasonIds, setSelectedAiSeasonIds] = useState<string[]>([]);
  const [aiWorkspaceSeasonData, setAiWorkspaceSeasonData] = useState<Record<string, DashboardAiWorkspaceSeasonData>>({});
  const [aiWorkspaceDataError, setAiWorkspaceDataError] = useState<string | null>(null);
  const [lastAiPrompt, setLastAiPrompt] = useState('');
  const [pinnedAiContextCellId, setPinnedAiContextCellId] = useState<string | null>(null);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const dashboardScrollRef = useRef<HTMLElement | null>(null);
  const loadedWindowKeyRef = useRef<string | null>(initialDashboardRouteState?.windowKey ?? null);
  const fetchServerDataRequestRef = useRef(0);
  const latestRouteWindowRef = useRef<{ seasonId: string | null; windowKey: string }>({
    seasonId: initialDashboardRouteState?.season.id ?? null,
    windowKey: initialDashboardRouteState?.windowKey ?? '',
  });
  useSessionScrollRestoration('dashboard:scroll', dashboardScrollRef);
  const routeCountries = operationalSettings?.routeCountries;
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, syncNow } = useSeasonSync(syncSeasonId, 'dashboard');
  const [fetchingServerData, setFetchingServerData] = useState(false);
  const syncInProgress = syncStatus.status === 'syncing';
  const syncProgress = syncStatus.progress ?? (syncStatus.status === 'failed' ? syncStatus.message : null);
  const syncPendingCount = getSeasonSyncPendingCount(syncStatus, syncMeta?.pendingCount ?? 0);
  const fetchProgress = fetchingServerData ? 'Fetching server data' : syncStatus.message;

  useEffect(() => {
    latestRouteWindowRef.current = {
      seasonId: season?.id ?? null,
      windowKey: buildDashboardWindowKey('operations'),
    };
  }, [season?.id]);

  useEffect(() => {
    if (dashboardViewState !== dashboardView) setDashboardView(dashboardView);
  }, [dashboardView, dashboardViewState, setDashboardView]);

  const tryApplyCachedDashboardRouteWindow = useCallback((): boolean => {
    const cachedState = readInitialDashboardRouteState(targetSeasonId);
    if (!cachedState) return false;

    setError(null);
    setSeasons(cachedState.seasons);
    setSeason(cachedState.season);
    setRecords(cachedState.records);
    setModifications(cachedState.modifications);
    if (cachedState.operationalSettings) setOperationalSettings(cachedState.operationalSettings);
    setDataSource(cachedState.dataSource);
    setSyncMeta(cachedState.syncMeta);
    loadedWindowKeyRef.current = cachedState.windowKey;
    setLoading(false);
    return true;
  }, [targetSeasonId]);

  const refreshDashboardWindow = useCallback(async () => {
    if (!season?.id) return null;
    const windowKey = buildDashboardWindowKey('operations');
    const snapshot = readWorkspaceWindowSnapshot(useSeasonWorkspaceStore.getState().workspaces[season.id], windowKey);
    if (!snapshot) return null;
    setRecords(snapshot.records);
    setModifications(snapshot.modifications);
    setDataSource('cache');
    setSyncMeta(snapshot.syncMeta);
    setCachedSeasonData(season.id, {
      rows: [],
      records: snapshot.records,
      modifications: snapshot.modifications,
      seasonDataVersion: season.dataVersion,
    });
    loadedWindowKeyRef.current = windowKey;
    return snapshot;
  }, [season]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'dashboard',
    onRefresh: async () => {
      await refreshDashboardWindow();
    },
  });

  const handleSync = useCallback(async () => {
    if (!syncSeasonId || syncInProgress) return;
    setFetchUpdateNotice(null);
    try {
      const result = await syncNow();
      if (result.status !== 'synced') {
        setFetchUpdateNotice({
          title: 'Save Failed',
          message: result.message ?? 'Save failed.',
          tone: 'error',
        });
      }
    } catch (err) {
      setFetchUpdateNotice({
        title: 'Save Failed',
        message: (err as Error).message,
        tone: 'error',
      });
    }
  }, [syncInProgress, syncNow, syncSeasonId]);

  const fetchServerData = useCallback(async () => {
    if (!season || fetchingServerData || syncInProgress) return;
    const overviewWindowKey = buildDashboardWindowKey('operations');
    const requestId = ++fetchServerDataRequestRef.current;
    const requestedSeasonId = season.id;
    const hasRouteDataLoaded = loadedWindowKeyRef.current === overviewWindowKey;
    setFetchingServerData(true);
    if (!hasRouteDataLoaded) setError(null);
    setFetchUpdateNotice(null);
    setLoadProgress(buildLoadProgress('Loading server workspace', 35, season.seasonCode));
    try {
      const serverWindow = await loadSeasonWorkspaceWindow({
        seasonId: season.id,
        resourceType: 'schedule',
        limit: 100000,
      });
      if (!serverWindow) throw new Error('Server dashboard window is unavailable.');
      if (
        fetchServerDataRequestRef.current !== requestId ||
        latestRouteWindowRef.current.seasonId !== requestedSeasonId ||
        latestRouteWindowRef.current.windowKey !== overviewWindowKey
      ) {
        return;
      }
      loadedWindowKeyRef.current = overviewWindowKey;
      setLoadProgress(buildLoadProgress('Preparing dashboard', 80, `${serverWindow.records.length} records`));
      setRecords(serverWindow.records);
      setModifications(serverWindow.modifications);
      setDataSource('server');
      setSyncMeta(serverWindow.syncMeta);
      setCachedSeasonData(season.id, {
        rows: [],
        records: serverWindow.records,
        modifications: serverWindow.modifications,
        seasonDataVersion: season.dataVersion,
      });
      useSeasonWorkspaceStore.getState().replaceSeasonWindow({
        seasonId: season.id,
        season,
        rows: [],
        records: serverWindow.records,
        modifications: serverWindow.modifications,
        syncMeta: serverWindow.syncMeta,
        windowKey: overviewWindowKey,
      });
      publishSeasonWorkspaceChanged({
        seasonId: season.id,
        localRevision: serverWindow.syncMeta.localRevision,
        source: 'server-window',
        syncMeta: serverWindow.syncMeta,
      });
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Could not fetch dashboard data from the server.';
      if (!hasRouteDataLoaded) setError(message);
      setFetchUpdateNotice({ title: 'Fetch data failed', message, tone: 'error' });
    } finally {
      setFetchingServerData(false);
    }
  }, [fetchingServerData, season, syncInProgress]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await getOperationalSettings();
        if (!cancelled) {
          setOperationalSettings(settings);
          useSeasonWorkspaceStore.getState().setOperationalSettings(settings);
        }
      } catch {
        if (!cancelled) setOperationalSettings(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboardData() {
      if (tryApplyCachedDashboardRouteWindow()) return;
      setLoading(true);
      setError(null);
      setLoadProgress(buildLoadProgress('Loading seasons', 15, 'Preparing dashboard'));
      try {
        const cachedSeasons = getCachedSeasons();
        const nextSeasons = cachedSeasons ?? await getSeasons();
        if (cancelled) return;
        if (!cachedSeasons) setCachedSeasons(nextSeasons);
        setSeasons(nextSeasons);
        useSeasonWorkspaceStore.getState().setSeasons(nextSeasons);

        if (nextSeasons.length === 0) {
          loadedWindowKeyRef.current = null;
          setSeason(null);
          setRecords([]);
          setModifications(new Map());
          setDataSource(null);
          setSyncMeta(null);
          return;
        }

        const targetSeason = nextSeasons.find((item) => item.id === targetSeasonId) ?? nextSeasons[0];
        if (!targetSeasonId || targetSeasonId !== targetSeason.id) {
          router.replace(`${dashboardRoute}?season=${targetSeason.id}`);
        }

        setSeason(targetSeason);
        const overviewWindowKey = buildDashboardWindowKey('operations');
        const cachedWindow = readCachedWorkspaceWindow(
          useSeasonWorkspaceStore.getState().workspaces[targetSeason.id],
          overviewWindowKey
        );
        if (cachedWindow) {
          loadedWindowKeyRef.current = overviewWindowKey;
          setRecords(cachedWindow.records);
          setModifications(cachedWindow.modifications);
          setDataSource('local');
          setSyncMeta(cachedWindow.syncMeta);
          return;
        }

        setLoadProgress(buildLoadProgress('Loading server workspace', 35, targetSeason.seasonCode));
        const serverWindow = await loadSeasonWorkspaceWindow({
          seasonId: targetSeason.id,
          resourceType: 'schedule',
          limit: 100000,
        }).catch((error) => {
          if (SERVER_AUTHORITATIVE_MODE) throw error;
          console.warn('Server dashboard window unavailable, falling back to native SQLite', error);
          return null;
        });
        if (cancelled) return;
        if (serverWindow) {
          loadedWindowKeyRef.current = overviewWindowKey;
          setLoadProgress(buildLoadProgress(
            'Preparing dashboard',
            80,
            `${serverWindow.records.length} records`
          ));
          setSeason(targetSeason);
          setRecords(serverWindow.records);
          setModifications(serverWindow.modifications);
          setDataSource('server');
          setSyncMeta(serverWindow.syncMeta);
          setCachedSeasonData(targetSeason.id, {
            rows: [],
            records: serverWindow.records,
            modifications: serverWindow.modifications,
            seasonDataVersion: targetSeason.dataVersion,
          });
          useSeasonWorkspaceStore.getState().replaceSeasonWindow({
            seasonId: targetSeason.id,
            season: targetSeason,
            rows: [],
            records: serverWindow.records,
            modifications: serverWindow.modifications,
            syncMeta: serverWindow.syncMeta,
            windowKey: overviewWindowKey,
          });
          publishSeasonWorkspaceChanged({
            seasonId: targetSeason.id,
            localRevision: serverWindow.syncMeta.localRevision,
            source: 'server-window',
            syncMeta: serverWindow.syncMeta,
          });
          setFetchUpdateNotice(null);
          return;
        }

        setLoadProgress(buildLoadProgress('Checking local season baseline', 40, targetSeason.seasonCode));
        await ensureNativeSeasonBaseline(targetSeason);
        if (cancelled) return;
        setLoadProgress(buildLoadProgress('Querying native SQLite fallback', 50, targetSeason.seasonCode));
        const result = await queryNativeScheduleWindow({
          seasonId: targetSeason.id,
          limit: 100000,
        });
        if (cancelled) return;
        if (!result) throw new Error('Native dashboard query is unavailable.');
        const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
        setLoadProgress(buildLoadProgress(
          'Preparing dashboard',
          80,
          `${result.records.length} records`
        ));
        setSeason(targetSeason);
        setRecords(result.records);
        setModifications(nextModifications);
        setDataSource('local');
        setSyncMeta(result.syncMeta);
        setCachedSeasonData(targetSeason.id, {
          rows: [],
          records: result.records,
          modifications: nextModifications,
          seasonDataVersion: targetSeason.dataVersion,
        });
        useSeasonWorkspaceStore.getState().replaceSeasonWindow({
          seasonId: targetSeason.id,
          season: targetSeason,
          rows: [],
          records: result.records,
          modifications: nextModifications,
          syncMeta: result.syncMeta,
          windowKey: overviewWindowKey,
        });
        loadedWindowKeyRef.current = overviewWindowKey;
        setFetchUpdateNotice(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadDashboardData();
    return () => {
      cancelled = true;
    };
  }, [dashboardRoute, router, targetSeasonId, tryApplyCachedDashboardRouteWindow]);

  const effectiveRecords = useMemo(() => (
    buildEffectiveDashboardRecords(records, modifications)
  ), [records, modifications]);

  useEffect(() => {
    if (!season) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setAiWorkspaceSeasonData((current) => ({
        ...current,
        [season.id]: {
          season,
          records,
          modifications,
          effectiveRecords,
          dataSource: 'active',
          syncMeta: syncMeta ?? undefined,
          total: records.length,
          truncated: false,
        },
      }));
      setSelectedAiSeasonIds((current) => {
        const valid = new Set(seasons.map((item) => item.id));
        const normalized = normalizeDashboardAiWorkspaceSeasonIds([
          season.id,
          ...current.filter((id) => id !== season.id && valid.has(id)),
        ]);
        return normalized.length > 0 ? normalized : [season.id];
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [effectiveRecords, modifications, records, season, seasons, syncMeta]);

  const loadAiWorkspaceSeason = useCallback(async (targetSeason: Season): Promise<DashboardAiWorkspaceSeasonData> => {
    const result = await queryNativeScheduleWindow({
      seasonId: targetSeason.id,
      limit: 100000,
    });
    if (!result) throw new Error('Native dashboard schedule query is unavailable.');
    const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: targetSeason.id,
      season: targetSeason,
      rows: [],
      records: result.records,
      modifications: nextModifications,
      syncMeta: result.syncMeta,
      windowKey: buildDashboardWindowKey('ai-workspace'),
    });
    return {
      season: targetSeason,
      records: result.records,
      modifications: nextModifications,
      effectiveRecords: buildEffectiveDashboardRecords(result.records, nextModifications),
      dataSource: 'local',
      syncMeta: result.syncMeta,
      total: result.total,
      truncated: result.truncated,
    };
  }, []);

  const yoySeasonIds = useMemo(() => (
    comparisonMode === 'yoy' ? resolveYoySeasonIds(seasons, effectiveRecords, season) : []
  ), [comparisonMode, effectiveRecords, season, seasons]);

  const requestedSeasonDataIds = useMemo(() => (
    normalizeDashboardAiWorkspaceSeasonIds([
      ...selectedAiSeasonIds,
      ...yoySeasonIds,
    ])
  ), [selectedAiSeasonIds, yoySeasonIds]);

  useEffect(() => {
    let cancelled = false;
    const selected = requestedSeasonDataIds
      .map((seasonId) => seasons.find((item) => item.id === seasonId))
      .filter((item): item is Season => Boolean(item));
    const missing = selected.filter((item) => !aiWorkspaceSeasonData[item.id]);
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (item) => [item.id, await loadAiWorkspaceSeason(item)] as const))
      .then((entries) => {
        if (cancelled) return;
        setAiWorkspaceDataError(null);
        setAiWorkspaceSeasonData((current) => {
          const next = { ...current };
          for (const [seasonId, data] of entries) next[seasonId] = data;
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) setAiWorkspaceDataError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [aiWorkspaceSeasonData, loadAiWorkspaceSeason, requestedSeasonDataIds, seasons]);

  const dashboardRecords = useMemo(() => effectiveRecords, [effectiveRecords]);

  const analysisSeasonData = useMemo(() => (
    yoySeasonIds
      .map((seasonId) => aiWorkspaceSeasonData[seasonId])
      .filter((item): item is DashboardAiWorkspaceSeasonData => Boolean(item))
  ), [aiWorkspaceSeasonData, yoySeasonIds]);

  const analysisRecords = useMemo(() => {
    if (comparisonMode !== 'yoy') return effectiveRecords;
    const recordsById = new Map<string, FlightRecord>();
    const sourceRecords = analysisSeasonData.length > 0
      ? analysisSeasonData.flatMap((item) => item.effectiveRecords)
      : effectiveRecords;
    for (const record of sourceRecords) recordsById.set(record.id, record);
    return [...recordsById.values()];
  }, [analysisSeasonData, comparisonMode, effectiveRecords]);

  const overviewMonthOptions = useMemo(() => (
    Array.from(new Set(
      dashboardRecords
        .filter((record) => record.status !== 'deleted')
        .map((record) => getDashboardOperationalDate(record).slice(0, 7))
        .filter(Boolean)
    ))
      .sort()
      .map((key) => ({ key, label: periodLabel(key, 'mom') }))
  ), [dashboardRecords]);

  const defaultOverviewMonthFrom = overviewMonthOptions[0]?.key ?? '';
  const defaultOverviewMonthTo = overviewMonthOptions[overviewMonthOptions.length - 1]?.key ?? '';
  const activeOverviewMonthFrom = overviewMonthOptions.some((month) => month.key === overviewMonthFrom)
    ? overviewMonthFrom
    : defaultOverviewMonthFrom;
  const activeOverviewMonthTo = overviewMonthOptions.some((month) => month.key === overviewMonthTo)
    ? overviewMonthTo
    : defaultOverviewMonthTo;
  const overviewMonthStart = activeOverviewMonthFrom && activeOverviewMonthTo && activeOverviewMonthFrom > activeOverviewMonthTo
    ? activeOverviewMonthTo
    : activeOverviewMonthFrom;
  const overviewMonthEnd = activeOverviewMonthFrom && activeOverviewMonthTo && activeOverviewMonthFrom > activeOverviewMonthTo
    ? activeOverviewMonthFrom
    : activeOverviewMonthTo;
  const overviewPeakHourMonthForBuild = overviewPeakHourMonth === 'all' || overviewMonthOptions.some((month) => month.key === overviewPeakHourMonth)
    ? overviewPeakHourMonth
    : 'all';

  const overview = useMemo(() => (
    buildDashboardOverview({
      records: dashboardRecords,
      typeFilter,
      timeBasis,
      monthFrom: overviewMonthStart,
      monthTo: overviewMonthEnd,
      peakHourMonth: overviewPeakHourMonthForBuild === 'all' ? undefined : overviewPeakHourMonthForBuild,
      airline: overviewAirline,
      country: overviewCountry,
      route: overviewRoute,
      routeCountries,
    })
  ), [dashboardRecords, overviewAirline, overviewCountry, overviewMonthEnd, overviewMonthStart, overviewPeakHourMonthForBuild, overviewRoute, routeCountries, timeBasis, typeFilter]);

  const dashboardAlertSettings = operationalSettings?.dashboardAlerts ?? DEFAULT_DASHBOARD_ALERT_SETTINGS;
  const todayOperationalDate = todayLocalIso();
  const operationalDateOptions = useMemo(() => (
    Array.from(new Set(
      [
        ...dashboardRecords
        .filter((record) => record.status !== 'deleted')
        .map((record) => getDashboardOperationalDate(record))
          .filter(Boolean),
        todayOperationalDate,
      ]
    ))
      .sort()
      .map((date) => ({ key: date, label: date }))
  ), [dashboardRecords, todayOperationalDate]);
  const operationalMonthOptions = useMemo(() => (
    Array.from(new Set(
      dashboardRecords
        .filter((record) => record.status !== 'deleted')
        .map((record) => getDashboardOperationalDate(record).slice(0, 7))
        .filter(Boolean)
    ))
      .sort()
      .map((month) => ({ key: month, label: periodLabel(month, 'mom') }))
  ), [dashboardRecords]);
  const defaultOperationalDate = todayOperationalDate;
  const activeOperationalDate = operationalDateOptions.some((item) => item.key === operationalDate)
    ? operationalDate
    : defaultOperationalDate;
  const activeOperationalMonth = activeOperationalDate.slice(0, 7);
  const activePeakDayMonth = operationalMonthOptions.some((item) => item.key === operationalPeakDayMonth)
    ? operationalPeakDayMonth
    : operationalMonthOptions.some((item) => item.key === activeOperationalMonth)
      ? activeOperationalMonth
      : operationalMonthOptions.at(-1)?.key ?? activeOperationalMonth;
  const peakDayMonthBounds = monthBounds(activePeakDayMonth);
  const operationalDashboard = useMemo(() => (
    buildOperationalDashboard({
      records: dashboardRecords,
      operationalDate: activeOperationalDate,
      bucketSizeMinutes: operationalBucketSize,
      timeBasis,
      settings: dashboardAlertSettings,
    })
  ), [activeOperationalDate, dashboardAlertSettings, dashboardRecords, operationalBucketSize, timeBasis]);
  const peakDayHeatmap = useMemo(() => (
    buildPeakDayHeatmap({
      records: dashboardRecords,
      dateFrom: peakDayMonthBounds.from,
      dateTo: peakDayMonthBounds.to,
      settings: dashboardAlertSettings,
    })
  ), [dashboardAlertSettings, dashboardRecords, peakDayMonthBounds.from, peakDayMonthBounds.to]);
  const peakDayCellByDate = useMemo(() => new Map(
    peakDayHeatmap.map((cell) => [cell.operationalDate, cell])
  ), [peakDayHeatmap]);
  const peakDayCalendarCells = useMemo(() => {
    const dates = monthDateKeys(activePeakDayMonth);
    const leadingBlankCount = dates[0] ? mondayFirstOffset(dates[0]) : 0;
    const monthMaxFlights = Math.max(0, ...dates.map((date) => peakDayCellByDate.get(date)?.totalFlights ?? 0));
    const leadingBlanks: PeakDayCalendarCell[] = Array.from({ length: leadingBlankCount }, (_, index) => ({
      key: `blank-start-${index}`,
      date: '',
      cell: null,
      weekMinFlights: 0,
      weekMaxFlights: 0,
      isMonthHigh: false,
    }));
    const dateCells: PeakDayCalendarCell[] = dates.map((date) => {
      const cell = peakDayCellByDate.get(date) ?? null;
      return {
        key: date,
        date,
        cell,
        weekMinFlights: 0,
        weekMaxFlights: 0,
        isMonthHigh: Boolean(cell && monthMaxFlights > 0 && cell.totalFlights === monthMaxFlights),
      };
    });
    const trailingBlankCount = (7 - ((leadingBlanks.length + dateCells.length) % 7)) % 7;
    const trailingBlanks: PeakDayCalendarCell[] = Array.from({ length: trailingBlankCount }, (_, index) => ({
      key: `blank-end-${index}`,
      date: '',
      cell: null,
      weekMinFlights: 0,
      weekMaxFlights: 0,
      isMonthHigh: false,
    }));
    const calendarCells = [...leadingBlanks, ...dateCells, ...trailingBlanks];
    for (let index = 0; index < calendarCells.length; index += 7) {
      const week = calendarCells.slice(index, index + 7).filter((item) => item.cell);
      if (week.length <= 1) continue;
      const totals = week.map((item) => item.cell?.totalFlights ?? 0);
      const weekMax = Math.max(...totals);
      const weekMin = Math.min(...totals);
      for (const item of week) {
        item.weekMinFlights = weekMin;
        item.weekMaxFlights = weekMax;
      }
    }
    return calendarCells;
  }, [activePeakDayMonth, peakDayCellByDate]);
  const peakHourHeatmapMonths = useMemo(() => (
    operationalMonthOptions.map((month) => {
      const bounds = monthBounds(month.key);
      const heatmap = buildPeakHourHeatmap({
        records: dashboardRecords,
        bucketSizeMinutes: operationalBucketSize,
        timeBasis,
        typeFilter: operationalPeakHourTypeFilter,
        dateFrom: bounds.from,
        dateTo: bounds.to,
      });
      const cellMap = new Map(heatmap.cells.map((cell) => [`${cell.operationalDate}|${cell.bucketIndex}`, cell]));
      const totalFlights = heatmap.cells.reduce((sum, cell) => sum + cell.totalFlights, 0);
      return { ...month, heatmap, cellMap, totalFlights };
    })
  ), [dashboardRecords, operationalBucketSize, operationalMonthOptions, operationalPeakHourTypeFilter, timeBasis]);
  const operationalDailyRows = useMemo(() => {
    const sourceRows = summarizeFlightRecordsByOperationalDate(dashboardRecords);
    const byDate = new Map(sourceRows.map((row) => [row.date, row]));
    return monthDateKeys(activeOperationalDate.slice(0, 7)).map((date) => (
      byDate.get(date) ?? { date, flights: 0, arrivals: 0, departures: 0, pax: 0 }
    ));
  }, [activeOperationalDate, dashboardRecords]);
  const operationalDailyMaxFlights = Math.max(1, ...operationalDailyRows.map((row) => row.flights));
  const peakHourMaxFlights = Math.max(1, ...peakHourHeatmapMonths.flatMap((month) => month.heatmap.cells.map((cell) => cell.totalFlights)));
  const operationalBucketDrilldownCards = useMemo(() => {
    const makeCard = (label: string, bucket: OperationalTimelineBucket | null) => {
      const records = bucket?.records ?? [];
      return {
        label,
        bucketLabel: bucket?.label ?? '-',
        flights: bucket?.flights ?? 0,
        dimensions: [
          { label: 'Hãng bay', rows: summarizeOperationalRecords(records, (record) => record.airline || 'Không rõ').slice(0, 5) },
          { label: 'Đường bay', rows: summarizeOperationalRecords(records, (record) => record.route || 'Không rõ').slice(0, 5) },
          { label: 'A/C Type', rows: summarizeOperationalRecords(records, (record) => resolveAircraftGroupLabel(record, operationalSettings)).slice(0, 5) },
        ],
      };
    };
    return [
      makeCard('Peak ARR bucket', operationalDashboard.kpis.peakArrivalBucket),
      makeCard('Peak DEP bucket', operationalDashboard.kpis.peakDepartureBucket),
    ];
  }, [operationalDashboard, operationalSettings]);
  const periodOptions = useMemo(() => (
    listPeriods(analysisRecords, comparisonMode, comparisonMode === 'yoy' ? comparisonGranularity : 'month')
  ), [analysisRecords, comparisonGranularity, comparisonMode]);

  const defaultCurrentPeriod = periodOptions[periodOptions.length - 1]?.key ?? '';
  const activeCurrentPeriod = periodOptions.some((period) => period.key === currentPeriod)
    ? currentPeriod
    : defaultCurrentPeriod;
  const defaultPreviousPeriod = resolveDefaultPreviousPeriod(
    periodOptions,
    activeCurrentPeriod,
    comparisonMode,
    comparisonMode === 'yoy' ? comparisonGranularity : 'month'
  );
  const activePreviousPeriod = periodOptions.some((period) => period.key === previousPeriod) && previousPeriod !== activeCurrentPeriod
    ? previousPeriod
    : defaultPreviousPeriod;
  const comparisonGranularityForBuild = comparisonMode === 'yoy' ? comparisonGranularity : 'month';
  const comparisonScopedRecords = useMemo(() => {
    if (!activeCurrentPeriod) return [];
    const periodKeys = new Set([activeCurrentPeriod, activePreviousPeriod].filter(Boolean));
    return analysisRecords.filter((record) => (
      record.status !== 'deleted' &&
      (typeFilter === 'all' || record.type === typeFilter) &&
      periodKeys.has(periodKey(record, comparisonMode, comparisonGranularityForBuild))
    ));
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularityForBuild, comparisonMode, typeFilter]);
  const comparisonPaxCoverage = useMemo(() => computePaxCoverage(comparisonScopedRecords), [comparisonScopedRecords]);
  const comparisonTrendRecords = useMemo(() => (
    dashboardRecords.filter((record) => (
      record.status !== 'deleted' &&
      (typeFilter === 'all' || record.type === typeFilter)
    ))
  ), [dashboardRecords, typeFilter]);
  const comparisonMonthlyTrendRows = useMemo(() => (
    summarizeComparisonRecordsByMonth(comparisonTrendRecords, metric)
  ), [comparisonTrendRecords, metric]);
  const defaultComparisonTrendMonth = /^\d{4}-\d{2}$/.test(activeCurrentPeriod) && comparisonMonthlyTrendRows.some((row) => row.key === activeCurrentPeriod)
    ? activeCurrentPeriod
    : comparisonMonthlyTrendRows.at(-1)?.key ?? '';
  const activeComparisonTrendMonth = comparisonMonthlyTrendRows.some((row) => row.key === comparisonTrendMonth)
    ? comparisonTrendMonth
    : defaultComparisonTrendMonth;
  const comparisonDailyTrendRows = useMemo(() => {
    const sourceRows = summarizeComparisonRecordsByDate(
      comparisonTrendRecords.filter((record) => getDashboardOperationalDate(record).slice(0, 7) === activeComparisonTrendMonth),
      metric
    );
    const byDate = new Map(sourceRows.map((row) => [row.key, row]));
    return monthDateKeys(activeComparisonTrendMonth).map((date) => (
      byDate.get(date) ?? {
        key: date,
        label: date,
        day: date.slice(8, 10),
        value: 0,
        flights: 0,
        arrivals: 0,
        departures: 0,
        pax: 0,
      }
    ));
  }, [activeComparisonTrendMonth, comparisonTrendRecords, metric]);
  const comparisonMaxMonthlyTrend = Math.max(1, ...comparisonMonthlyTrendRows.map((row) => row.value));
  const comparisonMaxDailyTrend = Math.max(1, ...comparisonDailyTrendRows.map((row) => row.value));
  const comparisonTrendMetricLabel = metric === 'pax' ? 'Pax' : 'Flights';

  const comparison = useMemo(() => {
    if (!activeCurrentPeriod) return null;
    return buildDashboardComparison({
      records: analysisRecords,
      mode: comparisonMode,
      granularity: comparisonGranularityForBuild,
      metric,
      currentPeriod: activeCurrentPeriod,
      previousPeriod: activePreviousPeriod,
      typeFilter,
      timeBasis,
      dimension,
      routeCountries,
    });
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularityForBuild, comparisonMode, dimension, metric, routeCountries, timeBasis, typeFilter]);

  const dimensionLabel = DRIVER_TABS.find((tab) => tab.value === dimension)?.label ?? 'Tác nhân';

  const waterfallRows = useMemo(() => {
    if (!activeCurrentPeriod) return [];
    return WATERFALL_DIMENSIONS.map((item) => {
      const result = buildDashboardComparison({
        records: analysisRecords,
        mode: comparisonMode,
        granularity: comparisonGranularityForBuild,
        metric,
        currentPeriod: activeCurrentPeriod,
        previousPeriod: activePreviousPeriod,
        typeFilter,
        timeBasis,
        dimension: item.value,
        routeCountries,
      });
      const topDriver = result.drivers[0] ?? null;
      const reconciledDelta = result.drivers.reduce((sum, driver) => sum + driver.delta, 0);
      return { ...item, result, topDriver, reconciledDelta };
    });
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularityForBuild, comparisonMode, metric, routeCountries, timeBasis, typeFilter]);

  const maxWaterfallDelta = Math.max(
    1,
    ...waterfallRows.map((row) => Math.abs(row.topDriver?.delta ?? 0))
  );

  const ctgRankedDrivers = useMemo(() => (
    [...(comparison?.drivers ?? [])]
      .filter((driver) => driver.ctgPct != null)
      .sort((left, right) => Math.abs(right.ctgPct ?? 0) - Math.abs(left.ctgPct ?? 0) || Math.abs(right.delta) - Math.abs(left.delta))
  ), [comparison]);

  const selectedDriver = useMemo(() => (
    comparison?.drivers.find((driver) => driver.key === selectedDriverKey) ?? ctgRankedDrivers[0] ?? comparison?.drivers[0] ?? null
  ), [comparison, ctgRankedDrivers, selectedDriverKey]);

  const selectedDriverRecords = useMemo(() => {
    if (!selectedDriver) return [];
    return analysisRecords
      .filter((record) => (
        record.status !== 'deleted' &&
        (typeFilter === 'all' || record.type === typeFilter) &&
        (periodKey(record, comparisonMode, comparisonGranularityForBuild) === activeCurrentPeriod || periodKey(record, comparisonMode, comparisonGranularityForBuild) === activePreviousPeriod) &&
        dimensionValue(record, dimension, timeBasis, routeCountries) === selectedDriver.key
      ))
      .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule));
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularityForBuild, comparisonMode, dimension, routeCountries, selectedDriver, timeBasis, typeFilter]);

  const selectedDriverDrilldownRows = useMemo(() => {
    const groups = new Map<string, { date: string; flights: number; arrivals: number; departures: number; pax: number }>();
    for (const record of selectedDriverRecords) {
      const date = getDashboardOperationalDate(record);
      const current = groups.get(date) ?? { date, flights: 0, arrivals: 0, departures: 0, pax: 0 };
      current.flights += 1;
      current.pax += operationalRecordPax(record);
      if (record.type === 'A') current.arrivals += 1;
      if (record.type === 'D') current.departures += 1;
      groups.set(date, current);
    }
    return [...groups.values()].sort((left, right) => right.flights - left.flights || left.date.localeCompare(right.date));
  }, [selectedDriverRecords]);

  const topGain = comparison?.drivers.find((driver) => driver.delta > 0) ?? null;
  const topDrag = comparison?.drivers.find((driver) => driver.delta < 0) ?? null;
  const topCtg = ctgRankedDrivers[0] ?? null;
  const topMixRows = comparison?.drivers.slice(0, 6) ?? [];
  const maxMixShare = Math.max(0.01, ...topMixRows.flatMap((driver) => [driver.currentShare, driver.previousShare]));

  const selectedAiWorkspaceSeasonData = useMemo(() => (
    selectedAiSeasonIds
      .map((seasonId) => aiWorkspaceSeasonData[seasonId])
      .filter((item): item is DashboardAiWorkspaceSeasonData => Boolean(item))
  ), [aiWorkspaceSeasonData, selectedAiSeasonIds]);

  const aiAvailableSeasonCatalog = useMemo(() => seasons.map((item) => ({
    seasonId: item.id,
    seasonCode: item.seasonCode,
    name: item.name,
    dateRange: { from: item.effectiveStart, to: item.effectiveEnd },
  })), [seasons]);

  const dashboardAiQueryOnlyContext = useMemo(() => {
    const prompt = 'Xuất báo cáo bằng Supabase reporting/query.';
    const dataScope = resolveDashboardAiDataScopeForPrompt({
      prompt,
      activeSeasonId: season?.id,
      selectedSeasonIds: selectedAiSeasonIds,
      availableSeasonCatalog: aiAvailableSeasonCatalog,
    });
    const seasonIds = dataScope.seasonIds.length > 0 ? dataScope.seasonIds : selectedAiSeasonIds;
    return buildDashboardAiQueryOnlyContext({
      seasonIds,
      availableSeasonCatalog: aiAvailableSeasonCatalog,
      dataScope,
      semanticIntent: inferDashboardAiSemanticIntent({
        userPrompt: prompt,
        context: {
          dataScope,
          availableSeasonCatalog: aiAvailableSeasonCatalog,
          sourcePolicy: 'supabase-reporting-query-only',
        },
      }),
    });
  }, [aiAvailableSeasonCatalog, season?.id, selectedAiSeasonIds]);

  const aiSettings = operationalSettings?.aiAnalysis;
  const enabledAiModels = useMemo(() => listEnabledDashboardAiModels(aiSettings), [aiSettings]);
  const selectedAiModel = useMemo<AiAnalysisModelSetting | null>(() => (
    resolveDashboardAiModel(aiSettings, selectedAiModelId)
  ), [aiSettings, selectedAiModelId]);
  const aiConfigured = isDashboardAiConfigured(aiSettings);
  const dashboardAiAvailableTools = useMemo(() => resolveDashboardAiAvailableTools({
    aiConfigured,
    operatorAuthorized: true,
    hasSelectedSeason: Boolean(season),
    hasLocalRecords: Boolean(season),
    selectedSeasonCount: selectedAiSeasonIds.length,
    exportEnabled: effectiveRecords.length > 0,
  }), [aiConfigured, effectiveRecords.length, season, selectedAiSeasonIds.length]);
  const aiNotebookStorageKey = `dashboard:aiNotebook:${selectedAiSeasonIds.join('|') || season?.id || targetSeasonId || 'global'}`;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const fallbackNotebook = buildDashboardAiNotebook({
        seasonIds: selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : season?.id ? [season.id] : [],
        title: 'Rich Chat AI',
      });
      const raw = window.localStorage.getItem(aiNotebookStorageKey);
      if (!raw) {
        setAiNotebook(fallbackNotebook);
        return;
      }
      try {
        setAiNotebook(normalizeStoredAiNotebook(JSON.parse(raw), fallbackNotebook));
        return;
      } catch {
        // Notebook persistence is convenience-only.
      }
      setAiNotebook(fallbackNotebook);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [aiNotebookStorageKey, season, selectedAiSeasonIds]);

  useEffect(() => {
    if (typeof window === 'undefined' || !aiNotebook) return;
    try {
      window.localStorage.setItem(aiNotebookStorageKey, JSON.stringify(aiNotebook));
    } catch {
      // Notebook persistence is convenience-only.
    }
  }, [aiNotebook, aiNotebookStorageKey]);

  useEffect(() => {
    if (!selectedAiModel || selectedAiModelId === selectedAiModel.id) return;
    setSelectedAiModelId(selectedAiModel.id);
  }, [selectedAiModel, selectedAiModelId, setSelectedAiModelId]);

  const downloadDashboardReport = useCallback(async (templateId: DashboardReportTemplateId, aiNotesOverride?: string | null) => {
    const latestAiAnswer = aiNotesOverride ??
      [...(aiNotebook?.cells ?? [])].reverse().find((cell) => cell.assistantText)?.assistantText ??
      null;
    const workbook = templateId === 'mom-wow-analysis'
      ? buildMomWowAnalysisWorkbook({
        context: dashboardAiQueryOnlyContext,
        aiNotes: latestAiAnswer,
        seasonCode: season?.seasonCode,
      })
      : buildSanLuongSummaryWorkbook({
        records: effectiveRecords,
        routeCountries,
        seasonCode: season?.seasonCode,
        timeBasis,
    });
    const result = await downloadDashboardWorkbook(workbook, buildDashboardReportFileName(templateId, season?.seasonCode));
    notifyExportCompleted(result);
  }, [aiNotebook, dashboardAiQueryOnlyContext, effectiveRecords, notifyExportCompleted, routeCountries, season?.seasonCode, timeBasis]);

  const downloadAiNotebookExport = useCallback(async (exportAction: DashboardAiExportAction) => {
    if (exportAction.type === 'dashboard-template-export') {
      await downloadDashboardReport(exportAction.templateId);
      return;
    }
    const workbook = buildCustomDashboardWorkbook(exportAction.workbookSpec, {
      seasonCode: season?.seasonCode,
    });
    const result = await downloadDashboardWorkbook(workbook, exportAction.fileName);
    notifyExportCompleted(result);
  }, [downloadDashboardReport, notifyExportCompleted, season?.seasonCode]);

  const cancelAiPrompt = useCallback(() => {
    aiAbortControllerRef.current?.abort();
    aiAbortControllerRef.current = null;
    setAiLoading(false);
    setAiLoadingStartedAt(null);
    setAiLoadingStep('context');
    setAiLoadingMessage('AI đang phân tích dữ liệu...');
  }, []);

  const submitAiPrompt = useCallback(async (promptOverride?: string, options: { preferredTool?: DashboardAiToolName | null; signal?: AbortSignal; modelOverride?: AiAnalysisModelSetting | null } = {}) => {
    const prompt = (promptOverride ?? aiPrompt).trim();
    if (!prompt || aiLoading) return;
    if (!aiConfigured) {
      setAiError('AI analysis is not configured. Add an enabled model in Settings > AI Analysis.');
      return;
    }
    const modelForRequest = options.modelOverride ?? selectedAiModel;
    if (!modelForRequest) {
      setAiError('No enabled AI model is selected.');
      return;
    }

    const controller = options.signal ? null : new AbortController();
    const signal = options.signal ?? controller?.signal;
    aiAbortControllerRef.current?.abort();
    if (controller) aiAbortControllerRef.current = controller;
    const throwIfAborted = () => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    const preferredTool = options.preferredTool ?? null;
    const selectedSkill = resolveDashboardAiSkillForPrompt(prompt);
    const currentAiCells = aiNotebook?.cells ?? [];
    const notebookContext = buildDashboardAiNotebookContext(currentAiCells, { maxCells: 3, activeCellId: pinnedAiContextCellId });
    const selectedWorkflow = resolveDashboardAiWorkflowForPrompt(prompt, {
      activeArtifact: notebookContext.activeArtifact ?? null,
    });
    const sessionFollowUp = resolveDashboardAiSessionFollowUp({
      userPrompt: prompt,
      cells: currentAiCells,
      pinnedCellId: pinnedAiContextCellId,
    });
    const history = capDashboardAiLocalHistory(
      currentAiCells.flatMap((cell) => [
        {
          id: `${cell.id}-prompt`,
          role: 'user' as const,
          content: cell.prompt,
          createdAt: cell.createdAt,
          modelId: cell.modelId,
        },
        {
          id: `${cell.id}-assistant`,
          role: 'assistant' as const,
          content: cell.assistantText,
          createdAt: cell.createdAt,
          modelId: cell.modelId,
        },
      ])
    ).map(({ role, content }) => ({ role, content })).slice(-6);
    setLastAiPrompt(prompt);
    setAiPrompt('');
    setAiError(null);
    setAiLoading(true);
    setAiLoadingStartedAt(Date.now());
    setAiLoadingStep('context');
    setAiLoadingMessage('Đang chuẩn bị context AI...');

    try { 
      throwIfAborted(); 
      if (sessionFollowUp?.boardPatch) {
        setAiLoadingStep('render');
        const cellCreatedAt = Date.now();
        const runId = `ai-run-${cellCreatedAt}`;
        const runEvents = appendDashboardAiRunEvent([], {
          id: `${runId}-result`,
          runId,
          type: 'result',
          createdAt: cellCreatedAt,
          prompt,
          status: 'completed',
          message: sessionFollowUp.assistantText,
        });
        const sourceQueryResults = capDashboardAiNotebookQueryResults(
          currentAiCells.find((cell) => cell.id === sessionFollowUp.sourceCellId)?.queryResults,
          { maxResults: 2, maxRowsPerResult: 100 }
        );
        const nextCell: DashboardAiNotebookCell = {
          id: `ai-cell-${cellCreatedAt}`,
          prompt,
          assistantText: sessionFollowUp.assistantText,
          blocks: sessionFollowUp.boardPatch.blocks,
          toolTraceSummary: [{
            tool: 'compose_dashboard_ai_board',
            status: 'executed',
            reason: 'rendered_rich_chat: Dùng lại active artifact/query result từ phiên chat hiện tại cho prompt follow-up.',
            phase: 'rendered_rich_chat',
            toolset: 'dashboard-visual',
            ...(selectedSkill ? { skill: selectedSkill.id, contextProfile: selectedSkill.contextProfile } : {}),
          }],
          exportAction: null,
          createdAt: cellCreatedAt,
          modelId: modelForRequest.id,
          runEvents,
          ...(sourceQueryResults.length > 0 ? { queryResults: sourceQueryResults } : {}),
          activeArtifact: sessionFollowUp.activeArtifact,
        };
        setAiNotebook((current) => {
          const base = current ?? buildDashboardAiNotebook({
            seasonIds: selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : season?.id ? [season.id] : [],
            title: sessionFollowUp.boardPatch?.title ?? 'Rich Chat AI',
          });
          return {
            ...base,
            title: sessionFollowUp.boardPatch?.title || base.title,
            cells: [...base.cells, nextCell].slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS),
            updatedAt: cellCreatedAt,
          };
        });
        return;
      }
      const followUpBoardPatch = buildDashboardAiFollowUpBoardPatchFromCells({ 
        userPrompt: prompt, 
        cells: aiNotebook?.cells ?? [], 
      }); 
      if (followUpBoardPatch) { 
        setAiLoadingStep('render'); 
        const cellCreatedAt = Date.now(); 
        const runId = `ai-run-${cellCreatedAt}`;
        const runEvents = appendDashboardAiRunEvent([], {
          id: `${runId}-result`,
          runId,
          type: 'result',
          createdAt: cellCreatedAt,
          prompt,
          status: 'completed',
          message: 'Đã phân tích driver từ dữ liệu đã render ở cell trước.',
        });
        const nextCell: DashboardAiNotebookCell = { 
          id: `ai-cell-${cellCreatedAt}`, 
          prompt, 
          assistantText: 'Đã phân tích driver từ dữ liệu đã render ở cell trước, không dùng fallback MoM/WoW mặc định.', 
          blocks: followUpBoardPatch.blocks, 
          toolTraceSummary: [{ 
            tool: 'compose_dashboard_ai_board', 
            status: 'executed', 
            reason: 'rendered_rich_chat: Dùng lại artifact/queryResults từ cell trước cho prompt follow-up ngắn.',
            phase: 'rendered_rich_chat', 
            toolset: 'dashboard-visual', 
            ...(selectedSkill ? { skill: selectedSkill.id, contextProfile: selectedSkill.contextProfile } : {}), 
          }], 
          exportAction: null, 
          createdAt: cellCreatedAt, 
          modelId: modelForRequest.id, 
          runEvents,
        }; 
        setAiNotebook((current) => { 
          const base = current ?? buildDashboardAiNotebook({ 
            seasonIds: selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : season?.id ? [season.id] : [], 
            title: followUpBoardPatch.title, 
          }); 
          return { 
            ...base, 
            title: followUpBoardPatch.title || base.title, 
            cells: [...base.cells, nextCell].slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS), 
            updatedAt: cellCreatedAt, 
          }; 
        }); 
        return; 
      } 
      let requestDataScope = resolveDashboardAiDataScopeForPrompt({ 
        prompt,
        activeSeasonId: season?.id,
        selectedSeasonIds: selectedAiSeasonIds,
        availableSeasonCatalog: aiAvailableSeasonCatalog,
      });
      let requestSeasonIds = requestDataScope.seasonIds.length > 0 ? requestDataScope.seasonIds : selectedAiSeasonIds;
      let shouldUpdateSelectedAiSeasons = false;
      if (isConsecutiveSeasonPrompt(prompt) && selectedAiSeasonIds.length === 1) {
        requestSeasonIds = resolveConsecutiveAiSeasonIds(selectedAiSeasonIds, seasons);
        requestDataScope = {
          ...requestDataScope,
          scope: 'selected-seasons',
          seasonIds: requestSeasonIds,
          explicitSeasonFilter: false,
          reason: 'consecutive-seasons',
        };
        shouldUpdateSelectedAiSeasons = true;
      }
      const loadedEntries = await Promise.all(requestSeasonIds.map(async (seasonId) => {
        const existing = aiWorkspaceSeasonData[seasonId];
        if (existing) return existing;
        const target = seasons.find((item) => item.id === seasonId);
        return target ? loadAiWorkspaceSeason(target) : null;
      }));
      const requestSeasonData = loadedEntries.filter((item): item is DashboardAiWorkspaceSeasonData => Boolean(item));
      if (requestSeasonData.some((item) => !aiWorkspaceSeasonData[item.season.id])) {
        setAiWorkspaceSeasonData((current) => {
          const next = { ...current };
          for (const item of requestSeasonData) next[item.season.id] = item;
          return next;
        });
      }
      if (shouldUpdateSelectedAiSeasons && requestSeasonData.length > selectedAiWorkspaceSeasonData.length) {
        setSelectedAiSeasonIds(requestSeasonIds);
      }
      const semanticIntent = inferDashboardAiSemanticIntent({
        userPrompt: prompt,
        context: {
          dataScope: requestDataScope,
          availableSeasonCatalog: aiAvailableSeasonCatalog,
          sourcePolicy: 'supabase-reporting-query-only',
        },
      });
      const requestContext = buildDashboardAiQueryOnlyContext({
        seasonIds: requestSeasonIds,
        availableSeasonCatalog: aiAvailableSeasonCatalog,
        dataScope: requestDataScope,
        semanticIntent,
      });
      setAiLoadingStep('provider');
      setAiLoadingMessage('AI đang gọi Supabase reporting/query...');
      const response = await analyzeDashboardWithAi({
        userPrompt: prompt,
        context: requestContext,
        history,
        model: modelForRequest,
        preferredTool,
        availableTools: dashboardAiAvailableTools,
        selectedSkillId: selectedSkill?.id,
        contextProfile: selectedSkill?.contextProfile,
        notebookContext,
        workflowId: selectedWorkflow?.id ?? semanticIntent.workflowId,
        language: 'vi',
        providerFallback: true,
        allowDataRequest: false,
        signal,
      });
      let aiResponse = response;
      if (!aiResponse) throw new Error('AI provider returned no response.');
      throwIfAborted();
      if (aiResponse.sqlQueryPlans.length > 0) {
        const rejectedSqlTrace: DashboardAiToolTraceSummary = {
          tool: 'query_dashboard_data',
          status: 'rejected',
          reason: 'AI Workspace query-only không chạy SQL local trong page; hãy dùng dataQueries để Edge Function trả queryResults từ Supabase reporting.',
          toolset: 'dashboard-readonly',
        };
        aiResponse = {
          ...aiResponse,
          sqlQueryPlans: [],
          toolTraceSummary: [rejectedSqlTrace, ...aiResponse.toolTraceSummary].slice(0, 8),
        };
      }
      if (aiResponse.dataRequest && aiResponse.queryResults.length === 0) {
        const legacyDataRequestTrace: DashboardAiToolTraceSummary = {
          tool: 'query_dashboard_data',
          status: 'rejected',
          reason: 'AI Workspace query-only không dùng dataRequest/MoM-WoW payload; hãy dùng dataQueries hoặc queryResults.',
          toolset: 'dashboard-readonly',
          fallbackReason: 'Bỏ qua dataRequest legacy để tránh quay về bảng MoM/WoW.',
        };
        aiResponse = {
          ...aiResponse,
          dataRequest: null,
          toolTraceSummary: [
            legacyDataRequestTrace,
            ...aiResponse.toolTraceSummary,
          ].slice(0, 8),
        };
      }
      setAiLoadingStep('render');
      const boardPatch = aiResponse.boardPatch ?? buildDashboardAiFallbackBoardPatch({
        userPrompt: prompt,
        preferredTool,
        visualReport: aiResponse.visualReport,
      });
      const cellCreatedAt = Date.now();
      const runId = `ai-run-${cellCreatedAt}`;
      const runEvents = appendDashboardAiRunEvent([], {
        id: `${runId}-result`,
        runId,
        type: 'result',
        createdAt: cellCreatedAt,
        prompt,
        status: 'completed',
        message: aiResponse.assistantText,
      });
      const nextCellBase: DashboardAiNotebookCell = {
        id: `ai-cell-${cellCreatedAt}`,
        prompt,
        assistantText: aiResponse.assistantText,
        blocks: boardPatch?.blocks ?? [],
        toolTraceSummary: aiResponse.toolTraceSummary,
        exportAction: aiResponse.exportAction,
        createdAt: cellCreatedAt,
        modelId: modelForRequest.id,
        runEvents,
        queryResults: aiResponse.queryResults,
        resultProfiles: aiResponse.resultProfiles,
        answerVerification: aiResponse.answerVerification,
      };
      const nextCell: DashboardAiNotebookCell = {
        ...nextCellBase,
        activeArtifact: buildDashboardAiActiveArtifactFromCell(nextCellBase, {
          seasonIds: requestSeasonIds.length > 0 ? requestSeasonIds : selectedAiSeasonIds,
        }),
      };
      setAiNotebook((current) => {
        const base = current ?? buildDashboardAiNotebook({
            seasonIds: requestSeasonIds.length > 0 ? requestSeasonIds : selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : season?.id ? [season.id] : [],
            title: boardPatch?.title ?? 'Rich Chat AI',
          });
        return {
          ...base,
          title: boardPatch?.title ?? base.title,
          seasonIds: normalizeDashboardAiWorkspaceSeasonIds(requestSeasonIds.length > 0 ? requestSeasonIds : selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : base.seasonIds),
          cells: [...base.cells, nextCell].slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS),
          updatedAt: cellCreatedAt,
        };
      });
    } catch (err) {
      if (!isAbortError(err)) {
        setAiError((err as Error).message);
      }
    } finally {
      if (!controller || aiAbortControllerRef.current === controller) {
        aiAbortControllerRef.current = null;
        setAiLoading(false);
        setAiLoadingStartedAt(null);
        setAiLoadingStep('context');
        setAiLoadingMessage('AI đang phân tích dữ liệu...');
      }
    }
  }, [aiAvailableSeasonCatalog, aiConfigured, aiLoading, aiNotebook, aiPrompt, aiWorkspaceSeasonData, dashboardAiAvailableTools, loadAiWorkspaceSeason, pinnedAiContextCellId, season, seasons, selectedAiModel, selectedAiSeasonIds, selectedAiWorkspaceSeasonData.length]);

  const aiWorkspaceSeasonSummaryRows = useMemo<AiWorkspaceTableRow[]>(() => (
    selectedAiWorkspaceSeasonData.map((item) => {
      const activeRows = item.effectiveRecords.filter((record) => record.status !== 'deleted');
      const dates = activeRows.map((record) => getDashboardOperationalDate(record)).filter(Boolean).sort();
      const arrivals = activeRows.filter((record) => record.type === 'A').length;
      const departures = activeRows.filter((record) => record.type === 'D').length;
      const pax = activeRows.reduce((sum, record) => sum + (Number.isFinite(record.pax ?? NaN) ? Number(record.pax) : 0), 0);
      return {
        Season: item.season.seasonCode,
        Name: item.season.name,
        Flights: activeRows.length,
        Pax: pax,
        ARR: arrivals,
        DEP: departures,
        From: dates[0] ?? '-',
        To: dates[dates.length - 1] ?? '-',
        Source: item.dataSource,
      };
    })
  ), [selectedAiWorkspaceSeasonData]);

  const materializeAiWorkspaceTableRows = useCallback((block: DashboardAiWorkspaceBlock): AiWorkspaceTableRow[] => {
    if (block.table?.rows?.length) {
      return block.table.rows.map((row) => ({ ...row }));
    }
    const limit = block.table?.limit ?? 12;
    const templateId = block.table?.templateId ?? 'season-summary';
    if (block.source === 'multiSeason' || templateId === 'season-summary' || templateId === 'multi-season-summary') {
      return aiWorkspaceSeasonSummaryRows.slice(0, limit);
    }
    const sourceQueryId = block.table?.sourceQueryId ?? block.chart?.sourceQueryId ?? '';
    return [{
      'Ghi chú dữ liệu': sourceQueryId
        ? `Block gắn sourceQueryId ${sourceQueryId} nhưng boardPatch không nhúng rows. Cần queryResults từ Supabase reporting để render số liệu.`
        : `Template ${templateId} cần dataQueries/queryResults từ Supabase reporting; AI Workspace không dùng dữ liệu overview dashboard làm fallback.`,
      Source: block.source,
      Template: templateId,
      ...(sourceQueryId ? { sourceQueryId } : {}),
    }];
  }, [aiWorkspaceSeasonSummaryRows]);

  const materializeAiWorkspaceChartRows = useCallback((block: DashboardAiWorkspaceBlock): Array<Record<string, string | number>> => {
    if (block.chart?.rows?.length) {
      return block.chart.rows.map((row) => Object.fromEntries(
        Object.entries(row)
          .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')
      ));
    }
    const limit = block.chart?.limit ?? 10;
    if (block.source === 'multiSeason') {
      return aiWorkspaceSeasonSummaryRows.slice(0, limit).map((row) => ({
        label: String(row.Season),
        value: Number(row.Flights) || 0,
      }));
    }
    return [];
  }, [aiWorkspaceSeasonSummaryRows]);

  const moveAiNotebookBlock = useCallback((cellId: string, blockId: string, direction: -1 | 1) => {
    setAiNotebook((current) => {
      if (!current) return current;
      return {
        ...current,
        cells: current.cells.map((cell) => {
          if (cell.id !== cellId) return cell;
          const index = cell.blocks.findIndex((block) => block.id === blockId);
          const targetIndex = index + direction;
          if (index < 0 || targetIndex < 0 || targetIndex >= cell.blocks.length) return cell;
          const blocks = [...cell.blocks];
          const [block] = blocks.splice(index, 1);
          blocks.splice(targetIndex, 0, block);
          return { ...cell, blocks };
        }),
        updatedAt: Date.now(),
      };
    });
  }, []);

  const deleteAiNotebookBlock = useCallback((cellId: string, blockId: string) => {
    setAiNotebook((current) => current
      ? {
        ...current,
        cells: current.cells.map((cell) => cell.id === cellId
          ? { ...cell, blocks: cell.blocks.filter((block) => block.id !== blockId) }
          : cell),
        updatedAt: Date.now(),
      }
      : current);
  }, []);

  const deleteAiNotebookCell = useCallback((cellId: string) => {
    setPinnedAiContextCellId((current) => current === cellId ? null : current);
    setAiNotebook((current) => current
      ? { ...current, cells: current.cells.filter((cell) => cell.id !== cellId), updatedAt: Date.now() }
      : current);
  }, []);

  const pinAiNotebookContext = useCallback((cell: DashboardAiNotebookCell) => {
    setPinnedAiContextCellId(cell.id);
  }, []);

  const duplicateAiNotebookPrompt = useCallback((cell: DashboardAiNotebookCell) => {
    setAiPrompt(cell.prompt);
    setLastAiPrompt(cell.prompt);
  }, []);

  const toggleAiWorkspaceSeason = useCallback((seasonId: string) => {
    setSelectedAiSeasonIds((current) => {
      const hasSeason = current.includes(seasonId);
      const next = hasSeason
        ? current.filter((id) => id !== seasonId)
        : [...current, seasonId];
      const normalized = normalizeDashboardAiWorkspaceSeasonIds(next);
      if (normalized.length === 0 && season?.id) return [season.id];
      return normalized;
    });
  }, [season]);

  const exportAiWorkspaceBlockExcel = useCallback(async (block: DashboardAiWorkspaceBlock) => {
    if (block.type !== 'table') return;
    const rows = materializeAiWorkspaceTableRows(block);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : ['Value'];
    const workbook = buildCustomDashboardWorkbook({
      title: block.title,
      sheets: [{
        name: block.title,
        columns,
        rows,
        notes: `Block AI Workspace: ${block.source}`,
      }],
    }, {
      seasonCode: season?.seasonCode,
    });
    const safeName = `${block.title.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'ai_workspace_block'}.xlsx`;
    const result = await downloadDashboardWorkbook(workbook, safeName);
    notifyExportCompleted(result);
  }, [materializeAiWorkspaceTableRows, notifyExportCompleted, season?.seasonCode]);

  const retryAiPrompt = useCallback((prompt: string) => {
    void submitAiPrompt(prompt);
  }, [submitAiPrompt]);

  const tryDifferentAiModel = useCallback((prompt: string) => {
    if (enabledAiModels.length < 2) {
      void submitAiPrompt(prompt);
      return;
    }
    const currentIndex = enabledAiModels.findIndex((model) => model.id === selectedAiModel?.id);
    const nextModel = enabledAiModels[(currentIndex + 1 + enabledAiModels.length) % enabledAiModels.length];
    if (!nextModel) return;
    setSelectedAiModelId(nextModel.id);
    void submitAiPrompt(prompt, { modelOverride: nextModel });
  }, [enabledAiModels, selectedAiModel?.id, setSelectedAiModelId, submitAiPrompt]);

  const clearAiNotebook = useCallback(() => {
    setPinnedAiContextCellId(null);
    setAiNotebook(buildDashboardAiNotebook({ seasonIds: selectedAiSeasonIds, title: 'Rich Chat AI' }));
  }, [selectedAiSeasonIds]);

  const aiWorkspaceFallbackKpis = useMemo(() => {
    const activeRows = selectedAiWorkspaceSeasonData.flatMap((item) => (
      item.effectiveRecords.filter((record) => record.status !== 'deleted')
    ));
    const operatingDays = new Set(activeRows.map((record) => getDashboardOperationalDate(record)).filter(Boolean)).size;
    return {
      totalFlights: activeRows.length,
      totalPax: activeRows.reduce((sum, record) => sum + operationalRecordPax(record), 0),
      avgFlightsPerDay: operatingDays > 0 ? activeRows.length / operatingDays : 0,
      selectedSeasonCount: selectedAiSeasonIds.length,
    };
  }, [selectedAiSeasonIds.length, selectedAiWorkspaceSeasonData]);

  const aiNotebookRendererData = useMemo<AiNotebookRendererData>(() => ({
    formatValue,
    materializeTableRows: materializeAiWorkspaceTableRows,
    materializeChartRows: materializeAiWorkspaceChartRows,
    fallbackKpis: aiWorkspaceFallbackKpis,
  }), [aiWorkspaceFallbackKpis, materializeAiWorkspaceChartRows, materializeAiWorkspaceTableRows]);

  const aiNotebookActions = useMemo(() => ({
    submitPrompt: submitAiPrompt,
    retryPrompt: retryAiPrompt,
    tryDifferentModel: tryDifferentAiModel,
    deleteCell: deleteAiNotebookCell,
    duplicatePrompt: duplicateAiNotebookPrompt,
    onPinContext: pinAiNotebookContext,
    moveBlock: moveAiNotebookBlock,
    deleteBlock: deleteAiNotebookBlock,
    exportBlockExcel: exportAiWorkspaceBlockExcel,
    downloadExport: downloadAiNotebookExport,
  }), [
    deleteAiNotebookBlock,
    deleteAiNotebookCell,
    downloadAiNotebookExport,
    duplicateAiNotebookPrompt,
    exportAiWorkspaceBlockExcel,
    moveAiNotebookBlock,
    pinAiNotebookContext,
    retryAiPrompt,
    submitAiPrompt,
    tryDifferentAiModel,
  ]);

  const aiModelOptions = useMemo(() => enabledAiModels.map((model) => ({
    id: model.id,
    label: model.label,
  })), [enabledAiModels]);

  const aiSeasonOptions = useMemo(() => seasons.map((item) => ({
    id: item.id,
    seasonCode: item.seasonCode,
  })), [seasons]);

  function handleDailyTrendDoubleClick(date: string) {
    if (!season || !date) return;
    const params = new URLSearchParams();
    params.set('season', season.id);
    params.set('date', date);
    router.push(`/daily?${params.toString()}`);
  }

  const routeToSeason = (path: string) => {
    router.push(season ? `${path}?season=${season.id}` : path);
  };

  if (loading) {
    return <LoadingStatusPanel progress={loadProgress} mode="fullscreen" icon="analytics" />;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface text-on-surface font-sans">
      <div className="flex h-dvh min-w-0 flex-1 flex-col bg-surface">
        <header className="z-30 flex flex-none items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 shadow-sm backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <h1 className="font-h3 text-h3 text-on-surface">Seasonal Dashboard</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">{season ? buildSeasonDisplayLabel(season) : 'Chưa chọn mùa bay'}</p> 
          </div>
          <div className="flex items-center gap-3">
            <select
              value={season?.id ?? ''}
              onChange={(event) => router.push(`${dashboardRoute}?season=${event.target.value}`)}
              disabled={seasons.length === 0}
              className="min-w-[200px] rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm font-medium text-on-surface"
            >
              {seasons.length === 0 ? (
                <option value="">Không có mùa bay</option>
              ) : seasons.map((item) => (
                <option key={item.id} value={item.id}>{buildSeasonDisplayLabel(item)}</option> 
              ))}
            </select>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {dataSource ?? 'chưa có'}
            </span>
            {season && (
              <>
                <FetchServerUpdatesButton
                  fetching={fetchingServerData}
                  progress={fetchProgress}
                  disabled={syncInProgress || loading}
                  onFetch={fetchServerData}
                />
                <SyncActionButton
                  syncing={syncInProgress}
                  pendingCount={syncPendingCount}
                  progress={syncProgress}
                  onSync={handleSync}
                />
              </>
            )}
          </div>
        </header>

        <main ref={dashboardScrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {fetchUpdateNotice && (
            <section
              className={`rounded-lg border px-4 py-3 text-sm font-medium ${
                fetchUpdateNotice.tone === 'warning'
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              <div className="font-semibold">{fetchUpdateNotice.title}</div>
              <div className="mt-1">{fetchUpdateNotice.message}</div>
            </section>
          )}
          {error && (
            <section className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </section>
          )}

          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Bảng điều khiển</div>
                <div className="mt-1 grid grid-cols-1 rounded-lg border border-outline-variant bg-surface p-1 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => setDashboardView('operations')}
                    className={`inline-flex min-h-11 min-w-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-semibold sm:justify-center ${dashboardView === 'operations' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">monitoring</span>
                    <span className="min-w-0 truncate">Vận hành ca trực</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDashboardView('comparison')}
                    className={`inline-flex min-h-11 min-w-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-semibold sm:justify-center ${dashboardView === 'comparison' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">analytics</span>
                    <span className="min-w-0 truncate">So sánh sản lượng</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDashboardView('ai-workspace')}
                    className={`inline-flex min-h-11 min-w-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-semibold sm:justify-center ${dashboardView === 'ai-workspace' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">dashboard_customize</span>
                    <span className="min-w-0 truncate">AI Workspace</span>
                  </button>
                </div>
              </div>
              <div className="text-left text-xs font-semibold text-on-surface-variant sm:text-right">
                <div>{season?.seasonCode ?? 'Mùa bay'} ưu tiên vận hành</div>
                <div>{formatValue(overview.records.length)} chuyến sau lọc từ {formatValue(dashboardRecords.length)} bản ghi Dashboard</div>
              </div>
            </div>
          </section>

          {dashboardView === 'operations' && (
            <>
              <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
                <div className="grid gap-3 md:grid-cols-4">
                  <label className="text-xs font-semibold uppercase text-on-surface-variant">
                    Ngày vận hành
                    <select
                      value={activeOperationalDate}
                      onChange={(event) => setOperationalDate(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case text-on-surface"
                    >
                      {operationalDateOptions.length === 0
                        ? <option value="">Không có ngày</option>
                        : operationalDateOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase text-on-surface-variant">
                    Bucket
                    <select
                      value={operationalBucketSize}
                      onChange={(event) => setOperationalBucketSize(Number(event.target.value) as OperationalDashboardBucketSize)}
                      className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case text-on-surface"
                    >
                      <option value={60}>1h</option>
                      <option value={30}>30 phút</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase text-on-surface-variant">
                    Time basis
                    <select
                      value={timeBasis}
                      onChange={(event) => setTimeBasis(event.target.value as DashboardTimeBasis)}
                      className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case text-on-surface"
                    >
                      <option value="local">Local STA/STD</option>
                      <option value="utc">UTC</option>
                    </select>
                  </label>
                  <div className="rounded-lg border border-outline-variant bg-surface px-3 py-2">
                    <div className="text-xs font-semibold uppercase text-on-surface-variant">Operational window</div>
                    <div className="mt-1 text-sm font-bold text-on-surface">05:00 -&gt; 04:59 +1</div>
                    <div className="mt-1 text-xs text-on-surface-variant">{activeOperationalDate || 'Chưa có ngày vận hành'}</div>
                  </div>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
                {[
                  { label: 'ARR flights', value: formatValue(operationalDashboard.kpis.arrivalFlights), sub: operationalDashboard.arrivals.peakBucket?.label ?? '-' },
                  { label: 'DEP flights', value: formatValue(operationalDashboard.kpis.departureFlights), sub: operationalDashboard.departures.peakBucket?.label ?? '-' },
                  { label: 'Total flights', value: formatValue(operationalDashboard.kpis.totalFlights), sub: `${formatValue(operationalDashboard.kpis.totalPax)} pax` },
                  { label: 'A-D gap', value: formatDelta(operationalDashboard.kpis.adGapFlights), sub: 'ARR vs DEP' },
                  { label: 'Peak ARR bucket', value: operationalDashboard.kpis.peakArrivalBucket?.label ?? '-', sub: `${formatValue(operationalDashboard.kpis.peakArrivalBucket?.flights ?? 0)} flights` },
                  { label: 'Peak DEP bucket', value: operationalDashboard.kpis.peakDepartureBucket?.label ?? '-', sub: `${formatValue(operationalDashboard.kpis.peakDepartureBucket?.flights ?? 0)} flights` },
                  { label: 'Pax coverage', value: formatPct(operationalDashboard.paxCoverage.coveragePct), sub: `${formatValue(operationalDashboard.paxCoverage.available)} / ${formatValue(operationalDashboard.paxCoverage.totalFlights)}` },
                  { label: 'Pax missing > 1 ngày', value: formatValue(operationalDashboard.paxCoverage.missingAfterOneDay), sub: `${formatValue(operationalDashboard.paxCoverage.plannedZero)} planned zero` },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm">
                    <div className="text-xs font-semibold uppercase text-on-surface-variant">{item.label}</div>
                    <div className="mt-1 truncate text-xl font-bold tabular-nums text-on-surface">{item.value}</div>
                    <div className="mt-1 truncate text-xs text-on-surface-variant">{item.sub}</div>
                  </div>
                ))}
              </section>

              <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
                <section className="grid gap-3 lg:grid-cols-2">
                  {[
                    { title: 'ARR timeline (Type=A)', timeline: operationalDashboard.arrivals },
                    { title: 'DEP timeline (Type=D)', timeline: operationalDashboard.departures },
                  ].map(({ title, timeline }) => {
                    const maxFlights = Math.max(1, ...timeline.buckets.map((bucket) => Math.max(bucket.flights, bucket.baselineFlights)));
                    return (
                      <section key={title} className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <h2 className="text-sm font-bold text-on-surface">{title}</h2>
                            <p className="text-xs text-on-surface-variant">Bucket {operationalBucketSize === 60 ? '1h' : '30 phút'} | baseline cùng thứ trong tháng</p>
                          </div>
                          <div className="text-right text-xs font-semibold text-on-surface-variant">
                            {formatValue(timeline.totals.flights)} flights
                          </div>
                        </div>
                        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                          {timeline.buckets.map((bucket) => {
                            const width = `${Math.max(3, bucket.flights / maxFlights * 100)}%`;
                            const baselineWidth = `${Math.max(3, bucket.baselineFlights / maxFlights * 100)}%`;
                            return (
                              <div key={bucket.index} className="grid grid-cols-[52px_minmax(0,1fr)_84px] items-center gap-2 text-xs">
                                <span className="font-semibold tabular-nums text-on-surface-variant">{bucket.label}</span>
                                <span className="min-w-0">
                                  <span className="block h-2 rounded-full bg-surface-container-high">
                                    <span className="block h-2 rounded-full bg-primary" style={{ width }} />
                                  </span>
                                  <span className="mt-1 block h-1 rounded-full bg-surface-container-high">
                                    <span className="block h-1 rounded-full bg-amber-500" style={{ width: baselineWidth }} />
                                  </span>
                                </span>
                                <span className="text-right tabular-nums text-on-surface">
                                  <span className="font-bold">{formatValue(bucket.flights)}</span>
                                  <span className={bucket.deltaFlights >= 0 ? 'ml-1 text-emerald-700' : 'ml-1 text-red-700'}>{formatDelta(bucket.deltaFlights)}</span>
                                  <span className="block text-[10px] text-on-surface-variant">{formatValue(bucket.pax)} pax</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-on-surface">Alert panel</h2>
                      <p className="text-xs text-on-surface-variant">Theo ngưỡng Dashboard Alerts</p>
                    </div>
                    <span className="rounded-full border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface-variant">{operationalDashboard.alerts.length} alerts</span>
                  </div>
                  <div className="space-y-2">
                    {operationalDashboard.alerts.length === 0 ? (
                      <div className="rounded-md border border-dashed border-outline-variant px-3 py-8 text-center text-sm text-on-surface-variant">Không có cảnh báo theo ngưỡng hiện tại. Kiểm tra lại ngày vận hành hoặc ngưỡng Dashboard Alerts nếu cần theo dõi chặt hơn.</div>
                    ) : operationalDashboard.alerts.map((alert) => (
                      <div key={alert.id} className={`rounded-md border px-3 py-2 text-sm ${alert.severity === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : alert.severity === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>
                        <div className="font-semibold">{alert.kind}</div>
                        <div className="mt-1 text-xs">{alert.message}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </section>

              <section className="grid gap-3 xl:grid-cols-2">
                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-on-surface">Xu hướng chuyến bay theo ngày</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">{activeOperationalDate.slice(0, 7) || '-'}</span>
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <div className="flex h-44 min-w-[720px] items-end gap-1">
                      {operationalDailyRows.map((row) => (
                        <button
                          key={row.date}
                          type="button"
                          onDoubleClick={() => handleDailyTrendDoubleClick(row.date)}
                          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm hover:bg-surface-container"
                          title={`${row.date}: ${row.flights} flights`}
                        >
                          <span className="w-full rounded-t bg-primary" style={{ height: trendBarHeight(row.flights, operationalDailyMaxFlights) }} />
                          <span className="text-[10px] tabular-nums text-on-surface-variant">{row.date.slice(8, 10)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-bold text-on-surface">Peak Day Heatmap</h2>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-on-surface-variant">ARR + DEP</span>
                      <select
                        value={activePeakDayMonth}
                        onChange={(event) => setOperationalPeakDayMonth(event.target.value)}
                        className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        {operationalMonthOptions.length === 0
                          ? <option value={activePeakDayMonth}>{activePeakDayMonth || 'Không có tháng'}</option>
                          : operationalMonthOptions.map((month) => <option key={month.key} value={month.key}>{month.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] font-semibold text-on-surface-variant">
                    <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ring-1 ${HEATMAP_CELL_TONES[0]}`} />Thấp trong tuần</span>
                    <span className="inline-flex items-center gap-1"><span className={`size-3 rounded-sm ring-1 ${HEATMAP_CELL_TONES[HEATMAP_CELL_TONES.length - 1]}`} />Cao trong tuần</span>
                    <span className="text-red-700 dark:text-red-300">Số đỏ: cao nhất tháng</span>
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <div className="grid min-w-[520px] grid-cols-7 gap-1">
                      {MONDAY_FIRST_WEEKDAY_COLUMNS.map((weekday) => (
                        <div key={weekday.key} className="rounded bg-surface-container px-2 py-1 text-center text-[10px] font-bold text-on-surface-variant">
                          {weekday.label}
                        </div>
                      ))}
                      {peakDayCalendarCells.map(({ key, date, cell, weekMinFlights, weekMaxFlights, isMonthHigh }) => (
                        cell ? (
                          <button
                            key={key}
                            type="button"
                            onDoubleClick={() => handleDailyTrendDoubleClick(cell.operationalDate)}
                            className={`min-h-16 rounded-md p-2 text-left ring-1 ${peakDayWeekTone(cell.totalFlights, weekMinFlights, weekMaxFlights)}`}
                            title={`${cell.operationalDate}: ${cell.totalFlights} flights`}
                          >
                            <span className="block text-[10px] font-semibold">{cell.operationalDate.slice(8, 10)}</span>
                            <span className={`mt-1 block text-sm font-bold tabular-nums ${isMonthHigh ? 'text-red-700 dark:text-red-300' : ''}`}>{formatValue(cell.totalFlights)}</span>
                            <span className="block text-[10px]">A {cell.arrivals} / D {cell.departures}</span>
                          </button>
                        ) : (
                          <div
                            key={key}
                            className="min-h-16 rounded-md border border-dashed border-outline-variant bg-surface-container-low"
                            title={date ? `${date}: 0 flights` : 'Ngày ngoài tháng'}
                          >
                            {date ? <span className="block p-2 text-[10px] font-semibold text-on-surface-variant">{date.slice(8, 10)}</span> : null}
                          </div>
                        )
                      ))}
                    </div>
                  </div>
                </section>
              </section>

              <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-on-surface">Peak Hour Heatmap</h2>
                    <p className="text-xs text-on-surface-variant">{operationalBucketSize === 60 ? '1h' : '30 phút'} | {timeBasis === 'local' ? 'Local STA/STD' : 'UTC'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={operationalPeakHourTypeFilter}
                      onChange={(event) => setOperationalPeakHourTypeFilter(event.target.value as DashboardTypeFilter)}
                      className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="all">Chuyến đến + đi</option>
                      <option value="A">Chuyến đến</option>
                      <option value="D">Chuyến đi</option>
                    </select>
                    <span className="text-xs font-semibold text-on-surface-variant">05:00 -&gt; 04:59 +1</span>
                  </div>
                </div>
                <div className="space-y-2">
                  {peakHourHeatmapMonths.length === 0 ? (
                    <div className="rounded-md border border-dashed border-outline-variant p-4 text-sm text-on-surface-variant">Không có dữ liệu tháng trong mùa.</div>
                  ) : peakHourHeatmapMonths.map((month) => (
                    <details key={month.key} open={month.key === activeOperationalMonth} className="rounded-md border border-surface-variant bg-surface p-3">
                      <summary className="cursor-pointer select-none rounded-sm focus:outline-none focus:ring-2 focus:ring-primary">
                        <div className="inline-flex w-[calc(100%-1.25rem)] items-center justify-between gap-3 align-middle">
                          <span className="text-sm font-bold text-on-surface">{month.label}</span>
                          <span className="text-xs font-semibold tabular-nums text-on-surface-variant">{formatValue(month.totalFlights)} chuyến</span>
                        </div>
                      </summary>
                      <div className="mt-3 overflow-x-auto">
                        <div className="min-w-[920px] space-y-1">
                          <div className="grid gap-1" style={{ gridTemplateColumns: `80px repeat(${month.heatmap.buckets.length}, minmax(28px, 1fr))` }}>
                            <div />
                            {month.heatmap.buckets.map((bucket) => (
                              <div key={bucket.index} className="truncate text-center text-[10px] font-semibold tabular-nums text-on-surface-variant">{bucket.label}</div>
                            ))}
                          </div>
                          {month.heatmap.dates.map((date) => (
                            <div key={date} className="grid gap-1" style={{ gridTemplateColumns: `80px repeat(${month.heatmap.buckets.length}, minmax(28px, 1fr))` }}>
                              <button type="button" onDoubleClick={() => handleDailyTrendDoubleClick(date)} className="truncate rounded px-1 text-left text-xs font-semibold tabular-nums text-on-surface-variant hover:bg-surface-container">{date}</button>
                              {month.heatmap.buckets.map((bucket) => {
                                const cell = month.cellMap.get(`${date}|${bucket.index}`);
                                const flights = cell?.totalFlights ?? 0;
                                return (
                                  <div
                                    key={`${date}-${bucket.index}`}
                                    className={`flex h-8 items-center justify-center rounded text-[10px] font-bold tabular-nums ring-1 ${heatmapCellTone(flights, peakHourMaxFlights)}`}
                                    title={`${date} ${bucket.label}: ${flights} flights`}
                                  >
                                    {flights > 0 ? formatValue(flights) : ''}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
              </section>

              <section className="grid gap-3 xl:grid-cols-2">
                {operationalBucketDrilldownCards.map((card) => (
                  <details key={card.label} open className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
                    <summary className="mb-3 cursor-pointer select-none rounded-md focus:outline-none focus:ring-2 focus:ring-primary">
                      <div className="inline-flex w-[calc(100%-1.25rem)] items-center justify-between gap-3 align-middle">
                        <div>
                          <h2 className="text-sm font-bold text-on-surface">{card.label}</h2>
                          <p className="text-xs text-on-surface-variant">{card.bucketLabel} | {formatValue(card.flights)} flights</p>
                        </div>
                        <span className="text-xs font-semibold text-on-surface-variant">Thu gọn/mở rộng</span>
                      </div>
                    </summary>
                    <div className="grid gap-3 md:grid-cols-3">
                      {card.dimensions.map((dimensionCard) => (
                        <div key={dimensionCard.label} className="rounded-md border border-surface-variant bg-surface p-3">
                          <div className="mb-2 text-xs font-semibold uppercase text-on-surface-variant">{dimensionCard.label}</div>
                          <div className="space-y-2">
                            {dimensionCard.rows.length === 0 ? (
                              <div className="text-xs text-on-surface-variant">Không có dữ liệu theo ngày/bucket đang chọn.</div>
                            ) : dimensionCard.rows.map((row) => (
                              <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-2 text-xs">
                                <span className="truncate font-medium text-on-surface">{row.label}</span>
                                <span className="text-right font-bold tabular-nums text-on-surface">{formatValue(row.flights)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </section>
            </>
          )}
          {dashboardView === 'comparison' && (
            <>
          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(160px,0.9fr)_minmax(260px,1.2fr)_repeat(2,minmax(160px,1fr))]">
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Chỉ số
                <select value={metric} onChange={(event) => setMetric(event.target.value as DashboardMetric)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {METRICS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                So sánh: MoM / WoW
                <div className="mt-1 grid grid-cols-1 rounded-lg border border-outline-variant bg-surface p-1 normal-case tracking-normal sm:grid-cols-3">
                  <button type="button" onClick={() => setComparisonMode('mom')} className={`min-h-11 rounded-md px-3 py-2 text-sm font-semibold ${comparisonMode === 'mom' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
                    MoM
                  </button>
                  <button type="button" onClick={() => setComparisonMode('wow')} className={`min-h-11 rounded-md px-3 py-2 text-sm font-semibold ${comparisonMode === 'wow' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
                    WoW
                  </button>
                  <button type="button" onClick={() => setComparisonMode('yoy')} className={`min-h-11 rounded-md px-3 py-2 text-sm font-semibold ${comparisonMode === 'yoy' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
                    YoY
                  </button>
                </div>
              </div>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Cấp YoY
                <select value={comparisonGranularity} onChange={(event) => setComparisonGranularity(event.target.value as DashboardComparisonGranularity)} disabled={comparisonMode !== 'yoy'} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface disabled:opacity-60">
                  <option value="month">Tháng</option>
                  <option value="year">Năm</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Loại chuyến
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as DashboardTypeFilter)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {TYPE_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Time basis
                <select value={timeBasis} onChange={(event) => setTimeBasis(event.target.value as DashboardTimeBasis)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  <option value="local">Local STA/STD</option>
                  <option value="utc">UTC</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Dimension
                <select value={dimension} onChange={(event) => setDimension(event.target.value as DashboardDimension)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {DRIVER_TABS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Kỳ hiện tại
                <select value={activeCurrentPeriod} onChange={(event) => setCurrentPeriod(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {periodOptions.length === 0 ? <option value="">Không có kỳ</option> : periodOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Kỳ trước
                <select value={activePreviousPeriod} onChange={(event) => setPreviousPeriod(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {activePreviousPeriod === '' && <option value="">Không có kỳ trước</option>}
                  {periodOptions.length === 0 ? <option value="">Không có kỳ</option> : periodOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </label>
            </div>
          </section>
          {metric === 'pax' && (
            <section className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              Pax coverage: {formatPct(comparisonPaxCoverage.coveragePct)}. Pax missing &gt; 1 ngày: {formatValue(comparisonPaxCoverage.missingAfterOneDay)}.
            </section>
          )}

          <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
            {[
              { label: 'Hiện tại', value: formatValue(comparison?.current.total ?? 0), sub: comparison?.periodLabels.current ?? '-' },
              { label: 'Kỳ trước', value: formatValue(comparison?.previous.total ?? 0), sub: comparison?.periodLabels.previous ?? '-' },
              { label: 'Chênh lệch', value: formatDelta(comparison?.delta ?? 0), sub: comparison?.periodLabels.current ?? '-' },
              { label: 'Chênh lệch %', value: formatPct(comparison?.deltaPct ?? null), sub: comparison?.periodLabels.previous ?? '-' },
              { label: 'Tăng mạnh nhất', value: topGain ? topGain.label : '-', sub: topGain ? formatDelta(topGain.delta) : '-' },
              { label: 'Kéo giảm nhất', value: topDrag ? topDrag.label : '-', sub: topDrag ? formatDelta(topDrag.delta) : '-' },
              { label: 'Top CTG', value: topCtg ? topCtg.label : '-', sub: topCtg ? formatPointPct(topCtg.ctgPct) : '-' },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{item.label}</div>
                <div className="mt-1 truncate text-xl font-bold text-on-surface">{item.value}</div>
                <div className="mt-1 truncate text-xs text-on-surface-variant">{item.sub}</div>
              </div>
            ))}
          </section>

          <section className="grid gap-3 xl:grid-cols-12">
            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-on-surface">Thác nước biến động</h2>
                  <p className="text-xs text-on-surface-variant">{comparison?.periodLabels.current ?? '-'} so với {comparison?.periodLabels.previous ?? '-'}</p>
                </div>
                <div className="text-right text-xs font-semibold text-on-surface-variant">
                  Tổng {formatDelta(comparison?.delta ?? 0)}
                </div>
              </div>
              <div className="space-y-2">
                {waterfallRows.map((row) => {
                  const delta = row.topDriver?.delta ?? 0;
                  const width = `${Math.max(6, Math.abs(delta) / maxWaterfallDelta * 100)}%`;
                  return (
                    <button
                      type="button"
                      key={row.value}
                      onClick={() => setDimension(row.value)}
                      className="grid min-h-11 w-full grid-cols-[92px_minmax(0,1fr)_90px] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-container"
                    >
                      <span className="text-xs font-semibold text-on-surface-variant">{row.label}</span>
                      <span className="min-w-0">
                        <span className="mb-1 flex items-center justify-between text-xs">
                          <span className="truncate font-medium text-on-surface">{row.topDriver?.label ?? '-'}</span>
                          <span className="text-on-surface-variant">tổng {formatDelta(row.reconciledDelta)}</span>
                        </span>
                        <span className="block h-2 rounded-full bg-surface-container-high">
                          <span className={`block h-2 rounded-full ${delta >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width }} />
                        </span>
                      </span>
                      <span className={`text-right text-sm font-bold ${delta >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatDelta(delta)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold text-on-surface">Dịch chuyển cơ cấu</h2>
                <span className="text-xs font-semibold text-on-surface-variant">{dimensionLabel}</span>
              </div>
              <div className="space-y-3">
                {topMixRows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-outline-variant px-3 py-8 text-center text-sm text-on-surface-variant">Không có dữ liệu cơ cấu cho kỳ và bộ lọc hiện tại.</div>
                ) : topMixRows.map((driver) => (
                  <button key={driver.key} type="button" onClick={() => setSelectedDriverKey(driver.key)} className="min-h-11 w-full rounded-md px-2 py-2 text-left hover:bg-surface-container">
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                      <span className="truncate font-semibold text-on-surface">{driver.label}</span>
                      <span className="text-on-surface-variant">{formatPointPct(driver.shareShift)}</span>
                    </div>
                    <div className="grid gap-1">
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-[10px] font-semibold text-on-surface-variant">Trước</span>
                        <span className="h-2 flex-1 rounded-full bg-surface-container-high">
                          <span className="block h-2 rounded-full bg-slate-400" style={{ width: `${driver.previousShare / maxMixShare * 100}%` }} />
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-[10px] font-semibold text-on-surface-variant">Hiện</span>
                        <span className="h-2 flex-1 rounded-full bg-surface-container-high">
                          <span className="block h-2 rounded-full bg-primary" style={{ width: `${driver.currentShare / maxMixShare * 100}%` }} />
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-12">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-on-surface">Xếp hạng CTG</h2>
                  <p className="text-xs text-on-surface-variant">Hiện tại, kỳ trước, chênh lệch, CTG và dịch chuyển cơ cấu</p>
                </div>
                <div className="flex flex-wrap gap-1" aria-label="Nhóm tác nhân">
                  {DRIVER_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setDimension(tab.value)}
                      className={`inline-flex min-h-10 items-center gap-1 rounded-full border px-3 py-2 text-xs font-semibold ${dimension === tab.value ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container'}`}
                    >
                      <span className="material-symbols-outlined text-[15px]">{tab.icon}</span>
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
              <details open>
                <summary className="mb-2 cursor-pointer select-none rounded-md text-xs font-semibold uppercase tracking-wide text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary">
                  Nhóm tác nhân | {formatValue(ctgRankedDrivers.length)} dòng
                </summary>
                <div className="max-h-[420px] overflow-auto rounded-lg border border-surface-variant">
                  <table className="min-w-[860px] w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant shadow-sm">
                      <tr>
                        <th className="px-3 py-2 text-left">Tác nhân</th>
                        <th className="px-3 py-2 text-right">Hiện tại</th>
                        <th className="px-3 py-2 text-right">Kỳ trước</th>
                        <th className="px-3 py-2 text-right">Chênh lệch</th>
                        <th className="px-3 py-2 text-right">Chênh lệch %</th>
                        <th className="px-3 py-2 text-right">CTG</th>
                        <th className="px-3 py-2 text-right">Dịch chuyển cơ cấu</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-variant bg-surface">
                      {ctgRankedDrivers.slice(0, 12).map((driver) => (
                        <tr key={driver.key} onClick={() => setSelectedDriverKey(driver.key)} className={`cursor-pointer hover:bg-surface-container ${selectedDriver?.key === driver.key ? 'bg-primary/5' : ''}`}>
                          <td className="max-w-[180px] truncate px-3 py-2 font-semibold text-on-surface">{driver.label}</td>
                          <td className="px-3 py-2 text-right text-on-surface">{formatValue(driver.currentValue)}</td>
                          <td className="px-3 py-2 text-right text-on-surface">{formatValue(driver.previousValue)}</td>
                          <td className={`px-3 py-2 text-right font-bold ${driver.delta >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatDelta(driver.delta)}</td>
                          <td className="px-3 py-2 text-right text-on-surface-variant">{formatPct(driver.deltaPct)}</td>
                          <td className="px-3 py-2 text-right text-on-surface-variant">{formatPointPct(driver.ctgPct)}</td>
                          <td className="px-3 py-2 text-right text-on-surface-variant">{formatPointPct(driver.shareShift)}</td>
                        </tr>
                      ))}
                      {ctgRankedDrivers.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-on-surface-variant">Không có dòng xếp hạng cho kỳ đã chọn. Đổi kỳ so sánh hoặc nới bộ lọc để có dữ liệu.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>

            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold text-on-surface">Xu hướng chuyến bay theo tháng</h2>
                <span className="text-xs font-semibold text-on-surface-variant">Toàn mùa | {comparisonTrendMetricLabel}</span>
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="flex h-44 min-w-[520px] items-end gap-2">
                  {comparisonMonthlyTrendRows.map((row) => (
                    <button
                      key={row.key}
                      type="button"
                      onClick={() => setComparisonTrendMonth(row.key)}
                      className={`flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm px-1 pb-1 focus:outline-none focus:ring-2 focus:ring-primary ${row.key === activeComparisonTrendMonth ? 'bg-primary/10' : 'hover:bg-surface-container'}`}
                      title={`${row.label}: ${formatValue(row.value)} ${comparisonTrendMetricLabel}`}
                    >
                      <span className={`w-full rounded-t ${row.key === activeComparisonTrendMonth ? 'bg-primary' : 'bg-primary/70'}`} style={{ height: trendBarHeight(row.value, comparisonMaxMonthlyTrend) }} />
                      <span className="max-w-full truncate text-[10px] font-semibold text-on-surface-variant">{row.label}</span>
                    </button>
                  ))}
                  {comparisonMonthlyTrendRows.length === 0 && (
                    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-outline-variant px-3 text-center text-sm text-on-surface-variant">Không có dữ liệu xu hướng trong mùa hiện tại.</div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold text-on-surface">Xu hướng chuyến bay theo ngày</h2>
                <span className="text-xs font-semibold text-on-surface-variant">{periodLabel(activeComparisonTrendMonth, 'mom')} | {comparisonTrendMetricLabel}</span>
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="flex h-44 min-w-[720px] items-end gap-1">
                  {comparisonDailyTrendRows.map((row) => (
                    <button
                      key={row.key}
                      type="button"
                      onDoubleClick={() => handleDailyTrendDoubleClick(row.key)}
                      className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-sm hover:bg-surface-container"
                      title={`${row.key}: ${formatValue(row.value)} ${comparisonTrendMetricLabel}`}
                    >
                      <span className="w-full rounded-t bg-primary" style={{ height: trendBarHeight(row.value, comparisonMaxDailyTrend) }} />
                      <span className="text-[10px] tabular-nums text-on-surface-variant">{row.day ?? row.key.slice(8, 10)}</span>
                    </button>
                  ))}
                  {comparisonDailyTrendRows.length === 0 && (
                    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-outline-variant px-3 text-center text-sm text-on-surface-variant">Không có dữ liệu xu hướng theo tháng đã chọn.</div>
                  )}
                </div>
              </div>
            </section>

            <details open className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-12">
              <summary className="mb-3 cursor-pointer select-none rounded-md text-sm font-bold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary">
                Drill-down tác nhân đã chọn | {selectedDriver?.label ?? '-'}
              </summary>
              <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_260px]">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Tác nhân đã chọn</div>
                  <div className="mt-1 text-2xl font-bold text-on-surface">{selectedDriver?.label ?? '-'}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-surface px-3 py-2">
                      <div className="text-xs text-on-surface-variant">Hiện tại</div>
                      <div className="font-bold">{formatValue(selectedDriver?.currentValue ?? 0)}</div>
                    </div>
                    <div className="rounded-md bg-surface px-3 py-2">
                      <div className="text-xs text-on-surface-variant">Kỳ trước</div>
                      <div className="font-bold">{formatValue(selectedDriver?.previousValue ?? 0)}</div>
                    </div>
                    <div className="rounded-md bg-surface px-3 py-2">
                      <div className="text-xs text-on-surface-variant">Chênh lệch</div>
                      <div className={`font-bold ${(selectedDriver?.delta ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatDelta(selectedDriver?.delta ?? 0)}</div>
                    </div>
                    <div className="rounded-md bg-surface px-3 py-2">
                      <div className="text-xs text-on-surface-variant">Dịch chuyển cơ cấu</div>
                      <div className="font-bold">{formatPointPct(selectedDriver?.shareShift ?? null)}</div>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-on-surface">Drill-down theo ngày vận hành</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">{dimensionLabel}</span>
                  </div>
                  <div className="max-h-[420px] overflow-auto rounded-lg border border-surface-variant">
                    <table className="min-w-[720px] w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant shadow-sm">
                        <tr>
                          <th className="px-3 py-2 text-left">Ngày vận hành</th>
                          <th className="px-3 py-2 text-right">Flights</th>
                          <th className="px-3 py-2 text-right">ARR</th>
                          <th className="px-3 py-2 text-right">DEP</th>
                          <th className="px-3 py-2 text-right">Pax</th>
                          <th className="px-3 py-2 text-right">Daily Schedule</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-variant bg-surface">
                        {selectedDriverDrilldownRows.map((row) => (
                          <tr key={row.date}>
                            <td className="px-3 py-2 font-semibold tabular-nums">{row.date}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatValue(row.flights)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatValue(row.arrivals)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatValue(row.departures)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatValue(row.pax)}</td>
                            <td className="px-3 py-2 text-right">
                              <button type="button" onClick={() => handleDailyTrendDoubleClick(row.date)} className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-outline-variant px-2 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container">
                                <span className="material-symbols-outlined text-[15px]">open_in_new</span>
                                Mở
                              </button>
                            </td>
                          </tr>
                        ))}
                        {selectedDriverDrilldownRows.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-3 py-8 text-center text-on-surface-variant">Không có dữ liệu tổng hợp cho tác nhân đã chọn. Chọn tác nhân khác hoặc đổi kỳ so sánh.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="flex flex-col justify-between gap-3">
                  <div className="rounded-md border border-surface-variant bg-surface px-3 py-3 text-sm">
                    <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Kỳ kiểm tra</div>
                    <div className="mt-1 font-semibold text-on-surface">{comparison?.periodLabels.current ?? '-'} so với {comparison?.periodLabels.previous ?? '-'}</div>
                    <div className="mt-1 text-xs text-on-surface-variant">{typeFilter === 'all' ? 'Toàn bộ lưu lượng' : typeFilter === 'A' ? 'Chỉ ARR' : 'Chỉ DEP'} | {timeBasis === 'local' ? 'Local +7' : 'UTC'}</div>
                  </div>
                  <div className="grid gap-2">
                    <button type="button" onClick={() => routeToSeason('/detailed')} disabled={!season} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary disabled:opacity-50">
                      <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                      Lịch chi tiết
                    </button>
                    <button type="button" onClick={() => routeToSeason('/daily')} disabled={!season} className="inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-semibold text-on-surface disabled:opacity-50">
                      <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                      Lịch ngày
                    </button>
                  </div>
                </div>
              </div>
            </details>
          </section>
            </>
          )}

          {dashboardView === 'ai-workspace' && (
            <AiWorkspacePanel
              notebook={aiNotebook}
              aiPrompt={aiPrompt}
              setAiPrompt={setAiPrompt}
              aiLoading={aiLoading}
              aiLoadingMessage={aiLoadingMessage}
              aiLoadingStep={aiLoadingStep}
              aiLoadingStartedAt={aiLoadingStartedAt}
              aiError={aiError}
              lastAiPrompt={lastAiPrompt}
              aiConfigured={aiConfigured}
              selectedModelId={selectedAiModel?.id ?? ''}
              models={aiModelOptions}
              onModelChange={setSelectedAiModelId}
              canTryDifferentModel={enabledAiModels.length > 1}
              seasons={aiSeasonOptions}
              selectedSeasonIds={selectedAiSeasonIds}
              onToggleSeason={toggleAiWorkspaceSeason}
              seasonSummaryRows={aiWorkspaceSeasonSummaryRows}
              dataError={aiWorkspaceDataError}
              presets={AI_WORKSPACE_PRESETS}
              rendererData={aiNotebookRendererData}
              actions={aiNotebookActions}
              onCancel={cancelAiPrompt}
              onClearNotebook={clearAiNotebook}
              onDownloadReport={(templateId) => downloadDashboardReport(templateId)}
              summaryExportDisabled={loading || effectiveRecords.length === 0}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default function DashboardPage({ routeBase = '/dashboard' }: { routeBase?: '/' | '/dashboard' } = {}) {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center bg-surface text-on-surface">Đang tải bảng điều khiển...</div>}>
      <DashboardContent routeBase={routeBase} />
    </Suspense>
  );
}
