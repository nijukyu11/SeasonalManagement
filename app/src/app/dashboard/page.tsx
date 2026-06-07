'use client';

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getOperationalSettings, getSeasons } from '@/lib/remoteStore';
import { buildSeasonDisplayLabel } from '@/lib/importSeasonRules';
import {
  buildPeakHourAxisTicks,
  buildDashboardOverview,
  buildDashboardComparison,
  buildEffectiveDashboardRecords,
  getDashboardOperationalDate,
  listDashboardPeriods,
  type DashboardComparisonGranularity,
  type DashboardComparisonMode,
  type DashboardDimension,
  type DashboardMetric,
  type DashboardOverviewDailyRow,
  type DashboardTimeBasis,
  type DashboardTypeFilter,
} from '@/lib/dashboardAnalysis';
import {
  analyzeDashboardWithLocalAgent,
  analyzeDashboardWithAi, 
  appendDashboardAiRunEvent,
  applyDashboardAiResultProfileAndVerification, 
  buildDashboardAiBoardPatchFromQueryResults, 
  buildDashboardAiContext,
  buildDashboardAiFallbackBoardPatch, 
  buildDashboardAiActiveArtifactFromCell,
  buildDashboardAiFollowUpBoardPatchFromCells,
  buildDashboardAiNotebookContext, 
  capDashboardAiNotebookQueryResults,
  capDashboardAiLocalHistory,
  dashboardAiSqlResultToQueryResult,
  inferDashboardAiDataQueryForPrompt,
  inferDashboardAiSemanticIntent,
  isDashboardAiConfigured,
  listEnabledDashboardAiModels,
  normalizeDashboardAiWorkspaceSeasonIds,
  planDashboardAiSqlDrilldownQueries,
  planDashboardAiSqlQueries,
  resolveDashboardAiLocalQueryResults,
  resolveDashboardAiAvailableTools,
  resolveDashboardAiDataScopeForPrompt,
  resolveDashboardAiQueryResults,
  resolveDashboardAiSessionFollowUp,
  resolveDashboardAiWorkflowForPrompt,
  resolveDashboardAiSkillForPrompt,
  resolveDashboardAiModel,
  type DashboardAiExportAction,
  type DashboardAiNotebook,
  type DashboardAiNotebookCell,
  type DashboardAiQueryResult,
  type DashboardAiRunEvent,
  type DashboardAiSqlQueryPlan,
  type DashboardAiToolTraceSummary,
  type DashboardAiToolName,
  type DashboardAiWorkspaceBlock,
  type DashboardAiWaterfallContextRow,
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
import { callNativeDashboardAiAgent, isTauriRuntime, queryNativeDashboardAiSql, queryNativeScheduleWindow } from '@/lib/nativeSeasonRepository';
import { ensureNativeSeasonBaseline } from '@/lib/nativeSeasonBootstrap';
import { useSeasonWorkspaceStore } from '@/lib/seasonWorkspaceStore';
import { buildLoadProgress, type LoadProgress } from '@/lib/importProgress';
import { resolveCountryForRoute } from '@/lib/routeCountry';
import type { AiAnalysisModelSetting, FlightModification, FlightRecord, OperationalSettings, RouteCountryMapping, Season } from '@/lib/types';
import FetchServerUpdatesButton from '../components/FetchServerUpdatesButton';
import { useCachedRouteSearchParams } from '../components/RouteCacheContext';
import { useExportNotifications } from '../components/ExportNotificationProvider';
import LoadingStatusPanel from '../components/LoadingStatusPanel';
import { useSeasonSync } from '../components/SeasonSyncProvider';
import { useSessionScrollRestoration } from '../hooks/useSessionScrollRestoration';
import { useSessionState } from '../hooks/useSessionState';
import { useSeasonWorkspaceRefresh } from '../hooks/useSeasonWorkspaceRefresh';
import { AiWorkspacePanel, type AiWorkspacePreset } from './components/AiWorkspacePanel';
import type { AiNotebookLoadingStep } from './components/AiNotebookCanvas';
import type { AiNotebookRendererData } from './components/AiNotebookBlockRenderers';
import DateRangeFilter from './components/DateRangeFilter';

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
  { value: 'route', label: 'Đường bay', icon: 'route' },
  { value: 'country', label: 'Quốc gia', icon: 'public' },
  { value: 'aircraft', label: 'Tàu bay', icon: 'flight' },
  { value: 'hourBucket', label: 'Thời gian', icon: 'schedule' },
  { value: 'flightNumber', label: 'Số chuyến', icon: 'confirmation_number' },
];

const WATERFALL_DIMENSIONS: Array<{ value: DashboardDimension; label: string }> = [
  { value: 'airline', label: 'Hãng bay' },
  { value: 'country', label: 'Quốc gia' },
  { value: 'route', label: 'Đường bay' },
  { value: 'aircraft', label: 'Loại tàu bay' },
  { value: 'type', label: 'ARR/DEP' },
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
  { label: 'Giải thích tác nhân chính', prompt: 'Giải thích các tác nhân chính trong so sánh dashboard hiện tại bằng tiếng Việt.', mode: 'chat' },
  { label: 'Tìm bất thường', prompt: 'Tìm các điểm bất thường trong dữ liệu dashboard hiện tại và trả lời bằng tiếng Việt.', mode: 'chat' },
  { label: 'Vì sao chỉ số giảm?', prompt: 'Vì sao chỉ số này giảm trong so sánh hiện tại? Trả lời bằng tiếng Việt và nêu số liệu.', mode: 'chat' },
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
const WEEKDAY_LABEL_BY_KEY = new Map(WEEKDAY_COLUMNS.map((weekday) => [weekday.key, weekday.label]));
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
type DashboardView = 'overview' | 'analysis' | 'ai-workspace';

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

function buildDashboardWindowKey(scope: 'overview' | 'ai-workspace' = 'overview'): string {
  return `dashboard:${scope}:full`;
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

function buildAiWorkspaceMultiSeasonCatalogFromData(
  seasonIds: string[],
  seasonData: DashboardAiWorkspaceSeasonData[]
) {
  if (seasonData.length === 0) return null;
  return {
    seasonIds,
    seasons: seasonData.map((item) => {
      const activeRows = item.effectiveRecords.filter((record) => record.status !== 'deleted');
      const dates = activeRows.map((record) => getDashboardOperationalDate(record)).filter(Boolean).sort();
      return {
        seasonId: item.season.id,
        seasonCode: item.season.seasonCode,
        name: item.season.name,
        totalRecords: activeRows.length,
        totalPax: activeRows.reduce((sum, record) => sum + (Number.isFinite(record.pax ?? NaN) ? Number(record.pax) : 0), 0),
        dateRange: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
        months: new Set(dates.map((date) => date.slice(0, 7))).size,
      };
    }),
  };
}

function resolveAiDataSourcePolicyFromSeasonData(seasonData: DashboardAiWorkspaceSeasonData[]) {
  if (seasonData.length === 0) return 'local-sqlite' as const;
  const localCount = seasonData.filter((item) => item.dataSource === 'active' || item.dataSource === 'local').length;
  if (localCount === seasonData.length) return 'local-sqlite' as const;
  if (localCount === 0) return 'supabase-reporting' as const;
  return 'mixed' as const;
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

function emptyDailyTrendRow(date: string): DashboardOverviewDailyRow {
  const parsed = parseIsoDate(date);
  const month = date.slice(0, 7);
  const day = date.slice(8, 10);
  return {
    date,
    month,
    day,
    label: parsed ? `${MONTH_LABELS[parsed.getUTCMonth()] ?? month} ${day}` : date,
    weekday: parsed ? WEEKDAY_KEYS[parsed.getUTCDay()] ?? 'Không rõ' : 'Không rõ',
    arrivals: 0,
    departures: 0,
    total: 0,
    pax: 0,
  };
}

function listPeriods(records: FlightRecord[], mode: DashboardComparisonMode, granularity: DashboardComparisonGranularity = 'month'): Array<{ key: string; label: string }> {
  return listDashboardPeriods(records, mode, granularity);
}

function resolveWorkspacePeriodKey(
  periods: Array<{ key: string }>,
  explicitPeriod?: string,
  monthNumber?: string
): string {
  if (explicitPeriod && periods.some((period) => period.key === explicitPeriod)) return explicitPeriod;
  if (monthNumber) {
    const suffix = `-${monthNumber.padStart(2, '0')}`;
    for (let index = periods.length - 1; index >= 0; index -= 1) {
      if (periods[index].key.endsWith(suffix)) return periods[index].key;
    }
  }
  return '';
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

function weekdayDisplayLabel(weekday: string): string {
  return WEEKDAY_LABEL_BY_KEY.get(weekday) ?? weekday;
}

function heatmapCellTone(flights: number | undefined, maxFlights: number): string {
  if (!flights || flights <= 0 || maxFlights <= 0) {
    return 'bg-surface-container-low text-on-surface-variant ring-outline-variant';
  }
  const ratio = Math.min(1, flights / maxFlights);
  const toneIndex = Math.min(HEATMAP_CELL_TONES.length - 1, Math.max(0, Math.ceil(ratio * HEATMAP_CELL_TONES.length) - 1));
  return HEATMAP_CELL_TONES[toneIndex];
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

  const [seasons, setSeasons] = useState<Season[]>([]);
  const [season, setSeason] = useState<Season | null>(null);
  const [records, setRecords] = useState<FlightRecord[]>([]);
  const [modifications, setModifications] = useState<Map<string, FlightModification>>(new Map());
  const [operationalSettings, setOperationalSettings] = useState<OperationalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>(() =>
    buildLoadProgress('Loading dashboard...', 10, 'Preparing analysis')
  );
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'local' | 'cache' | 'server' | null>(null);
  const [syncMeta, setSyncMeta] = useState<LocalSyncMeta | null>(null);

  const [dashboardView, setDashboardView] = useSessionState<DashboardView>('dashboard:view', 'overview');
  const [metric, setMetric] = useSessionState<DashboardMetric>('dashboard:metric', 'flights');
  const [comparisonMode, setComparisonMode] = useSessionState<DashboardComparisonMode>('dashboard:comparisonMode', 'mom');
  const [comparisonGranularity, setComparisonGranularity] = useSessionState<DashboardComparisonGranularity>('dashboard:comparisonGranularity', 'month');
  const [typeFilter, setTypeFilter] = useSessionState<DashboardTypeFilter>('dashboard:typeFilter', 'all');
  const [timeBasis, setTimeBasis] = useSessionState<DashboardTimeBasis>('dashboard:timeBasis', 'local');
  const [dimension, setDimension] = useSessionState<DashboardDimension>('dashboard:dimension', 'airline');
  const [currentPeriod, setCurrentPeriod] = useSessionState('dashboard:currentPeriod', '');
  const [previousPeriod, setPreviousPeriod] = useSessionState('dashboard:previousPeriod', '');
  const [overviewMonthFrom, setOverviewMonthFrom] = useSessionState('dashboard:overviewMonthFrom', '');
  const [overviewMonthTo, setOverviewMonthTo] = useSessionState('dashboard:overviewMonthTo', '');
  const [overviewAirline, setOverviewAirline] = useSessionState('dashboard:overviewAirline', 'all');
  const [overviewCountry, setOverviewCountry] = useSessionState('dashboard:overviewCountry', 'all');
  const [overviewRoute, setOverviewRoute] = useSessionState('dashboard:overviewRoute', 'all');
  const [overviewDailyMonth, setOverviewDailyMonth] = useSessionState('dashboard:overviewDailyMonth', '');
  const [overviewPeakHourMonth, setOverviewPeakHourMonth] = useSessionState('dashboard:overviewPeakHourMonth', 'all');
  const [dashboardSeasonIds, setDashboardSeasonIds] = useSessionState<string[]>('dashboard:seasonIds', []);
  const [expandedOverviewCountries, setExpandedOverviewCountries] = useState<Set<string>>(new Set());
  const [overviewCountryExpansionTouched, setOverviewCountryExpansionTouched] = useState(false);
  const [selectedDriverKey, setSelectedDriverKey] = useSessionState<string | null>('dashboard:selectedDriverKey', null);
  const [selectedDriverRecordLimit, setSelectedDriverRecordLimit] = useSessionState('dashboard:selectedDriverRecordLimit', 25);
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
  useSessionScrollRestoration('dashboard:scroll', dashboardScrollRef);
  const routeCountries = operationalSettings?.routeCountries;
  const syncSeasonId = season?.id ?? targetSeasonId;
  const { status: syncStatus, fetchUpdatesNow } = useSeasonSync(syncSeasonId, 'dashboard');
  const fetchingUpdates = syncStatus.status === 'catching_up' && syncStatus.mode === 'manual';
  const fetchProgress = fetchingUpdates ? syncStatus.progress ?? syncStatus.message : syncStatus.message;

  const refreshDashboardWindow = useCallback(async () => {
    if (!season?.id) return null;
    const result = await queryNativeScheduleWindow({
      seasonId: season.id,
      limit: 100000,
    });
    if (!result) throw new Error('Native dashboard query is unavailable.');
    const nextModifications = new Map(result.modifications.map((mod) => [mod.legId, mod]));
    setRecords(result.records);
    setModifications(nextModifications);
    setDataSource('local');
    setSyncMeta(result.syncMeta);
    setCachedSeasonData(season.id, {
      rows: [],
      records: result.records,
      modifications: nextModifications,
      seasonDataVersion: season.dataVersion,
    });
    useSeasonWorkspaceStore.getState().replaceSeasonWindow({
      seasonId: season.id,
      season,
      rows: [],
      records: result.records,
      modifications: nextModifications,
      syncMeta: result.syncMeta,
      windowKey: buildDashboardWindowKey('overview'),
    });
    return result;
  }, [season]);

  useSeasonWorkspaceRefresh({
    seasonId: season?.id ?? targetSeasonId,
    policy: 'on-activation',
    source: 'dashboard',
    onNativeRefresh: async () => {
      await refreshDashboardWindow();
    },
  });

  const handleFetchUpdates = useCallback(async () => {
    if (!syncSeasonId || fetchingUpdates) return;
    try {
      const result = await fetchUpdatesNow();
      if (result.status !== 'synced') {
        setError(result.message);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [fetchUpdatesNow, fetchingUpdates, syncSeasonId]);

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

        setLoadProgress(buildLoadProgress('Checking local season baseline', 30, targetSeason.seasonCode));
        await ensureNativeSeasonBaseline(targetSeason);
        if (cancelled) return;
        setLoadProgress(buildLoadProgress('Querying native SQLite', 45, targetSeason.seasonCode));
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
          windowKey: buildDashboardWindowKey('overview'),
        });
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
  }, [dashboardRoute, router, targetSeasonId]);

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
      setDashboardSeasonIds((current) => {
        const valid = new Set(seasons.map((item) => item.id));
        const normalized = normalizeDashboardAiWorkspaceSeasonIds(current.filter((id) => valid.has(id)));
        return normalized.length > 0 ? normalized : [season.id];
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [effectiveRecords, modifications, records, season, seasons, setDashboardSeasonIds, syncMeta]);

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

  const activeDashboardSeasonIds = useMemo(() => {
    const valid = new Set(seasons.map((item) => item.id));
    const normalized = normalizeDashboardAiWorkspaceSeasonIds(dashboardSeasonIds.filter((id) => valid.has(id)));
    return normalized.length > 0 ? normalized : season?.id ? [season.id] : [];
  }, [dashboardSeasonIds, season, seasons]);

  const yoySeasonIds = useMemo(() => (
    comparisonMode === 'yoy' ? resolveYoySeasonIds(seasons, effectiveRecords, season) : []
  ), [comparisonMode, effectiveRecords, season, seasons]);

  const requestedSeasonDataIds = useMemo(() => (
    normalizeDashboardAiWorkspaceSeasonIds([
      ...selectedAiSeasonIds,
      ...activeDashboardSeasonIds,
      ...yoySeasonIds,
    ])
  ), [activeDashboardSeasonIds, selectedAiSeasonIds, yoySeasonIds]);

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

  const dashboardSeasonData = useMemo(() => (
    activeDashboardSeasonIds
      .map((seasonId) => aiWorkspaceSeasonData[seasonId])
      .filter((item): item is DashboardAiWorkspaceSeasonData => Boolean(item))
  ), [activeDashboardSeasonIds, aiWorkspaceSeasonData]);

  const dashboardRecords = useMemo(() => {
    const recordsById = new Map<string, FlightRecord>();
    const sourceRecords = dashboardSeasonData.length > 0
      ? dashboardSeasonData.flatMap((item) => item.effectiveRecords)
      : effectiveRecords;
    for (const record of sourceRecords) recordsById.set(record.id, record);
    return [...recordsById.values()];
  }, [dashboardSeasonData, effectiveRecords]);

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

  const overviewMaxMonthlyFlights = Math.max(1, ...overview.monthlyTrend.map((row) => row.total));
  const overviewDailyMonthOptions = overview.monthlyTrend.map((row) => ({ key: row.key, label: row.label }));
  const defaultOverviewDailyMonth = overviewDailyMonthOptions.some((month) => month.key === overview.kpis.peakMonth.key)
    ? overview.kpis.peakMonth.key
    : overviewDailyMonthOptions.at(-1)?.key ?? '';
  const activeOverviewDailyMonth = overviewDailyMonthOptions.some((month) => month.key === overviewDailyMonth)
    ? overviewDailyMonth
    : defaultOverviewDailyMonth;
  const overviewDailyCalendarRows = (() => {
    const dailyMap = new Map(overview.dailyTrend.map((row) => [row.date, row]));
    return monthDateKeys(activeOverviewDailyMonth).map((date) => dailyMap.get(date) ?? emptyDailyTrendRow(date));
  })();
  const overviewMaxDailyFlights = Math.max(1, ...overviewDailyCalendarRows.map((row) => row.total));
  const overviewDailyTotalFlights = overviewDailyCalendarRows.reduce((sum, row) => sum + row.total, 0);
  const overviewDailyPeakDay = overviewDailyCalendarRows.reduce<DashboardOverviewDailyRow | null>(
    (best, row) => (!best || row.total > best.total ? row : best),
    null
  );
  const overviewDailyWeekdayPeak = (() => {
    const weekdayTotals = new Map<string, number>();
    for (const row of overviewDailyCalendarRows) {
      weekdayTotals.set(row.weekday, (weekdayTotals.get(row.weekday) ?? 0) + row.total);
    }
    return [...weekdayTotals.entries()]
      .sort((a, b) => b[1] - a[1] || WEEKDAY_KEYS.indexOf(a[0]) - WEEKDAY_KEYS.indexOf(b[0]))[0] ?? ['-', 0];
  })();
  const overviewDailyWeekendFlights = overviewDailyCalendarRows
    .filter((row) => row.weekday === 'Sat' || row.weekday === 'Sun')
    .reduce((sum, row) => sum + row.total, 0);
  const overviewMaxAirlineFlights = Math.max(1, ...overview.airlineRanking.slice(0, 8).map((row) => row.flights));
  const overviewMaxCountryRouteFlights = Math.max(1, ...overview.countryRouteContribution.slice(0, 8).map((row) => row.flights));
  const overviewCountryGroups = (() => {
    const groups = new Map<string, {
      country: string;
      flights: number;
      pax: number;
      share: number;
      routes: Array<(typeof overview.countryRouteContribution)[number]>;
    }>();
    for (const row of overview.countryRouteContribution) {
      const current = groups.get(row.country) ?? {
        country: row.country,
        flights: 0,
        pax: 0,
        share: 0,
        routes: [],
      };
      current.flights += row.flights;
      current.pax += row.pax;
      current.share += row.share;
      current.routes.push(row);
      groups.set(row.country, current);
    }
    return [...groups.values()].sort((a, b) => b.flights - a.flights || a.country.localeCompare(b.country));
  })();
  const effectiveExpandedOverviewCountries = (() => {
    const next = new Set(expandedOverviewCountries);
    if (!overviewCountryExpansionTouched && overviewCountryGroups[0]?.country) {
      next.add(overviewCountryGroups[0].country);
    }
    return next;
  })();
  const overviewPeakHourMonthOptions = [{ key: 'all', label: 'Toàn bộ khoảng lọc' }, ...overview.monthlyTrend.map((row) => ({ key: row.key, label: row.label }))];
  const activeOverviewPeakHourMonth = overviewPeakHourMonthOptions.some((month) => month.key === overviewPeakHourMonthForBuild)
    ? overviewPeakHourMonthForBuild
    : 'all';
  const overviewMaxPeakHourAverage = Math.max(1, ...overview.peakHourAverage.map((row) => row.avgFlightsPerDay));
  const overviewPeakHourPeak = overview.peakHourAverage.reduce(
    (best, row) => (row.avgFlightsPerDay > best.avgFlightsPerDay ? row : best),
    overview.peakHourAverage[0] ?? { bucket: '-', flights: 0, arrivals: 0, departures: 0, operatingDays: 0, avgFlightsPerDay: 0, avgArrivalsPerDay: 0, avgDeparturesPerDay: 0 }
  );
  const overviewPeakHourQuietest = overview.peakHourAverage.reduce(
    (best, row) => (row.avgFlightsPerDay < best.avgFlightsPerDay ? row : best),
    overview.peakHourAverage[0] ?? { bucket: '-', flights: 0, arrivals: 0, departures: 0, operatingDays: 0, avgFlightsPerDay: 0, avgArrivalsPerDay: 0, avgDeparturesPerDay: 0 }
  );
  const overviewPeakHourAxisTicks = useMemo(() => buildPeakHourAxisTicks(timeBasis), [timeBasis]);
  const overviewHeatmapRows = useMemo(() => {
    const cellMap = new Map(overview.weekdayHeatmap.map((cell) => [`${cell.month}|${cell.weekday}`, cell]));
    return overview.monthlyTrend.map((month) => ({
      key: month.key,
      label: month.label,
      cells: WEEKDAY_COLUMNS.map((weekday) => cellMap.get(`${month.key}|${weekday.key}`) ?? null),
    }));
  }, [overview.monthlyTrend, overview.weekdayHeatmap]);
  const overviewMaxHeatmapFlights = Math.max(
    1,
    ...overviewHeatmapRows.flatMap((row) => row.cells.map((cell) => cell?.flights ?? 0))
  );

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

  const comparison = useMemo(() => {
    if (!activeCurrentPeriod) return null;
    return buildDashboardComparison({
      records: analysisRecords,
      mode: comparisonMode,
      granularity: comparisonMode === 'yoy' ? comparisonGranularity : 'month',
      metric,
      currentPeriod: activeCurrentPeriod,
      previousPeriod: activePreviousPeriod,
      typeFilter,
      timeBasis,
      dimension,
      routeCountries,
    });
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularity, comparisonMode, dimension, metric, routeCountries, timeBasis, typeFilter]);

  const dimensionLabel = DRIVER_TABS.find((tab) => tab.value === dimension)?.label ?? 'Tác nhân';

  const waterfallRows = useMemo(() => {
    if (!activeCurrentPeriod) return [];
    return WATERFALL_DIMENSIONS.map((item) => {
      const result = buildDashboardComparison({
        records: analysisRecords,
        mode: comparisonMode,
        granularity: comparisonMode === 'yoy' ? comparisonGranularity : 'month',
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
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularity, comparisonMode, metric, routeCountries, timeBasis, typeFilter]);

  const maxWaterfallDelta = Math.max(
    1,
    ...waterfallRows.map((row) => Math.abs(row.topDriver?.delta ?? 0))
  );

  const selectedDriver = useMemo(() => (
    comparison?.drivers.find((driver) => driver.key === selectedDriverKey) ?? comparison?.drivers[0] ?? null
  ), [comparison, selectedDriverKey]);

  const selectedDriverRecords = useMemo(() => {
    if (!selectedDriver) return [];
    return analysisRecords
      .filter((record) => (
        record.status !== 'deleted' &&
        (typeFilter === 'all' || record.type === typeFilter) &&
        (periodKey(record, comparisonMode, comparisonMode === 'yoy' ? comparisonGranularity : 'month') === activeCurrentPeriod || periodKey(record, comparisonMode, comparisonMode === 'yoy' ? comparisonGranularity : 'month') === activePreviousPeriod) &&
        dimensionValue(record, dimension, timeBasis, routeCountries) === selectedDriver.key
      ))
      .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule))
      .slice(0, selectedDriverRecordLimit);
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularity, comparisonMode, dimension, routeCountries, selectedDriver, selectedDriverRecordLimit, timeBasis, typeFilter]);

  const selectedDriverRecordsForAi = useMemo(() => {
    if (!selectedDriver) return [];
    return analysisRecords
      .filter((record) => (
        record.status !== 'deleted' &&
        (typeFilter === 'all' || record.type === typeFilter) &&
        (periodKey(record, comparisonMode, comparisonMode === 'yoy' ? comparisonGranularity : 'month') === activeCurrentPeriod || periodKey(record, comparisonMode, comparisonMode === 'yoy' ? comparisonGranularity : 'month') === activePreviousPeriod) &&
        dimensionValue(record, dimension, timeBasis, routeCountries) === selectedDriver.key
      ))
      .sort((left, right) => left.date.localeCompare(right.date) || left.schedule.localeCompare(right.schedule));
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularity, comparisonMode, dimension, routeCountries, selectedDriver, timeBasis, typeFilter]);

  const topGain = comparison?.drivers.find((driver) => driver.delta > 0) ?? null;
  const topDrag = comparison?.drivers.find((driver) => driver.delta < 0) ?? null;
  const topMixRows = comparison?.drivers.slice(0, 6) ?? [];
  const maxMixShare = Math.max(0.01, ...topMixRows.flatMap((driver) => [driver.currentShare, driver.previousShare]));
  const driverTotalMovement = comparison?.drivers.reduce((sum, driver) => sum + Math.abs(driver.delta), 0) ?? 0;
  const topDriverConcentration = driverTotalMovement === 0 || !comparison?.drivers[0]
    ? null
    : Math.abs(comparison.drivers[0].delta) / driverTotalMovement;

  useEffect(() => {
    setSelectedDriverRecordLimit(25);
  }, [activeCurrentPeriod, activePreviousPeriod, dimension, selectedDriver?.key, setSelectedDriverRecordLimit]);

  const aiWaterfallRows = useMemo<DashboardAiWaterfallContextRow[]>(() => waterfallRows.map((row) => ({
    dimension: row.value,
    label: row.label,
    result: row.result,
    topDriver: row.topDriver,
    reconciledDelta: row.reconciledDelta,
  })), [waterfallRows]);

  const selectedAiWorkspaceSeasonData = useMemo(() => (
    selectedAiSeasonIds
      .map((seasonId) => aiWorkspaceSeasonData[seasonId])
      .filter((item): item is DashboardAiWorkspaceSeasonData => Boolean(item))
  ), [aiWorkspaceSeasonData, selectedAiSeasonIds]);

  const dashboardAiDataSourcePolicy = useMemo(() => {
    if (selectedAiWorkspaceSeasonData.length === 0) return 'local-sqlite' as const;
    const localCount = selectedAiWorkspaceSeasonData.filter((item) => item.dataSource === 'active' || item.dataSource === 'local').length;
    if (localCount === selectedAiWorkspaceSeasonData.length) return 'local-sqlite' as const;
    if (localCount === 0) return 'supabase-reporting' as const;
    return 'mixed' as const;
  }, [selectedAiWorkspaceSeasonData]);

  const aiWorkspaceMultiSeasonCatalog = useMemo(() => {
    if (selectedAiWorkspaceSeasonData.length === 0) return null;
    return {
      seasonIds: selectedAiSeasonIds,
      seasons: selectedAiWorkspaceSeasonData.map((item) => {
        const activeRows = item.effectiveRecords.filter((record) => record.status !== 'deleted');
        const dates = activeRows.map((record) => getDashboardOperationalDate(record)).filter(Boolean).sort();
        const monthCount = new Set(dates.map((date) => date.slice(0, 7))).size;
        return {
          seasonId: item.season.id,
          seasonCode: item.season.seasonCode,
          name: item.season.name,
          totalRecords: activeRows.length,
          totalPax: activeRows.reduce((sum, record) => sum + (Number.isFinite(record.pax ?? NaN) ? Number(record.pax) : 0), 0),
          dateRange: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
          months: monthCount,
        };
      }),
    };
  }, [selectedAiSeasonIds, selectedAiWorkspaceSeasonData]);

  const aiAvailableSeasonCatalog = useMemo(() => seasons.map((item) => ({
    seasonId: item.id,
    seasonCode: item.seasonCode,
    name: item.name,
    dateRange: { from: item.effectiveStart, to: item.effectiveEnd },
  })), [seasons]);

  const dashboardAiContext = useMemo(() => ({
    ...buildDashboardAiContext({
      comparison,
      filters: {
        comparisonMode,
        metric,
        typeFilter,
        dimension,
        timeBasis,
      },
      waterfallRows: aiWaterfallRows,
      selectedDriver,
      selectedDriverRecords: selectedDriverRecordsForAi,
      seasonRecords: effectiveRecords,
      routeCountries,
    }),
    multiSeasonCatalog: aiWorkspaceMultiSeasonCatalog,
    availableSeasonCatalog: aiAvailableSeasonCatalog,
    dataSourcePolicy: dashboardAiDataSourcePolicy,
  }), [aiAvailableSeasonCatalog, aiWaterfallRows, aiWorkspaceMultiSeasonCatalog, comparison, comparisonMode, dashboardAiDataSourcePolicy, dimension, effectiveRecords, metric, routeCountries, selectedDriver, selectedDriverRecordsForAi, timeBasis, typeFilter]);

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
    hasLocalRecords: effectiveRecords.length > 0,
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
        context: dashboardAiContext,
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
  }, [aiNotebook, dashboardAiContext, effectiveRecords, notifyExportCompleted, routeCountries, season?.seasonCode, timeBasis]);

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
      if (sessionFollowUp?.sqlQueryPlans?.length) {
        setAiLoadingStep('query');
        setAiLoadingMessage('Đang truy vấn SQLite local theo ngữ cảnh cell trước...');
        const followUpQueryResults: DashboardAiQueryResult[] = [];
        for (const plan of sessionFollowUp.sqlQueryPlans.slice(0, 4)) {
          throwIfAborted();
          const nativeResult = await queryNativeDashboardAiSql({
            sql: plan.sql,
            params: plan.params,
            limit: 500,
          });
          if (nativeResult) followUpQueryResults.push(dashboardAiSqlResultToQueryResult(plan, nativeResult));
        }
        if (followUpQueryResults.length > 0) {
          setAiLoadingStep('render');
          const boardPatch = buildDashboardAiBoardPatchFromQueryResults(followUpQueryResults, sessionFollowUp.rewrittenPrompt) ?? buildDashboardAiFallbackBoardPatch({
            userPrompt: sessionFollowUp.rewrittenPrompt,
            preferredTool: 'compose_dashboard_ai_board',
          });
          const response = applyDashboardAiResultProfileAndVerification({
            assistantText: sessionFollowUp.assistantText,
            dataRequest: null,
            exportAction: null,
            visualReport: null,
            boardPatch,
            queryResults: followUpQueryResults,
            sqlQueryPlans: [],
            toolTraceSummary: [{
              tool: 'query_dashboard_data',
              status: 'executed',
              reason: 'executed_local_sql: Đã chạy follow-up SQL từ active context của phiên chat.',
              phase: 'executed_local_sql',
              toolset: 'dashboard-readonly',
              ...(selectedSkill ? { skill: selectedSkill.id, contextProfile: selectedSkill.contextProfile } : {}),
            }],
          }, {
            userPrompt: sessionFollowUp.rewrittenPrompt,
            selectedSkillId: selectedSkill?.id,
            contextProfile: selectedSkill?.contextProfile,
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
            message: response.assistantText,
          });
          const nextCellBase: DashboardAiNotebookCell = {
            id: `ai-cell-${cellCreatedAt}`,
            prompt,
            assistantText: response.assistantText,
            blocks: response.boardPatch?.blocks ?? [],
            toolTraceSummary: response.toolTraceSummary,
            exportAction: response.exportAction,
            createdAt: cellCreatedAt,
            modelId: modelForRequest.id,
            runEvents,
            queryResults: response.queryResults,
            resultProfiles: response.resultProfiles,
            answerVerification: response.answerVerification,
          };
          const nextCell: DashboardAiNotebookCell = {
            ...nextCellBase,
            activeArtifact: {
              ...sessionFollowUp.activeArtifact,
              queryIds: response.queryResults.map((result) => result.queryId),
              blockIds: nextCellBase.blocks.map((block) => block.id),
            },
          };
          setAiNotebook((current) => {
            const base = current ?? buildDashboardAiNotebook({
              seasonIds: selectedAiSeasonIds.length > 0 ? selectedAiSeasonIds : season?.id ? [season.id] : [],
              title: response.boardPatch?.title ?? 'Rich Chat AI',
            });
            return {
              ...base,
              title: response.boardPatch?.title ?? base.title,
              cells: [...base.cells, nextCell].slice(-DASHBOARD_AI_NOTEBOOK_MAX_CELLS),
              updatedAt: cellCreatedAt,
            };
          });
          return;
        }
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
            reason: 'rendered_rich_chat: Dùng lại bảng/drilldown SQLite local từ cell trước cho prompt follow-up ngắn.', 
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
      const requestScopedRecords = requestSeasonData.length > 0
        ? requestSeasonData.flatMap((item) => item.effectiveRecords)
        : effectiveRecords;
      const localAiSeasonRows = requestSeasonData.length > 0
        ? requestSeasonData.map((item) => ({
            seasonId: item.season.id,
            seasonCode: item.season.seasonCode,
            records: item.effectiveRecords,
            dataSource: item.dataSource,
            pendingCount: item.syncMeta?.pendingCount ?? 0,
            total: item.total,
            truncated: item.truncated,
          }))
        : requestScopedRecords.length > 0 && season
          ? [{
              seasonId: season.id,
              seasonCode: season.seasonCode,
              records: requestScopedRecords,
              dataSource: 'active' as const,
              pendingCount: syncMeta?.pendingCount ?? 0,
              total: requestScopedRecords.length,
              truncated: false,
            }]
          : [];
      const semanticIntent = inferDashboardAiSemanticIntent({
        userPrompt: prompt,
        context: {
          dataScope: requestDataScope,
          availableSeasonCatalog: aiAvailableSeasonCatalog,
        },
      });
      const requestContext = {
        ...buildDashboardAiContext({
          seasonRecords: requestScopedRecords,
          routeCountries,
          semanticIntent,
        }),
        multiSeasonCatalog: buildAiWorkspaceMultiSeasonCatalogFromData(requestSeasonIds, requestSeasonData),
        availableSeasonCatalog: aiAvailableSeasonCatalog,
        dataScope: requestDataScope,
        dataSourcePolicy: resolveAiDataSourcePolicyFromSeasonData(requestSeasonData),
      };
      const sqlQueryResults: DashboardAiQueryResult[] = [];
      const localSqlTraceWarnings: DashboardAiToolTraceSummary[] = [];
      const runLocalSqlPlan = async (plan: DashboardAiSqlQueryPlan): Promise<DashboardAiQueryResult | null> => {
        try {
          const nativeResult = await queryNativeDashboardAiSql({
            sql: plan.sql,
            params: plan.params,
            limit: 500,
          });
          return nativeResult ? dashboardAiSqlResultToQueryResult(plan, nativeResult) : null;
        } catch (error) {
          localSqlTraceWarnings.push({
            tool: 'query_dashboard_data',
            status: 'rejected',
            reason: `validated_sql: Không chạy được SQLite local cho ${plan.queryId}; app sẽ dùng fallback từ dữ liệu dashboard đang hiển thị nếu có. Lỗi: ${(error as Error).message}`,
            phase: 'validated_sql',
            toolset: 'dashboard-readonly',
          });
          return null;
        }
      };
      if (requestContext.dataSourcePolicy !== 'supabase-reporting') {
        const sqlPlans = planDashboardAiSqlQueries({
          userPrompt: prompt,
          context: requestContext,
          source: 'local-sqlite',
        });
        if (sqlPlans.length > 0) {
          setAiLoadingStep('query');
          setAiLoadingMessage('Đang chạy truy vấn SQL local đã kiểm tra...');
          for (const plan of sqlPlans) {
            throwIfAborted();
            const result = await runLocalSqlPlan(plan);
            if (result) sqlQueryResults.push(result);
          }
          const drilldownPlans = planDashboardAiSqlDrilldownQueries({
            userPrompt: prompt,
            queryResults: sqlQueryResults,
            source: 'local-sqlite',
          });
          for (const plan of drilldownPlans) {
            throwIfAborted();
            const result = await runLocalSqlPlan(plan);
            if (result) sqlQueryResults.push(result);
          }
        }
      }
      const inferredLocalQuery = inferDashboardAiDataQueryForPrompt({
        userPrompt: prompt,
        context: requestContext,
      });
      const localQueryResults = sqlQueryResults.length > 0
        ? sqlQueryResults
        : inferredLocalQuery && localAiSeasonRows.length > 0 && requestContext.dataSourcePolicy !== 'supabase-reporting'
        ? resolveDashboardAiLocalQueryResults([inferredLocalQuery], {
            seasonRows: localAiSeasonRows,
            routeCountries,
          })
        : [];
      const analysisContext = localQueryResults.length > 0
        ? { ...requestContext, queryResults: localQueryResults }
        : requestContext;
      setAiLoadingStep('provider');
      setAiLoadingMessage(isTauriRuntime() ? 'Python Agent đang gọi provider local...' : 'AI đang gọi provider...');
      let response: Awaited<ReturnType<typeof analyzeDashboardWithAi>> | undefined;
      let localAgentError: Error | null = null;
      if (isTauriRuntime()) {
        try {
          const localAgentResponse = await analyzeDashboardWithLocalAgent({
            userPrompt: prompt,
            model: modelForRequest,
            seasonIds: requestSeasonIds,
            workflowId: selectedWorkflow?.id ?? semanticIntent.workflowId,
            semanticIntent,
            requiredGates: selectedWorkflow?.requiredGates ?? [],
            sessionArtifact: notebookContext.activeArtifact ?? null,
            notebookContext,
            signal,
            localAgentClient: callNativeDashboardAiAgent,
          });
          if (localAgentResponse) {
            response = applyDashboardAiResultProfileAndVerification(localAgentResponse, {
              userPrompt: prompt,
              selectedSkillId: selectedSkill?.id,
              contextProfile: selectedSkill?.contextProfile,
            });
          }
        } catch (error) {
          localAgentError = error as Error;
        }
      }
      if (isTauriRuntime() && localAgentError && !response) {
        if (localQueryResults.length === 0 || signal?.aborted) throw localAgentError;
        const localAgentFallbackTrace: DashboardAiToolTraceSummary = {
          tool: 'query_dashboard_data',
          status: 'executed',
          reason: `executed_local_sql: Đã dùng kết quả SQLite local. Provider local chưa sẵn sàng: ${localAgentError.message}`,
          phase: 'executed_local_sql',
          toolset: 'dashboard-readonly',
        };
        response = {
          assistantText: 'Đã truy vấn SQLite local và dựng kết quả trực tiếp. Provider local chưa sẵn sàng; hãy đồng bộ API key trong Settings > AI Analysis và kiểm tra quyền can_use_ai.',
          dataRequest: null,
          exportAction: null,
          visualReport: null,
          boardPatch: buildDashboardAiBoardPatchFromQueryResults(localQueryResults, prompt),
          queryResults: localQueryResults,
          sqlQueryPlans: [],
          toolTraceSummary: [localAgentFallbackTrace],
        };
      } else {
        try {
          response = response ?? await analyzeDashboardWithAi({
            userPrompt: prompt,
            context: analysisContext,
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
            allowDataRequest: localQueryResults.length > 0 ? false : undefined,
            localQueryResults,
            signal,
          });
        } catch (error) {
          if (localQueryResults.length === 0 || signal?.aborted) throw error;
          const providerFallbackTrace: DashboardAiToolTraceSummary = {
            tool: 'query_dashboard_data',
            status: 'executed',
            reason: `executed_local_sql: Đã dùng kết quả SQLite local thay cho provider. Lỗi provider: ${(error as Error).message}`,
            phase: 'executed_local_sql',
            toolset: 'dashboard-readonly',
          };
          response = {
            assistantText: 'Đã truy vấn SQLite local và dựng kết quả trực tiếp vì provider AI chưa trả lời ổn định.',
            dataRequest: null,
            exportAction: null,
            visualReport: null,
            boardPatch: buildDashboardAiBoardPatchFromQueryResults(localQueryResults, prompt),
            queryResults: localQueryResults,
            sqlQueryPlans: [],
            toolTraceSummary: [providerFallbackTrace],
          };
        }
      }
      if (!response) throw new Error('AI provider returned no response.');
      if (localSqlTraceWarnings.length > 0) {
        response = {
          ...response,
          toolTraceSummary: [...localSqlTraceWarnings, ...response.toolTraceSummary].slice(0, 8),
        };
      }
      throwIfAborted();
      if (requestContext.dataSourcePolicy !== 'supabase-reporting' && response.sqlQueryPlans.length > 0) {
        setAiLoadingStep('query');
        setAiLoadingMessage('Đang chạy SQL local read-only do AI đề xuất...');
        const providerSqlQueryResults: DashboardAiQueryResult[] = [];
        for (const plan of response.sqlQueryPlans.filter((item) => item.source !== 'supabase-reporting').slice(0, 4)) {
          const result = await runLocalSqlPlan(plan);
          if (result) providerSqlQueryResults.push(result);
        }
        throwIfAborted();
        if (providerSqlQueryResults.length > 0) {
          const mergedById = new Map<string, DashboardAiQueryResult>();
          for (const result of response.queryResults) mergedById.set(result.queryId, result);
          for (const result of providerSqlQueryResults) mergedById.set(result.queryId, result);
          const mergedQueryResults = Array.from(mergedById.values());
          const queryBoardPatch = buildDashboardAiBoardPatchFromQueryResults(mergedQueryResults, prompt);
          const responseTextLooksPending = /^(đang|dang|cần|can|hệ thống sẽ|he thong se)\b/i.test(response.assistantText.trim());
          const sqlTrace: DashboardAiToolTraceSummary = {
            tool: 'query_dashboard_data',
            status: 'executed',
            reason: 'generated_sql → validated_sql → executed_local_sql: Đã chạy SELECT/CTE local do AI đề xuất qua Tauri gateway read-only.',
            phase: 'executed_local_sql',
            toolset: 'dashboard-readonly',
            ...(selectedSkill ? { skill: selectedSkill.id } : {}),
            ...(selectedSkill ? { contextProfile: selectedSkill.contextProfile } : {}),
          };
          response = { 
            ...response, 
            assistantText: responseTextLooksPending 
              ? `Đã chạy ${providerSqlQueryResults.length} truy vấn SQLite local read-only và render kết quả trực tiếp bên dưới.` 
              : response.assistantText, 
            queryResults: mergedQueryResults, 
            boardPatch: queryBoardPatch ?? response.boardPatch, 
            toolTraceSummary: [sqlTrace, ...response.toolTraceSummary].slice(0, 8), 
          }; 
          response = applyDashboardAiResultProfileAndVerification(response, { 
            userPrompt: prompt, 
            selectedSkillId: selectedSkill?.id, 
            contextProfile: selectedSkill?.contextProfile, 
          }); 
        } 
      } 
      if (response.dataRequest && response.queryResults.length === 0) {
        const legacyDataRequestTrace: DashboardAiToolTraceSummary = {
          tool: 'query_dashboard_data',
          status: 'rejected',
          reason: 'AI Workspace query-only không dùng dataRequest/MoM-WoW payload; hãy dùng sqlQueryPlans hoặc queryResults.',
          toolset: 'dashboard-readonly',
          fallbackReason: 'Bỏ qua dataRequest legacy để tránh quay về bảng MoM/WoW.',
        };
        response = {
          ...response,
          dataRequest: null,
          toolTraceSummary: [
            legacyDataRequestTrace,
            ...response.toolTraceSummary,
          ].slice(0, 8),
        };
      }
      setAiLoadingStep('render');
      const boardPatch = response.boardPatch ?? buildDashboardAiFallbackBoardPatch({
        userPrompt: prompt,
        preferredTool,
        visualReport: response.visualReport,
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
        message: response.assistantText,
      });
      const nextCellBase: DashboardAiNotebookCell = {
        id: `ai-cell-${cellCreatedAt}`,
        prompt,
        assistantText: response.assistantText,
        blocks: boardPatch?.blocks ?? [],
        toolTraceSummary: response.toolTraceSummary,
        exportAction: response.exportAction,
        createdAt: cellCreatedAt,
        modelId: modelForRequest.id,
        runEvents,
        queryResults: response.queryResults,
        resultProfiles: response.resultProfiles,
        answerVerification: response.answerVerification,
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
  }, [aiAvailableSeasonCatalog, aiConfigured, aiLoading, aiNotebook, aiPrompt, aiWorkspaceSeasonData, dashboardAiAvailableTools, effectiveRecords, loadAiWorkspaceSeason, pinnedAiContextCellId, routeCountries, season, seasons, selectedAiModel, selectedAiSeasonIds, selectedAiWorkspaceSeasonData.length, syncMeta]);

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

  const resolveAiWorkspaceComparison = useCallback((block: DashboardAiWorkspaceBlock) => {
    const filters = block.table?.filters ?? block.chart?.filters ?? {};
    const mode = filters.comparisonMode ?? comparisonMode;
    const granularity = mode === 'yoy' ? comparisonGranularity : 'month';
    const modePeriods = mode === comparisonMode ? periodOptions : listPeriods(analysisRecords, mode, granularity);
    const current = resolveWorkspacePeriodKey(modePeriods, filters.currentPeriod, filters.currentMonth) || (mode === comparisonMode ? activeCurrentPeriod : modePeriods.at(-1)?.key ?? '');
    const fallbackPrevious = resolveDefaultPreviousPeriod(modePeriods, current, mode, granularity);
    const previous = resolveWorkspacePeriodKey(modePeriods, filters.previousPeriod, filters.previousMonth) || (mode === comparisonMode ? activePreviousPeriod : fallbackPrevious);
    if (!current) return null;
    return buildDashboardComparison({
      records: analysisRecords,
      mode,
      granularity,
      metric: filters.metric ?? metric,
      currentPeriod: current,
      previousPeriod: previous === current ? fallbackPrevious : previous,
      typeFilter: filters.typeFilter ?? typeFilter,
      timeBasis: filters.timeBasis ?? timeBasis,
      dimension: filters.dimension ?? dimension,
      routeCountries,
    });
  }, [activeCurrentPeriod, activePreviousPeriod, analysisRecords, comparisonGranularity, comparisonMode, dimension, metric, periodOptions, routeCountries, timeBasis, typeFilter]);

  const materializeAiWorkspaceTableRows = useCallback((block: DashboardAiWorkspaceBlock): AiWorkspaceTableRow[] => {
    if (block.table?.rows?.length) {
      return block.table.rows.map((row) => ({ ...row }));
    }
    const limit = block.table?.limit ?? 12;
    const templateId = block.table?.templateId ?? 'season-summary';
    if (templateId === 'comparison-drivers') {
      return (resolveAiWorkspaceComparison(block)?.drivers ?? []).slice(0, limit).map((driver) => ({
        Driver: driver.label,
        Current: driver.currentValue,
        Previous: driver.previousValue,
        Delta: driver.delta,
        'Delta %': formatPct(driver.deltaPct),
        CTG: formatPointPct(driver.ctgPct),
        'Share shift': formatPointPct(driver.shareShift),
      }));
    }
    if (templateId === 'monthly-trend') {
      return overview.monthlyTrend.slice(0, limit).map((row) => ({
        Month: row.label,
        Flights: row.total,
        ARR: row.arrivals,
        DEP: row.departures,
        Pax: row.pax,
      }));
    }
    if (templateId === 'airline-ranking') {
      return overview.airlineRanking.slice(0, limit).map((row) => ({
        Airline: row.label,
        Flights: row.flights,
        Pax: row.pax,
        Share: formatPct(row.share),
      }));
    }
    if (templateId === 'route-country-ranking') {
      return overview.countryRouteContribution.slice(0, limit).map((row) => ({
        Country: row.country,
        Route: row.route,
        Flights: row.flights,
        Pax: row.pax,
        Share: formatPct(row.share),
      }));
    }
    if (templateId === 'peak-hour') {
      return overview.peakHourAverage.slice(0, limit).map((row) => ({
        Bucket: row.bucket,
        Flights: row.flights,
        ARR: row.arrivals,
        DEP: row.departures,
        'Ops days': row.operatingDays,
        'Avg/day': Number(row.avgFlightsPerDay.toFixed(1)),
      }));
    }
    return aiWorkspaceSeasonSummaryRows.slice(0, limit);
  }, [aiWorkspaceSeasonSummaryRows, overview, resolveAiWorkspaceComparison]);

  const materializeAiWorkspaceChartRows = useCallback((block: DashboardAiWorkspaceBlock): Array<Record<string, string | number>> => {
    if (block.chart?.rows?.length) {
      return block.chart.rows.map((row) => Object.fromEntries(
        Object.entries(row)
          .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')
      ));
    }
    const limit = block.chart?.limit ?? 10;
    if (block.chart?.chartType === 'line-trend') {
      return overview.monthlyTrend.slice(0, limit).map((row) => ({
        label: row.label,
        flights: row.total,
        arrivals: row.arrivals,
        departures: row.departures,
      }));
    }
    if (block.chart?.chartType === 'waterfall') {
      return (resolveAiWorkspaceComparison(block)?.drivers ?? []).slice(0, limit).map((driver) => ({
        label: driver.label,
        value: driver.delta,
      }));
    }
    if (block.chart?.chartType === 'heatmap') {
      return overview.weekdayHeatmap.slice(0, limit).map((cell) => ({
        label: `${cell.monthLabel} ${weekdayDisplayLabel(cell.weekday)}`,
        value: Number(cell.avgFlightsPerDay.toFixed(1)),
      }));
    }
    if (block.source === 'multiSeason') {
      return aiWorkspaceSeasonSummaryRows.slice(0, limit).map((row) => ({
        label: String(row.Season),
        value: Number(row.Flights) || 0,
      }));
    }
    if (block.chart?.filters?.dimension === 'hourBucket') {
      return overview.peakHourAverage.slice(0, limit).map((row) => ({
        label: row.bucket,
        value: row.flights,
      }));
    }
    if (block.chart?.filters?.dimension === 'route' || block.chart?.filters?.dimension === 'country') {
      return overview.countryRouteContribution.slice(0, limit).map((row) => ({
        label: block.chart?.filters?.dimension === 'country' ? row.country : row.route,
        value: row.flights,
      }));
    }
    if (block.chart?.filters?.dimension === 'aircraft') {
      return overview.aircraftMix.slice(0, limit).map((row) => ({
        label: row.label,
        value: row.flights,
      }));
    }
    if (block.source === 'comparison') {
      return (resolveAiWorkspaceComparison(block)?.drivers ?? []).slice(0, limit).map((driver) => ({
        label: driver.label,
        value: driver.delta,
      }));
    }
    return overview.airlineRanking.slice(0, limit).map((row) => ({
      label: row.label,
      value: row.flights,
    }));
  }, [aiWorkspaceSeasonSummaryRows, overview, resolveAiWorkspaceComparison]);

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

  const aiNotebookRendererData = useMemo<AiNotebookRendererData>(() => ({
    formatValue,
    materializeTableRows: materializeAiWorkspaceTableRows,
    materializeChartRows: materializeAiWorkspaceChartRows,
    fallbackKpis: {
      totalFlights: overview.kpis.totalFlights,
      totalPax: overview.kpis.totalPax,
      avgFlightsPerDay: overview.kpis.avgFlightsPerDay,
      selectedSeasonCount: selectedAiSeasonIds.length,
    },
  }), [materializeAiWorkspaceChartRows, materializeAiWorkspaceTableRows, overview.kpis.avgFlightsPerDay, overview.kpis.totalFlights, overview.kpis.totalPax, selectedAiSeasonIds.length]);

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

  const dashboardSeasonOptions = useMemo(() => seasons.map((item) => ({
    id: item.id,
    seasonCode: item.seasonCode,
    name: item.name,
  })), [seasons]);

  const toggleDashboardSeason = useCallback((seasonId: string) => {
    setDashboardSeasonIds((current) => {
      const hasSeason = current.includes(seasonId);
      const next = hasSeason
        ? current.filter((id) => id !== seasonId)
        : [...current, seasonId];
      const normalized = normalizeDashboardAiWorkspaceSeasonIds(next);
      if (normalized.length === 0 && season?.id) return [season.id];
      return normalized;
    });
  }, [season, setDashboardSeasonIds]);

  const handleOverviewRangeChange = useCallback((monthFrom: string, monthTo: string) => {
    setOverviewMonthFrom(monthFrom);
    setOverviewMonthTo(monthTo);
  }, [setOverviewMonthFrom, setOverviewMonthTo]);

  const toggleOverviewCountry = (country: string) => {
    setOverviewCountryExpansionTouched(true);
    setExpandedOverviewCountries((current) => {
      const next = new Set(current);
      if (effectiveExpandedOverviewCountries.has(country)) {
        next.delete(country);
      } else {
        next.add(country);
      }
      return next;
    });
  };

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
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface font-sans">
      <div className="flex h-screen min-w-0 flex-1 flex-col bg-surface">
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
              <FetchServerUpdatesButton
                fetching={fetchingUpdates}
                progress={fetchProgress}
                disabled={loading}
                onFetch={handleFetchUpdates}
              />
            )}
          </div>
        </header>

        <main ref={dashboardScrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {error && (
            <section className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </section>
          )}

          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Bảng điều khiển</div>
                <div className="mt-1 grid grid-cols-3 rounded-lg border border-outline-variant bg-surface p-1">
                  <button
                    type="button"
                    onClick={() => setDashboardView('overview')}
                    className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold ${dashboardView === 'overview' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">space_dashboard</span>
                    Tổng quan
                  </button>
                  <button
                    type="button"
                    onClick={() => setDashboardView('ai-workspace')}
                    className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold ${dashboardView === 'ai-workspace' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">dashboard_customize</span>
                    AI Workspace
                  </button>
                  <button
                    type="button"
                    onClick={() => setDashboardView('analysis')}
                    className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold ${dashboardView === 'analysis' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">analytics</span>
                    Phân tích MoM / WoW
                  </button>
                </div>
              </div>
              <div className="text-right text-xs font-semibold text-on-surface-variant">
                <div>{season?.seasonCode ?? 'Mùa bay'} ưu tiên tổng quan</div>
                <div>{formatValue(overview.records.length)} chuyến sau lọc từ {formatValue(dashboardRecords.length)} bản ghi Dashboard</div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
            <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
            </div>
          </section>

          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
            <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Loại chuyến
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as DashboardTypeFilter)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {TYPE_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Múi giờ
                <select value={timeBasis} onChange={(event) => setTimeBasis(event.target.value as DashboardTimeBasis)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  <option value="local">Local +7</option>
                  <option value="utc">UTC</option>
                </select>
              </label>
            </div>
          </section>

          {dashboardView === 'overview' && (
            <>
              <DateRangeFilter
                monthOptions={overviewMonthOptions}
                monthFrom={activeOverviewMonthFrom}
                monthTo={activeOverviewMonthTo}
                seasonOptions={dashboardSeasonOptions}
                selectedSeasonIds={activeDashboardSeasonIds}
                onRangeChange={handleOverviewRangeChange}
                onToggleSeason={toggleDashboardSeason}
              />

              <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                    Hãng bay
                    <select value={overviewAirline} onChange={(event) => setOverviewAirline(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                      <option value="all">Tất cả hãng bay</option>
                      {overview.airlineOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                    Quốc gia
                    <select value={overviewCountry} onChange={(event) => setOverviewCountry(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                      <option value="all">Tất cả quốc gia</option>
                      {overview.countryOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                    Đường bay
                    <select value={overviewRoute} onChange={(event) => setOverviewRoute(event.target.value)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                      <option value="all">Tất cả đường bay</option>
                      {overview.routeOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                {[
                  { label: 'Tổng chuyến bay', value: formatValue(overview.kpis.totalFlights), sub: `${overviewMonthStart || '-'} đến ${overviewMonthEnd || '-'}` },
                  { label: 'Tổng khách', value: formatValue(overview.kpis.totalPax), sub: 'Bản ghi hiệu lực' },
                  { label: 'TB chuyến/ngày', value: overview.kpis.avgFlightsPerDay.toFixed(1), sub: `${overview.records.length} dòng sau lọc` },
                  { label: 'Tháng cao điểm', value: overview.kpis.peakMonth.label, sub: `${formatValue(overview.kpis.peakMonth.flights)} chuyến` },
                  { label: 'Hãng bay cao nhất', value: overview.kpis.topAirline.label, sub: `${formatValue(overview.kpis.topAirline.flights)} chuyến` },
                  { label: 'Đường bay cao nhất', value: overview.kpis.topRoute.label, sub: `${formatValue(overview.kpis.topRoute.flights)} chuyến` },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg border border-surface-variant bg-surface-container-lowest px-4 py-3 shadow-sm">
                    <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{item.label}</div>
                    <div className="mt-1 truncate text-xl font-bold text-on-surface">{item.value}</div>
                    <div className="mt-1 truncate text-xs text-on-surface-variant">{item.sub}</div>
                  </div>
                ))}
              </section>

              <section className="grid gap-3 xl:grid-cols-12">
                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-on-surface">Xu hướng chuyến bay theo tháng</h2>
                      <p className="text-xs text-on-surface-variant">Tách ARR và DEP theo tháng</p>
                    </div>
                    <span className="text-xs font-semibold text-on-surface-variant">{typeFilter === 'all' ? 'Toàn bộ lưu lượng' : typeFilter === 'A' ? 'Chỉ ARR' : 'Chỉ DEP'}</span>
                  </div>
                  <div className="space-y-3">
                    {overview.monthlyTrend.map((row) => (
                      <button
                        key={row.key}
                        type="button"
                        onClick={() => setOverviewDailyMonth(row.key)}
                        className={`grid w-full grid-cols-[68px_minmax(0,1fr)_72px] items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-surface-container ${activeOverviewDailyMonth === row.key ? 'bg-surface-container-low' : ''}`}
                      >
                        <span className="text-xs font-semibold text-on-surface-variant">{row.label}</span>
                        <span className="flex h-3 overflow-hidden rounded-full bg-surface-container-high">
                          <span className="h-full bg-sky-500" style={{ width: `${row.arrivals / overviewMaxMonthlyFlights * 100}%` }} />
                          <span className="h-full bg-amber-500" style={{ width: `${row.departures / overviewMaxMonthlyFlights * 100}%` }} />
                        </span>
                        <span className="text-right text-sm font-bold text-on-surface">{formatValue(row.total)}</span>
                      </button>
                    ))}
                    {overview.monthlyTrend.length === 0 && (
                      <div className="rounded-md border border-dashed border-outline-variant px-3 py-8 text-center text-sm text-on-surface-variant">Không có dữ liệu xu hướng tháng.</div>
                    )}
                  </div>
                  <div className="mt-4 flex gap-4 text-xs font-semibold text-on-surface-variant">
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />ARR</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />DEP</span>
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-on-surface">Xu hướng chuyến bay theo ngày</h2>
                      <p className="text-xs text-on-surface-variant">Tìm ngày cao điểm trong tháng đã chọn</p>
                    </div>
                    <select
                      value={activeOverviewDailyMonth}
                      onChange={(event) => setOverviewDailyMonth(event.target.value)}
                      className="w-28 rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold text-on-surface"
                    >
                      {overviewDailyMonthOptions.length === 0 ? (
                        <option value="">Không có tháng</option>
                      ) : overviewDailyMonthOptions.map((month) => (
                        <option key={month.key} value={month.key}>{month.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="relative h-40 border-b border-surface-variant">
                    <div className="absolute inset-x-0 top-0 h-px bg-surface-variant/70" />
                    <div className="absolute inset-x-0 top-1/2 h-px bg-surface-variant/70" />
                    <div className="relative z-10 flex h-full items-end gap-1 px-1 pt-3">
                      {overviewDailyCalendarRows.map((row) => {
                        const isPeak = overviewDailyPeakDay?.date === row.date && row.total > 0;
                        return (
                          <button
                            key={row.date}
                            type="button"
                            disabled={!season}
                            onDoubleClick={() => handleDailyTrendDoubleClick(row.date)}
                            aria-label={`Mở Lịch ngày cho ${row.date}`}
                            className="flex h-full min-w-0 flex-1 items-end justify-center rounded-t-sm outline-none transition hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-70"
                          >
                            <div
                              title={`Nhấp đúp để mở Lịch ngày ${row.date}: ${formatValue(row.total)} chuyến (${formatValue(row.arrivals)} ARR / ${formatValue(row.departures)} DEP)`}
                              className={`flex w-full max-w-3 flex-col-reverse overflow-hidden rounded-t-sm ${isPeak ? 'ring-2 ring-teal-700 ring-offset-1' : ''} ${row.total === 0 ? 'bg-slate-200 dark:bg-slate-800' : 'bg-surface-container-high'}`}
                              style={{ height: row.total === 0 ? 4 : `${Math.max(8, row.total / overviewMaxDailyFlights * 100)}%` }}
                            >
                              {row.total > 0 && (
                                <>
                                  <span className="block bg-amber-500" style={{ height: `${row.departures / row.total * 100}%` }} />
                                  <span className="block bg-sky-500" style={{ height: `${row.arrivals / row.total * 100}%` }} />
                                </>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] font-semibold text-on-surface-variant">
                    {overviewDailyCalendarRows.map((row, index) => (
                      <span key={`${row.date}-axis`} className={index % 5 === 0 || index === overviewDailyCalendarRows.length - 1 ? 'opacity-100' : 'opacity-0'}>
                        {row.day}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs xl:grid-cols-4">
                    <div className="rounded-md bg-surface-container-low px-2 py-2">
                      <div className="font-bold uppercase text-on-surface-variant">Ngày cao điểm</div>
                      <div className="mt-1 font-bold text-on-surface">{overviewDailyPeakDay ? `${overviewDailyPeakDay.label}` : '-'}</div>
                      <div className="text-on-surface-variant">{formatValue(overviewDailyPeakDay?.total ?? 0)} chuyến</div>
                    </div>
                    <div className="rounded-md bg-surface-container-low px-2 py-2">
                      <div className="font-bold uppercase text-on-surface-variant">Avg/day</div>
                      <div className="mt-1 font-bold text-teal-700">{overviewDailyCalendarRows.length === 0 ? '0.0' : (overviewDailyTotalFlights / overviewDailyCalendarRows.length).toFixed(1)}</div>
                      <div className="text-on-surface-variant">chuyến</div>
                    </div>
                    <div className="rounded-md bg-surface-container-low px-2 py-2">
                      <div className="font-bold uppercase text-on-surface-variant">Thứ cao điểm</div>
                      <div className="mt-1 font-bold text-on-surface">{weekdayDisplayLabel(overviewDailyWeekdayPeak[0])}</div>
                      <div className="text-on-surface-variant">{formatValue(overviewDailyWeekdayPeak[1])} chuyến</div>
                    </div>
                    <div className="rounded-md bg-surface-container-low px-2 py-2">
                      <div className="font-bold uppercase text-on-surface-variant">Weekend</div>
                      <div className="mt-1 font-bold text-on-surface">{formatPct(overviewDailyTotalFlights === 0 ? null : overviewDailyWeekendFlights / overviewDailyTotalFlights)}</div>
                      <div className="text-on-surface-variant">tỷ trọng</div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-4 text-xs font-semibold text-on-surface-variant">
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />ARR</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />DEP</span>
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-3">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-on-surface">Hiệu suất hãng bay</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">Chuyến + khách</span>
                  </div>
                  <div className="space-y-2">
                    {overview.airlineRanking.slice(0, 8).map((row) => (
                      <div key={row.key} className="grid grid-cols-[54px_minmax(0,1fr)_70px_80px] items-center gap-2 text-sm">
                        <span className="truncate font-bold text-on-surface">{row.label}</span>
                        <span className="h-2 rounded-full bg-surface-container-high">
                          <span className="block h-2 rounded-full bg-primary" style={{ width: `${row.flights / overviewMaxAirlineFlights * 100}%` }} />
                        </span>
                        <span className="text-right font-semibold text-on-surface">{formatValue(row.flights)}</span>
                        <span className="text-right text-xs text-on-surface-variant">{formatValue(row.pax)} khách</span>
                      </div>
                    ))}
                    {overview.airlineRanking.length === 0 && (
                      <div className="rounded-md border border-dashed border-outline-variant px-3 py-8 text-center text-sm text-on-surface-variant">Không có dữ liệu hãng bay.</div>
                    )}
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-6">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-on-surface">Đóng góp theo quốc gia / đường bay</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">Có thể mở chi tiết đường bay</span>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-surface-variant">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
                        <tr>
                          <th className="px-3 py-2 text-left">Quốc gia</th>
                          <th className="px-3 py-2 text-left">Đường bay</th>
                          <th className="px-3 py-2 text-right">Chuyến</th>
                          <th className="px-3 py-2 text-right">Khách</th>
                          <th className="px-3 py-2 text-right">Tỷ trọng</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-variant bg-surface">
                        {overviewCountryGroups.slice(0, 8).map((group) => {
                          const expanded = effectiveExpandedOverviewCountries.has(group.country);
                          return (
                            <Fragment key={group.country}>
                              <tr className="bg-surface-container-lowest hover:bg-surface-container">
                                <td className="px-3 py-2 font-semibold text-on-surface">
                                  <button
                                    type="button"
                                    onClick={() => toggleOverviewCountry(group.country)}
                                    className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-surface-container-high"
                                    aria-expanded={expanded}
                                  >
                                    <span className="material-symbols-outlined text-[18px]">{expanded ? 'expand_more' : 'chevron_right'}</span>
                                    <span className="truncate">{group.country}</span>
                                  </button>
                                </td>
                                <td className="px-3 py-2 text-on-surface-variant">{group.routes.length} đường bay</td>
                                <td className="px-3 py-2 text-right font-semibold text-on-surface">{formatValue(group.flights)}</td>
                                <td className="px-3 py-2 text-right text-on-surface-variant">{formatValue(group.pax)}</td>
                                <td className="px-3 py-2 text-right text-on-surface-variant">{formatPct(group.share)}</td>
                              </tr>
                              {expanded && group.routes.map((row) => (
                                <tr key={`${row.country}-${row.route}`} className="hover:bg-surface-container">
                                  <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Đường bay</td>
                                  <td className="px-3 py-2 font-semibold text-on-surface">{row.route}</td>
                                  <td className="px-3 py-2 text-right font-semibold text-on-surface">{formatValue(row.flights)}</td>
                                  <td className="px-3 py-2 text-right text-on-surface-variant">{formatValue(row.pax)}</td>
                                  <td className="px-3 py-2 text-right text-on-surface-variant">{formatPct(row.share)}</td>
                                </tr>
                              ))}
                            </Fragment>
                          );
                        })}
                        {overviewCountryGroups.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-3 py-8 text-center text-on-surface-variant">Không có dữ liệu đóng góp đường bay.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 space-y-1">
                    {overview.countryRouteContribution.slice(0, 8).map((row) => (
                      <div key={`${row.country}-${row.route}-bar`} className="flex items-center gap-2 text-xs text-on-surface-variant">
                        <span className="w-16 truncate font-semibold text-on-surface">{row.route}</span>
                        <span className="h-1.5 flex-1 rounded-full bg-surface-container-high">
                          <span className="block h-1.5 rounded-full bg-teal-500" style={{ width: `${row.flights / overviewMaxCountryRouteFlights * 100}%` }} />
                        </span>
                        <span className="w-12 text-right">{formatValue(row.flights)}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-6">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-on-surface">Bản đồ tải</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">Tháng x thứ trong tuần</span>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-surface-variant">
                    <table className="w-full table-fixed text-xs">
                      <thead className="bg-surface-container-low uppercase tracking-wide text-on-surface-variant">
                        <tr>
                          <th className="px-2 py-2 text-left">Tháng</th>
                          {WEEKDAY_COLUMNS.map((weekday) => <th key={weekday.key} className="px-1 py-2 text-center">{weekday.label}</th>)}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-variant bg-surface">
                        {overviewHeatmapRows.map((row) => (
                          <tr key={row.key}>
                            <td className="px-2 py-2 font-semibold text-on-surface">{row.label}</td>
                            {row.cells.map((cell, index) => {
                              const cellTone = heatmapCellTone(cell?.flights, overviewMaxHeatmapFlights);
                              return (
                                <td key={`${row.key}-${WEEKDAY_COLUMNS[index]?.key ?? index}`} className="px-1 py-1 text-center">
                                  <span
                                    className={`block rounded px-1 py-1 font-semibold ring-1 ring-inset transition-colors ${cellTone}`}
                                    title={cell ? `${row.label} ${weekdayDisplayLabel(cell.weekday)}: ${formatValue(cell.flights)} chuyến, TB ${cell.avgFlightsPerDay.toFixed(1)} chuyến/ngày khai thác` : `${row.label} ${WEEKDAY_COLUMNS[index]?.label ?? ''}: không có dữ liệu`}
                                  >
                                    {cell?.flights ?? '-'}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                        {overviewHeatmapRows.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-3 py-8 text-center text-on-surface-variant">Không có dữ liệu bản đồ tải.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-12">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-surface-variant pb-3">
                    <div className="flex items-baseline gap-4">
                      <h2 className="text-xl font-bold text-on-surface">Trung bình theo khung giờ cao điểm</h2>
                      <span className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">Trung bình chuyến / 30 phút</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                    <select
                      value={activeOverviewPeakHourMonth}
                      onChange={(event) => setOverviewPeakHourMonth(event.target.value)}
                      className="rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold text-on-surface"
                    >
                      {overviewPeakHourMonthOptions.map((month) => (
                        <option key={month.key} value={month.key}>{month.label}</option>
                      ))}
                    </select>
                    <div className="grid grid-cols-2 rounded-lg border border-outline-variant bg-surface-container-low p-1">
                      <button
                        type="button"
                        onClick={() => setTimeBasis('local')}
                        className={`rounded-md px-3 py-1 text-xs font-bold uppercase ${timeBasis === 'local' ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:bg-surface-container'}`}
                      >
                        Local +7
                      </button>
                      <button
                        type="button"
                        onClick={() => setTimeBasis('utc')}
                        className={`rounded-md px-3 py-1 text-xs font-bold uppercase ${timeBasis === 'utc' ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:bg-surface-container'}`}
                      >
                        UTC
                      </button>
                    </div>
                    </div>
                  </div>
                  <div className="relative h-72 border-b border-surface-variant">
                    <div className="absolute inset-x-0 top-0 h-px bg-surface-variant" />
                    <div className="absolute inset-x-0 top-1/4 h-px bg-surface-variant/70" />
                    <div className="absolute inset-x-0 top-1/2 h-px bg-surface-variant/70" />
                    <div className="absolute inset-x-0 top-3/4 h-px bg-surface-variant/70" />
                    <div className="relative z-10 flex h-full items-end gap-1 px-2 pt-3">
                      {overview.peakHourAverage.map((row) => (
                        <div key={row.bucket} className="flex h-full min-w-0 flex-1 items-end justify-center">
                          <div
                            title={`${row.bucket}: ${row.avgFlightsPerDay.toFixed(1)} chuyến / 30 phút (${row.avgArrivalsPerDay.toFixed(1)} ARR / ${row.avgDeparturesPerDay.toFixed(1)} DEP)`}
                            className={`flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-t-sm ${row.avgFlightsPerDay === 0 ? 'bg-slate-200 dark:bg-slate-800' : 'bg-surface-container-high'}`}
                            style={{ height: `${Math.max(4, row.avgFlightsPerDay / overviewMaxPeakHourAverage * 100)}%` }}
                          >
                            {row.avgFlightsPerDay > 0 && (
                              <>
                                <span className="block bg-amber-500" style={{ height: `${row.avgDeparturesPerDay / row.avgFlightsPerDay * 100}%` }} />
                                <span className="block bg-sky-500" style={{ height: `${row.avgArrivalsPerDay / row.avgFlightsPerDay * 100}%` }} />
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1 text-xs font-semibold text-on-surface-variant">
                    {overviewPeakHourAxisTicks.map((tick, index) => (
                      <span key={`${tick.index}-${tick.label}`} className={index === 0 ? 'text-left' : index === overviewPeakHourAxisTicks.length - 1 ? 'text-right' : 'text-center'}>
                        {tick.label}
                      </span>
                    ))}
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-semibold text-on-surface-variant">Ngày khai thác 05:00-05:00</span>
                      <div className="mt-1 flex gap-4 text-xs font-semibold text-on-surface-variant">
                        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />ARR</span>
                        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />DEP</span>
                      </div>
                    </div>
                    <div className="grid gap-4 rounded-lg border border-surface-variant bg-surface-container-low px-4 py-3 text-sm sm:grid-cols-4">
                      <div>
                        <div className="text-xs font-bold uppercase text-on-surface-variant">Khung cao điểm</div>
                        <div className="font-bold text-on-surface">{overviewPeakHourPeak.bucket}</div>
                      </div>
                      <div>
                        <div className="text-xs font-bold uppercase text-on-surface-variant">TB cao điểm</div>
                        <div className="font-bold text-teal-700">{overviewPeakHourPeak.avgFlightsPerDay.toFixed(1)} chuyến / 30 phút</div>
                      </div>
                      <div>
                        <div className="text-xs font-bold uppercase text-on-surface-variant">Thấp nhất</div>
                        <div className="font-bold text-on-surface">{overviewPeakHourQuietest.bucket}</div>
                      </div>
                      <div>
                        <div className="text-xs font-bold uppercase text-on-surface-variant">Chế độ UTC</div>
                        <div className="font-semibold italic text-on-surface-variant">dịch trục -7 giờ</div>
                      </div>
                    </div>
                  </div>
                </section>
              </section>
            </>
          )}

          {dashboardView === 'analysis' && (
            <>
          <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-3 shadow-sm">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(180px,0.8fr)_minmax(280px,1.2fr)_minmax(150px,0.7fr)_repeat(2,minmax(150px,0.75fr))]">
              <label className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                Chỉ số
                <select value={metric} onChange={(event) => setMetric(event.target.value as DashboardMetric)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-on-surface">
                  {METRICS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                So sánh: MoM / WoW
                <div className="mt-1 grid grid-cols-3 rounded-lg border border-outline-variant bg-surface p-1 normal-case tracking-normal">
                  <button type="button" onClick={() => setComparisonMode('mom')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${comparisonMode === 'mom' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
                    MoM
                  </button>
                  <button type="button" onClick={() => setComparisonMode('wow')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${comparisonMode === 'wow' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
                    WoW
                  </button>
                  <button type="button" onClick={() => setComparisonMode('yoy')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${comparisonMode === 'yoy' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>
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

          <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'Hiện tại', value: formatValue(comparison?.current.total ?? 0), sub: comparison?.periodLabels.current ?? '-' },
              { label: 'Kỳ trước', value: formatValue(comparison?.previous.total ?? 0), sub: comparison?.periodLabels.previous ?? '-' },
              { label: 'Chênh lệch', value: formatDelta(comparison?.delta ?? 0), sub: formatPct(comparison?.deltaPct ?? null) },
              { label: 'Tập trung top driver', value: formatPct(topDriverConcentration), sub: comparison?.drivers[0]?.label ?? '-' },
              { label: 'Tăng mạnh nhất', value: topGain ? topGain.label : '-', sub: topGain ? formatDelta(topGain.delta) : '-' },
              { label: 'Kéo giảm nhất', value: topDrag ? topDrag.label : '-', sub: topDrag ? formatDelta(topDrag.delta) : '-' },
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
                      className="grid w-full grid-cols-[92px_minmax(0,1fr)_90px] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-container"
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
                  <div className="rounded-md border border-dashed border-outline-variant px-3 py-8 text-center text-sm text-on-surface-variant">Không có dữ liệu cơ cấu</div>
                ) : topMixRows.map((driver) => (
                  <button key={driver.key} type="button" onClick={() => setSelectedDriverKey(driver.key)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-container">
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
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold ${dimension === tab.value ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container'}`}
                    >
                      <span className="material-symbols-outlined text-[15px]">{tab.icon}</span>
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">Nhóm tác nhân</div>
              <div className="overflow-hidden rounded-lg border border-surface-variant">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
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
                    {(comparison?.drivers ?? []).slice(0, 12).map((driver) => (
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
                    {(comparison?.drivers.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-on-surface-variant">Không có dòng xếp hạng cho kỳ đã chọn.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm xl:col-span-12">
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
                    <h2 className="text-sm font-bold text-on-surface">Chi tiết tác nhân</h2>
                    <span className="text-xs font-semibold text-on-surface-variant">{dimensionLabel}</span>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-surface-variant">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
                        <tr>
                          <th className="px-3 py-2 text-left">Ngày</th>
                          <th className="px-3 py-2 text-left">Giờ</th>
                          <th className="px-3 py-2 text-left">Loại</th>
                          <th className="px-3 py-2 text-left">Chuyến bay</th>
                          <th className="px-3 py-2 text-left">Đường bay</th>
                          <th className="px-3 py-2 text-right">Khách</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-variant bg-surface">
                        {selectedDriverRecords.map((record) => (
                          <tr key={record.id}>
                            <td className="px-3 py-2">{record.date}</td>
                            <td className="px-3 py-2">{record.schedule}</td>
                            <td className="px-3 py-2">{record.type}</td>
                            <td className="px-3 py-2 font-semibold">{record.airline}{record.flightNumber}</td>
                            <td className="px-3 py-2">{record.route}</td>
                            <td className="px-3 py-2 text-right">{record.pax == null ? '-' : formatValue(record.pax)}</td>
                          </tr>
                        ))}
                        {selectedDriverRecords.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-3 py-8 text-center text-on-surface-variant">Không có chuyến liên quan trong kỳ đã chọn.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {selectedDriverRecordsForAi.length > selectedDriverRecords.length && (
                    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-on-surface-variant">
                      <span>Đang hiển thị {formatValue(selectedDriverRecords.length)} / {formatValue(selectedDriverRecordsForAi.length)} chuyến liên quan.</span>
                      <button
                        type="button"
                        onClick={() => setSelectedDriverRecordLimit((current) => current + 25)}
                        className="inline-flex items-center gap-1 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-semibold text-on-surface hover:bg-surface-container"
                      >
                        <span className="material-symbols-outlined text-[16px]">expand_more</span>
                        Hiển thị thêm
                      </button>
                    </div>
                  )}
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
            </section>
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
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-surface text-on-surface">Đang tải bảng điều khiển...</div>}>
      <DashboardContent routeBase={routeBase} />
    </Suspense>
  );
}
